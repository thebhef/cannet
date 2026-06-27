//! Machinery shared by the harness modes: the report shape, the
//! contending filtered-scan loop, ingest sampling / append-latency
//! accounting, and the process-RSS read.
//!
//! Each mode differs only in where frames come from (synthetic, virtual
//! bus, hardware); the model under test (`TraceStore` + the filtered
//! scan), the metrics, and how they are computed are identical, and live
//! here.

// Metrics module — frame counts and elapsed nanoseconds become `f64`
// rates throughout; the precision loss is immaterial at these magnitudes.
#![allow(clippy::cast_precision_loss)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use cannet_gui_lib::filter::{FilterPredicate, TaggedPredicate};
use cannet_gui_lib::trace_store::TraceStore;
use serde::Serialize;

/// Frames scanned per lock acquisition — matches the production filtered
/// scan's chunk size so the harness reproduces its lock-hold granularity.
pub const SCAN_CHUNK: usize = 8192;

/// The parameters that describe a run, carried into the report.
pub struct RunParams {
    pub mode: &'static str,
    pub scan: bool,
    pub scan_hz: f64,
    pub ingest_hz: f64,
    pub predicate: serde_json::Value,
    pub target_frames: usize,
}

/// One (buffer-size, instantaneous ingest-rate) sample.
#[derive(Debug, Clone, Serialize)]
pub struct Checkpoint {
    pub buffer: usize,
    pub ingest_fps: f64,
}

/// Harness results — machine-readable, the unit a baseline diffs against.
/// Shared across modes; `mode` names which source produced the frames.
#[derive(Debug, Clone, Serialize)]
pub struct HarnessReport {
    pub mode: &'static str,
    pub scan: bool,
    pub scan_hz: f64,
    pub ingest_hz: f64,
    pub predicate: serde_json::Value,
    pub target_frames: usize,
    pub frames_ingested: usize,
    pub elapsed_s: f64,
    pub ingest_fps_overall: f64,
    pub ingest_fps_first_half: f64,
    pub ingest_fps_second_half: f64,
    /// `second_half / first_half`. ~1.0 = flat; the diagnosed bug drove
    /// this toward 0.5 (ingest halving as the buffer grew).
    pub fps_retention: f64,
    /// Worst single-append stall, ms — a long lock-hold by the scan
    /// shows up here. `_second_half` isolates it to the large-buffer
    /// portion, where an O(buffer) lock-hold regression would bite.
    pub append_ms_max: f64,
    pub append_ms_max_second_half: f64,
    pub scans_completed: usize,
    pub scan_ms_mean: f64,
    pub scan_ms_max: f64,
    pub rss_start_mb: f64,
    pub rss_end_mb: f64,
    pub rss_growth_mb: f64,
    pub checkpoints: Vec<Checkpoint>,
}

/// A timed ingest sample (one per ~50 ms during the run).
pub struct Sample {
    pub buffer: usize,
    pub count: usize,
    pub elapsed: Duration,
}

/// What the ingest side reports back, whatever its frame source.
pub struct IngestOut {
    pub samples: Vec<Sample>,
    pub append_ms_max: f64,
    pub append_ms_max_second_half: f64,
}

/// Accumulates ingest samples + append-latency as frames land in the
/// store, regardless of where they came from. Each mode's ingest side
/// calls [`Self::record_append`] around its `store.append`, then
/// [`Self::finish`].
pub struct IngestRecorder {
    start: Instant,
    next_sample: Instant,
    samples: Vec<Sample>,
    append_max: Duration,
    append_max_late: Duration,
    half: usize,
}

impl IngestRecorder {
    #[must_use]
    pub fn new(target: usize) -> Self {
        let start = Instant::now();
        Self {
            start,
            next_sample: start,
            samples: Vec::new(),
            append_max: Duration::ZERO,
            append_max_late: Duration::ZERO,
            half: target / 2,
        }
    }

    #[must_use]
    pub fn start(&self) -> Instant {
        self.start
    }

    /// Record one append's latency, keyed by the running frame index.
    pub fn record_append(&mut self, index: usize, append_dt: Duration) {
        if append_dt > self.append_max {
            self.append_max = append_dt;
        }
        if index >= self.half && append_dt > self.append_max_late {
            self.append_max_late = append_dt;
        }
    }

    /// Take a (buffer, count, elapsed) sample at most every 50 ms.
    pub fn maybe_sample(&mut self, buffer: usize, count: usize) {
        let now = Instant::now();
        if now >= self.next_sample {
            self.samples.push(Sample {
                buffer,
                count,
                elapsed: self.start.elapsed(),
            });
            self.next_sample = now + Duration::from_millis(50);
        }
    }

    #[must_use]
    pub fn finish(mut self, final_buffer: usize, final_count: usize) -> IngestOut {
        self.samples.push(Sample {
            buffer: final_buffer,
            count: final_count,
            elapsed: self.start.elapsed(),
        });
        IngestOut {
            samples: self.samples,
            append_ms_max: self.append_max.as_secs_f64() * 1000.0,
            append_ms_max_second_half: self.append_max_late.as_secs_f64() * 1000.0,
        }
    }
}

