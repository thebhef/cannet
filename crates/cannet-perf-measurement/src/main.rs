//! `cannet-perf-measurement` — the agent-runnable performance /
//! integration harness.
//!
//! See the crate-level docs in `lib.rs` for the mode model. This binary
//! is the CLI front end.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};

use cannet_perf_measurement::check::{
    self, Baseline, Expected, Metrics, ModeBaseline, BASELINE_VERSION,
};
use cannet_perf_measurement::filter_bench::{self, FilterBenchConfig};
use cannet_perf_measurement::frontend::{self, FrontendBaseline, FrontendMetrics};
use cannet_perf_measurement::grpc::{self, GrpcConfig};
use cannet_perf_measurement::hardware_peak::{self, HardwarePeakConfig};
use cannet_perf_measurement::screenshot;
use cannet_perf_measurement::signal_bench::{self, SignalBenchConfig};
use cannet_perf_measurement::tracebuffer::{self, StoreKind, TracebufferConfig};
use cannet_perf_measurement::upstream::UpstreamSpec;
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
    /// to reading the promoted `baseline.json` there (copy a dated
    /// snapshot over it to promote).
    #[arg(long, global = true)]
    baseline: Option<PathBuf>,
    /// Render report(s) (`RenderReport` JSON) from a self-driving GUI run.
    /// `baseline` stores the (first) one's gated metrics; `check` compares
    /// a fresh set against them. Repeat the flag for a gate of more than
    /// one run (`--frontend-report a.json --frontend-report b.json …`).
    /// With exactly one report `check` judges every metric per-run, as
    /// before; with more than one, the three memory-drift metrics
    /// (`{jsheap,renderer,tree}_mb_drift_per_min`) gate on the **median**
    /// across the given reports instead of each report's own worst value
    /// (ADR 0031) — every other metric stays per-run. Omit to leave the
    /// frontend tier out of the run.
    #[arg(long = "frontend-report", global = true)]
    frontend_report: Vec<PathBuf>,
    /// Expected receive rate (frames/s) for the live sim, gated by `check`
    /// on the frontend tier as a two-sided ±15 % band around this value,
    /// independent of the baseline — the sim's schedule is deterministic,
    /// so too many frames is as wrong as too few. Host modes gate ingest
    /// against their own configured offered rate instead.
    #[arg(long, global = true)]
    expected_rx_fps: Option<f64>,
    /// Expected transmit rate (frames/s) for the live sim, gated on the
    /// frontend tier (the only tier that measures tx separately) as the
    /// same two-sided band.
    #[arg(long, global = true)]
    expected_tx_fps: Option<f64>,
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
    /// Fill a real `TraceStore` and time a deep positional filtered page
    /// three ways — full scan, one-time index build, per-fetch index page
    /// — to characterize the filter index (ADR 0002 DS-3).
    FilterBench(FilterBenchArgs),
    /// Fill a real `TraceStore` and time a whole-span decoded-signal serve
    /// two ways — raw materialize + decimate vs the pyramid serve — to
    /// characterize the per-signal decimation tier (ADR 0002 DS-5).
    SignalBench(SignalBenchArgs),
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
    /// Launch the shipping GUI on a project, walk the visual-parity
    /// scenario, and write one PNG per step. Windows only (the capture
    /// needs `WebView2`'s `DevTools` protocol).
    Screenshot(ScreenshotArgs),
    /// Pixel-diff two capture sets (or two single PNGs) and report how
    /// many pixels moved; exit non-zero past `--max-diff-pct`.
    ScreenshotDiff(ScreenshotDiffArgs),
}

