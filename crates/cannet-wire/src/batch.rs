//! Stream adapters between [`cannet_core::CanFrame`] and
//! [`proto::FrameBatch`].
//!
//! The wire only carries [`proto::FrameBatch`] for frame movement, so
//! application code that wants to speak in single frames goes through a
//! coalescing adapter on the way out and a flattening adapter on the way
//! in. The hard parts (count + latency caps, end-of-input flushing) come
//! from [`tokio_stream::StreamExt::chunks_timeout`]; this module just
//! wraps that with the right protobuf shape.

use std::time::Duration;

use cannet_core::CanFrame;
use futures_core::Stream;
use tokio_stream::StreamExt;

use crate::convert::frame_to_proto;
use crate::proto;

/// How [`batch_frames`] decides when to emit a batch.
#[derive(Debug, Clone, Copy)]
pub struct BatchPolicy {
    /// Emit a batch as soon as it accumulates this many frames.
    pub max_frames_per_batch: usize,
    /// Emit a batch this long after its first frame, even if it hasn't
    /// reached `max_frames_per_batch`.
    pub max_batch_latency: Duration,
}

impl Default for BatchPolicy {
    /// 256 frames or 5 ms, whichever comes first. Matches the Phase 1
    /// in-process trace event cadence so batched-rx behaves the same
    /// way under either transport.
    fn default() -> Self {
        Self {
            max_frames_per_batch: 256,
            max_batch_latency: Duration::from_millis(5),
        }
    }
}

/// Coalesce a stream of [`CanFrame`]s into [`proto::FrameBatch`]es
/// tagged with the given `interface_id`.
///
/// Each output batch contains at most `policy.max_frames_per_batch`
/// frames. A batch is flushed early if `policy.max_batch_latency`
/// elapses after its first frame. Any frames buffered when the input
/// stream ends are flushed as a final batch.
///
/// Caller is responsible for sharding by interface — every frame on the
/// input stream is assumed to belong to `interface_id`.
pub fn batch_frames<S>(
    interface_id: String,
    frames: S,
    policy: BatchPolicy,
) -> impl Stream<Item = proto::FrameBatch>
where
    S: Stream<Item = CanFrame>,
{
    frames
        .chunks_timeout(policy.max_frames_per_batch, policy.max_batch_latency)
        .map(move |chunk| proto::FrameBatch {
            interface_id: interface_id.clone(),
            frames: chunk.iter().map(frame_to_proto).collect(),
        })
}

/// Flatten a stream of [`proto::FrameBatch`]es into individual
/// `(interface_id, proto::Frame)` pairs.
///
/// The caller decides whether and how to convert each [`proto::Frame`]
/// to a [`CanFrame`]; that step needs an `interface_id → channel`
/// mapping that lives at the application layer.
pub fn unbatch_frames<S>(batches: S) -> impl Stream<Item = (String, proto::Frame)>
where
    S: Stream<Item = proto::FrameBatch>,
{
    async_stream::stream! {
        let mut batches = std::pin::pin!(batches);
        while let Some(batch) = batches.next().await {
            let interface_id = batch.interface_id;
            for frame in batch.frames {
                yield (interface_id.clone(), frame);
            }
        }
    }
}
