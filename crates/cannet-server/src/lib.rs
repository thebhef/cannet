//! gRPC server for the Phase-2 cannet wire protocol.
//!
//! Phase 2's only supported input is BLF: a server is constructed with a
//! [`LoopingBlfReplay`] loaded from a file at startup, and that replay is
//! streamed forever (looping at end-of-file) to whichever client is
//! currently subscribed. Phase 6 will introduce hardware-backed sources;
//! this crate stays focused on BLF for now.
//!
//! ## Crate layout
//!
//! - [`replay`] — pure-data: load a BLF file into memory, partition it by
//!   channel, expose interfaces and frame slices.
//! - [`server`] — the [`tonic`] [`cannet_wire::proto::cannet_server_server::CannetServer`]
//!   implementation: [`ListInterfaces`](server::CannetServer::list_interfaces)
//!   and [`Session`](server::CannetServer::session). Single-client per
//!   server (multi-client is in `plans/backlog.md`); transmit envelopes
//!   are rejected with `Error::TX_REJECTED` because BLF sources are
//!   read-only.
//! - [`loopback`] — Phase-5 demo mode. Exposes one fixed `loopback:0`
//!   interface; every client-transmitted frame is mirrored back as an
//!   `Rx` frame on the same interface. The in-process building block
//!   is [`cannet_core::loopback_bus`]; the server task just wraps it.
//!   Picked by `--loopback` on the CLI.
//!
//! The CLI binary (`src/main.rs`) is a thin wrapper that parses arguments
//! and calls into this library.

pub mod loopback;
pub mod replay;
pub mod server;

pub use loopback::{LoopbackServerImpl, LOOPBACK_INTERFACE_ID};
pub use replay::{LoopingBlfReplay, ReplayError};
pub use server::CannetServerImpl;
