//! Multi-participant virtual CAN bus: a fan-out + per-participant arbitration primitive.
//!
//! [`SharedBus`] models one CAN bus shared by N participants with configurable
//! bitrate, ISO 11898-style arbitration at frame boundaries, and bridge
//! participants that front an external sink/source pair (typically a wire
//! session into another endpoint). See
//! [ADR 0021](../../../docs/adr/0021-virtual-bus-server.md) for the
//! architectural reasoning.
//!
//! ## Shape
//!
//! Construct a bus with [`SharedBus::new`] and a [`BusConfig`]
//! (arbitration-phase bit rate, optional FD data-phase bit rate, FD
//! enable). Attach a virtual participant with [`SharedBus::attach_participant`]: the
//! returned [`LocalSink`] queues frames the participant transmits and the
//! returned [`LocalSource`] yields a stream of [`ParticipantEvent`]s for that
//! participant — other participants' frames as `Rx`, plus a `NoAcknowledger` event
//! for every frame the participant sent that reached zero recipients. Attach
//! a bridge with [`SharedBus::attach_bridge`]: frames pulled from the
//! supplied source fan out to other participants; frames the bus delivers to
//! the bridge are forwarded to the supplied sink with `Direction::Tx`.
//!
//! Dropping a [`LocalSink`] detaches its participant; dropping a
//! [`BridgeHandle`] detaches the bridge. Dropping the [`SharedBus`]
//! itself shuts down the arbitration worker and causes every subsequent
//! sink operation to fail with [`BusClosed`].
//!
//! ## Arbitration model
//!
//! The bus runs one timeline (`busy_until`). At each arbitration round
//! it picks one head-of-queue per non-empty local participant, the lowest CAN
//! id wins, FIFO on ties by enqueue time, the winner pops, and the bus
//! advances by the frame's approximate wire duration computed from
//! `BusConfig` and on-wire size (with FD BRS applied for FD frames).
//! Bridge ingress bypasses the virtual arbiter — bridges delegate
//! arbitration and timing to their controller per ADR 0021, so a
//! bridge's frame appears on the bus without consuming a slot. Bit-
//! level arbitration and full bridge-vs-virtual timing delegation are
//! deferred (the ADR's known-deviations list); today's implementation
//! is frame-boundary on the virtual side and bypass on the bridge side.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::frame::{CanFrame, CanFramePayload, Direction};
use crate::io::{CanFrameSink, CanFrameSource};

/// Configuration for a [`SharedBus`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BusConfig {
    /// Arbitration-phase bit rate (Hz).
    pub speed_bps: u64,
    /// Data-phase bit rate (Hz) used for CAN FD frames whose BRS flag
    /// is set. `None` on classic-only buses.
    pub fd_data_speed_bps: Option<u64>,
    /// Whether CAN FD frames are accepted on this bus. The primitive
    /// itself does not reject FD submissions when this is `false`;
    /// enforcement is the wrapper's job (the wire layer for remote
    /// buses, the GUI host for in-process ones).
    pub fd_enabled: bool,
}

impl BusConfig {
    /// 500 kbit/s classic-only — a common default.
    #[must_use]
    pub const fn classic_500k() -> Self {
        Self {
            speed_bps: 500_000,
            fd_data_speed_bps: None,
            fd_enabled: false,
        }
    }

    /// 500 kbit/s arbitration / 2 Mbit/s data, FD enabled.
    #[must_use]
    pub const fn fd_500k_2m() -> Self {
        Self {
            speed_bps: 500_000,
            fd_data_speed_bps: Some(2_000_000),
            fd_enabled: true,
        }
    }
}

/// An event delivered to a participant attached to a [`SharedBus`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParticipantEvent {
    /// A frame from another participant fanned out to this participant.
    /// `frame.direction` is `Rx` and `frame.timestamp_ns` is the bus's
    /// fan-out timestamp; `sender` is the [`ParticipantId`] of the
    /// participant that submitted the frame, so the recipient can
    /// attribute it without ambiguity (ADR 0021).
    Frame {
        frame: CanFrame,
        sender: ParticipantId,
    },
    /// One of this participant's previously submitted frames was sent
    /// on the bus but reached zero recipients. The frame is echoed back
    /// so the originator can correlate the failure with its TX.
    NoAcknowledger(CanFrame),
}

/// Returned by sink and handle operations after the bus has been
/// dropped or the corresponding participant detached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BusClosed;

impl core::fmt::Display for BusClosed {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("shared bus closed")
    }
}

impl std::error::Error for BusClosed {}

