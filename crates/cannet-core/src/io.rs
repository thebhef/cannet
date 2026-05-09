//! Producer / consumer interfaces over `Frame`.
//!
//! The Phase 1 BLF reader implements `FrameSource`; the trace view (and
//! eventually the Phase 2 server) implement `FrameSink`. `pump` drains a
//! source into a sink until the source signals end-of-stream, so callers
//! don't reinvent the loop.

use crate::frame::Frame;

/// A pull-based stream of CAN frames.
///
/// `next_frame` returns `Ok(Some(frame))` for each frame, `Ok(None)` when
/// the stream is exhausted (e.g. end of file), or `Err` on a recoverable
/// or fatal source error — the caller decides which by inspecting the
/// concrete error type.
pub trait FrameSource {
    type Error;

    fn next_frame(&mut self) -> Result<Option<Frame>, Self::Error>;
}

/// A push-based consumer of CAN frames.
pub trait FrameSink {
    type Error;

    fn submit(&mut self, frame: Frame) -> Result<(), Self::Error>;
}

/// Drain `source` into `sink` until the source returns `Ok(None)`.
///
/// Either side's error short-circuits the pump; the source error wraps
/// into [`PumpError::Source`] and the sink error into [`PumpError::Sink`].
pub fn pump<S, K>(source: &mut S, sink: &mut K) -> Result<(), PumpError<S::Error, K::Error>>
where
    S: FrameSource,
    K: FrameSink,
{
    while let Some(frame) = source.next_frame().map_err(PumpError::Source)? {
        sink.submit(frame).map_err(PumpError::Sink)?;
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub enum PumpError<S, K> {
    Source(S),
    Sink(K),
}

impl<S: core::fmt::Display, K: core::fmt::Display> core::fmt::Display for PumpError<S, K> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Source(e) => write!(f, "frame source error: {e}"),
            Self::Sink(e) => write!(f, "frame sink error: {e}"),
        }
    }
}

impl<S, K> std::error::Error for PumpError<S, K>
where
    S: std::error::Error + 'static,
    K: std::error::Error + 'static,
{
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Source(e) => Some(e),
            Self::Sink(e) => Some(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{CanId, Direction, Frame};

    fn make_frame(ts: u64) -> Frame {
        let id = CanId::standard(0x100).unwrap();
        let tag = u8::try_from(ts & 0xFF).unwrap();
        Frame::classic(ts, 0, id, Direction::Rx, vec![tag]).unwrap()
    }

    struct VecSource {
        frames: std::vec::IntoIter<Frame>,
    }

    impl FrameSource for VecSource {
        type Error = std::convert::Infallible;
        fn next_frame(&mut self) -> Result<Option<Frame>, Self::Error> {
            Ok(self.frames.next())
        }
    }

    #[derive(Default)]
    struct VecSink {
        captured: Vec<Frame>,
    }

    impl FrameSink for VecSink {
        type Error = std::convert::Infallible;
        fn submit(&mut self, frame: Frame) -> Result<(), Self::Error> {
            self.captured.push(frame);
            Ok(())
        }
    }

    #[test]
    fn pump_drains_source_into_sink_in_order() {
        let mut source = VecSource {
            frames: vec![make_frame(1), make_frame(2), make_frame(3)].into_iter(),
        };
        let mut sink = VecSink::default();

        pump(&mut source, &mut sink).unwrap();

        let timestamps: Vec<u64> = sink.captured.iter().map(|f| f.timestamp_ns).collect();
        assert_eq!(timestamps, vec![1, 2, 3]);
    }

    #[test]
    fn pump_returns_ok_on_empty_source() {
        let mut source = VecSource { frames: Vec::new().into_iter() };
        let mut sink = VecSink::default();
        pump(&mut source, &mut sink).unwrap();
        assert!(sink.captured.is_empty());
    }

    struct FailingSource;
    #[derive(Debug, PartialEq, Eq)]
    struct SourceErr;
    impl core::fmt::Display for SourceErr {
        fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
            f.write_str("boom")
        }
    }
    impl std::error::Error for SourceErr {}
    impl FrameSource for FailingSource {
        type Error = SourceErr;
        fn next_frame(&mut self) -> Result<Option<Frame>, Self::Error> {
            Err(SourceErr)
        }
    }

    #[test]
    fn pump_surfaces_source_errors() {
        let mut source = FailingSource;
        let mut sink = VecSink::default();
        let err = pump(&mut source, &mut sink).unwrap_err();
        assert!(matches!(err, PumpError::Source(SourceErr)));
    }

    struct FailingSink;
    #[derive(Debug, PartialEq, Eq)]
    struct SinkErr;
    impl core::fmt::Display for SinkErr {
        fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
            f.write_str("nope")
        }
    }
    impl std::error::Error for SinkErr {}
    impl FrameSink for FailingSink {
        type Error = SinkErr;
        fn submit(&mut self, _: Frame) -> Result<(), Self::Error> {
            Err(SinkErr)
        }
    }

    #[test]
    fn pump_surfaces_sink_errors() {
        let mut source = VecSource { frames: vec![make_frame(0)].into_iter() };
        let mut sink = FailingSink;
        let err = pump(&mut source, &mut sink).unwrap_err();
        assert!(matches!(err, PumpError::Sink(SinkErr)));
    }
}