/// The contending filtered-scan loop, mirroring the GUI's scrollbar
/// match-count refresh. Each pass scans only the frames appended since
/// the previous one — the **incremental** count refresh (ADR 0025): the
/// view keeps a running per-view match count and resumes from the last
/// index it counted, so steady-state contention is O(Δ), not O(buffer).
/// The first pass over a small buffer and every later delta are both
/// bounded by the inter-pass growth, so a long-running filtered view
/// never re-scans the whole history on a refresh. (A filtered view
/// *opened* against an already-large buffer pays one full scan to
/// establish its baseline; that one-off is not the steady-state
/// contention this models. The positional page fetch on scroll / follow
/// live remains O(buffer) until Task 18's filter index.)
///
/// `hz <= 0` runs scans back to back; a positive value paces to that rate.
pub fn scan_loop(
    store: &TraceStore,
    stop: &AtomicBool,
    predicate: &FilterPredicate,
    hz: f64,
) -> Vec<Duration> {
    let interval = (hz > 0.0).then(|| Duration::from_secs_f64(1.0 / hz));
    let mut durations = Vec::new();
    // The running checkpoint: the absolute index up to which matches have
    // already been counted. A refresh scans only `[counted_to, len)`.
    let mut counted_to = 0;
    while !stop.load(Ordering::Relaxed) {
        let t0 = Instant::now();
        let len = store.len();
        let mut pos = counted_to.min(len);
        while pos < len {
            let end = (pos + SCAN_CHUNK).min(len);
            // `None` decoded — an id/bus predicate needs no decode, so
            // this is pure scan + lock cost.
            let _ = store.scan_chunk(pos, end, |f| predicate.matches(f, None));
            pos = end;
        }
        counted_to = len;
        let elapsed = t0.elapsed();
        durations.push(elapsed);
        if let Some(interval) = interval {
            if elapsed < interval {
                std::thread::sleep(interval.saturating_sub(elapsed));
            }
        }
    }
    durations
}

/// Parse a predicate JSON, falling back to a match-everything predicate
/// (empty `all`) if the value doesn't deserialize.
#[must_use]
pub fn parse_predicate(value: &serde_json::Value) -> FilterPredicate {
    serde_json::from_value(value.clone())
        .unwrap_or_else(|_| FilterPredicate::Tagged(TaggedPredicate::All(Vec::new())))
}

/// Assemble the report from an ingest result + scan durations.
#[must_use]
pub fn build_report(
    params: &RunParams,
    ingest: &IngestOut,
    scan_durations: &[Duration],
    rss_start: f64,
    rss_end: f64,
) -> HarnessReport {
    let samples = &ingest.samples;
    let last = samples.last();
    let frames_ingested = last.map_or(0, |s| s.count);
    let elapsed_s = last.map_or(0.0, |s| s.elapsed.as_secs_f64());
    let ingest_fps_overall = if elapsed_s > 0.0 {
        frames_ingested as f64 / elapsed_s
    } else {
        0.0
    };

    let half = frames_ingested / 2;
    let mid = samples
        .iter()
        .find(|s| s.count >= half)
        .or_else(|| samples.first());
    let (first_half, second_half) = match (mid, last) {
        (Some(m), Some(l)) if m.elapsed.as_secs_f64() > 0.0 && l.elapsed > m.elapsed => {
            let first = m.count as f64 / m.elapsed.as_secs_f64();
            let second =
                (l.count - m.count) as f64 / l.elapsed.saturating_sub(m.elapsed).as_secs_f64();
            (first, second)
        }
        _ => (ingest_fps_overall, ingest_fps_overall),
    };
    let fps_retention = if first_half > 0.0 {
        second_half / first_half
    } else {
        0.0
    };

    let mut checkpoints = Vec::new();
    for w in samples.windows(2) {
        let [a, b] = w else { continue };
        let dt = b.elapsed.saturating_sub(a.elapsed).as_secs_f64();
        if dt > 0.0 {
            checkpoints.push(Checkpoint {
                buffer: b.buffer,
                ingest_fps: (b.count - a.count) as f64 / dt,
            });
        }
    }

    let scans_completed = scan_durations.len();
    let scan_ms: Vec<f64> = scan_durations
        .iter()
        .map(|d| d.as_secs_f64() * 1000.0)
        .collect();
    let scan_ms_mean = if scan_ms.is_empty() {
        0.0
    } else {
        scan_ms.iter().sum::<f64>() / scan_ms.len() as f64
    };
    let scan_ms_max = scan_ms.iter().copied().fold(0.0, f64::max);

    HarnessReport {
        mode: params.mode,
        scan: params.scan,
        scan_hz: params.scan_hz,
        ingest_hz: params.ingest_hz,
        predicate: params.predicate.clone(),
        target_frames: params.target_frames,
        frames_ingested,
        elapsed_s,
        ingest_fps_overall,
        ingest_fps_first_half: first_half,
        ingest_fps_second_half: second_half,
        fps_retention,
        append_ms_max: ingest.append_ms_max,
        append_ms_max_second_half: ingest.append_ms_max_second_half,
        scans_completed,
        scan_ms_mean,
        scan_ms_max,
        rss_start_mb: rss_start,
        rss_end_mb: rss_end,
        rss_growth_mb: rss_end - rss_start,
        checkpoints,
    }
}

/// Resident set size of this process, in MiB. `0.0` if unavailable.
#[must_use]
pub fn current_rss_mb() -> f64 {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let Ok(pid): Result<Pid, _> = sysinfo::get_current_pid() else {
        return 0.0;
    };
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );
    sys.process(pid)
        .map_or(0.0, |p| p.memory() as f64 / (1024.0 * 1024.0))
}
