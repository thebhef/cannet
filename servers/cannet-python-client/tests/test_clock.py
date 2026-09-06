"""The SNTP arithmetic and the two pieces of state it produces.

A straight port of `crates/cannet-client/src/clock.rs`'s own test
suite, minus the overflow-saturation cases: Python integers do not
overflow, so there is nothing there to pin.
"""

from __future__ import annotations

from cannet_python_client import clock

T1 = 1_760_000_000_000_000_000
MS = 1_000_000


# --- the RFC 4330 reduction --------------------------------------------


def test_a_symmetric_exchange_recovers_the_offset_exactly() -> None:
    # Server 4 s ahead, 10 ms each way, 1 ms of server handling.
    t2 = T1 + 10 * MS + 4_000_000_000
    t3 = t2 + MS
    t4 = T1 + 21 * MS
    s = clock.sample(T1, t2, t3, t4)
    assert s.offset_ns == 4_000_000_000
    # delay is the round trip *without* the server's handling time —
    # that is what makes it a measure of the path.
    assert s.delay_ns == 20 * MS


def test_a_server_behind_us_reports_a_negative_offset() -> None:
    t2 = T1 + 10 * MS - 4_000_000_000
    t3 = t2 + MS
    t4 = T1 + 21 * MS
    s = clock.sample(T1, t2, t3, t4)
    assert s.offset_ns == -4_000_000_000
    assert s.delay_ns == 20 * MS


def test_clocks_in_sync_report_no_offset() -> None:
    t2 = T1 + 10 * MS
    t3 = t2 + MS
    t4 = T1 + 21 * MS
    assert clock.sample(T1, t2, t3, t4).offset_ns == 0


def test_an_asymmetric_path_biases_the_offset_by_half_the_asymmetry() -> None:
    # 30 ms out, 10 ms back: theta is wrong by (30 - 10) / 2 = 10 ms.
    # Pinned because it is the error minimum-delay selection exists to
    # keep small, not a defect to fix here.
    t2 = T1 + 30 * MS
    t3 = t2 + MS
    t4 = T1 + 41 * MS
    s = clock.sample(T1, t2, t3, t4)
    assert s.offset_ns == 10 * MS
    assert s.delay_ns == 40 * MS


def test_a_delay_that_computes_negative_is_reported_as_zero() -> None:
    # Left signed, this sample would win every minimum-delay selection
    # it took part in.
    t2 = T1 + 10 * MS
    t3 = t2 + 50 * MS
    t4 = T1 + 21 * MS
    assert clock.sample(T1, t2, t3, t4).delay_ns == 0


def test_minimum_delay_selection_takes_the_least_delayed_exchange() -> None:
    samples = [
        clock.ClockSample(offset_ns=4_100_000_000, delay_ns=80 * MS),
        clock.ClockSample(offset_ns=4_000_000_000, delay_ns=20 * MS),
        clock.ClockSample(offset_ns=3_500_000_000, delay_ns=500 * MS),
    ]
    assert clock.best_sample(samples).offset_ns == 4_000_000_000


def test_a_tie_on_delay_keeps_the_earlier_exchange() -> None:
    samples = [
        clock.ClockSample(offset_ns=10, delay_ns=5),
        clock.ClockSample(offset_ns=20, delay_ns=5),
    ]
    assert clock.best_sample(samples).offset_ns == 10


def test_no_exchanges_means_nothing_to_choose() -> None:
    assert clock.best_sample([]) is None


# --- the per-session record ---------------------------------------------


def round_of(offset_ns: int) -> list[clock.ClockSample]:
    return [clock.ClockSample(offset_ns=offset_ns, delay_ns=10)]


def test_settling_with_no_samples_reports_the_peer_as_unsupported() -> None:
    session_clock = clock.SessionClock()
    assert session_clock.status() == clock.STATUS_PENDING
    assert session_clock.settle_round([], T1) is None
    assert session_clock.status() == clock.STATUS_UNSUPPORTED
    assert session_clock.offset() is None


