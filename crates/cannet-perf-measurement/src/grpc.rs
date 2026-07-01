//! gRPC mode — virtual bus over the real wire.
//!
//! Stands up an in-process `cannet-server` virtual bus on an ephemeral
//! localhost port, connects two `cannet-client` sessions to it (one
//! transmits the workload schedule, one receives), and feeds the
//! received frames into a real `TraceStore` while the same filtered scan
//! contends — exactly the tracebuffer mode's model and metrics, but the frames now
//! travel the production gRPC path (`SessionTransmitter` → server
//! `SharedBus` fan-out → `FrameReceiver`) instead of a local `append`.
//! Ingest rate is wire-bound, so this mode surfaces serialization /
//! fan-out cost on top of the lock contention.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cannet_client::{connect_and_subscribe, Subscription};
use cannet_core::{BusConfig, CanFrame, CanFramePayload, CanFrameSource, CanId, Direction};
use cannet_gui_lib::trace_store::{RawTraceFrame, TraceStore};
use cannet_server::{serve_virtual_bus_ephemeral, VIRTUAL_BUS_FACTORY_ID};

use crate::runner::{
    build_report, current_rss_mb, parse_predicate, scan_loop, HarnessReport, IngestRecorder,
    RunParams,
};
use crate::workload::ScheduledMessage;
use crate::LoadedExample;

/// gRPC-mode run parameters.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GrpcConfig {
    /// Stop once the receiver has stored this many frames.
    pub target_frames: usize,
    /// Transmit pace, frames/s (the offered wire load). `0` = flat-out.
    pub tx_hz: f64,
    /// Run the contending filtered scan.
    pub scan: bool,
    /// Full-scan rate, Hz.
    pub scan_hz: f64,
    /// Filter predicate the scan evaluates, as JSON.
    pub predicate: serde_json::Value,
}

impl Default for GrpcConfig {
    fn default() -> Self {
        Self {
            target_frames: 50_000,
            tx_hz: 5_000.0,
            scan: true,
            scan_hz: 8.0,
            predicate: serde_json::json!({ "bus": "pt" }),
        }
    }
}

/// Run the grpc workload and return its report.
///
/// # Errors
/// Returns a message if the in-process server or either client session
/// fails to start / connect.
///
/// # Panics
/// Panics if a worker thread panics (e.g. the trace store mutex is
/// poisoned).
pub fn run(ex: &LoadedExample, cfg: &GrpcConfig) -> Result<HarnessReport, String> {
    let schedule = Arc::new(crate::workload::build_schedule(ex));
    // can_id → bus_id, to re-tag received frames (bus_id is a host-model
    // concept; it doesn't travel the wire).
    let bus_by_id: Arc<std::collections::HashMap<u32, String>> = Arc::new(
        schedule
            .iter()
            .map(|m| (m.can_id, m.bus_id.clone()))
            .collect(),
    );

    // Tokio runtime hosting the in-process virtual-bus server.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|e| format!("building tokio runtime: {e}"))?;
    let (addr_tx, addr_rx) = tokio::sync::oneshot::channel();
    let _server = rt.spawn(serve_virtual_bus_ephemeral(
        BusConfig::classic_500k(),
        addr_tx,
    ));
    let addr = rt
        .block_on(addr_rx)
        .map_err(|_| "virtual-bus server exited before binding".to_string())?;
    let address = addr.to_string();

    // TX session (factory subscription, channel 0) and RX session
    // (channel 1) — the receiver sees the transmitter's frames fanned out.
    let tx_session = connect_and_subscribe(
        &address,
        vec![Subscription::factory(VIRTUAL_BUS_FACTORY_ID, 0)],
    )
    .map_err(|e| format!("tx session connect: {e}"))?;
    let tx_alloc = tx_session
        .subscriptions()
        .first()
        .and_then(|s| s.allocated_id.clone())
        .ok_or_else(|| "tx session: no allocated id".to_string())?;
    let (tx_handle, _tx_recv, transmitter) = tx_session.into_parts();

    let rx_session = connect_and_subscribe(
        &address,
        vec![Subscription::factory(VIRTUAL_BUS_FACTORY_ID, 1)],
    )
    .map_err(|e| format!("rx session connect: {e}"))?;
    let (rx_handle, mut rx_recv, _rx_tx) = rx_session.into_parts();

    let store = Arc::new(TraceStore::new());
    store.start_session(0);
    let stop = Arc::new(AtomicBool::new(false));
    let rss_start = current_rss_mb();

    // TX thread: paced transmit of the schedule round-robin until stop.
    let tx = {
        let schedule = schedule.clone();
        let stop = stop.clone();
        let tx_hz = cfg.tx_hz;
        std::thread::spawn(move || tx_loop(&transmitter, &tx_alloc, &schedule, &stop, tx_hz))
    };

    // Scan thread: the contending filtered match-count refresh.
    let scan = if cfg.scan {
        let store = store.clone();
        let stop = stop.clone();
        let predicate = parse_predicate(&cfg.predicate);
        let hz = cfg.scan_hz;
        Some(std::thread::spawn(move || {
            scan_loop(&store, &stop, &predicate, hz)
        }))
    } else {
        None
    };

    // Ingest happens on this thread: drain the receiver into the store.
    let ingest_out = rx_ingest(&mut rx_recv, &store, &bus_by_id, cfg.target_frames);
    stop.store(true, Ordering::Relaxed);

    let _ = tx.join();
    let scan_durations = scan
        .map(|h| h.join().expect("scan thread panicked"))
        .unwrap_or_default();
    let rss_end = current_rss_mb();

    // Close sessions before tearing down the runtime.
    tx_handle.shutdown();
    rx_handle.shutdown();
    drop(rt);

    Ok(build_report(
        &RunParams {
            mode: "grpc",
            scan: cfg.scan,
            scan_hz: cfg.scan_hz,
            ingest_hz: cfg.tx_hz,
            predicate: cfg.predicate.clone(),
            target_frames: cfg.target_frames,
        },
        &ingest_out,
        &scan_durations,
        rss_start,
        rss_end,
    ))
}

