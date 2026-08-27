"""Default :mod:`cannet_python_can.driver` implementation, backed by
``python-can``.

Designed so the *module* imports cleanly even when ``python-can`` is
absent — the sidecar must boot and report zero interfaces on a
machine with no vendor SDK installed. The import fallback is checked
at module load; everything else degrades to "no channels available".

Channel id grammar
==================

Every enumerated channel id has the shape ``<vendor>:<body>(<meta>)``
where ``<meta>`` is a comma-separated ``key:value`` list. The body is
the vendor-specific routing key python-can needs; the parens are
metadata the GUI uses for identity (it never has to know what's in
them). :func:`_bus_kwargs_for` strips the parens before handing the
body off to python-can, so the open path stays simple.

Per-vendor shape:

- **Vector** — ``vector:<app_name>(SN:<serial>, ch:<hw_channel>)``
  (``SN:`` is omitted when the card doesn't report a serial).
- **Kvaser** — ``kvaser:<global_index>(SN:<card_serial>, ch:<per_card_channel>)``
  (``SN:`` is omitted when the card doesn't report a serial).
- **PEAK** — ``pcan:<slot>(h:<handle hex>, ch:<controller_number>[, uid:<device_id>])``
  where ``<slot>`` is the PCAN-Basic constant name
  (``PCAN_USBBUS1``…) or a ``handle=0xNN`` fallback for transports
  without a known constant; ``uid:`` appears only when the user has
  set a non-zero device id in PCAN-View.

If a vendor's SDK isn't installed on the host, that vendor simply
contributes zero channels and a one-line info log; the other vendors
still enumerate. The wire-level surface stays vendor-agnostic.
"""

from __future__ import annotations

import logging
import time
from typing import Iterable, List, Optional

from .driver import (
    Channel,
    ControllerState,
    Frame,
    FrameKind,
    OpenConfig,
    STATE_ACTIVE,
    STATE_BUS_OFF,
    STATE_PASSIVE,
    STATE_UNAVAILABLE,
    STATE_WARNING,
    TxRejected,
    state_from_counters,
    worse_state,
)

_log = logging.getLogger(__name__)


try:  # python-can may be absent in a fresh / replaced venv.
    import can  # type: ignore[import-untyped]

    _HAVE_PYTHON_CAN = True
    _IMPORT_ERROR = ""
except Exception as _e:  # noqa: BLE001 - swallow any import-time error.
    can = None  # type: ignore[assignment]
    _HAVE_PYTHON_CAN = False
    _IMPORT_ERROR = repr(_e)


#: PCAN-Basic channel-status codes, from the vendor header python-can
#: vendors as ``can.interfaces.pcan.basic``. Spelled out here rather
#: than imported so a build without the PCAN backend still loads, and
#: so the exact values a reading is compared against are visible where
#: the comparison is.
#:
#: These four are **flags**, and the vendor header says so itself:
#: ``PCAN_ERROR_ANYBUSERR`` is defined as their bitwise union, 0x4001C.
#: A real reading combines them — a controller that is error-passive
#: and still over the warning limit answers 0x40008 — so the bus-error
#: half of a status word is masked, never compared for equality.
_PCAN_ERROR_BUSLIGHT = 0x00004
_PCAN_ERROR_BUSWARNING = 0x00008
_PCAN_ERROR_BUSOFF = 0x00010
_PCAN_ERROR_BUSPASSIVE = 0x40000
#: Statuses that mean there is no reachable adapter behind the handle:
#: the controller registers do not answer (REGTEST), the driver is not
#: loaded (NODRIVER), the hardware / net / client handle is invalid
#: (ILLHW, ILLNET, ILLHANDLE) or the channel is not initialised
#: (INITIALIZE). None of these can be reported by a channel that is
#: open on a present device.
#:
#: Unlike the bus-error flags above, these are multi-bit *values* that
#: overlap each other bit for bit — ILLHW 0x1400, ILLNET 0x1800 and
#: ILLHANDLE 0x1C00 share the 0x0400 and 0x0800 bits — so they keep the
#: exact match a masked test would ruin.
_PCAN_STATUS_UNREACHABLE = frozenset(
    {0x00100, 0x00200, 0x01400, 0x01800, 0x01C00, 0x4000000}
)

#: Byte offsets of the two error counters in a PEAK error frame's
#: payload. Measured on a PCAN-USB FD at the bench: byte 3 stepped by
#: exactly 8 per failed transmission and pinned at 128 — the transmit
#: error counter, by its own arithmetic — while byte 2 stayed 0 on a
#: channel that was only transmitting. Byte 1 is an error-type code
#: nothing here reads.
_PCAN_ERR_REC_OFFSET = 2
_PCAN_ERR_TEC_OFFSET = 3

#: Vector XL chip-state constants, copied from python-can's own
#: ``can.interfaces.vector.xldefine``. Spelled out here for the same
#: reason PEAK's are: this module has to load on a machine with no
#: Vector XL library at all, and the values a reading is tested against
#: should be visible where the test is. A unit test asserts each one
#: still equals the enum member it copies.
#:
#: ``busStatus`` is a bit field — ``XL_BusStatus`` gives BUSOFF 1,
#: ERROR_PASSIVE 2, ERROR_WARNING 4, ERROR_ACTIVE 8, one bit each — so
#: it is masked, exactly like PEAK's bus-error half. ERROR_ACTIVE needs
#: no constant: it is the healthy reading, and so is the fall-through.
_XL_CHIPSTAT_BUSOFF = 0x01
_XL_CHIPSTAT_ERROR_PASSIVE = 0x02
_XL_CHIPSTAT_ERROR_WARNING = 0x04
#: ``XL_EventTags.XL_CHIP_STATE`` — the classic-CAN event queue's tag
#: for a chip-state answer.
_XL_EVENT_TAG_CHIP_STATE = 4
#: ``XL_CANFD_RX_EventTags.XL_CAN_EV_TAG_CHIP_STATE`` — the same answer
#: on the CAN FD queue, which is a different event struct with its own
#: union member.
_XL_CANFD_EVENT_TAG_CHIP_STATE = 1033


