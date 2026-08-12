//! `cannet-server` CLI.
//!
//! Bare invocation is the production hardware proxy (ADR 0040), not
//! yet implemented: today it prints an error and exits non-zero.
//!
//! `debug replay <blf>` and `debug vbus` are the prior BLF-replay and
//! `--virtual-bus` modes, kept as explicitly dev/test tooling: replay
//! serves a BLF file on a loop over the gRPC wire protocol defined in
//! `cannet-wire`, and vbus (ADR 0021) hosts a multi-client virtual CAN
//! bus.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use cannet_core::BusConfig;
use cannet_server::{
    CannetServerImpl, LoopingBlfReplay, VirtualBusServerImpl, VIRTUAL_BUS_FACTORY_ID,
};
use clap::{Parser, Subcommand};
use tonic::transport::Server;

#[derive(Parser, Debug)]
#[command(version, about = "cannet gRPC server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
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

/// Message printed (and returned as the process's error) when
/// `cannet-server` is invoked bare. The production hardware proxy
/// (ADR 0040) is not yet implemented, so today bare invocation has
/// nothing to serve.
fn production_proxy_not_yet_implemented() -> String {
    "cannet-server: the production hardware proxy is not yet implemented; \
     use `cannet-server debug replay <blf>` or `cannet-server debug vbus` \
     for dev/test tooling"
        .to_string()
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
        None => Err(production_proxy_not_yet_implemented().into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_invocation_has_no_subcommand() {
        let cli = Cli::try_parse_from(["cannet-server"]).expect("bare invocation should parse");
        assert!(cli.command.is_none());
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

    #[test]
    fn bare_invocation_error_message_names_the_debug_subcommands() {
        let msg = production_proxy_not_yet_implemented();
        assert!(msg.contains("debug replay"));
        assert!(msg.contains("debug vbus"));
    }
}
