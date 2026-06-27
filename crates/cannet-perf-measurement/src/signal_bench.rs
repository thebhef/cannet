//! Per-signal decimation characterization — does a decoded signal's
//! resolution pyramid (ADR 0002 DS-5) make a wide-range serve `O(budget)`
//! instead of `O(matches)`?
//!
//! A decoded signal is an arbitrarily long series — one value per matching
//! frame. Any consumer that wants the whole span at a bounded point budget
//! (a plot fitting all data is the consumer today, but the property is the
//! signal's, not the plot's) used to pay `O(matches)`: materialize every
//! decoded sample in the range and decimate it, on every request. The
//! per-signal min/max pyramid lets the host read the coarsest level whose
//! in-range count still exceeds the budget, so the serve is bounded by the
//! budget, not by how much of the signal exists.
//!
//! This mode fills a real `TraceStore` (in-RAM or disk-spill), picks the
//! most-frequent scheduled signal, builds its pyramid once (the first
//! catch-up), then times a whole-span serve two ways: the old path (raw
//! materialize + `decimate_min_max`) and the pyramid serve. It drives the
//! genuine model surface — `SignalCacheStore::slice` — not a
//! microbenchmark. (Spike survival under decimation is a `signal_cache`
//! unit test; this mode characterizes timing, so the synthesized signal's
//! constant value is immaterial to the comparison.)

use std::sync::Arc;
use std::time::Instant;

use cannet_core::{CanFramePayload, Direction};
use cannet_dbc::Database;
use cannet_gui_lib::signal_cache::SignalCacheStore;
use cannet_gui_lib::signal_sampler;
use cannet_gui_lib::trace_store::{RawTraceFrame, TraceStore};

use crate::tracebuffer::StoreKind;
use crate::workload::{self, ScheduledMessage};
use crate::LoadedExample;

/// One signal-bench run's parameters.
pub struct SignalBenchConfig {
    pub store: StoreKind,
    /// Frames to fill the store with before measuring.
    pub frames: usize,
    /// Point budget the whole-span serve targets — the maximum number of
    /// points a consumer wants back for the signal's full range.
    pub max_points: usize,
}

/// What the bench measured.
#[derive(Debug, serde::Serialize)]
pub struct SignalBenchReport {
    pub store: &'static str,
    pub frames: usize,
    pub bus_id: Option<String>,
    pub message_id: u32,
    pub signal: String,
    /// Decoded samples for the chosen signal across the whole capture —
    /// the length of the signal's raw series.
    pub matches: usize,
    pub max_points: usize,
    /// Points the pyramid whole-span serve actually returned (bounded by
    /// `2 × max_points + 2`).
    pub returned_points: usize,
    /// First serve: the catch-up decode of the signal's frames plus the
    /// fold up the pyramid — `O(that id's occurrences)`.
    pub build_ms: f64,
    /// Old path: raw whole-span materialize (`O(matches)`) +
    /// `decimate_min_max` — the cost paid on every request before the
    /// pyramid.
    pub serve_naive_ms: f64,
    /// Pyramid serve of the same whole span — the steady cost now
    /// (`O(max_points)`, independent of the signal's length).
    pub serve_pyramid_us: f64,
}

