"""A PEAK-shaped fake wire for the fault-recovery bench.

The fake stands in for python-can's ``PcanBus`` -- the same surface
(``send``, ``recv``, ``status``, ``reset``, ``state``, ``shutdown``,
``m_objPCANBasic``, ``m_PcanHandle``) -- so the sidecar's real
``PythonCanChannel`` runs on top of it, with its PEAK paths: the status
word, the error-frame counters, the send-refusal texts. The bench's
strategies call the same PCAN-Basic functions they call on hardware.

One :class:`FakeWire` joins the channels. A thread ticks it every
5 ms: each controller with frames queued puts them on the wire, or, in
a fault, retransmits its head frame into it and reports an error frame
per attempt. What a fault does follows ISO 11898-1:

- ``short`` (bit errors): TEC rises by 8 per attempt; past 255 the
  controller is bus-off and stays there until it is initialised again,
  as a PEAK controller without auto-reset does.
- ``open`` (no acknowledge): TEC rises to 128 and stops -- an
  error-passive transmitter's acknowledge errors do not count -- so the
  controller is error-passive and its queue fills.

and what PCAN-Basic does with a handle the process already holds:
``CAN_Initialize`` on it fails ``PCAN_ERROR_INITIALIZE``, the answer the
owner's bench recorded when the sidecar reopened a bus-off PCAN-USB FD
channel while still holding it. ``CAN_Uninitialize`` releases the
handle by number.

:data:`SCENARIOS` are the faults the bench is tested against.
"""

from __future__ import annotations

import collections
import dataclasses
import threading
import time
from typing import Callable

from .. import driver as drv
from ..driver_python_can import PythonCanChannel, _disable_pcan_status_frames

#: PCAN-Basic's texts, as python-can raises them.
INITIALIZE_TEXT = (
    "A PCAN Channel has not been initialized yet or the initialization "
    "process has failed"
)
BUS_OFF_TEXT = "Bus error: the CAN controller is in bus-off state"
QUEUE_FULL_TEXT = "The transmit queue is full"

_PCAN_ERROR_OK = 0
_PCAN_ERROR_INITIALIZE = 0x4000000
_PCAN_ERROR_BUSWARNING = 0x00008
_PCAN_ERROR_BUSOFF = 0x00010
_PCAN_ERROR_BUSPASSIVE = 0x40000

#: How often the wire moves, how many error frames a faulted
#: transmitter reports per tick, and the transmit queue's depth.
_TICK_S = 0.005
_ERRORS_PER_TICK = 2
_TX_QUEUE_MAX = 512
_RX_QUEUE_MAX = 32_768


@dataclasses.dataclass
class _Controller:
    tec: int = 0
    rec: int = 0
    bus_off: bool = False
    auto_reset: bool = False
    tx: collections.deque = dataclasses.field(default_factory=collections.deque)
    rx: collections.deque = dataclasses.field(
        default_factory=lambda: collections.deque(maxlen=_RX_QUEUE_MAX)
    )