def _pcan_status_state(status: int) -> str:
    """The worst fault-confinement state a PCAN status word admits to.

    Masked, because these bits are flags — the vendor header defines
    ``PCAN_ERROR_ANYBUSERR`` as their union, and a controller that is
    error-passive while still over the warning limit answers with both
    set. ``BUSLIGHT`` sits below ISO 11898-1's warning limit and so
    reads as active: a light bus error is a controller counting, not a
    controller in trouble.

    Everything unrecognised reads as active too — a busy transmit queue
    and an empty receive queue both show up here, and a reading that is
    not certainly a fault must not raise one.
    """
    if status & _PCAN_ERROR_BUSOFF:
        return STATE_BUS_OFF
    if status & _PCAN_ERROR_BUSPASSIVE:
        return STATE_PASSIVE
    if status & _PCAN_ERROR_BUSWARNING:
        return STATE_WARNING
    return STATE_ACTIVE


def _xl_chip_state_state(bus_status: int) -> str:
    """The worst fault-confinement state a Vector ``busStatus`` admits to.

    Masked for the same reason PEAK's status word is: ``XL_BusStatus``
    gives each state its own bit, so a controller past the warning limit
    and into error-passive reports both. Nothing set reads as active —
    an answer that is not certainly a fault must not raise one.
    """
    if bus_status & _XL_CHIPSTAT_BUSOFF:
        return STATE_BUS_OFF
    if bus_status & _XL_CHIPSTAT_ERROR_PASSIVE:
        return STATE_PASSIVE
    if bus_status & _XL_CHIPSTAT_ERROR_WARNING:
        return STATE_WARNING
    return STATE_ACTIVE


def _xl_chip_state_reading(chip_state: object) -> tuple[int, int, int]:
    """``(busStatus, tec, rec)`` out of an XL chip-state struct.

    ``s_xl_chip_state`` (classic) and ``s_xl_can_ev_chip_state`` (FD)
    declare the same three leading fields in the same order, so one
    reader serves both event shapes.
    """
    return (
        int(getattr(chip_state, "busStatus", 0)),
        int(getattr(chip_state, "txErrorCounter", 0)),
        int(getattr(chip_state, "rxErrorCounter", 0)),
    )


#: Built once, on first Vector open. Importing python-can's Vector
#: backend probes for the XL library, so the sidecar must not pay for it
#: — or depend on it — at module load.
_vector_bus_class: Optional[type] = None


def _chip_state_vector_bus_class() -> type:
    """python-can's ``VectorBus``, subclassed to keep the chip state the
    XL driver reports.

    ``VectorBus.handle_can_event`` and ``handle_canfd_event`` are empty
    methods python-can calls for every event that is not a message, and
    documents for subclassing; their own docstrings name
    ``XL_CHIP_STATE`` and ``XL_CAN_EV_TAG_CHIP_STATE`` as tags that
    arrive there. That is the supported seam, which is why nothing here
    patches python-can.

    ``Bus.state`` is deliberately *not* implemented on top of this.
    python-can's ``BusState`` has three values and cannot hold warning,
    error-passive and bus-off apart — the ixxat backend has to fold
    bus-off into ``BusState.ERROR`` — while this sidecar's wire carries
    all three plus "unavailable". Conforming would mean flattening the
    model to fit an interface whose meaning python-can itself has left
    unsettled since 2019 (issue #736, open against 4.6.1). The
    derivation stays in this driver's own seam, as it does for PEAK.

    The class object costs nothing beyond the import: ``canlib`` catches
    the XL library's absence itself and only *opening* a bus needs it.
    """
    global _vector_bus_class
    if _vector_bus_class is not None:
        return _vector_bus_class

    from can.interfaces.vector import VectorBus  # type: ignore[import-untyped]

    class _ChipStateVectorBus(VectorBus):  # type: ignore[misc, valid-type]
        """A ``VectorBus`` that remembers the last chip state it was told.

        The XL driver answers ``xlCanRequestChipState`` asynchronously,
        as an event in the same queue the messages come out of, so the
        request and the answer are on opposite sides of a ``recv``. The
        reading is stored as one tuple, so the state poll (its own
        thread) can never read a torn triple from the rx thread's write.
        """

        #: ``(busStatus, tec, rec)``, or ``None`` until the first answer
        #: arrives. A class attribute so it reads correctly before
        #: anything has been received.
        chip_state: Optional[tuple[int, int, int]] = None

        def handle_can_event(self, event: object) -> None:
            if getattr(event, "tag", None) == _XL_EVENT_TAG_CHIP_STATE:
                self.chip_state = _xl_chip_state_reading(event.tagData.chipState)  # type: ignore[attr-defined]

        def handle_canfd_event(self, event: object) -> None:
            if getattr(event, "tag", None) == _XL_CANFD_EVENT_TAG_CHIP_STATE:
                self.chip_state = _xl_chip_state_reading(
                    event.tagData.canChipState  # type: ignore[attr-defined]
                )

        def request_chip_state(self) -> None:
            """Ask the controller for a fresh chip state.

            Polled rather than only awaited: ``xlCanRequestChipState`` is
            already bound in python-can's ``xldriver``, and a request on
            the state poll's cadence means a fault that never produces
            another event still gets noticed. python-can's ``errcheck``
            raises on any non-zero XL status, so a card that has gone
            away surfaces here rather than as silence.
            """
            self.xldriver.xlCanRequestChipState(self.port_handle, self.mask)

    _vector_bus_class = _ChipStateVectorBus
    return _vector_bus_class


