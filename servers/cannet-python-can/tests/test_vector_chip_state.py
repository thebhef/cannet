"""Controller state from Vector's chip-state events.

**Unverified against hardware.** No Vector adapter — and no Vector XL
library — exists in the environment these tests run in: python-can
answers the import with *"Could not import vxlapi: Vector XL library not
found"*, so the backend cannot even load here. Everything below
exercises the seam against faked chip-state events whose shape is read
off the installed python-can 4.6.1 (``xlclass.s_xl_chip_state``,
``xlclass.s_xl_can_ev_chip_state``, ``xldefine.XL_BusStatus`` and the
two event-tag enums). What they pin is that the driver reads the fields
the XL API defines and feeds them to the one derivation PCAN already
uses; what they cannot pin is that a real VN card populates those
fields the way the header says. The bench numbers behind the derivation
itself are PEAK's.

``VectorBus.handle_can_event`` / ``handle_canfd_event`` are empty
methods python-can calls for every non-message event and documents for
subclassing -- their own docstrings name ``XL_CHIP_STATE`` and
``XL_CAN_EV_TAG_CHIP_STATE`` as tags that arrive there. That is the
supported seam, which is why nothing here patches python-can.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import pytest


def _ensure_on_path() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


_ensure_on_path()

from cannet_python_can import driver as drv  # noqa: E402
from cannet_python_can import driver_python_can as dpc  # noqa: E402
from cannet_python_can.driver_python_can import PythonCanChannel  # noqa: E402


# ----- Fakes shaped like the XL structs --------------------------------------


class _ChipState:
    """``s_xl_chip_state`` / ``s_xl_can_ev_chip_state``: the three fields
    both structs share, in the order the header declares them."""

    def __init__(self, bus_status: int, tx: int, rx: int) -> None:
        self.busStatus = bus_status  # noqa: N815 - the XL field's own name
        self.txErrorCounter = tx  # noqa: N815
        self.rxErrorCounter = rx  # noqa: N815


class _TagData:
    def __init__(self, **fields: object) -> None:
        self.__dict__.update(fields)


class _ClassicEvent:
    """``XLevent``: the chip state lands in ``tagData.chipState``."""

    def __init__(self, tag: int, chip_state: Optional[_ChipState] = None) -> None:
        self.tag = tag
        self.tagData = _TagData(chipState=chip_state)  # noqa: N815


class _FdEvent:
    """``XLcanRxEvent``: the chip state lands in ``tagData.canChipState``,
    a different union member with the same three leading fields."""

    def __init__(self, tag: int, chip_state: Optional[_ChipState] = None) -> None:
        self.tag = tag
        self.tagData = _TagData(canChipState=chip_state)  # noqa: N815


class _VectorBus:
    """A bus with the surface the driver's Vector path uses: the recorded
    chip state and the poll that asks for a fresh one.

    Duck-typed rather than a real ``VectorBus``, because a real one needs
    the XL library to construct. That the subclass really does record
    what arrives has its own test below, driven through the same hooks
    python-can calls.
    """

    def __init__(
        self,
        chip_state: Optional[tuple[int, int, int]] = None,
        *,
        request_raises: bool = False,
    ) -> None:
        self.chip_state = chip_state
        self.requests = 0
        self._request_raises = request_raises
        self._payloads: list[bytes] = []

    def request_chip_state(self) -> None:
        self.requests += 1
        if self._request_raises:
            raise OSError("XL_ERR_INVALID_PORT")

    def recv(self, timeout: float) -> object:
        if not self._payloads:
            return None
        return _ErrMsg(self._payloads.pop(0))

    def shutdown(self) -> None:
        pass


class _ErrMsg:
    """python-can's ``Message`` for an error frame, as the tests for the
    PEAK path build one."""

    def __init__(self, data: bytes) -> None:
        self.timestamp = 0.0
        self.arbitration_id = 0
        self.is_extended_id = False
        self.is_tx = False
        self.is_error_frame = True
        self.is_remote_frame = False
        self.is_fd = False
        self.bitrate_switch = False
        self.error_state_indicator = False
        self.data = data
        self.dlc = len(data)


def _channel(bus: object) -> PythonCanChannel:
    return PythonCanChannel(
        channel_id="vector:VN1640A(SN:12345, ch:0)",
        bus=bus,
        listen_only=False,
        fd=False,
    )


# ----- The constants are the vendor's ----------------------------------------


def test_the_chip_state_constants_match_python_cans_own_definitions() -> None:
    # Spelled out in the driver so the module loads with no XL library
    # present, which means they can drift from the enums they copy. This
    # is the guard: it reads the installed package, which imports fine
    # even though the DLL behind it does not.
    from can.interfaces.vector import xldefine

    assert dpc._XL_CHIPSTAT_BUSOFF == xldefine.XL_BusStatus.XL_CHIPSTAT_BUSOFF
    assert (
        dpc._XL_CHIPSTAT_ERROR_PASSIVE
        == xldefine.XL_BusStatus.XL_CHIPSTAT_ERROR_PASSIVE
    )
    assert (
        dpc._XL_CHIPSTAT_ERROR_WARNING
        == xldefine.XL_BusStatus.XL_CHIPSTAT_ERROR_WARNING
    )
    assert dpc._XL_EVENT_TAG_CHIP_STATE == xldefine.XL_EventTags.XL_CHIP_STATE
    assert (
        dpc._XL_CANFD_EVENT_TAG_CHIP_STATE
        == xldefine.XL_CANFD_RX_EventTags.XL_CAN_EV_TAG_CHIP_STATE
    )


# ----- busStatus is a bit field ----------------------------------------------


@pytest.mark.parametrize(
    ("bus_status", "expected"),
    [
        (0x08, drv.STATE_ACTIVE),  # ERROR_ACTIVE alone
        (0x04, drv.STATE_WARNING),  # ERROR_WARNING
        (0x02, drv.STATE_PASSIVE),  # ERROR_PASSIVE
        (0x01, drv.STATE_BUS_OFF),  # BUSOFF
        (0x06, drv.STATE_PASSIVE),  # PASSIVE | WARNING: a controller past
        #                             the warning limit and still counting
        (0x03, drv.STATE_BUS_OFF),  # BUSOFF | PASSIVE
        (0x00, drv.STATE_ACTIVE),  # nothing set says nothing is wrong
    ],
)
def test_the_bus_status_bits_are_masked_because_they_are_flags(
    bus_status: int, expected: str
) -> None:
    assert dpc._xl_chip_state_state(bus_status) == expected


# ----- The documented hooks record what arrives ------------------------------


def _hooked_bus() -> object:
    """An instance of the real ``VectorBus`` subclass, built without
    running ``VectorBus.__init__`` -- that needs the XL library. The
    hooks touch nothing but ``chip_state``, which is a class attribute so
    an unopened instance reads it as ``None``."""
    cls = dpc._chip_state_vector_bus_class()
    return cls.__new__(cls)


def test_the_subclass_overrides_the_hooks_python_can_leaves_empty() -> None:
    from can.interfaces.vector import VectorBus

    cls = dpc._chip_state_vector_bus_class()
    assert issubclass(cls, VectorBus)
    assert cls.handle_can_event is not VectorBus.handle_can_event
    assert cls.handle_canfd_event is not VectorBus.handle_canfd_event


def test_a_classic_chip_state_event_is_recorded() -> None:
    bus = _hooked_bus()
    assert bus.chip_state is None
    bus.handle_can_event(_ClassicEvent(4, _ChipState(0x02, 128, 3)))
    assert bus.chip_state == (0x02, 128, 3)


def test_an_fd_chip_state_event_is_recorded_from_its_own_union_member() -> None:
    bus = _hooked_bus()
    bus.handle_canfd_event(_FdEvent(1033, _ChipState(0x04, 100, 0)))
    assert bus.chip_state == (0x04, 100, 0)


@pytest.mark.parametrize("tag", [8, 11, 6])  # XL_TIMER, XL_SYNC_PULSE, XL_TRANSCEIVER
def test_a_classic_event_that_is_not_a_chip_state_is_left_alone(tag: int) -> None:
    # python-can routes *every* non-message event to this hook, so the
    # tag test is what keeps a timer tick from being read as a chip
    # state -- the union member would be whatever bytes that event put
    # there.
    bus = _hooked_bus()
    bus.handle_can_event(_ClassicEvent(4, _ChipState(0x02, 128, 0)))
    bus.handle_can_event(_ClassicEvent(tag))
    assert bus.chip_state == (0x02, 128, 0)


@pytest.mark.parametrize("tag", [1025, 1026, 1027])  # RX_ERROR, TX_ERROR, TX_REQUEST
def test_an_fd_event_that_is_not_a_chip_state_is_left_alone(tag: int) -> None:
    bus = _hooked_bus()
    bus.handle_canfd_event(_FdEvent(1033, _ChipState(0x04, 100, 0)))
    bus.handle_canfd_event(_FdEvent(tag))
    assert bus.chip_state == (0x04, 100, 0)


# ----- The same derivation PCAN feeds ----------------------------------------


@pytest.mark.parametrize(
    ("tec", "rec", "expected"),
    [
        (0, 0, drv.STATE_ACTIVE),
        (96, 0, drv.STATE_WARNING),
        (0, 96, drv.STATE_WARNING),
        (128, 0, drv.STATE_PASSIVE),
        (0, 128, drv.STATE_PASSIVE),
        (255, 255, drv.STATE_PASSIVE),
    ],
)
def test_the_counters_drive_the_state_through_the_shared_derivation(
    tec: int, rec: int, expected: str
) -> None:
    # One rule, two vendors: the thresholds are `state_from_counters`,
    # not a second table written for Vector.
    ch = _channel(_VectorBus((0x08, tec, rec)))
    st = ch.state()
    assert st.state == expected
    assert (st.tec, st.rec) == (tec, rec)
    assert st.state == drv.state_from_counters(tec, rec)


def test_the_bus_status_cannot_talk_the_counters_down() -> None:
    # The failure mode measured on PEAK: a status word that stops at
    # warning while the counters are already past the passive threshold.
    ch = _channel(_VectorBus((0x04, 200, 0)))
    assert ch.state().state == drv.STATE_PASSIVE


def test_the_counters_cannot_talk_the_bus_status_down() -> None:
    # And the other direction: bus-off is a state the chip reports at a
    # transmit counter the byte-wide field cannot express.
    ch = _channel(_VectorBus((0x01, 255, 0)))
    assert ch.state().state == drv.STATE_BUS_OFF


def test_a_channel_that_has_not_answered_yet_reads_healthy_and_still_asks() -> None:
    # The XL driver answers a request asynchronously, so the first poll
    # after open has nothing to report. It must not invent a fault, and
    # it must still place the request that fills the next one.
    bus = _VectorBus(None)
    st = _channel(bus).state()
    assert (st.state, st.tec, st.rec) == (drv.STATE_ACTIVE, 0, 0)
    assert bus.requests == 1


def test_every_state_read_asks_the_chip_for_a_fresh_reading() -> None:
    # Polled on the state pump's cadence, the same one PCAN's status read
    # runs on, so the publish-on-change gate coalesces Vector's readings
    # exactly as it does PEAK's.
    bus = _VectorBus((0x08, 0, 0))
    ch = _channel(bus)
    for _ in range(3):
        ch.state()
    assert bus.requests == 3


def test_a_request_that_fails_at_the_device_reports_unavailable() -> None:
    # `xlCanRequestChipState` goes through python-can's `errcheck`, which
    # raises on any non-zero XL status -- an unplugged card included. A
    # read we cannot make must not render as a healthy bus.
    bus = _VectorBus((0x08, 0, 0), request_raises=True)
    assert _channel(bus).state().state == drv.STATE_UNAVAILABLE


def test_vector_does_not_decode_error_frame_payloads_as_peak_counters() -> None:
    # Bytes 2/3 as REC/TEC is PEAK's error-frame layout. Vector reports
    # its counters through chip-state events instead, so a Vector error
    # frame's payload must not move them.
    bus = _VectorBus((0x08, 0, 0))
    bus._payloads = [bytes([0x00, 0x19, 0x00, 0x80])]
    ch = _channel(bus)
    while ch.recv(timeout_s=0.0) is not None:
        pass
    st = ch.state()
    assert (st.state, st.tec, st.rec) == (drv.STATE_ACTIVE, 0, 0)


# ----- The sidecar still runs with no Vector library at all ------------------


def test_enumeration_survives_a_machine_with_no_vector_xl_library() -> None:
    # This one *is* verified here rather than assumed: the XL library is
    # genuinely absent in this environment (python-can logs "Could not
    # import vxlapi"), so the Vector backend cannot load. Enumeration
    # must still answer, and the subclass must not be built at import
    # time -- it is what would drag the failing import into module load.
    assert isinstance(list(dpc.PythonCanDriver().list_channels()), list)


def test_building_the_subclass_needs_no_xl_library_either() -> None:
    # The class object comes from `canlib`, which catches the DLL's
    # absence itself; only *opening* a bus needs the library. Cached, so
    # the second call is the same object.
    first = dpc._chip_state_vector_bus_class()
    assert first is dpc._chip_state_vector_bus_class()
