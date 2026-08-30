//! Render-tier performance capture (ADR 0031).
//!
//! The host-side perf harness (`cannet-perf-measurement`) stands in for
//! the frontend — it drives the model but cannot see the React / uPlot /
//! virtualizer render tier, which is where the remaining user-visible cost
//! lives. This module is the other half: the host captures the render-tier
//! numbers the webview already gathers.
//!
//! The frontend's diagnostic reporter (`diag.ts`) aggregates, once per
//! second, the UI-thread health signals (`lag`, `longtask`) and the
//! render / resample counters and gauges. During a capture the webview
//! pushes one [`DiagSample`] per second through [`diag_push`];
//! [`diag_capture_start`] / [`diag_capture_finish`] bracket the session,
//! and [`summarize`] reduces the series to a [`RenderReport`] of UX-facing
//! metrics, written next to the host-side baselines so a run is diffable
//! the same way.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

/// The display refresh budget: a frame is "late" once a synchronous task
/// overruns ~16.7 ms (60 Hz). Long-task time divided by this estimates
/// dropped frames.
const FRAME_BUDGET_MS: f64 = 1000.0 / 60.0;

/// A second is counted as janky once more than this much long-task time
/// accrued in it. The frame budget is ~16.7 ms, so 50 ms is several
/// frames' worth of uninterruptible work — the threshold the browser's
/// own `longtask` entries use, and what a user perceives as a hitch.
const JANK_THRESHOLD_MS: f64 = 50.0;

/// Host-side jitter metrics the frontend can't see, drained into each
/// capture sample (ADR 0031). Both hold the **max since the last drain**,
/// so a per-second drain yields that second's worst case — the tail signal
/// a throughput average is structurally blind to (a sub-second stall is
/// hidden by the catch-up burst that follows it).
///
/// - `flush_ms` — duration of the periodic `TraceStore::flush`; it holds
///   the append lock, so this *is* the lock-contention root signal,
///   present in any capture.
/// - `tx_late_ms` — the transmit scheduler's wake lateness; the
///   user-facing effect of the same contention, and it also catches lock
///   holders other than flush. Only non-zero while something transmits.
///
/// Managed as Tauri state: the flusher and scheduler threads record into
/// it; [`diag_push`] drains it.
///
/// Recording is **armed by a capture** ([`diag_capture_start`]) and
/// disarmed when it finishes. Nothing else ever drains these maxima, so
/// outside a capture the recording would be pure waste — and this is
/// instrumentation that ships in the product binary, which must cost
/// nothing when it isn't being used. Unarmed, a `record_*` call is one
/// relaxed load and a return; no atomic is written.
#[derive(Default)]
pub struct HostMetrics {
    armed: std::sync::atomic::AtomicBool,
    flush_ms_max: AtomicU64,
    tx_late_ms_max: AtomicU64,
}

impl HostMetrics {
    /// Arm or disarm recording. Called by the capture bracket.
    fn set_armed(&self, on: bool) {
        self.armed.store(on, Ordering::Relaxed);
    }

    /// Raise `slot` to `ms` if larger (a lock-free max).
    fn record(slot: &AtomicU64, ms: f64) {
        let want = ms.to_bits();
        let mut cur = slot.load(Ordering::Relaxed);
        while f64::from_bits(cur) < ms {
            match slot.compare_exchange_weak(cur, want, Ordering::Relaxed, Ordering::Relaxed) {
                Ok(_) => break,
                Err(observed) => cur = observed,
            }
        }
    }

    /// Record a `TraceStore::flush` duration (ms). No-op unless a capture
    /// is armed.
    pub fn record_flush_ms(&self, ms: f64) {
        if !self.armed.load(Ordering::Relaxed) {
            return;
        }
        Self::record(&self.flush_ms_max, ms);
    }

    /// Record a transmit-scheduler wake lateness (ms). No-op unless a
    /// capture is armed.
    pub fn record_tx_late_ms(&self, ms: f64) {
        if !self.armed.load(Ordering::Relaxed) {
            return;
        }
        Self::record(&self.tx_late_ms_max, ms);
    }

    /// Read and reset both maxima — the capture's per-second drain.
    fn drain(&self) -> (f64, f64) {
        (
            f64::from_bits(self.flush_ms_max.swap(0, Ordering::Relaxed)),
            f64::from_bits(self.tx_late_ms_max.swap(0, Ordering::Relaxed)),
        )
    }
}

/// One second of frontend diagnostics, pushed by `diag.ts`.
#[derive(Debug, Clone, Deserialize)]
pub struct DiagSample {
    /// Milliseconds since the capture started (frontend clock).
    pub t_ms: f64,
    /// Event-loop lateness for this tick — how late the 1 s interval
    /// fired (ms). ~0 on a healthy loop; climbs when timers are starved.
    pub lag_ms: f64,
    /// Total ms spent in >50 ms long tasks during this tick — the
    /// UI-thread blocking the user perceives as jank.
    pub longtask_ms: f64,
    /// Per-second counter deltas (e.g. `render.PlotArea`,
    /// `plotarea.resample`).
    #[serde(default)]
    pub counts: BTreeMap<String, f64>,
    /// Instantaneous gauges (e.g. `fps.pt`, the trace buffer `count`).
    #[serde(default)]
    pub gauges: BTreeMap<String, f64>,
}

/// Mean and max of a per-second series.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Spread {
    pub mean: f64,
    pub max: f64,
}

/// Long-task spread, with the 95th percentile — the tail is what a user
/// feels, so it gets its own number alongside mean / max.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LongTaskSpread {
    pub mean: f64,
    pub max: f64,
    pub p95: f64,
}

