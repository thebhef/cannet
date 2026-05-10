//! gRPC server for the Phase-2 cannet wire protocol.
//!
//! Phase 2's only supported input is BLF: a server is constructed with a
//! [`LoopingBlfReplay`] loaded from a file at startup, and that replay is
//! streamed forever (looping at end-of-file) to whichever client is
//! currently subscribed. Phase 4 will introduce hardware-backed sources;
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
//!
//! The CLI binary (`src/main.rs`) is a thin wrapper that parses arguments
//! and calls into this library.

pub mod replay;
pub mod server;

pub use replay::{LoopingBlfReplay, ReplayError};
pub use server::CannetServerImpl;
