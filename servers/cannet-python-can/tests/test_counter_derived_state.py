"""Controller state derived from the error counters the hardware sends.

Measured at the bench on 2026-08-22 with two PEAK PCAN-USB FD adapters
at 500 kbit/s, one transmitting into an open circuit: PCAN-Basic's
``CAN_GetStatus`` never got past ``PCAN_ERROR_BUSWARNING`` (0x8) and the
queued ``PCAN_MESSAGE_STATUS`` frames said the same, while the **error
frames** carried a transmit error counter climbing 8 per failed
transmission -- ``08 10 18 ... 80`` -- pinning at 0x80 for the whole
22-second fault and counting back down to zero on reconnect. TEC 128 is
error-passive under ISO 11898-1, which is why PCAN-View read
"error passive" where a status poll read only warning.

So the counters are the state source and the status word is a floor,
not the answer. The payloads below are the captured bytes, not invented
fixtures.
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


#: The transmit-error-counter values the bench run recorded, in order:
#: the 8-per-failure climb out of health, the pin at 128, the brief
#: overshoot, then the count back down as transmissions succeeded.
_TEC_CLIMB = [
    0x08,
    0x10,
    0x18,
    0x20,
    0x28,
    0x30,
    0x38,
    0x40,
    0x48,
    0x50,
    0x58,
    0x60,
    0x68,
    0x70,
    0x78,
    0x80,
]
_TEC_OVERSHOOT = [0x88, 0x90, 0xB7, 0xBB]
_TEC_FALL = [0xB7, 0x60, 0x20, 0x02, 0x01, 0x00]

#: Byte 1 of the payload is an error-type code: 0x19 while the fault was
#: live, 0x00 during the recovery ramp. Nothing reads it -- it is here so
#: the fixtures are the bytes the hardware sent rather than a subset.
_TYPE_FAULTING = 0x19
_TYPE_RECOVERING = 0x00


def _error_payload(tec: int, rec: int = 0, type_code: int = _TYPE_FAULTING) -> bytes:
    """One PEAK error frame's payload: byte 2 is REC, byte 3 is TEC."""
    return bytes([0x00, type_code, rec, tec])


class _ErrMsg:
    """python-can's ``Message`` as its PCAN backend builds an error frame:
    ``is_error_frame`` set and the raw payload copied verbatim."""

    def __init__(self, data: bytes) -> None:
        self.timestamp = 0.0
        self.arbitration_id = 0
        self.is_extended_id = False
        self.is_rx = True
        self.is_error_frame = True
        self.is_remote_frame = False
        self.is_fd = False
        self.bitrate_switch = False
        self.error_state_indicator = False
        self.data = data
        self.dlc = len(data)


class _PcanErrorBus:
    """A PCAN-shaped bus that hands out a scripted run of error frames.

    ``status()`` answers ``PCAN_ERROR_OK`` unless a test says otherwise,
    so the counter path is on its own: a derivation that read only the
    status word would report a healthy controller through every fault
    below. The measured combination -- a status word stuck at
    ``BUSWARNING`` while the counters climb past it -- has its own test.
    """

    m_objPCANBasic = object()

    def __init__(self, payloads: list[bytes], status: int = 0x00000) -> None:
        self._payloads = list(payloads)
        self._status = status
        self._state = "ACTIVE"

    @property
    def state(self) -> object:
        return self._state

    def status(self) -> int:
        return self._status

    def recv(self, timeout: float) -> object:
        if not self._payloads:
            return None
        return _ErrMsg(self._payloads.pop(0))

    def shutdown(self) -> None:
        pass


class _PcanDataBus(_PcanErrorBus):
    """Same shape, but the frames are ordinary data frames."""

    def recv(self, timeout: float) -> object:
        if not self._payloads:
            return None
        msg = _ErrMsg(self._payloads.pop(0))
        msg.is_error_frame = False
        return msg


class _PlainErrorBus:
    """The same error frames from a backend that is not PCAN: no
    ``m_objPCANBasic``, so nothing here is PEAK's payload layout."""

    def __init__(self, payloads: list[bytes]) -> None:
        self._payloads = list(payloads)
        self._state = "ACTIVE"

    @property
    def state(self) -> object:
        return self._state

    def recv(self, timeout: float) -> object:
        if not self._payloads:
            return None
        return _ErrMsg(self._payloads.pop(0))

    def shutdown(self) -> None:
        pass


def _channel(bus: object) -> PythonCanChannel:
    return PythonCanChannel(
        channel_id="PCAN_USBBUS1", bus=bus, listen_only=False, fd=False
    )


def _drain(ch: PythonCanChannel) -> None:
    while ch.recv(timeout_s=0.0) is not None:
        pass