class FakeWire:
    """Channels ``handles`` on one wire, and the faults applied to it.

    The fault knobs are plain attributes a scenario sets under
    :attr:`cond`: ``mode`` (``ok`` / ``short`` / ``open``), ``stuck``
    (handles whose queue does not drain until it is emptied),
    ``refuse_writes`` (handle → the text every write is refused with),
    ``hide_bus_off`` (handles whose status word and reads stop saying
    bus-off while writes still do) and ``open_failures`` (handle → how
    many more opens fail ``PCAN_ERROR_INITIALIZE``)."""

    def __init__(self, handles: tuple[str, ...] = ("fake:A", "fake:B")) -> None:
        self.handles = handles
        self.cond = threading.Condition()
        self.held: dict[str, _Controller] = {}
        self.mode = "ok"
        self.stuck: set[str] = set()
        self.refuse_writes: dict[str, str] = {}
        self.hide_bus_off: set[str] = set()
        self.open_failures: dict[str, int] = {}
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="fake-wire", daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1.0)

    def _run(self) -> None:
        while not self._stop.wait(_TICK_S):
            with self.cond:
                self._tick()
                self.cond.notify_all()

    def _tick(self) -> None:
        for handle, c in list(self.held.items()):
            if c.bus_off or not c.tx or handle in self.stuck:
                continue
            if self.mode == "ok":
                frames = list(c.tx)
                c.tx.clear()
                c.tec = max(0, c.tec - len(frames))
                for msg in frames:
                    c.rx.append(_copy(msg, is_rx=False))
                    for other, oc in self.held.items():
                        if other != handle and not oc.bus_off:
                            oc.rx.append(_copy(msg, is_rx=True))
                            oc.rec = max(0, oc.rec - 1)
                continue
            for _ in range(_ERRORS_PER_TICK):
                if self.mode == "short":
                    c.tec += 8
                    c.rx.append(_error_frame(1, 0x00, c.rec, min(c.tec, 255)))
                    if c.tec > 255:
                        c.bus_off = True
                        break
                else:  # open: no acknowledge
                    if c.tec < 128:
                        c.tec += 8
                    c.rx.append(_error_frame(1, 0x19, c.rec, c.tec))

    # ----- PCAN-Basic --------------------------------------------------

    def initialize(self, handle: str) -> int:
        with self.cond:
            if self.open_failures.get(handle, 0) > 0:
                self.open_failures[handle] -= 1
                return _PCAN_ERROR_INITIALIZE
            if handle in self.held:
                return _PCAN_ERROR_INITIALIZE
            self.held[handle] = _Controller()
            return _PCAN_ERROR_OK

    def uninitialize(self, handle: str) -> int:
        with self.cond:
            self.held.pop(handle, None)
            self.cond.notify_all()
            return _PCAN_ERROR_OK

    def reset(self, handle: str) -> int:
        """``CAN_Reset``: both queues emptied, the controller untouched.
        An emptied queue is no longer stuck."""
        with self.cond:
            c = self.held.get(handle)
            if c is None:
                return _PCAN_ERROR_INITIALIZE
            c.tx.clear()
            c.rx.clear()
            self.stuck.discard(handle)
            return _PCAN_ERROR_OK

    def status(self, handle: str) -> int:
        """``CAN_GetStatus``. With auto-reset on, a bus-off controller is
        reset inside the call (its queue kept), as PCAN-Basic does."""
        with self.cond:
            c = self.held.get(handle)
            if c is None:
                return _PCAN_ERROR_INITIALIZE
            if c.bus_off and c.auto_reset:
                c.bus_off = False
                c.tec = 0
            if c.bus_off:
                return 0 if handle in self.hide_bus_off else _PCAN_ERROR_BUSOFF
            if c.tec > 127:
                return _PCAN_ERROR_BUSPASSIVE
            if c.tec > 95:
                return _PCAN_ERROR_BUSWARNING
            return _PCAN_ERROR_OK

    def set_auto_reset(self, handle: str, on: bool) -> int:
        with self.cond:
            c = self.held.get(handle)
            if c is None:
                return _PCAN_ERROR_INITIALIZE
            c.auto_reset = on
            return _PCAN_ERROR_OK

    def write(self, handle: str, msg) -> None:
        import can  # type: ignore[import-untyped]

        with self.cond:
            c = self.held.get(handle)
            if c is None:
                raise can.CanOperationError(INITIALIZE_TEXT)
            text = self.refuse_writes.get(handle)
            if text is not None:
                raise can.CanOperationError(text)
            if c.bus_off:
                raise can.CanOperationError(BUS_OFF_TEXT)
            if len(c.tx) >= _TX_QUEUE_MAX:
                raise can.CanOperationError(QUEUE_FULL_TEXT)
            c.tx.append(msg)

    def read(self, handle: str, timeout_s: float):
        import can  # type: ignore[import-untyped]

        deadline = time.monotonic() + timeout_s
        with self.cond:
            while True:
                c = self.held.get(handle)
                if c is None:
                    raise can.CanOperationError(INITIALIZE_TEXT)
                if c.bus_off and handle not in self.hide_bus_off:
                    raise can.CanOperationError(BUS_OFF_TEXT)
                if c.rx:
                    return c.rx.popleft()
                left = deadline - time.monotonic()
                if left <= 0:
                    return None
                self.cond.wait(left)


