"""What a channel reports about its controller when the device is gone.

A removed USB adapter is not a fault-confinement state — the controller
is not unwell, it is absent — so the driver reports it as its own state
rather than as the healthy default. These tests pin the two independent
detectors a python-can channel has for that:

- a **driver read that fails**: ``Bus.recv`` raising is the adapter
  going away under an in-flight read;
- **PCAN's live channel status**: ``PcanBus.status()`` is a device
  query (``CAN_GetStatus``), unlike ``PcanBus.state``, which is a
  stored echo of the value the bus was *configured* with and therefore
  never moves on its own.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest


def _ensure_on_path() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


_ensure_on_path()

from cannet_python_can import driver as drv  # noqa: E402
from cannet_python_can.driver_python_can import PythonCanChannel  # noqa: E402
from cannet_python_can.server.helpers import _state_name_to_proto  # noqa: E402
from cannet_python_can._proto import cannet_pb2 as pb  # noqa: E402


class _PlainBus:
    """A backend that exposes python-can's ``Bus.state`` and nothing else."""

    def __init__(self, state: object = "ACTIVE", raises: bool = False) -> None:
        self._state = state
        self._raises = raises
        self.received: list[object] = []

    @property
    def state(self) -> object:
        if self._raises:
            raise OSError("device removed")
        return self._state

    def recv(self, timeout: float) -> None:
        if self._raises:
            raise OSError("device removed")
        return None

    def shutdown(self) -> None:
        pass


class _PcanShapedBus(_PlainBus):
    """A bus with PCAN's live-status read. ``state`` is deliberately a
    stored ``ACTIVE`` echo, as python-can's real ``PcanBus`` has it, so a
    test that passes by reading ``state`` is not reading the device."""

    #: python-can's marker for its PCAN backend; the real bus holds the
    #: PCANBasic handle here.
    m_objPCANBasic = object()

    def __init__(self, status: int) -> None:
        super().__init__(state="ACTIVE")
        self._status = status

    def status(self) -> int:
        return self._status


def _channel(bus: object) -> PythonCanChannel:
    return PythonCanChannel(
        channel_id="PCAN_USBBUS1", bus=bus, listen_only=False, fd=False
    )


def test_a_failed_controller_read_is_not_reported_as_a_healthy_controller() -> None:
    # The regression this file exists for: `state()` used to swallow
    # every exception and return the ACTIVE default, so a channel whose
    # device had gone reported a healthy controller forever.
    ch = _channel(_PlainBus(raises=True))
    assert ch.state().state == drv.STATE_UNAVAILABLE


def test_a_read_that_fails_mid_stream_marks_the_channel_unreachable() -> None:
    # The virtual analogue of unplugging the adapter: the reads succeed,
    # then start raising, and the controller state has to follow.
    bus = _PlainBus()
    ch = _channel(bus)
    assert ch.recv(timeout_s=0.0) is None
    assert ch.state().state == drv.STATE_ACTIVE
    bus._raises = True
    with pytest.raises(OSError):
        ch.recv(timeout_s=0.0)
    assert ch.state().state == drv.STATE_UNAVAILABLE


def test_a_read_that_succeeds_again_clears_the_unreachable_mark() -> None:
    # The adapter comes back. Nothing else re-arms the state, so a
    # channel that stayed unavailable after a recovery would keep the
    # bus parked for the rest of the session.
    bus = _PlainBus()
    ch = _channel(bus)
    bus._raises = True
    with pytest.raises(OSError):
        ch.recv(timeout_s=0.0)
    assert ch.state().state == drv.STATE_UNAVAILABLE
    bus._raises = False
    assert ch.recv(timeout_s=0.0) is None
    assert ch.state().state == drv.STATE_ACTIVE


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (0x00000, drv.STATE_ACTIVE),  # PCAN_ERROR_OK
        (0x00004, drv.STATE_ACTIVE),  # PCAN_ERROR_BUSLIGHT — below the limit
        (0x00008, drv.STATE_WARNING),  # PCAN_ERROR_BUSWARNING — at the limit
        (0x00020, drv.STATE_ACTIVE),  # PCAN_ERROR_QRCVEMPTY — nothing to read
        (0x00080, drv.STATE_ACTIVE),  # PCAN_ERROR_QXMTFULL — saturated, present
        (0x40000, drv.STATE_PASSIVE),  # PCAN_ERROR_BUSPASSIVE
        (0x00010, drv.STATE_BUS_OFF),  # PCAN_ERROR_BUSOFF
        (0x00100, drv.STATE_UNAVAILABLE),  # PCAN_ERROR_REGTEST — no hardware
        (0x00200, drv.STATE_UNAVAILABLE),  # PCAN_ERROR_NODRIVER
        (0x01400, drv.STATE_UNAVAILABLE),  # PCAN_ERROR_ILLHW
        (0x01800, drv.STATE_UNAVAILABLE),  # PCAN_ERROR_ILLNET
        (0x01C00, drv.STATE_UNAVAILABLE),  # PCAN_ERROR_ILLHANDLE
        (0x4000000, drv.STATE_UNAVAILABLE),  # PCAN_ERROR_INITIALIZE
    ],
)
def test_pcan_channel_status_maps_onto_the_states_we_report(
    status: int, expected: str
) -> None:
    # A saturated transmit queue and a light bus error are the
    # controls: both mean the adapter is present and working, and
    # neither may park the bus. The bits themselves are masked and the
    # counters they are combined with are the state source — see
    # `test_counter_derived_state.py`; this table is the exact-match
    # no-hardware family plus the single-flag readings.
    assert _channel(_PcanShapedBus(status)).state().state == expected


def test_a_pcan_channel_reads_the_device_not_the_configured_echo() -> None:
    # python-can's `PcanBus.state` returns `self._state`, written only
    # when the bus is *configured* — it never moves on its own, so a
    # reading taken from it can never report bus-off. The live read is
    # `status()`, and this is the test that we take it.
    bus = _PcanShapedBus(0x00010)  # PCAN_ERROR_BUSOFF
    assert bus.state == "ACTIVE", "the echo still says the bus was set up active"
    assert _channel(bus).state().state == drv.STATE_BUS_OFF


def test_a_status_read_that_raises_is_unavailable_not_active() -> None:
    class _Raising(_PcanShapedBus):
        def status(self) -> int:
            raise OSError("device removed")

    assert _channel(_Raising(0)).state().state == drv.STATE_UNAVAILABLE


def test_unavailable_rides_its_own_wire_value() -> None:
    assert (
        _state_name_to_proto(drv.STATE_UNAVAILABLE) == pb.CONTROLLER_STATE_UNAVAILABLE
    )
    assert pb.CONTROLLER_STATE_UNAVAILABLE != pb.CONTROLLER_STATE_BUS_OFF
