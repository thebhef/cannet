//! `cannet-server` CLI.
//!
//! Bare invocation is the production hardware proxy (ADR 0040): it
//! supervises the `cannet-python-can` sidecar on loopback and relays
//! the sidecar's interfaces, under their real identities, to one
//! network endpoint.
//!
//! `debug replay <blf>` and `debug vbus` are the prior BLF-replay and
//! `--virtual-bus` modes, kept as explicitly dev/test tooling: replay
//! serves a BLF file on a loop over the gRPC wire protocol defined in
//! `cannet-wire`, and vbus (ADR 0021) hosts a multi-client virtual CAN
//! bus.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cannet_core::BusConfig;
use cannet_server::{
    CannetServerImpl, LoopingBlfReplay, ProxyServerImpl, VirtualBusServerImpl,
    VIRTUAL_BUS_FACTORY_ID,
};
use cannet_sidecar::{
    LogLevel, SidecarConfig, SidecarHost, SidecarPhase, SidecarStatus, SidecarSupervisor, SOURCE,
};
use clap::{Args, Parser, Subcommand};
use tonic::transport::Server;

#[derive(Parser, Debug)]
#[command(version, about = "cannet gRPC server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    proxy: ProxyArgs,
}

/// Options for the bare invocation — the production hardware proxy.
/// Ignored when a `debug` subcommand is given.
#[derive(Args, Debug)]
struct ProxyArgs {
    /// Address to bind the gRPC service on. The default is loopback:
    /// serving the network is an explicit choice, and until
    /// connections are authenticated a non-loopback bind is
    /// unprotected.
    #[arg(long, default_value = "127.0.0.1:50051")]
    bind: SocketAddr,
    /// The supervised sidecar's own `--log-level`, which governs how
    /// much it writes to stderr — and so how much of this server's log
    /// is the sidecar talking.
    #[arg(long, default_value = "info")]
    sidecar_log_level: String,
    /// How many times a crashing sidecar is restarted automatically
    /// before this server gives up and says so.
    #[arg(long, default_value_t = 3)]
    sidecar_restart_budget: u64,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Dev/test tooling: BLF replay or a virtual bus, in place of the
    /// production hardware proxy.
    #[command(subcommand)]
    Debug(DebugCommand),
}

#[derive(Subcommand, Debug)]
enum DebugCommand {
    /// Load a BLF file and replay it on a loop over the gRPC wire
    /// protocol. Dev/test tooling.
    Replay {
        /// Path to the BLF file to load and replay on a loop.
        blf: PathBuf,
        /// Address to bind the gRPC service on.
        #[arg(long, default_value = "127.0.0.1:50051")]
        bind: SocketAddr,
        /// Replay rate multiplier. `1.0` plays the BLF back at its
        /// recorded cadence (real-time emulation); `100.0` would play
        /// it 100× faster; `0.0` (the default) disables pacing
        /// entirely and streams frames as fast as the consumer
        /// drains, which is useful for development, tests, and
        /// stress-testing clients but does not resemble the cadence
        /// of any real CAN bus.
        #[arg(long, default_value_t = 0.0)]
        rate: f64,
    },
    /// Host a multi-client virtual CAN bus (ADR 0021): one factory
    /// interface (`virtual:bus0`). Any number of concurrent clients
    /// may connect; each `Subscribe` allocates a fresh participant
    /// whose transmissions fan out to every other participant.
    /// Dev/test tooling.
    Vbus {
        /// Address to bind the gRPC service on.
        #[arg(long, default_value = "127.0.0.1:50051")]
        bind: SocketAddr,
        /// Arbitration-phase bit rate (bits per second) for the
        /// virtual bus's initial configuration.
        #[arg(long, default_value_t = 500_000)]
        speed_bps: u64,
        /// Data-phase bit rate (bits per second) for CAN FD frames
        /// with BRS set. `0` (default) leaves the virtual bus
        /// classic-only.
        #[arg(long, default_value_t = 0)]
        fd_data_speed_bps: u64,
    },
}

