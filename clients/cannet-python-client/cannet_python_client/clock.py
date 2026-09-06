"""Measuring how far a server's clock is from ours, and correcting for it.

Every frame on the cannet wire carries Unix-epoch nanoseconds stamped
by whichever host produced it. Across machines that stamp is only as
good as what the two hosts are independently doing about their clocks,
and a server a few seconds off produces frames out of place on the
timeline with nothing on the wire to say so.

This is the SNTP algorithm (RFC 4330 § 5), run over the already-open
``Session`` stream rather than NTP's own UDP transport, and it is a
straight port of ``crates/cannet-client/src/clock.rs`` — same math,
same policy, same names — with the parts that exist only to dodge
``u64``/``i128`` overflow dropped, because Python integers do not
overflow:

| stamp | clock  | when                    |
|-------|--------|-------------------------|
| t1    | client | the probe left us       |
| t2    | server | the probe arrived there |
| t3    | server | the reply left there    |
| t4    | client | the reply arrived here  |

```
offset_ns = ((t2 - t1) + (t3 - t4)) / 2   # theta: server clock - ours
delay_ns  = (t4 - t1) - (t3 - t2)          # round-trip delay
```

Several exchanges are run per round and the one with the smallest
delay is kept — the exchange least likely to have been distorted by a
queue in one direction. A peer that answers nothing in a round is
:data:`ClockProbeStatus.UNSUPPORTED`: it does not know the envelopes
exist, so it is not asked again this session. A peer that answered
once and then goes quiet keeps its last measurement — silence is a
lost round, not a retraction.

:class:`OffsetSlew` is what actually corrects a frame's timestamp, and
it does not jump to each new measurement: it slews towards it at a
bounded rate, driven by the frame timeline rather than by wall-clock
time, so a non-decreasing run of raw stamps stays non-decreasing after
correction whatever the delivery timing was. The session's driving
loop lives in :mod:`cannet_python_client.session`; this module is the
arithmetic and the two pieces of state it produces.
"""

from __future__ import annotations

import dataclasses
import threading

#: How many clock probes a round sends. Minimum-delay selection needs
#: several exchanges to choose between; a fifth buys little next to the
#: extra window it would keep open.
CLOCK_PROBE_COUNT = 4

#: Spacing between probes within a round, in seconds. Far enough apart
#: that one transient queue does not distort every exchange, close
#: enough that a whole round is over before a user notices.
CLOCK_PROBE_SPACING_S = 0.02

#: How long a round waits for replies before concluding, in seconds.
#: Generous, because nothing blocks on it: a session is usable before
#: the first round settles, so this budget only decides how long a
#: slow link gets before its peer is written off as unsupporting.
CLOCK_PROBE_DEADLINE_S = 2.0

#: How long a session waits between rounds, in seconds, once a peer has
#: answered at least once. Both hosts may be disciplining their clocks
#: independently while the session is open, so one measurement at
#: start-up would go stale.
CLOCK_REPROBE_INTERVAL_S = 30.0

#: How fast the applied offset is allowed to move, in nanoseconds of
#: correction per second of the timeline being corrected. 5 ms/s is an
#: order of magnitude above the fastest realistic NTP slew (0.5 ms/s
#: per host, so up to 1 ms/s between two of them), so the applied
#: offset converges on a moving measurement instead of chasing it
#: forever, while staying far too slow for anything in a trace view to
#: notice.
SLEW_RATE_NS_PER_S = 5_000_000

#: The measurement-to-applied gap above which the correction steps
#: instead of slewing. A whole second of error is not clock drift; it
#: is an operator fixing a grossly wrong clock, or a host finally
#: reaching an NTP server, and slewing that away would misplace frames
#: for minutes on the way.
STEP_THRESHOLD_NS = 1_000_000_000

#: The wire's own timestamp range. A correction that would carry a
#: stamp outside it is nonsense arithmetic on corrupt input, not a time.
_U64_MAX = (1 << 64) - 1


