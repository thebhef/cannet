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
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

/// The display refresh budget: a frame is "late" once a synchronous task
/// overruns ~16.7 ms (60 Hz). Long-task time divided by this estimates
/// dropped frames.
const FRAME_BUDGET_MS: f64 = 1000.0 / 60.0;

/// A second is counted as janky once more than this much long-task time
/// accrued in it. The frame budget is ~16.7 ms, so 50 ms is several
/// frames' worth of uninterruptible work — the threshold the browser's
/// own `longtask` entries use, and what a user perceives as a hitch.
const JANK_THRESHOLD_MS: f64 = 50.0;

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
/// the end value — e.g. final buffer size — is meaningful on its own).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GaugeSpread {
    pub mean: f64,
    pub max: f64,
    pub last: f64,
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
    /// Per-counter per-second spread (render / resample / invoke counts).
    pub counters_per_s: BTreeMap<String, Spread>,
    /// Per-gauge spread over the run.
    pub gauges: BTreeMap<String, GaugeSpread>,
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
        let series: Vec<f64> = samples
            .iter()
            .filter_map(|s| s.gauges.get(k).copied())
            .collect();
        let last = samples
            .iter()
            .rev()
            .find_map(|s| s.gauges.get(k).copied())
            .unwrap_or(0.0);
        gauges.insert(
            k.to_string(),
            GaugeSpread {
                mean: mean(&series),
                max: max(&series),
                last,
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
        counters_per_s,
        gauges,
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
pub fn diag_capture_start(state: State<'_, DiagState>, label: String) {
    let mut cap = state.inner.lock().expect("diag mutex poisoned");
    cap.active = true;
    cap.label = label;
    cap.samples.clear();
}

/// Record one per-second sample. Ignored unless a capture is armed, so
/// the frontend can push unconditionally without a round-trip to check.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn diag_push(state: State<'_, DiagState>, sample: DiagSample) {
    let mut cap = state.inner.lock().expect("diag mutex poisoned");
    if cap.active {
        cap.samples.push(sample);
    }
}

/// Disarm, reduce the captured samples to a [`RenderReport`], and — when
/// `path` is given — write it there as pretty JSON.
///
/// # Errors
/// Returns an error if nothing was captured, or if writing `path` fails.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn diag_capture_finish(
    state: State<'_, DiagState>,
    path: Option<String>,
) -> Result<FinishedCapture, String> {
    let (label, samples) = {
        let mut cap = state.inner.lock().expect("diag mutex poisoned");
        cap.active = false;
        (cap.label.clone(), std::mem::take(&mut cap.samples))
    };
    if samples.is_empty() {
        return Err("no diagnostic samples were captured".into());
    }
    let report = summarize(&label, &samples);
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
                _ => {}
            }
        }
        seen.then_some(cfg)
    }
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

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_string()).collect()
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
        ]))
        .expect("flags arm autostart");
        assert_eq!(cfg.project.as_deref(), Some("demo.cannet_prj"));
        assert!(cfg.connect_on_start);
        assert_eq!(cfg.capture_secs, Some(30));
        assert_eq!(cfg.out.as_deref(), Some("out/report.json"));
        assert_eq!(cfg.label.as_deref(), Some("2 plots + 2 traces"));
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
