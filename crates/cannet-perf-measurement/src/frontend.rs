//! Frontend (render-tier) baseline integration.
//!
//! The host harness drives the model but cannot *produce* a frontend
//! report — only the running webview sees the React / uPlot / virtualizer
//! render tier (ADR 0031). So a self-driving GUI run writes a render
//! report and the harness consumes it: `baseline` stores the report's
//! gated UX-health metrics, and `check` compares a fresh report against
//! them. With no report supplied (`--frontend-report`), frontend is
//! omitted at capture and skipped at check — exactly as a mode whose
//! hardware is absent is.
//!
//! Only the regression-gating subset of the render report is mirrored
//! here (the same way [`crate::check::Metrics`] mirrors a subset of the
//! host [`crate::runner::HarnessReport`]); the report's full counter and
//! gauge maps are carried for humans, not gated, so they are ignored on
//! read.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::check::{expected_band_verdict, tol as ctol, Expected, Verdict};

/// Long-task fields read from the report's `longtask_ms_per_s` spread.
#[derive(Debug, Clone, Deserialize)]
struct LongTaskFields {
    mean: f64,
    p95: f64,
}

/// Lag field read from the report's `lag_ms` spread.
#[derive(Debug, Clone, Deserialize)]
struct LagFields {
    max: f64,
}

/// The gating subset of a report's `rx_fps` / `tx_fps` [`RateReport`]: the
/// overall level (gated against the expected floor) and the retention
/// ratio (gated against a decay floor). Defaults to zero so a report
/// predating the split still parses.
#[derive(Debug, Clone, Default, Deserialize)]
struct RateFields {
    overall: f64,
    retention: f64,
}

/// The gating subset of a report's per-gauge `GaugeSpread`: the run peak
/// and the linear drift. Used for the memory gauges (`jsheap_mb`,
/// `mem.webview_renderer_mb`, `mem.host_mb`). Default-zero so a gauge — or
/// a whole report predating the drift field — still parses.
#[derive(Debug, Clone, Default, Deserialize)]
struct GaugeFields {
    #[serde(default)]
    mean: f64,
    #[serde(default)]
    max: f64,
    #[serde(default)]
    slope_per_min: f64,
}

/// The frontend `RenderReport` as the harness reads it: the gating subset
/// plus a little context for the printout. Extra fields (counters,
/// per-frame detail) are ignored; the `gauges` map is read for the memory
/// metrics only.
#[derive(Debug, Clone, Deserialize)]
pub struct FrontendReport {
    pub label: String,
    pub duration_s: f64,
    pub sample_count: usize,
    longtask_ms_per_s: LongTaskFields,
    lag_ms: LagFields,
    pub jank_fraction: f64,
    /// Receive / transmit-confirmed throughput, split by direction (the
    /// `fps.rx` / `fps.tx` gauges reduced by `diag.rs`). Default-zero so a
    /// report from before the split still parses.
    #[serde(default)]
    rx_fps: RateFields,
    #[serde(default)]
    tx_fps: RateFields,
    /// The reduced per-gauge map; the memory peak/drift metrics are pulled
    /// out by key. Default-empty so a report without it still parses.
    #[serde(default)]
    gauges: BTreeMap<String, GaugeFields>,
}

