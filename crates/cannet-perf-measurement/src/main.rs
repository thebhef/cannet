//! `cannet-perf-measurement` — the agent-runnable performance /
//! integration harness.
//!
//! See the crate-level docs in `lib.rs` for the mode model. This binary
//! is the CLI front end.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};

use cannet_perf_measurement::check::{
    self, Baseline, Metrics, ModeBaseline, BASELINE_VERSION,
};
use cannet_perf_measurement::frontend::{self, FrontendBaseline, FrontendMetrics};
use cannet_perf_measurement::grpc::{self, GrpcConfig};
use cannet_perf_measurement::hardware_peak::{self, HardwarePeakConfig};
use cannet_perf_measurement::tracebuffer::{self, TracebufferConfig};
use cannet_perf_measurement::{
    default_baseline_path, default_example_dir, default_measurements_dir, load_example,
    measurement_filename, workload,
};

#[derive(Parser)]
#[command(
    name = "cannet-perf-measurement",
    about = "cannet performance / integration harness"
)]
struct Cli {
    /// Example project directory (defaults to examples/ev-demo).
    #[arg(long, global = true)]
    example: Option<PathBuf>,
    /// Explicit baseline file. `baseline` defaults to writing a new
    /// dated file under docs/performance-measurements/; `check` defaults
    /// to reading the newest file there.
    #[arg(long, global = true)]
    baseline: Option<PathBuf>,
    /// Render report (`RenderReport` JSON) from a self-driving GUI run.
    /// `baseline` stores its gated metrics; `check` compares a fresh one
    /// against them. Omit to leave the frontend tier out of the run.
    #[arg(long, global = true)]
    frontend_report: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Load the example, validate it against the real parsers, and print
    /// the schedule it would replay.
    Validate,
    /// Drive frames into a real `TraceStore` in-process while a filtered
    /// scan contends, and print the metrics as JSON.
    Tracebuffer(TracebufferArgs),
    /// Drive frames over the real gRPC wire through an in-process virtual
    /// bus into the model, and print the metrics as JSON.
    Grpc(GrpcArgs),
    /// Drive the workload over real PEAK hardware via the python-can
    /// sidecar, and print the metrics as JSON. Needs hardware.
    HardwarePeak(HardwarePeakArgs),
    /// Run every mode at its defaults and write configs + metrics to the
    /// baseline file (modes that can't run — e.g. no hardware — are
    /// omitted).
    Baseline,
    /// Re-run each captured mode with its baseline config and compare;
    /// exit non-zero if any gated metric has regressed past tolerance.
    /// Modes that can't run are skipped, not failed.
    Check,
}

#[derive(Args)]
struct TracebufferArgs {
    /// Stop once the buffer reaches this many frames.
    #[arg(long, default_value_t = 200_000)]
    target_frames: usize,
    /// Ingest pace in frames/s (0 = flat-out / uncapped).
    #[arg(long, default_value_t = 25_000.0)]
    ingest_hz: f64,
    /// Skip the contending scan (ingest-only control run).
    #[arg(long)]
    no_scan: bool,
    /// Target full-scan rate in Hz. 0 = continuous (max contention).
    #[arg(long, default_value_t = 8.0)]
    scan_hz: f64,
    /// Filter predicate the scan evaluates, as JSON.
    #[arg(long, default_value = "{\"bus\":\"pt\"}")]
    predicate: String,
}

#[derive(Args)]
struct GrpcArgs {
    /// Stop once the receiver has stored this many frames.
    #[arg(long, default_value_t = 50_000)]
    target_frames: usize,
    /// Transmit pace in frames/s (0 = flat-out).
    #[arg(long, default_value_t = 5_000.0)]
    tx_hz: f64,
    /// Skip the contending scan.
    #[arg(long)]
    no_scan: bool,
    /// Target full-scan rate in Hz. 0 = continuous.
    #[arg(long, default_value_t = 8.0)]
    scan_hz: f64,
    /// Filter predicate the scan evaluates, as JSON.
    #[arg(long, default_value = "{\"bus\":\"pt\"}")]
    predicate: String,
}

impl GrpcArgs {
    fn into_config(self) -> Result<GrpcConfig, String> {
        Ok(GrpcConfig {
            target_frames: self.target_frames,
            tx_hz: self.tx_hz,
            scan: !self.no_scan,
            scan_hz: self.scan_hz,
            predicate: serde_json::from_str(&self.predicate)
                .map_err(|e| format!("invalid --predicate JSON: {e}"))?,
        })
    }
}