# ----- The pure derivation ---------------------------------------------------


@pytest.mark.parametrize(
    ("tec", "rec", "expected"),
    [
        (0, 0, drv.STATE_ACTIVE),
        (95, 0, drv.STATE_ACTIVE),
        (0, 95, drv.STATE_ACTIVE),
        (96, 0, drv.STATE_WARNING),
        (0, 96, drv.STATE_WARNING),
        (127, 0, drv.STATE_WARNING),
        (128, 0, drv.STATE_PASSIVE),
        (0, 128, drv.STATE_PASSIVE),
        (255, 0, drv.STATE_PASSIVE),
        (256, 0, drv.STATE_BUS_OFF),
        # REC never takes a controller bus-off: only the transmit
        # counter does, which is why the two are not folded into one
        # "worst counter" before the thresholds are applied.
        (0, 300, drv.STATE_PASSIVE),
    ],
)
def test_the_iso_thresholds_are_where_the_standard_puts_them(
    tec: int, rec: int, expected: str
) -> None:
    assert drv.state_from_counters(tec, rec) == expected


# ----- The recorded fault ----------------------------------------------------


def test_the_recorded_climb_reaches_passive_at_128_not_warning() -> None:
    # The defect, in one test. The status word said BUSWARNING for the
    # whole run; the counters said the controller had gone error-passive
    # part-way through it, which is what PCAN-View displayed.
    bus = _PcanErrorBus([_error_payload(t) for t in _TEC_CLIMB])
    ch = _channel(bus)
    seen = []
    while (frame := ch.recv(timeout_s=0.0)) is not None:
        assert frame.kind == drv.FrameKind.ERROR
        seen.append(ch.state().state)
    assert seen[0] == drv.STATE_ACTIVE, "TEC 8 is a healthy controller"
    assert drv.STATE_WARNING in seen, "TEC crossed 96 on the way up"
    assert seen[-1] == drv.STATE_PASSIVE, "TEC 128 is error-passive"
    assert ch.state().tec == 0x80
    assert ch.state().rec == 0


def test_the_pin_at_128_holds_passive_however_many_frames_arrive() -> None:
    # 114,917 consecutive frames at 0x80 on the bench. The state must not
    # oscillate, and the counters must not accumulate: each frame carries
    # the controller's current register value, not a delta.
    bus = _PcanErrorBus([_error_payload(0x80) for _ in range(500)])
    ch = _channel(bus)
    _drain(ch)
    assert ch.state() == drv.ControllerState(state=drv.STATE_PASSIVE, tec=128, rec=0)


def test_reconnecting_walks_the_counter_back_down_to_active() -> None:
    # The recovery ramp, with byte 1 as the hardware sent it (0x00, not
    # the 0x19 of the fault). Nothing reads that byte; the state has to
    # follow the counter alone.
    bus = _PcanErrorBus(
        [_error_payload(t, type_code=_TYPE_RECOVERING) for t in _TEC_FALL]
    )
    ch = _channel(bus)
    seen = []
    while ch.recv(timeout_s=0.0) is not None:
        seen.append(ch.state().state)
    assert seen[0] == drv.STATE_PASSIVE
    assert seen[-1] == drv.STATE_ACTIVE, "TEC 0 is a healthy controller again"
    assert ch.state().tec == 0


def test_the_overshoot_past_128_is_still_passive_not_bus_off() -> None:
    # ``88 90 b7 bb`` -- above the passive threshold, nowhere near 256. A
    # derivation that treated any counter over 128 as bus-off would have
    # parked the bus here.
    bus = _PcanErrorBus([_error_payload(t) for t in _TEC_OVERSHOOT])
    ch = _channel(bus)
    _drain(ch)
    assert ch.state().state == drv.STATE_PASSIVE


def test_a_receive_side_fault_moves_rec_and_leaves_tec_alone() -> None:
    # Byte 2 is REC. On the bench it stayed 0 because we were the
    # transmitter; the control for reading the right byte is a payload
    # where only byte 2 moves.
    bus = _PcanErrorBus([_error_payload(0, rec=r) for r in (0x08, 0x60, 0x82)])
    ch = _channel(bus)
    _drain(ch)
    st = ch.state()
    assert (st.tec, st.rec) == (0, 0x82)
    assert st.state == drv.STATE_PASSIVE


def test_a_data_frame_never_moves_the_counters() -> None:
    # The control for the decode being gated on the frame kind: a data
    # frame whose payload happens to look like a counter pair must not
    # take the bus error-passive.
    bus = _PcanDataBus([bytes([0x00, 0x19, 0xFF, 0xFF])])
    ch = _channel(bus)
    _drain(ch)
    assert ch.state() == drv.ControllerState(state=drv.STATE_ACTIVE, tec=0, rec=0)


