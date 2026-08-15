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
//!
//! ## Tracking, not a single reading
//!
//! One measurement at session start goes stale. Both hosts may be
//! running NTP or PTP and disciplining their clocks independently while
//! the session is open, so the distance between them moves. A session
//! therefore re-probes on a cadence (see `CLOCK_REPROBE_INTERVAL` in the
//! crate root) — each round is a fresh burst reduced by the same
//! minimum-delay rule, so a round is never worse than the start-up
//! measurement was.
//!
//! A peer that answers *nothing* on its first round is
//! [`ClockProbeStatus::Unsupported`] and is not asked again: it does not
//! know the envelopes exist, and that will not change inside one
//! session. A peer that answered once and then goes quiet keeps its last
//! measurement — silence is a lost round, not a retraction — and is
//! re-probed on the next tick. [`ClockRecord::silent_rounds`] is how a
//! consumer tells a fresh number from an old one.
//! ## Applying it: slewed, not stepped
//!
//! [`OffsetSlew`] is what actually corrects frames, and it deliberately
//! does not jump to each new measurement. See its documentation for the
//! rate, the threshold at which it steps instead, and why the slew is
//! driven by the frame timeline rather than by local elapsed time.

use std::sync::atomic::{AtomicI64, Ordering};
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

/// Everything one session ever learned about its peer's clock — the
/// read surface a status display renders.
///
/// `measured_offset_ns` and `applied_offset_ns` differ whenever the
/// slew is still travelling towards a new measurement; that gap *is*
/// the convergence, not an inconsistency.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockRecord {
    /// The newest round's conclusion.
    pub status: ClockProbeStatus,
    /// θ of the session's *first* successful round — what the peer's
    /// clock was doing when the session opened. `None` if no round has
    /// ever succeeded.
    pub start_offset_ns: Option<i64>,
    /// θ of the newest successful round.
    pub measured_offset_ns: Option<i64>,
    /// What frames leaving this session are actually being corrected
    /// by. Equal to `measured_offset_ns` once the slew has converged.
    pub applied_offset_ns: i64,
    /// δ of the newest successful round — the error bound on
    /// `measured_offset_ns`.
    pub delay_ns: Option<i64>,
    /// Exchanges that completed in the newest successful round.
    pub samples: u32,
    /// Probe rounds attempted, answered or not.
    pub rounds: u32,
    /// Consecutive rounds since the last answer. Non-zero means
    /// `measured_offset_ns` is stale: the peer answered before and has
    /// stopped, so the last good number is still the best available
    /// one.
    pub silent_rounds: u32,
    /// Our wall clock when the newest successful round settled, for a
    /// consumer that wants to show the measurement's age.
    pub measured_at_ns: Option<u64>,
}

/// The mutable half of a [`SessionClock`]. Written once per probe
/// round, so a mutex costs nothing that matters; the applied offset,
/// which moves per frame, lives outside it.
#[derive(Debug)]
struct ClockState {
    status: ClockProbeStatus,
    start: Option<ClockOffset>,
    rounds: u32,
    silent_rounds: u32,
    measured_at_ns: Option<u64>,
}

#[derive(Debug)]
struct ClockInner {
    state: Mutex<ClockState>,
    /// The offset frames are being corrected by right now. Atomic
    /// rather than behind the mutex because the slew advances it on the
    /// frame path, and a lock per frame there would be a real cost for
    /// a number nobody has to read consistently with anything else.
    applied_ns: AtomicI64,
}

/// A session's clock measurement, readable from anywhere that holds a
/// piece of the session.
///
/// Cheap to clone — every clone reads the same measurement. The
/// session's worker publishes a measurement into it at the end of each
/// probe round, and the applied offset as it slews.
#[derive(Debug, Clone)]
pub struct SessionClock(Arc<ClockInner>);

impl SessionClock {
    pub(crate) fn pending() -> Self {
        Self(Arc::new(ClockInner {
            state: Mutex::new(ClockState {
                status: ClockProbeStatus::Pending,
                start: None,
                rounds: 0,
                silent_rounds: 0,
                measured_at_ns: None,
            }),
            applied_ns: AtomicI64::new(0),
        }))
    }

    /// What the newest probe round concluded, or
    /// [`ClockProbeStatus::Pending`] while the first one is still
    /// running. Never blocks on the network.
    #[must_use]
    pub fn status(&self) -> ClockProbeStatus {
        self.0
            .state
            .lock()
            .map_or(ClockProbeStatus::Unsupported, |s| s.status)
    }

