"""A session's stream to the host: two bounded lanes, control first
(ADR 0060 rule 3).

:class:`SessionOutbox` replaces the single unbounded first-in-first-out
queue a session used to have. Everything the sidecar says to one
session goes through it, and the session's response generator drains it
with :meth:`SessionOutbox.get`:

- **The control lane** carries what describes the bus: ``InterfaceState``,
  ``BusErrorEpisode``, ``TxRefusals``, ``FramesDropped``, ``ClockReply``,
  ``Log`` and ``Error``. It is bounded by *key*, latest wins, so a fault,
  a refusal or a recovery reaches the host however far behind the data
  is:

  ======================  =====================  ==========================
  message                 key                    a newer one ...
  ======================  =====================  ==========================
  ``InterfaceState``      (kind, interface)      replaces it
  ``BusErrorEpisode``     (interface, ``seq``)   replaces it; a backed-up
                                                 closed episode folds into
                                                 its successor
  ``TxRefusals``          (interface, reason)    is summed into it
  ``FramesDropped``       (kind, interface)      is summed into it
  ``ClockReply``          (kind,)                replaces it
  ``Log`` / ``Error``     bounded FIFO           pushes the oldest out; the
                                                 next ``Log`` says how many
  ======================  =====================  ==========================

- **The data lane** carries ``FrameBatch`` only, bounded per interface at
  :data:`_DATA_LANE_FRAMES_PER_INTERFACE` frames. On overflow the oldest
  whole batches are dropped and a ``FramesDropped`` naming the frames
  and their span goes on the control lane.

Refused transmits never become one envelope each: :meth:`refuse` counts
them per (interface, reason) and :meth:`get` publishes the counts as
``TxRefusals`` at most once per :data:`_REFUSAL_REPORT_PERIOD_S` per
interface while refusals continue, and once more after they stop (ADR
0060 rule 4). The first refusal after a quiet period is published at
once.

The interface is ``queue.Queue``-shaped where the rest of the sidecar
already used one (``put``, ``get(timeout=...)`` raising
:class:`queue.Empty`, ``get_nowait``), and ``put(None)`` closes it the
way the old sentinel did.
"""

from __future__ import annotations

import collections
import itertools
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional, Union

from cannet_python_wire._proto import cannet_pb2 as pb

from .. import driver as drv
from .helpers import _log_envelope

#: Frames the data lane holds per interface before it drops the oldest
#: whole batches. About one second of frames at the rates the bench
#: produces during a fault: 1.4 s at 7.2 k frames/s, 2.8 s at the 3.6 k
#: frames/s a pulled cable measured. A reader that keeps up never comes
#: near it (the load harness peaked at under 100 envelopes), so the cap
#: only ever touches a stalled reader -- and then it bounds how stale
#: the "live" view can be, instead of letting it replay minutes of
#: backlog.
_DATA_LANE_FRAMES_PER_INTERFACE = 10_000

#: ``Log`` / ``Error`` envelopes the control lane holds before it drops
#: the oldest. These are lifecycle lines -- open, close, a failure, a
#: timer rollover -- a few a minute on a healthy session; 64 holds the
#: worst burst the sidecar produces (every interface on a session
#: failing to open or reconfigure at once, two lines each, with eight
#: interfaces) four times over, while still bounding a stalled reader.
_LOG_LANE_MAX = 64

#: An interface's ``TxRefusals`` (one per reason pending) at most this
#: often while refusals continue (ADR 0060 rule 4: about four a second
#: per interface).
_REFUSAL_REPORT_PERIOD_S = 0.25

#: Closed ``BusErrorEpisode`` reports the control lane holds per
#: interface before the oldest folds into its successor (ADR 0060
#: rule 3). Two is the shape a reader that keeps up ever sees -- one
#: episode's closing report and the next one's opening -- so folding
#: starts only when a third arrives behind a stalled reader.
_EPISODE_REPORTS_PER_INTERFACE = 2


def _fold_episode(
    earlier: pb.BusErrorEpisode, later: pb.BusErrorEpisode
) -> pb.BusErrorEpisode:
    """``later``, carrying ``earlier``'s counts too. Exact, because a
    report is already a sum: counts add, the earlier ``first_ns`` is
    kept, and everything that is a reading "as of" (``last_ns``, the
    counters, ``open``, ``seq``) is the later report's."""
    out = pb.BusErrorEpisode()
    out.CopyFrom(later)
    out.first_ns = min(earlier.first_ns, later.first_ns)
    out.count = earlier.count + later.count
    out.tx_count = earlier.tx_count + later.tx_count
    out.rx_count = earlier.rx_count + later.rx_count
    for kind in drv.ERROR_KINDS:
        setattr(
            out.count_by_kind,
            kind,
            getattr(earlier.count_by_kind, kind) + getattr(later.count_by_kind, kind),
        )
    return out