def _open_vector_bus(kwargs: dict) -> object:
    """Open a Vector channel as :func:`_chip_state_vector_bus_class`.

    ``can.interface.Bus`` resolves the class from python-can's own
    ``BACKENDS`` table, which can only ever name ``VectorBus`` — there is
    no way to hand it a subclass short of editing that table, and editing
    it would be the monkey-patch the documented ``handle_*_event`` hooks
    exist to avoid. So the class is constructed directly, with the same
    configuration merge ``Bus`` performs first, so a Vector open still
    sees whatever ``can.rc`` or a ``can.conf`` would have contributed.
    """
    assert can is not None  # callable only after import succeeded
    merged = dict(can.util.load_config(config={"interface": "vector", **kwargs}))
    del merged["interface"]
    channel = merged.pop("channel")
    return _chip_state_vector_bus_class()(channel, **merged)


class PythonCanDriver:
    """Default driver: enumerate + open via ``python-can``."""

    def __init__(self) -> None:
        if not _HAVE_PYTHON_CAN:
            _log.warning(
                "python-can not importable (%s); reporting zero channels",
                _IMPORT_ERROR,
            )

    def list_channels(self) -> Iterable[Channel]:
        if not _HAVE_PYTHON_CAN:
            return []
        out: List[Channel] = []
        out.extend(_list_vector())
        out.extend(_list_kvaser())
        out.extend(_list_pcan())
        return out

    def open(self, channel_id: str, config: OpenConfig) -> "PythonCanChannel":
        if not _HAVE_PYTHON_CAN:
            raise KeyError(channel_id)
        interface, kwargs = _bus_kwargs_for(channel_id, config)
        try:
            if interface == "vector":
                bus = _open_vector_bus(kwargs)
            else:
                bus = can.interface.Bus(interface=interface, **kwargs)  # type: ignore[union-attr]
        except Exception as e:  # noqa: BLE001
            raise OSError(f"open {channel_id}: {e}") from e
        if interface == "pcan":
            _disable_pcan_status_frames(bus)
        return PythonCanChannel(
            channel_id=channel_id,
            bus=bus,
            listen_only=config.listen_only,
            fd=config.fd,
        )