/// Sink half of a virtual participant. Implements [`CanFrameSink`] one frame
/// at a time; multi-frame batches go through [`LocalSink::submit_batch`]
/// so an entire batch enters the bus's queue atomically before any
/// arbitration round runs against it.
pub struct LocalSink {
    bus: Weak<BusInner>,
    participant_id: ParticipantId,
}

/// Source half of a virtual participant.
pub struct LocalSource {
    events_rx: Receiver<ParticipantEvent>,
    participant_id: ParticipantId,
}

/// Handle to a bridge installed on the bus. Drop to detach. The
/// ingress/egress threads it owns are detached on drop (not
/// synchronously joined) and self-terminate — see [`Self::drop`].
pub struct BridgeHandle {
    bus: Weak<BusInner>,
    participant_id: ParticipantId,
    shutdown: Arc<AtomicBool>,
    _ingress: JoinHandle<()>,
    _egress: JoinHandle<()>,
}

/// One CAN bus shared by N participants.
pub struct SharedBus {
    inner: Arc<BusInner>,
    worker: Option<JoinHandle<()>>,
}

/// Server-allocated identifier for a participant on a [`SharedBus`].
///
/// Allocated by [`SharedBus::attach_participant`] /
/// [`SharedBus::attach_bridge`]; monotonic per bus lifetime, never
/// re-used. The wire-layer factory id (e.g. `virtual:bus0/p7`) is
/// derived from this by the server wrapper.
pub type ParticipantId = u64;

struct BusInner {
    state: Mutex<BusState>,
    cv: Condvar,
}

struct BusState {
    config: BusConfig,
    busy_until: Instant,
    next_participant_id: ParticipantId,
    participants: Vec<Participant>,
    shutdown: bool,
}

struct Participant {
    id: ParticipantId,
    /// Outgoing TX queue. Bridge participants never enqueue here — their
    /// ingress bypasses arbitration and their egress is handled by the
    /// bridge's background thread, so the queue stays empty for them.
    queue: VecDeque<QueuedTx>,
    /// Where fan-out events go. For local participants this is the user's
    /// [`LocalSource`]; for bridges it's the egress thread that
    /// forwards frames to the bridge's remote sink.
    events_tx: Sender<ParticipantEvent>,
    kind: ParticipantKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParticipantKind {
    Local,
    Bridge,
}

struct QueuedTx {
    frame: CanFrame,
    enqueued_at: Instant,
}

impl SharedBus {
    /// Construct a fresh bus. Spawns one background worker thread that
    /// runs the arbitration loop; the thread exits when this
    /// [`SharedBus`] is dropped.
    #[must_use]
    pub fn new(config: BusConfig) -> Self {
        let inner = Arc::new(BusInner {
            state: Mutex::new(BusState {
                config,
                busy_until: Instant::now(),
                next_participant_id: 0,
                participants: Vec::new(),
                shutdown: false,
            }),
            cv: Condvar::new(),
        });
        let worker_inner = inner.clone();
        let worker = thread::Builder::new()
            .name("cannet-shared-bus".into())
            .spawn(move || run_worker(&worker_inner))
            .expect("spawning bus worker");
        Self {
            inner,
            worker: Some(worker),
        }
    }

    /// Attach a fresh virtual participant. Dropping the returned [`LocalSink`]
    /// detaches the participant.
    #[must_use]
    pub fn attach_participant(&self) -> (LocalSink, LocalSource) {
        let (events_tx, events_rx) = mpsc::channel();
        let participant_id = {
            let mut state = self.inner.state.lock().expect("bus state poisoned");
            let id = state.next_participant_id;
            state.next_participant_id += 1;
            state.participants.push(Participant {
                id,
                queue: VecDeque::new(),
                events_tx,
                kind: ParticipantKind::Local,
            });
            id
        };
        let sink = LocalSink {
            bus: Arc::downgrade(&self.inner),
            participant_id,
        };
        let source = LocalSource {
            events_rx,
            participant_id,
        };
        (sink, source)
    }

