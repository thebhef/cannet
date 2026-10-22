//! How fast the session worker reads frames off the wire, and how many
//! it has handed over that the receiver has not yet taken.
//!
//! The worker thread decodes each `FrameBatch` and pushes its frames onto
//! the receiver's channel; whoever owns the [`crate::FrameReceiver`]
//! takes them off at its own pace. The two counters here say which side
//! of that channel a slow capture is on: a read count that keeps pace
//! with the bus while the queue grows means the reader is behind; a read
//! count that falls short while the queue stays empty means the frames
//! never arrived. Cumulative, so a reader samples them on its own cadence
//! and takes the difference.
//!
//! Shaped like [`crate::controller::ControllerStates`]: a cheap-to-clone
//! handle the worker writes and anything holding the session reads,
//! without a lock.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Debug, Default)]
struct Counters {
    read: AtomicU64,
    taken: AtomicU64,
}

/// The session's frame-channel counters. Clones share one set.
#[derive(Debug, Clone, Default)]
pub struct IngestStats(Arc<Counters>);

impl IngestStats {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every frame the worker has read off the wire and handed to the
    /// receiver's channel, since the session opened.
    #[must_use]
    pub fn frames_read(&self) -> u64 {
        self.0.read.load(Ordering::Relaxed)
    }

    /// Frames handed over that the receiver has not yet taken: the depth
    /// of the frame channel at this instant.
    #[must_use]
    pub fn queued(&self) -> u64 {
        self.frames_read()
            .saturating_sub(self.0.taken.load(Ordering::Relaxed))
    }

    pub(crate) fn record_read(&self) {
        self.0.read.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_taken(&self) {
        self.0.taken.fetch_add(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_queue_is_what_was_read_and_not_yet_taken() {
        let worker = IngestStats::new();
        let reader = worker.clone();
        for _ in 0..5 {
            worker.record_read();
        }
        reader.record_taken();
        reader.record_taken();
        assert_eq!(reader.frames_read(), 5);
        assert_eq!(reader.queued(), 3);
    }
}
