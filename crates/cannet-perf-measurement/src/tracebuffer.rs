//! Tracebuffer mode — in-process host-model contention.
//!
//! The cheapest, most deterministic mode: no sidecar, no wire, no
//! hardware. It drives synthetic frames straight into a real
//! [`cannet_gui_lib::trace_store::TraceStore`] from one ingest thread
//! while a second thread runs the filtered-trace scan the GUI's scrollbar
//! match-count issues — the same `scan_chunk` loop, holding the same
//! store mutex. The headline numbers are **ingest-FPS retention** and the
//! **worst append stall**: how much of the uncontended append rate
//! survives, and how long a single append can block, as the buffer grows
//! under that scan. The Task 21 diagnosis found a buffer-proportional
//! decay here; this mode turns it into measured, diffable numbers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cannet_core::{CanFramePayload, Direction};
use cannet_gui_lib::trace_store::{RawTraceFrame, TraceStore};

use crate::runner::{
    build_report, current_rss_mb, parse_predicate, scan_loop, HarnessReport, IngestOut,
    IngestRecorder, RunParams,
};
use crate::workload::ScheduledMessage;
use crate::LoadedExample;

/// Tracebuffer-mode run parameters.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TracebufferConfig {
    /// Stop once the buffer reaches this many frames.
    pub target_frames: usize,
    /// Ingest pace, frames/s. Accelerated far above a real bus so the
    /// run is short, but bounded so it coexists with the scan the way a
    /// real bus does (flat-out ingest would fill the buffer before the
    /// scan runs, and would pathologically starve on the unfair mutex).
    /// `0` = flat-out (uncapped), for a raw append-throughput number.
    pub ingest_hz: f64,
    /// Run the contending filtered scan (false = ingest-only control).
    pub scan: bool,
    /// Full-scan rate, Hz — the GUI refreshes the match count ~8×/s.
    /// `0` = continuous (back-to-back); note that starves ingest on the
    /// unfair mutex and is not representative, so it is not the default.
    pub scan_hz: f64,
    /// Filter predicate the scan evaluates, as JSON. An id/bus predicate
    /// needs no decode, isolating the lock-contention cost.
    pub predicate: serde_json::Value,
}

impl Default for TracebufferConfig {
    fn default() -> Self {
        Self {
            target_frames: 200_000,
            ingest_hz: 25_000.0,
            scan: true,
            scan_hz: 8.0,
            // The powertrain bus — the hot path; needs no decode.
            predicate: serde_json::json!({ "bus": "pt" }),
        }
    }
}

/// Run the tracebuffer workload and return its report.
///
/// # Panics
/// Panics if the ingest or scan worker thread panics (e.g. the trace
/// store's mutex is poisoned) — a worker fault is not recoverable here.
#[must_use]
pub fn run(ex: &LoadedExample, cfg: &TracebufferConfig) -> HarnessReport {
    let templates = Arc::new(crate::workload::build_schedule(ex));

    let store = Arc::new(TraceStore::new());
    store.start_session(0); // 0 = no timestamp gating

    let stop = Arc::new(AtomicBool::new(false));
    let rss_start = current_rss_mb();

    // Ingest thread: append round-robin over the schedule (paced).
    let ingest = {
        let store = store.clone();
        let templates = templates.clone();
        let target = cfg.target_frames;
        let ingest_hz = cfg.ingest_hz;
        std::thread::spawn(move || ingest_loop(&store, &templates, target, ingest_hz))
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

    let ingest_out = ingest.join().expect("ingest thread panicked");
    stop.store(true, Ordering::Relaxed);
    let scan_durations = scan
        .map(|h| h.join().expect("scan thread panicked"))
        .unwrap_or_default();

    let rss_end = current_rss_mb();

    build_report(
        &RunParams {
            mode: "tracebuffer",
            scan: cfg.scan,
            scan_hz: cfg.scan_hz,
            ingest_hz: cfg.ingest_hz,
            predicate: cfg.predicate.clone(),
            target_frames: cfg.target_frames,
        },
        &ingest_out,
        &scan_durations,
        rss_start,
        rss_end,
    )
}

fn ingest_loop(
    store: &TraceStore,
    templates: &[ScheduledMessage],
    target: usize,
    ingest_hz: f64,
) -> IngestOut {
    const BASE_TS: u64 = 1_000_000_000;
    const DT_NS: u64 = 1_000;

    let pace = (ingest_hz > 0.0).then(|| Duration::from_secs_f64(1.0 / ingest_hz));
    let mut rec = IngestRecorder::new(target);
    let start = rec.start();
    let mut i: usize = 0;

    loop {
        let t = &templates[i % templates.len()];
        let frame = RawTraceFrame {
            timestamp_ns: BASE_TS + (i as u64) * DT_NS,
            channel: t.channel,
            id: t.can_id,
            extended: t.extended,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(t.payload.clone()),
            bus_id: Some(t.bus_id.clone()),
        };
        let a0 = Instant::now();
        store.append(frame);
        rec.record_append(i, a0.elapsed());
        i += 1;

        if i.is_multiple_of(1024) {
            let len = store.len();
            rec.maybe_sample(len, i);
            if len >= target {
                break;
            }
        }

        // Pace to `ingest_hz`: sleep the bulk of the remaining time, spin
        // the last sliver so coarse OS timers don't dominate.
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
    rec.finish(store.len(), i)
}