class PythonCanChannel:
    """One opened ``python-can`` ``Bus`` plus a small recv/send wrapper."""

    def __init__(
        self, *, channel_id: str, bus: object, listen_only: bool, fd: bool
    ) -> None:
        self.channel_id = channel_id
        self._bus = bus
        self._listen_only = listen_only
        self._fd = fd
        self._closed = False
        # Set when a call into the backend fails at the device boundary
        # -- the adapter was unplugged, the handle was invalidated --
        # and cleared by the next call that succeeds. Read by `state`,
        # which is how "we cannot reach this interface" leaves the
        # driver at all: it is not a fault-confinement state, so
        # nothing else on the channel can carry it.
        #
        # Only reads feed it. A failing `send` is deliberately excluded:
        # a full transmit queue on a bus with no other node raises
        # exactly the same way a missing adapter does, and parking a
        # single-node bench bus is worse than being slow to notice a
        # real removal.
        self._unreachable = False
        # python-can's own marker for its PCAN backend: the real
        # `PcanBus` holds the PCANBasic handle here. Used to gate both
        # the live status read and the error-frame counter decode, since
        # the payload layout below is PEAK's and nobody else's.
        self._is_pcan = hasattr(bus, "m_objPCANBasic")
        # The marker our own `VectorBus` subclass carries: it is the only
        # bus that can be asked for a chip state and remembers the answer.
        self._is_vector = hasattr(bus, "request_chip_state")
        # Last error counters the controller reported, as one tuple so
        # the state poll (its own thread) can never read a torn pair
        # from the rx thread's write. `(rec, tec)`, matching the payload
        # order they are decoded from.
        self._counters: tuple[int, int] = (0, 0)

    def recv(self, timeout_s: float) -> Optional[Frame]:
        if self._closed:
            return None
        try:
            msg = self._bus.recv(timeout=timeout_s)  # type: ignore[attr-defined]
        except Exception:
            self._unreachable = True
            raise
        self._unreachable = False
        if msg is None:
            return None
        frame = _msg_to_frame(msg)
        if self._is_pcan and frame.kind == FrameKind.ERROR:
            self._note_pcan_counters(frame.data)
        return frame

    def _note_pcan_counters(self, data: bytes) -> None:
        """Record the error counters carried by a PEAK error frame.

        This is the only live reading of the controller's registers that
        PCAN offers. ``CAN_GetStatus`` and the queued
        ``PCAN_MESSAGE_STATUS`` frames both stop at ``BUSWARNING`` on a
        transmitter driving an open circuit, while these counters climb
        past the error-passive threshold and count back down when the
        wire is restored.

        Costs two array reads on the receive thread, which matters: the
        measured rate on that fault was about 5,200 error frames a
        second. Nothing is published from here — the state poll reads
        the latest pair on its own 500 ms cadence, which is where the
        coalescing happens.

        A payload too short to hold them leaves the last reading in
        place. Every PEAK error frame observed carried four bytes, and a
        shorter one is a backend we do not have a layout for, not a
        controller reporting zero.
        """
        if len(data) <= _PCAN_ERR_TEC_OFFSET:
            return
        self._counters = (data[_PCAN_ERR_REC_OFFSET], data[_PCAN_ERR_TEC_OFFSET])

    def send(self, frame: Frame) -> None:
        if self._closed:
            raise TxRejected("channel closed")
        if self._listen_only:
            raise TxRejected("listen-only configuration")
        self._reject_if_incompatible(frame)
        msg = _frame_to_msg(frame)
        try:
            self._bus.send(msg)  # type: ignore[attr-defined]
        except Exception as e:  # noqa: BLE001
            raise TxRejected(str(e)) from e

    def _reject_if_incompatible(self, frame: Frame) -> None:
        """Refuse frame shapes that would make python-can raise inside a
        ctypes slice assignment.

        Backends like PCAN copy the payload into a fixed-size ``c_ubyte``
        array (8 bytes for classic, 64 for FD) with a slice assignment
        whose left and right halves must agree in length. When they
        don't — e.g. an FD frame with >8 bytes on a classic-mode bus, or
        a frame whose ``dlc`` disagrees with ``len(data)`` — the bus
        raises a bare ``ValueError("Can only assign sequence of same
        size")`` that's hard to interpret upstream. Reject here so the
        caller sees a precise ``TxRejected`` with the actual mismatch.
        """
        if frame.kind == FrameKind.ERROR:
            return
        if frame.kind == FrameKind.FD and not self._fd:
            raise TxRejected(f"FD frame on classic-mode bus {self.channel_id}")
        if frame.kind == FrameKind.REMOTE and self._fd:
            raise TxRejected(
                f"remote (RTR) frame not supported on FD-mode bus {self.channel_id}"
            )
        if frame.kind == FrameKind.REMOTE:
            return
        max_bytes = 64 if self._fd else 8
        if len(frame.data) > max_bytes:
            raise TxRejected(
                f"payload {len(frame.data)} bytes exceeds {max_bytes}-byte "
                f"limit ({'FD' if self._fd else 'classic'} bus "
                f"{self.channel_id})"
            )
        if frame.dlc and frame.dlc != len(frame.data):
            raise TxRejected(
                f"dlc={frame.dlc} differs from data length "
                f"{len(frame.data)} (bus {self.channel_id})"
            )

    def state(self) -> ControllerState:
        """Read the controller's fault-confinement state, or report that
        the interface cannot be reached.

        Two sources, in order. A read that already failed at the device
        boundary (see :attr:`_unreachable`) settles it: there is nothing
        to ask. Otherwise the backend is asked — PCAN through its error
        counters and its live channel status, Vector through the chip
        state its XL driver reports, everything else through python-can's
        ``Bus.state`` (``BusState.ACTIVE`` / ``PASSIVE`` / ``ERROR``, with
        ``ERROR`` mapped to ``bus_off`` as the closest analog of an ISO
        11898-1 fault state in that three-value enum). A read that raises
        reports :data:`STATE_UNAVAILABLE`, never the healthy default: "we
        cannot reach it" must not render as "it is fine".

        TEC / REC are reported where the backend exposes them and 0
        where it does not; today that means PCAN and Vector.
        """
        if self._closed or can is None:
            return ControllerState()
        if self._unreachable:
            return ControllerState(state=STATE_UNAVAILABLE)
        if self._is_pcan:
            return self._pcan_state()
        if self._is_vector:
            return self._vector_state()
        try:
            raw = self._bus.state  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            self._unreachable = True
            return ControllerState(state=STATE_UNAVAILABLE)
        name = getattr(raw, "name", str(raw)).upper()
        if name == "PASSIVE":
            return ControllerState(state=STATE_PASSIVE)
        if name in ("ERROR", "BUS_OFF", "BUSOFF"):
            return ControllerState(state=STATE_BUS_OFF)
        return ControllerState(state=STATE_ACTIVE)

    def _pcan_state(self) -> ControllerState:
        """PCAN's controller state, derived from the error counters its
        error frames carry and floored by its live channel status.

        **The counters are the state source.** ISO 11898-1 defines fault
        confinement on TEC and REC, and PEAK reports both in every error
        frame (see :meth:`_note_pcan_counters`). They rise 8 per failed
        transmission, fall on every success, and therefore recover
        without anything having to notice that a fault ended.

        **The status word is a floor, not the answer.** Measured on a
        transmitter driving an open circuit, ``CAN_GetStatus`` reported
        ``BUSWARNING`` and never moved further while the counters
        climbed past the error-passive threshold — so a state read from
        the status word alone under-reports a real fault as a healthy
        bus. It still contributes what only it can: bus-off is visible
        there at a transmit counter no single payload byte can express.
        The two are combined with :func:`~cannet_python_can.driver
        .worse_state` so neither can talk the other down.

        Note also that python-can's ``PcanBus.state`` is a **stored
        echo** of the value the bus was configured with — its getter
        returns ``self._state``, written only by the setter ``__init__``
        calls — so it never moves at all and is not consulted here.

        The bus-error bits are masked, because the vendor header's own
        ``PCAN_ERROR_ANYBUSERR`` defines them as a union and a real
        reading combines them. The no-hardware family keeps its exact
        match: those are multi-bit values that overlap each other, and a
        masked test there would read a busy transmit queue as a missing
        adapter.
        """
        rec, tec = self._counters
        from_counters = state_from_counters(tec, rec)
        status_read = getattr(self._bus, "status", None)
        if not callable(status_read):
            return ControllerState(state=from_counters, tec=tec, rec=rec)
        try:
            status = int(status_read())
        except Exception:  # noqa: BLE001
            self._unreachable = True
            return ControllerState(state=STATE_UNAVAILABLE)
        self._unreachable = False
        if status in _PCAN_STATUS_UNREACHABLE:
            self._unreachable = True
            return ControllerState(state=STATE_UNAVAILABLE)
        state = worse_state(_pcan_status_state(status), from_counters)
        return ControllerState(state=state, tec=tec, rec=rec)

    def _vector_state(self) -> ControllerState:
        """Vector's controller state, read off the chip state its XL
        driver reports.

        **Unverified against hardware.** No Vector adapter and no Vector
        XL library existed anywhere this was developed or tested, so what
        follows is written from the XL API's own field definitions and
        exercised against faked events. It is implemented, not proven.

        Same shape as PEAK's, and deliberately the same derivation
        (:func:`~cannet_python_can.driver.state_from_counters` combined
        with :func:`~cannet_python_can.driver.worse_state`) rather than a
        second rule written for a second vendor. Vector is the easier of
        the two: ``s_xl_chip_state`` carries ``busStatus``,
        ``txErrorCounter`` and ``rxErrorCounter`` together, so the
        counters need no payload archaeology — but the counters still
        outrank the status bits, because ISO 11898-1 defines confinement
        on the counters and PEAK's status word was measured
        under-reporting a real fault as a healthy bus.

        The request is placed first and the *previous* answer read: the
        XL driver replies asynchronously, as an event on the same queue
        the messages arrive on, so a reading is always one poll old. At
        the state pump's 500 ms cadence that is half a second, and the
        publish-on-change gate above it coalesces unchanged readings the
        same way it does PEAK's.

        Nothing here reads ``Bus.state``: python-can's ``VectorBus`` does
        not implement it, and ``BusABC``'s getter returns
        ``BusState.ACTIVE`` unconditionally, so it would report a healthy
        bus through every fault.
        """
        try:
            self._bus.request_chip_state()  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            self._unreachable = True
            return ControllerState(state=STATE_UNAVAILABLE)
        self._unreachable = False
        reading = getattr(self._bus, "chip_state", None)
        if reading is None:
            return ControllerState()
        bus_status, tec, rec = reading
        state = worse_state(
            _xl_chip_state_state(bus_status), state_from_counters(tec, rec)
        )
        return ControllerState(state=state, tec=tec, rec=rec)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._bus.shutdown()  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass


