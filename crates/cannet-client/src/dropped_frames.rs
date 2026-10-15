//! Frames evicted from the bounded data lane (ADR 0060 rule 3).
//!
//! The data lane holds about one second of frames per interface; on
//! overflow the sidecar drops the oldest whole batches -- never the
//! newest, and never by blocking the receive thread -- and names what
//! it dropped in a `FramesDropped` report. [`FramesDropped`] (this
//! module's shared handle, which shares its name with the wire message
//! it is fed from -- the same precedent
//! [`ControllerState`](crate::controller::ControllerState) sets against
//! the wire's own `ControllerState` enum) keeps every undrained
//! [`DroppedSpan`] per interface so the host can turn each into a
//! durable dropped-frames gap event (ADR 0060's consequences; the event
//! itself is a later phase) without losing one to a poll that runs
//! slower than the sidecar reports.
//!
//! [`FramesDropped::drain`] is destructive on purpose: once the host has
//! read a span it is responsible for recording it, and this module has
//! nothing further to say about frames it has already handed over.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

/// One reported span of frames the data lane evicted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DroppedSpan {
    pub count: u64,
    pub first_ns: u64,
    pub last_ns: u64,
}

/// Undrained spans kept per interface.
///
/// The host is expected to drain on (at least) its own poll cadence --
/// about once a second, the same cadence the sidecar's own state
/// heartbeat runs on -- so this only has to absorb a poll or two's
/// worth of overflow bursts, not a whole session's worth. On overflow
/// the oldest undrained span is evicted first, the same policy the data
/// lane itself uses.
const DROPPED_SPAN_HISTORY: usize = 16;

/// Per-interface dropped-frame spans for one session. Cheap to clone;
/// the clones share one map, so the session worker's writes are
/// visible to every reader.
#[derive(Debug, Clone, Default)]
pub struct FramesDropped(Arc<Mutex<BTreeMap<String, VecDeque<DroppedSpan>>>>);

impl FramesDropped {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one span the peer reported dropping on `interface_id`.
    pub fn record(&self, interface_id: &str, count: u64, first_ns: u64, last_ns: u64) {
        if let Ok(mut guard) = self.0.lock() {
            let spans = guard.entry(interface_id.to_string()).or_default();
            spans.push_back(DroppedSpan {
                count,
                first_ns,
                last_ns,
            });
            while spans.len() > DROPPED_SPAN_HISTORY {
                spans.pop_front();
            }
        }
    }

    /// Every undrained span per interface, oldest first. Does not clear
    /// anything -- see [`Self::drain`] for the consuming read.
    #[must_use]
    pub fn snapshot(&self) -> BTreeMap<String, Vec<DroppedSpan>> {
        self.0
            .lock()
            .map(|g| {
                g.iter()
                    .map(|(id, spans)| (id.clone(), spans.iter().copied().collect()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Take every undrained span per interface, leaving none behind.
    /// The host calls this once it has turned a span into a durable gap
    /// event, so a slow poller still sees each span exactly once rather
    /// than re-reporting it on every subsequent poll.
    #[must_use]
    pub fn drain(&self) -> BTreeMap<String, Vec<DroppedSpan>> {
        self.0
            .lock()
            .map(|mut g| {
                g.iter_mut()
                    .map(|(id, spans)| (id.clone(), spans.drain(..).collect()))
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_span_is_readable_through_any_clone_of_the_handle() {
        let writer = FramesDropped::new();
        let reader = writer.clone();
        assert!(reader.snapshot().is_empty());
        writer.record("vector:0", 10_000, 1_000, 9_000);
        let snap = reader.snapshot();
        assert_eq!(
            snap["vector:0"],
            vec![DroppedSpan {
                count: 10_000,
                first_ns: 1_000,
                last_ns: 9_000,
            }],
        );
    }

    #[test]
    fn multiple_spans_accumulate_until_drained() {
        let dropped = FramesDropped::new();
        dropped.record("vector:0", 1, 0, 1);
        dropped.record("vector:0", 2, 2, 3);
        assert_eq!(dropped.snapshot()["vector:0"].len(), 2);
    }

    #[test]
    fn history_is_bounded() {
        let dropped = FramesDropped::new();
        for i in 0..(DROPPED_SPAN_HISTORY as u64 + 5) {
            dropped.record("vector:0", 1, i, i);
        }
        let spans = dropped.snapshot();
        let spans = &spans["vector:0"];
        assert_eq!(spans.len(), DROPPED_SPAN_HISTORY);
        assert_eq!(spans.first().unwrap().first_ns, 5, "the oldest evict first");
    }

    #[test]
    fn drain_empties_what_snapshot_still_shows() {
        let dropped = FramesDropped::new();
        dropped.record("vector:0", 10, 0, 1);
        let drained = dropped.drain();
        assert_eq!(drained["vector:0"].len(), 1);
        assert!(
            dropped.snapshot()["vector:0"].is_empty(),
            "a drained span is not reported again",
        );
    }

    #[test]
    fn interfaces_are_tracked_independently() {
        let dropped = FramesDropped::new();
        dropped.record("peak:0", 1, 0, 1);
        dropped.record("vector:0", 2, 0, 1);
        assert_eq!(dropped.snapshot().len(), 2);
        assert_eq!(dropped.snapshot()["peak:0"][0].count, 1);
        assert_eq!(dropped.snapshot()["vector:0"][0].count, 2);
    }
}