/// Run the per-signal decimation bench and return its report.
///
/// # Panics
/// Panics if the disk store can't open a scratch dir, or if no scheduled
/// message in the example carries a decodable signal (the bench needs one
/// to exercise).
#[must_use]
pub fn run(ex: &LoadedExample, cfg: &SignalBenchConfig) -> SignalBenchReport {
    // Repeats for the steady-state pyramid-serve timing average.
    const ITERS: usize = 50;

    let templates = workload::build_schedule(ex);
    let dbs: Vec<&Database> = ex.dbcs.iter().map(|d| &d.db).collect();
    let chosen = pick_signal(&templates, &dbs).expect("a decodable scheduled signal");

    let scratch = match cfg.store {
        StoreKind::Mem => None,
        StoreKind::Disk => Some(tempfile::TempDir::new().expect("scratch tempdir")),
    };
    let store = Arc::new(match &scratch {
        None => TraceStore::new(),
        Some(dir) => TraceStore::new_disk(dir.path()).expect("open disk store"),
    });
    store.start_session(0);
    fill(&store, &templates, cfg.frames);

    let caches = SignalCacheStore::new();
    let (bus, id, ext, sig) = (
        Some(chosen.bus_id.as_str()),
        chosen.can_id,
        chosen.extended,
        chosen.signal.as_str(),
    );

    // (1) First serve: the catch-up decodes the signal's frames and folds
    // the pyramid. A small max_points serve rides along (negligible vs the
    // build), so this is the build cost.
    let t = Instant::now();
    let _ = caches.slice(
        bus,
        id,
        ext,
        sig,
        f64::MIN,
        f64::MAX,
        cfg.max_points,
        &store,
        &dbs,
    );
    let build_ms = ms(t);

    // (2) Old path: raw whole-span serve (max_points = 0) then decimate —
    // what every request cost before DS-5. The cache is warm, so this is
    // purely the materialize-and-decimate cost.
    let t = Instant::now();
    let raw = caches.slice(bus, id, ext, sig, f64::MIN, f64::MAX, 0, &store, &dbs);
    let naive = signal_sampler::decimate_min_max(&raw, cfg.max_points);
    let serve_naive_ms = ms(t);
    let matches = raw.len();
    let _ = naive;

    // (3) Pyramid serve of the same whole span, averaged over repeats.
    let mut returned_points = 0;
    let t = Instant::now();
    for _ in 0..ITERS {
        let pts = caches.slice(
            bus,
            id,
            ext,
            sig,
            f64::MIN,
            f64::MAX,
            cfg.max_points,
            &store,
            &dbs,
        );
        returned_points = pts.len();
    }
    #[allow(clippy::cast_precision_loss)]
    let serve_pyramid_us = t.elapsed().as_secs_f64() * 1e6 / ITERS as f64;

    SignalBenchReport {
        store: match cfg.store {
            StoreKind::Mem => "mem",
            StoreKind::Disk => "disk",
        },
        frames: store.len(),
        bus_id: Some(chosen.bus_id.clone()),
        message_id: id,
        signal: chosen.signal.clone(),
        matches,
        max_points: cfg.max_points,
        returned_points,
        build_ms,
        serve_naive_ms,
        serve_pyramid_us,
    }
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

/// The scheduled message + signal the bench exercises.
struct ChosenSignal {
    bus_id: String,
    can_id: u32,
    extended: bool,
    signal: String,
}

/// Pick the most-frequent scheduled message (smallest period) that has a
/// signal some DBC can decode — the deepest series, where decimation
/// matters most.
fn pick_signal(templates: &[ScheduledMessage], dbs: &[&Database]) -> Option<ChosenSignal> {
    let mut by_freq: Vec<&ScheduledMessage> = templates.iter().collect();
    by_freq.sort_by_key(|m| m.period_ms);
    for m in by_freq {
        let canid = m.canid();
        for db in dbs {
            if let Some(desc) = db.describe_message(canid) {
                if let Some(sig) = desc.signals.first() {
                    return Some(ChosenSignal {
                        bus_id: m.bus_id.clone(),
                        can_id: m.can_id,
                        extended: m.extended,
                        signal: sig.name.clone(),
                    });
                }
            }
        }
    }
    None
}

/// Append `target` frames by cycling the schedule, flat out (mirrors
/// `filter_bench::fill`).
fn fill(store: &TraceStore, templates: &[ScheduledMessage], target: usize) {
    const BASE_TS: u64 = 1_000_000_000;
    for i in 0..target {
        let t = &templates[i % templates.len()];
        store.append(RawTraceFrame {
            timestamp_ns: BASE_TS + i as u64,
            channel: t.channel,
            id: t.can_id,
            extended: t.extended,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(t.payload.clone()),
            bus_id: Some(t.bus_id.clone()),
        });
    }
}