@dataclass
class _Keyed:
    """One control-lane slot: its arrival order and its latest envelope.
    ``carry`` holds episodes folded into this one (ADR 0060 rule 3)."""

    order: int
    env: pb.Envelope
    carry: Optional[pb.BusErrorEpisode] = None

    def out(self) -> pb.Envelope:
        if self.carry is None:
            return self.env
        return pb.Envelope(
            bus_error_episode=_fold_episode(self.carry, self.env.bus_error_episode)
        )


@dataclass
class _Tally:
    """Refusals counted for one (interface, reason) since its last
    report, plus flushes for the queue-full key."""

    count: int = 0
    first_ns: int = 0
    last_ns: int = 0
    last_message: str = ""
    flush_count: int = 0
    last_flush_ns: int = 0

    def pending(self) -> bool:
        return self.count > 0 or self.flush_count > 0


_REASON_TO_PROTO = {
    drv.REFUSAL_QUEUE_FULL: pb.TX_REFUSAL_REASON_QUEUE_FULL,
    drv.REFUSAL_CLOSED: pb.TX_REFUSAL_REASON_CLOSED,
    drv.REFUSAL_LISTEN_ONLY: pb.TX_REFUSAL_REASON_LISTEN_ONLY,
    drv.REFUSAL_INCOMPATIBLE: pb.TX_REFUSAL_REASON_INCOMPATIBLE,
    drv.REFUSAL_OTHER: pb.TX_REFUSAL_REASON_OTHER,
}

_Key = Union[tuple[str], tuple[str, str], tuple[str, str, int]]


@dataclass
class _DataLane:
    batches: "collections.deque[tuple[int, pb.Envelope, int]]" = field(
        default_factory=collections.deque
    )
    frames: int = 0


