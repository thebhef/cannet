//! In-process CAN abstraction shared by every consumer in the analyzer.
//!
//! This crate is the contract between frame *sources* (BLF readers,
//! eventually network clients and hardware adapters) and frame
//! *consumers* (trace store, decoders, plotters, eventually the
//! network server). It is deliberately small: a single owned [`CanFrame`]
//! type plus two traits, [`CanFrameSource`] and [`CanFrameSink`], with a
//! [`pump`] helper that drains a source into a sink.
//!
//! ## `CanFrame` model
//!
//! [`CanFrame`] carries a source-defined nanosecond timestamp, a 0-based
//! logical [`channel`](CanFrame::channel), a [`CanId`] (with addressing
//! mode tagged on the type, so a standard `0x123` and an extended
//! `0x123` are not equal), a [`Direction`], and a [`CanFramePayload`]
//! enum that distinguishes:
//!
//! - [`CanFramePayload::Classic`]: classic CAN data frame, 0..=8 bytes
//! - [`CanFramePayload::Fd`]: CAN FD data frame, 0..=64 bytes plus
//!   [`CanFdFlags`] for BRS / ESI
//! - [`CanFramePayload::Remote`]: classic CAN remote-transmission-request,
//!   carries DLC only
//! - [`CanFramePayload::Error`]: bus error frame surfaced by the controller
//!
//! Constructors validate the payload-length contract. `CanFrame` itself
//! intentionally has *no* runtime configuration knobs — it is the
//! single canonical shape every part of the system reads.
//!
//! ## Source / sink contract
//!
//! [`CanFrameSource`] is pull-based: callers ask `next_frame()` and get
//! `Ok(Some(frame))` for each frame, `Ok(None)` once the stream is
//! exhausted (e.g. end of file), and `Err` on any source-defined
//! failure. [`CanFrameSink`] is push-based: `submit(frame)` either accepts
//! the frame or surfaces a sink-defined error.
//!
//! The two error types are independent — [`pump`] glues them with
//! [`PumpError`] so the source error type and the sink error type
//! don't have to share a parent.
//!
//! ## Phase plan
//!
//! - **Phase 1** (alpha0): BLF reader implements `CanFrameSource`; the
//!   Tauri host consumes via a per-thread loop that fans out batched
//!   frame events to the trace view.
//! - **Phase 2** (client/server): a network client implements
//!   `CanFrameSource`; the server bridges its own input to a `CanFrameSink`.
//!   `CanFrame` does not change; only adapters are added.
//! - **Phase 5** (transmit): the abstraction grows a transmit direction
//!   so a GUI transmit panel can send through a remote server (or a
//!   `cannet-server --loopback`); `CanFrameSink` is the seam.
//! - **Phase 6** (hardware): per-vendor server processes implement
//!   `CanFrameSource` against vendor SDKs / `python-can`. The GUI sees
//!   only the network transport.
//!
//! Anything that needs to slot in later (transports, hardware, replay
//! controllers) lives behind one of these traits.

mod frame;
mod io;

pub use frame::{
    CanId, Direction, EXTENDED_ID_MAX, FD_DATA_MAX, CanFdFlags, CanFrame, CanFrameError, CanFramePayload,
    IdError, CLASSIC_DATA_MAX, STANDARD_ID_MAX,
};
pub use io::{pump, CanFrameSink, CanFrameSource, PumpError};