def test_settling_publishes_the_best_sample_and_the_count() -> None:
    session_clock = clock.SessionClock()
    session_clock.settle_round(
        [
            clock.ClockSample(offset_ns=900, delay_ns=90),
            clock.ClockSample(offset_ns=100, delay_ns=10),
        ],
        T1,
    )
    offset = session_clock.offset()
    assert offset == clock.ClockOffset(offset_ns=100, delay_ns=10, samples=2)


def test_the_record_keeps_the_first_measurement_and_the_newest_one() -> None:
    # "Offset at start + current" is the per-session record: a server
    # whose clock was fixed mid-session must still be able to say what
    # it was doing when the session opened.
    session_clock = clock.SessionClock()
    session_clock.settle_round(round_of(4_000_000_000), T1)
    session_clock.settle_round(round_of(1_000_000), T1 + 30_000_000_000)
    record = session_clock.record()
    assert record.start_offset_ns == 4_000_000_000
    assert record.measured_offset_ns == 1_000_000
    assert record.rounds == 2
    assert record.silent_rounds == 0
    assert record.measured_at_ns == T1 + 30_000_000_000


def test_a_peer_that_answered_once_and_stops_keeps_its_last_measurement() -> None:
    session_clock = clock.SessionClock()
    session_clock.settle_round(round_of(250_000_000), T1)
    session_clock.settle_round([], T1 + 30_000_000_000)
    session_clock.settle_round([], T1 + 60_000_000_000)
    record = session_clock.record()
    assert record.measured_offset_ns == 250_000_000
    assert record.silent_rounds == 2
    assert record.rounds == 3
    assert record.measured_at_ns == T1
    assert session_clock.ever_measured(), "a peer that has answered stays worth asking"


def test_an_answer_after_silence_clears_the_staleness() -> None:
    session_clock = clock.SessionClock()
    session_clock.settle_round(round_of(10), T1)
    session_clock.settle_round([], T1 + 1)
    session_clock.settle_round(round_of(20), T1 + 2)
    assert session_clock.record().silent_rounds == 0


def test_a_peer_that_never_answers_is_reported_unsupported() -> None:
    session_clock = clock.SessionClock()
    session_clock.settle_round([], T1)
    assert not session_clock.ever_measured()
    assert session_clock.record().status == clock.STATUS_UNSUPPORTED


def test_the_applied_offset_is_published_separately_from_the_measurement() -> None:
    # They differ while the slew is travelling, and the record has to
    # show both — that gap is the convergence.
    session_clock = clock.SessionClock()
    session_clock.settle_round(round_of(500_000_000), T1)
    session_clock.publish_applied(120_000_000)
    record = session_clock.record()
    assert record.measured_offset_ns == 500_000_000
    assert record.applied_offset_ns == 120_000_000


def test_nothing_is_applied_before_the_first_measurement() -> None:
    assert clock.SessionClock().record().applied_offset_ns == 0


# --- the slew -------------------------------------------------------------

SEC = 1_000_000_000


def test_an_unmeasured_slew_leaves_stamps_alone() -> None:
    slew = clock.OffsetSlew()
    assert slew.correct(T1) == T1
    assert slew.applied_ns() == 0


def test_the_first_measurement_is_applied_whole() -> None:
    # No corrected timeline exists yet, so there is nothing for a slew
    # to protect — and a session that spent 200 s creeping up to a
    # known 1 s offset would be wrong on purpose the whole way.
    slew = clock.OffsetSlew()
    slew.retarget(4_000_000_000)
    assert slew.applied_ns() == 4_000_000_000
    assert slew.correct(T1) == T1 - 4_000_000_000


