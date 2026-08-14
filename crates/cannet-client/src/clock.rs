//! Measuring how far a server's clock is from ours.
//!
//! Every frame on the cannet wire carries Unix-epoch nanoseconds
//! stamped by whichever host produced it. On one machine that is
//! exact. Across machines it is only as good as whatever the two hosts
//! are independently doing about their clocks, and a server four
//! seconds off produces frames four seconds out of place in the trace
//! with nothing on the wire to say so.
//!
//! This module turns that into a measured number. It is the algorithm
//! of SNTP (RFC 4330 § 5) — the standard answer to this exact question
//! — run over the `Session` stream we already have open rather than
//! over NTP's UDP transport:
//!
//! | stamp | clock | when |
//! |---|---|---|
//! | `t1` | client | the probe left us |
//! | `t2` | server | the probe arrived there |
//! | `t3` | server | the reply left there |
//! | `t4` | client | the reply arrived here |
//!
//! from which
//!
//! ```text
//! θ = ((t2 − t1) + (t3 − t4)) / 2      offset: server clock − ours
//! δ = (t4 − t1) − (t3 − t2)            round-trip delay
//! ```
//!
//! θ is exact when the path is symmetric, and wrong by half the
//! asymmetry when it is not — so several exchanges are run and the one
//! with the smallest δ is kept, that being the exchange least likely
//! to have been distorted by a queue in one direction. That selection
//! rule is the whole reason the wire carries a delay at all, and it is
//! what lets a relaying proxy sit in the path without biasing the
//! answer.
//!
//! ## Why the arithmetic is signed and wide
//!
//! The wire stamps are `uint64` epoch nanoseconds — around 1.76 × 10¹⁸
//! today. A server whose clock is *behind* ours makes `t2 < t1`, so
//! computing `t2 - t1` in the wire's own type underflows and turns a
//! −4 s offset into roughly +584 years. Every difference here is
//! taken in `i128`, which cannot overflow for any pair of `u64`
//! inputs, and only the final results are narrowed.

use std::sync::{Arc, Mutex};

/// One completed probe exchange, reduced to the two numbers RFC 4330
/// derives from its four stamps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockSample {
    /// θ — the server's clock minus ours, in nanoseconds. Positive
    /// means the server is ahead.
    pub offset_ns: i64,
    /// δ — the round-trip delay in nanoseconds, never negative (see
    /// [`sample`]).
    pub delay_ns: i64,
}

/// What a session's start-up probe concluded about the peer's clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockOffset {
    /// θ of the least-delayed exchange.
    pub offset_ns: i64,
    /// δ of that same exchange — the error bound on `offset_ns`, which
    /// is good to roughly ±δ/2.
    pub delay_ns: i64,
    /// How many exchanges completed. The measurement is the best of
    /// these, not their average.
    pub samples: u32,
}

/// The state of a session's clock measurement.
///
/// `Unsupported` is a real answer, not a failure: the envelope pair is
/// additive, so a peer built before it existed parses the probe, sees
/// no body it recognises, and never replies. A client must be able to
/// say "this peer cannot be asked" — and must never sit waiting for an
/// answer that is not coming.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockProbeStatus {
    /// Probes are still in flight; the deadline has not passed.
    Pending,
    /// The peer answered.
    Measured(ClockOffset),
    /// The probe window closed with no reply at all.
    Unsupported,
}

/// A session's clock measurement, readable from anywhere that holds a
/// piece of the session.
///
/// Cheap to clone — every clone reads the same measurement. The
/// session's worker publishes into it once, when the probe window
/// closes.
#[derive(Debug, Clone)]
pub struct SessionClock(Arc<Mutex<ClockProbeStatus>>);

impl SessionClock {
    pub(crate) fn pending() -> Self {
        Self(Arc::new(Mutex::new(ClockProbeStatus::Pending)))
    }

    /// What the probe concluded, or [`ClockProbeStatus::Pending`] while
    /// it is still running. Never blocks on the network.
    #[must_use]
    pub fn status(&self) -> ClockProbeStatus {
        self.0.lock().map_or(ClockProbeStatus::Unsupported, |s| *s)
    }

