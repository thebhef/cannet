"""Unwrapping Kvaser's 32-bit receive timer.

python-can's Kvaser backend reads a frame's timestamp out of
``canReadWait`` as a 32-bit count of 10 µs ticks and hands it back as
``ticks * 1e-5 + self._timestamp_offset`` with no wrap handling
(python-can 4.6.1 and its ``main`` as of 2026-09-23). The counter wraps
every ``2**32 * 10 µs`` = 42,949.67296 s, so every receive timestamp
after the wrap is 11 h 55 m earlier than the one before it — which
downstream reads as frames arriving before the session started
(ADR 0024: one origin, elapsed time from it).

The driver keeps the last raw stamp per open channel and counts a wrap
when a new one falls more than half a period behind. Hardware-free: the
tests drive synthetic ``can.Message``-shaped objects through a bus
shaped like python-can's ``KvaserBus``.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Optional


def _ensure_on_path() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


_ensure_on_path()

from cannet_local_sidecar.driver_python_can import (  # noqa: E402
    _KVASER_WRAP_PERIOD_S,
    PythonCanChannel,
)

#: A plausible ``_timestamp_offset``: the Unix time at which the
#: adapter's tick counter read zero. Placed one wrap period in the past
#: so every stamp these tests build — raw or corrected — lands inside
#: the shared mapper's one-day plausibility window, as a real capture's
#: would. A fixed epoch would age out of that window and take the whole
#: file with it.
_OFFSET = time.time() - _KVASER_WRAP_PERIOD_S


class _Msg:
    """The subset of ``can.Message`` the wire mapper reads, plus the
    settable ``timestamp`` the driver corrects in place."""

    def __init__(self, timestamp: float, arbitration_id: int = 0x123) -> None:
        self.timestamp = timestamp
        self.arbitration_id = arbitration_id
        self.is_extended_id = False
        self.is_rx = True
        self.is_tx = False
        self.data = b"\x01\x02"
        self.dlc = 2
        self.is_error_frame = False
        self.is_remote_frame = False
        self.is_fd = False
        self.bitrate_switch = False
        self.error_state_indicator = False


class _PlainBus:
    """A backend whose stamps are somebody else's problem — no Kvaser
    marker, so the driver must leave its timestamps alone."""

    def __init__(self, stamps: list[float]) -> None:
        self._stamps = list(stamps)
        self.state = "ACTIVE"

    def recv(self, timeout: float) -> Optional[_Msg]:
        if not self._stamps:
            return None
        return _Msg(self._stamps.pop(0))

    def shutdown(self) -> None:
        pass


class _KvaserShapedBus(_PlainBus):
    """python-can's ``KvaserBus``, reduced to the attribute that marks
    it: ``_timestamp_offset``, the open-time correction its ``recv``
    adds to every wrapping tick count."""

    _timestamp_offset = _OFFSET


def _channel(bus: object) -> PythonCanChannel:
    return PythonCanChannel(
        channel_id="kvaser:0(SN:1, ch:0)", bus=bus, listen_only=False, fd=False
    )


def _raw(ticks_since_offset_s: float) -> float:
    """The float python-can hands back for a tick count that has been
    reduced modulo 2**32."""
    return _OFFSET + ticks_since_offset_s


def _drain(ch: PythonCanChannel) -> list[int]:
    out = []
    while True:
        frame = ch.recv(timeout_s=0.0)
        if frame is None:
            return out
        out.append(frame.timestamp_ns)


def test_the_wrap_period_is_the_32_bit_counter_at_ten_microseconds() -> None:
    # The constant the rest of the file leans on, stated once: 2**32
    # ticks of Kvaser's TIMESTAMP_RESOLUTION = 10 µs.
    assert _KVASER_WRAP_PERIOD_S == (1 << 32) * 10 / 1_000_000.0
    assert round(_KVASER_WRAP_PERIOD_S, 5) == 42_949.67296


def test_stamps_below_the_wrap_pass_through_unchanged() -> None:
    bus = _KvaserShapedBus([_raw(10.0), _raw(11.0), _raw(12.5)])
    ch = _channel(bus)
    assert _drain(ch) == [
        int(_raw(10.0) * 1e9),
        int(_raw(11.0) * 1e9),
        int(_raw(12.5) * 1e9),
    ]
    assert ch.timer_wraps() == 0


def test_a_wrap_is_unwrapped_into_a_continuous_timeline() -> None:
    # Two frames 1 ms apart across the wrap: the second comes back from
    # python-can 42,949.67 s *earlier* than the first.
    before = _raw(_KVASER_WRAP_PERIOD_S - 0.001)
    after = _raw(0.0)
    ch = _channel(_KvaserShapedBus([_raw(0.5), before, after, _raw(0.002)]))
    stamps = _drain(ch)
    assert stamps == sorted(stamps), f"not monotonic: {stamps}"
    # The 1 ms gap the bus actually saw survives the correction.
    assert abs((stamps[2] - stamps[1]) - 1_000_000) < 10_000
    assert abs((stamps[3] - stamps[2]) - 2_000_000) < 10_000
    assert ch.timer_wraps() == 1


def test_two_wraps_add_two_periods() -> None:
    ch = _channel(
        _KvaserShapedBus(
            [
                _raw(_KVASER_WRAP_PERIOD_S - 1.0),
                _raw(1.0),
                _raw(_KVASER_WRAP_PERIOD_S - 1.0),
                _raw(1.0),
            ]
        )
    )
    stamps = _drain(ch)
    assert stamps == sorted(stamps), f"not monotonic: {stamps}"
    assert ch.timer_wraps() == 2
    # Elapsed is what the counter says it is: 2 s across the first
    # rollover, a lap less those 2 s back up to the top, then 2 s across
    # the second -- one period plus 2 s, not one period minus 42,947 s.
    elapsed_s = (stamps[-1] - stamps[0]) / 1e9
    assert abs(elapsed_s - (_KVASER_WRAP_PERIOD_S + 2.0)) < 0.001


def test_ordinary_out_of_order_delivery_is_not_a_wrap() -> None:
    # Frames arriving microseconds out of order across a receive queue
    # are normal. Only a jump of more than half a period is a wrap.
    ch = _channel(
        _KvaserShapedBus([_raw(100.0), _raw(99.999), _raw(100.001), _raw(100.0005)])
    )
    stamps = _drain(ch)
    assert ch.timer_wraps() == 0
    assert stamps == [
        int(_raw(100.0) * 1e9),
        int(_raw(99.999) * 1e9),
        int(_raw(100.001) * 1e9),
        int(_raw(100.0005) * 1e9),
    ]


def test_just_under_half_a_period_back_is_not_a_wrap() -> None:
    # The boundary, from the side that must not fire. A jump back of
    # 5 h 57 m 54 s -- one second short of half a period -- is still
    # read as reordering, not as a rollover.
    ch = _channel(
        _KvaserShapedBus(
            [
                _raw(_KVASER_WRAP_PERIOD_S / 2 + 10.0),
                _raw(11.0),
            ]
        )
    )
    _drain(ch)
    assert ch.timer_wraps() == 0


def test_just_over_half_a_period_back_is_a_wrap() -> None:
    # The same boundary from the other side, so the threshold is pinned
    # rather than merely not-tripped.
    ch = _channel(
        _KvaserShapedBus(
            [
                _raw(_KVASER_WRAP_PERIOD_S / 2 + 10.0),
                _raw(9.0),
            ]
        )
    )
    _drain(ch)
    assert ch.timer_wraps() == 1


def test_a_non_kvaser_backend_is_left_alone() -> None:
    # The control. A bus with no Kvaser marker keeps whatever its own
    # backend stamped, wrap-shaped jump and all: the correction is for
    # one defective backend, not a policy about time.
    stamps_in = [_raw(_KVASER_WRAP_PERIOD_S - 1.0), _raw(1.0)]
    ch = _channel(_PlainBus(stamps_in))
    assert _drain(ch) == [int(s * 1e9) for s in stamps_in]
    assert ch.timer_wraps() == 0


def test_a_reopened_channel_counts_from_zero() -> None:
    # python-can re-derives ``_timestamp_offset`` from the (wrapping)
    # hardware timer every time the bus is opened, so a reconfigure's
    # new channel inherits nothing: its stamps are correct again at
    # open, and carrying a wrap count across would push them a full
    # period into the future.
    first = _channel(_KvaserShapedBus([_raw(_KVASER_WRAP_PERIOD_S - 1.0), _raw(1.0)]))
    _drain(first)
    assert first.timer_wraps() == 1
    second = _channel(_KvaserShapedBus([_raw(2.0), _raw(3.0)]))
    assert _drain(second) == [int(_raw(2.0) * 1e9), int(_raw(3.0) * 1e9)]
    assert second.timer_wraps() == 0


def test_a_missing_stamp_neither_wraps_nor_anchors() -> None:
    # python-can leaves ``timestamp`` at 0.0 when a backend does not
    # stamp; the shared mapper substitutes the wall clock. A zero must
    # not read as a 42,949 s jump back, and must not become the anchor
    # the next real stamp is compared against.
    ch = _channel(_KvaserShapedBus([_raw(100.0), 0.0, _raw(100.001)]))
    stamps = _drain(ch)
    assert ch.timer_wraps() == 0
    assert stamps[0] == int(_raw(100.0) * 1e9)
    assert stamps[2] == int(_raw(100.001) * 1e9)