/// The render-tier metrics persisted in a baseline and compared by
/// `check` — the UX-health numbers a regression would move.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FrontendMetrics {
    /// Sustained UI-thread blocking (ms of long-task time per second).
    pub longtask_ms_per_s_mean: f64,
    /// The long-task tail — the hitch a user actually feels.
    pub longtask_ms_per_s_p95: f64,
    /// Worst event-loop lateness — how starved timers got.
    pub lag_ms_max: f64,
    /// Fraction of seconds that hitched (long-task time over threshold).
    pub jank_fraction: f64,
    /// Receive throughput over the run, and its first/second-half
    /// retention. The retention is the buffer-growth-degradation signal
    /// the gated longtask/lag/jank metrics are blind to (they stayed green
    /// while real ingest halved). Default-zero on baselines from before
    /// the split — regenerate the baseline to arm the relative gate; the
    /// absolute expected-rate gate ([`Expected`]) is baseline-independent
    /// and protects regardless.
    #[serde(default)]
    pub rx_fps_overall: f64,
    #[serde(default)]
    pub rx_fps_retention: f64,
    /// Transmit-confirmed throughput, same reduction — split so a
    /// transmit-only stall is gated even when receive holds.
    #[serde(default)]
    pub tx_fps_overall: f64,
    #[serde(default)]
    pub tx_fps_retention: f64,
    /// Renderer memory health (ADR 0031): the run peak and the linear
    /// drift per minute, for the JS heap (`jsheap_mb`), the `WebView`
    /// renderer process RSS (`mem.webview_renderer_mb` — where a native or
    /// GPU-side climb the heap can't see shows up), and the Rust host RSS
    /// (`mem.host_mb`, expected flat). Default-zero on baselines from
    /// before the memory tier; the relative gate is inert until the
    /// baseline is regenerated with these populated (a leak's signature is
    /// the renderer/jsheap *drift*, which `max`/`last` alone miss).
    #[serde(default)]
    pub jsheap_mb_peak: f64,
    #[serde(default)]
    pub jsheap_mb_drift_per_min: f64,
    #[serde(default)]
    pub renderer_mb_peak: f64,
    #[serde(default)]
    pub renderer_mb_drift_per_min: f64,
    #[serde(default)]
    pub host_mb_peak: f64,
    /// Whole-app RSS — the Rust host plus every descendant
    /// (`mem.tree_mb`): browser, renderer, GPU, and utility `WebView`
    /// processes folded together. The holistic backstop the per-process
    /// gates don't cover — a leak in the GPU or a helper process trips
    /// neither `renderer` nor `host` but shows here, and it's the single
    /// number for total-footprint growth.
    #[serde(default)]
    pub tree_mb_peak: f64,
    #[serde(default)]
    pub tree_mb_drift_per_min: f64,
    /// Host append-lock contention (ADR 0031), each the **mean** over the
    /// capture's per-second worst values: `flush_ms` is the periodic
    /// `TraceStore::flush` duration (it holds the append lock, so it *is*
    /// the contention) and `tx_late_ms` is the transmit scheduler's wake
    /// lateness (the user-facing effect). Throughput/retention is
    /// structurally blind to these — a sub-second stall is refilled by the
    /// catch-up burst, so `tx_fps` retention stays ~1.0 through it. The
    /// *mean* (not the peak) is the gated statistic: the regression is a
    /// *systematic per-flush* stall (every tick), which moves the mean
    /// cleanly, whereas a peak gate would flap on one-off OS writeback
    /// noise. Gated against an absolute ceiling, not the baseline (a flush
    /// should be a few ms regardless of the machine).
    #[serde(default)]
    pub flush_ms_mean: f64,
    #[serde(default)]
    pub tx_late_ms_mean: f64,
}

impl From<&FrontendReport> for FrontendMetrics {
    fn from(r: &FrontendReport) -> Self {
        Self {
            longtask_ms_per_s_mean: r.longtask_ms_per_s.mean,
            longtask_ms_per_s_p95: r.longtask_ms_per_s.p95,
            lag_ms_max: r.lag_ms.max,
            jank_fraction: r.jank_fraction,
            rx_fps_overall: r.rx_fps.overall,
            rx_fps_retention: r.rx_fps.retention,
            tx_fps_overall: r.tx_fps.overall,
            tx_fps_retention: r.tx_fps.retention,
            jsheap_mb_peak: r.gauge("jsheap_mb").max,
            jsheap_mb_drift_per_min: r.gauge("jsheap_mb").slope_per_min,
            renderer_mb_peak: r.gauge("mem.webview_renderer_mb").max,
            renderer_mb_drift_per_min: r.gauge("mem.webview_renderer_mb").slope_per_min,
            host_mb_peak: r.gauge("mem.host_mb").max,
            tree_mb_peak: r.gauge("mem.tree_mb").max,
            tree_mb_drift_per_min: r.gauge("mem.tree_mb").slope_per_min,
            flush_ms_mean: r.gauge("flush_ms").mean,
            tx_late_ms_mean: r.gauge("tx_late_ms").mean,
        }
    }
}