/// Gauge spread, plus the final reading (gauges are absolute levels, so
/// the end value — e.g. final buffer size — is meaningful on its own) and
/// the linear drift over the run. `slope_per_min` is the least-squares
/// slope of the reading against capture time, in the gauge's own units per
/// minute — the signal for a slow memory climb (`jsheap_mb`,
/// `mem.webview_renderer_mb`) that `max`/`last` alone can't separate from a
/// one-off spike.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GaugeSpread {
    pub mean: f64,
    pub max: f64,
    pub last: f64,
    pub slope_per_min: f64,
}

/// A throughput gauge reduced for regression gating: its run mean plus
/// the first-half / second-half split and their ratio. The render tier's
/// counterpart to the host harness's `fps_retention` (runner.rs) — a
/// retention near 1.0 means throughput held as the buffer grew; the
/// diagnosed lock-contention regression drove it toward 0.5. `overall`
/// is gated against an expected floor; `retention` against a decay floor.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RateReport {
    pub overall: f64,
    pub first_half: f64,
    pub second_half: f64,
    pub retention: f64,
}

/// The render-tier counterpart to the host harness's report: UX-facing
/// metrics reduced from a capture's per-second samples.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RenderReport {
    /// Slots this report beside the host-side modes
    /// (`tracebuffer` / `grpc` / `hardware-peak`) in a measurement file.
    pub mode: &'static str,
    /// Caller-supplied label for the view configuration / scenario.
    pub label: String,
    /// Capture wall-clock span (from the sample timestamps).
    pub duration_s: f64,
    /// Number of 1 s samples the report reduced.
    pub sample_count: usize,
    /// UI-thread long-task time per second — the smoothness measure.
    pub longtask_ms_per_s: LongTaskSpread,
    /// Event-loop lateness per second.
    pub lag_ms: Spread,
    /// Seconds with more than [`JANK_THRESHOLD_MS`] of long-task time.
    pub jank_seconds: usize,
    /// `jank_seconds / sample_count` — the fraction of the run that hitched.
    pub jank_fraction: f64,
    /// Mean estimated dropped frames per second (long-task ms ÷ frame budget).
    pub frames_late_per_s_mean: f64,
    /// Receive throughput (the `fps.rx` gauge) reduced for gating —
    /// overall level and first/second-half retention.
    pub rx_fps: RateReport,
    /// Transmit-confirmed throughput (the `fps.tx` gauge), same reduction.
    /// Split from rx so a transmit-only stall is gated even when receive
    /// holds.
    pub tx_fps: RateReport,
    /// Per-counter per-second spread (render / resample / invoke counts).
    pub counters_per_s: BTreeMap<String, Spread>,
    /// Per-gauge spread over the run.
    pub gauges: BTreeMap<String, GaugeSpread>,
    /// On-wire receive cadence (worst per-id gap stats) over the capture
    /// window, from the trace store's device-stamped rx timestamps.
    /// `None` when no periodic rx id qualified (sim-only run, no
    /// hardware). Stamped by the capture-finish command, not
    /// [`summarize`] — it comes from the store, not the samples.
    pub rx_gap: Option<RxGapReport>,
    /// What the synthetic interaction script drove, or `None` when the
    /// run was gestureless (no `--perf-interact`, or an operator-driven
    /// capture from the console). Stamped by the capture-finish command
    /// from the webview's own count.
    pub interact: Option<InteractTally>,
}

/// On-wire receive cadence over the capture (ADR 0031 / ADR 0039): the
/// worst per-id gap statistics from the receiving side's device-stamped
/// timestamps. This is the ground-truth bunching signal the throughput
/// and lateness gauges are blind to — a catch-up burst refills `rx_fps`
/// within the second, and `tx_late_ms` measures the cause side only.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RxGapReport {
    /// Ids that qualified (enough gaps, periodic-band median).
    pub ids_measured: usize,
    /// Worst per-id `p95 gap / median gap` — the lateness-tail ratio.
    /// ~1.2 on a healthy rig; the pre-stagger cohort regression sat ~3.5.
    pub worst_p95_ratio: f64,
    /// `bus/0xID` that produced `worst_p95_ratio` (context for humans).
    pub worst_p95_ratio_id: String,
    /// Worst per-id fraction of gaps under half the median — the
    /// catch-up-pair (bunching) signal. ~2% healthy; ~28% pre-stagger.
    pub worst_short_frac: f64,
    /// `bus/0xID` that produced `worst_short_frac`.
    pub worst_short_frac_id: String,
}

/// What the synthetic interaction script actually did during the capture
/// (ADR 0031), tallied by the webview and handed over at finish.
///
/// Skipping a gesture whose target is not on screen is deliberate — a
/// project whose layout has no plot is a legitimate capture, just a
/// quieter one — but a run where *every* gesture was skipped produces a
/// report structurally identical to a good one, and reads as "interaction
/// is free". This is what tells those apart in the data: a report whose
/// `performed` is zero (or whose `missing` names the control that moved)
/// was measuring a disarmed harness.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct InteractTally {
    /// The script that ran (`scrub` / `follow`).
    pub script: String,
    /// Timer ticks the script was driven for.
    pub ticks: usize,
    /// Ticks that dispatched a gesture at a real element.
    pub performed: usize,
    /// Ticks whose gesture found no target on screen.
    pub missing: usize,
    /// Ticks that were deliberate idle slots — the gaps the app needs to
    /// finish the work the previous gesture triggered.
    pub idle: usize,
    /// Per-label counts of the gestures that landed.
    pub by_gesture: BTreeMap<String, usize>,
    /// Per-label counts of the gestures that found nothing to drive.
    pub missing_by_gesture: BTreeMap<String, usize>,
}

/// Gaps needed before an id's statistics are trusted.
const RX_GAP_MIN_GAPS: usize = 50;
/// Periodic band for the median gap: 1 ms ..= 2 s. Outside it the id is
/// event-driven or too slow to judge in a one-minute capture.
const RX_GAP_PERIODIC_BAND_NS: std::ops::RangeInclusive<u64> = 1_000_000..=2_000_000_000;