# ----- Vendor enumeration helpers --------------------------------------------


def _list_vector() -> List[Channel]:
    """Vector XL channels via python-can's ``vector`` backend.

    ``VectorChannelConfig`` (the NamedTuple python-can returns from
    ``get_channel_configs``) carries:

    - ``name`` — application-visible channel name, used as the
      ``app_name`` python-can needs to reopen the channel.
    - ``hw_type`` — ``XL_HardwareType``. ``XL_HWTYPE_NONE`` (0) marks
      a channel slot the XL driver pre-allocated but no physical
      hardware fills; we skip those.
    - ``channel_bus_capabilities`` — ``XL_BusCapabilities`` flags. We
      keep only channels whose ``XL_BUS_COMPATIBLE_CAN`` bit is set,
      which drops the non-CAN slots the XL driver enumerates next to
      the CAN ports — e.g. a VN1630A's on-board D/A I/O channel, which
      otherwise shows up as a bogus fifth "CAN" channel.
    - ``hw_channel`` — 0-based per-card channel number, and the open
      key python-can's vector backend wants as ``channel=``. The
      ``ch:`` in the id is this raw value; the *display* shows
      ``hw_channel + 1`` so the channel number matches the device's
      own 1-based "Channel N" label (the hardware silkscreen and
      Vector Hardware Config both count from 1).
    - ``serial_number`` — card serial; the disambiguator for two
      physically identical VN devices, and the open-path key (see
      :func:`_bus_kwargs_for`).
    - ``channel_capabilities`` — ``XL_ChannelCapabilities`` flags; we
      OR the two CAN-FD support flags to decide ``fd_capable``.
    """
    try:
        from can.interfaces.vector import canlib as vector_canlib  # type: ignore[import-untyped]
    except Exception:  # noqa: BLE001
        return []
    # CAN-FD capability flags from xldefine.XL_ChannelCapabilities.
    # Looked up lazily because importing xldefine pulls the vxlapi
    # native library on some platforms; if the lookup fails we just
    # report fd_capable=False, which is the right default.
    fd_mask = 0
    # ``XL_BUS_COMPATIBLE_CAN`` bit, used to keep only CAN channels.
    # Left at 0 if the lookup fails, in which case we don't filter on
    # bus capability — better to over-list than to hide a real channel.
    can_cap_mask = 0
    try:
        from can.interfaces.vector import xldefine  # type: ignore[import-untyped]

        fd_mask = int(
            getattr(
                xldefine.XL_ChannelCapabilities,
                "XL_CHANNEL_FLAG_CANFD_BOSCH_SUPPORT",
                0,
            )
        ) | int(
            getattr(
                xldefine.XL_ChannelCapabilities, "XL_CHANNEL_FLAG_CANFD_ISO_SUPPORT", 0
            )
        )
        can_cap_mask = int(
            getattr(
                getattr(xldefine, "XL_BusCapabilities", None),
                "XL_BUS_COMPATIBLE_CAN",
                0,
            )
        )
    except Exception:  # noqa: BLE001
        fd_mask = 0
        can_cap_mask = 0
    try:
        configs = vector_canlib.get_channel_configs()
    except Exception as e:  # noqa: BLE001
        _log.info("vector enumeration failed (%s); skipping", e)
        return []
    out: List[Channel] = []
    for cfg in configs or []:
        hw_type = getattr(cfg, "hw_type", None)
        if hw_type is not None and int(hw_type) == 0:
            continue
        # Keep only CAN channels. A VN1630A enumerates its on-board
        # D/A I/O slot right after the CAN ports; it shares the CAN
        # ports' hardware type but its bus capability is DAIO, not CAN,
        # so without this it leaks through as a phantom CAN channel.
        # Skip the test only when we couldn't resolve the CAN bit or
        # the config doesn't report capabilities — never hide a channel
        # we can't classify.
        if can_cap_mask:
            bus_caps = getattr(cfg, "channel_bus_capabilities", None)
            if bus_caps is not None and not (int(bus_caps) & can_cap_mask):
                continue
        app_name = getattr(cfg, "name", None) or "vector"
        hw_channel = getattr(cfg, "hw_channel", None)
        if hw_channel is None:
            continue
        sn = getattr(cfg, "serial_number", None)
        sn_chunk = f"SN:{sn}, " if sn else ""
        # The id carries the raw 0-based ``hw_channel`` python-can opens
        # with; the display counts from 1 to match the device's own
        # channel labelling, so the two never disagree in front of the
        # user.
        cid = f"vector:{app_name}({sn_chunk}ch:{hw_channel})"
        label = f"Vector {app_name} ({sn_chunk}ch:{hw_channel + 1})"
        fd = False
        if fd_mask:
            caps = int(getattr(cfg, "channel_capabilities", 0) or 0)
            fd = bool(caps & fd_mask)
        out.append(Channel(id=cid, display_name=label, fd_capable=fd))
    return out


