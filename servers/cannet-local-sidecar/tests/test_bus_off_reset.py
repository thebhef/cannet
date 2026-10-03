"""Bringing a bus-off controller back, per backend.

A bus-off controller transmits nothing, so its error counters cannot
fall and it stays bus-off until something resets it. PEAK's driver does
that itself when asked at open (``auto_reset``, covered with the open
kwargs); for the rest the state poll calls ``PythonCanChannel.reset``,
which resets in place where the backend can and answers ``False`` where
the channel can only be reopened. Kvaser additionally needed its state
read at all: python-can's ``KvaserBus.state`` answers active
unconditionally, so a Kvaser controller that went bus-off was never
seen to.

Hardware-free: each backend is a duck-typed bus with the surface the
driver touches, and Kvaser's CANlib calls go through a fake
``_KvaserApi``.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import pytest


def _ensure_on_path() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


_ensure_on_path()

from cannet_local_sidecar import driver_python_can as m  # noqa: E402
from cannet_local_sidecar.driver import (  # noqa: E402
    STATE_ACTIVE,
    STATE_BUS_OFF,
    STATE_PASSIVE,
    STATE_UNAVAILABLE,
    STATE_WARNING,
)


def _channel(bus: object) -> m.PythonCanChannel:
    return m.PythonCanChannel(channel_id="x:0", bus=bus, listen_only=False, fd=False)


# ----- Kvaser ------------------------------------------------------------------


class _KvaserBus:
    """The surface python-can's ``KvaserBus`` shows the driver: the
    timestamp offset that marks it, and its two handles."""

    def __init__(self, *, single_handle: bool = False) -> None:
        self._timestamp_offset = 0.0
        self.single_handle = single_handle
        self._read_handle = "read"
        self._write_handle = "read" if single_handle else "write"

    def shutdown(self) -> None:
        pass


class _FakeKvaserApi:
    def __init__(self) -> None:
        self.status = 0x08  # canSTAT_ERROR_ACTIVE
        self.counters = (0, 0)
        self.raises: Optional[Exception] = None
        self.calls: list[tuple[str, object]] = []

    def read_status(self, handle: object) -> int:
        self.calls.append(("status", handle))
        if self.raises:
            raise self.raises
        return self.status

    def read_error_counters(self, handle: object) -> tuple[int, int]:
        self.calls.append(("counters", handle))
        return self.counters

    def reset(self, handles) -> None:
        self.calls.append(("reset", list(handles)))


@pytest.fixture
def kvaser(monkeypatch: "pytest.MonkeyPatch") -> _FakeKvaserApi:
    api = _FakeKvaserApi()
    monkeypatch.setattr(m, "can", object())
    monkeypatch.setattr(m, "_kvaser_api", lambda: api)
    return api


@pytest.mark.parametrize(
    "status, expected",
    [
        (0x08, STATE_ACTIVE),
        (0x04 | 0x08, STATE_WARNING),
        (0x01 | 0x04, STATE_PASSIVE),
        (0x02, STATE_BUS_OFF),
        (0x02 | 0x01, STATE_BUS_OFF),
    ],
)
def test_kvaser_state_is_read_off_the_circuit_status(
    kvaser: _FakeKvaserApi, status: int, expected: str
) -> None:
    kvaser.status = status
    assert _channel(_KvaserBus()).state().state == expected


def test_kvaser_counters_floor_the_status_like_every_other_backend(
    kvaser: _FakeKvaserApi,
) -> None:
    kvaser.status = 0x08
    kvaser.counters = (256, 3)
    st = _channel(_KvaserBus()).state()
    assert (st.state, st.tec, st.rec) == (STATE_BUS_OFF, 256, 3)


def test_kvaser_state_read_that_fails_reports_unavailable(
    kvaser: _FakeKvaserApi,
) -> None:
    kvaser.raises = OSError("canERR_INVHANDLE")
    assert _channel(_KvaserBus()).state().state == STATE_UNAVAILABLE


def test_kvaser_reset_takes_every_handle_off_bus_and_on_again(
    kvaser: _FakeKvaserApi,
) -> None:
    assert _channel(_KvaserBus()).reset() is True
    assert ("reset", ["read", "write"]) in kvaser.calls


def test_kvaser_single_handle_reset_touches_the_one_handle(
    kvaser: _FakeKvaserApi,
) -> None:
    assert _channel(_KvaserBus(single_handle=True)).reset() is True
    assert ("reset", ["read"]) in kvaser.calls


class _RecordingCanlib:
    """python-can's ``can.interfaces.kvaser.canlib`` functions, recorded."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def canIoCtl(self, handle, func, buf, size) -> None:  # noqa: N802
        self.calls.append(("ioctl", handle, func, buf._obj.value, size))

    def canBusOff(self, handle) -> None:  # noqa: N802
        self.calls.append(("off", handle))

    def canBusOn(self, handle) -> None:  # noqa: N802
        self.calls.append(("on", handle))