/// Reduce per-id rx timestamp series to the worst-id gap statistics, or
/// `None` when nothing qualifies (no hardware rx in the capture). Pure —
/// the capture-finish command feeds it the capture window's frames.
#[must_use]
#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
pub fn rx_gap_stats(
    series: &std::collections::HashMap<(String, u32), Vec<u64>>,
) -> Option<RxGapReport> {
    let mut report: Option<RxGapReport> = None;
    for ((bus, id), ts) in series {
        if ts.len() < RX_GAP_MIN_GAPS + 1 {
            continue;
        }
        let mut gaps: Vec<u64> = ts.windows(2).map(|w| w[1].saturating_sub(w[0])).collect();
        gaps.sort_unstable();
        let median = gaps[gaps.len() / 2];
        if !RX_GAP_PERIODIC_BAND_NS.contains(&median) {
            continue;
        }
        let p95_idx = (((gaps.len() as f64) * 0.95) as usize).min(gaps.len() - 1);
        let p95 = gaps[p95_idx];
        let ratio = p95 as f64 / median as f64;
        let short = gaps.iter().filter(|&&g| g < median / 2).count();
        let short_frac = short as f64 / gaps.len() as f64;
        let label = format!("{bus}/0x{id:X}");
        let r = report.get_or_insert(RxGapReport {
            ids_measured: 0,
            worst_p95_ratio: 0.0,
            worst_p95_ratio_id: String::new(),
            worst_short_frac: 0.0,
            worst_short_frac_id: String::new(),
        });
        r.ids_measured += 1;
        if ratio > r.worst_p95_ratio {
            r.worst_p95_ratio = ratio;
            r.worst_p95_ratio_id.clone_from(&label);
        }
        if short_frac > r.worst_short_frac {
            r.worst_short_frac = short_frac;
            r.worst_short_frac_id = label;
        }
    }
    report
}

/// Reduce a capture's per-second samples to a [`RenderReport`]. Pure —
/// the unit of the module worth testing; the command wrappers are thin
/// glue around it.
#[must_use]
#[allow(clippy::cast_precision_loss)]
pub fn summarize(label: &str, samples: &[DiagSample]) -> RenderReport {
    let n = samples.len();
    let duration_s = match (samples.first(), samples.last()) {
        (Some(a), Some(b)) if b.t_ms > a.t_ms => (b.t_ms - a.t_ms) / 1000.0,
        // 1 Hz fallback when timestamps are flat / absent.
        _ => n as f64,
    };

    let longtask: Vec<f64> = samples.iter().map(|s| s.longtask_ms).collect();
    let lag: Vec<f64> = samples.iter().map(|s| s.lag_ms).collect();

    let jank_seconds = longtask.iter().filter(|&&v| v > JANK_THRESHOLD_MS).count();
    let jank_fraction = if n == 0 {
        0.0
    } else {
        jank_seconds as f64 / n as f64
    };
    let frames_late: Vec<f64> = longtask.iter().map(|v| v / FRAME_BUDGET_MS).collect();

    // Counters: union of keys across samples, each a per-second series
    // (a key absent from a sample contributes 0 that second).
    let mut counter_keys: BTreeSet<&str> = BTreeSet::new();
    for s in samples {
        for k in s.counts.keys() {
            counter_keys.insert(k);
        }
    }
    let mut counters_per_s = BTreeMap::new();
    for k in counter_keys {
        let series: Vec<f64> = samples
            .iter()
            .map(|s| s.counts.get(k).copied().unwrap_or(0.0))
            .collect();
        counters_per_s.insert(
            k.to_string(),
            Spread {
                mean: mean(&series),
                max: max(&series),
            },
        );
    }

    // Gauges: absent readings are skipped (a gauge that wasn't reported
    // that second has no level), and `last` is the final reading seen.
    let mut gauge_keys: BTreeSet<&str> = BTreeSet::new();
    for s in samples {
        for k in s.gauges.keys() {
            gauge_keys.insert(k);
        }
    }
    let mut gauges = BTreeMap::new();
    for k in gauge_keys {
        // Pair each present reading with its sample time so the drift is a
        // regression over real elapsed time, not sample ordinal.
        let pairs: Vec<(f64, f64)> = samples
            .iter()
            .filter_map(|s| s.gauges.get(k).map(|&v| (s.t_ms, v)))
            .collect();
        let series: Vec<f64> = pairs.iter().map(|(_, v)| *v).collect();
        let last = pairs.last().map_or(0.0, |(_, v)| *v);
        gauges.insert(
            k.to_string(),
            GaugeSpread {
                mean: mean(&series),
                max: max(&series),
                last,
                slope_per_min: slope_per_min(&pairs),
            },
        );
    }

    RenderReport {
        mode: "frontend",
        label: label.to_string(),
        duration_s,
        sample_count: n,
        longtask_ms_per_s: LongTaskSpread {
            mean: mean(&longtask),
            max: max(&longtask),
            p95: percentile(&longtask, 95.0),
        },
        lag_ms: Spread {
            mean: mean(&lag),
            max: max(&lag),
        },
        jank_seconds,
        jank_fraction,
        frames_late_per_s_mean: mean(&frames_late),
        rx_fps: rate_report(samples, "fps.rx"),
        tx_fps: rate_report(samples, "fps.tx"),
        counters_per_s,
        gauges,
        rx_gap: None,
        interact: None,
    }
}

/// Reduce one throughput gauge's per-second series to a [`RateReport`].
/// Absent readings (seconds before the rate gauge first reported) are
/// skipped; the present readings are split in half by order so the
/// first-half / second-half ratio measures decay as the buffer grew —
/// the same retention shape the host harness gates (runner.rs).
fn rate_report(samples: &[DiagSample], key: &str) -> RateReport {
    let vals: Vec<f64> = samples
        .iter()
        .filter_map(|s| s.gauges.get(key).copied())
        .collect();
    let overall = mean(&vals);
    let (first_half, second_half) = if vals.len() >= 2 {
        let mid = vals.len() / 2;
        (mean(&vals[..mid]), mean(&vals[mid..]))
    } else {
        (overall, overall)
    };
    let retention = if first_half > 0.0 {
        second_half / first_half
    } else {
        0.0
    };
    RateReport {
        overall,
        first_half,
        second_half,
        retention,
    }
}

