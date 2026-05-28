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
