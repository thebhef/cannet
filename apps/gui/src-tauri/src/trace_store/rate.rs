//! Rate estimation for the trace store.
//!
//! Rates are computed from per-frame `timestamp_ns` (the bus-side arrival
//! time the driver stamped), not from when the frame was appended — see the
//! module-level docs on [`super`] for why. Two shapes live here: the
//! per-id windowed [`RateEstimate`] (with its silence-decay fallback) and
//! the bucket-scoped [`RateTrack`] the aggregate / per-bus / per-direction
//! throughput readouts share, both sampled and pruned the same way.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use super::{Inner, TraceStore};

/// How far back the rate estimator looks. One second is short enough
/// that a stalled stream registers immediately and long enough that
/// per-batch jitter (256-frame batches at 60+ fps) doesn't bounce the
/// reading around.
pub(super) const RATE_WINDOW: Duration = Duration::from_secs(1);

/// Minimum spacing between rate samples. At a multi-thousand-frame/s
/// replay a per-frame sample would pile up tens of thousands of deque
/// entries each second; bounding the cadence caps the deque at roughly
/// `RATE_WINDOW / RATE_SAMPLE_INTERVAL` entries while still tracking
/// the rate closely enough for a status line.
pub(super) const RATE_SAMPLE_INTERVAL: Duration = Duration::from_millis(20);

/// Per-id message-rate estimate: a windowed frame count — the same
/// count-delta-over-frame-time-span read as the aggregate
/// [`rate_from_samples`] — plus a last-inter-frame-delta fallback for
/// ids slower than [`RATE_WINDOW`].
///
/// The windowed read is what keeps the displayed rate independent of
/// *delivery* timing: rx frames land in sidecar batches, so any
/// estimate that keys off wall time since the last append reads low
/// whenever it's sampled inside a delivery gap (the by-id panel showed
/// rx ids well under their wire rate while identically-paced tx
/// confirms — appended smoothly in-process — read true). A count over
/// the window doesn't care when inside the window the frames landed.
#[derive(Debug, Clone)]
pub(super) struct RateEstimate {
    last_ts_ns: u64,
    last_wall: Instant,
    /// Frame-time delta between the two most recent frames, seconds.
    /// The fallback cadence when the sample window holds fewer than two
    /// samples (id slower than the window, or gone quiet).
    last_dt_secs: f64,
    pub(super) count: u64,
    /// Rolling `(wall, ts_ns, count)` window, recorded at most every
    /// [`RATE_SAMPLE_INTERVAL`] and pruned to [`RATE_WINDOW`] on
    /// append — bounded per id like the aggregate deque.
    samples: VecDeque<RateSample>,
}

impl RateEstimate {
    pub(super) fn first_seen(ts_ns: u64, now: Instant) -> Self {
        Self {
            last_ts_ns: ts_ns,
            last_wall: now,
            last_dt_secs: 0.0,
            count: 0,
            samples: VecDeque::new(),
        }
    }

    /// Fold in a new frame stamped at `ts_ns` and appended at wall-time
    /// `now`.
    #[allow(clippy::cast_precision_loss)] // ns diffs fit comfortably in f64's mantissa.
    pub(super) fn observe(&mut self, ts_ns: u64, now: Instant) {
        self.count = self.count.saturating_add(1);
        let dt = ts_ns.saturating_sub(self.last_ts_ns) as f64 / 1e9;
        if dt > 0.0 {
            self.last_dt_secs = dt;
        }
        self.last_ts_ns = ts_ns;
        self.last_wall = now;
        sample_if_due(
            &mut self.samples,
            now,
            ts_ns,
            usize::try_from(self.count).unwrap_or(usize::MAX),
        );
    }