#[allow(clippy::cast_precision_loss)]
fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    xs.iter().sum::<f64>() / xs.len() as f64
}

fn max(xs: &[f64]) -> f64 {
    xs.iter().copied().fold(0.0_f64, f64::max)
}

/// Least-squares slope of `(t_ms, value)` pairs, scaled to the value's
/// units **per minute**. Fewer than two points (or a degenerate time span)
/// → 0. Used for the per-gauge drift in [`GaugeSpread`]: a positive
/// `jsheap_mb` / `mem.*_mb` slope is the slow-climb signal a leak gate
/// watches.
#[allow(clippy::cast_precision_loss)]
fn slope_per_min(pairs: &[(f64, f64)]) -> f64 {
    let n = pairs.len();
    if n < 2 {
        return 0.0;
    }
    let nf = n as f64;
    let sx: f64 = pairs.iter().map(|(t, _)| *t).sum();
    let sy: f64 = pairs.iter().map(|(_, v)| *v).sum();
    let sxx: f64 = pairs.iter().map(|(t, _)| t * t).sum();
    let sxy: f64 = pairs.iter().map(|(t, v)| t * v).sum();
    let denom = nf * sxx - sx * sx;
    if denom.abs() < f64::EPSILON {
        return 0.0;
    }
    // Slope is value-per-ms; ×60_000 ms/min gives value-per-minute.
    (nf * sxy - sx * sy) / denom * 60_000.0
}

/// Linear-interpolated percentile of a non-negative series. Empty → 0.
#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
fn percentile(xs: &[f64], pct: f64) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let mut v = xs.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = (pct / 100.0) * (v.len() as f64 - 1.0);
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    if lo == hi {
        v[lo]
    } else {
        let frac = rank - lo as f64;
        v[lo] * (1.0 - frac) + v[hi] * frac
    }
}

/// Capture session state, managed independently of `AppState` (like the
/// sidecar / interfaces state) — it's an orthogonal dev/measurement
/// surface with no cross-lock ordering against the model.
#[derive(Default)]
pub struct DiagState {
    inner: Mutex<Capture>,
}

#[derive(Default)]
struct Capture {
    active: bool,
    label: String,
    samples: Vec<DiagSample>,
    /// Host-side process-memory sampler, live only while a capture is
    /// armed. The frontend can't read process RSS, so the host stamps the
    /// `mem.*_mb` split onto each pushed sample (ADR 0031).
    mem: Option<crate::crash::MemSampler>,
    /// First reason a memory reading could not be attributed to this app,
    /// if any. It fails the whole capture at finish: a memory metric that
    /// reads `0.0` because the processes holding the memory were never
    /// ours passes every gate it is checked against.
    mem_fault: Option<&'static str>,
    /// Trace-store length when the capture armed — the finish walk reads
    /// only the frames appended during the capture (`rx_gap`).
    store_len_at_start: usize,
}

/// What [`diag_capture_finish`] returns: the reduced report and, when a
/// path was given, where it was written.
#[derive(Debug, Clone, Serialize)]
pub struct FinishedCapture {
    pub report: RenderReport,
    pub path: Option<String>,
}

/// Arm a capture under `label`, discarding any prior samples.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn diag_capture_start(
    state: State<'_, DiagState>,
    metrics: State<'_, HostMetrics>,
    app_state: State<'_, crate::app_state::AppState>,
    label: String,
) {
    let mut cap = state.inner.lock().expect("diag mutex poisoned");
    cap.active = true;
    cap.label = label;
    cap.samples.clear();
    cap.mem = Some(crate::crash::MemSampler::new());
    cap.mem_fault = None;
    cap.store_len_at_start = app_state.trace_store.len();
    // Discard any max accrued before the capture so the first sample isn't
    // inflated by a pre-capture flush / scheduler stall, then start
    // recording (the flusher and scheduler skip the atomics until armed).
    let _ = metrics.drain();
    metrics.set_armed(true);
}

/// Record one per-second sample. Ignored unless a capture is armed, so
/// the frontend can push unconditionally without a round-trip to check.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn diag_push(
    state: State<'_, DiagState>,
    metrics: State<'_, HostMetrics>,
    mut sample: DiagSample,
) {
    let mut cap = state.inner.lock().expect("diag mutex poisoned");
    if cap.active {
        // Stamp the host-side process-memory split onto the sample before
        // storing it, so the renderer/host gauges share the frontend's
        // 1 Hz timeline.
        if let Some(mem) = cap.mem.as_mut() {
            // Keep the first fault: the reason does not improve with
            // repetition, and the capture is already void.
            let fault = mem.stamp_mb(&mut sample.gauges);
            cap.mem_fault = cap.mem_fault.or(fault);
        }
        // Drain the host jitter maxima into this second's sample.
        let (flush_ms, tx_late_ms) = metrics.drain();
        sample.gauges.insert("flush_ms".to_string(), flush_ms);
        sample.gauges.insert("tx_late_ms".to_string(), tx_late_ms);
        cap.samples.push(sample);
    }
}

