//! `cannet-server` CLI: load a BLF file and serve it on the gRPC wire
//! protocol defined in `cannet-wire`, or run in `--loopback` mode and
//! echo client transmits back as `Rx` frames.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use cannet_server::{CannetServerImpl, LoopbackServerImpl, LoopingBlfReplay};
use clap::Parser;
use tonic::transport::Server;

#[derive(Parser, Debug)]
#[command(version, about = "cannet Phase 2 BLF replay server")]
struct Cli {
    /// Path to the BLF file to load and replay on a loop. Required
    /// unless `--loopback` is set.
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
    /// Run in loopback mode: expose one fixed `loopback:0` interface
    /// and echo every client-transmitted frame back as an `Rx` frame
    /// on that interface. Mutually exclusive with a BLF path. Used by
    /// the Phase-5 transmit demo, where the GUI's transmit panel sends
    /// frames over the wire and sees them appear in the trace.
    #[arg(long)]
    loopback: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    if cli.loopback {
        if cli.blf.is_some() {
            return Err("--loopback and a BLF path are mutually exclusive".into());
        }
        eprintln!("loopback mode: every transmit is echoed back on loopback:0");
        eprintln!("listening on {}", cli.bind);
        let service = LoopbackServerImpl::new().into_service();
        Server::builder().add_service(service).serve(cli.bind).await?;
        return Ok(());
    }
    let Some(blf) = cli.blf else {
        return Err("expected a BLF path (or --loopback)".into());
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
    Server::builder().add_service(service).serve(cli.bind).await?;
    Ok(())
}