    /// The measured offset, if the probe finished and the peer
    /// answered. A convenience over [`Self::status`] for callers that
    /// only want the number.
    #[must_use]
    pub fn offset(&self) -> Option<ClockOffset> {
        match self.status() {
            ClockProbeStatus::Measured(offset) => Some(offset),
            ClockProbeStatus::Pending | ClockProbeStatus::Unsupported => None,
        }
    }

    /// Close the probe window: publish the best of `samples`, or
    /// `Unsupported` when none arrived.
    pub(crate) fn settle(&self, samples: &[ClockSample]) {
        let status = best_sample(samples).map_or(ClockProbeStatus::Unsupported, |best| {
            ClockProbeStatus::Measured(ClockOffset {
                offset_ns: best.offset_ns,
                delay_ns: best.delay_ns,
                samples: u32::try_from(samples.len()).unwrap_or(u32::MAX),
            })
        });
        if let Ok(mut slot) = self.0.lock() {
            *slot = status;
        }
    }
}

/// Reduce one exchange's four stamps to an offset and a delay
/// (RFC 4330 § 5).
///
/// `t1` and `t4` are on our clock; `t2` and `t3` are on the peer's.
/// Every difference is taken in `i128` — see the module docs for why a
/// `u64` subtraction here is a 584-year bug rather than a small one.
///
/// A computed δ below zero is reported as zero. The RFC notes the
/// computation can come out very small or negative when the two clocks
/// tick at different rates across the exchange; a negative round trip
/// is not physical, and left signed it would win minimum-delay
/// selection every time — turning the *worst* sample into the chosen
/// one.
pub(crate) fn sample(t1: u64, t2: u64, t3: u64, t4: u64) -> ClockSample {
    let (t1, t2, t3, t4) = (
        i128::from(t1),
        i128::from(t2),
        i128::from(t3),
        i128::from(t4),
    );
    // `midpoint` is the halving in θ's definition; which way it breaks
    // a sub-nanosecond tie does not matter at the scale of anything
    // this measures.
    let offset = i128::midpoint(t2 - t1, t3 - t4);
    let delay = (t4 - t1) - (t3 - t2);
    ClockSample {
        offset_ns: narrow(offset),
        delay_ns: narrow(delay.max(0)),
    }
}

/// The exchange least distorted by path asymmetry: the one whose round
/// trip was shortest. Ties keep the earliest, which is the earliest
/// answer we could have acted on.
pub(crate) fn best_sample(samples: &[ClockSample]) -> Option<ClockSample> {
    samples.iter().copied().min_by_key(|s| s.delay_ns)
}