#[derive(Args)]
struct ScreenshotArgs {
    /// The GUI binary to photograph — a build with the frontend embedded
    /// (`pnpm --dir apps/gui tauri build --no-bundle`). Absolute.
    #[arg(long)]
    gui_binary: PathBuf,
    /// Project to open. Absolute — the child's working directory is not
    /// the repo root.
    #[arg(long)]
    project: PathBuf,
    /// Which scenario to walk: `panels` (the visual-parity walk over an
    /// idle app) or `extrapolation` (import a capture and photograph the
    /// plot drawing its extrapolated stretches — needs `--capture`).
    #[arg(long, default_value = "panels")]
    scenario: String,
    /// A capture the run seeds into its own profile's recents, so a
    /// scenario can open it from the toolbar's Recent menu instead of
    /// the native file dialog a page cannot reach. Absolute. Required by
    /// `--scenario extrapolation`; unused by `panels`, which
    /// deliberately photographs an app with no data in it.
    #[arg(long)]
    capture: Option<PathBuf>,
    /// Directory the PNGs land in (created if absent). Absolute.
    #[arg(long)]
    out_dir: PathBuf,
    /// Prefix on every file name, e.g. `dark-baseline-`.
    #[arg(long, default_value = "")]
    prefix: String,
    /// `DevTools` port opened on the child's `WebView2`.
    #[arg(long, default_value_t = 9333)]
    port: u16,
    /// Emulated viewport width / height (pinned so the restored OS window
    /// geometry can't move a pixel).
    #[arg(long, default_value_t = 1600)]
    width: u32,
    #[arg(long, default_value_t = 1000)]
    height: u32,
    /// Seconds to wait for the splash overlay to drop.
    #[arg(long, default_value_t = 90)]
    boot_timeout_secs: u64,
    /// Directory this run's whole user scope is redirected into, so the
    /// capture neither reads nor writes the operator's own settings,
    /// recents, trust store or window geometry. Absent ⇒ a
    /// `cannet-screenshot-<theme>` directory beside `--out-dir`.
    #[arg(long)]
    app_data_dir: Option<PathBuf>,
    /// Theme to photograph in — `dark`, `light` or `lighthk`. Seeded
    /// into the isolated profile, which is where the app reads it from.
    #[arg(long, default_value = "dark")]
    theme: String,
}

#[derive(Args)]
struct ScreenshotDiffArgs {
    /// The "before" PNG, or a directory of them.
    #[arg(long)]
    before: PathBuf,
    /// The "after" PNG, or a directory of them.
    #[arg(long)]
    after: PathBuf,
    /// Where the magenta-marked diff artifacts are written. Defaults to
    /// `<after>/diff` for a directory pair, `<after>.diff.png` for files.
    #[arg(long)]
    diff_out: Option<PathBuf>,
    /// File-name prefix to strip when pairing a `before`/`after`
    /// directory whose captures were written with different prefixes.
    #[arg(long, default_value = "")]
    before_prefix: String,
    #[arg(long, default_value = "")]
    after_prefix: String,
    /// Fail past this share of differing pixels (per capture).
    #[arg(long, default_value_t = 0.0)]
    max_diff_pct: f64,
}

#[derive(Args)]
struct TracebufferArgs {
    /// Store backend to drive: `mem` (in-RAM, current production) or
    /// `disk` (the disk-spill store, ADR 0002).
    #[arg(long, default_value = "mem")]
    store: String,
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
    /// Measure through a locally spawned production `cannet-server` (this
    /// binary, absolute path) instead of dialling the sidecar directly:
    /// the server supervises its own sidecar and proxies it, so the run
    /// differs only by the proxy hop. Omit for the direct path — the one
    /// `baseline` / `check` use.
    #[arg(long)]
    via_server: Option<PathBuf>,
}