impl FrontendReport {
    /// The gating fields for gauge `key`, or zeros when the run didn't
    /// report it (a non-Chromium webview without `jsheap_mb`, or a report
    /// predating the host memory split).
    fn gauge(&self, key: &str) -> GaugeFields {
        self.gauges.get(key).cloned().unwrap_or_default()
    }
}

/// One captured frontend baseline: the run's label plus its gated metrics.
/// No re-run config (unlike the host modes) — the report is supplied, not
/// regenerated.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrontendBaseline {
    pub label: String,
    pub metrics: FrontendMetrics,
}

/// Read and parse a frontend render report written by a self-driving GUI
/// run (`--perf-out`).
///
/// # Errors
/// Returns a message if the file is unreadable or isn't a render report.
pub fn load_report(path: &Path) -> Result<FrontendReport, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("reading frontend report {}: {e}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("parsing frontend report {}: {e}", path.display()))
}

/// Gating tolerances. Every frontend metric is lower-is-better, so each
/// gets a ceiling of `baseline * FACTOR + floor`; the floor (in the
/// metric's own units) keeps a near-zero baseline from false-tripping on
/// ordinary scheduler jitter.
mod ftol {
    pub const FACTOR: f64 = 2.0;
    /// Sustained long-task floor (ms/s).
    pub const LONGTASK_MEAN_FLOOR_MS: f64 = 10.0;
    /// Long-task tail floor — about one 60 Hz frame (ms).
    pub const LONGTASK_P95_FLOOR_MS: f64 = 17.0;
    /// Event-loop lateness floor (ms).
    pub const LAG_FLOOR_MS: f64 = 20.0;
    /// Jank-fraction floor (5 % of seconds may hitch before it gates).
    pub const JANK_FLOOR: f64 = 0.05;
    /// Memory-peak floor (MB) — headroom over the baseline peak before a
    /// taller high-water mark gates.
    pub const MEM_PEAK_FLOOR_MB: f64 = 64.0;
    /// Memory-drift floor (MB/min) — a baseline near-zero slope still
    /// tolerates this much climb (allocator/V8 watermark wobble) before the
    /// drift gate trips.
    pub const MEM_DRIFT_FLOOR_MB_PER_MIN: f64 = 5.0;
    /// Absolute ceiling (ms) on the **mean** `TraceStore::flush` duration —
    /// it holds the append lock, so a healthy flush averages a few ms
    /// whatever the scenario; the systematic-stall regression drove the
    /// mean to ~38 ms (every tick slow). Mean, not peak, so a single slow
    /// writeback doesn't flap the gate.
    pub const FLUSH_MS_CEILING: f64 = 25.0;
    /// Absolute ceiling (ms) on the **mean** transmit-scheduler wake
    /// lateness (regression mean ~27 ms; healthy ~9 ms).
    pub const TX_LATE_MS_CEILING: f64 = 18.0;
}