def test_a_later_measurement_is_approached_at_the_bounded_rate() -> None:
    slew = clock.OffsetSlew()
    slew.retarget(0)
    slew.correct(T1)
    # 100 ms of new error, well inside the step threshold.
    slew.retarget(100_000_000)
    # One second of timeline buys exactly one second's worth of slew,
    # and no more.
    slew.correct(T1 + SEC)
    assert slew.applied_ns() == 5_000_000
    slew.correct(T1 + 2 * SEC)
    assert slew.applied_ns() == 10_000_000


def test_the_slew_converges_and_then_stops() -> None:
    slew = clock.OffsetSlew()
    slew.retarget(0)
    slew.correct(T1)
    slew.retarget(20_000_000)
    # 20 ms of error at 5 ms/s needs 4 s of timeline.
    slew.correct(T1 + 4 * SEC)
    assert slew.applied_ns() == 20_000_000
    # It stops on arrival rather than overshooting.
    slew.correct(T1 + 100 * SEC)
    assert slew.applied_ns() == 20_000_000


def test_the_slew_runs_backwards_at_the_same_bounded_rate() -> None:
    slew = clock.OffsetSlew()
    slew.retarget(0)
    slew.correct(T1)
    slew.retarget(-100_000_000)
    slew.correct(T1 + SEC)
    assert slew.applied_ns() == -5_000_000


def test_an_error_past_the_threshold_steps_instead() -> None:
    # An operator fixing a grossly wrong clock; slewing 4 s away at
    # 5 ms/s would misplace frames for 13 minutes.
    slew = clock.OffsetSlew()
    slew.retarget(0)
    slew.correct(T1)
    slew.retarget(4_000_000_000)
    assert slew.applied_ns() == 4_000_000_000


def test_an_error_at_the_threshold_still_slews() -> None:
    # The boundary is exclusive: exactly one second is the largest
    # error the continuous path handles.
    slew = clock.OffsetSlew()
    slew.retarget(0)
    slew.correct(T1)
    slew.retarget(1_000_000_000)
    assert slew.applied_ns() == 0, "a step happened at the boundary"
    slew.correct(T1 + SEC)
    assert slew.applied_ns() == 5_000_000


def test_a_slewing_correction_never_reorders_the_timeline() -> None:
    # The property the whole design exists for: whatever the slew is
    # doing, a non-decreasing run of raw stamps comes out non-decreasing.
    slew = clock.OffsetSlew()
    slew.retarget(0)
    previous = 0
    for i in range(2_000):
        if i % 100 == 0:
            # Alternate +-800 ms — under the step threshold, so every
            # one of these is worked off by slewing.
            slew.retarget(800_000_000 if (i // 100) % 2 == 0 else -800_000_000)
        corrected = slew.correct(T1 + i * 1_000_000)
        assert corrected >= previous, (
            f"the corrected timeline went backwards at frame {i}: "
            f"{corrected} after {previous}"
        )
        previous = corrected


def test_identical_stamps_stay_identical_however_far_apart_they_arrive() -> None:
    # The case a wall-clock-driven slew gets wrong: the timeline did
    # not move, so neither does the correction.
    slew = clock.OffsetSlew()
    slew.retarget(0)
    slew.retarget(500_000_000)
    first = slew.correct(T1)
    slew.correct(T1 + 60 * SEC)
    same_stamp_again = slew.correct(T1)
    assert same_stamp_again <= first, (
        "a repeated stamp must not be corrected to a later time"
    )


def test_a_stamp_that_does_not_advance_the_timeline_does_not_advance_the_slew() -> None:
    slew = clock.OffsetSlew()
    slew.retarget(0)
    slew.correct(T1 + 10 * SEC)
    slew.retarget(100_000_000)
    slew.correct(T1)
    assert slew.applied_ns() == 0, "an out-of-order arrival is not elapsed time"


def test_correcting_past_the_epoch_clamps_rather_than_wrapping() -> None:
    slew = clock.OffsetSlew()
    slew.retarget(2**63 - 1)
    assert slew.correct(1_000) == 0