    /// The measured offset, if a round has succeeded. A convenience
    /// over [`Self::status`] for callers that only want the number.
    #[must_use]
    pub fn offset(&self) -> Option<ClockOffset> {
        match self.status() {
            ClockProbeStatus::Measured(offset) => Some(offset),
            ClockProbeStatus::Pending | ClockProbeStatus::Unsupported => None,
        }
    }

    /// The offset frames leaving this session are corrected by at this
    /// instant. Zero until the first measurement lands, and travelling
    /// towards [`Self::offset`] whenever the two disagree.
    #[must_use]
    pub fn applied_offset_ns(&self) -> i64 {
        self.0.applied_ns.load(Ordering::Relaxed)
    }

    /// The whole per-session record in one consistent read.
    #[must_use]
    pub fn record(&self) -> ClockRecord {
        let applied_offset_ns = self.applied_offset_ns();
        let Ok(state) = self.0.state.lock() else {
            return ClockRecord {
                status: ClockProbeStatus::Unsupported,
                start_offset_ns: None,
                measured_offset_ns: None,
                applied_offset_ns,
                delay_ns: None,
                samples: 0,
                rounds: 0,
                silent_rounds: 0,
                measured_at_ns: None,
            };
        };
        let latest = match state.status {
            ClockProbeStatus::Measured(offset) => Some(offset),
            ClockProbeStatus::Pending | ClockProbeStatus::Unsupported => None,
        };
        ClockRecord {
            status: state.status,
            start_offset_ns: state.start.map(|o| o.offset_ns),
            measured_offset_ns: latest.map(|o| o.offset_ns),
            applied_offset_ns,
            delay_ns: latest.map(|o| o.delay_ns),
            samples: latest.map_or(0, |o| o.samples),
            rounds: state.rounds,
            silent_rounds: state.silent_rounds,
            measured_at_ns: state.measured_at_ns,
        }
    }

    /// Publish the offset the slew is currently applying.
    pub(crate) fn publish_applied(&self, applied_ns: i64) {
        self.0.applied_ns.store(applied_ns, Ordering::Relaxed);
    }

    /// Close a probe round: fold `samples` down to one measurement and
    /// record it, or account for a round nobody answered.
    ///
    /// Returns the new measurement when there is one, so the caller can
    /// retarget the slew — the two are one decision and should not be
    /// able to drift apart.
    ///
    /// A silent round is only [`ClockProbeStatus::Unsupported`] when it
    /// is also the *first* success-less state: a peer that has answered
    /// before demonstrably speaks the protocol, so its silence keeps the
    /// last measurement rather than discarding it.
    pub(crate) fn settle_round(&self, samples: &[ClockSample], now_ns: u64) -> Option<ClockOffset> {
        let best = best_sample(samples).map(|best| ClockOffset {
            offset_ns: best.offset_ns,
            delay_ns: best.delay_ns,
            samples: u32::try_from(samples.len()).unwrap_or(u32::MAX),
        });
        let Ok(mut state) = self.0.state.lock() else {
            return best;
        };
        state.rounds = state.rounds.saturating_add(1);
        if let Some(offset) = best {
            state.status = ClockProbeStatus::Measured(offset);
            state.measured_at_ns = Some(now_ns);
            state.silent_rounds = 0;
            if state.start.is_none() {
                state.start = Some(offset);
            }
        } else {
            state.silent_rounds = state.silent_rounds.saturating_add(1);
            if state.start.is_none() {
                state.status = ClockProbeStatus::Unsupported;
            }
        }
        best
    }

    /// Whether any round has ever produced a measurement — the test for
    /// "is this peer worth asking again". See [`should_reprobe`].
    pub(crate) fn ever_measured(&self) -> bool {
        self.0.state.lock().is_ok_and(|state| state.start.is_some())
    }
}

/// What a session's probe timer means once it next fires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProbeStep {
    /// A round is open; the timer is its deadline for replies.
    AwaitReplies,
    /// No round is open; the timer is the wait until the next one.
    WaitForNextRound,
    /// Nothing more to time. This peer does not answer.
    Stop,
}

/// The alternation between a session's probe rounds and the gaps
/// between them, kept as a state machine so the one thing worth
/// getting right — that it neither stops tracking a live peer nor
/// questions a deaf one forever — is testable without a session.
///
/// A session drives it with a single timer whose meaning is whatever
/// [`Self::advance`] last returned.
#[derive(Debug)]
pub(crate) struct ProbeRounds {
    in_round: bool,
    armed: bool,
}