/// Compare a fresh frontend report's metrics against the baseline's, and
/// against the operator-supplied [`Expected`] sim rates.
///
/// Three families of gate:
/// - **Lower-is-better, baseline-relative** — longtask / lag / jank
///   (render-tier UX health).
/// - **Higher-is-better, baseline-relative** — rx / tx throughput
///   *retention* (the buffer-growth-degradation signal). Floored the same
///   way the host harness floors `fps_retention`.
/// - **Higher-is-better, absolute** — rx / tx throughput vs the expected
///   sim rate, when handed in. Baseline-independent, so a uniformly-slow
///   run is caught even against a slow baseline.
#[must_use]
#[allow(clippy::too_many_lines)] // a flat list of independent gate blocks
pub fn check_frontend(
    baseline: &FrontendMetrics,
    current: &FrontendMetrics,
    expected: Expected,
) -> Vec<Verdict> {
    let mut verdicts: Vec<Verdict> = [
        (
            "longtask_ms_per_s_mean",
            baseline.longtask_ms_per_s_mean,
            current.longtask_ms_per_s_mean,
            ftol::LONGTASK_MEAN_FLOOR_MS,
        ),
        (
            "longtask_ms_per_s_p95",
            baseline.longtask_ms_per_s_p95,
            current.longtask_ms_per_s_p95,
            ftol::LONGTASK_P95_FLOOR_MS,
        ),
        (
            "lag_ms_max",
            baseline.lag_ms_max,
            current.lag_ms_max,
            ftol::LAG_FLOOR_MS,
        ),
        (
            "jank_fraction",
            baseline.jank_fraction,
            current.jank_fraction,
            ftol::JANK_FLOOR,
        ),
    ]
    .into_iter()
    .map(|(metric, base, cur, floor)| {
        let limit = base * ftol::FACTOR + floor;
        Verdict {
            mode: "frontend",
            metric,
            baseline: base,
            current: cur,
            limit,
            pass: cur <= limit,
        }
    })
    .collect();

    // Lower-is-better memory peak / drift (ADR 0031). Each is gated
    // `baseline * FACTOR + floor`, like the render metrics — but skipped
    // entirely when the baseline value is absent (≤ 0), so the gate stays
    // inert until a baseline is regenerated with the memory tier
    // populated. A real leak's signature is a renderer/jsheap *drift* that
    // outpaces the baseline's; the peak catches a higher high-water mark.
    for (metric, base, cur, floor) in [
        (
            "jsheap_mb_peak",
            baseline.jsheap_mb_peak,
            current.jsheap_mb_peak,
            ftol::MEM_PEAK_FLOOR_MB,
        ),
        (
            "jsheap_mb_drift_per_min",
            baseline.jsheap_mb_drift_per_min,
            current.jsheap_mb_drift_per_min,
            ftol::MEM_DRIFT_FLOOR_MB_PER_MIN,
        ),
        (
            "renderer_mb_peak",
            baseline.renderer_mb_peak,
            current.renderer_mb_peak,
            ftol::MEM_PEAK_FLOOR_MB,
        ),
        (
            "renderer_mb_drift_per_min",
            baseline.renderer_mb_drift_per_min,
            current.renderer_mb_drift_per_min,
            ftol::MEM_DRIFT_FLOOR_MB_PER_MIN,
        ),
        (
            "host_mb_peak",
            baseline.host_mb_peak,
            current.host_mb_peak,
            ftol::MEM_PEAK_FLOOR_MB,
        ),
        (
            "tree_mb_peak",
            baseline.tree_mb_peak,
            current.tree_mb_peak,
            ftol::MEM_PEAK_FLOOR_MB,
        ),
        (
            "tree_mb_drift_per_min",
            baseline.tree_mb_drift_per_min,
            current.tree_mb_drift_per_min,
            ftol::MEM_DRIFT_FLOOR_MB_PER_MIN,
        ),
    ] {
        if base <= 0.0 {
            continue; // inert until the baseline carries the memory tier
        }
        let limit = base * ftol::FACTOR + floor;
        verdicts.push(Verdict {
            mode: "frontend",
            metric,
            baseline: base,
            current: cur,
            limit,
            pass: cur <= limit,
        });
    }

    // Absolute host-contention ceilings (ADR 0031), lower-is-better with a
    // fixed bar rather than baseline-relative — these are tail signals
    // throughput can't see, and a systematic flush/scheduler stall is a bug
    // regardless of the machine. The gated statistic is the *mean* (the
    // regression slows every flush, moving it cleanly; a peak would flap on
    // one-off OS writeback noise). Always active (an absent gauge reads 0,
    // which passes).
    for (metric, cur, ceiling) in [
        ("flush_ms_mean", current.flush_ms_mean, ftol::FLUSH_MS_CEILING),
        ("tx_late_ms_mean", current.tx_late_ms_mean, ftol::TX_LATE_MS_CEILING),
    ] {
        verdicts.push(Verdict {
            mode: "frontend",
            metric,
            baseline: ceiling, // absolute gate: the fixed bar, shown for context
            current: cur,
            limit: ceiling,
            pass: cur <= ceiling,
        });
    }

    // Higher-is-better retention floors (mirror the host `fps_retention`
    // gate): no worse than 0.90× baseline, and never below 0.80 absolute.
    for (metric, base, cur) in [
        (
            "rx_fps_retention",
            baseline.rx_fps_retention,
            current.rx_fps_retention,
        ),
        (
            "tx_fps_retention",
            baseline.tx_fps_retention,
            current.tx_fps_retention,
        ),
    ] {
        let limit = (base * ctol::RETENTION_MIN_FRACTION).min(ctol::RETENTION_ABS_FLOOR);
        verdicts.push(Verdict {
            mode: "frontend",
            metric,
            baseline: base,
            current: cur,
            limit,
            pass: cur >= limit,
        });
    }

    // Absolute expected-rate bands, when handed in. Two-sided: a
    // deterministic sim has a known average, so both a shortfall and an
    // overshoot fail.
    if let Some(rx) = expected.rx_fps {
        verdicts.push(expected_band_verdict(
            "frontend",
            "rx_fps_expected",
            current.rx_fps_overall,
            rx,
        ));
    }
    if let Some(tx) = expected.tx_fps {
        verdicts.push(expected_band_verdict(
            "frontend",
            "tx_fps_expected",
            current.tx_fps_overall,
            tx,
        ));
    }

    verdicts
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A render report carries far more than the gated subset; the parser
    /// must pull the four gated numbers and ignore the rest.
    const SAMPLE: &str = r#"{
        "mode": "frontend",
        "label": "2 plots + 2 traces",
        "duration_s": 30.0,
        "sample_count": 30,
        "longtask_ms_per_s": { "mean": 0.8, "max": 81.0, "p95": 12.0 },
        "lag_ms": { "mean": -0.01, "max": 27.0 },
        "jank_seconds": 1,
        "jank_fraction": 0.0333,
        "frames_late_per_s_mean": 0.048,
        "rx_fps": { "overall": 1000.0, "first_half": 1100.0, "second_half": 900.0, "retention": 0.82 },
        "tx_fps": { "overall": 500.0, "first_half": 500.0, "second_half": 500.0, "retention": 1.0 },
        "counters_per_s": { "render.PlotArea": { "mean": 951.0, "max": 1224.0 } },
        "gauges": { "fps": { "mean": 1031.0, "max": 1051.0, "last": 1022.0 } }
    }"#;

    fn approx(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} != {b}");
    }

    #[test]
    fn parses_gated_subset_and_ignores_the_rest() {
        let report: FrontendReport = serde_json::from_str(SAMPLE).expect("parses");
        assert_eq!(report.label, "2 plots + 2 traces");
        approx(report.duration_s, 30.0);
        assert_eq!(report.sample_count, 30);
        let m = FrontendMetrics::from(&report);
        approx(m.longtask_ms_per_s_mean, 0.8);
        approx(m.longtask_ms_per_s_p95, 12.0);
        approx(m.lag_ms_max, 27.0);
        approx(m.jank_fraction, 0.0333);
        approx(m.rx_fps_overall, 1000.0);
        approx(m.rx_fps_retention, 0.82);
        approx(m.tx_fps_overall, 500.0);
        approx(m.tx_fps_retention, 1.0);
    }

    #[test]
    fn a_report_without_the_rate_split_still_parses() {
        // A render report predating the rx/tx split: the rate fields are
        // absent and default to zero rather than failing the parse.
        let no_rates = r#"{
            "mode": "frontend", "label": "old", "duration_s": 1.0, "sample_count": 1,
            "longtask_ms_per_s": { "mean": 0.0, "max": 0.0, "p95": 0.0 },
            "lag_ms": { "mean": 0.0, "max": 0.0 }, "jank_seconds": 0, "jank_fraction": 0.0
        }"#;
        let report: FrontendReport = serde_json::from_str(no_rates).expect("parses without rates");
        let m = FrontendMetrics::from(&report);
        approx(m.rx_fps_overall, 0.0);
        approx(m.tx_fps_retention, 0.0);
    }

    fn metrics(longtask_mean: f64, p95: f64, lag_max: f64, jank: f64) -> FrontendMetrics {
        FrontendMetrics {
            longtask_ms_per_s_mean: longtask_mean,
            longtask_ms_per_s_p95: p95,
            lag_ms_max: lag_max,
            jank_fraction: jank,
            // Healthy throughput by default; the rate-specific tests
            // override these.
            rx_fps_overall: 1000.0,
            rx_fps_retention: 1.0,
            tx_fps_overall: 500.0,
            tx_fps_retention: 1.0,
            // Memory tier absent by default (base ≤ 0 ⇒ inert); the
            // memory-specific tests populate it.
            jsheap_mb_peak: 0.0,
            jsheap_mb_drift_per_min: 0.0,
            renderer_mb_peak: 0.0,
            renderer_mb_drift_per_min: 0.0,
            host_mb_peak: 0.0,
            tree_mb_peak: 0.0,
            tree_mb_drift_per_min: 0.0,
            // Healthy host contention by default (well under the ceilings);
            // the contention-specific test drives these.
            flush_ms_mean: 0.0,
            tx_late_ms_mean: 0.0,
        }
    }

    #[test]
    fn within_tolerance_passes() {
        let base = metrics(1.0, 12.0, 27.0, 0.03);
        // Each render metric grows but stays under `base * 2 + floor`;
        // throughput holds. No expected handed in, memory absent (skipped)
        // → 4 UX + 2 contention ceilings + 2 retention.
        let cur = metrics(10.0, 38.0, 70.0, 0.1);
        let verdicts = check_frontend(&base, &cur, Expected::default());
        assert_eq!(verdicts.len(), 8);
        assert!(verdicts.iter().all(|v| v.pass), "all within tolerance");
    }

    #[test]
    fn a_regressed_metric_fails_only_itself() {
        let base = metrics(1.0, 12.0, 27.0, 0.03);
        // jank blows past 0.03 * 2 + 0.05 = 0.11; the others stay in band.
        let cur = metrics(1.5, 13.0, 30.0, 0.5);
        let verdicts = check_frontend(&base, &cur, Expected::default());
        let jank = verdicts.iter().find(|v| v.metric == "jank_fraction").unwrap();
        assert!(!jank.pass, "jank regressed");
        assert!(
            verdicts.iter().filter(|v| v.metric != "jank_fraction").all(|v| v.pass),
            "only jank should fail"
        );
    }

    #[test]
    fn a_retention_collapse_fails_even_with_healthy_render_metrics() {
        // The diagnosed bug's signature: render-tier UX stays green
        // (longtask/lag/jank flat) while rx throughput halves over the
        // run. The retention gate must catch it where the others can't.
        let base = metrics(1.0, 12.0, 27.0, 0.03);
        let mut cur = metrics(1.0, 12.0, 27.0, 0.03);
        cur.rx_fps_retention = 0.5; // halved as the buffer grew
        let verdicts = check_frontend(&base, &cur, Expected::default());
        let rx = verdicts.iter().find(|v| v.metric == "rx_fps_retention").unwrap();
        assert!(!rx.pass, "rx retention 0.5 < 0.80 floor must fail");
        assert!(
            verdicts.iter().filter(|v| v.metric != "rx_fps_retention").all(|v| v.pass),
            "only rx retention should fail"
        );
    }

    #[test]
    fn memory_gates_are_inert_until_the_baseline_carries_them() {
        // A baseline with no memory tier (all zero) must not gate memory,
        // even against a current run that ballooned — there's nothing to
        // compare against yet. Verdict count stays the 4 UX + 2 retention.
        let base = metrics(1.0, 12.0, 27.0, 0.03);
        let mut cur = metrics(1.0, 12.0, 27.0, 0.03);
        cur.renderer_mb_peak = 4096.0;
        cur.renderer_mb_drift_per_min = 200.0;
        cur.jsheap_mb_peak = 2048.0;
        let verdicts = check_frontend(&base, &cur, Expected::default());
        // 4 UX + 2 contention ceilings + 2 retention; memory still inert.
        assert_eq!(verdicts.len(), 8);
        assert!(!verdicts.iter().any(|v| v.metric.contains("_mb")));
    }

    #[test]
    fn an_armed_renderer_drift_gate_catches_a_leak() {
        // Once the baseline carries a (healthy, small) renderer drift, a
        // run drifting far faster fails the drift gate; a peak bump within
        // base*2 + floor stays green.
        let mut base = metrics(1.0, 12.0, 27.0, 0.03);
        base.renderer_mb_peak = 800.0;
        base.renderer_mb_drift_per_min = 2.0;
        base.jsheap_mb_peak = 300.0;
        base.jsheap_mb_drift_per_min = 1.0;
        base.host_mb_peak = 80.0;
        base.tree_mb_peak = 1000.0;
        base.tree_mb_drift_per_min = 3.0;

        let mut cur = base.clone();
        cur.renderer_mb_drift_per_min = 60.0; // 60 > 2*2 + 5 = 9 ⇒ fails
        let verdicts = check_frontend(&base, &cur, Expected::default());
        let drift = verdicts
            .iter()
            .find(|v| v.metric == "renderer_mb_drift_per_min")
            .unwrap();
        assert!(!drift.pass, "runaway renderer drift must fail");
        // All seven memory verdicts are present (baseline armed) and only
        // the renderer drift one failed.
        assert_eq!(verdicts.iter().filter(|v| v.metric.contains("_mb")).count(), 7);
        assert!(
            verdicts
                .iter()
                .filter(|v| v.metric.contains("_mb") && v.metric != "renderer_mb_drift_per_min")
                .all(|v| v.pass),
            "only the renderer drift should fail",
        );
    }

    #[test]
    fn host_contention_ceilings_catch_a_stall_a_throughput_average_misses() {
        // The flush-under-lock regression's signature: throughput holds
        // (retention ~1.0, the sub-second stall refilled by the catch-up
        // burst) while the *mean* per-second flush / scheduler time climbs
        // (every tick is slow). The absolute ceilings must fail on that
        // even with healthy rates.
        let base = metrics(1.0, 12.0, 27.0, 0.03);
        let mut cur = metrics(1.0, 12.0, 27.0, 0.03); // throughput perfect
        cur.flush_ms_mean = 38.0; // > 25 ms ceiling (systematic stall)
        cur.tx_late_ms_mean = 27.0; // > 18 ms ceiling
        let verdicts = check_frontend(&base, &cur, Expected::default());
        let flush = verdicts.iter().find(|v| v.metric == "flush_ms_mean").unwrap();
        let txl = verdicts.iter().find(|v| v.metric == "tx_late_ms_mean").unwrap();
        assert!(!flush.pass, "38ms mean flush must fail the 25ms ceiling");
        assert!(!txl.pass, "27ms mean lateness must fail the 18ms ceiling");
        // The retention gates stayed green — proving the ceilings catch
        // what the averages cannot.
        assert!(
            verdicts.iter().filter(|v| v.metric.ends_with("_retention")).all(|v| v.pass),
            "throughput retention is blind to the sub-second stall",
        );
        // And a healthy run passes both ceilings.
        let verdicts = check_frontend(&base, &base, Expected::default());
        assert!(
            verdicts
                .iter()
                .filter(|v| v.metric == "flush_ms_mean" || v.metric == "tx_late_ms_mean")
                .all(|v| v.pass),
            "a few-ms mean flush / lateness passes",
        );
    }

    #[test]
    fn from_report_pulls_memory_gauges_by_key() {
        let with_mem = r#"{
            "mode": "frontend", "label": "mem", "duration_s": 60.0, "sample_count": 60,
            "longtask_ms_per_s": { "mean": 0.0, "max": 0.0, "p95": 0.0 },
            "lag_ms": { "mean": 0.0, "max": 0.0 }, "jank_seconds": 0, "jank_fraction": 0.0,
            "gauges": {
                "jsheap_mb": { "mean": 250.0, "max": 320.0, "last": 318.0, "slope_per_min": 1.4 },
                "mem.webview_renderer_mb": { "mean": 900.0, "max": 1200.0, "last": 1180.0, "slope_per_min": 8.0 },
                "mem.host_mb": { "mean": 78.0, "max": 80.0, "last": 79.0, "slope_per_min": 0.0 },
                "mem.tree_mb": { "mean": 1300.0, "max": 1600.0, "last": 1580.0, "slope_per_min": 9.5 }
            }
        }"#;
        let report: FrontendReport = serde_json::from_str(with_mem).expect("parses");
        let m = FrontendMetrics::from(&report);
        approx(m.jsheap_mb_peak, 320.0);
        approx(m.jsheap_mb_drift_per_min, 1.4);
        approx(m.renderer_mb_peak, 1200.0);
        approx(m.renderer_mb_drift_per_min, 8.0);
        approx(m.host_mb_peak, 80.0);
        approx(m.tree_mb_peak, 1600.0);
        approx(m.tree_mb_drift_per_min, 9.5);
    }

    #[test]
    fn the_expected_band_fails_both_a_shortfall_and_an_overshoot() {
        // Two-sided absolute gate around the deterministic sim rate: too
        // few (frames dropped) and too many (duplication/runaway) both
        // fail; in-band passes. Band is ±15%, so for expected 1000 the
        // band is [850, 1150]; for 500 it's [425, 575].
        let base = metrics(1.0, 12.0, 27.0, 0.03);
        let mut cur = metrics(1.0, 12.0, 27.0, 0.03);
        cur.rx_fps_overall = 700.0; // < 850 → shortfall, fails
        cur.tx_fps_overall = 650.0; // > 575 → overshoot, fails
        let expected = Expected {
            rx_fps: Some(1000.0),
            tx_fps: Some(500.0),
        };
        let verdicts = check_frontend(&base, &cur, expected);
        let rx = verdicts.iter().find(|v| v.metric == "rx_fps_expected").unwrap();
        let tx = verdicts.iter().find(|v| v.metric == "tx_fps_expected").unwrap();
        assert!(!rx.pass, "700 below the 850 band floor must fail");
        assert!(!tx.pass, "650 above the 575 band ceiling must fail");

        // In band passes.
        cur.rx_fps_overall = 980.0;
        cur.tx_fps_overall = 510.0;
        let verdicts = check_frontend(&base, &cur, expected);
        assert!(
            verdicts
                .iter()
                .filter(|v| v.metric.ends_with("_expected"))
                .all(|v| v.pass),
            "in-band rates pass"
        );
    }
}
