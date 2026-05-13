//! Decodes one DBC signal across a run of trace frames and yields a
//! `(time, value)` series — the plotting analogue of the trace view's
//! decode-on-fetch slice.
//!
//! A plot panel asks for a `(message id, signal name)` pair over a time
//! window. The caller pulls the frames covering that window out of the
//! [`TraceStore`](crate::trace_store::TraceStore) (see
//! `TraceStore::slice_time_range`) and hands them here together with the
//! currently-attached [`Database`]; [`sample_signal`] keeps the frames
//! whose id matches, decodes the signal, and returns the physical values
//! in capture order. Frames that don't decode (payload too short, signal
//! gated out by the message's multiplexor) are skipped rather than
//! producing a gap marker — the plot just doesn't get a point there.
//!
//! Taking an already-extracted slice (rather than the store itself)
//! keeps this function lock-free, so the caller controls when the
//! trace-store and DBC locks are held and in what order.
//!
//! [`decimate_min_max`] reduces a (possibly enormous) series to roughly
//! a requested number of time buckets, keeping each bucket's min- and
//! max-value point so spikes survive — what the plot panel applies
//! before handing the data to uPlot, since a window can hold far more
//! frames than the canvas has pixels.

use cannet_core::CanId;
use cannet_dbc::Database;

use crate::trace_store::RawTraceFrame;

/// One sampled point: source time in seconds, decoded physical value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SamplePoint {
    pub t_seconds: f64,
    pub value: f64,
}

/// From `frames` (already restricted to the desired time window), keep
/// the ones on the message identified by `message_id` / `extended`,
/// decode `signal_name` from each, and return the physical values in
/// input order.
///
/// Returns an empty series if the id is malformed or the database
/// doesn't define that `(message, signal)` pair.
#[must_use]
pub fn sample_signal(
    frames: &[RawTraceFrame],
    db: &Database,
    message_id: u32,
    extended: bool,
    signal_name: &str,
) -> Vec<SamplePoint> {
    let Some(id) = make_id(message_id, extended) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for frame in frames {
        if frame.id != message_id || frame.extended != extended {
            continue;
        }
        let Some(decoded) = db.decode_raw(id, frame.payload.data()) else {
            continue;
        };
        let Some(sig) = decoded.signals.iter().find(|s| s.name == signal_name) else {
            continue;
        };
        #[allow(clippy::cast_precision_loss)]
        out.push(SamplePoint {
            t_seconds: (frame.timestamp_ns as f64) / 1e9,
            value: sig.value,
        });
    }
    out
}

fn make_id(raw: u32, extended: bool) -> Option<CanId> {
    if extended {
        CanId::extended(raw).ok()
    } else {
        CanId::standard(raw).ok()
    }
}

