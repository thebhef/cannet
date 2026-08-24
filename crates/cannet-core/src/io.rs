//! Producer / consumer interfaces over `CanFrame`.
//!
//! The BLF reader implements `CanFrameSource`; the trace view (and
//! the server) implement `CanFrameSink`. `pump` drains a
//! source into a sink until the source signals end-of-stream, so callers
//! don't reinvent the loop.

use crate::frame::CanFrame;

/// A pull-based stream of CAN frames.
///
/// `next_frame` returns `Ok(Some(frame))` for each frame, `Ok(None)` when
/// the stream is exhausted (e.g. end of file), or `Err` on a recoverable
/// or fatal source error — the caller decides which by inspecting the
/// concrete error type.
pub trait CanFrameSource {
    type Error;

    fn next_frame(&mut self) -> Result<Option<CanFrame>, Self::Error>;

    /// How many frames this source has pulled off its underlying stream
    /// so far, or `None` for a source with no such notion.
    ///
    /// This is what a *replay* reports progress against, and it counts
    /// frames read rather than frames yielded on purpose: a filtering
    /// wrapper drops frames after reading them, and the denominator a
    /// caller has — a census's frame count over the whole file — counts
    /// what was read. Comparing yielded frames against it would make a
    /// windowed import stall part-way and never finish.
    ///
    /// `None` is the honest answer for a live stream: it has no end to
    /// be a fraction of. Defaulted, so a source only implements this if
    /// it has something to say.
    fn frames_read(&self) -> Option<u64> {
        None
    }
}

/// A push-based consumer of CAN frames.
pub trait CanFrameSink {
    type Error;

    fn submit(&mut self, frame: CanFrame) -> Result<(), Self::Error>;
}

/// Drain `source` into `sink` until the source returns `Ok(None)`.
///
/// Either side's error short-circuits the pump; the source error wraps
/// into [`PumpError::Source`] and the sink error into [`PumpError::Sink`].
pub fn pump<S, K>(source: &mut S, sink: &mut K) -> Result<(), PumpError<S::Error, K::Error>>
where
    S: CanFrameSource,
    K: CanFrameSink,
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

/// A `CanFrameSource` that only yields frames whose timestamp falls in
/// `[start_ns, end_ns]` (both bounds inclusive, either or both omittable).
///
/// This is the time-range filter [ADR 0046](../../../docs/adr/0046-one-ingest-pathway.md)
/// requires: a selected import range is a filter at the `CanFrameSource`
/// seam, not a second ingest path. Every source — BLF, live, future
/// formats — gets range windowing the same way, for free, by wrapping.
///
/// Frames outside `[start_ns, end_ns]` are skipped, not truncated: the
/// inner source is walked all the way to EOF regardless of where a
/// frame falls, because a capture's frames are not promised to arrive
/// in timestamp order (ADR 0024) — a real multi-bus capture dips below
/// its own running maximum several times a minute, and a frame that
/// belongs in the window can sit after one that doesn't. Stopping at
/// the first out-of-range frame would silently drop those. A wrapped
/// source that surfaces side information as it walks — e.g.
/// `BlfCanFrameSource`'s marker sink — sees the whole walk, not just a
/// prefix bounded by the window.
pub struct WindowedSource<S> {
    inner: S,
    start_ns: Option<u64>,
    end_ns: Option<u64>,
    done: bool,
    /// Frames pulled out of `inner`, filtered or not. See
    /// [`CanFrameSource::frames_read`] for why the count is taken here
    /// rather than at what this yields.
    frames_read: u64,
}

impl<S: CanFrameSource> WindowedSource<S> {
    /// Wrap `inner` with the given inclusive bounds. `None` on either
    /// side means that side is unbounded.
    pub fn new(inner: S, start_ns: Option<u64>, end_ns: Option<u64>) -> Self {
        Self {
            inner,
            start_ns,
            end_ns,
            done: false,
            frames_read: 0,
        }
    }
}

impl<S: CanFrameSource> CanFrameSource for WindowedSource<S> {
    type Error = S::Error;

    fn next_frame(&mut self) -> Result<Option<CanFrame>, Self::Error> {
        if self.done {
            return Ok(None);
        }
        loop {
            let Some(frame) = self.inner.next_frame()? else {
                self.done = true;
                return Ok(None);
            };
            self.frames_read += 1;
            if self
                .start_ns
                .is_some_and(|start| frame.timestamp_ns < start)
            {
                continue;
            }
            if self.end_ns.is_some_and(|end| frame.timestamp_ns > end) {
                continue;
            }
            return Ok(Some(frame));
        }
    }

