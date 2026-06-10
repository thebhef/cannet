//! In-memory loopback bus: a paired [`CanFrameSink`] / [`CanFrameSource`]
//! that echoes every frame submitted to the sink straight to the source.
//!
//! The Phase-5 demo and test scaffold for the transmit path. The
//! `cannet-server --loopback` mode wraps a [`loopback_bus`] so a remote
//! client's transmits are reflected back as if they came off a bus,
//! without needing real hardware or a kernel virtual CAN device. The
//! same primitive backs unit tests of the GUI's transmit pipeline.
//!
//! Capacity is unbounded — the underlying queue is an
//! [`std::sync::mpsc`] channel. Bounded variants and inserting a
//! timestamp / direction rewrite (Rx vs. Tx) are deliberately *not* in
//! the primitive: callers that want them wrap the sink. The transmit
//! pipeline rewrites frames to [`Direction::Rx`] on the way through the
//! loopback so the consumer sees them as "received from the wire",
//! matching what real hardware would do.

use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};

use crate::frame::CanFrame;
use crate::io::{CanFrameSink, CanFrameSource};

/// Construct a fresh loopback bus: a connected
/// (sink, source) pair. Every frame submitted to the [`LoopbackSink`]
/// is delivered, in order, to the [`LoopbackSource`].
///
/// Dropping either side closes the channel:
///
/// - Drop the sink ⇒ the source drains remaining frames, then
///   [`LoopbackSource::next_frame`] returns `Ok(None)` (end-of-stream).
/// - Drop the source ⇒ subsequent [`LoopbackSink::submit`] calls return
///   `Err(LoopbackBusClosed)`.
#[must_use]
pub fn loopback_bus() -> (LoopbackSink, LoopbackSource) {
    let (tx, rx) = mpsc::channel();
    (LoopbackSink { tx }, LoopbackSource { rx })
}

/// Sink half of a [`loopback_bus`].
pub struct LoopbackSink {
    tx: Sender<CanFrame>,
}

impl CanFrameSink for LoopbackSink {
    type Error = LoopbackBusClosed;

    fn submit(&mut self, frame: CanFrame) -> Result<(), Self::Error> {
        self.tx.send(frame).map_err(|_| LoopbackBusClosed)
    }
}

/// Source half of a [`loopback_bus`]. Implements [`CanFrameSource`]
/// blockingly: `next_frame` parks until the next frame arrives, returns
/// `Ok(None)` once every clone of the sink has been dropped.
pub struct LoopbackSource {
    rx: Receiver<CanFrame>,
}

impl LoopbackSource {
    /// Non-blocking poll. Returns `Ok(Some(frame))` if one is ready,
    /// `Ok(None)` if the channel is empty but the sink is still live,
    /// `Err(LoopbackBusClosed)` once every sink has been dropped *and*
    /// the queue is drained.
    ///
    /// Useful for an `async` server task that wants to interleave the
    /// loopback feed with `tokio::select!` arms — it polls the queue
    /// each loop iteration and yields when there's nothing to do.
    pub fn try_next(&mut self) -> Result<Option<CanFrame>, LoopbackBusClosed> {
        match self.rx.try_recv() {
            Ok(frame) => Ok(Some(frame)),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err(LoopbackBusClosed),
        }
    }
}

impl CanFrameSource for LoopbackSource {
    type Error = LoopbackBusClosed;

    fn next_frame(&mut self) -> Result<Option<CanFrame>, Self::Error> {
        // `Ok(None)` semantics: every sink dropped *and* the queue is
        // drained — i.e. end-of-stream. `recv` returns `Err` precisely
        // in that case.
        match self.rx.recv() {
            Ok(frame) => Ok(Some(frame)),
            Err(_) => Ok(None),
        }
    }
}

/// Returned by [`LoopbackSink::submit`] when every source clone has
/// been dropped, and by [`LoopbackSource::try_next`] once the channel
/// is fully disconnected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoopbackBusClosed;

impl core::fmt::Display for LoopbackBusClosed {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("loopback bus closed: no live source")
    }
}

impl std::error::Error for LoopbackBusClosed {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{CanId, Direction};

    fn frame(ts: u64) -> CanFrame {
        let id = CanId::standard(0x123).unwrap();
        CanFrame::classic(ts, 0, id, Direction::Tx, vec![u8::try_from(ts & 0xFF).unwrap()])
            .unwrap()
    }

    #[test]
    fn submitted_frames_are_delivered_in_order() {
        let (mut sink, mut source) = loopback_bus();
        sink.submit(frame(1)).unwrap();
        sink.submit(frame(2)).unwrap();
        sink.submit(frame(3)).unwrap();

        let a = source.next_frame().unwrap().unwrap();
        let b = source.next_frame().unwrap().unwrap();
        let c = source.next_frame().unwrap().unwrap();
        assert_eq!([a.timestamp_ns, b.timestamp_ns, c.timestamp_ns], [1, 2, 3]);
    }

    #[test]
    fn source_observes_end_of_stream_when_sink_is_dropped() {
        let (mut sink, mut source) = loopback_bus();
        sink.submit(frame(7)).unwrap();
        drop(sink);
        assert_eq!(source.next_frame().unwrap().unwrap().timestamp_ns, 7);
        assert!(source.next_frame().unwrap().is_none());
    }

    #[test]
    fn sink_submit_errors_after_source_is_dropped() {
        let (mut sink, source) = loopback_bus();
        drop(source);
        assert_eq!(sink.submit(frame(1)), Err(LoopbackBusClosed));
    }

    #[test]
    fn try_next_returns_none_when_empty_and_err_when_closed() {
        let (mut sink, mut source) = loopback_bus();
        assert_eq!(source.try_next().unwrap(), None);
        sink.submit(frame(4)).unwrap();
        assert_eq!(source.try_next().unwrap().unwrap().timestamp_ns, 4);
        drop(sink);
        // Empty + sink dropped -> error (channel disconnected).
        assert!(source.try_next().is_err());
    }
}
