//! Wire protocol for CAN frame transport between cannet clients and servers.
//!
//! The service definition lives in `proto/cannet.proto`; this crate exposes
//! the [`tonic`]-generated client and server stubs (under [`proto`])
//! alongside conversion helpers between the wire types and the in-process
//! [`cannet_core::CanFrame`].
//!
//! ## Wire shape
//!
//! Two RPCs:
//!
//! - `ListInterfaces`: stateless, on-demand discovery of the CAN interfaces
//!   a server exposes.
//! - `Session`: a single bidirectional stream of [`proto::Envelope`]
//!   messages for the lifetime of the client session. The envelope
//!   variants — `Subscribe`, `Unsubscribe`, `FrameBatch`, `Error`,
//!   `LogMessage`, `ConfigureBus`, `InterfaceAllocated`,
//!   `InterfaceState`, `AttachBridge`, `DetachBridge`, and
//!   `Error::Code::NoAcknowledger` — flow on the same stream.
//!   Direction conventions (client→server vs server→client) and the
//!   virtual-bus / hardware-server responsibility split are
//!   documented in [ADR 0021].
//!
//! [ADR 0021]: ../../../docs/adr/0021-virtual-bus-server.md
//!
//! [`proto::LogMessage`] is the Phase-7 out-of-band log channel: a
//! sender (vendor sidecar, server, peer client) emits structured
//! advisory messages on the same stream. Unlike [`proto::Error`] it
//! does **not** end the session — receivers route it into their local
//! log surface (the host's System Messages panel in this project).
//! The variant is defined here; the host-side bridge that consumes it
//! ships separately so application code can be exercised without a
//! live wire.
//!
//! [`proto::FrameBatch`] is the only frame-carrying envelope variant.
//! Application code never deals with batches directly; the [`batch`]
//! module provides adapters between a stream of [`cannet_core::CanFrame`]
//! and a stream of [`proto::FrameBatch`] so server and client crates
//! work in `cannet-core` types.
//!
//! ## Schema evolution
//!
//! The `.proto` is the contract. Protobuf-3 evolution rules apply:
//!
//! - Field tags are immutable. Never reuse a tag number for a different
//!   meaning; mark retired tags as `reserved`.
//! - Adding a new field is forward- and backward-compatible — older peers
//!   ignore unknown fields.
//! - Adding a new variant to an enum or `oneof` is backward-compatible
//!   for receivers (they see `Unspecified` / `None` for variants they
//!   don't know).
//!
//! Cyclic / scheduled emission is intentionally **not** part of the wire
//! protocol. Sending on a cadence is a feature of the client transmit UI.

#[allow(
    clippy::pedantic,
    clippy::nursery,
    clippy::all,
    missing_docs,
    unreachable_pub
)]
pub mod proto {
    tonic::include_proto!("cannet.v1");
}

pub mod batch;
pub mod convert;

pub use batch::{batch_frames, unbatch_frames, BatchPolicy};
pub use convert::{
    batch_to_proto, frame_to_proto, proto_to_batch, proto_to_frame, ProtoConversionError,
};