impl ProbeRounds {
    /// A session opens with a round already in flight.
    pub(crate) fn new() -> Self {
        Self {
            in_round: true,
            armed: true,
        }
    }

    /// Whether probes should be going out and replies counted right
    /// now. False in the gaps, so a straggling reply from a closed
    /// round cannot join the next one's sample set.
    pub(crate) fn in_round(&self) -> bool {
        self.armed && self.in_round
    }

    /// Whether the timer is still worth polling at all.
    pub(crate) fn armed(&self) -> bool {
        self.armed
    }

    /// The timer fired: close the open round or open the next one, and
    /// say what the timer should be set to now.
    ///
    /// `ever_measured` decides only the one irreversible transition. A
    /// peer that has never answered is not asked again — it does not
    /// recognise the envelopes, and no amount of waiting changes that
    /// inside one session. Every other peer is re-probed for the
    /// session's life, *including* one that has gone quiet: silence
    /// from a peer that demonstrably speaks the protocol is far more
    /// likely to be a busy link than a peer that forgot it.
    pub(crate) fn advance(&mut self, ever_measured: bool) -> ProbeStep {
        if self.in_round {
            self.in_round = false;
            if ever_measured {
                ProbeStep::WaitForNextRound
            } else {
                self.armed = false;
                ProbeStep::Stop
            }
        } else {
            self.in_round = true;
            ProbeStep::AwaitReplies
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

/// How fast the applied offset is allowed to move, in nanoseconds of
/// correction per second of the timeline being corrected.
///
/// 5 ms/s is 0.5 % — a rate chosen from both ends at once:
///
/// - **Fast enough to track.** A host disciplining its clock with NTP
///   slews at up to 500 ppm (0.5 ms/s); two of them can pull apart at
///   twice that. 5 ms/s is an order of magnitude above the worst case,
///   so the applied offset converges on a moving measurement instead of
///   chasing it forever.
/// - **Slow enough to be invisible.** While it is moving, the corrected
///   timeline runs 0.5 % fast or slow. Over the widest trace window
///   anyone reads frame-to-frame — say a second — that is 5 ms of
///   stretch spread across the whole window, and between two adjacent
///   frames a millisecond apart it is 5 µs. Nothing in the view moves.
///
/// The worst error that does *not* step ([`STEP_THRESHOLD_NS`]) closes
/// in 200 s at this rate; a realistic one — tens of milliseconds of
/// drift between re-probes — closes in seconds.
const SLEW_RATE_NS_PER_S: i128 = 5_000_000;

/// The measurement-to-applied gap above which the correction steps
/// instead of slewing.
///
/// Slewing exists so the corrected timeline stays continuous while a
/// small error is worked off. A whole second is not that error: it is
/// an operator noticing a grossly wrong clock and fixing it, or a host
/// finally reaching an NTP server. Slewing that away would take
/// minutes, during which every frame is knowingly placed wrong by an
/// amount we have already measured. Stepping is the honest answer, and
/// the discontinuity it leaves is a true record of what the peer's
/// clock did.
const STEP_THRESHOLD_NS: i128 = 1_000_000_000;

/// The correction actually applied to frames, and the policy that moves
/// it.
///
/// ## Why the slew is driven by the frame timeline
///
/// The obvious design advances the correction on *local elapsed time* —
/// so many milliseconds per second of wall clock. That design cannot
/// promise monotonicity: two frames the server stamped identically but
/// delivered a second apart would come out a slew-step apart, in the
/// wrong order.
///
/// So the offset advances as a function of the stamps themselves. The
/// correction is `raw − applied(raw)`, and because the rate is far
/// below 1 ns per ns, that mapping is strictly increasing: any
/// non-decreasing run of raw stamps stays non-decreasing after
/// correction, whatever the delivery timing was. It also costs no clock
/// read on the frame path, which matters where every frame passes.
///
/// A stamp that does not advance the timeline — an out-of-order arrival
/// across interfaces, or a server whose clock went backwards — does not
/// advance the slew either. Order is preserved as observed; the slew
/// never invents motion the timeline did not have.
///
/// ## The first measurement steps
///
/// Until a round succeeds there is no correction and no corrected
/// timeline to keep continuous, so the first measurement is applied
/// whole. Frames delivered in the ~100 ms before it lands are
/// uncorrected — the alternative is holding frames until a clock is
/// known, which trades a bounded, brief error for an unbounded stall.
#[derive(Debug, Default)]
pub(crate) struct OffsetSlew {
    /// The offset in force, in nanoseconds; positive means the peer is
    /// ahead and stamps are moved back.
    applied_ns: i128,
    /// The newest measurement, which `applied_ns` is travelling to.
    target_ns: i128,
    /// The furthest the timeline has reached, for measuring how much
    /// slew the next frame has earned.
    high_water_ns: Option<u64>,
    /// Whether any measurement has been applied yet.
    established: bool,
}

impl OffsetSlew {
    /// Aim at a freshly measured offset.
    ///
    /// Steps rather than slews for the session's first measurement
    /// (nothing to stay continuous with) and for a gap beyond
    /// [`STEP_THRESHOLD_NS`] (see that constant).
    pub(crate) fn retarget(&mut self, measured_ns: i64) {
        self.target_ns = i128::from(measured_ns);
        if !self.established || (self.target_ns - self.applied_ns).abs() > STEP_THRESHOLD_NS {
            self.applied_ns = self.target_ns;
            self.established = true;
        }
    }

    /// Correct one frame's timestamp, advancing the slew by whatever
    /// the timeline moved since the last frame.
    pub(crate) fn correct(&mut self, raw_ns: u64) -> u64 {
        match self.high_water_ns {
            Some(high_water) if raw_ns > high_water => {
                let elapsed = i128::from(raw_ns - high_water);
                let allowance = elapsed * SLEW_RATE_NS_PER_S / 1_000_000_000;
                let remaining = self.target_ns - self.applied_ns;
                self.applied_ns += remaining.clamp(-allowance, allowance);
                self.high_water_ns = Some(raw_ns);
            }
            Some(_) => {}
            None => self.high_water_ns = Some(raw_ns),
        }
        // Clamped to the wire's own range: a correction that would take
        // a stamp below the epoch is nonsense arithmetic on corrupt
        // input, not a time.
        u64::try_from((i128::from(raw_ns) - self.applied_ns).clamp(0, i128::from(u64::MAX)))
            .unwrap_or(u64::MAX)
    }

    /// The offset currently in force, for publishing to readers.
    pub(crate) fn applied_ns(&self) -> i64 {
        narrow(self.applied_ns)
    }
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
        assert_eq!(clock.settle_round(&[], T1), None);
        assert_eq!(clock.status(), ClockProbeStatus::Unsupported);
        assert!(clock.offset().is_none());
    }

    #[test]
    fn settling_publishes_the_best_sample_and_the_count() {
        let clock = SessionClock::pending();
        clock.settle_round(
            &[
                ClockSample {
                    offset_ns: 900,
                    delay_ns: 90,
                },
                ClockSample {
                    offset_ns: 100,
                    delay_ns: 10,
                },
            ],
            T1,
        );
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
        worker.settle_round(
            &[ClockSample {
                offset_ns: 42,
                delay_ns: 1,
            }],
            T1,
        );
        assert_eq!(caller.offset().unwrap().offset_ns, 42);
    }

    // ---------- the per-session record ----------

    fn round(offset_ns: i64) -> [ClockSample; 1] {
        [ClockSample {
            offset_ns,
            delay_ns: 10,
        }]
    }

    #[test]
    fn the_record_keeps_the_first_measurement_and_the_newest_one() {
        // "Offset at start + current" is the per-session record: a
        // server whose clock was fixed mid-session must still be able
        // to say what it was doing when the session opened.
        let clock = SessionClock::pending();
        clock.settle_round(&round(4_000_000_000), T1);
        clock.settle_round(&round(1_000_000), T1 + 30_000_000_000);
        let record = clock.record();
        assert_eq!(record.start_offset_ns, Some(4_000_000_000));
        assert_eq!(record.measured_offset_ns, Some(1_000_000));
        assert_eq!(record.rounds, 2);
        assert_eq!(record.silent_rounds, 0);
        assert_eq!(record.measured_at_ns, Some(T1 + 30_000_000_000));
    }

    #[test]
    fn a_peer_that_answered_once_and_stops_keeps_its_last_measurement() {
        // Silence after an answer is a lost round, not a retraction —
        // the last good number stays the best available one, and the
        // count of silent rounds is what says it is stale.
        let clock = SessionClock::pending();
        clock.settle_round(&round(250_000_000), T1);
        clock.settle_round(&[], T1 + 30_000_000_000);
        clock.settle_round(&[], T1 + 60_000_000_000);
        let record = clock.record();
        assert_eq!(record.measured_offset_ns, Some(250_000_000));
        assert_eq!(record.silent_rounds, 2);
        assert_eq!(record.rounds, 3);
        assert_eq!(record.measured_at_ns, Some(T1));
        assert!(
            clock.ever_measured(),
            "a peer that has answered stays worth asking"
        );
    }

    #[test]
    fn an_answer_after_silence_clears_the_staleness() {
        let clock = SessionClock::pending();
        clock.settle_round(&round(10), T1);
        clock.settle_round(&[], T1 + 1);
        clock.settle_round(&round(20), T1 + 2);
        assert_eq!(clock.record().silent_rounds, 0);
    }

    #[test]
    fn a_peer_that_never_answers_is_reported_unsupported() {
        let clock = SessionClock::pending();
        clock.settle_round(&[], T1);
        assert!(!clock.ever_measured());
        assert_eq!(clock.record().status, ClockProbeStatus::Unsupported);
    }

    // ---------- the round cadence ----------

    #[test]
    fn a_session_opens_with_a_round_in_flight() {
        let rounds = ProbeRounds::new();
        assert!(rounds.in_round());
        assert!(rounds.armed());
    }

    #[test]
    fn a_measured_round_is_followed_by_a_gap_and_then_another_round() {
        let mut rounds = ProbeRounds::new();
        assert_eq!(rounds.advance(true), ProbeStep::WaitForNextRound);
        assert!(!rounds.in_round(), "no probes go out between rounds");
        assert!(rounds.armed(), "the timer still has a job");
        assert_eq!(rounds.advance(true), ProbeStep::AwaitReplies);
        assert!(rounds.in_round());
    }

    #[test]
    fn tracking_never_winds_down_on_its_own() {
        // The failure this pins is a session that measures for a while
        // and then quietly stops, leaving a number that looks live.
        let mut rounds = ProbeRounds::new();
        for _ in 0..1_000 {
            assert_eq!(rounds.advance(true), ProbeStep::WaitForNextRound);
            assert_eq!(rounds.advance(true), ProbeStep::AwaitReplies);
        }
        assert!(rounds.armed());
    }

    #[test]
    fn a_peer_that_never_answers_is_never_asked_again() {
        // The timer must not be re-armed forever against something that
        // does not recognise the envelopes.
        let mut rounds = ProbeRounds::new();
        assert_eq!(rounds.advance(false), ProbeStep::Stop);
        assert!(!rounds.armed());
        assert!(!rounds.in_round());
    }

    #[test]
    fn a_peer_that_goes_quiet_after_answering_keeps_being_asked() {
        // Silence from a peer that has spoken is a busy link, not a
        // peer that forgot the protocol — `ever_measured` stays true
        // through any number of empty rounds.
        let mut rounds = ProbeRounds::new();
        rounds.advance(true);
        for _ in 0..10 {
            assert_eq!(rounds.advance(true), ProbeStep::AwaitReplies);
            assert_eq!(rounds.advance(true), ProbeStep::WaitForNextRound);
        }
        assert!(rounds.armed());
    }

    #[test]
    fn the_applied_offset_is_published_separately_from_the_measurement() {
        // They differ while the slew is travelling, and the record has
        // to show both — that gap is the convergence.
        let clock = SessionClock::pending();
        clock.settle_round(&round(500_000_000), T1);
        clock.publish_applied(120_000_000);
        let record = clock.record();
        assert_eq!(record.measured_offset_ns, Some(500_000_000));
        assert_eq!(record.applied_offset_ns, 120_000_000);
    }

    #[test]
    fn nothing_is_applied_before_the_first_measurement() {
        assert_eq!(SessionClock::pending().record().applied_offset_ns, 0);
    }

    // ---------- the slew ----------

    const SEC: u64 = 1_000_000_000;

    #[test]
    fn an_unmeasured_slew_leaves_stamps_alone() {
        let mut slew = OffsetSlew::default();
        assert_eq!(slew.correct(T1), T1);
        assert_eq!(slew.applied_ns(), 0);
    }

    #[test]
    fn the_first_measurement_is_applied_whole() {
        // No corrected timeline exists yet, so there is nothing for a
        // slew to protect — and a session that spent 200 s creeping up
        // to a known 1 s offset would be wrong on purpose the whole way.
        let mut slew = OffsetSlew::default();
        slew.retarget(4_000_000_000);
        assert_eq!(slew.applied_ns(), 4_000_000_000);
        assert_eq!(slew.correct(T1), T1 - 4_000_000_000);
    }

    #[test]
    fn a_later_measurement_is_approached_at_the_bounded_rate() {
        let mut slew = OffsetSlew::default();
        slew.retarget(0);
        slew.correct(T1);
        // 100 ms of new error, well inside the step threshold.
        slew.retarget(100_000_000);
        // One second of timeline buys exactly one second's worth of
        // slew, and no more.
        slew.correct(T1 + SEC);
        assert_eq!(slew.applied_ns(), 5_000_000);
        slew.correct(T1 + 2 * SEC);
        assert_eq!(slew.applied_ns(), 10_000_000);
    }

    #[test]
    fn the_slew_converges_and_then_stops() {
        let mut slew = OffsetSlew::default();
        slew.retarget(0);
        slew.correct(T1);
        slew.retarget(20_000_000);
        // 20 ms of error at 5 ms/s needs 4 s of timeline.
        slew.correct(T1 + 4 * SEC);
        assert_eq!(slew.applied_ns(), 20_000_000);
        // It stops on arrival rather than overshooting.
        slew.correct(T1 + 100 * SEC);
        assert_eq!(slew.applied_ns(), 20_000_000);
    }

    #[test]
    fn the_slew_runs_backwards_at_the_same_bounded_rate() {
        let mut slew = OffsetSlew::default();
        slew.retarget(0);
        slew.correct(T1);
        slew.retarget(-100_000_000);
        slew.correct(T1 + SEC);
        assert_eq!(slew.applied_ns(), -5_000_000);
    }

    #[test]
    fn an_error_past_the_threshold_steps_instead() {
        // An operator fixing a grossly wrong clock; slewing 4 s away at
        // 5 ms/s would misplace frames for 13 minutes.
        let mut slew = OffsetSlew::default();
        slew.retarget(0);
        slew.correct(T1);
        slew.retarget(4_000_000_000);
        assert_eq!(slew.applied_ns(), 4_000_000_000);
    }

    #[test]
    fn an_error_at_the_threshold_still_slews() {
        // The boundary is exclusive: exactly one second is the largest
        // error the continuous path handles.
        let mut slew = OffsetSlew::default();
        slew.retarget(0);
        slew.correct(T1);
        slew.retarget(1_000_000_000);
        assert_eq!(slew.applied_ns(), 0, "a step happened at the boundary");
        slew.correct(T1 + SEC);
        assert_eq!(slew.applied_ns(), 5_000_000);
    }

    #[test]
    fn a_slewing_correction_never_reorders_the_timeline() {
        // The property the whole design exists for: whatever the slew
        // is doing, a non-decreasing run of raw stamps comes out
        // non-decreasing. Frames every millisecond across a target that
        // keeps flipping sign.
        let mut slew = OffsetSlew::default();
        slew.retarget(0);
        let mut previous = 0u64;
        for i in 0..2_000u64 {
            if i % 100 == 0 {
                // Alternate ±800 ms — under the step threshold, so
                // every one of these is worked off by slewing.
                slew.retarget(if (i / 100) % 2 == 0 {
                    800_000_000
                } else {
                    -800_000_000
                });
            }
            let corrected = slew.correct(T1 + i * 1_000_000);
            assert!(
                corrected >= previous,
                "the corrected timeline went backwards at frame {i}: \
                 {corrected} after {previous}"
            );
            previous = corrected;
        }
    }

    #[test]
    fn identical_stamps_stay_identical_however_far_apart_they_arrive() {
        // The case a wall-clock-driven slew gets wrong: the timeline
        // did not move, so neither does the correction.
        let mut slew = OffsetSlew::default();
        slew.retarget(0);
        slew.retarget(500_000_000);
        let first = slew.correct(T1);
        slew.correct(T1 + 60 * SEC);
        let same_stamp_again = slew.correct(T1);
        assert!(
            same_stamp_again <= first,
            "a repeated stamp must not be corrected to a later time"
        );
    }

    #[test]
    fn a_stamp_that_does_not_advance_the_timeline_does_not_advance_the_slew() {
        let mut slew = OffsetSlew::default();
        slew.retarget(0);
        slew.correct(T1 + 10 * SEC);
        slew.retarget(100_000_000);
        slew.correct(T1);
        assert_eq!(
            slew.applied_ns(),
            0,
            "an out-of-order arrival is not elapsed time"
        );
    }

    #[test]
    fn correcting_past_the_epoch_clamps_rather_than_wrapping() {
        let mut slew = OffsetSlew::default();
        slew.retarget(i64::MAX);
        assert_eq!(slew.correct(1_000), 0);
    }
}