/// Reduce `points` to roughly `max_buckets` time buckets, keeping the
/// min- and max-value point in each bucket (in timestamp order) so peaks
/// and troughs survive — the standard "min/max decimation" a plot uses
/// when there are far more samples than pixels.
///
/// Bucketing is by point index, not by time: the trace store's samples
/// are roughly time-ordered and roughly uniformly spaced, so index
/// buckets approximate time buckets closely enough, and an index walk is
/// O(n) with no search. Returns at most `2 * max_buckets + 2` points (the
/// "+ 2" comes from forcing the very first and very last input points
/// into the output — see below); a `max_buckets` of 0 is treated as "no
/// decimation". If the series already fits in `max_buckets` points it's
/// returned unchanged.
///
/// The first/last forcing matters for plots: a plot panel passes a slice
/// `[from, to)` plus one boundary sample on each side so the rendered
/// line spans the full visible x range. Without the forcing, the
/// boundary sample can lose the bucket's argmin/argmax race and get
/// dropped — visible as the line "ending one bin early" inside the
/// canvas.
#[must_use]
pub fn decimate_min_max(points: &[SamplePoint], max_buckets: usize) -> Vec<SamplePoint> {
    let n = points.len();
    if max_buckets == 0 || n <= max_buckets {
        return points.to_vec();
    }
    let bucket = n.div_ceil(max_buckets);
    let mut out = Vec::with_capacity(2 * max_buckets + 2);
    let mut start = 0;
    while start < n {
        let end = (start + bucket).min(n);
        let slice = &points[start..end];
        // argmin / argmax by value (first occurrence wins on ties).
        let mut lo = 0;
        let mut hi = 0;
        for (i, p) in slice.iter().enumerate() {
            if p.value < slice[lo].value {
                lo = i;
            }
            if p.value > slice[hi].value {
                hi = i;
            }
        }
        // Force the first sample of the first bucket and the last sample
        // of the last bucket into the bucket's "kept" set, so the
        // rendered line touches both ends of the input series. (See
        // function-level rustdoc.) Otherwise emit min/max in index order
        // (collapsing to one when they coincide).
        let is_first_bucket = start == 0;
        let is_last_bucket = end == n;
        let first_idx = 0;
        let last_idx = slice.len() - 1;
        let mut keep: [Option<usize>; 4] = [None; 4];
        if is_first_bucket {
            keep[0] = Some(first_idx);
        }
        keep[1] = Some(lo.min(hi));
        if lo != hi {
            keep[2] = Some(lo.max(hi));
        }
        if is_last_bucket {
            keep[3] = Some(last_idx);
        }
        // Emit in index order, deduplicating.
        let mut prev: Option<usize> = None;
        let mut sorted: Vec<usize> = keep.iter().filter_map(|&i| i).collect();
        sorted.sort_unstable();
        for i in sorted {
            if Some(i) != prev {
                out.push(slice[i]);
                prev = Some(i);
            }
        }
        start = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use cannet_core::{CanFramePayload, Direction};

    const DBC: &str = r#"VERSION ""
NS_ :
BS_:
BU_: ECU
BO_ 256 EngineData: 2 ECU
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16383.75] "rpm" ECU
"#;

    fn frame(ts_ns: u64, id: u32, data: Vec<u8>) -> RawTraceFrame {
        RawTraceFrame {
            timestamp_ns: ts_ns,
            channel: 0,
            id,
            extended: false,
            direction: Direction::Rx,
            payload: CanFramePayload::Classic(data),
        }
    }

    #[test]
    fn samples_matching_frames() {
        let db = Database::parse(DBC).unwrap();
        let frames = vec![
            // raw 0x0004 LE => 4 * 0.25 = 1.0 rpm at t = 1.0 s
            frame(1_000_000_000, 256, vec![0x04, 0x00]),
            // raw 0x0008 => 2.0 rpm at t = 2.0 s
            frame(2_000_000_000, 256, vec![0x08, 0x00]),
            // a frame for a different id is ignored
            frame(2_500_000_000, 257, vec![0xFF, 0xFF]),
        ];
        let pts = sample_signal(&frames, &db, 256, false, "EngineSpeed");
        assert_eq!(
            pts,
            vec![
                SamplePoint { t_seconds: 1.0, value: 1.0 },
                SamplePoint { t_seconds: 2.0, value: 2.0 },
            ]
        );
    }

    #[test]
    fn unknown_signal_or_message_yields_empty() {
        let db = Database::parse(DBC).unwrap();
        let frames = vec![frame(0, 256, vec![0x04, 0x00])];
        assert!(sample_signal(&frames, &db, 256, false, "Nope").is_empty());
        assert!(sample_signal(&frames, &db, 999, false, "EngineSpeed").is_empty());
    }

    #[test]
    fn undecodable_frame_is_skipped_not_fatal() {
        let db = Database::parse(DBC).unwrap();
        let frames = vec![
            // 1-byte payload: EngineSpeed needs 2 bytes, so no point here,
            frame(0, 256, vec![0x04]),
            // but the next valid frame still produces one.
            frame(1_000_000_000, 256, vec![0x08, 0x00]),
        ];
        let pts = sample_signal(&frames, &db, 256, false, "EngineSpeed");
        assert_eq!(pts, vec![SamplePoint { t_seconds: 1.0, value: 2.0 }]);
    }

    fn pt(t: f64, v: f64) -> SamplePoint {
        SamplePoint { t_seconds: t, value: v }
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn decimate_passthrough_when_small_or_disabled() {
        let pts = vec![pt(0.0, 1.0), pt(1.0, 2.0), pt(2.0, 3.0)];
        assert_eq!(decimate_min_max(&pts, 10), pts);
        assert_eq!(decimate_min_max(&pts, 3), pts);
        assert_eq!(decimate_min_max(&pts, 0), pts);
        assert_eq!(decimate_min_max(&[], 5), Vec::<SamplePoint>::new());
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn decimate_keeps_bucket_extrema_in_time_order_with_endpoints_forced() {
        // 6 points, 2 buckets of 3. Bucket 0 = [10, 1, 5] → first
        // (forced) = 10@t0, min=1@t1, max=10@t0 → emit [10@t0, 1@t1].
        // Bucket 1 = [3, 9, 4] → min=3@t3, max=9@t4, last (forced) =
        // 4@t5 → emit [3@t3, 9@t4, 4@t5].
        let pts = vec![
            pt(0.0, 10.0),
            pt(1.0, 1.0),
            pt(2.0, 5.0),
            pt(3.0, 3.0),
            pt(4.0, 9.0),
            pt(5.0, 4.0),
        ];
        let out = decimate_min_max(&pts, 2);
        assert_eq!(
            out,
            vec![
                pt(0.0, 10.0),
                pt(1.0, 1.0),
                pt(3.0, 3.0),
                pt(4.0, 9.0),
                pt(5.0, 4.0),
            ],
        );
        // Spikes preserved: global min (1.0) and max (10.0) still present.
        assert!(out.iter().any(|p| p.value == 1.0));
        assert!(out.iter().any(|p| p.value == 10.0));
        // Endpoints preserved: first and last input points still present.
        assert_eq!(out.first(), Some(&pt(0.0, 10.0)));
        assert_eq!(out.last(), Some(&pt(5.0, 4.0)));
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn decimate_collapses_flat_bucket_to_one_point_keeping_endpoints() {
        let pts = vec![pt(0.0, 7.0), pt(1.0, 7.0), pt(2.0, 7.0), pt(3.0, 7.0)];
        // Bucket 0 (first): forced first (0) + min/max (both 0 since
        // values flat) → just [0]. Bucket 1 (last): min/max (both 2)
        // + forced last (3) → [2, 3]. Endpoints come through.
        assert_eq!(
            decimate_min_max(&pts, 2),
            vec![pt(0.0, 7.0), pt(2.0, 7.0), pt(3.0, 7.0)],
        );
    }

    #[test]
    fn decimate_bounds_output_size() {
        let pts: Vec<SamplePoint> = (0..1000)
            .map(|i| pt(f64::from(i), f64::from((i * 7) % 13)))
            .collect();
        let out = decimate_min_max(&pts, 50);
        // Bound is `2 * max_buckets + 2` after the endpoint-forcing
        // rule (the +2 covers the forced first / last input points).
        assert!(out.len() <= 102, "got {}", out.len());
        assert!(out.len() >= 50);
        // Endpoints make it through.
        assert_eq!(out.first().map(|p| p.t_seconds), Some(0.0));
        assert_eq!(out.last().map(|p| p.t_seconds), Some(999.0));
    }
}
