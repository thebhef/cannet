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
//! [`sample_shared`] is the same decode for several signals of one
//! message at once — one decode pass answering every cached series that
//! rides that message id, instead of one full decode per signal that
//! then throws away every value but one.
//!
//! [`decimate_min_max`] reduces a (possibly enormous) series to roughly
//! a requested number of time buckets, keeping each bucket's first,
//! last, min- and max-value point so both spikes and held runs survive
//! — what the plot panel applies before handing the data to uPlot,
//! since a window can hold far more frames than the canvas has pixels.
//! It is the **one** reduction every serve applies, whatever the
//! requesting view draws: an enum lane's held states survive it for the
//! same reason a stepped line's steps do (ADR 0026), so the host needs
//! no render-mode flag from the caller.

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
        if let Some(point) = sample_frame(frame, db, id, message_id, extended, signal_name) {
            out.push(point);
        }
    }
    out
}

/// Decode one frame **once** for several signals of the same message —
/// what the decoded-signal cache's catch-up runs when N cached series
/// ride one message id. Writes `wanted.len()` entries into `out`,
/// index-parallel with `wanted`: `Some(value)` where a database
/// produced that signal, `None` where none did (name unknown to every
/// database, payload too short, or gated out by the message's
/// multiplexor). `out` is cleared first, and is the caller's scratch
/// buffer so a per-frame loop allocates nothing.
///
/// The message is decoded once *per database*, in load order, and each
/// name takes the first database that yields **that name** — the host's
/// "first DBC that decodes wins" rule (`LoadedDbc`), applied per signal
/// rather than per message. Where two loaded databases both define a
/// message, one may carry a signal the other lacks, so two signals of
/// one message legitimately resolve to two different databases.
/// Choosing a database once for the whole message would rescale a
/// signal against the wrong definition, or drop it.
///
/// `picked` overrides that default per name. It is either empty — no
/// signal here has a user-chosen database, which is the ordinary case —
/// or index-parallel with `wanted`, each entry naming the index in
/// `dbs` of the one database that may answer for that name
/// (`signal_fingerprint::DecodeModel::picked_index`). A pinned name
/// takes its value from that database or from none: falling through to
/// the next database would put back exactly the silent substitution the
/// pick was made to stop.
pub fn sample_shared(
    frame: &RawTraceFrame,
    dbs: &[&Database],
    message_id: u32,
    extended: bool,
    wanted: &[&str],
    picked: &[Option<usize>],
    out: &mut Vec<Option<f64>>,
) {
    out.clear();
    out.resize(wanted.len(), None);
    if frame.id != message_id || frame.extended != extended {
        return;
    }
    let Some(id) = make_id(message_id, extended) else {
        return;
    };
    let mut unresolved = out.len();
    for (index, db) in dbs.iter().enumerate() {
        if unresolved == 0 {
            break;
        }
        let Some(decoded) = db.decode_raw(id, frame.payload.data()) else {
            continue;
        };
        for (i, (slot, name)) in out.iter_mut().zip(wanted).enumerate() {
            if slot.is_some() {
                continue;
            }
            if picked.get(i).copied().flatten().is_some_and(|p| p != index) {
                continue;
            }
            if let Some(sig) = decoded.signals.iter().find(|s| s.name == *name) {
                *slot = Some(sig.value);
                unresolved -= 1;
            }
        }
    }
}

/// The shared per-frame body: id filter, decode, signal lookup. Takes
/// the already-validated [`CanId`] so a multi-frame caller resolves it
/// once.
fn sample_frame(
    frame: &RawTraceFrame,
    db: &Database,
    id: CanId,
    message_id: u32,
    extended: bool,
    signal_name: &str,
) -> Option<SamplePoint> {
    if frame.id != message_id || frame.extended != extended {
        return None;
    }
    let decoded = db.decode_raw(id, frame.payload.data())?;
    let sig = decoded.signals.iter().find(|s| s.name == signal_name)?;
    #[allow(clippy::cast_precision_loss)]
    Some(SamplePoint {
        t_seconds: (frame.timestamp_ns as f64) / 1e9,
        value: sig.value,
    })
}

