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

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::check::Verdict;

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

/// The frontend `RenderReport` as the harness reads it: the gating subset
/// plus a little context for the printout. Extra fields (counters,
/// gauges, per-frame detail) are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct FrontendReport {
    pub label: String,
    pub duration_s: f64,
    pub sample_count: usize,
    longtask_ms_per_s: LongTaskFields,
    lag_ms: LagFields,
    pub jank_fraction: f64,
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
}

impl From<&FrontendReport> for FrontendMetrics {
    fn from(r: &FrontendReport) -> Self {
        Self {
            longtask_ms_per_s_mean: r.longtask_ms_per_s.mean,
            longtask_ms_per_s_p95: r.longtask_ms_per_s.p95,
            lag_ms_max: r.lag_ms.max,
            jank_fraction: r.jank_fraction,
        }
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
}

/// Compare a fresh frontend report's metrics against the baseline's.
#[must_use]
pub fn check_frontend(baseline: &FrontendMetrics, current: &FrontendMetrics) -> Vec<Verdict> {
    [
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
    .collect()
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
    }

    fn metrics(longtask_mean: f64, p95: f64, lag_max: f64, jank: f64) -> FrontendMetrics {
        FrontendMetrics {
            longtask_ms_per_s_mean: longtask_mean,
            longtask_ms_per_s_p95: p95,
            lag_ms_max: lag_max,
            jank_fraction: jank,
        }
    }

    #[test]
    fn within_tolerance_passes() {
        let base = metrics(1.0, 12.0, 27.0, 0.03);
        // Each metric grows but stays under `base * 2 + floor`.
        let cur = metrics(10.0, 38.0, 70.0, 0.1);
        let verdicts = check_frontend(&base, &cur);
        assert_eq!(verdicts.len(), 4);
        assert!(verdicts.iter().all(|v| v.pass), "all within tolerance");
    }

    #[test]
    fn a_regressed_metric_fails_only_itself() {
        let base = metrics(1.0, 12.0, 27.0, 0.03);
        // jank blows past 0.03 * 2 + 0.05 = 0.11; the others stay in band.
        let cur = metrics(1.5, 13.0, 30.0, 0.5);
        let verdicts = check_frontend(&base, &cur);
        let jank = verdicts.iter().find(|v| v.metric == "jank_fraction").unwrap();
        assert!(!jank.pass, "jank regressed");
        assert!(
            verdicts.iter().filter(|v| v.metric != "jank_fraction").all(|v| v.pass),
            "only jank should fail"
        );
    }
}
