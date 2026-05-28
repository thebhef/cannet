//! `cannet-server` CLI: load a BLF file and serve it on the gRPC wire
//! protocol defined in `cannet-wire`, or run in `--virtual-bus` mode
//! (ADR 0021) and host a multi-client virtual CAN bus.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use cannet_core::BusConfig;
use cannet_server::{
    CannetServerImpl, LoopingBlfReplay, VirtualBusServerImpl, VIRTUAL_BUS_FACTORY_ID,
};
use clap::Parser;
use tonic::transport::Server;

#[derive(Parser, Debug)]
#[command(version, about = "cannet gRPC server (BLF replay or virtual bus)")]
struct Cli {
    /// Path to the BLF file to load and replay on a loop. Required
    /// unless `--virtual-bus` is set.
    blf: Option<PathBuf>,
    /// Address to bind the gRPC service on.
    #[arg(long, default_value = "127.0.0.1:50051")]
    bind: SocketAddr,
    /// Replay rate multiplier. `1.0` plays the BLF back at its
    /// recorded cadence (real-time emulation); `100.0` would play it
    /// 100× faster; `0.0` (the default) disables pacing entirely and
    /// streams frames as fast as the consumer drains, which is useful
    /// for development, tests, and stress-testing clients but does not
    /// resemble the cadence of any real CAN bus.
    #[arg(long, default_value_t = 0.0)]
    rate: f64,
    /// Run in virtual-bus mode (ADR 0021): expose one factory
    /// interface (`virtual:bus0`). Any number of concurrent clients
    /// may connect; each `Subscribe` allocates a fresh participant
    /// whose transmissions fan out to every other participant.
    /// Mutually exclusive with a BLF path.
    #[arg(long)]
    virtual_bus: bool,
    /// Arbitration-phase bit rate (bits per second) for the virtual
    /// bus's initial configuration.
    #[arg(long, default_value_t = 500_000)]
    speed_bps: u64,
    /// Data-phase bit rate (bits per second) for CAN FD frames with
    /// BRS set. `0` (default) leaves the virtual bus classic-only.
    #[arg(long, default_value_t = 0)]
    fd_data_speed_bps: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    if cli.virtual_bus {
        if cli.blf.is_some() {
            return Err("--virtual-bus and a BLF path are mutually exclusive".into());
        }
        let fd_enabled = cli.fd_data_speed_bps > 0;
        let config = BusConfig {
            speed_bps: cli.speed_bps,
            fd_data_speed_bps: if fd_enabled {
                Some(cli.fd_data_speed_bps)
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
        eprintln!("listening on {}", cli.bind);
        let service = VirtualBusServerImpl::new(config).into_service();
        Server::builder()
            .add_service(service)
            .serve(cli.bind)
            .await?;
        return Ok(());
    }
    let Some(blf) = cli.blf else {
        return Err("expected a BLF path (or --virtual-bus)".into());
    };
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
        cli.bind,
        if cli.rate == 0.0 {
            "unbounded".to_string()
        } else {
            format!("{}×", cli.rate)
        }
    );

    let service = CannetServerImpl::new(replay, cli.rate).into_service();
    Server::builder()
        .add_service(service)
        .serve(cli.bind)
        .await?;
    Ok(())
}