    fn frames_read(&self) -> Option<u64> {
        Some(self.frames_read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{CanFrame, CanId, Direction};

    fn make_frame(ts: u64) -> CanFrame {
        let id = CanId::standard(0x100).unwrap();
        let tag = u8::try_from(ts & 0xFF).unwrap();
        CanFrame::classic(ts, 0, id, Direction::Rx, vec![tag]).unwrap()
    }

    struct VecSource {
        frames: std::vec::IntoIter<CanFrame>,
    }

    impl CanFrameSource for VecSource {
        type Error = std::convert::Infallible;
        fn next_frame(&mut self) -> Result<Option<CanFrame>, Self::Error> {
            Ok(self.frames.next())
        }
    }

    #[derive(Default)]
    struct VecSink {
        captured: Vec<CanFrame>,
    }

    impl CanFrameSink for VecSink {
        type Error = std::convert::Infallible;
        fn submit(&mut self, frame: CanFrame) -> Result<(), Self::Error> {
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
        let mut source = VecSource {
            frames: Vec::new().into_iter(),
        };
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
    impl CanFrameSource for FailingSource {
        type Error = SourceErr;
        fn next_frame(&mut self) -> Result<Option<CanFrame>, Self::Error> {
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
    impl CanFrameSink for FailingSink {
        type Error = SinkErr;
        fn submit(&mut self, _: CanFrame) -> Result<(), Self::Error> {
            Err(SinkErr)
        }
    }

    #[test]
    fn pump_surfaces_sink_errors() {
        let mut source = VecSource {
            frames: vec![make_frame(0)].into_iter(),
        };
        let mut sink = FailingSink;
        let err = pump(&mut source, &mut sink).unwrap_err();
        assert!(matches!(err, PumpError::Sink(SinkErr)));
    }

    fn drain(mut source: impl CanFrameSource<Error = std::convert::Infallible>) -> Vec<u64> {
        let mut out = Vec::new();
        while let Some(frame) = source.next_frame().unwrap() {
            out.push(frame.timestamp_ns);
        }
        out
    }

    fn vec_source(timestamps: &[u64]) -> VecSource {
        VecSource {
            frames: timestamps
                .iter()
                .copied()
                .map(make_frame)
                .collect::<Vec<_>>()
                .into_iter(),
        }
    }

    /// The window filters what it yields, not what it reads, and
    /// progress has to be reported against the latter — otherwise a
    /// narrow import range reports a fraction of a fraction and the bar
    /// never reaches its end.
    #[test]
    fn frames_read_counts_what_the_window_pulled_in_not_what_it_let_through() {
        let mut source = WindowedSource::new(vec_source(&[1, 2, 3, 4, 5]), Some(4), None);
        assert_eq!(source.frames_read(), Some(0));

        let mut yielded = 0;
        while source.next_frame().unwrap().is_some() {
            yielded += 1;
        }

        assert_eq!(yielded, 2, "only frames 4 and 5 are in the window");
        assert_eq!(
            source.frames_read(),
            Some(5),
            "but the whole source was read, and that is what a census counted",
        );
    }

    /// A source that has no end to be a fraction of says so, rather than
    /// making one up. The default is what every live source inherits.
    #[test]
    fn a_source_with_no_notion_of_progress_reports_none() {
        let source = vec_source(&[1, 2, 3]);
        assert_eq!(source.frames_read(), None);
    }

    #[test]
    fn windowed_source_with_no_bounds_passes_every_frame_through() {
        let source = WindowedSource::new(vec_source(&[1, 2, 3]), None, None);
        assert_eq!(drain(source), vec![1, 2, 3]);
    }

    #[test]
    fn windowed_source_skips_frames_strictly_before_start() {
        let source = WindowedSource::new(vec_source(&[1, 2, 3, 4]), Some(3), None);
        assert_eq!(drain(source), vec![3, 4]);
    }

    #[test]
    fn windowed_source_keeps_the_frame_exactly_at_start() {
        // Pinned: `start_ns` is an inclusive bound.
        let source = WindowedSource::new(vec_source(&[2, 3]), Some(3), None);
        assert_eq!(drain(source), vec![3]);
    }

    #[test]
    fn windowed_source_keeps_the_frame_exactly_at_end() {
        // Pinned: `end_ns` is an inclusive bound.
        let source = WindowedSource::new(vec_source(&[3, 4]), None, Some(3));
        assert_eq!(drain(source), vec![3]);
    }

    #[test]
    fn windowed_source_reads_to_eof_and_keeps_a_frame_that_falls_back_in_range() {
        // Real captures are not timestamp-ordered (ADR 0024): a frame
        // past `end_ns` must not end the walk, because a later frame in
        // the underlying source can still be back inside the window —
        // this is the shape of `wall-clock-out-of-order.blf`, whose two
        // earliest frames sit after a frame comfortably past the window.
        let source = WindowedSource::new(vec_source(&[1, 2, 5, 2]), None, Some(3));
        assert_eq!(drain(source), vec![1, 2, 2]);
    }

    #[test]
    fn windowed_source_applies_both_bounds_together() {
        let source = WindowedSource::new(vec_source(&[1, 2, 3, 4, 5]), Some(2), Some(4));
        assert_eq!(drain(source), vec![2, 3, 4]);
    }

    #[test]
    fn windowed_source_empty_source_yields_nothing() {
        let source = WindowedSource::new(vec_source(&[]), Some(2), Some(4));
        assert_eq!(drain(source), Vec::<u64>::new());
    }
}