    /// Attach a bridge participant.
    ///
    /// Frames pulled from `remote_source` fan out to every other participant
    /// on the bus immediately, bypassing the virtual arbiter. Frames
    /// the bus delivers to the bridge are forwarded to `remote_sink`
    /// with [`Direction::Tx`].
    ///
    /// The bridge spawns two background threads: an *ingress* thread
    /// that calls `remote_source.next_frame()` in a loop, and an
    /// *egress* thread that drains the bus's per-bridge event channel
    /// into `remote_sink`. Dropping the returned handle signals both
    /// threads to exit and removes the bridge participant from the
    /// bus; the threads are *detached* (not synchronously joined) and
    /// self-terminate shortly after — egress wakes immediately on the
    /// participant's `events_tx` drop, and ingress wakes when its
    /// source's end-of-stream signal lands (the caller's
    /// responsibility to arrange via the source's drop chain).
    /// Dropping a `BridgeHandle` is therefore safe from any context
    /// including a tokio worker; callers that need a synchronous
    /// guarantee should drive their source to end-of-stream first.
    pub fn attach_bridge<S, R>(
        &self,
        name: &str,
        mut remote_sink: S,
        mut remote_source: R,
    ) -> BridgeHandle
    where
        S: CanFrameSink + Send + 'static,
        R: CanFrameSource + Send + 'static,
    {
        let (egress_tx, egress_rx) = mpsc::channel::<ParticipantEvent>();
        let participant_id = {
            let mut state = self.inner.state.lock().expect("bus state poisoned");
            let id = state.next_participant_id;
            state.next_participant_id += 1;
            state.participants.push(Participant {
                id,
                queue: VecDeque::new(),
                events_tx: egress_tx,
                kind: ParticipantKind::Bridge,
            });
            id
        };

        let shutdown = Arc::new(AtomicBool::new(false));

        let shutdown_for_egress = shutdown.clone();
        let egress_name = name.to_owned();
        let egress = thread::Builder::new()
            .name(format!("cannet-bridge-egress[{egress_name}]"))
            .spawn(move || {
                while let Ok(event) = egress_rx.recv() {
                    if shutdown_for_egress.load(Ordering::Relaxed) {
                        return;
                    }
                    let ParticipantEvent::Frame { mut frame, .. } = event else {
                        // Bridges don't generate TX through the virtual
                        // arbiter, so they never receive NoAcknowledger.
                        continue;
                    };
                    frame.direction = Direction::Tx;
                    if remote_sink.submit(frame).is_err() {
                        return;
                    }
                }
            })
            .expect("spawning bridge egress");

        let shutdown_for_ingress = shutdown.clone();
        let inner_for_ingress = Arc::downgrade(&self.inner);
        let ingress_name = name.to_owned();
        let ingress = thread::Builder::new()
            .name(format!("cannet-bridge-ingress[{ingress_name}]"))
            .spawn(move || loop {
                if shutdown_for_ingress.load(Ordering::Relaxed) {
                    return;
                }
                let Ok(Some(next)) = remote_source.next_frame() else {
                    return;
                };
                let Some(inner) = inner_for_ingress.upgrade() else {
                    return;
                };
                let mut state = inner.state.lock().expect("bus state poisoned");
                if state.shutdown {
                    return;
                }
                let timestamp_ns = wall_clock_ns();
                let _ = broadcast(&mut state, participant_id, &next, timestamp_ns);
            })
            .expect("spawning bridge ingress");

        BridgeHandle {
            bus: Arc::downgrade(&self.inner),
            participant_id,
            shutdown,
            _ingress: ingress,
            _egress: egress,
        }
    }