def _list_kvaser() -> List[Channel]:
    """Kvaser CANlib channels.

    Channel *discovery* is delegated to python-can's own detector
    (:func:`can.detect_available_configs`), whose kvaser backend binds
    CANlib through ``ctypes`` and reports, per channel, the
    ``device_name``, the card's ``serial``, and ``dongle_channel`` — the
    per-card channel counted from 1. Reaching instead for Kvaser's
    separate ``canlib`` PyPI wrapper is what previously made Kvaser
    adapters invisible: it is not a dependency of this sidecar, so it is
    absent from the frozen build, and the failed import enumerated zero
    channels silently. Delegating keeps discovery on the same bundled
    backend that opening already uses.

    The id body is the global index ``channel`` python-can's kvaser
    backend takes as its ``channel`` kwarg; the paren metadata carries
    the card serial (when known) and the per-card channel the user reads
    off the device, so two identical cards always produce distinct ids
    and the label shows the per-card channel number.
    """
    if not _HAVE_PYTHON_CAN:
        return []
    try:
        detected = can.detect_available_configs(interfaces=["kvaser"])
    except Exception as e:  # noqa: BLE001
        _log.info("kvaser enumeration failed (%s); skipping", e)
        return []
    out: List[Channel] = []
    for cfg in detected:
        # The global index is what an open takes; an entry without one
        # can't be opened, so it isn't offered.
        index = cfg.get("channel")
        if not isinstance(index, int):
            continue
        device_name = cfg.get("device_name") or f"ch{index}"
        sn = cfg.get("serial")
        # python-can counts `dongle_channel` from 1; the id and the label
        # carry the raw per-card channel, as they always have.
        dongle = cfg.get("dongle_channel")
        per_card = int(dongle) - 1 if isinstance(dongle, int) else index
        meta = []
        if sn:
            meta.append(f"SN:{sn}")
        meta.append(f"ch:{per_card}")
        meta_str = ", ".join(meta)
        cid = f"kvaser:{index}({meta_str})"
        label = f"Kvaser {device_name} ({meta_str})"
        out.append(Channel(id=cid, display_name=label, fd_capable=True))
    return out


def _decode_pcan_bytes(value) -> str:
    """PCAN-Basic returns ``c_char`` arrays — decode to ``str`` once."""
    if isinstance(value, bytes):
        return value.decode("ascii", errors="replace").rstrip("\x00").strip()
    return str(value)


def _pcan_read_int(api, handle, pcan_basic, *param_names: str, default: int = 0) -> int:
    """Read the first available integer PCAN-Basic parameter from
    ``param_names`` for ``handle``, unwrapping ctypes values. Returns
    ``default`` if none is present or readable."""
    for pname in param_names:
        param = getattr(pcan_basic, pname, None)
        if param is None:
            continue
        try:
            err, val = api.GetValue(handle, param)
        except Exception:  # noqa: BLE001
            continue
        if err == 0 and val is not None:
            return int(getattr(val, "value", val))
    return default


def _pcan_read_str(api, handle, pcan_basic, *param_names: str) -> str:
    """Read the first available string PCAN-Basic parameter from
    ``param_names`` for ``handle``, decoded to ``str``. Returns ``""``
    if none is present or readable."""
    for pname in param_names:
        param = getattr(pcan_basic, pname, None)
        if param is None:
            continue
        try:
            err, val = api.GetValue(handle, param)
        except Exception:  # noqa: BLE001
            continue
        if err == 0 and val:
            return _decode_pcan_bytes(val)
    return ""


def _list_pcan() -> List[Channel]:
    """PEAK PCAN-Basic channels.

    Channel *discovery* is delegated to python-can's own detector
    (:func:`can.detect_available_configs`). That call branches on the
    OS: on macOS the PCBUSB driver doesn't implement the bulk
    ``PCAN_ATTACHED_CHANNELS`` query (it returns PCAN_ERROR_ILLOPERATION),
    so python-can probes each candidate handle individually with
    ``PCAN_CHANNEL_CONDITION`` instead. Reimplementing that
    platform-specific probe here is what previously made PEAK adapters
    invisible on macOS — delegating keeps the single, maintained code
    path working on every OS.

    Each detected channel is then *enriched* with the identity metadata
    the GUI needs, via per-handle ``GetValue`` (which works uniformly on
    Windows/Linux/macOS): the ``controller_number`` (the per-card channel
    on multi-channel devices like PCAN-USB Pro FD), the user-settable
    ``device_id`` from PCAN-View (``uid:``), and the model name. The id
    body is the named slot constant (``PCAN_USBBUS1`` …) python-can
    reports and opens with; the paren metadata carries the raw hex
    handle, controller number, and device id.
    """
    if not _HAVE_PYTHON_CAN:
        return []
    try:
        from can.interfaces.pcan import basic as pcan_basic  # type: ignore[import-untyped]
    except Exception:  # noqa: BLE001
        return []
    PCANBasic = getattr(pcan_basic, "PCANBasic", None)
    if PCANBasic is None:
        return []
    try:
        detected = can.detect_available_configs(interfaces=["pcan"])
        api = PCANBasic()
    except Exception as e:  # noqa: BLE001
        _log.info("pcan enumeration failed (%s); skipping", e)
        return []
    out: List[Channel] = []
    for cfg in detected:
        # `channel` is the slot constant name python-can opens with
        # (e.g. "PCAN_USBBUS1"); resolve it back to the numeric handle
        # for the per-handle enrichment reads and the `h:` metadata.
        name = cfg.get("channel")
        if not isinstance(name, str):
            continue
        handle = getattr(pcan_basic, name, None)
        if handle is None:
            continue
        handle_int = int(getattr(handle, "value", handle))

        ctrl = _pcan_read_int(api, handle, pcan_basic, "PCAN_CONTROLLER_NUMBER")
        dev_id = _pcan_read_int(
            api, handle, pcan_basic, "PCAN_DEVICE_ID", "PCAN_DEVICE_NUMBER"
        )
        model = _pcan_read_str(api, handle, pcan_basic, "PCAN_HARDWARE_NAME") or "PCAN"

        # `uid:` is the user-settable PCAN-View device id. It's always
        # shown, including the factory-default 0 — having it always
        # present makes the format predictable and tells the user
        # whether anyone has set a non-zero id on this adapter.
        meta = [f"h:0x{handle_int:X}", f"ch:{ctrl}", f"uid:{dev_id}"]
        meta_str = ", ".join(meta)

        # The display prepends the named slot to the meta list, so the
        # user sees both "which port" (slot) and the underlying handle
        # integer / controller in one paren group.
        display_meta = f"{name}, {meta_str}"

        cid = f"pcan:{name}({meta_str})"
        label = f"PEAK {model} ({display_meta})"
        out.append(
            Channel(
                id=cid,
                display_name=label,
                fd_capable=bool(cfg.get("supports_fd", False)),
            )
        )
    return out