async fn run_replay(
    blf: PathBuf,
    bind: SocketAddr,
    rate: f64,
) -> Result<(), Box<dyn std::error::Error>> {
    let replay = Arc::new(LoopingBlfReplay::open(&blf)?);

    eprintln!(
        "loaded {} interface(s) from {}",
        replay.interfaces().len(),
        blf.display()
    );
    for iface in replay.interfaces() {
        eprintln!(
            "  {} ({}) {}",
            iface.id,
            iface.display_name,
            if iface.fd_capable { "[fd]" } else { "" }
        );
    }
    eprintln!(
        "listening on {} (rate = {})",
        bind,
        if rate == 0.0 {
            "unbounded".to_string()
        } else {
            format!("{rate}×")
        }
    );

    let service = CannetServerImpl::new(replay, rate).into_service();
    Server::builder().add_service(service).serve(bind).await?;
    Ok(())
}

async fn run_vbus(
    bind: SocketAddr,
    speed_bps: u64,
    fd_data_speed_bps: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    let fd_enabled = fd_data_speed_bps > 0;
    let config = BusConfig {
        speed_bps,
        fd_data_speed_bps: if fd_enabled {
            Some(fd_data_speed_bps)
        } else {
            None
        },
        fd_enabled,
    };
    eprintln!(
        "virtual-bus mode: factory {VIRTUAL_BUS_FACTORY_ID} \
         (speed {} bit/s, fd data {})",
        config.speed_bps,
        config
            .fd_data_speed_bps
            .map_or_else(|| "off".to_string(), |v| format!("{v} bit/s"))
    );
    eprintln!("listening on {bind}");
    let service = VirtualBusServerImpl::new(config).into_service();
    Server::builder().add_service(service).serve(bind).await?;
    Ok(())
}

/// The name of the frozen sidecar's onedir, as
/// `scripts/build-sidecar.py` emits it. A distribution archive unpacks
/// it beside the server binary.
const FROZEN_SIDECAR_DIR: &str = "cannet-python-can";

/// The frozen sidecar launcher inside `dir`, or `None` when it isn't
/// there — the developer flow, where the shared crate falls back to
/// running the sidecar's source tree through `uv`.
fn frozen_launcher_in(dir: &Path) -> Option<PathBuf> {
    let launcher = dir
        .join(FROZEN_SIDECAR_DIR)
        .join(cannet_sidecar::frozen_launcher_name());
    launcher.is_file().then_some(launcher)
}

/// This CLI as the sidecar supervisor's host. A headless server has no
/// settings file and no message ring, so the two halves the trait asks
/// about are its own flags on the way in and its stderr on the way out.
struct CliSidecarHost {
    log_level: String,
    restart_budget: u64,
    /// The runtime the wait loop's thread is taken from. Captured
    /// rather than looked up per call so a restart dispatched from
    /// inside the wait loop's own blocking thread cannot depend on
    /// that thread carrying the runtime context.
    runtime: tokio::runtime::Handle,
}