    /// Reconfigure the bus's bitrate / FD mode. Takes effect on the
    /// next arbitration round; the current `busy_until` is preserved
    /// so an in-flight frame is not retimed mid-transmission.
    pub fn reconfigure(&self, config: BusConfig) {
        let mut state = self.inner.state.lock().expect("bus state poisoned");
        state.config = config;
        self.inner.cv.notify_all();
    }
}

impl Drop for SharedBus {
    fn drop(&mut self) {
        {
            let mut state = self.inner.state.lock().expect("bus state poisoned");
            state.shutdown = true;
            // Drop every participant's events_tx so dependent threads (bridge
            // egress, local-source recv) wake on their next read.
            state.participants.clear();
        }
        self.inner.cv.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl LocalSink {
    /// The [`ParticipantId`] this sink submits as.
    #[must_use]
    pub fn id(&self) -> ParticipantId {
        self.participant_id
    }

    /// Submit a batch of frames atomically — the whole batch enters the
    /// participant's queue before any arbitration round runs against it. Use
    /// this whenever frames need to be considered together (e.g. when
    /// the wire's `FrameBatch` envelope carries several frames meant to
    /// arbitrate together against another participant's batch).
    pub fn submit_batch(&mut self, frames: Vec<CanFrame>) -> Result<(), BusClosed> {
        if frames.is_empty() {
            return Ok(());
        }
        let Some(inner) = self.bus.upgrade() else {
            return Err(BusClosed);
        };
        {
            let mut state = inner.state.lock().expect("bus state poisoned");
            if state.shutdown {
                return Err(BusClosed);
            }
            let Some(participant) = state.participants.iter_mut().find(|n| n.id == self.participant_id) else {
                return Err(BusClosed);
            };
            let now = Instant::now();
            for frame in frames {
                participant.queue.push_back(QueuedTx {
                    frame,
                    enqueued_at: now,
                });
            }
        }
        inner.cv.notify_all();
        Ok(())
    }
}

impl CanFrameSink for LocalSink {
    type Error = BusClosed;

    fn submit(&mut self, frame: CanFrame) -> Result<(), Self::Error> {
        self.submit_batch(vec![frame])
    }
}

impl Drop for LocalSink {
    fn drop(&mut self) {
        if let Some(inner) = self.bus.upgrade() {
            let mut state = inner.state.lock().expect("bus state poisoned");
            state.participants.retain(|n| n.id != self.participant_id);
            inner.cv.notify_all();
        }
    }
}

impl LocalSource {
    /// The [`ParticipantId`] this source receives as.
    #[must_use]
    pub fn id(&self) -> ParticipantId {
        self.participant_id
    }

    /// Block until the next event arrives. Returns `None` once the
    /// participant is detached and all queued events have drained.
    pub fn next_event(&mut self) -> Option<ParticipantEvent> {
        self.events_rx.recv().ok()
    }

    /// Non-blocking poll. `Ok(Some)` when an event is ready, `Ok(None)`
    /// when no event is pending but the participant is still attached,
    /// `Err(BusClosed)` once the participant has been detached and the queue
    /// drained.
    pub fn try_next(&mut self) -> Result<Option<ParticipantEvent>, BusClosed> {
        match self.events_rx.try_recv() {
            Ok(event) => Ok(Some(event)),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err(BusClosed),
        }
    }
}

impl BridgeHandle {
    /// The [`ParticipantId`] the bus assigned this bridge.
    #[must_use]
    pub fn id(&self) -> ParticipantId {
        self.participant_id
    }
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(inner) = self.bus.upgrade() {
            let mut state = inner.state.lock().expect("bus state poisoned");
            // Removing the participant drops its events_tx, which wakes the
            // egress thread's `recv` with `Err`.
            state.participants.retain(|n| n.id != self.participant_id);
            inner.cv.notify_all();
        }
        // The egress and ingress `JoinHandle`s in `self` drop (detached,
        // no join) when this method returns. Both threads self-terminate:
        //
        // - **egress**: woken by the `events_tx` drop above; its
        //   blocking `recv` returns `Err` and the thread exits.
        // - **ingress**: blocked on `remote_source.next_frame()`. When
        //   the source's end-of-stream signal lands (its own drop
        //   chain closes its channel), the thread returns and exits.
        //
        // Joining synchronously here would block whoever runs this
        // drop. Callers on a tokio worker would deadlock the very
        // abort processing their bridge source depends on to signal
        // end-of-stream — so this method stays cheap. Threads finish
        // in the microseconds after this returns.
    }
}

fn run_worker(inner: &Arc<BusInner>) {
    let mut state = inner.state.lock().expect("bus state poisoned");
    loop {
        if state.shutdown {
            return;
        }
        let now = Instant::now();
        let pending_local = state
            .participants
            .iter()
            .any(|n| n.kind == ParticipantKind::Local && !n.queue.is_empty());
        if !pending_local {
            state = inner.cv.wait(state).expect("bus state poisoned");
            continue;
        }
        if state.busy_until > now {
            let wait = state.busy_until - now;
            let (next, _) = inner
                .cv
                .wait_timeout(state, wait)
                .expect("bus state poisoned");
            state = next;
            continue;
        }
        let Some(winner_idx) = pick_winner_local(&state) else {
            // Caught the rare case where the queues drained between the
            // pending check and the lock re-acquire after a timeout.
            continue;
        };
        let queued = state.participants[winner_idx]
            .queue
            .pop_front()
            .expect("winner non-empty");
        let originator_id = state.participants[winner_idx].id;
        let frame = queued.frame;
        let duration = frame_duration(&frame, &state.config);
        let start = state.busy_until.max(now);
        let end = start + duration;
        state.busy_until = end;
        let timestamp_ns = wall_clock_ns();
        let delivered = broadcast(&mut state, originator_id, &frame, timestamp_ns);
        if delivered == 0 {
            send_no_acknowledger(&state, originator_id, frame);
        }
    }
}

fn pick_winner_local(state: &BusState) -> Option<usize> {
    let mut best: Option<(usize, u32, Instant)> = None;
    for (idx, participant) in state.participants.iter().enumerate() {
        if participant.kind != ParticipantKind::Local {
            continue;
        }
        let Some(head) = participant.queue.front() else {
            continue;
        };
        let head_id = head.frame.id.raw();
        let head_enq = head.enqueued_at;
        match best {
            None => best = Some((idx, head_id, head_enq)),
            Some((_, best_id, best_enq)) => {
                if head_id < best_id || (head_id == best_id && head_enq < best_enq) {
                    best = Some((idx, head_id, head_enq));
                }
            }
        }
    }
    best.map(|(idx, _, _)| idx)
}

/// Fan out a frame to every participant except the originator. Returns the
/// number of recipients that actually received it (live channels);
/// dead channels are cleaned up in the same pass.
fn broadcast(
    state: &mut BusState,
    originator_id: ParticipantId,
    frame: &CanFrame,
    timestamp_ns: u64,
) -> usize {
    let mut delivered = 0;
    let mut dead: Vec<ParticipantId> = Vec::new();
    for participant in state.participants.iter().filter(|n| n.id != originator_id) {
        let mut copy = frame.clone();
        copy.timestamp_ns = timestamp_ns;
        copy.direction = Direction::Rx;
        let event = ParticipantEvent::Frame {
            frame: copy,
            sender: originator_id,
        };
        if participant.events_tx.send(event).is_ok() {
            delivered += 1;
        } else {
            dead.push(participant.id);
        }
    }
    if !dead.is_empty() {
        state.participants.retain(|n| !dead.contains(&n.id));
    }
    delivered
}

fn send_no_acknowledger(state: &BusState, originator_id: ParticipantId, frame: CanFrame) {
    if let Some(participant) = state.participants.iter().find(|n| n.id == originator_id) {
        let _ = participant.events_tx.send(ParticipantEvent::NoAcknowledger(frame));
    }
}

/// Approximate on-wire duration of `frame` at the configured bit rates.
///
/// Classic CAN uses a fixed header (47 bits for standard, 67 for
/// extended) plus 8 bits per data byte. CAN FD uses the same header at
/// the arbitration rate plus a data-phase tail (25 bits of trailer + 8
/// bits per data byte) at `fd_data_speed_bps` when BRS is set. Error
/// frames are modelled as 13 bits. Bit-stuffing overhead is not
/// included — this is the virtual-bus arbiter's timeline, not a
/// wire-accurate clock.
fn frame_duration(frame: &CanFrame, config: &BusConfig) -> Duration {
    let arb_speed = config.speed_bps.max(1);
    let extended = frame.id.is_extended();
    let header_bits: u64 = if extended { 67 } else { 47 };
    match &frame.payload {
        CanFramePayload::Classic(data) => {
            let bits = header_bits + 8 * (data.len() as u64);
            ns_for(bits, arb_speed)
        }
        CanFramePayload::Remote { .. } => ns_for(header_bits, arb_speed),
        CanFramePayload::Fd { data, flags } => {
            let data_bits = 25 + 8 * (data.len() as u64);
            let data_speed = if flags.bitrate_switch {
                config.fd_data_speed_bps.unwrap_or(arb_speed).max(1)
            } else {
                arb_speed
            };
            ns_for(header_bits, arb_speed) + ns_for(data_bits, data_speed)
        }
        CanFramePayload::Error => ns_for(13, arb_speed),
    }
}

fn ns_for(bits: u64, speed_bps: u64) -> Duration {
    Duration::from_nanos(bits.saturating_mul(1_000_000_000) / speed_bps.max(1))
}

/// Wall-clock nanoseconds since the Unix epoch. Every frame that lands
/// in the trace — the GUI host's tx-confirms, hardware RX, and this
/// virtual bus's fan-out — is stamped on this one clock, so a
/// transmitted frame and its received copy share a time base. The vbus
/// is a made-up bus; it stamps with the same clock as the real ones
/// rather than its own relative epoch, which kept the receiver's
/// samples off the plot's first-frame-anchored x-axis.
fn wall_clock_ns() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{CanFrame, CanFdFlags, CanId, Direction};