#[derive(Args)]
struct HardwarePeakArgs {
    /// Stop once the receiver has stored this many frames.
    #[arg(long, default_value_t = 20_000)]
    target_frames: usize,
    /// Transmit pace in frames/s (0 = flat-out).
    #[arg(long, default_value_t = 1_000.0)]
    tx_hz: f64,
    /// Bus bit rate (bps) to configure the PEAK interfaces at.
    #[arg(long, default_value_t = 500_000)]
    speed_bps: u64,
    /// Skip the contending scan.
    #[arg(long)]
    no_scan: bool,
    /// Target full-scan rate in Hz. 0 = continuous.
    #[arg(long, default_value_t = 8.0)]
    scan_hz: f64,
    /// Filter predicate the scan evaluates, as JSON.
    #[arg(long, default_value = "{\"bus\":\"pt\"}")]
    predicate: String,
}

impl HardwarePeakArgs {
    fn into_config(self) -> Result<HardwarePeakConfig, String> {
        Ok(HardwarePeakConfig {
            target_frames: self.target_frames,
            tx_hz: self.tx_hz,
            speed_bps: self.speed_bps,
            scan: !self.no_scan,
            scan_hz: self.scan_hz,
            predicate: serde_json::from_str(&self.predicate)
                .map_err(|e| format!("invalid --predicate JSON: {e}"))?,
        })
    }
}