def test_a_short_error_payload_is_ignored_rather_than_guessed_at() -> None:
    # Not every backend's error frame carries counters at these offsets.
    # A payload too short to hold them leaves the last known reading in
    # place instead of reading past the end or inventing a zero.
    bus = _PcanErrorBus([_error_payload(0x80), bytes([0x00, 0x19])])
    ch = _channel(bus)
    _drain(ch)
    assert ch.state().tec == 0x80


def test_a_non_pcan_backend_does_not_decode_error_payloads() -> None:
    # Byte 2/3 as REC/TEC is PEAK's layout. SocketCAN puts them at 6/7
    # and a virtual bus carries whatever the sender put there, so
    # decoding everyone's error frames would invent a fault out of a
    # user's own test traffic.
    ch = _channel(_PlainErrorBus([_error_payload(0x80)]))
    _drain(ch)
    assert ch.state().state == drv.STATE_ACTIVE
    assert ch.state().tec == 0


# ----- The status word, now masked -------------------------------------------


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        # PEAK's own ANYBUSERR is 0x4001C -- BUSLIGHT | BUSWARNING |
        # BUSOFF | BUSPASSIVE -- so these four are flags and combine.
        (0x40008, drv.STATE_PASSIVE),  # BUSPASSIVE | BUSWARNING, as measured
        (0x4001C, drv.STATE_BUS_OFF),  # every bus-error flag at once
        (0x0001C, drv.STATE_BUS_OFF),  # BUSOFF | BUSWARNING | BUSLIGHT
        (0x00008, drv.STATE_WARNING),  # BUSWARNING alone
        (0x00004, drv.STATE_ACTIVE),  # BUSLIGHT is below the warning threshold
        (0x00081, drv.STATE_ACTIVE),  # QXMTFULL | XMTFULL: present and busy
    ],
)
def test_the_bus_error_bits_are_masked_because_they_are_flags(
    status: int, expected: str
) -> None:
    bus = _PcanErrorBus([], status=status)
    assert _channel(bus).state().state == expected


@pytest.mark.parametrize(
    "status",
    [0x00100, 0x00200, 0x01400, 0x01800, 0x01C00, 0x4000000],
)
def test_the_no_hardware_family_still_matches_exactly(status: int) -> None:
    # REGTEST / NODRIVER / ILLHW / ILLNET / ILLHANDLE / INITIALIZE are
    # multi-bit *values*, not flags: ILLHW 0x1400, ILLNET 0x1800 and
    # ILLHANDLE 0x1C00 overlap each other bit for bit, so a masked test
    # would read one as another. They keep the exact match.
    bus = _PcanErrorBus([], status=status)
    assert _channel(bus).state().state == drv.STATE_UNAVAILABLE


def test_the_counters_outrank_a_status_word_that_under_reports() -> None:
    # The bench reading exactly: status BUSWARNING, TEC 128. The state
    # is the worse of the two, so the under-reporting status word cannot
    # hold the controller at warning.
    bus = _PcanErrorBus([_error_payload(0x80)], status=0x00008)
    ch = _channel(bus)
    _drain(ch)
    assert ch.state().state == drv.STATE_PASSIVE


def test_a_status_word_that_over_reports_outranks_healthy_counters() -> None:
    # And the other direction: bus-off is visible in the status word at
    # a TEC a single payload byte cannot express, so the status word is a
    # floor the counters cannot lower.
    bus = _PcanErrorBus([], status=0x00010)
    assert _channel(bus).state().state == drv.STATE_BUS_OFF


def test_an_unreachable_adapter_still_outranks_every_counter() -> None:
    # Phase 2's path, unweakened: a device that cannot be read reports
    # `unavailable` whatever the last counters said. The two answer
    # different faults -- an open CAN wire versus a removed USB device.
    bus = _PcanErrorBus([_error_payload(0x80)], status=0x01400)
    ch = _channel(bus)
    _drain(ch)
    assert ch.state().state == drv.STATE_UNAVAILABLE


def test_warning_rides_its_own_wire_value() -> None:
    assert _state_name_to_proto(drv.STATE_WARNING) == pb.CONTROLLER_STATE_WARNING
    assert pb.CONTROLLER_STATE_WARNING not in (
        pb.CONTROLLER_STATE_ACTIVE,
        pb.CONTROLLER_STATE_PASSIVE,
        pb.CONTROLLER_STATE_BUS_OFF,
        pb.CONTROLLER_STATE_UNAVAILABLE,
    )