    fn classic(id: u32, data: Vec<u8>) -> CanFrame {
        CanFrame::classic(0, 0, CanId::standard(id).unwrap(), Direction::Tx, data).unwrap()
    }

    fn fd(id: u32, data: Vec<u8>, brs: bool) -> CanFrame {
        CanFrame::fd(
            0,
            0,
            CanId::standard(id).unwrap(),
            Direction::Tx,
            data,
            CanFdFlags {
                bitrate_switch: brs,
                error_state_indicator: false,
            },
        )
        .unwrap()
    }

    fn drain_events(src: &mut LocalSource, count: usize, timeout: Duration) -> Vec<ParticipantEvent> {
        let deadline = Instant::now() + timeout;
        let mut out = Vec::with_capacity(count);
        while out.len() < count && Instant::now() < deadline {
            match src.try_next() {
                Ok(Some(event)) => out.push(event),
                Ok(None) => thread::sleep(Duration::from_millis(1)),
                Err(_) => break,
            }
        }
        out
    }

    fn drain_frames(src: &mut LocalSource, count: usize, timeout: Duration) -> Vec<CanFrame> {
        drain_events(src, count, timeout)
            .into_iter()
            .filter_map(|e| match e {
                ParticipantEvent::Frame { frame, .. } => Some(frame),
                ParticipantEvent::NoAcknowledger(_) => None,
            })
            .collect()
    }