impl SidecarHost for CliSidecarHost {
    fn config(&self) -> SidecarConfig {
        SidecarConfig {
            frozen_launcher: std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().and_then(frozen_launcher_in)),
            // A debug build is a developer running `cargo run`, where
            // edits to the sidecar source tree must win over any frozen
            // artifact that happens to be lying beside the binary
            // (ADR 0036).
            prefer_source_tree: cfg!(debug_assertions),
            sidecar_dir: std::env::var_os(cannet_sidecar::SIDECAR_DIR_ENV),
            log_level: self.log_level.clone(),
            // No `--log-file`: a headless server's log *is* its stderr,
            // and everything the sidecar writes is already on it.
            log_file: None,
            // Nothing to forward: the child inherits this process's
            // environment, so a driver-module override set for the
            // server reaches the sidecar untouched.
            driver_module: None,
        }
    }

    fn log(&self, level: LogLevel, message: String) {
        let level = match level {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        };
        eprintln!("[{level}] {SOURCE}: {message}");
    }

    fn restart_budget(&self) -> u64 {
        self.restart_budget
    }

    fn status_changed(&self, _previous: &SidecarStatus, current: &SidecarStatus) {
        // The proxy reads the same status per RPC, so this line is
        // purely the operator's view of why the endpoint is (or isn't)
        // answering yet.
        match (current.phase, current.address.as_deref()) {
            (SidecarPhase::Ready, Some(address)) => {
                eprintln!("[info] {SOURCE}: upstream ready on {address}");
            }
            (SidecarPhase::Starting, _) => eprintln!("[info] {SOURCE}: starting"),
            (SidecarPhase::Offline, _) => {
                eprintln!("[warn] {SOURCE}: offline; sessions are unavailable until it returns");
            }
            (SidecarPhase::Ready, None) => {}
        }
    }

    fn spawn_blocking(&self, task: Box<dyn FnOnce() + Send + 'static>) {
        self.runtime.spawn_blocking(task);
    }
}