/// Disarm, reduce the captured samples to a [`RenderReport`], and — when
/// `path` is given — write it there as pretty JSON. `interact` is the
/// webview's tally of the gestures its script drove, carried into the
/// report so a run that gestured at nothing is visible in the data.
///
/// # Errors
/// Returns an error if nothing was captured, if the memory readings could
/// not be attributed to this app, or if writing `path` fails. A capture
/// that failed writes no report: absence is the one signal no consumer
/// can misread as a healthy number.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn diag_capture_finish(
    state: State<'_, DiagState>,
    metrics: State<'_, HostMetrics>,
    app_state: State<'_, crate::app_state::AppState>,
    path: Option<String>,
    interact: Option<InteractTally>,
) -> Result<FinishedCapture, String> {
    metrics.set_armed(false);
    let (label, samples, store_len_at_start, mem_fault) = {
        let mut cap = state.inner.lock().expect("diag mutex poisoned");
        cap.active = false;
        cap.mem = None;
        (
            cap.label.clone(),
            std::mem::take(&mut cap.samples),
            cap.store_len_at_start,
            cap.mem_fault.take(),
        )
    };
    if samples.is_empty() {
        return Err("no diagnostic samples were captured".into());
    }
    if let Some(why) = mem_fault {
        return Err(format!("memory attribution failed: {why}"));
    }
    let mut report = summarize(&label, &samples);
    report.interact = interact;
    report.rx_gap = rx_gap_stats(&capture_rx_series(
        &app_state.trace_store,
        store_len_at_start,
    ));
    let written = match path {
        Some(p) => {
            let json = serde_json::to_string_pretty(&report)
                .map_err(|e| format!("serializing render report: {e}"))?;
            std::fs::write(&p, json).map_err(|e| format!("writing {p}: {e}"))?;
            Some(p)
        }
        None => None,
    };
    Ok(FinishedCapture {
        report,
        path: written,
    })
}

/// Collect the capture window's rx timestamps grouped per `(bus, id)`,
/// walking the store in bounded chunks (the window is minutes of frames;
/// never materialize it whole).
fn capture_rx_series(
    store: &crate::TraceStore,
    from: usize,
) -> std::collections::HashMap<(String, u32), Vec<u64>> {
    const CHUNK: usize = 65_536;
    let mut series: std::collections::HashMap<(String, u32), Vec<u64>> =
        std::collections::HashMap::new();
    let end = store.len();
    let mut i = from.min(end);
    while i < end {
        let hi = (i + CHUNK).min(end);
        for f in store.slice(i, hi) {
            if f.direction == cannet_core::Direction::Rx {
                series
                    .entry((f.bus_id.unwrap_or_default(), f.id))
                    .or_default()
                    .push(f.timestamp_ns);
            }
        }
        i = hi;
    }
    series
}

/// Self-driving perf automation config, parsed from the launch args
/// (ADR 0031). The webview fetches this once on boot via
/// [`diag_autostart`]; when present it opens the project, connects,
/// captures for the requested span, writes the report, and exits —
/// without an operator. The two things deliberately *not* persisted in
/// the project (the decision to touch interfaces, and the decision to
/// record) are exactly what these flags supply.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationConfig {
    /// `--project <path>`: open this project deterministically, ahead of
    /// the last-opened pointer.
    pub project: Option<String>,
    /// `--connect-on-start`: fire the same connect the user clicks, once
    /// the project's bindings (and, for a local binding, the sidecar) are
    /// ready.
    pub connect_on_start: bool,
    /// `--perf-capture-secs <n>`: after connect settles, capture for `n`
    /// seconds, then finish and exit.
    pub capture_secs: Option<u64>,
    /// `--perf-out <path>`: write the [`RenderReport`] JSON here on finish.
    pub out: Option<String>,
    /// `--perf-label <text>`: label stamped on the report (the webview
    /// falls back to the project path / `"perf"` when absent).
    pub label: Option<String>,
    /// `--rbs-run-on-start`: arm every RBS element the project loads,
    /// the same thing the panel's Run toggle does. A measurement run
    /// needs the simulation putting frames on the bus, and an RBS Run
    /// flag is session state a project file cannot carry (ADR 0028), so
    /// an unattended run has to ask for it in the launch as explicitly
    /// as a person would in the panel.
    pub rbs_run_on_start: bool,
    /// `--perf-interact <script>`: drive synthetic scroll / pan / zoom
    /// gestures at the heavy views while the capture runs, so the
    /// interaction cost of the render tier is in the measurement rather
    /// than only its resting cost. The webview owns the script names
    /// (`perfInteract.ts`); an unrecognised one falls back to the
    /// scrubbing script there. `None` leaves the run gestureless.
    pub interact: Option<String>,
}

impl AutomationConfig {
    /// Parse the perf launch flags out of `args` (typically
    /// `std::env::args()`, whose first element is the program path and is
    /// skipped). Returns `None` when none of the flags are present, so a
    /// normal launch is wholly unaffected. An unparseable
    /// `--perf-capture-secs` value leaves the capture span unset rather
    /// than failing the launch.
    #[must_use]
    pub fn from_args(args: impl IntoIterator<Item = String>) -> Option<Self> {
        let mut cfg = AutomationConfig::default();
        let mut seen = false;
        let mut it = args.into_iter();
        it.next(); // argv[0] — the program path
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "--project" => {
                    cfg.project = it.next();
                    seen = true;
                }
                "--connect-on-start" => {
                    cfg.connect_on_start = true;
                    seen = true;
                }
                "--rbs-run-on-start" => {
                    cfg.rbs_run_on_start = true;
                    seen = true;
                }
                "--perf-capture-secs" => {
                    cfg.capture_secs = it.next().and_then(|v| v.parse().ok());
                    seen = true;
                }
                "--perf-out" => {
                    cfg.out = it.next();
                    seen = true;
                }
                "--perf-label" => {
                    cfg.label = it.next();
                    seen = true;
                }
                "--perf-interact" => {
                    cfg.interact = it.next();
                    seen = true;
                }
                _ => {}
            }
        }
        seen.then_some(cfg)
    }
}

