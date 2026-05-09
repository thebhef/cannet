//! In-process CAN abstraction.
//!
//! `frame` defines the wire-shape types every consumer reads (trace,
//! decode, plotting, network transport). `io` defines the producer /
//! consumer traits and a `pump` helper that drains a source into a sink.

mod frame;
mod io;

pub use frame::{
    CanId, Direction, EXTENDED_ID_MAX, FD_DATA_MAX, FdFlags, Frame, FrameError, FramePayload,
    IdError, CLASSIC_DATA_MAX, STANDARD_ID_MAX,
};
pub use io::{pump, FrameSink, FrameSource, PumpError};