/// Narrow a wide intermediate to the reported type, saturating rather
/// than wrapping. Reaching either bound needs a stamp ~292 years from
/// ours, which is corrupt input, not a clock that is merely wrong —
/// and a saturated value stays obviously absurd instead of wrapping
/// into a plausible-looking one.
fn narrow(value: i128) -> i64 {
    i64::try_from(value).unwrap_or(if value < 0 { i64::MIN } else { i64::MAX })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plausible epoch stamp — big enough that a `u64` subtraction
    /// going the wrong way is catastrophic rather than merely wrong.
    const T1: u64 = 1_760_000_000_000_000_000;
    const MS: u64 = 1_000_000;

    #[test]
    fn a_symmetric_exchange_recovers_the_offset_exactly() {
        // Server 4 s ahead, 10 ms each way, 1 ms of server handling.
        let t2 = T1 + 10 * MS + 4_000_000_000;
        let t3 = t2 + MS;
        let t4 = T1 + 21 * MS;
        let s = sample(T1, t2, t3, t4);
        assert_eq!(s.offset_ns, 4_000_000_000);
        // δ is the round trip *without* the server's handling time —
        // that is what makes it a measure of the path.
        assert_eq!(s.delay_ns, 20 * 1_000_000);
    }

    #[test]
    fn a_server_behind_us_reports_a_negative_offset() {
        // The case a naive `t2 - t1` on the wire's own u64 turns into
        // roughly +584 years instead of −4 s.
        let t2 = T1 + 10 * MS - 4_000_000_000;
        let t3 = t2 + MS;
        let t4 = T1 + 21 * MS;
        assert!(t2 < T1, "the test is only meaningful if t2 precedes t1");
        assert!(
            T1.checked_sub(0).is_some() && t2.wrapping_sub(T1) > u64::MAX / 2,
            "an unsigned t2 - t1 here really does wrap: {}",
            t2.wrapping_sub(T1)
        );
        let s = sample(T1, t2, t3, t4);
        assert_eq!(s.offset_ns, -4_000_000_000);
        assert_eq!(s.delay_ns, 20 * 1_000_000);
    }

    #[test]
    fn clocks_in_sync_report_no_offset() {
        let t2 = T1 + 10 * MS;
        let t3 = t2 + MS;
        let t4 = T1 + 21 * MS;
        let s = sample(T1, t2, t3, t4);
        assert_eq!(s.offset_ns, 0);
    }

    #[test]
    fn an_asymmetric_path_biases_the_offset_by_half_the_asymmetry() {
        // 30 ms out, 10 ms back: θ is wrong by (30 − 10) / 2 = 10 ms.
        // Pinned because it is the error minimum-delay selection
        // exists to keep small, not a defect to fix here.
        let t2 = T1 + 30 * MS;
        let t3 = t2 + MS;
        let t4 = T1 + 41 * MS;
        let s = sample(T1, t2, t3, t4);
        assert_eq!(s.offset_ns, 10 * 1_000_000);
        assert_eq!(s.delay_ns, 40 * 1_000_000);
    }

    #[test]
    fn a_delay_that_computes_negative_is_reported_as_zero() {
        // Left signed, this sample would win every minimum-delay
        // selection it took part in.
        let t2 = T1 + 10 * MS;
        let t3 = t2 + 50 * MS;
        let t4 = T1 + 21 * MS;
        let s = sample(T1, t2, t3, t4);
        assert_eq!(s.delay_ns, 0);
    }

    #[test]
    fn minimum_delay_selection_takes_the_least_delayed_exchange() {
        let samples = vec![
            ClockSample {
                offset_ns: 4_100_000_000,
                delay_ns: 80 * 1_000_000,
            },
            ClockSample {
                offset_ns: 4_000_000_000,
                delay_ns: 20 * 1_000_000,
            },
            ClockSample {
                offset_ns: 3_500_000_000,
                delay_ns: 500 * 1_000_000,
            },
        ];
        assert_eq!(best_sample(&samples).unwrap().offset_ns, 4_000_000_000);
    }

    #[test]
    fn a_tie_on_delay_keeps_the_earlier_exchange() {
        let samples = vec![
            ClockSample {
                offset_ns: 10,
                delay_ns: 5,
            },
            ClockSample {
                offset_ns: 20,
                delay_ns: 5,
            },
        ];
        assert_eq!(best_sample(&samples).unwrap().offset_ns, 10);
    }

    #[test]
    fn no_exchanges_means_nothing_to_choose() {
        assert!(best_sample(&[]).is_none());
    }

    #[test]
    fn a_stamp_far_enough_out_to_overflow_saturates_rather_than_wrapping() {
        // Corrupt input — a driver stamp millennia away — must stay
        // obviously absurd rather than wrap into something plausible.
        let s = sample(0, u64::MAX, u64::MAX, 0);
        assert_eq!(s.offset_ns, i64::MAX);
    }

    #[test]
    fn settling_with_no_samples_reports_the_peer_as_unsupported() {
        let clock = SessionClock::pending();
        assert_eq!(clock.status(), ClockProbeStatus::Pending);
        clock.settle(&[]);
        assert_eq!(clock.status(), ClockProbeStatus::Unsupported);
        assert!(clock.offset().is_none());
    }

    #[test]
    fn settling_publishes_the_best_sample_and_the_count() {
        let clock = SessionClock::pending();
        clock.settle(&[
            ClockSample {
                offset_ns: 900,
                delay_ns: 90,
            },
            ClockSample {
                offset_ns: 100,
                delay_ns: 10,
            },
        ]);
        assert_eq!(
            clock.offset(),
            Some(ClockOffset {
                offset_ns: 100,
                delay_ns: 10,
                samples: 2,
            })
        );
    }

    #[test]
    fn a_clone_reads_the_same_measurement() {
        // The session worker holds one clone and publishes; the caller
        // holds another and reads.
        let worker = SessionClock::pending();
        let caller = worker.clone();
        worker.settle(&[ClockSample {
            offset_ns: 42,
            delay_ns: 1,
        }]);
        assert_eq!(caller.offset().unwrap().offset_ns, 42);
    }
}