@dataclasses.dataclass(frozen=True)
class ClockSample:
    """One completed probe exchange, reduced to offset and delay."""

    #: theta - the server's clock minus ours, in nanoseconds. Positive
    #: means the server is ahead.
    offset_ns: int
    #: delta - the round-trip delay in nanoseconds, never negative.
    delay_ns: int


@dataclasses.dataclass(frozen=True)
class ClockOffset:
    """What a round concluded about the peer's clock."""

    #: theta of the least-delayed exchange in the round.
    offset_ns: int
    #: delta of that same exchange - the error bound on ``offset_ns``.
    delay_ns: int
    #: How many exchanges completed. The measurement is the best of
    #: these, not their average.
    samples: int


#: A round is still waiting on its deadline.
STATUS_PENDING = "pending"
#: The peer answered; :attr:`ClockRecord.measured_offset_ns` is live.
STATUS_MEASURED = "measured"
#: A round closed with no reply at all, and this peer is never probed
#: again — see the module docstring.
STATUS_UNSUPPORTED = "unsupported"


@dataclasses.dataclass(frozen=True)
class ClockRecord:
    """Everything one session has learned about its peer's clock.

    ``measured_offset_ns`` and ``applied_offset_ns`` differ whenever
    the slew is still travelling towards a new measurement; that gap
    *is* the convergence, not an inconsistency.
    """

    status: str
    #: theta of the session's *first* successful round, or ``None`` if
    #: none has ever succeeded.
    start_offset_ns: int | None
    #: theta of the newest successful round.
    measured_offset_ns: int | None
    #: What frames leaving this session are actually corrected by.
    applied_offset_ns: int
    #: delta of the newest successful round.
    delay_ns: int | None
    #: Exchanges that completed in the newest successful round.
    samples: int
    #: Probe rounds attempted, answered or not.
    rounds: int
    #: Consecutive rounds since the last answer. Non-zero means
    #: ``measured_offset_ns`` is stale.
    silent_rounds: int
    #: Our wall clock when the newest successful round settled.
    measured_at_ns: int | None


def sample(t1: int, t2: int, t3: int, t4: int) -> ClockSample:
    """Reduce one exchange's four stamps to an offset and a delay.

    ``t1``/``t4`` are on our clock, ``t2``/``t3`` on the peer's. A
    computed delay below zero is reported as zero: the RFC notes the
    computation can come out negative when the two clocks tick at
    different rates across the exchange, and left signed it would win
    minimum-delay selection every time — turning the worst sample into
    the chosen one.
    """
    offset_ns = ((t2 - t1) + (t3 - t4)) // 2
    delay_ns = max((t4 - t1) - (t3 - t2), 0)
    return ClockSample(offset_ns=offset_ns, delay_ns=delay_ns)


def best_sample(samples: list[ClockSample]) -> ClockSample | None:
    """The exchange least distorted by path asymmetry: the shortest
    round trip. Ties keep the earliest — the earliest answer we could
    have acted on."""
    if not samples:
        return None
    return min(samples, key=lambda s: s.delay_ns)


