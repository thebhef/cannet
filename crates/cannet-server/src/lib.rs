//! gRPC server for the cannet wire protocol.
//!
//! Two server modes ship today:
//!
//! - **BLF replay** ([`server::CannetServerImpl`] over a
//!   [`replay::LoopingBlfReplay`]) loads a BLF file once at startup
//!   and streams it on a loop to the subscribed client. Read-only:
//!   client transmits are rejected with `Error::TX_REJECTED`.
//!   Single-client per server.
//! - **Virtual bus** ([`virtual_bus::VirtualBusServerImpl`] over a
//!   [`cannet_core::SharedBus`]) hosts a multi-client virtual CAN
//!   bus (ADR 0021): one factory interface, fan-out with sender
//!   attribution, `NoAcknowledger` on zero-recipient transmits,
//!   runtime `ConfigureBus`.
//!
//! ## Crate layout
//!
//! - [`replay`] — pure-data: load a BLF file into memory, partition it by
//!   channel, expose interfaces and frame slices.
//! - [`server`] — BLF replay tonic service.
//! - [`virtual_bus`] — virtual-bus tonic service.
//! - [`bridge_client`] — server-internal gRPC client the virtual-bus
//!   server uses to install a bridge that fronts a remote interface.
//!
//! The CLI binary (`src/main.rs`) is a thin wrapper that parses
//! arguments and chooses one of the services.

pub mod bridge_client;
pub mod replay;
pub mod server;
pub mod virtual_bus;

pub use replay::{LoopingBlfReplay, ReplayError};
pub use server::CannetServerImpl;
pub use virtual_bus::{VirtualBusServerImpl, VIRTUAL_BUS_FACTORY_ID};

/// Bind a virtual-bus server to an ephemeral local port and serve it.
///
/// Binds `127.0.0.1:0`, sends the resolved [`std::net::SocketAddr`] back
/// through `addr_tx` once known, then serves until the future is dropped.
/// A convenience for in-process consumers (tests, the `cannet-perf-measurement`
/// harness) that need a real gRPC endpoint without the CLI binary or
/// hand-rolled `tonic` / `tokio-stream` wiring.
///
/// # Errors
/// Returns the bind or serve error from the OS / `tonic`.
pub async fn serve_virtual_bus_ephemeral(
    config: cannet_core::BusConfig,
    addr_tx: tokio::sync::oneshot::Sender<std::net::SocketAddr>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let _ = addr_tx.send(addr);
    let stream = tokio_stream::wrappers::TcpListenerStream::new(listener);
    tonic::transport::Server::builder()
        .add_service(VirtualBusServerImpl::new(config).into_service())
        .serve_with_incoming(stream)
        .await?;
    Ok(())
}