/// The production role (ADR 0040): supervise one sidecar on loopback
/// and proxy it at `bind`. The sidecar picks an ephemeral port and
/// reports it on its banner, so the proxy asks the supervisor for the
/// current address per RPC rather than capturing one at startup — a
/// restart re-binds a different port.
async fn run_proxy(args: ProxyArgs) -> Result<(), Box<dyn std::error::Error>> {
    let supervisor = Arc::new(SidecarSupervisor::default());
    let host: Arc<dyn SidecarHost> = Arc::new(CliSidecarHost {
        log_level: args.sidecar_log_level,
        restart_budget: args.sidecar_restart_budget,
        runtime: tokio::runtime::Handle::current(),
    });
    supervisor.spawn(&host);

    eprintln!("hardware proxy: listening on {}", args.bind);
    let upstream = Arc::clone(&supervisor);
    let service = ProxyServerImpl::new(move || upstream.status().address).into_service();
    Server::builder()
        .add_service(service)
        .serve(args.bind)
        .await?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        Some(Command::Debug(DebugCommand::Replay { blf, bind, rate })) => {
            run_replay(blf, bind, rate).await
        }
        Some(Command::Debug(DebugCommand::Vbus {
            bind,
            speed_bps,
            fd_data_speed_bps,
        })) => run_vbus(bind, speed_bps, fd_data_speed_bps).await,
        None => run_proxy(cli.proxy).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_invocation_is_the_proxy_with_a_loopback_default() {
        // Loopback by default: exposing the hardware to the network is
        // an explicit `--bind`, never something a bare launch does.
        let cli = Cli::try_parse_from(["cannet-server"]).expect("bare invocation should parse");
        assert!(cli.command.is_none());
        assert_eq!(
            cli.proxy.bind,
            "127.0.0.1:50051".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(cli.proxy.sidecar_log_level, "info");
        assert_eq!(cli.proxy.sidecar_restart_budget, 3);
    }

    #[test]
    fn the_proxy_accepts_bind_and_the_sidecar_options() {
        let cli = Cli::try_parse_from([
            "cannet-server",
            "--bind",
            "0.0.0.0:9000",
            "--sidecar-log-level",
            "debug",
            "--sidecar-restart-budget",
            "10",
        ])
        .expect("the proxy's flags should parse");
        assert!(cli.command.is_none());
        assert_eq!(
            cli.proxy.bind,
            "0.0.0.0:9000".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(cli.proxy.sidecar_log_level, "debug");
        assert_eq!(cli.proxy.sidecar_restart_budget, 10);
    }

    #[test]
    fn a_frozen_launcher_beside_the_binary_is_found() {
        // The distribution archive's layout: the onedir unpacks next to
        // the server binary, under the name the freeze script emits.
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            frozen_launcher_in(dir.path()),
            None,
            "an unpacked-from-source tree has no frozen sidecar"
        );

        let onedir = dir.path().join(FROZEN_SIDECAR_DIR);
        std::fs::create_dir(&onedir).unwrap();
        let launcher = onedir.join(cannet_sidecar::frozen_launcher_name());
        std::fs::write(&launcher, b"").unwrap();
        assert_eq!(frozen_launcher_in(dir.path()), Some(launcher));
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn debug_replay_parses_positional_blf_with_defaults() {
        let cli = Cli::try_parse_from(["cannet-server", "debug", "replay", "capture.blf"])
            .expect("debug replay <blf> should parse");
        let Some(Command::Debug(DebugCommand::Replay { blf, bind, rate })) = cli.command else {
            panic!("expected Debug(Replay), got {:?}", cli.command);
        };
        assert_eq!(blf, PathBuf::from("capture.blf"));
        assert_eq!(bind, "127.0.0.1:50051".parse::<SocketAddr>().unwrap());
        assert_eq!(rate, 0.0);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn debug_replay_accepts_bind_and_rate() {
        let cli = Cli::try_parse_from([
            "cannet-server",
            "debug",
            "replay",
            "capture.blf",
            "--bind",
            "0.0.0.0:9000",
            "--rate",
            "1.5",
        ])
        .expect("debug replay with flags should parse");
        let Some(Command::Debug(DebugCommand::Replay { blf, bind, rate })) = cli.command else {
            panic!("expected Debug(Replay), got {:?}", cli.command);
        };
        assert_eq!(blf, PathBuf::from("capture.blf"));
        assert_eq!(bind, "0.0.0.0:9000".parse::<SocketAddr>().unwrap());
        assert_eq!(rate, 1.5);
    }

    #[test]
    fn debug_replay_requires_a_blf_path() {
        Cli::try_parse_from(["cannet-server", "debug", "replay"])
            .expect_err("debug replay with no BLF path should fail to parse");
    }

    #[test]
    fn debug_vbus_parses_with_defaults() {
        let cli = Cli::try_parse_from(["cannet-server", "debug", "vbus"])
            .expect("debug vbus should parse");
        let Some(Command::Debug(DebugCommand::Vbus {
            bind,
            speed_bps,
            fd_data_speed_bps,
        })) = cli.command
        else {
            panic!("expected Debug(Vbus), got {:?}", cli.command);
        };
        assert_eq!(bind, "127.0.0.1:50051".parse::<SocketAddr>().unwrap());
        assert_eq!(speed_bps, 500_000);
        assert_eq!(fd_data_speed_bps, 0);
    }

    #[test]
    fn debug_vbus_accepts_speed_and_fd_data_speed() {
        let cli = Cli::try_parse_from([
            "cannet-server",
            "debug",
            "vbus",
            "--speed-bps",
            "250000",
            "--fd-data-speed-bps",
            "2000000",
        ])
        .expect("debug vbus with flags should parse");
        let Some(Command::Debug(DebugCommand::Vbus {
            bind: _,
            speed_bps,
            fd_data_speed_bps,
        })) = cli.command
        else {
            panic!("expected Debug(Vbus), got {:?}", cli.command);
        };
        assert_eq!(speed_bps, 250_000);
        assert_eq!(fd_data_speed_bps, 2_000_000);
    }

    #[test]
    fn old_top_level_virtual_bus_flag_no_longer_parses() {
        Cli::try_parse_from(["cannet-server", "--virtual-bus"])
            .expect_err("--virtual-bus is no longer a top-level flag; it is `debug vbus`");
    }

    #[test]
    fn old_top_level_positional_blf_no_longer_parses() {
        Cli::try_parse_from(["cannet-server", "capture.blf"])
            .expect_err("a bare positional BLF path is no longer accepted; it is `debug replay`");
    }
}