    #[test]
    fn fanout_excludes_the_originator() {
        let bus = SharedBus::new(BusConfig::classic_500k());
        let (mut a_sink, mut a_src) = bus.attach_participant();
        let (_b_sink, mut b_src) = bus.attach_participant();

        a_sink.submit(classic(0x100, vec![1, 2, 3])).unwrap();

        let b_frames = drain_frames(&mut b_src, 1, Duration::from_millis(500));
        assert_eq!(b_frames.len(), 1);
        assert_eq!(b_frames[0].direction, Direction::Rx);
        assert_eq!(b_frames[0].id.raw(), 0x100);
        assert_eq!(b_frames[0].payload.data(), &[1, 2, 3]);

        // The originator does not see its own frame come back.
        assert!(matches!(a_src.try_next(), Ok(None)));
    }

    #[test]
    fn fanout_event_carries_originator_id_as_sender() {
        let bus = SharedBus::new(BusConfig::classic_500k());
        let (mut a_sink, _a_src) = bus.attach_participant();
        let (_b_sink, mut b_src) = bus.attach_participant();
        let a_id = a_sink.id();

        a_sink.submit(classic(0x100, vec![0xAA])).unwrap();

        let events = drain_events(&mut b_src, 1, Duration::from_millis(500));
        match events.first() {
            Some(ParticipantEvent::Frame { sender, frame }) => {
                assert_eq!(*sender, a_id, "fan-out should be tagged with sender id");
                assert_eq!(frame.id.raw(), 0x100);
            }
            other => panic!("expected Frame, got {other:?}"),
        }
    }

    #[test]
    fn solo_transmit_yields_no_acknowledger() {
        let bus = SharedBus::new(BusConfig::classic_500k());
        let (mut sink, mut src) = bus.attach_participant();

        sink.submit(classic(0x123, vec![1, 2])).unwrap();

        let events = drain_events(&mut src, 1, Duration::from_millis(500));
        match events.first() {
            Some(ParticipantEvent::NoAcknowledger(f)) => {
                assert_eq!(f.id.raw(), 0x123);
                assert_eq!(f.payload.data(), &[1, 2]);
            }
            other => panic!("expected NoAcknowledger, got {other:?}"),
        }
    }

    #[test]
    fn per_participant_fifo_arbitration_lowest_id_wins() {
        // 50 kbit/s makes each empty-payload classic frame ~940 µs, so
        // the test code has plenty of time to load both participants' batches
        // before the worker pops the first frame.
        let bus = SharedBus::new(BusConfig {
            speed_bps: 50_000,
            fd_data_speed_bps: None,
            fd_enabled: false,
        });
        let (mut a_sink, _a_src) = bus.attach_participant();
        let (mut b_sink, _b_src) = bus.attach_participant();
        let (_o_sink, mut observer) = bus.attach_participant();

        a_sink
            .submit_batch(vec![
                classic(0x000, vec![]),
                classic(0x000, vec![]),
                classic(0x500, vec![]),
            ])
            .unwrap();
        b_sink.submit_batch(vec![classic(0x100, vec![])]).unwrap();

        let frames = drain_frames(&mut observer, 4, Duration::from_secs(2));
        let ids: Vec<u32> = frames.iter().map(|f| f.id.raw()).collect();
        assert_eq!(ids, vec![0x000, 0x000, 0x100, 0x500]);
    }