    /// Messages/second as of wall-time `now`: the count delta over the
    /// frame-time span of the samples still inside [`RATE_WINDOW`]
    /// (skipping stale ones without mutating — reads hold the map by
    /// shared reference). With fewer than two in-window samples, falls
    /// back to the last inter-frame delta, decaying on wall-clock
    /// silence so a stalled id still visibly drops toward zero. `0.0`
    /// until two frames have been seen.
    #[allow(clippy::cast_precision_loss)] // counts and ns diffs fit in f64's mantissa.
    pub(super) fn rate(&self, now: Instant) -> f64 {
        let first = self
            .samples
            .iter()
            .find(|s| now.duration_since(s.wall) <= RATE_WINDOW);
        if let (Some(first), Some(last)) = (first, self.samples.back()) {
            let frames = last.count.saturating_sub(first.count);
            let span = last.ts_ns.saturating_sub(first.ts_ns) as f64 / 1e9;
            if frames > 0 && span > 0.0 {
                return frames as f64 / span;
            }
        }
        // A positive `last_dt_secs` implies two distinct timestamps have
        // been seen — the "no estimate until two frames" gate.
        if self.last_dt_secs > 0.0 {
            let since = now.duration_since(self.last_wall).as_secs_f64();
            return 1.0 / since.max(self.last_dt_secs);
        }
        0.0
    }
}

/// One entry in a rate-sample deque. `wall` is the append's wall-clock
/// time (used to prune the window so a stalled stream visibly drops to
/// zero); `ts_ns` is the frame's bus-side timestamp (used to compute the
/// rate, so batching jitter doesn't bounce the reading); `count` is the
/// running frame total at that point.
#[derive(Debug, Clone, Copy)]
pub(super) struct RateSample {
    pub(super) wall: Instant,
    pub(super) ts_ns: u64,
    pub(super) count: usize,
}

/// A rolling frames/second tracker: a running frame count plus its
/// rate-sample history, sampled and pruned via [`sample_if_due`]. One per
/// bucket — the aggregate ([`super::Inner::agg_rate`]), per-bus
/// ([`TraceStore::frames_per_second_by_bus`]), and per-direction
/// ([`TraceStore::frames_per_second_by_direction`]) throughput readouts all
/// share this one shape, so each reads a scoped rate the same way.
#[derive(Default)]
pub(super) struct RateTrack {
    pub(super) count: usize,
    pub(super) samples: VecDeque<RateSample>,
}

impl RateTrack {
    /// Fold in one appended frame stamped at `ts_ns` (wall-time `now`):
    /// bump the running count and record a rate sample if the cadence gate
    /// allows. The single sampling path the aggregate, per-bus, and
    /// per-direction trackers all use.
    pub(super) fn observe(&mut self, ts_ns: u64, now: Instant) {
        self.observe_weighted(ts_ns, now, 1);
    }

    /// The same fold, counting `weight` rather than one. Bus load is the
    /// same windowed read as a frame rate over a different unit — bit
    /// times instead of frames — so it shares the sampling and pruning
    /// rather than growing a second, subtly different window.
    pub(super) fn observe_weighted(&mut self, ts_ns: u64, now: Instant, weight: u64) {
        self.count = self
            .count
            .saturating_add(usize::try_from(weight).unwrap_or(usize::MAX));
        sample_if_due(&mut self.samples, now, ts_ns, self.count);
    }
}

/// Record a `(now, ts_ns, count)` sample onto `samples` if at least
/// [`RATE_SAMPLE_INTERVAL`] has passed since the last one, then prune the
/// window to [`RATE_WINDOW`]. The shared sample-cadence gate behind every
/// rate deque — the aggregate/bucket [`RateTrack`]s and the per-id
/// [`RateEstimate`] alike — so the "sample at most every interval, prune on
/// each touch" rule lives in exactly one place.
fn sample_if_due(samples: &mut VecDeque<RateSample>, now: Instant, ts_ns: u64, count: usize) {
    let due = match samples.back() {
        Some(last) => now.duration_since(last.wall) >= RATE_SAMPLE_INTERVAL,
        None => true,
    };
    if due {
        samples.push_back(RateSample {
            wall: now,
            ts_ns,
            count,
        });
        prune_rate_samples(samples, now);
    }
}

