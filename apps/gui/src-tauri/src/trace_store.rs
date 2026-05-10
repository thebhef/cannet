//! In-memory model for the trace view.
//!
//! The store is the model layer the trace UI is a view over. Pump
//! threads (BLF, remote) append frames as they arrive; the frontend
//! pulls slices on demand via the `fetch_trace_range` Tauri command,
//! sized to the virtualizer's visible window plus a small prefetch
//! pad. Decoding against the currently-attached DBC happens at fetch
//! time, so attaching or replacing a DBC just changes what subsequent
//! fetches return — there is no retro-decode walk through the whole
//! trace.
//!
//! ## What's in the store
//!
//! [`RawTraceFrame`] is the canonical undecoded shape. It owns its
//! payload bytes (no borrowing into a parent file or stream) so once
//! a frame is appended the source it came from is irrelevant. Append
//! is `O(1)` via [`Vec::push`]; slices clone out of the lock so the
//! decoder can run without holding it.
//!
//! ## Bounds and the future
//!
//! The Phase-2 store is `Vec<RawTraceFrame>`. For a long-running
//! session this grows unbounded — see `plans/backlog.md` for the
//! disk-spill follow-up. The interface here is shaped so that
//! evolution (windowed in-memory tail + on-disk overflow) can land
//! behind the same `append` / `len` / `slice` surface without
//! reshaping callers.
//!
//! ## Rate estimation
//!
//! The store keeps a rolling window of `(Instant, total_count)`
//! samples — one per append, pruned to a fixed window
//! ([`RATE_WINDOW`]) on each touch. [`Self::frames_per_second`] is the
//! count delta over the wall time spanned by the surviving samples,
//! returning `0.0` if there's not yet enough signal to estimate.
//! Bounded memory: at any instantaneous append rate `R` we hold
//! `R × RATE_WINDOW.as_secs()` entries.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use cannet_core::{CanFrame, CanFramePayload, Direction};

/// How far back the rate estimator looks. One second is short enough
/// that a stalled stream registers immediately and long enough that
/// per-batch jitter (256-frame batches at 60+ fps) doesn't bounce the
/// reading around.
const RATE_WINDOW: Duration = Duration::from_secs(1);

/// One row in the trace store. Owned, undecoded.
#[derive(Debug, Clone)]
pub struct RawTraceFrame {
    pub timestamp_ns: u64,
    pub channel: u8,
    pub id: u32,
    pub extended: bool,
    pub direction: Direction,
    pub payload: CanFramePayload,
}

impl From<CanFrame> for RawTraceFrame {
    fn from(frame: CanFrame) -> Self {
        Self {
            timestamp_ns: frame.timestamp_ns,
            channel: frame.channel,
            id: frame.id.raw(),
            extended: frame.id.is_extended(),
            direction: frame.direction,
            payload: frame.payload,
        }
    }
}

/// The trace model. Single producer (per pump thread) is typical but
/// not required; multiple producers serialise on the inner mutex.
pub struct TraceStore {
    inner: Mutex<Inner>,
}

struct Inner {
    frames: Vec<RawTraceFrame>,
    rate_samples: VecDeque<(Instant, usize)>,
}

impl TraceStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                frames: Vec::new(),
                rate_samples: VecDeque::new(),
            }),
        }
    }

    /// Append a frame to the tail of the trace. Records a rate sample.
    pub fn append(&self, frame: RawTraceFrame) {
        let now = Instant::now();
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        inner.frames.push(frame);
        let count = inner.frames.len();
        inner.rate_samples.push_back((now, count));
        prune_rate_samples(&mut inner.rate_samples, now);
    }

    /// Number of frames currently stored.
    #[must_use]
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("trace store mutex poisoned")
            .frames
            .len()
    }

    /// Cloned slice of frames in `[start, end)`. Clamped to the store's
    /// current bounds, so an over-large `end` returns whatever's
    /// available rather than erroring; an entirely out-of-range request
    /// returns an empty `Vec`.
    #[must_use]
    pub fn slice(&self, start: usize, end: usize) -> Vec<RawTraceFrame> {
        let inner = self.inner.lock().expect("trace store mutex poisoned");
        let len = inner.frames.len();
        if start >= len {
            return Vec::new();
        }
        let end = end.min(len);
        inner.frames[start..end].to_vec()
    }

    /// Drop every stored frame. Keeps the rate estimator's history
    /// because the consumer (the frontend) tends to clear in response
    /// to a user action, not a stream event — preserving past rate
    /// makes the displayed value continuous across the click.
    pub fn clear(&self) {
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        inner.frames.clear();
    }

    /// Estimated current append rate in frames per second.
    #[must_use]
    pub fn frames_per_second(&self) -> f64 {
        let now = Instant::now();
        let mut inner = self.inner.lock().expect("trace store mutex poisoned");
        prune_rate_samples(&mut inner.rate_samples, now);
        rate_from_samples(&inner.rate_samples)
    }
}

fn prune_rate_samples(samples: &mut VecDeque<(Instant, usize)>, now: Instant) {
    while let Some(&(t, _)) = samples.front() {
        if now.duration_since(t) > RATE_WINDOW {
            samples.pop_front();
        } else {
            break;
        }
    }
}

fn rate_from_samples(samples: &VecDeque<(Instant, usize)>) -> f64 {
    let (Some(&(t0, c0)), Some(&(t1, c1))) = (samples.front(), samples.back()) else {
        return 0.0;
    };
    let dt = t1.duration_since(t0).as_secs_f64();
    if dt <= 0.0 {
        return 0.0;
    }
    #[allow(clippy::cast_precision_loss)]
    let delta = (c1.saturating_sub(c0)) as f64;
    delta / dt
}

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_core::{CanId, Direction};

    fn dummy(ts_ns: u64, id: u32) -> RawTraceFrame {
        RawTraceFrame {
            timestamp_ns: ts_ns,
            channel: 0,
            id,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(vec![]),
        }
    }

    fn dummy_canframe(ts_ns: u64, id: u32) -> CanFrame {
        CanFrame::classic(
            ts_ns,
            0,
            CanId::standard(id).unwrap(),
            Direction::Rx,
            vec![],
        )
        .unwrap()
    }

    #[test]
    fn append_then_slice() {
        let store = TraceStore::new();
        for i in 0u32..10 {
            store.append(dummy(u64::from(i) * 1_000, i));
        }
        assert_eq!(store.len(), 10);
        let slice = store.slice(2, 5);
        let ids: Vec<u32> = slice.iter().map(|f| f.id).collect();
        assert_eq!(ids, vec![2, 3, 4]);
    }

    #[test]
    fn slice_clamps_oversized_end() {
        let store = TraceStore::new();
        for i in 0u32..3 {
            store.append(dummy(0, i));
        }
        let slice = store.slice(1, 100);
        assert_eq!(slice.len(), 2);
    }

    #[test]
    fn slice_out_of_range_returns_empty() {
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        assert!(store.slice(10, 20).is_empty());
    }

    #[test]
    fn clear_resets_len() {
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        store.append(dummy(0, 2));
        store.clear();
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn from_canframe_preserves_fields() {
        let frame = dummy_canframe(123_456, 0x10);
        let raw = RawTraceFrame::from(frame);
        assert_eq!(raw.timestamp_ns, 123_456);
        assert_eq!(raw.id, 0x10);
        assert!(!raw.extended);
        assert_eq!(raw.direction, Direction::Rx);
    }

    #[test]
    fn rate_is_zero_with_no_samples() {
        let store = TraceStore::new();
        assert_eq!(store.frames_per_second(), 0.0);
    }
}