    #[test]
    fn back_to_back_frames_have_strictly_increasing_timestamps() {
        let bus = SharedBus::new(BusConfig::classic_500k());
        let (mut sink, _src_a) = bus.attach_participant();
        let (_sink_b, mut observer) = bus.attach_participant();

        sink.submit_batch(vec![
            classic(0x123, vec![0; 8]),
            classic(0x123, vec![0; 8]),
            classic(0x123, vec![0; 8]),
        ])
        .unwrap();

        let frames = drain_frames(&mut observer, 3, Duration::from_millis(500));
        assert_eq!(frames.len(), 3);
        // A classic 0x123 with 8 data bytes at 500 kbit/s is
        // 47 + 64 = 111 bits ≈ 222 µs per frame.
        let min_delta_ns: u64 = 100_000;
        assert!(frames[1].timestamp_ns - frames[0].timestamp_ns >= min_delta_ns);
        assert!(frames[2].timestamp_ns - frames[1].timestamp_ns >= min_delta_ns);
    }

    #[test]
    fn fanout_timestamps_ride_the_wall_clock() {
        // The fan-out copy of a transmitted frame must be stamped on the
        // same wall clock the rest of the analyzer uses (the GUI host's
        // tx-confirms, hardware RX). A bus-relative epoch stamp is
        // decades adrift from wall time, so a transmitted frame and its
        // received copy would land on two different time bases in one
        // trace buffer — and the plot, which anchors its x-axis on the
        // window's first-frame timestamp, shoves the receiver's samples
        // off-canvas. The vbus is a made-up bus; it shouldn't diverge
        // from the real ones on something as basic as what clock it
        // stamps with.
        let bus = SharedBus::new(BusConfig::classic_500k());
        let (mut sink, _src_a) = bus.attach_participant();
        let (_sink_b, mut observer) = bus.attach_participant();
        sink.submit(classic(0x100, vec![1])).unwrap();
        let frames = drain_frames(&mut observer, 1, Duration::from_secs(1));
        assert_eq!(frames.len(), 1);
        let wall_now = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        )
        .unwrap();
        let ts = frames[0].timestamp_ns;
        assert!(
            wall_now.abs_diff(ts) < 5_000_000_000,
            "fan-out timestamp {ts} ns is not on the wall clock (now {wall_now} ns)",
        );
    }

    #[test]
    fn reconfigure_changes_frame_duration() {
        // The bitrate→duration scaling is a pure property of
        // `frame_duration`. Assert it directly: delivered timestamps now
        // ride the wall clock (paced by, but no longer derived from, the
        // simulated on-wire duration), so they can't be used to measure
        // the simulated spacing deterministically.
        let slow_cfg = BusConfig { speed_bps: 50_000, fd_data_speed_bps: None, fd_enabled: false };
        let fast_cfg = BusConfig { speed_bps: 5_000_000, fd_data_speed_bps: None, fd_enabled: false };
        let frame = classic(0x100, vec![0; 8]);
        assert!(
            frame_duration(&frame, &fast_cfg) * 10 < frame_duration(&frame, &slow_cfg),
            "expected the faster bitrate to shorten the frame duration"
        );

        // And `reconfigure` keeps the bus delivering after a mid-stream
        // config swap.
        let bus = SharedBus::new(slow_cfg);
        let (mut sink, _src_a) = bus.attach_participant();
        let (_sink_b, mut observer) = bus.attach_participant();
        bus.reconfigure(fast_cfg);
        sink.submit(classic(0x100, vec![0; 8])).unwrap();
        let frames = drain_frames(&mut observer, 1, Duration::from_secs(1));
        assert_eq!(frames.len(), 1);
    }

    #[test]
    fn fd_brs_speeds_up_data_phase() {
        // Two FD frames, same id and payload, on a bus with classic and
        // data-phase rates. With BRS the data phase rides the higher
        // rate; without it, the data phase falls back to the
        // arbitration rate. So the BRS frame should transmit faster.
        let config = BusConfig::fd_500k_2m();
        let no_brs = frame_duration(&fd(0x100, vec![0; 64], false), &config);
        let with_brs = frame_duration(&fd(0x100, vec![0; 64], true), &config);
        assert!(
            with_brs < no_brs,
            "BRS should shorten the data phase: with_brs={with_brs:?} no_brs={no_brs:?}"
        );
    }

    #[test]
    fn dropping_a_sink_detaches_the_participant() {
        let bus = SharedBus::new(BusConfig::classic_500k());
        let (mut a_sink, mut a_src) = bus.attach_participant();
        let (b_sink, _b_src) = bus.attach_participant();

        // While b is alive, a's transmit fans out and a receives no NoAck.
        a_sink.submit(classic(0x100, vec![1])).unwrap();
        let alive = drain_events(&mut a_src, 1, Duration::from_millis(200));
        assert!(alive.is_empty(), "a should not receive events while b acks");

        drop(b_sink);

        // After b detaches, a's next transmit has zero recipients and
        // a receives NoAcknowledger.
        a_sink.submit(classic(0x101, vec![2])).unwrap();
        let events = drain_events(&mut a_src, 1, Duration::from_millis(500));
        match events.first() {
            Some(ParticipantEvent::NoAcknowledger(f)) => assert_eq!(f.id.raw(), 0x101),
            other => panic!("expected NoAcknowledger after b dropped, got {other:?}"),
        }
    }