pub(super) fn prune_rate_samples(samples: &mut VecDeque<RateSample>, now: Instant) {
    while let Some(front) = samples.front() {
        if now.duration_since(front.wall) > RATE_WINDOW {
            samples.pop_front();
        } else {
            break;
        }
    }
}

#[allow(clippy::cast_precision_loss)] // counts and ns diffs fit in f64's mantissa.
fn rate_from_samples(samples: &VecDeque<RateSample>) -> f64 {
    let (Some(first), Some(last)) = (samples.front(), samples.back()) else {
        return 0.0;
    };
    let dt = last.ts_ns.saturating_sub(first.ts_ns) as f64 / 1e9;
    if dt <= 0.0 {
        return 0.0;
    }
    let delta = (last.count.saturating_sub(first.count)) as f64;
    delta / dt
}

// The rate readouts are split into an inner-taking helper plus a
// locking wrapper so [`TraceStore::status_snapshot`] can take all of
// them in a single lock acquisition.

pub(super) fn agg_fps(inner: &mut Inner, now: Instant) -> f64 {
    prune_rate_samples(&mut inner.agg_rate.samples, now);
    rate_from_samples(&inner.agg_rate.samples)
}

pub(super) fn by_bus_fps(inner: &mut Inner, now: Instant) -> Vec<(String, f64)> {
    let mut out: Vec<(String, f64)> = inner
        .per_bus
        .iter_mut()
        .map(|(bus, br)| {
            prune_rate_samples(&mut br.samples, now);
            (bus.clone(), rate_from_samples(&br.samples))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Bit times per second per logical bus, split by the rate each part is
/// clocked at: `(bus, arbitration_bits_per_second, data_bits_per_second)`.
///
/// The numerator, not the percentage: the store knows what went over the
/// wire, and only the session knows what bitrate the wire is running at.
/// Combining the two is the bus-health model's job.
pub(super) fn by_bus_bits(inner: &mut Inner, now: Instant) -> Vec<(String, f64, f64)> {
    let mut out: Vec<(String, f64, f64)> = inner
        .per_bus_arb_bits
        .iter_mut()
        .map(|(bus, br)| {
            prune_rate_samples(&mut br.samples, now);
            (bus.clone(), rate_from_samples(&br.samples), 0.0)
        })
        .collect();
    for (bus, br) in &mut inner.per_bus_data_bits {
        prune_rate_samples(&mut br.samples, now);
        let rate = rate_from_samples(&br.samples);
        match out.iter_mut().find(|(b, _, _)| b == bus) {
            Some(entry) => entry.2 = rate,
            None => out.push((bus.clone(), 0.0, rate)),
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

pub(super) fn by_direction_fps(inner: &mut Inner, now: Instant) -> (f64, f64) {
    prune_rate_samples(&mut inner.rx_rate.samples, now);
    prune_rate_samples(&mut inner.tx_rate.samples, now);
    let rx = rate_from_samples(&inner.rx_rate.samples);
    let tx = rate_from_samples(&inner.tx_rate.samples);
    (rx, tx)
}

impl TraceStore {
    /// Estimated current append rate in frames per second.
    #[must_use]
    pub fn frames_per_second(&self) -> f64 {
        let now = Instant::now();
        let mut inner = self.lock_inner();
        agg_fps(&mut inner, now)
    }

    /// Estimated current append rate per logical bus, in frames per
    /// second. One entry per bus that has received a frame this session
    /// (`None` = the unassigned bucket), sorted by bus (`None` first,
    /// then by name). Lets a capture show *which* bus is slowing on a
    /// multi-bus stream rather than only the aggregate.
    #[must_use]
    pub fn frames_per_second_by_bus(&self) -> Vec<(String, f64)> {
        let now = Instant::now();
        let mut inner = self.lock_inner();
        by_bus_fps(&mut inner, now)
    }

    /// Estimated current append rate split by [`cannet_core::Direction`],
    /// as `(rx, tx)` frames per second. Read the same way as the aggregate
    /// [`Self::frames_per_second`] — off the rolling sample window — but
    /// on direction-scoped buckets, so a transmit stall (tx falling while
    /// rx holds, or vice versa) is visible where the merged aggregate
    /// would hide it.
    #[must_use]
    pub fn frames_per_second_by_direction(&self) -> (f64, f64) {
        let now = Instant::now();
        let mut inner = self.lock_inner();
        by_direction_fps(&mut inner, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace_store::test_support::{dummy, dummy_on_bus, dummy_tx};
    use crate::trace_store::TraceStore;

    #[test]
    #[allow(clippy::float_cmp)] // 0.0 is the exact "no estimate yet" sentinel.
    fn per_id_rate_is_zero_until_two_frames_then_estimates_and_decays() {
        let t0 = Instant::now();
        let mut r = RateEstimate::first_seen(0, t0);
        assert_eq!(r.rate(t0), 0.0); // one frame: no estimate yet
                                     // Second frame: 100 ms apart in *frame time*, but the wall clock
                                     // hasn't advanced at all (simulates batched arrival). Rate must
                                     // reflect the frame-time interval, not the wall-clock one.
        r.observe(100_000_000, t0);
        assert!((r.rate(t0) - 10.0).abs() < 1e-6);
        // No further frames: a second of wall time later the estimate
        // decays toward 1/s (stall behavior keyed off wall clock so a
        // dead stream visibly drops to zero).
        assert!((r.rate(t0 + Duration::from_secs(1)) - 1.0).abs() < 1e-3);
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn per_id_rate_uses_frame_timestamp_not_batch_arrival() {
        // Regression: a periodic 100 Hz message that gets batched on
        // the rx pump arrives at the store with wall-clock intervals
        // close to zero (batches land tens of millis apart, each with
        // many frames inside). The bus-side cadence is 10 ms; the
        // rate must report that, not the batch shape.
        let store = TraceStore::new();
        for i in 0u64..20 {
            // Frame timestamps step 10 ms apart; wall clock barely
            // moves between appends (which the real pump does too).
            store.append(dummy(i * 10_000_000, 0x100));
        }
        let rows = store.latest_since(0);
        let rate = rows.iter().find(|r| r.frame.id == 0x100).unwrap().rate;
        // Allow a wide tolerance — EMA hasn't fully settled at 20 samples.
        assert!(
            (rate - 100.0).abs() < 10.0,
            "expected ~100/s from 10-ms frame-time gaps, got {rate}",
        );
    }

    #[test]
    fn per_id_rate_is_steady_across_delivery_gaps() {
        // Regression for the by-id msg/s rx bias: a 100 Hz message whose
        // frames are *delivered* in bursts (sidecar batch flush + pump)
        // has smooth 10-ms frame timestamps but wall-clock append gaps of
        // ~100 ms. Sampled mid-gap — where the panel's refresh usually
        // lands — the rate must read the wire cadence (~100/s), not decay
        // toward 1/gap. The old EMA + wall-decay estimate read ~67 here
        // while the tx side (appended smoothly in-process) read ~100,
        // showing rx "way fewer" than tx for identical wire traffic.
        let t0 = Instant::now();
        let mut r = RateEstimate::first_seen(0, t0);
        let mut ts = 0u64;
        for burst in 0..12u64 {
            let wall = t0 + Duration::from_millis(burst * 100);
            for _ in 0..10 {
                ts += 10_000_000;
                r.observe(ts, wall);
            }
        }
        // 15 ms after the last burst landed.
        let rate = r.rate(t0 + Duration::from_millis(11 * 100 + 15));
        assert!(
            (rate - 100.0).abs() < 5.0,
            "expected ~100/s across delivery gaps, got {rate}",
        );
    }

    #[test]
    fn per_id_rate_for_an_id_slower_than_the_window_reads_its_period() {
        // A 0.2 Hz id (5 s period) can never have two frames inside the
        // 1 s rate window; the estimate falls back to the last
        // inter-frame delta, and decays only once the id goes silent
        // longer than that period.
        let t0 = Instant::now();
        let mut r = RateEstimate::first_seen(0, t0);
        r.observe(5_000_000_000, t0 + Duration::from_secs(5));
        r.observe(10_000_000_000, t0 + Duration::from_secs(10));
        assert!((r.rate(t0 + Duration::from_secs(12)) - 0.2).abs() < 0.01);
        assert!((r.rate(t0 + Duration::from_secs(20)) - 0.1).abs() < 0.01);
    }

    #[test]
    #[allow(clippy::float_cmp)] // 0.0 is the exact no-samples sentinel.
    fn rate_is_zero_with_no_samples() {
        let store = TraceStore::new();
        assert_eq!(store.frames_per_second(), 0.0);
    }

    #[test]
    fn frames_per_second_reports_the_aggregate_rate() {
        // Two aggregate samples, the second taken after a wall gap longer
        // than RATE_SAMPLE_INTERVAL (so it actually records), with frame
        // timestamps 100 ms apart and a count delta of 1 → (2 − 1) / 0.1 s
        // = 10 frames/s. Like the per-bus/per-direction cases, the rate is
        // read off the frame timestamps, not wall time; the sleep only
        // guarantees the second sample is due.
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        std::thread::sleep(Duration::from_millis(30));
        store.append(dummy(100_000_000, 2));
        let rate = store.frames_per_second();
        assert!((rate - 10.0).abs() < 1.0, "expected ~10/s, got {rate}");
    }

    #[test]
    #[allow(clippy::float_cmp)] // 0.0 is the exact "no data phase ran" sentinel.
    fn bits_per_second_by_bus_reads_the_wire_not_the_frame_count() {
        // The whole point of a second unit: two buses at the *same* frame
        // rate load the wire differently when their frames differ in
        // size. Eight payload bytes is 64 bit times on top of the 47 a
        // standard frame costs anyway, so bus B occupies 111/47 of what
        // bus A does while both carry the same number of frames.
        let store = TraceStore::new();
        let payload = |ts: u64, bus: &str, len: usize| {
            let mut f = dummy_on_bus(ts, 1, bus);
            f.payload = cannet_core::CanFramePayload::Classic(vec![0; len]);
            f
        };
        store.append(payload(0, "A", 0));
        store.append(payload(0, "B", 8));
        std::thread::sleep(std::time::Duration::from_millis(30));
        store.append(payload(100_000_000, "A", 0));
        store.append(payload(100_000_000, "B", 8));

        let snap = store.status_snapshot();
        let bits = |bus: &str| {
            snap.bits_per_second_by_bus
                .iter()
                .find(|(b, _, _)| b == bus)
                .map(|(_, arb, data)| (*arb, *data))
                .unwrap()
        };
        // One frame's worth of bits over the 100 ms between the samples.
        assert!((bits("A").0 - 470.0).abs() < 1.0, "{:?}", bits("A"));
        assert!((bits("B").0 - 1110.0).abs() < 1.0, "{:?}", bits("B"));
        // The control: neither bus is CAN FD, so nothing is charged to a
        // data phase that never ran.
        assert_eq!(bits("A").1, 0.0);
        assert_eq!(bits("B").1, 0.0);
        // And the frame rates are identical, which is what makes the two
        // readings different measurements rather than the same one twice.
        let fps = |bus: &str| {
            snap.frames_per_second_by_bus
                .iter()
                .find(|(b, _)| b == bus)
                .map(|(_, r)| *r)
                .unwrap()
        };
        assert!((fps("A") - fps("B")).abs() < 1e-9);
    }

    #[test]
    fn a_bitrate_switched_fd_frame_splits_its_bits_across_the_two_phases() {
        let store = TraceStore::new();
        let fd = |ts: u64| {
            let mut f = dummy_on_bus(ts, 1, "A");
            f.payload = cannet_core::CanFramePayload::Fd {
                data: vec![0; 64],
                flags: cannet_core::CanFdFlags {
                    bitrate_switch: true,
                    error_state_indicator: false,
                },
            };
            f
        };
        store.append(fd(0));
        std::thread::sleep(std::time::Duration::from_millis(30));
        store.append(fd(100_000_000));
        let snap = store.status_snapshot();
        let (_, arb, data) = snap.bits_per_second_by_bus[0].clone();
        assert!((arb - 470.0).abs() < 1.0, "{arb}");
        assert!((data - 5370.0).abs() < 1.0, "{data}");
    }

    #[test]
    fn frames_per_second_by_bus_is_empty_with_no_frames() {
        let store = TraceStore::new();
        assert!(store.frames_per_second_by_bus().is_empty());
    }

    #[test]
    fn frames_per_second_by_bus_buckets_each_bus_separately() {
        // Each logical bus is tracked independently; the result is
        // sorted by name. There is no unassigned bucket — the store
        // holds no frame that lacks a bus.
        let store = TraceStore::new();
        store.append(dummy_on_bus(0, 1, "A"));
        store.append(dummy_on_bus(0, 2, "B"));
        store.append(dummy_on_bus(0, 3, "C"));
        let buses: Vec<String> = store
            .frames_per_second_by_bus()
            .into_iter()
            .map(|(b, _)| b)
            .collect();
        assert_eq!(buses, vec!["A".to_string(), "B".into(), "C".into()]);
    }

    #[test]
    fn frames_per_second_by_bus_reports_a_per_bus_rate() {
        // Two samples on bus A, the second taken after a wall gap longer
        // than RATE_SAMPLE_INTERVAL (so it's actually recorded), with
        // frame timestamps 100 ms apart and a count delta of 1 →
        // (2 − 1) / 0.1 s = 10 frames/s. The sleep is what guarantees the
        // second sample is due; the rate itself is read off the frame
        // timestamps, not wall time.
        let store = TraceStore::new();
        store.append(dummy_on_bus(0, 1, "A"));
        std::thread::sleep(std::time::Duration::from_millis(30));
        store.append(dummy_on_bus(100_000_000, 1, "A"));
        let rate = store
            .frames_per_second_by_bus()
            .into_iter()
            .find(|(b, _)| b == "A")
            .expect("bus A present")
            .1;
        assert!((rate - 10.0).abs() < 1.0, "expected ~10/s, got {rate}");
    }

    #[test]
    fn frames_per_second_by_direction_splits_rx_and_tx() {
        // Rx and Tx are tracked in separate buckets. Two frames per
        // direction, the second taken after a wall gap longer than
        // RATE_SAMPLE_INTERVAL so it actually records; the rate reads off
        // the frame-time deltas. Rx steps 100 ms (→10/s); Tx steps 50 ms
        // (→20/s) — distinct rates prove the buckets don't bleed.
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        store.append(dummy_tx(0, 2));
        std::thread::sleep(Duration::from_millis(30));
        store.append(dummy(100_000_000, 1));
        store.append(dummy_tx(50_000_000, 2));
        let (rx, tx) = store.frames_per_second_by_direction();
        assert!((rx - 10.0).abs() < 2.0, "expected rx ~10/s, got {rx}");
        assert!((tx - 20.0).abs() < 3.0, "expected tx ~20/s, got {tx}");
    }

    #[test]
    #[allow(clippy::float_cmp)] // 0.0 is the exact "no frames this direction" sentinel.
    fn frames_per_second_by_direction_is_zero_for_an_unseen_direction() {
        // Only Rx frames have arrived: rx estimates, tx is exactly zero.
        let store = TraceStore::new();
        store.append(dummy(0, 1));
        std::thread::sleep(Duration::from_millis(30));
        store.append(dummy(100_000_000, 1));
        let (rx, tx) = store.frames_per_second_by_direction();
        assert!(rx > 0.0, "rx should estimate, got {rx}");
        assert_eq!(tx, 0.0);
    }
}