/// Whether this launch arms the frontend's diagnostic machinery — the
/// per-event counters and gauges, their burst logger, the `longtask`
/// observer, the 1 Hz console line, and the `window.__cannetPerf` capture
/// entry point (`diag.ts`).
///
/// **Off unless asked for.** All of it exists to be measured with, and a
/// normal launch is not being measured: it would pay Map traffic on every
/// render, an observer registration, and a console line a second for
/// nothing. `--diag` asks for it outright; the capture flags imply it,
/// because a capture's payload *is* those counters. `--project` /
/// `--app-data-dir` / `--connect-on-start` do not — they open and connect,
/// they don't record.
#[must_use]
pub fn diag_enabled_from_args(args: impl IntoIterator<Item = String>) -> bool {
    let mut on = false;
    let mut it = args.into_iter();
    it.next(); // argv[0] — the program path
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--diag" => on = true,
            "--perf-capture-secs" | "--perf-out" | "--perf-label" | "--perf-interact" => {
                it.next(); // the flag's value, which is data — not a flag
                on = true;
            }
            // Value-taking flags that don't arm anything: skip their value
            // so a project path of `--diag` stays a path.
            "--project" | "--app-data-dir" => {
                it.next();
            }
            _ => {}
        }
    }
    on
}

/// Managed wrapper for [`diag_enabled_from_args`]'s verdict.
pub struct DiagEnabled(pub bool);

/// Whether the frontend should arm its diagnostic machinery. The webview
/// calls this once, from the effect that starts the 1 Hz reporter.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn diag_enabled(state: State<'_, DiagEnabled>) -> bool {
    state.0
}

/// Managed wrapper so the parsed [`AutomationConfig`] (or its absence) can
/// live in Tauri state and be served to the webview on boot.
pub struct AutomationState(pub Option<AutomationConfig>);

/// Return the perf self-driving config parsed from the launch args, or
/// `null` for a normal launch. The webview calls this once on boot.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn diag_autostart(state: State<'_, AutomationState>) -> Option<AutomationConfig> {
    state.0.clone()
}

