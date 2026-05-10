//! `cannet-server` CLI: load a BLF file and serve it on the gRPC wire
//! protocol defined in `cannet-wire`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use cannet_server::{CannetServerImpl, LoopingBlfReplay};
use clap::Parser;
use tonic::transport::Server;

#[derive(Parser, Debug)]
#[command(version, about = "cannet Phase 2 BLF replay server")]
struct Cli {
    /// Path to the BLF file to load and replay on a loop.
    blf: PathBuf,
    /// Address to bind the gRPC service on.
    #[arg(long, default_value = "127.0.0.1:50051")]
    bind: SocketAddr,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let replay = Arc::new(LoopingBlfReplay::open(&cli.blf)?);

    eprintln!(
        "loaded {} interface(s) from {}",
        replay.interfaces().len(),
        cli.blf.display()
    );
    for iface in replay.interfaces() {
        eprintln!(
            "  {} ({}) {}",
            iface.id,
            iface.display_name,
            if iface.fd_capable { "[fd]" } else { "" }
        );
    }
    eprintln!("listening on {}", cli.bind);

    let service = CannetServerImpl::new(replay).into_service();
    Server::builder().add_service(service).serve(cli.bind).await?;
    Ok(())
}