def _split_meta(rest: str) -> tuple[str, dict]:
    """Split ``<body>(k:v, k:v, …)`` into ``(body, {k: v, ...})``.

    Values are returned as raw strings; callers do their own typing.
    """
    meta: dict[str, str] = {}
    body = rest
    paren_open = body.rfind("(")
    if paren_open >= 0 and body.endswith(")"):
        inner = body[paren_open + 1 : -1]
        body = body[:paren_open]
        for part in inner.split(","):
            if ":" in part:
                k, _, v = part.partition(":")
                meta[k.strip()] = v.strip()
    return body, meta


#: ``f_clock`` value passed to :meth:`BitTimingFd.from_sample_point`.
#: 80 MHz is the only value accepted by every FD-capable backend we
#: support (PEAK, Kvaser, Vector all advertise 80 MHz as a valid
#: CAN-FD reference clock).
_FD_F_CLOCK_HZ = 80_000_000

#: Default sample point percentage for the nominal (arbitration) phase
#: when the user hasn't pinned bit-level timing. 80 % matches the
#: CiA-recommended midpoint for 500 kbps – 1 Mbps and is the value
#: python-can's own ``Bus`` constructor implicitly aims for.
_FD_NOM_SAMPLE_POINT_PCT = 80

#: Default data-phase sample point percentage. 70 % is a CiA-recommended
#: value for the faster data phase where ringing matters more.
_FD_DATA_SAMPLE_POINT_PCT = 70

#: Nominal bitrate used when FD is enabled but no ``bitrate_bps`` is
#: configured. Pinned to 500 kbps (the python-can default for classic
#: buses) so an FD-enabled bus opened from a project with no explicit
#: bitrate still has *some* sensible value to compute timing against.
_FD_DEFAULT_NOMINAL_BITRATE_BPS = 500_000


def _bus_kwargs_for(channel_id: str, config: OpenConfig):
    """Translate ``vendor:<body>(<meta>)`` + ``OpenConfig`` into the
    arguments python-can's ``Bus`` constructor takes.

    The paren metadata is identity information for the GUI — the open
    path only needs the body plus, for Vector, the ``ch:`` field from
    the parens (since python-can's ``vector`` backend wants ``app_name``
    and ``channel`` as separate kwargs).

    FD configuration is normalised to a :class:`can.BitTimingFd` via
    :meth:`BitTimingFd.from_sample_point`. Routing through ``timing=``
    rather than ``fd=True`` + ``data_bitrate=N`` matters for PEAK: its
    python-can backend has no ``data_bitrate`` kwarg, so the only way
    to pick a data-phase rate uniformly across PEAK, Kvaser, and
    Vector is to hand all three a fully-computed BitTimingFd instance.
    """
    vendor, _, rest = channel_id.partition(":")
    body, meta = _split_meta(rest)
    common = {}
    if config.fd:
        common["timing"] = _build_fd_timing(config)
    elif config.bitrate_bps is not None:
        common["bitrate"] = config.bitrate_bps
    if config.listen_only:
        common["receive_own_messages"] = False
    if vendor == "vector":
        # Open by ``serial`` + hw_channel when we have it: python-can's
        # vector backend then resolves the physical channel directly
        # via ``get_channel_configs`` and never calls
        # ``xlGetApplConfig``, so an unmapped slot in Vector Hardware
        # Config's "application" view can't break open or close. When
        # there's no serial (the always-present XL virtual bus reports
        # ``serial_number == 0``) we fall back to ``app_name``.
        ch = int(meta["ch"])
        sn = meta.get("SN")
        if sn:
            return ("vector", {"serial": int(sn), "channel": ch, **common})
        return ("vector", {"app_name": body, "channel": ch, **common})
    if vendor == "kvaser":
        return ("kvaser", {"channel": int(body), **common})
    if vendor == "pcan":
        # Known handle constants (PCAN_USBBUS1, etc.) go through as
        # strings — python-can looks them up. The ``handle=0xNN``
        # fallback (used when the enumerator can't reverse-map the
        # numeric handle to a constant name) is parsed to int here so
        # python-can's pcan accepts it as a raw TPCANHandle.
        if body.startswith("handle=0x"):
            return (
                "pcan",
                {"channel": int(body.removeprefix("handle="), 16), **common},
            )
        return ("pcan", {"channel": body, **common})
    raise KeyError(channel_id)