/// Exit the process with `code`. The webview has no other way to set a
/// process exit code — window close / `destroy()` always tears down with
/// 0 — so the perf automation (ADR 0031) calls this to fail a run loudly:
/// a capture window that never connected writes no report (absence is
/// the failure signal) and must still make the launching CLI see a
/// non-zero exit rather than a quiet success.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn exit_process(app: AppHandle, code: i32) {
    app.exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(t_ms: f64, lag_ms: f64, longtask_ms: f64) -> DiagSample {
        DiagSample {
            t_ms,
            lag_ms,
            longtask_ms,
            counts: BTreeMap::new(),
            gauges: BTreeMap::new(),
        }
    }

    fn approx(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "{a} != {b}");
    }

    /// Build a per-id rx timestamp series from a gap sequence (ms).
    fn series(gaps_ms: &[u64]) -> Vec<u64> {
        let mut ts = vec![0u64];
        for g in gaps_ms {
            ts.push(ts.last().unwrap() + g * 1_000_000);
        }
        ts
    }

    #[test]
    fn rx_gap_flags_the_bursty_id_not_the_healthy_one() {
        // Healthy: 10 ms grid with mild jitter. Bursty: the cohort
        // signature — runs of sub-ms catch-up gaps then a long stall.
        let healthy: Vec<u64> = series(&[10; 200]);
        let bursty: Vec<u64> = series(
            &std::iter::repeat_n([2u64, 2, 2, 2, 42], 40)
                .flatten()
                .collect::<Vec<_>>(),
        );
        let mut m = std::collections::HashMap::new();
        m.insert(("pack".to_string(), 0x100u32), healthy);
        m.insert(("pack".to_string(), 0x200u32), bursty);
        let r = rx_gap_stats(&m).expect("two qualifying ids");
        assert_eq!(r.ids_measured, 2);
        // Bursty id: median 2 ms, p95 = 42 ms → ratio 21; short gaps
        // (<1 ms) none — but the healthy id must not be the worst.
        assert!(r.worst_p95_ratio > 5.0, "ratio {}", r.worst_p95_ratio);
        assert_eq!(r.worst_p95_ratio_id, "pack/0x200");
        // Short-gap fraction: bursty id's 2 ms gaps sit under half its
        // *nominal* (the p95-side stall makes median 2 ms — so short is
        // judged against the healthy grid below instead).
        assert!(r.worst_short_frac_id.ends_with("0x200") || r.worst_short_frac <= 0.05);
    }

    #[test]
    fn rx_gap_short_fraction_catches_catch_up_pairs() {
        // 10 ms grid where every 10th frame arrives 1 ms after its
        // predecessor (the catch-up double): median stays 10 ms, and
        // ~10% of gaps are < 5 ms.
        let mut gaps = Vec::new();
        for _ in 0..40 {
            gaps.extend_from_slice(&[10u64; 8]);
            gaps.extend_from_slice(&[19, 1]);
        }
        let mut m = std::collections::HashMap::new();
        m.insert(("pack".to_string(), 0x300u32), series(&gaps));
        let r = rx_gap_stats(&m).expect("qualifying id");
        assert!(
            (r.worst_short_frac - 0.1).abs() < 0.02,
            "short_frac {}",
            r.worst_short_frac
        );
        assert_eq!(r.worst_short_frac_id, "pack/0x300");
    }

    #[test]
    fn rx_gap_ignores_sparse_and_aperiodic_ids() {
        let mut m = std::collections::HashMap::new();
        // Too few gaps to judge.
        m.insert(("a".to_string(), 1u32), series(&[10; 5]));
        // Aperiodic: median gap beyond the periodic band.
        m.insert(("a".to_string(), 2u32), series(&[5_000; 100]));
        assert!(rx_gap_stats(&m).is_none());
    }

    #[test]
    fn empty_capture_reduces_to_zeros() {
        let r = summarize("idle", &[]);
        assert_eq!(r.mode, "frontend");
        assert_eq!(r.sample_count, 0);
        assert_eq!(r.jank_seconds, 0);
        approx(r.jank_fraction, 0.0);
        approx(r.longtask_ms_per_s.max, 0.0);
        approx(r.frames_late_per_s_mean, 0.0);
        assert!(r.counters_per_s.is_empty());
        assert!(r.gauges.is_empty());
    }

    #[test]
    fn longtask_and_jank_are_computed_over_the_run() {
        // Four seconds; two exceed the 50 ms jank threshold.
        let samples = [
            sample(0.0, 1.0, 0.0),
            sample(1000.0, 2.0, 60.0),
            sample(2000.0, 3.0, 120.0),
            sample(3000.0, 4.0, 10.0),
        ];
        let r = summarize("plots", &samples);
        assert_eq!(r.sample_count, 4);
        approx(r.duration_s, 3.0); // span 0..3000 ms
        approx(r.longtask_ms_per_s.mean, (0.0 + 60.0 + 120.0 + 10.0) / 4.0);
        approx(r.longtask_ms_per_s.max, 120.0);
        assert_eq!(r.jank_seconds, 2); // 60 and 120 exceed 50
        approx(r.jank_fraction, 0.5);
        approx(r.lag_ms.mean, 2.5);
        approx(r.lag_ms.max, 4.0);
        // frames-late mean: each second's longtask / 16.67, averaged.
        approx(
            r.frames_late_per_s_mean,
            r.longtask_ms_per_s.mean / (1000.0 / 60.0),
        );
    }

    #[test]
    fn percentile_interpolates() {
        // p95 of 0,60,120,10 sorted = 0,10,60,120; rank=0.95*3=2.85 →
        // between 60 and 120: 60 + 0.85*(120-60) = 111.
        let samples = [
            sample(0.0, 0.0, 0.0),
            sample(1000.0, 0.0, 60.0),
            sample(2000.0, 0.0, 120.0),
            sample(3000.0, 0.0, 10.0),
        ];
        let r = summarize("x", &samples);
        approx(r.longtask_ms_per_s.p95, 111.0);
    }

    #[test]
    fn counters_treat_absent_keys_as_zero() {
        let mut a = sample(0.0, 0.0, 0.0);
        a.counts.insert("render.PlotArea".into(), 200.0);
        let mut b = sample(1000.0, 0.0, 0.0);
        // No render.PlotArea this second → counts as 0 in the mean.
        b.counts.insert("plotarea.resample".into(), 8.0);
        let r = summarize("x", &[a, b]);
        approx(r.counters_per_s["render.PlotArea"].mean, 100.0);
        approx(r.counters_per_s["render.PlotArea"].max, 200.0);
        approx(r.counters_per_s["plotarea.resample"].mean, 4.0);
    }

    #[test]
    fn rx_tx_fps_retention_splits_first_and_second_half() {
        // fps.rx halves from 1000→500 across the run (the contention
        // signature); fps.tx holds flat at 800. Retention catches the rx
        // decay (0.5) while tx stays ~1.0. Absent early readings are
        // skipped, so warmup before the first rate gauge doesn't skew it.
        let mut s = Vec::new();
        let rx = [1000.0, 1000.0, 500.0, 500.0];
        for (i, &r) in rx.iter().enumerate() {
            #[allow(clippy::cast_precision_loss)]
            let mut d = sample(i as f64 * 1000.0, 0.0, 0.0);
            d.gauges.insert("fps.rx".into(), r);
            d.gauges.insert("fps.tx".into(), 800.0);
            s.push(d);
        }
        let r = summarize("x", &s);
        approx(r.rx_fps.first_half, 1000.0);
        approx(r.rx_fps.second_half, 500.0);
        approx(r.rx_fps.retention, 0.5);
        approx(r.rx_fps.overall, 750.0);
        approx(r.tx_fps.retention, 1.0);
        approx(r.tx_fps.overall, 800.0);
    }

    #[test]
    fn rate_report_is_zero_when_the_gauge_never_reported() {
        let r = summarize("idle", &[sample(0.0, 0.0, 0.0), sample(1000.0, 0.0, 0.0)]);
        approx(r.rx_fps.overall, 0.0);
        approx(r.rx_fps.retention, 0.0);
    }

    #[test]
    fn gauges_skip_absent_readings_and_keep_last() {
        let mut a = sample(0.0, 0.0, 0.0);
        a.gauges.insert("count".into(), 1000.0);
        let b = sample(1000.0, 0.0, 0.0); // no gauge reading this second
        let mut c = sample(2000.0, 0.0, 0.0);
        c.gauges.insert("count".into(), 3000.0);
        let r = summarize("x", &[a, b, c]);
        // mean over the two readings that exist, not three.
        approx(r.gauges["count"].mean, 2000.0);
        approx(r.gauges["count"].max, 3000.0);
        approx(r.gauges["count"].last, 3000.0);
    }

    #[test]
    fn gauge_slope_is_the_linear_drift_per_minute() {
        // A gauge climbing 100 units every second (1000 ms) drifts at
        // 100 * 60 = 6000 units/min, regardless of noise-free linearity.
        let samples: Vec<DiagSample> = (0..10)
            .map(|i| {
                let mut s = sample(f64::from(i) * 1000.0, 0.0, 0.0);
                s.gauges
                    .insert("mem.host_mb".into(), 50.0 + f64::from(i) * 100.0);
                s
            })
            .collect();
        let r = summarize("climb", &samples);
        approx(r.gauges["mem.host_mb"].slope_per_min, 6000.0);
        // A flat gauge has zero drift; a single reading too.
        let flat: Vec<DiagSample> = (0..5)
            .map(|i| {
                let mut s = sample(f64::from(i) * 1000.0, 0.0, 0.0);
                s.gauges.insert("flat".into(), 42.0);
                s
            })
            .collect();
        approx(summarize("flat", &flat).gauges["flat"].slope_per_min, 0.0);
    }

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn diag_is_off_on_a_plain_launch() {
        // The binding property: nothing a normal launch does arms the
        // frontend's diagnostic machinery. `--project` / `--app-data-dir`
        // are harness flags too, but they open a project — they don't ask
        // for measurement, so they don't turn the counters on either.
        assert!(!diag_enabled_from_args(args(&["cannet"])));
        assert!(!diag_enabled_from_args(args(&[
            "cannet",
            "--some-other-flag"
        ])));
        assert!(!diag_enabled_from_args(args(&[
            "cannet",
            "--project",
            "demo.cannet_prj",
            "--app-data-dir",
            "/tmp/scope",
            "--connect-on-start",
        ])));
    }

    #[test]
    fn diag_is_armed_by_its_own_flag() {
        assert!(diag_enabled_from_args(args(&["cannet", "--diag"])));
    }

    #[test]
    fn a_capture_run_arms_diag_without_asking() {
        // The capture's payload *is* the counters, so every flag that
        // brackets or shapes a capture implies them — otherwise every
        // harness invocation would have to remember a second flag.
        for flag in [
            "--perf-capture-secs",
            "--perf-out",
            "--perf-label",
            "--perf-interact",
        ] {
            assert!(
                diag_enabled_from_args(args(&["cannet", flag, "x"])),
                "{flag} must arm diag"
            );
        }
    }

    #[test]
    fn a_flag_value_that_looks_like_diag_does_not_arm_it() {
        // `--project --diag` names a project called `--diag`; the value of
        // a value-taking flag is data, not a flag.
        assert!(!diag_enabled_from_args(args(&[
            "cannet",
            "--project",
            "--diag"
        ])));
    }

    #[test]
    fn host_metrics_record_nothing_until_a_capture_arms_them() {
        // C7: the max-recorders are drained only by `diag_push`, so on a
        // plain launch the flusher's and scheduler's calls must not reach
        // the atomics at all.
        let m = HostMetrics::default();
        m.record_flush_ms(42.0);
        m.record_tx_late_ms(17.0);
        assert_eq!(m.drain(), (0.0, 0.0), "unarmed metrics must stay empty");

        m.set_armed(true);
        m.record_flush_ms(42.0);
        m.record_tx_late_ms(17.0);
        assert_eq!(m.drain(), (42.0, 17.0));

        m.set_armed(false);
        m.record_flush_ms(99.0);
        assert_eq!(m.drain(), (0.0, 0.0), "disarming stops the recording");
    }

    #[test]
    fn autostart_absent_without_flags() {
        assert_eq!(AutomationConfig::from_args(args(&["cannet"])), None);
        assert_eq!(
            AutomationConfig::from_args(args(&["cannet", "--some-other-flag", "x"])),
            None
        );
    }

    #[test]
    fn autostart_project_only() {
        let cfg = AutomationConfig::from_args(args(&["cannet", "--project", "/p/demo.cannet_prj"]))
            .expect("project flag arms autostart");
        assert_eq!(cfg.project.as_deref(), Some("/p/demo.cannet_prj"));
        assert!(!cfg.connect_on_start);
        assert_eq!(cfg.capture_secs, None);
        assert_eq!(cfg.out, None);
    }

    #[test]
    fn autostart_connect_only() {
        let cfg = AutomationConfig::from_args(args(&["cannet", "--connect-on-start"]))
            .expect("connect flag arms autostart");
        assert!(cfg.connect_on_start);
        assert_eq!(cfg.project, None);
        assert_eq!(cfg.capture_secs, None);
    }

    #[test]
    fn autostart_full_capture_run() {
        let cfg = AutomationConfig::from_args(args(&[
            "cannet",
            "--project",
            "demo.cannet_prj",
            "--connect-on-start",
            "--perf-capture-secs",
            "30",
            "--perf-out",
            "out/report.json",
            "--perf-label",
            "2 plots + 2 traces",
            "--perf-interact",
            "scrub",
        ]))
        .expect("flags arm autostart");
        assert_eq!(cfg.project.as_deref(), Some("demo.cannet_prj"));
        assert!(cfg.connect_on_start);
        assert_eq!(cfg.capture_secs, Some(30));
        assert_eq!(cfg.out.as_deref(), Some("out/report.json"));
        assert_eq!(cfg.label.as_deref(), Some("2 plots + 2 traces"));
        assert_eq!(cfg.interact.as_deref(), Some("scrub"));
    }

    #[test]
    fn autostart_arms_the_rbs_only_when_asked() {
        // A project can no longer carry "this simulation is live"
        // (ADR 0028 — Run is session state), so an unattended
        // measurement run has to ask for it, and a run that does not ask
        // must stay silent on the bus.
        let cfg = AutomationConfig::from_args(args(&["cannet", "--connect-on-start"]))
            .expect("flag arms autostart");
        assert!(!cfg.rbs_run_on_start);
        let cfg = AutomationConfig::from_args(args(&[
            "cannet",
            "--connect-on-start",
            "--rbs-run-on-start",
        ]))
        .expect("flag arms autostart");
        assert!(cfg.rbs_run_on_start);
    }

    #[test]
    fn autostart_without_interact_is_gestureless() {
        // The interaction script is opt-in: a capture that doesn't ask
        // for one must measure the resting cost, unperturbed.
        let cfg = AutomationConfig::from_args(args(&["cannet", "--perf-capture-secs", "30"]))
            .expect("flag arms autostart");
        assert_eq!(cfg.interact, None);
    }

    #[test]
    fn autostart_capture_secs_ignores_unparseable_value() {
        // Garbage value: the flag is still "seen" (autostart arms) but the
        // span stays unset rather than aborting the launch.
        let cfg = AutomationConfig::from_args(args(&["cannet", "--perf-capture-secs", "soon"]))
            .expect("flag arms autostart");
        assert_eq!(cfg.capture_secs, None);
    }
}