def _copy(msg, *, is_rx: bool):
    import can  # type: ignore[import-untyped]

    return can.Message(
        timestamp=time.time(),
        arbitration_id=msg.arbitration_id,
        is_extended_id=msg.is_extended_id,
        is_fd=msg.is_fd,
        bitrate_switch=msg.bitrate_switch,
        data=bytes(msg.data),
        dlc=msg.dlc,
        is_rx=is_rx,
    )


def _error_frame(can_id: int, position: int, rec: int, tec: int):
    """A PEAK error frame: direction (0 = transmitting), position, REC,
    TEC."""
    import can  # type: ignore[import-untyped]

    return can.Message(
        timestamp=time.time(),
        arbitration_id=can_id,
        is_error_frame=True,
        data=bytes([0, position, min(rec, 255), min(tec, 255)]),
        dlc=4,
        is_rx=True,
    )


class _FakeBasic:
    """The ``PCANBasic`` calls python-can, the sidecar and the bench's
    strategies make, answered by the wire."""

    def __init__(self, wire: FakeWire) -> None:
        self._wire = wire

    def Initialize(self, handle, rate, *_args) -> int:  # noqa: N802 - PCAN-Basic's name
        return self._wire.initialize(handle)

    def InitializeFD(self, handle, bitrate) -> int:  # noqa: N802
        return self._wire.initialize(handle)

    def Uninitialize(self, handle) -> int:  # noqa: N802
        return self._wire.uninitialize(handle)

    def Reset(self, handle) -> int:  # noqa: N802
        return self._wire.reset(handle)

    def GetStatus(self, handle) -> int:  # noqa: N802
        return self._wire.status(handle)

    def SetValue(self, handle, param, value) -> int:  # noqa: N802
        from can.interfaces.pcan.basic import (  # type: ignore[import-untyped]
            PCAN_BUSOFF_AUTORESET,
            PCAN_PARAMETER_ON,
        )

        if param == PCAN_BUSOFF_AUTORESET:
            return self._wire.set_auto_reset(handle, value == PCAN_PARAMETER_ON)
        with self._wire.cond:
            return (
                _PCAN_ERROR_OK if handle in self._wire.held else _PCAN_ERROR_INITIALIZE
            )


class FakePcanBus:
    """python-can's ``PcanBus``, on a :class:`FakeWire`."""

    def __init__(self, wire: FakeWire, channel: str, *, fd: bool) -> None:
        import can  # type: ignore[import-untyped]

        self._wire = wire
        self.m_objPCANBasic = _FakeBasic(wire)
        self.m_PcanHandle = channel
        self.fd_bitrate = b"fake" if fd else None
        self._state = can.BusState.ACTIVE
        init = (
            self.m_objPCANBasic.InitializeFD if fd else self.m_objPCANBasic.Initialize
        )
        if init(channel, self.fd_bitrate) != _PCAN_ERROR_OK:
            raise can.CanInitializationError(INITIALIZE_TEXT)

    def status(self) -> int:
        return self.m_objPCANBasic.GetStatus(self.m_PcanHandle)

    def reset(self) -> bool:
        return self.m_objPCANBasic.Reset(self.m_PcanHandle) == _PCAN_ERROR_OK

    @property
    def state(self):
        return self._state

    @state.setter
    def state(self, new_state) -> None:
        # python-can's setter: store it, set PCAN_LISTEN_ONLY to match.
        self._state = new_state

    def send(self, msg, timeout=None) -> None:
        self._wire.write(self.m_PcanHandle, msg)

    def recv(self, timeout=None):
        return self._wire.read(self.m_PcanHandle, timeout or 0.0)

    def shutdown(self) -> None:
        self.m_objPCANBasic.Uninitialize(self.m_PcanHandle)


