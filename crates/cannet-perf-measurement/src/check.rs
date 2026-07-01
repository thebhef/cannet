//! Baseline capture and regression checking.
//!
//! `baseline` runs every mode and writes their configs + metrics to a
//! JSON file; `check` re-runs each captured mode with its own config and
//! compares, failing (non-zero exit) if any gated metric has regressed
//! past its tolerance. The baseline is **environment-relative** —
//! absolute throughput and scan time scale with the host CPU (and, for
//! the hardware mode, the adapters) — so the workflow is: capture a
//! baseline on a machine, then `check` on that machine detects drift.
//! The committed baseline is a reference shape; regenerate it for your
//! own host before trusting the absolute numbers.

use serde::{Deserialize, Serialize};

use crate::grpc::GrpcConfig;
use crate::hardware_peak::HardwarePeakConfig;
use crate::runner::HarnessReport;
use crate::tracebuffer::TracebufferConfig;

/// Bumped only on a *breaking* shape change — a field removed or
/// renamed, or a gated metric's meaning changed — which rejects older
/// files rather than migrating them. Purely additive optional fields that
/// default when absent (e.g. `frontend`) are not breaking and land
/// without a bump, so existing baselines keep checking (ADR 0011).
pub const BASELINE_VERSION: u32 = 2;

/// The metric subset persisted and compared, the same for every mode.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metrics {
    pub ingest_fps_overall: f64,
    pub fps_retention: f64,
    pub append_ms_max: f64,
    pub scan_ms_max: f64,
}

impl From<&HarnessReport> for Metrics {
    fn from(r: &HarnessReport) -> Self {
        Self {
            ingest_fps_overall: r.ingest_fps_overall,
            fps_retention: r.fps_retention,
            append_ms_max: r.append_ms_max,
            scan_ms_max: r.scan_ms_max,
        }
    }
}

/// One mode's captured config + metrics. The config is stored so `check`
/// re-runs with exactly the parameters the baseline was taken under.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModeBaseline<C> {
    pub config: C,
    pub metrics: Metrics,
}

/// A captured baseline: one optional block per mode (a mode is absent if
/// it couldn't run at capture — e.g. hardware not connected), plus the
/// schema tag so a stale file is rejected rather than mis-compared.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Baseline {
    pub baseline_version: u32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tracebuffer: Option<ModeBaseline<TracebufferConfig>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub grpc: Option<ModeBaseline<GrpcConfig>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub hardware_peak: Option<ModeBaseline<HardwarePeakConfig>>,
    /// Render-tier metrics from a self-driving GUI run, supplied via
    /// `--frontend-report` (the harness can't generate them). Absent when
    /// no report was given at capture.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frontend: Option<crate::frontend::FrontendBaseline>,
}

/// Gating tolerances. Relative where the metric scales with the host
/// (throughput, scan time); absolute floors absorb scheduler jitter.
pub mod tol {
    /// Ingest throughput may not drop below this fraction of baseline.
    pub const INGEST_FPS_MIN_FRACTION: f64 = 0.85;
    /// FPS retention may not drop below this fraction of baseline …
    pub const RETENTION_MIN_FRACTION: f64 = 0.90;
    /// … nor below this absolute floor (ingest must not be starved).
    pub const RETENTION_ABS_FLOOR: f64 = 0.80;
    /// Latency metrics may grow at most this multiple of baseline …
    pub const LATENCY_MAX_FACTOR: f64 = 2.0;
    /// … plus this floor (ms), so tiny baselines don't false-trip.
    pub const LATENCY_FLOOR_MS: f64 = 5.0;
    /// Half-width of the band a measured rate must stay inside, around
    /// the operator-supplied *expected* rate ([`Expected`]). The sim emits
    /// a deterministic schedule, so the steady-state average is known:
    /// **too few _or_ too many frames is wrong**, so this gates both sides,
    /// not just a floor. ±15 % absorbs connect ramp-up and rate-estimator
    /// smoothing while still catching the diagnosed ~20 % shortfall (and a
    /// runaway/duplication overshoot).
    pub const EXPECTED_FPS_BAND: f64 = 0.15;
}

/// Operator-supplied absolute throughput expectations for the sim, handed
/// to `check` on the command line (not stored in the baseline, which is
/// host-relative). A measured rate below
/// `expected * `[`tol::EXPECTED_FPS_MIN_FRACTION`] gates independently of
/// the baseline comparison — so a uniformly-slow run is caught even when
/// it hasn't *regressed* against a slow baseline. `None` leaves that
/// direction ungated. RX applies to every tier; TX only to tiers that
/// measure it separately (the frontend), since the host modes track a
/// single ingest rate.
#[derive(Debug, Clone, Copy, Default)]
pub struct Expected {
    pub rx_fps: Option<f64>,
    pub tx_fps: Option<f64>,
}

/// One metric's verdict within a mode.
pub struct Verdict {
    pub mode: &'static str,
    pub metric: &'static str,
    pub baseline: f64,
    pub current: f64,
    pub limit: f64,
    pub pass: bool,
}

/// Verdict for a two-sided expected-rate band: `measured` must land within
/// `±`[`tol::EXPECTED_FPS_BAND`] of `expected`. A deterministic sim emits a
/// known average, so both a shortfall (frames dropped / stalled) and an
/// overshoot (duplication / runaway) are failures. The `baseline` column
/// carries the expected target; `limit` carries the violated edge (the
/// lower edge when in band, for reference).
#[must_use]
pub fn expected_band_verdict(
    mode: &'static str,
    metric: &'static str,
    measured: f64,
    expected: f64,
) -> Verdict {
    let lo = expected * (1.0 - tol::EXPECTED_FPS_BAND);
    let hi = expected * (1.0 + tol::EXPECTED_FPS_BAND);
    let (limit, pass) = if measured < lo {
        (lo, false)
    } else if measured > hi {
        (hi, false)
    } else {
        (lo, true)
    };
    Verdict {
        mode,
        metric,
        baseline: expected,
        current: measured,
        limit,
        pass,
    }
}

/// Compare a mode's fresh report against its baseline metrics.
#[must_use]
pub fn check_mode(mode: &'static str, baseline: &Metrics, current: &HarnessReport) -> Vec<Verdict> {
    let mut verdicts = Vec::new();

    // Higher-is-better, relative-to-baseline floors.
    let ingest_limit = baseline.ingest_fps_overall * tol::INGEST_FPS_MIN_FRACTION;
    verdicts.push(Verdict {
        mode,
        metric: "ingest_fps_overall",
        baseline: baseline.ingest_fps_overall,
        current: current.ingest_fps_overall,
        limit: ingest_limit,
        pass: current.ingest_fps_overall >= ingest_limit,
    });

    let retention_limit =
        (baseline.fps_retention * tol::RETENTION_MIN_FRACTION).min(tol::RETENTION_ABS_FLOOR);
    verdicts.push(Verdict {
        mode,
        metric: "fps_retention",
        baseline: baseline.fps_retention,
        current: current.fps_retention,
        limit: retention_limit,
        pass: current.fps_retention >= retention_limit,
    });

    // Lower-is-better, relative-to-baseline ceilings.
    for (metric, base, cur) in [
        ("append_ms_max", baseline.append_ms_max, current.append_ms_max),
        ("scan_ms_max", baseline.scan_ms_max, current.scan_ms_max),
    ] {
        let limit = base * tol::LATENCY_MAX_FACTOR + tol::LATENCY_FLOOR_MS;
        verdicts.push(Verdict {
            mode,
            metric,
            baseline: base,
            current: cur,
            limit,
            pass: cur <= limit,
        });
    }

    verdicts
}
