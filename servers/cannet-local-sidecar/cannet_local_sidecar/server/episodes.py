"""Bus-error episodes, counted at the source (ADR 0060 rules 1 and 2).

An interface's error frames are folded into **bus-error episodes**: an
episode opens at an error frame and closes after
:data:`_EPISODE_CLOSE_AFTER_NS` without one. The first
:data:`_DEFAULT_ERROR_ROW_CAP` error frames of an episode (or whatever
cap the client configured) are forwarded as trace rows -- the
**error-row cap** -- and the rest are only counted. The cap resets when
the episode closes, so every blast gets its first rows.

:class:`EpisodeAccumulator` is the per-interface state. The receive
thread feeds it every frame it reads; the state poll ticks it at its
250 ms cadence. Both hand back ``BusErrorEpisode`` reports for the
interface to broadcast: one when an episode opens, one per tick while
it is open, and one when it closes.

"1 s without one" is judged on two clocks, whichever says so first: the
frames' own hardware timestamps (a frame stamped a second after the
episode's last error closes it), and the sidecar's monotonic clock (a
second since the last error was *read*), so an episode on a bus that has
gone completely quiet still closes.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Optional

from cannet_python_wire._proto import cannet_pb2 as pb

from .. import driver as drv

#: An episode closes after this long without an error frame. The finest
#: grain any view shows: the host merges episodes at its reader's gap
#: (ADR 0035), so the sidecar's closing gap is the floor.
_EPISODE_CLOSE_AFTER_NS = 1_000_000_000
_EPISODE_CLOSE_AFTER_S = _EPISODE_CLOSE_AFTER_NS / 1e9

#: Error frames of each episode forwarded as trace rows when the client
#: has not configured a cap (``ConfigureBus.error_row_cap`` unset):
#: Vector's NACK error-frame filter keeps the same number (ADR 0060
#: rule 2).
_DEFAULT_ERROR_ROW_CAP = 16


@dataclass
class _Episode:
    seq: int
    first_ns: int
    last_ns: int
    last_mono_s: float
    cap: int
    count: int = 0
    rows: int = 0
    tx_count: int = 0
    rx_count: int = 0
    tec: int = 0
    rec: int = 0
    #: Whether any of this episode's frames carried the counters; if
    #: none did, the state poll's reading stands in for them.
    counters_from_frames: bool = False
    kinds: dict[str, int] = field(default_factory=dict)


class EpisodeAccumulator:
    """One interface's bus-error episodes. Thread-safe: fed by the
    receive thread, ticked by the state poll."""

    def __init__(self, interface_id: str, *, cap: int = _DEFAULT_ERROR_ROW_CAP) -> None:
        self._interface_id = interface_id
        self._lock = threading.Lock()
        self._cap = cap
        self._seq = 0
        self._cur: Optional[_Episode] = None
        # The latest counters known, from an error frame or the state
        # poll, for an episode whose frames carry none.
        self._tec = 0
        self._rec = 0

    def set_cap(self, cap: Optional[int]) -> None:
        """The error-row cap for episodes that open from now on; ``None``
        restores the default. An open episode keeps the cap it opened
        with."""
        with self._lock:
            self._cap = _DEFAULT_ERROR_ROW_CAP if cap is None else max(0, int(cap))

    @property
    def cap(self) -> int:
        with self._lock:
            return self._cap

    def is_open(self) -> bool:
        return self._cur is not None

    def on_error(
        self, err: drv.BusError, ts_ns: int, mono_s: float
    ) -> tuple[bool, list[pb.BusErrorEpisode]]:
        """Fold one error frame, stamped ``ts_ns`` on the frames' clock
        and read at monotonic ``mono_s``. Returns whether it is one of
        the episode's first-N rows, and the reports to publish (a closing
        one for an episode a second stale, an opening one for a new
        episode)."""
        reports: list[pb.BusErrorEpisode] = []
        with self._lock:
            cur = self._cur
            if cur is not None and ts_ns - cur.last_ns >= _EPISODE_CLOSE_AFTER_NS:
                reports.append(self._close_locked())
                cur = None
            if err.tec is not None and err.rec is not None:
                self._tec, self._rec = err.tec, err.rec
                if cur is not None:
                    cur.tec, cur.rec = err.tec, err.rec
                    cur.counters_from_frames = True
            if not err.counted:
                return False, reports
            opened = cur is None
            if cur is None:
                self._seq += 1
                cur = _Episode(
                    seq=self._seq,
                    first_ns=ts_ns,
                    last_ns=ts_ns,
                    last_mono_s=mono_s,
                    cap=self._cap,
                    tec=self._tec,
                    rec=self._rec,
                    counters_from_frames=err.tec is not None,
                )
                self._cur = cur
            cur.count += 1
            kind = err.kind if err.kind in drv.ERROR_KINDS else "unknown"
            cur.kinds[kind] = cur.kinds.get(kind, 0) + 1
            if err.direction == "tx":
                cur.tx_count += 1
            elif err.direction == "rx":
                cur.rx_count += 1
            cur.first_ns = min(cur.first_ns, ts_ns)
            cur.last_ns = max(cur.last_ns, ts_ns)
            cur.last_mono_s = mono_s
            row = cur.rows < cur.cap
            if row:
                cur.rows += 1
            if opened:
                reports.append(self._report_locked(cur, open_=True))
        return row, reports

    def on_frame(self, ts_ns: int) -> list[pb.BusErrorEpisode]:
        """A frame that is not an error, stamped ``ts_ns``: closes an
        episode whose last error is a second older on the frames' own
        clock. One unlocked read when no episode is open, which is the
        receive thread's common case."""
        if self._cur is None:
            return []
        with self._lock:
            cur = self._cur
            if cur is None or ts_ns - cur.last_ns < _EPISODE_CLOSE_AFTER_NS:
                return []
            return [self._close_locked()]

    def tick(self, mono_s: float, tec: int, rec: int) -> list[pb.BusErrorEpisode]:
        """The state poll's pass at monotonic ``mono_s``, with the
        counters it just read: republish an open episode, or close it if
        no error has been read for a second."""
        with self._lock:
            self._tec, self._rec = tec, rec
            cur = self._cur
            if cur is None:
                return []
            if not cur.counters_from_frames:
                cur.tec, cur.rec = tec, rec
            if mono_s - cur.last_mono_s >= _EPISODE_CLOSE_AFTER_S:
                return [self._close_locked()]
            return [self._report_locked(cur, open_=True)]

    def _close_locked(self) -> pb.BusErrorEpisode:
        cur = self._cur
        assert cur is not None
        self._cur = None
        return self._report_locked(cur, open_=False)

    def _report_locked(self, cur: _Episode, *, open_: bool) -> pb.BusErrorEpisode:
        return pb.BusErrorEpisode(
            interface_id=self._interface_id,
            seq=cur.seq,
            first_ns=cur.first_ns,
            last_ns=cur.last_ns,
            count=cur.count,
            count_by_kind=pb.ErrorKindCounts(**cur.kinds),
            tx_count=cur.tx_count,
            rx_count=cur.rx_count,
            tec=cur.tec,
            rec=cur.rec,
            open=open_,
        )


__all__ = ["EpisodeAccumulator"]