class SessionOutbox:
    """One session's two lanes. Thread-safe: every pump thread of every
    subscribed interface puts into it, the session's request thread
    counts refusals into it, and the response generator drains it."""

    def __init__(
        self,
        *,
        data_frames_per_interface: int = _DATA_LANE_FRAMES_PER_INTERFACE,
        log_max: int = _LOG_LANE_MAX,
        refusal_period_s: float = _REFUSAL_REPORT_PERIOD_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._data_cap = data_frames_per_interface
        self._log_max = log_max
        self._refusal_period_s = refusal_period_s
        self._clock = clock
        self._cond = threading.Condition()
        self._order = itertools.count()
        self._keyed: dict[_Key, _Keyed] = {}
        self._logs: "collections.deque[tuple[int, pb.Envelope]]" = collections.deque()
        self._logs_dropped = 0
        self._data: dict[str, _DataLane] = {}
        self._tallies: dict[tuple[str, str], _Tally] = {}
        # Per interface: when its refusals were last reported, and the
        # summaries of a burst not yet handed out.
        self._reported_s: dict[str, float] = {}
        self._ready: "collections.deque[pb.Envelope]" = collections.deque()
        self._closed = False
        #: High-water marks, for the load harness and the stats a
        #: post-mortem wants: the most control-lane slots (keyed + log)
        #: and the most frames one interface's data lane held.
        self.peak_control = 0
        self.peak_data_frames = 0
        #: Frames dropped from the data lane over the session's life.
        self.dropped_frames_total = 0

    # ----- producers --------------------------------------------------------

    def put(self, env: Optional[pb.Envelope]) -> None:
        """Route ``env`` to its lane. ``None`` closes the outbox."""
        with self._cond:
            if env is None:
                self._closed = True
            else:
                self._route_locked(env)
            self._cond.notify_all()

    def close(self) -> None:
        self.put(None)

    def refuse(
        self,
        interface_id: str,
        reason: str,
        message: str,
        *,
        now_ns: Optional[int] = None,
    ) -> None:
        """Count one refused transmit on ``interface_id`` (ADR 0060 rule
        4). ``reason`` is one of the driver's ``REFUSAL_*`` names."""
        if reason not in _REASON_TO_PROTO:
            reason = drv.REFUSAL_OTHER
        t = time.time_ns() if now_ns is None else now_ns
        with self._cond:
            tally = self._tallies.setdefault((interface_id, reason), _Tally())
            if tally.count == 0:
                tally.first_ns = t
            tally.count += 1
            tally.last_ns = t
            tally.last_message = message
            self._cond.notify_all()

    def note_flush(self, interface_id: str, *, now_ns: Optional[int] = None) -> None:
        """Count one transmit-queue flush on ``interface_id`` (ADR 0060
        rule 7); it rides that interface's queue-full ``TxRefusals``."""
        t = time.time_ns() if now_ns is None else now_ns
        with self._cond:
            tally = self._tallies.setdefault(
                (interface_id, drv.REFUSAL_QUEUE_FULL), _Tally()
            )
            tally.flush_count += 1
            tally.last_flush_ns = t
            self._cond.notify_all()

    # ----- the consumer ---------------------------------------------------

    def get(self, block: bool = True, timeout: Optional[float] = None):
        """The next envelope: control before data. ``None`` once the
        outbox is closed and empty. Raises :class:`queue.Empty` when
        ``timeout`` (or a non-blocking call) finds nothing."""
        deadline = None if timeout is None else self._clock() + timeout
        with self._cond:
            while True:
                now = self._clock()
                env, wait_s = self._next_locked(now)
                if env is not None:
                    return env
                if self._closed and wait_s is None:
                    return None
                if not block:
                    raise queue.Empty
                if deadline is not None:
                    remaining = deadline - now
                    if remaining <= 0:
                        raise queue.Empty
                    wait_s = remaining if wait_s is None else min(wait_s, remaining)
                if self._closed and wait_s is not None:
                    # Closed with refusals still to report: say them now
                    # rather than holding the session open for the period.
                    env = self._report_due_locked(now, force=True)
                    if env is not None:
                        return env
                    return None
                self._cond.wait(wait_s)

    def get_nowait(self):
        return self.get(block=False)

    def qsize(self) -> int:
        with self._cond:
            return (
                len(self._keyed)
                + len(self._logs)
                + len(self._ready)
                + sum(len(d.batches) for d in self._data.values())
            )

    def empty(self) -> bool:
        return self.qsize() == 0

    # ----- internals --------------------------------------------------------

    def _route_locked(self, env: pb.Envelope) -> None:
        body = env.WhichOneof("body")
        if body == "frame_batch":
            self._put_data_locked(env)
        elif body == "interface_state":
            self._put_keyed_locked(("state", env.interface_state.interface_id), env)
        elif body == "bus_error_episode":
            self._put_episode_locked(env)
        elif body == "clock_reply":
            self._put_keyed_locked(("clock",), env)
        else:
            self._logs.append((next(self._order), env))
            while len(self._logs) > self._log_max:
                self._logs.popleft()
                self._logs_dropped += 1
        self._note_control_depth_locked()

    def _note_control_depth_locked(self) -> None:
        depth = len(self._keyed) + len(self._logs)
        if depth > self.peak_control:
            self.peak_control = depth

    def _put_keyed_locked(self, key: _Key, env: pb.Envelope) -> None:
        slot = self._keyed.get(key)
        if slot is None:
            self._keyed[key] = _Keyed(next(self._order), env)
        else:
            slot.env = env

    def _put_episode_locked(self, env: pb.Envelope) -> None:
        ep = env.bus_error_episode
        iface = ep.interface_id
        key: _Key = ("episode", iface, int(ep.seq))
        slot = self._keyed.get(key)
        if slot is not None:
            slot.env = env
            return
        self._keyed[key] = _Keyed(next(self._order), env)
        pending = sorted(
            k
            for k in self._keyed
            if len(k) == 3 and k[0] == "episode" and k[1] == iface
        )
        while len(pending) > _EPISODE_REPORTS_PER_INTERFACE:
            oldest, successor = pending[0], pending[1]
            gone = self._keyed.pop(oldest)
            folded = gone.env.bus_error_episode
            if gone.carry is not None:
                folded = _fold_episode(gone.carry, folded)
            nxt = self._keyed[successor]
            nxt.carry = (
                folded if nxt.carry is None else _fold_episode(folded, nxt.carry)
            )
            pending = pending[1:]

    def _put_data_locked(self, env: pb.Envelope) -> None:
        batch = env.frame_batch
        n = len(batch.frames)
        lane = self._data.setdefault(batch.interface_id, _DataLane())
        lane.batches.append((next(self._order), env, n))
        lane.frames += n
        count = 0
        first_ns = last_ns = 0
        while lane.frames > self._data_cap and len(lane.batches) > 1:
            _, old, m = lane.batches.popleft()
            lane.frames -= m
            if m == 0:
                continue
            frames = old.frame_batch.frames
            if count == 0:
                first_ns = frames[0].timestamp_ns
            last_ns = frames[-1].timestamp_ns
            count += m
        if lane.frames > self.peak_data_frames:
            self.peak_data_frames = lane.frames
        if count:
            self.dropped_frames_total += count
            self._note_dropped_locked(batch.interface_id, count, first_ns, last_ns)

    def _note_dropped_locked(
        self, interface_id: str, count: int, first_ns: int, last_ns: int
    ) -> None:
        key: _Key = ("dropped", interface_id)
        slot = self._keyed.get(key)
        if slot is not None:
            prev = slot.env.frames_dropped
            count += prev.count
            first_ns = min(first_ns, prev.first_ns)
            last_ns = max(last_ns, prev.last_ns)
        env = pb.Envelope(
            frames_dropped=pb.FramesDropped(
                interface_id=interface_id,
                count=count,
                first_ns=first_ns,
                last_ns=last_ns,
            )
        )
        self._put_keyed_locked(key, env)
        self._note_control_depth_locked()

    def _report_due_locked(self, now: float, *, force: bool = False):
        """The next ``TxRefusals`` whose report is due, or ``None``.

        Paced per interface, not per reason: once an interface is due,
        every reason pending on it is reported together and the
        interface waits out the period again, so an interface never has
        more than one burst of summaries per period."""
        if not self._ready:
            pending = [i for (i, _), t in self._tallies.items() if t.pending()]
            for iface in dict.fromkeys(pending):
                last = self._reported_s.get(iface)
                if (
                    not force
                    and last is not None
                    and now - last < self._refusal_period_s
                ):
                    continue
                self._reported_s[iface] = now
                for (i, reason), tally in self._tallies.items():
                    if i != iface or not tally.pending():
                        continue
                    self._ready.append(
                        pb.Envelope(
                            tx_refusals=pb.TxRefusals(
                                interface_id=iface,
                                reason=_REASON_TO_PROTO[reason],
                                count=tally.count,
                                first_ns=tally.first_ns,
                                last_ns=tally.last_ns,
                                last_message=tally.last_message,
                                flush_count=tally.flush_count,
                                last_flush_ns=tally.last_flush_ns,
                            )
                        )
                    )
                    tally.count = 0
                    tally.flush_count = 0
        return self._ready.popleft() if self._ready else None

    def _refusal_wait_locked(self, now: float) -> Optional[float]:
        """Seconds until the next pending refusal report is due, or
        ``None`` with nothing pending."""
        wait: Optional[float] = None
        for (iface, _), tally in self._tallies.items():
            last = self._reported_s.get(iface)
            if not tally.pending() or last is None:
                continue
            left = max(0.0, self._refusal_period_s - (now - last))
            wait = left if wait is None else min(wait, left)
        return wait

    def _next_locked(self, now: float) -> tuple[Optional[pb.Envelope], Optional[float]]:
        """The next envelope to send, or ``(None, wait)`` where ``wait``
        is how long until a refusal report falls due (``None``: nothing
        is pending at all)."""
        env = self._report_due_locked(now)
        if env is not None:
            return env, None
        env = self._next_control_locked()
        if env is not None:
            return env, None
        env = self._next_data_locked()
        if env is not None:
            return env, None
        return None, self._refusal_wait_locked(now)

    def _next_control_locked(self) -> Optional[pb.Envelope]:
        if self._logs_dropped and self._logs:
            dropped, self._logs_dropped = self._logs_dropped, 0
            return _log_envelope(
                pb.LOG_LEVEL_WARN,
                f"{dropped} earlier log message(s) dropped: the session's "
                f"control lane backed up",
            )
        keyed_head = next(iter(self._keyed.items()), None)
        log_head = self._logs[0] if self._logs else None
        if keyed_head is None and log_head is None:
            return None
        if log_head is not None and (
            keyed_head is None or log_head[0] < keyed_head[1].order
        ):
            self._logs.popleft()
            return log_head[1]
        assert keyed_head is not None
        key, slot = keyed_head
        del self._keyed[key]
        return slot.out()

    def _next_data_locked(self) -> Optional[pb.Envelope]:
        best: Optional[_DataLane] = None
        for lane in self._data.values():
            if lane.batches and (
                best is None or lane.batches[0][0] < best.batches[0][0]
            ):
                best = lane
        if best is None:
            return None
        _, env, n = best.batches.popleft()
        best.frames -= n
        return env


__all__ = ["SessionOutbox"]