impl TracebufferArgs {
    fn into_config(self) -> Result<TracebufferConfig, String> {
        Ok(TracebufferConfig {
            target_frames: self.target_frames,
            ingest_hz: self.ingest_hz,
            scan: !self.no_scan,
            scan_hz: self.scan_hz,
            predicate: serde_json::from_str(&self.predicate)
                .map_err(|e| format!("invalid --predicate JSON: {e}"))?,
        })
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let dir = cli.example.unwrap_or_else(default_example_dir);

    let result = match cli.command {
        Command::Validate => run_validate(&dir),
        Command::Tracebuffer(args) => run_tracebuffer(&dir, args),
        Command::Grpc(args) => run_grpc(&dir, args),
        Command::HardwarePeak(args) => run_hardware_peak(&dir, args),
        Command::Baseline => run_baseline(&dir, cli.baseline, cli.frontend_report),
        Command::Check => run_check(&dir, cli.baseline, cli.frontend_report),
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run_baseline(
    dir: &std::path::Path,
    out: Option<PathBuf>,
    frontend_report: Option<PathBuf>,
) -> Result<ExitCode, String> {
    let baseline_path = if let Some(p) = out {
        p
    } else {
        let mdir = default_measurements_dir();
        std::fs::create_dir_all(&mdir).map_err(|e| format!("creating {}: {e}", mdir.display()))?;
        mdir.join(measurement_filename())
    };
    let ex = load_example(dir)?;

    eprintln!("capturing tracebuffer…");
    let tb_cfg = TracebufferConfig::default();
    let tb = tracebuffer::run(&ex, &tb_cfg);

    eprintln!("capturing grpc…");
    let grpc_cfg = GrpcConfig::default();
    let grpc_rep = grpc::run(&ex, &grpc_cfg);
    if let Err(e) = &grpc_rep {
        eprintln!("  grpc skipped: {e}");
    }

    eprintln!("capturing hardware-peak…");
    let hw_cfg = HardwarePeakConfig::default();
    let hw_rep = hardware_peak::run(&ex, &hw_cfg);
    if let Err(e) = &hw_rep {
        eprintln!("  hardware-peak skipped: {e}");
    }

    let frontend = if let Some(p) = frontend_report {
        eprintln!("capturing frontend from {}…", p.display());
        let report = frontend::load_report(&p)?;
        Some(FrontendBaseline {
            label: report.label.clone(),
            metrics: FrontendMetrics::from(&report),
        })
    } else {
        eprintln!("frontend skipped: no --frontend-report given");
        None
    };

    let baseline = Baseline {
        baseline_version: BASELINE_VERSION,
        tracebuffer: Some(ModeBaseline {
            config: tb_cfg,
            metrics: Metrics::from(&tb),
        }),
        grpc: grpc_rep.ok().map(|r| ModeBaseline {
            config: grpc_cfg,
            metrics: Metrics::from(&r),
        }),
        hardware_peak: hw_rep.ok().map(|r| ModeBaseline {
            config: hw_cfg,
            metrics: Metrics::from(&r),
        }),
        frontend,
    };
    let text = serde_json::to_string_pretty(&baseline).map_err(|e| e.to_string())?;
    std::fs::write(&baseline_path, text + "\n").map_err(|e| e.to_string())?;
    eprintln!("wrote baseline to {}", baseline_path.display());
    Ok(ExitCode::SUCCESS)
}

fn run_check(
    dir: &std::path::Path,
    explicit: Option<PathBuf>,
    frontend_report: Option<PathBuf>,
) -> Result<ExitCode, String> {
    let baseline_path = explicit.unwrap_or_else(default_baseline_path);
    if !baseline_path.exists() {
        return Err(format!(
            "no baseline at {} — capture one with `baseline` and promote it (copy the dated \
             snapshot to baseline.json)",
            baseline_path.display()
        ));
    }
    let text = std::fs::read_to_string(&baseline_path)
        .map_err(|e| format!("reading baseline {}: {e}", baseline_path.display()))?;
    let baseline: Baseline = serde_json::from_str(&text)
        .map_err(|e| format!("parsing baseline {}: {e}", baseline_path.display()))?;
    if baseline.baseline_version != BASELINE_VERSION {
        return Err(format!(
            "baseline version {}; this build expects {BASELINE_VERSION} — regenerate with `baseline`",
            baseline.baseline_version
        ));
    }

    let ex = load_example(dir)?;
    let mut verdicts = Vec::new();
    let mut skipped: Vec<(&str, String)> = Vec::new();

    if let Some(mb) = &baseline.tracebuffer {
        let rep = tracebuffer::run(&ex, &mb.config);
        verdicts.extend(check::check_mode("tracebuffer", &mb.metrics, &rep));
    }
    if let Some(mb) = &baseline.grpc {
        match grpc::run(&ex, &mb.config) {
            Ok(rep) => verdicts.extend(check::check_mode("grpc", &mb.metrics, &rep)),
            Err(e) => skipped.push(("grpc", e)),
        }
    }
    if let Some(mb) = &baseline.hardware_peak {
        match hardware_peak::run(&ex, &mb.config) {
            Ok(rep) => verdicts.extend(check::check_mode("hardware-peak", &mb.metrics, &rep)),
            Err(e) => skipped.push(("hardware-peak", e)),
        }
    }
    if let Some(fb) = &baseline.frontend {
        // The harness can't re-run the frontend; a fresh report must be
        // supplied. Without one, the tier is skipped, not failed.
        match frontend_report {
            Some(p) => {
                let current = FrontendMetrics::from(&frontend::load_report(&p)?);
                verdicts.extend(frontend::check_frontend(&fb.metrics, &current));
            }
            None => skipped.push(("frontend", "no --frontend-report supplied".to_string())),
        }
    } else if frontend_report.is_some() {
        eprintln!("note: --frontend-report ignored (baseline has no frontend block)");
    }

    println!(
        "{:<14} {:<20} {:>12} {:>12} {:>12}  result",
        "mode", "metric", "baseline", "current", "limit"
    );
    for v in &verdicts {
        println!(
            "{:<14} {:<20} {:>12.3} {:>12.3} {:>12.3}  {}",
            v.mode,
            v.metric,
            v.baseline,
            v.current,
            v.limit,
            if v.pass { "ok" } else { "REGRESSED" }
        );
    }
    for (mode, e) in &skipped {
        eprintln!("{mode}: skipped — {e}");
    }

    if verdicts.iter().all(|v| v.pass) {
        eprintln!("check passed ({} metrics gated)", verdicts.len());
        Ok(ExitCode::SUCCESS)
    } else {
        eprintln!("check FAILED — a gated metric regressed past tolerance");
        Ok(ExitCode::FAILURE)
    }
}

fn run_tracebuffer(dir: &std::path::Path, args: TracebufferArgs) -> Result<ExitCode, String> {
    let ex = load_example(dir)?;
    let cfg = args.into_config()?;
    let report = tracebuffer::run(&ex, &cfg);
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(ExitCode::SUCCESS)
}

fn run_grpc(dir: &std::path::Path, args: GrpcArgs) -> Result<ExitCode, String> {
    let ex = load_example(dir)?;
    let cfg = args.into_config()?;
    let report = grpc::run(&ex, &cfg)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(ExitCode::SUCCESS)
}

fn run_hardware_peak(dir: &std::path::Path, args: HardwarePeakArgs) -> Result<ExitCode, String> {
    let ex = load_example(dir)?;
    let cfg = args.into_config()?;
    let report = hardware_peak::run(&ex, &cfg)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(ExitCode::SUCCESS)
}

fn run_validate(dir: &std::path::Path) -> Result<ExitCode, String> {
    let ex = load_example(dir)?;
    ex.check_rbs_against_dbcs()?;
    let schedule = workload::build_schedule(&ex);
    println!(
        "loaded {} ({} buses, {} DBCs, {} scheduled messages)",
        dir.display(),
        ex.project.buses.len(),
        ex.dbcs.len(),
        schedule.len()
    );
    for m in &schedule {
        println!(
            "  bus={:<10} ch={} id=0x{:X}{} period={:>4}ms len={}",
            m.bus_name,
            m.channel,
            m.can_id,
            if m.extended { "x" } else { "" },
            m.period_ms,
            m.payload.len()
        );
    }
    println!(
        "aggregate steady-state rate: {:.1} frames/s",
        workload::aggregate_rate_hz(&schedule)
    );
    Ok(ExitCode::SUCCESS)
}