class SessionClock:
    """A session's clock measurement, readable from any thread.

    The driving loop in :mod:`cannet_python_client.session` publishes a
    measurement at the end of each round and the applied offset as it
    slews; a reader — a status display, a test — only ever calls the
    methods below.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._status = STATUS_PENDING
        self._start: ClockOffset | None = None
        self._latest: ClockOffset | None = None
        self._rounds = 0
        self._silent_rounds = 0
        self._measured_at_ns: int | None = None
        self._applied_ns = 0

    def status(self) -> str:
        """One of the ``STATUS_*`` constants. Never blocks on the network."""
        with self._lock:
            return self._status

    def offset(self) -> ClockOffset | None:
        """The measured offset, if a round has ever succeeded."""
        with self._lock:
            return self._latest if self._status == STATUS_MEASURED else None

    def applied_offset_ns(self) -> int:
        """The offset frames leaving this session are corrected by right
        now. Zero until the first measurement lands."""
        with self._lock:
            return self._applied_ns

    def record(self) -> ClockRecord:
        """The whole per-session record in one consistent read."""
        with self._lock:
            return ClockRecord(
                status=self._status,
                start_offset_ns=self._start.offset_ns if self._start else None,
                measured_offset_ns=(self._latest.offset_ns if self._latest else None),
                applied_offset_ns=self._applied_ns,
                delay_ns=self._latest.delay_ns if self._latest else None,
                samples=self._latest.samples if self._latest else 0,
                rounds=self._rounds,
                silent_rounds=self._silent_rounds,
                measured_at_ns=self._measured_at_ns,
            )

    def publish_applied(self, applied_ns: int) -> None:
        """Publish the offset the slew is currently applying."""
        with self._lock:
            self._applied_ns = applied_ns

    def settle_round(
        self, samples: list[ClockSample], now_ns: int
    ) -> ClockOffset | None:
        """Close a probe round: fold ``samples`` to one measurement and
        record it, or account for a round nobody answered.

        Returns the new measurement when there is one, so the caller
        can retarget the slew — the two are one decision. A silent
        round is only :data:`STATUS_UNSUPPORTED` when it is also the
        *first* success-less round: a peer that has answered before
        demonstrably speaks the protocol, so its silence keeps the last
        measurement rather than discarding it.
        """
        best = best_sample(samples)
        measured = (
            ClockOffset(
                offset_ns=best.offset_ns, delay_ns=best.delay_ns, samples=len(samples)
            )
            if best is not None
            else None
        )
        with self._lock:
            self._rounds += 1
            if measured is not None:
                self._status = STATUS_MEASURED
                self._latest = measured
                self._measured_at_ns = now_ns
                self._silent_rounds = 0
                if self._start is None:
                    self._start = measured
            else:
                self._silent_rounds += 1
                if self._start is None:
                    self._status = STATUS_UNSUPPORTED
        return measured

    def ever_measured(self) -> bool:
        """Whether any round has ever produced a measurement — whether
        this peer is worth asking again."""
        with self._lock:
            return self._start is not None


class OffsetSlew:
    """The correction actually applied to frames, and the policy that
    moves it towards each new measurement.

    Driven by the frame timeline rather than local elapsed time: the
    correction is ``raw - applied(raw)``, and because the rate is far
    below 1 ns per ns, that mapping is strictly increasing, so any
    non-decreasing run of raw stamps stays non-decreasing after
    correction whatever the delivery timing was. A stamp that does not
    advance the timeline — an out-of-order arrival, or a server clock
    that went backwards — does not advance the slew either.

    Until the first measurement lands there is no corrected timeline to
    stay continuous with, so it is stepped rather than slewed;
    likewise for a gap past :data:`STEP_THRESHOLD_NS`, which is not
    drift but an operator or an NTP client fixing a grossly wrong
    clock.
    """

    def __init__(self) -> None:
        self._applied_ns = 0
        self._target_ns = 0
        self._high_water_ns: int | None = None
        self._established = False

    def retarget(self, measured_ns: int) -> None:
        """Aim at a freshly measured offset."""
        self._target_ns = measured_ns
        if (
            not self._established
            or abs(self._target_ns - self._applied_ns) > STEP_THRESHOLD_NS
        ):
            self._applied_ns = self._target_ns
            self._established = True

    def correct(self, raw_ns: int) -> int:
        """Correct one frame's timestamp, advancing the slew by whatever
        the timeline moved since the last frame."""
        if self._high_water_ns is None:
            self._high_water_ns = raw_ns
        elif raw_ns > self._high_water_ns:
            elapsed = raw_ns - self._high_water_ns
            allowance = elapsed * SLEW_RATE_NS_PER_S // 1_000_000_000
            remaining = self._target_ns - self._applied_ns
            self._applied_ns += max(-allowance, min(allowance, remaining))
            self._high_water_ns = raw_ns
        return min(max(raw_ns - self._applied_ns, 0), _U64_MAX)

    def applied_ns(self) -> int:
        """The offset currently in force, for publishing to readers."""
        return self._applied_ns