def _disable_pcan_status_frames(bus) -> None:
    """Turn off PCAN-Basic's status-frame queue immediately after open.

    PCAN-Basic emits side-band notifications (channel initialised,
    bus-light, bus-heavy, bus-passive, ...) as queued "status frames"
    whose ``MSGTYPE`` has the ``PCAN_MESSAGE_STATUS`` bit set. python-can's
    PCAN backend reads ``MSGTYPE`` for the bits it knows about
    (``EXTENDED`` / ``RTR`` / ``FD`` / ``ECHO`` / ``BRS`` / ``ESI`` /
    ``ERRFRAME``) but never branches on ``STATUS``, so the status frame
    is built into a regular :class:`can.Message` with ``arbitration_id =
    pcan_msg.ID`` (a small status code, typically 1), ``dlc = 4``, and
    the 4-byte status word as payload. The result is indistinguishable
    from a real ``can_id=1, dlc=4`` wire frame.

    PCAN-Basic exposes the same fault-confinement information through
    ``CAN_GetStatus``, which the sidecar already polls every 500 ms (see
    :class:`cannet_python_can.server._SharedInterface._state_pump`), so
    disabling the queued status frames loses no observable signal — it
    only stops the synthetic frame.
    """
    from can.interfaces.pcan.basic import (  # type: ignore[import-untyped]
        PCAN_ALLOW_STATUS_FRAMES,
        PCAN_PARAMETER_OFF,
    )

    bus.m_objPCANBasic.SetValue(
        bus.m_PcanHandle,
        PCAN_ALLOW_STATUS_FRAMES,
        PCAN_PARAMETER_OFF,
    )


def _build_fd_timing(config: OpenConfig):
    """Build a :class:`can.BitTimingFd` from an FD-enabled
    :class:`OpenConfig`. The data-phase rate defaults to the nominal
    rate when unset (matching python-can's classic ``data_bitrate``
    fallback). Nominal defaults to :data:`_FD_DEFAULT_NOMINAL_BITRATE_BPS`
    when unset so the FD-mode open path always has *some* value to
    compute timing against.
    """
    from can import BitTimingFd  # type: ignore[import-untyped]

    nom_bps = config.bitrate_bps or _FD_DEFAULT_NOMINAL_BITRATE_BPS
    data_bps = config.data_bitrate_bps or nom_bps
    return BitTimingFd.from_sample_point(
        f_clock=_FD_F_CLOCK_HZ,
        nom_bitrate=int(nom_bps),
        nom_sample_point=_FD_NOM_SAMPLE_POINT_PCT,
        data_bitrate=int(data_bps),
        data_sample_point=_FD_DATA_SAMPLE_POINT_PCT,
    )


#: Hardware timestamps further than this from the current wall clock
#: are treated as garbage and replaced with the wall-clock fallback.
#: Generous enough for any real buffering delay or clock skew; tight
#: enough to reject driver garbage (PEAK's macOS PCBUSB library has
#: been seen handing python-can classic-CAN timestamps millennia in
#: the future, which overflow the wire format's uint64 ns field).
_TS_PLAUSIBLE_SLACK_S = 86_400.0


def _msg_to_frame(msg) -> Frame:
    """python-can ``Message`` → driver ``Frame``.

    The fallback for missing timestamps uses :func:`time.time_ns`
    (Unix-epoch ns), not :func:`time.monotonic_ns` — python-can's
    hardware-stamped path produces Unix-epoch ns too (boot epoch +
    PEAK's µs counter). Mixing those two clocks within one session
    produced timestamps three orders of magnitude apart, which broke
    the trace view's "first frame is the zero point" assumption and
    showed up as wildly-negative deltas the moment a fallback-stamped
    frame slipped in after a hardware-stamped one.

    Timestamps outside ``_TS_PLAUSIBLE_SLACK_S`` of the current wall
    clock take the same fallback: they are driver garbage, and passing
    them through either overflows the wire encode (killing the frame
    stream) or wrecks the trace view's timing the same way a
    mixed-clock stamp does.
    """
    ts_s = float(getattr(msg, "timestamp", 0.0) or 0.0)
    if ts_s and abs(ts_s - time.time()) <= _TS_PLAUSIBLE_SLACK_S:
        timestamp_ns = int(ts_s * 1_000_000_000)
    else:
        timestamp_ns = int(time.time_ns())
    data = bytes(getattr(msg, "data", b"") or b"")
    return Frame(
        timestamp_ns=timestamp_ns,
        can_id=int(getattr(msg, "arbitration_id", 0)),
        extended=bool(getattr(msg, "is_extended_id", False)),
        is_rx=not bool(getattr(msg, "is_tx", False)),
        data=data,
        kind=FrameKind.from_flags(
            is_error=bool(getattr(msg, "is_error_frame", False)),
            is_remote=bool(getattr(msg, "is_remote_frame", False)),
            is_fd=bool(getattr(msg, "is_fd", False)),
        ),
        brs=bool(getattr(msg, "bitrate_switch", False)),
        esi=bool(getattr(msg, "error_state_indicator", False)),
        dlc=int(getattr(msg, "dlc", len(data))),
    )


def _frame_to_msg(frame: Frame):
    """driver ``Frame`` → python-can ``Message``."""
    assert can is not None  # callable only after import succeeded
    return can.Message(  # type: ignore[union-attr]
        arbitration_id=frame.can_id,
        is_extended_id=frame.extended,
        is_fd=frame.kind == FrameKind.FD,
        bitrate_switch=frame.brs,
        error_state_indicator=frame.esi,
        is_remote_frame=frame.kind == FrameKind.REMOTE,
        is_error_frame=frame.kind == FrameKind.ERROR,
        data=frame.data,
        dlc=frame.dlc or len(frame.data),
    )


__all__ = ["PythonCanChannel", "PythonCanDriver"]
