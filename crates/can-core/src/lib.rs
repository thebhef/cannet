//! In-process CAN abstraction.
//!
//! See `frame` for the wire-shape types. Producer/consumer traits land in a
//! follow-up commit.

mod frame;

pub use frame::{
    CanId, Direction, EXTENDED_ID_MAX, FD_DATA_MAX, FdFlags, Frame, FrameError, FramePayload,
    IdError, CLASSIC_DATA_MAX, STANDARD_ID_MAX,
};