/// Drain received frames into the store until the target is reached (or a
/// stall timeout trips), recording ingest samples + append latency.
/// Shared with the full-stack mode.
pub(crate) fn rx_ingest(
    rx: &mut cannet_client::FrameReceiver,
    store: &TraceStore,
    bus_by_id: &std::collections::HashMap<u32, String>,
    target: usize,
) -> crate::runner::IngestOut {
    let mut rec = IngestRecorder::new(target);
    let mut i: usize = 0;
    let mut stored = 0usize;
    // Guard against a stalled wire so the harness can't hang forever.
    let deadline = Instant::now() + Duration::from_secs(90);

    // `next_frame` returning `Ok(None)` (closed) or `Err` (transport
    // error) ends the loop; an explicit break handles target / timeout.
    while let Ok(Some(frame)) = rx.next_frame() {
        let id = frame.id.raw();
        let raw = RawTraceFrame {
            timestamp_ns: frame.timestamp_ns,
            channel: frame.channel,
            id,
            extended: frame.id.is_extended(),
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(frame.payload.data().to_vec()),
            bus_id: bus_by_id.get(&id).cloned(),
        };
        let a0 = Instant::now();
        store.append(raw);
        rec.record_append(i, a0.elapsed());
        i += 1;
        stored += 1;
        if i.is_multiple_of(1024) {
            let len = store.len();
            rec.maybe_sample(len, i);
        }
        if stored >= target || Instant::now() >= deadline {
            break;
        }
    }
    rec.finish(store.len(), i)
}

/// Transmit the schedule round-robin at `tx_hz` until `stop` is set.
/// Shared with the full-stack mode.
pub(crate) fn tx_loop(
    transmitter: &cannet_client::SessionTransmitter,
    interface_id: &str,
    schedule: &[ScheduledMessage],
    stop: &AtomicBool,
    tx_hz: f64,
) {
    if schedule.is_empty() {
        return;
    }
    let pace = (tx_hz > 0.0).then(|| Duration::from_secs_f64(1.0 / tx_hz));
    let start = Instant::now();
    let mut i: usize = 0;
    while !stop.load(Ordering::Relaxed) {
        let m = &schedule[i % schedule.len()];
        let Ok(id) = (if m.extended {
            CanId::extended(m.can_id)
        } else {
            CanId::standard(m.can_id)
        }) else {
            i += 1;
            continue;
        };
        // Timestamp is stamped on receive; 0 on transmit.
        if let Ok(frame) = CanFrame::classic(0, m.channel, id, Direction::Tx, m.payload.clone()) {
            if transmitter.transmit(interface_id, &frame).is_err() {
                break; // session closed
            }
        }
        i += 1;
        if let Some(pace) = pace {
            let deadline = start + pace * u32::try_from(i).unwrap_or(u32::MAX);
            loop {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                let rem = deadline.saturating_duration_since(now);
                if rem > Duration::from_millis(2) {
                    std::thread::sleep(rem.saturating_sub(Duration::from_millis(1)));
                } else {
                    std::thread::yield_now();
                }
            }
        }
    }
}