impl HardwarePeakArgs {
    fn upstream(&self) -> UpstreamSpec {
        UpstreamSpec::from_server_binary(self.via_server.clone())
    }

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

#[derive(Args)]
struct FilterBenchArgs {
    /// Store backend: `mem` or `disk`.
    #[arg(long, default_value = "disk")]
    store: String,
    /// Frames to fill before measuring.
    #[arg(long, default_value_t = 200_000)]
    frames: usize,
    /// Predicate to filter by (JSON; must be id-narrowable, no decode).
    #[arg(long, default_value = "{\"bus\":\"pt\"}")]
    predicate: String,
    /// Match-position offset of the page to fetch (use a deep one).
    #[arg(long, default_value_t = 50_000)]
    offset: usize,
    /// Page size.
    #[arg(long, default_value_t = 50)]
    limit: usize,
}

#[derive(Args)]
struct SignalBenchArgs {
    /// Store backend: `mem` or `disk`.
    #[arg(long, default_value = "disk")]
    store: String,
    /// Frames to fill before measuring.
    #[arg(long, default_value_t = 200_000)]
    frames: usize,
    /// Point budget the whole-span serve targets.
    #[arg(long, default_value_t = 2_000)]
    max_points: usize,
}

impl SignalBenchArgs {
    fn into_config(self) -> Result<SignalBenchConfig, String> {
        let store = match self.store.as_str() {
            "mem" => StoreKind::Mem,
            "disk" => StoreKind::Disk,
            other => return Err(format!("invalid --store {other:?} (expected mem|disk)")),
        };
        Ok(SignalBenchConfig {
            store,
            frames: self.frames,
            max_points: self.max_points,
        })
    }
}

impl FilterBenchArgs {
    fn into_config(self) -> Result<FilterBenchConfig, String> {
        let store = match self.store.as_str() {
            "mem" => StoreKind::Mem,
            "disk" => StoreKind::Disk,
            other => return Err(format!("invalid --store {other:?} (expected mem|disk)")),
        };
        Ok(FilterBenchConfig {
            store,
            frames: self.frames,
            predicate: serde_json::from_str(&self.predicate)
                .map_err(|e| format!("invalid --predicate JSON: {e}"))?,
            offset: self.offset,
            limit: self.limit,
        })
    }
}

impl TracebufferArgs {
    fn into_config(self) -> Result<TracebufferConfig, String> {
        let store = match self.store.as_str() {
            "mem" => StoreKind::Mem,
            "disk" => StoreKind::Disk,
            other => return Err(format!("invalid --store {other:?} (expected mem|disk)")),
        };
        Ok(TracebufferConfig {
            store,
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
        Command::FilterBench(args) => run_filter_bench(&dir, args),
        Command::SignalBench(args) => run_signal_bench(&dir, args),
        Command::Grpc(args) => run_grpc(&dir, args),
        Command::HardwarePeak(args) => run_hardware_peak(&dir, args),
        Command::Baseline => run_baseline(&dir, cli.baseline, &cli.frontend_report),
        Command::Check => run_check(
            &dir,
            cli.baseline,
            &cli.frontend_report,
            Expected {
                rx_fps: cli.expected_rx_fps,
                tx_fps: cli.expected_tx_fps,
            },
        ),
        Command::Screenshot(args) => run_screenshot(args),
        Command::ScreenshotDiff(args) => run_screenshot_diff(&args),
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
    frontend_reports: &[PathBuf],
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
    // The captured — and therefore gated — hardware path is the direct
    // one; `hardware-peak --via-server` is a comparison run, not a gate.
    let hw_rep = hardware_peak::run(&ex, &hw_cfg, &UpstreamSpec::Sidecar);
    if let Err(e) = &hw_rep {
        eprintln!("  hardware-peak skipped: {e}");
    }

    if frontend_reports.len() > 1 {
        eprintln!(
            "note: baseline captures a single snapshot — using the first of {} \
             --frontend-report values given",
            frontend_reports.len()
        );
    }
    let frontend = if let Some(p) = frontend_reports.first() {
        eprintln!("capturing frontend from {}…", p.display());
        let report = frontend::load_report(p)?;
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
    frontend_reports: &[PathBuf],
    expected: Expected,
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

    // Host modes are gated *relative to their baseline* — their real
    // expectation. They're transport-limited stress runs that don't reach
    // their nominal offered rate (e.g. grpc sustains ~3.1k against an
    // offered 5k), so an absolute "expected" floor doesn't fit them. The
    // CLI `--expected-*` band describes the live ev-demo sim, whose
    // schedule rate is deterministic, and gates only the frontend tier.
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
        match hardware_peak::run(&ex, &mb.config, &UpstreamSpec::Sidecar) {
            Ok(rep) => verdicts.extend(check::check_mode("hardware-peak", &mb.metrics, &rep)),
            Err(e) => skipped.push(("hardware-peak", e)),
        }
    }
    if let Some(fb) = &baseline.frontend {
        // The harness can't re-run the frontend; fresh report(s) must be
        // supplied. Without one, the tier is skipped, not failed. With more
        // than one, the drift family gates on their median rather than
        // each report's own worst run (ADR 0031) — `check_frontend_gate`
        // is exactly `check_frontend` for a single report.
        if frontend_reports.is_empty() {
            skipped.push(("frontend", "no --frontend-report supplied".to_string()));
        } else {
            let mut currents = Vec::with_capacity(frontend_reports.len());
            for p in frontend_reports {
                currents.push(FrontendMetrics::from(&frontend::load_report(p)?));
            }
            verdicts.extend(frontend::check_frontend_gate(
                &fb.metrics,
                &currents,
                expected,
            ));
        }
    } else if !frontend_reports.is_empty() {
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

fn run_filter_bench(dir: &std::path::Path, args: FilterBenchArgs) -> Result<ExitCode, String> {
    let ex = load_example(dir)?;
    let cfg = args.into_config()?;
    let report = filter_bench::run(&ex, &cfg);
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(ExitCode::SUCCESS)
}

fn run_signal_bench(dir: &std::path::Path, args: SignalBenchArgs) -> Result<ExitCode, String> {
    let ex = load_example(dir)?;
    let cfg = args.into_config()?;
    let report = signal_bench::run(&ex, &cfg);
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
    let upstream = args.upstream();
    let cfg = args.into_config()?;
    let report = hardware_peak::run(&ex, &cfg, &upstream)?;
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

fn run_screenshot(args: ScreenshotArgs) -> Result<ExitCode, String> {
    // Defaulted beside the output rather than under the operator's
    // config directory: a capture's profile is an artifact of the run,
    // and it must be somewhere a wipe is obviously safe.
    let app_data_dir = args.app_data_dir.unwrap_or_else(|| {
        args.out_dir
            .join(format!("cannet-screenshot-{}", args.theme))
    });
    let steps = screenshot::scenario_by_name(&args.scenario)?;
    // Refused up front rather than at the click: a scenario that opens a
    // capture aborts at its first step without one, minutes into a run
    // that has already launched the app.
    if std::ptr::eq(steps, screenshot::EXTRAPOLATION_SCENARIO) && args.capture.is_none() {
        return Err(format!(
            "--scenario {} opens a capture, so it needs --capture <trace file>",
            args.scenario
        ));
    }
    let cfg = screenshot::CaptureConfig {
        gui_binary: args.gui_binary,
        project: args.project,
        steps,
        capture: args.capture,
        out_dir: args.out_dir,
        prefix: args.prefix,
        port: args.port,
        width: args.width,
        height: args.height,
        boot_timeout: std::time::Duration::from_secs(args.boot_timeout_secs),
        app_data_dir,
        theme: args.theme,
    };
    let out = screenshot::run_capture(&cfg)?;
    println!("{} captures written", out.files.len());
    Ok(ExitCode::SUCCESS)
}

/// Diff a capture pair (two PNGs) or two capture sets (two directories).
/// Every pair's numbers are printed; the exit code is the verdict over
/// the whole set.
fn run_screenshot_diff(args: &ScreenshotDiffArgs) -> Result<ExitCode, String> {
    let pairs: Vec<(PathBuf, PathBuf, String, PathBuf)> = if args.before.is_dir() {
        let out_dir = args
            .diff_out
            .clone()
            .unwrap_or_else(|| args.after.join("diff"));
        std::fs::create_dir_all(&out_dir)
            .map_err(|e| format!("creating {}: {e}", out_dir.display()))?;
        screenshot::pair_names(
            &screenshot::png_names(&args.before)?,
            &screenshot::png_names(&args.after)?,
            &args.before_prefix,
            &args.after_prefix,
        )?
        .into_iter()
        .map(|(b, a, step)| {
            let artifact = out_dir.join(format!("diff-{step}"));
            (args.before.join(b), args.after.join(a), step, artifact)
        })
        .collect()
    } else {
        let artifact = args.diff_out.clone().unwrap_or_else(|| {
            let mut p = args.after.clone();
            p.set_extension("diff.png");
            p
        });
        let step = args.after.file_name().map_or_else(
            || "capture".to_string(),
            |n| n.to_string_lossy().into_owned(),
        );
        vec![(args.before.clone(), args.after.clone(), step, artifact)]
    };

    let mut worst = 0.0_f64;
    let mut total_differing = 0u64;
    for (before, after, step, artifact) in &pairs {
        let d = screenshot::diff_files(before, after, artifact)?;
        total_differing += d.differing;
        worst = worst.max(d.percent());
        println!(
            "{step:<28} {}x{}  differing {:>9} / {:<9} ({:.6} %)  max Δchannel {}",
            d.width,
            d.height,
            d.differing,
            d.total,
            d.percent(),
            d.max_channel_delta
        );
    }
    println!(
        "{} pairs compared; {total_differing} differing pixels in total; worst {worst:.6} % (limit {:.6} %)",
        pairs.len(),
        args.max_diff_pct
    );
    Ok(if worst > args.max_diff_pct {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}