def test_kvaser_api_reset_keeps_the_receive_timer_running() -> None:
    """Bus-on resets Kvaser's receive timer by default, which would
    invalidate the timestamp offset python-can computed at open. The
    reset turns that off first, then takes every handle off bus before
    any comes back -- a circuit stays on bus while any handle is."""
    api = m._KvaserApi.__new__(m._KvaserApi)
    rec = _RecordingCanlib()
    api._kv = rec
    api._buson_time_auto_reset = 30  # canIOCTL_SET_BUSON_TIME_AUTO_RESET
    api.reset(["r", "w"])
    assert rec.calls == [
        ("ioctl", "r", 30, 0, 4),
        ("ioctl", "w", 30, 0, 4),
        ("off", "r"),
        ("off", "w"),
        ("on", "r"),
        ("on", "w"),
    ]


def test_kvaser_buson_ioctl_constant_is_python_cans() -> None:
    kvc = pytest.importorskip("can.interfaces.kvaser.constants")
    assert kvc.canIOCTL_SET_BUSON_TIME_AUTO_RESET == 30


# ----- Vector ------------------------------------------------------------------


class _VectorBus:
    def __init__(self) -> None:
        self.chip_state: Optional[tuple[int, int, int]] = (0x01, 256, 0)
        self.resets = 0

    def request_chip_state(self) -> None:
        pass

    def reset(self) -> None:
        self.resets += 1

    def shutdown(self) -> None:
        pass


def test_vector_reset_is_python_cans_deactivate_and_reactivate(
    monkeypatch: "pytest.MonkeyPatch",
) -> None:
    monkeypatch.setattr(m, "can", object())
    bus = _VectorBus()
    ch = _channel(bus)
    assert ch.state().state == STATE_BUS_OFF
    assert ch.reset() is True
    assert bus.resets == 1
    # The stale bus-off answer does not outlive the reset.
    assert ch.state().state == STATE_ACTIVE


# ----- PEAK, and everything else -------------------------------------------------


class _PcanBus:
    """A ``PcanBus`` by the marker the driver keys on. Its ``reset`` is
    python-can's ``CAN_Reset``, which clears queues and does not reset
    the controller -- the driver must not mistake it for a recovery."""

    def __init__(self) -> None:
        self.m_objPCANBasic = object()
        self.resets = 0

    def reset(self) -> bool:
        self.resets += 1
        return True

    def shutdown(self) -> None:
        pass


def test_pcan_has_no_in_place_reset_so_the_channel_is_reopened() -> None:
    bus = _PcanBus()
    assert _channel(bus).reset() is False
    assert bus.resets == 0


def test_a_backend_with_nothing_to_offer_is_reopened() -> None:
    class _Plain:
        def shutdown(self) -> None:
            pass

    assert _channel(_Plain()).reset() is False