    #[test]
    fn dropping_the_bus_closes_open_sinks() {
        let bus = SharedBus::new(BusConfig::classic_500k());
        let (mut sink, _src) = bus.attach_participant();
        drop(bus);
        assert_eq!(sink.submit(classic(0x100, vec![])), Err(BusClosed));
    }

    // ---- Bridge tests ----

    #[derive(Clone, Default)]
    struct CapturingSink {
        captured: Arc<Mutex<Vec<CanFrame>>>,
    }

    impl CanFrameSink for CapturingSink {
        type Error = BusClosed;

        fn submit(&mut self, frame: CanFrame) -> Result<(), Self::Error> {
            self.captured.lock().expect("captured poisoned").push(frame);
            Ok(())
        }
    }

    struct EmptySource;

    impl CanFrameSource for EmptySource {
        type Error = BusClosed;

        fn next_frame(&mut self) -> Result<Option<CanFrame>, Self::Error> {
            Ok(None)
        }
    }

    /// One-shot source that yields the queued frames in order and then
    /// signals end-of-stream. The ingress thread joins cleanly when it
    /// drains the queue.
    struct QueuedSource {
        frames: VecDeque<CanFrame>,
    }

    impl CanFrameSource for QueuedSource {
        type Error = BusClosed;

        fn next_frame(&mut self) -> Result<Option<CanFrame>, Self::Error> {
            Ok(self.frames.pop_front())
        }
    }

    fn await_captured(captured: &Arc<Mutex<Vec<CanFrame>>>, count: usize, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            if captured.lock().expect("captured poisoned").len() >= count {
                return;
            }
            if Instant::now() >= deadline {
                return;
            }
            thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn bridge_egress_receives_bus_fanout_as_tx() {
        let bus = SharedBus::new(BusConfig::classic_500k());
        let captured = Arc::new(Mutex::new(Vec::new()));
        let bridge = bus.attach_bridge(
            "test-bridge",
            CapturingSink {
                captured: captured.clone(),
            },
            EmptySource,
        );
        let (mut a_sink, _a_src) = bus.attach_participant();

        a_sink.submit(classic(0x321, vec![7, 7])).unwrap();

        await_captured(&captured, 1, Duration::from_millis(500));
        let captured = captured.lock().expect("captured poisoned");
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].direction, Direction::Tx);
        assert_eq!(captured[0].id.raw(), 0x321);
        assert_eq!(captured[0].payload.data(), &[7, 7]);

        drop(bridge);
    }

    #[test]
    fn bridge_ingress_fans_out_to_other_participants() {
        let bus = SharedBus::new(BusConfig::classic_500k());
        let (_a_sink, mut a_src) = bus.attach_participant();
        let bridge = bus.attach_bridge(
            "ingress",
            CapturingSink::default(),
            QueuedSource {
                frames: VecDeque::from([classic(0x250, vec![9, 9])]),
            },
        );

        let frames = drain_frames(&mut a_src, 1, Duration::from_millis(500));
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].id.raw(), 0x250);
        assert_eq!(frames[0].direction, Direction::Rx);
        assert_eq!(frames[0].payload.data(), &[9, 9]);

        drop(bridge);
    }

    #[test]
    fn bridge_presence_prevents_no_acknowledger_for_local_tx() {
        // A bridge counts as a recipient — its controller acks on the
        // physical side. So a local TX with only a bridge listening
        // does not see NoAcknowledger.
        let bus = SharedBus::new(BusConfig::classic_500k());
        let captured = Arc::new(Mutex::new(Vec::new()));
        let bridge = bus.attach_bridge(
            "ack",
            CapturingSink {
                captured: captured.clone(),
            },
            EmptySource,
        );
        let (mut sink, mut src) = bus.attach_participant();

        sink.submit(classic(0x100, vec![1])).unwrap();

        await_captured(&captured, 1, Duration::from_millis(500));
        assert_eq!(captured.lock().expect("captured poisoned").len(), 1);

        // The originator does not see its own frame nor a NoAck.
        let events = drain_events(&mut src, 1, Duration::from_millis(200));
        assert!(events.is_empty(), "unexpected events: {events:?}");

        drop(bridge);
    }
}