fn make_id(raw: u32, extended: bool) -> Option<CanId> {
    if extended {
        CanId::extended(raw).ok()
    } else {
        CanId::standard(raw).ok()
    }
}

/// Reduce `points` to roughly `max_buckets` time buckets, keeping each
/// bucket's **first, last, min- and max-value** point (in timestamp
/// order, deduplicated where they coincide) — min/max decimation with
/// the bucket's endpoints kept beside its extremes, so both spikes and
/// held runs survive.
///
/// Bucketing is by point index, not by time: the trace store's samples
/// are roughly time-ordered and roughly uniformly spaced, so index
/// buckets approximate time buckets closely enough, and an index walk is
/// O(n) with no search. Returns at most `4 * max_buckets` points; a
/// `max_buckets` of 0 is treated as "no decimation". If the series
/// already fits in `max_buckets` points it's returned unchanged.
///
/// **Why the endpoints, and not only the extremes.** A min/max envelope
/// keeps each bucket's argmin and argmax *by value*, which summarises a
/// measurement well and loses a held state: a value held across the
/// middle of a bucket whose neighbours carry both a lower and a higher
/// one is neither the argmin nor the argmax, so it is dropped outright.
/// On a 100 Hz enum series that lost a state held for up to 3.21 canvas
/// pixel columns — not drawn coarsely, absent, so no renderer
/// downstream could put it back. Keeping the bucket's first and last
/// sample closes it by construction, and gives this guarantee:
///
/// > every run of equal consecutive samples that spans two buckets
/// > contributes at least one kept sample carrying its value, at every
/// > alignment of the run against the bucket grid
///
/// — because such a run owns the last sample of the bucket it leaves
/// and the first of the one it enters. It is also what a **stepped**
/// line needs: a step renderer holds a value to the next sample, so a
/// bucket's last sample is where its step ends. That is why this is the
/// one shared reduction rather than a second, categorical one (ADR
/// 0026).
///
/// The endpoints also keep the rendered line touching both ends of the
/// input series, which matters for plots: a plot panel passes a slice
/// `[from, to)` plus one boundary sample on each side so the line spans
/// the full visible x range. Without them the boundary sample can lose
/// its bucket's argmin/argmax race and get dropped — visible as the line
/// "ending one bin early" inside the canvas.
#[must_use]
pub fn decimate_min_max(points: &[SamplePoint], max_buckets: usize) -> Vec<SamplePoint> {
    let n = points.len();
    if max_buckets == 0 || n <= max_buckets {
        return points.to_vec();
    }
    let bucket = n.div_ceil(max_buckets);
    let mut out = Vec::with_capacity(4 * max_buckets);
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
        // The bucket's four kept indices, emitted in index order and
        // deduplicated: a flat bucket collapses to its first and last,
        // and a one-sample bucket to that sample.
        let mut keep = [0, lo.min(hi), lo.max(hi), slice.len() - 1];
        keep.sort_unstable();
        let mut prev: Option<usize> = None;
        for i in keep {
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
            bus_id: None,
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
                SamplePoint {
                    t_seconds: 1.0,
                    value: 1.0
                },
                SamplePoint {
                    t_seconds: 2.0,
                    value: 2.0
                },
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
        assert_eq!(
            pts,
            vec![SamplePoint {
                t_seconds: 1.0,
                value: 2.0
            }]
        );
    }

    /// [`sample_shared`] decodes the one frame it is given for several
    /// names at once, and rejects every case [`sample_signal`] skips:
    /// wrong id, wrong extended flag, payload too short, unknown
    /// signal, malformed message id.
    #[test]
    fn sample_shared_decodes_a_frame_and_rejects_the_skip_cases() {
        let db = Database::parse(DBC).unwrap();
        let dbs: &[&Database] = &[&db];
        let mut out = Vec::new();
        let good = frame(1_000_000_000, 256, vec![0x04, 0x00]);
        // The decodable name and an unknown one, answered in one pass
        // and index-parallel with the request.
        sample_shared(
            &good,
            dbs,
            256,
            false,
            &["EngineSpeed", "Nope"],
            &[],
            &mut out,
        );
        assert_eq!(out, vec![Some(1.0), None]);
        // Wrong id / wrong extended flag — the frame filter. The
        // extended case is checked in the direction the decoder can't
        // catch on its own: an *extended* frame carrying the same raw
        // id decodes fine against the standard message, so only the
        // frame filter keeps it out of a standard query's series.
        sample_shared(&good, dbs, 257, false, &["EngineSpeed"], &[], &mut out);
        assert_eq!(out, vec![None]);
        sample_shared(&good, dbs, 256, true, &["EngineSpeed"], &[], &mut out);
        assert_eq!(out, vec![None]);
        let ext = RawTraceFrame {
            extended: true,
            ..good.clone()
        };
        sample_shared(&ext, dbs, 256, false, &["EngineSpeed"], &[], &mut out);
        assert_eq!(out, vec![None]);
        // A frame *of* another id, asked for under its own id, but the
        // DBC doesn't define it.
        let other = frame(1_000_000_000, 257, vec![0xFF, 0xFF]);
        sample_shared(&other, dbs, 257, false, &["EngineSpeed"], &[], &mut out);
        assert_eq!(out, vec![None]);
        // Payload too short for the signal.
        let short = frame(2_000_000_000, 256, vec![0x04]);
        sample_shared(&short, dbs, 256, false, &["EngineSpeed"], &[], &mut out);
        assert_eq!(out, vec![None]);
        // A malformed standard id, and the empty request.
        sample_shared(
            &good,
            dbs,
            0xFFFF_FFFF,
            false,
            &["EngineSpeed"],
            &[],
            &mut out,
        );
        assert_eq!(out, vec![None]);
        sample_shared(&good, dbs, 256, false, &[], &[], &mut out);
        assert!(out.is_empty());
    }

    /// The critical rule of the shared pass: a name takes the first
    /// database that yields **it**, which is not necessarily the first
    /// database that defines the message.
    #[test]
    fn sample_shared_resolves_each_name_against_its_own_first_database() {
        // `first` defines the message with only `A`; `second` defines
        // `A` at ten times the scale plus a `B` the first one lacks.
        let head = "VERSION \"\"\nNS_ :\nBS_:\nBU_: ECU\n";
        let first = Database::parse(&format!(
            "{head}BO_ 256 M: 8 ECU\n SG_ A : 0|16@1+ (1,0) [0|0] \"\" ECU\n"
        ))
        .unwrap();
        let second = Database::parse(&format!(
            "{head}BO_ 256 M: 8 ECU\n SG_ A : 0|16@1+ (10,0) [0|0] \"\" ECU\n \
             SG_ B : 16|16@1+ (1,0) [0|0] \"\" ECU\n"
        ))
        .unwrap();
        let f = frame(0, 256, vec![3, 0, 7, 0, 0, 0, 0, 0]);
        let mut out = Vec::new();
        sample_shared(
            &f,
            &[&first, &second],
            256,
            false,
            &["A", "B"],
            &[],
            &mut out,
        );
        assert_eq!(
            out,
            vec![Some(3.0), Some(7.0)],
            "A from the first database, B from the second",
        );
        // Load order is the whole rule: reversed, `A` takes the ×10
        // scaling of what is now the first database.
        sample_shared(
            &f,
            &[&second, &first],
            256,
            false,
            &["A", "B"],
            &[],
            &mut out,
        );
        assert_eq!(out, vec![Some(30.0), Some(7.0)]);

        // A pinned name takes the database the pick names, whatever
        // load order says — and only that name: `B` still resolves the
        // ordinary way in the same pass.
        sample_shared(
            &f,
            &[&first, &second],
            256,
            false,
            &["A", "B"],
            &[Some(1), None],
            &mut out,
        );
        assert_eq!(out, vec![Some(30.0), Some(7.0)]);

        // A pinned name takes its value from that database or from
        // none: `first` cannot produce `B`, so pinning `B` to it leaves
        // the slot empty rather than falling through to `second`.
        sample_shared(
            &f,
            &[&first, &second],
            256,
            false,
            &["A", "B"],
            &[None, Some(0)],
            &mut out,
        );
        assert_eq!(out, vec![Some(3.0), None]);
    }

    fn pt(t: f64, v: f64) -> SamplePoint {
        SamplePoint {
            t_seconds: t,
            value: v,
        }
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
    fn decimate_keeps_bucket_extrema_in_time_order_with_endpoints() {
        // 6 points, 2 buckets of 3. Bucket 0 = [10, 1, 5]: first =
        // 10@t0, min = 1@t1, max = 10@t0, last = 5@t2 → emit
        // [10@t0, 1@t1, 5@t2]. Bucket 1 = [3, 9, 4]: first = 3@t3,
        // min = 3@t3, max = 9@t4, last = 4@t5 → emit
        // [3@t3, 9@t4, 4@t5].
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
                pt(2.0, 5.0),
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
    fn decimate_collapses_flat_bucket_to_its_endpoints() {
        let pts = vec![pt(0.0, 7.0), pt(1.0, 7.0), pt(2.0, 7.0), pt(3.0, 7.0)];
        // A flat bucket's min and max are both its first sample, so
        // each bucket collapses to its own first and last — which is
        // also what a stepped renderer needs to know where the held
        // run starts and where it ends.
        assert_eq!(
            decimate_min_max(&pts, 2),
            vec![pt(0.0, 7.0), pt(1.0, 7.0), pt(2.0, 7.0), pt(3.0, 7.0)],
        );
    }

    /// The guarantee a stepped renderer rests on: **a run of equal
    /// consecutive samples that spans two buckets contributes at least
    /// one kept sample carrying its value, at every alignment of the run
    /// against the bucket grid.**
    ///
    /// A min/max envelope alone cannot promise that. It keeps a bucket's
    /// argmin and argmax *by value*, so a code held across the middle of
    /// a bucket whose neighbours carry both a lower and a higher code is
    /// neither, and vanishes — measured at up to 3.21 canvas pixel
    /// columns wide on a 100 Hz enum series. Keeping each bucket's first
    /// and last sample closes it: a run that crosses a bucket boundary
    /// owns the last sample of the bucket it leaves and the first of the
    /// one it enters.
    ///
    /// The held code is `3` against a background cycling `0..=5`, which
    /// is the adversarial case — strictly between the codes its bucket
    /// neighbours carry, so neither the bucket's argmin nor its argmax.
    #[test]
    #[allow(clippy::float_cmp, clippy::cast_precision_loss)]
    fn a_run_spanning_two_buckets_survives_at_every_alignment() {
        const N: usize = 600;
        const MAX_BUCKETS: usize = 100;
        const HELD: f64 = 3.0;
        let bucket = N.div_ceil(MAX_BUCKETS);
        for hold in 2..=bucket + 1 {
            for start in 0..3 * bucket {
                let pts: Vec<SamplePoint> = (0..N)
                    .map(|i| {
                        let v = if i >= start && i < start + hold {
                            HELD
                        } else {
                            (i % 6) as f64
                        };
                        pt(i as f64, v)
                    })
                    .collect();
                let out = decimate_min_max(&pts, MAX_BUCKETS);
                let carried = out.iter().any(|p| {
                    p.value == HELD
                        && p.t_seconds >= start as f64
                        && p.t_seconds < (start + hold) as f64
                });
                if start / bucket != (start + hold - 1) / bucket {
                    assert!(
                        carried,
                        "hold {hold} at {start} spans two buckets but no kept sample carries it",
                    );
                }
            }
        }
    }

    #[test]
    fn decimate_bounds_output_size() {
        let pts: Vec<SamplePoint> = (0..1000)
            .map(|i| pt(f64::from(i), f64::from((i * 7) % 13)))
            .collect();
        let out = decimate_min_max(&pts, 50);
        // Bound is `4 * max_buckets`: each bucket keeps its first,
        // last, min and max.
        assert!(out.len() <= 200, "got {}", out.len());
        assert!(out.len() >= 50);
        // Endpoints make it through.
        assert_eq!(out.first().map(|p| p.t_seconds), Some(0.0));
        assert_eq!(out.last().map(|p| p.t_seconds), Some(999.0));
    }
}