class FakeDriver:
    """A :class:`~cannet_local_sidecar.driver.Driver` opening
    :class:`FakePcanBus` channels the way ``PythonCanDriver`` opens PEAK
    ones."""

    def __init__(self, wire: FakeWire) -> None:
        self.wire = wire

    def list_channels(self):
        return [drv.Channel(id=h, display_name=h) for h in self.wire.handles]

    def open(self, channel_id: str, config: drv.OpenConfig) -> PythonCanChannel:
        if channel_id not in self.wire.handles:
            raise KeyError(channel_id)
        try:
            bus = FakePcanBus(self.wire, channel_id, fd=config.fd)
        except Exception as e:  # noqa: BLE001
            raise OSError(f"open {channel_id}: {e}") from e
        _disable_pcan_status_frames(bus)
        return PythonCanChannel(
            channel_id=channel_id,
            bus=bus,
            listen_only=config.listen_only,
            fd=config.fd,
        )


# ----- scenarios ---------------------------------------------------------------

Apply = Callable[[FakeWire, str], None]


@dataclasses.dataclass(frozen=True)
class Scenario:
    """A fault: ``inject`` once traffic runs, ``clear`` ``hold_s`` after
    the bench finds it -- the cable pulled and plugged back. Both take
    the wire and the channel under test, under the wire's lock."""

    name: str
    inject: Apply
    clear: Apply
    hold_s: float = 0.5


def _set(**knobs) -> Apply:
    def apply(wire: FakeWire, under_test: str) -> None:
        for key, value in knobs.items():
            setattr(wire, key, value)

    return apply


def _short_hiding_bus_off(wire: FakeWire, under_test: str) -> None:
    wire.mode = "short"
    wire.hide_bus_off.add(under_test)


def _short_failing_one_open(wire: FakeWire, under_test: str) -> None:
    wire.mode = "short"
    wire.open_failures[under_test] = 1


def _stick(wire: FakeWire, under_test: str) -> None:
    wire.stuck.add(under_test)


def _refuse(wire: FakeWire, under_test: str) -> None:
    wire.refuse_writes[under_test] = QUEUE_FULL_TEXT


def _stop_refusing(wire: FakeWire, under_test: str) -> None:
    wire.refuse_writes.pop(under_test, None)


def _nothing(wire: FakeWire, under_test: str) -> None:
    pass


#: The faults, by name.
#:
#: - ``bus_off``: bit errors on the wire until both controllers are
#:   bus-off; then the wire is restored.
#: - ``error_passive``: no acknowledge -- both controllers error-passive,
#:   queues filling -- then restored.
#: - ``stuck_tx_queue``: the channel under test stops draining its queue
#:   on a working wire, until the queue is emptied.
#: - ``refusal_storm``: every write on the channel under test refused
#:   queue-full for longer than the stuck-queue flush takes, then not.
#: - ``reopen_fails``: ``bus_off``, and the next open of the channel
#:   under test fails ``PCAN_ERROR_INITIALIZE`` once.
#: - ``status_word_clears_while_writes_refuse``: ``bus_off``, but the
#:   channel under test's status word and reads stop saying bus-off while
#:   its writes still refuse it.
SCENARIOS: dict[str, Scenario] = {
    s.name: s
    for s in (
        Scenario("bus_off", _set(mode="short"), _set(mode="ok")),
        Scenario("error_passive", _set(mode="open"), _set(mode="ok")),
        Scenario("stuck_tx_queue", _stick, _nothing),
        Scenario("refusal_storm", _refuse, _stop_refusing, hold_s=1.5),
        Scenario("reopen_fails", _short_failing_one_open, _set(mode="ok")),
        Scenario(
            "status_word_clears_while_writes_refuse",
            _short_hiding_bus_off,
            _set(mode="ok"),
        ),
    )
}


def apply(wire: FakeWire, step: Apply, under_test: str) -> None:
    with wire.cond:
        step(wire, under_test)
        wire.cond.notify_all()


__all__ = [
    "FakeDriver",
    "FakePcanBus",
    "FakeWire",
    "SCENARIOS",
    "Scenario",
    "apply",
]
