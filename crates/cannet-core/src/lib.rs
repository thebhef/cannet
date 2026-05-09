//! In-process CAN abstraction shared by every consumer in the analyzer.
//!
//! This crate is the contract between frame *sources* (BLF readers,
//! eventually network clients and hardware adapters) and frame
//! *consumers* (trace store, decoders, plotters, eventually the
//! network server). It is deliberately small: a single owned [`Frame`]
//! type plus two traits, [`FrameSource`] and [`FrameSink`], with a
//! [`pump`] helper that drains a source into a sink.
//!
//! ## Frame model
//!
//! [`Frame`] carries a source-defined nanosecond timestamp, a 0-based
//! logical [`channel`](Frame::channel), a [`CanId`] (with addressing
//! mode tagged on the type, so a standard `0x123` and an extended
//! `0x123` are not equal), a [`Direction`], and a [`FramePayload`]
//! enum that distinguishes:
//!
//! - [`FramePayload::Classic`]: classic CAN data frame, 0..=8 bytes
//! - [`FramePayload::Fd`]: CAN FD data frame, 0..=64 bytes plus
//!   [`FdFlags`] for BRS / ESI
//! - [`FramePayload::Remote`]: classic CAN remote-transmission-request,
//!   carries DLC only
//! - [`FramePayload::Error`]: bus error frame surfaced by the controller
//!
//! Constructors validate the payload-length contract. `Frame` itself
//! intentionally has *no* runtime configuration knobs — it is the
//! single canonical shape every part of the system reads.
//!
//! ## Source / sink contract
//!
//! [`FrameSource`] is pull-based: callers ask `next_frame()` and get
//! `Ok(Some(frame))` for each frame, `Ok(None)` once the stream is
//! exhausted (e.g. end of file), and `Err` on any source-defined
//! failure. [`FrameSink`] is push-based: `submit(frame)` either accepts
//! the frame or surfaces a sink-defined error.
//!
//! The two error types are independent — [`pump`] glues them with
//! [`PumpError`] so the source error type and the sink error type
//! don't have to share a parent.
//!
//! ## Phase plan
//!
//! - **Phase 1** (alpha0): BLF reader implements `FrameSource`; the
//!   Tauri host consumes via a per-thread loop that fans out batched
//!   frame events to the trace view.
//! - **Phase 2** (client/server): a network client implements
//!   `FrameSource`; the server bridges its own input to a `FrameSink`.
//!   `Frame` does not change; only adapters are added.
//! - **Phase 3** (hardware): per-vendor server processes implement
//!   `FrameSource` against vendor SDKs / `python-can`. The GUI sees
//!   only the network transport.
//!
//! Anything that needs to slot in later (transports, hardware, replay
//! controllers) lives behind one of these traits.

mod frame;
mod io;

pub use frame::{
    CanId, Direction, EXTENDED_ID_MAX, FD_DATA_MAX, FdFlags, Frame, FrameError, FramePayload,
    IdError, CLASSIC_DATA_MAX, STANDARD_ID_MAX,
};
pub use io::{pump, FrameSink, FrameSource, PumpError};
