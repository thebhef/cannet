"""Bus-off recovery strategies the fault-recovery bench swaps in.

The sidecar's state poll resets a channel it has read bus-off for a
second (ADR 0039) by calling the channel's ``reset``; the bench replaces
that method on every channel it opens with :attr:`Strategy.recover`.
The contract is :meth:`~cannet_local_sidecar.driver.OpenChannel.reset`'s:

- ``True``: handled in place;
- ``False``: the sidecar reopens the channel through its own swap;
- raises: failed, and the sidecar retries on its next pass that still
  reads bus-off.

The ladder runs python-can-abstract first (``state_active``,
``bus_reset``, ``close_then_open``), then PEAK-only (``auto_reset``,
``uninit_init_same_handle``). ``sidecar`` is the control: nothing is
swapped, the shipped recovery runs. Each docstring says what the call
does on the backend, read from python-can 4.6.1's ``pcan.py`` and
PCAN-Basic's own header text.

Each strategy is written against the ``PcanBus`` surface
(``state``, ``reset``, ``shutdown``, ``m_objPCANBasic``,
``m_PcanHandle``), which the bench's fake bus also has, so the same code
runs on hardware and on :mod:`.fake`.
"""

from __future__ import annotations

import dataclasses
from typing import Callable, Optional

from .. import driver as drv

#: PCAN-Basic status codes this module compares against.
_PCAN_ERROR_OK = 0


@dataclasses.dataclass(frozen=True)
class StrategyContext:
    """What a strategy knows about the channel besides its handle."""

    channel_id: str
    config: drv.OpenConfig


Recover = Callable[[object, StrategyContext], bool]
OnOpen = Callable[[object, StrategyContext], None]


@dataclasses.dataclass(frozen=True)
class Strategy:
    """A recovery under test.

    ``recover`` takes the opened channel (a ``PythonCanChannel``) and
    replaces its ``reset``; ``None`` leaves the sidecar's own.
    ``on_open`` runs on the python-can bus right after each open, for a
    strategy that is an open-time option. ``pcan_only`` strategies refuse
    any other backend at open.
    """

    name: str
    recover: Optional[Recover]
    on_open: Optional[OnOpen] = None
    pcan_only: bool = False


def _bus(ch: object) -> object:
    """The python-can bus behind a ``PythonCanChannel``."""
    return ch._bus  # type: ignore[attr-defined]


def _require_pcan(bus: object) -> None:
    if not hasattr(bus, "m_objPCANBasic"):
        raise OSError("this strategy is PEAK-only (PCAN-Basic); the bus is not PCAN")


def state_active(ch: object, ctx: StrategyContext) -> bool:
    """``bus.state = BusState.ACTIVE``.

    On PEAK the setter stores the value and makes one call,
    ``CAN_SetValue(PCAN_LISTEN_ONLY, PCAN_PARAMETER_OFF)``; it does not
    touch the controller's fault state, and the getter only ever returns
    the stored value. ``BusABC``'s setter, which Vector and Kvaser
    inherit, raises ``NotImplementedError``."""
    import can  # type: ignore[import-untyped]

    _bus(ch).state = can.BusState.ACTIVE  # type: ignore[attr-defined]
    return True


def bus_reset(ch: object, ctx: StrategyContext) -> bool:
    """``bus.reset()``.

    On PEAK this is ``CAN_Reset``: it empties the receive and transmit
    queues and, in PCAN-Basic's words, performs no reset of the CAN
    controller. Vector's is ``xlDeactivateChannel`` then
    ``xlActivateChannel``; Kvaser's bus has none and raises. A ``False``
    answer from the backend is raised, so the sidecar retries rather
    than reopening."""
    ok = _bus(ch).reset()  # type: ignore[attr-defined]
    if ok is False:
        raise OSError("bus.reset() reported failure")
    return True


def close_then_open(ch: object, ctx: StrategyContext) -> bool:
    """Close the channel, then let the sidecar open a fresh one: the
    sidecar's own reopen, in the other order.

    The close is ``PythonCanChannel.close`` -- ``bus.shutdown()``, which
    on PEAK stops periodic tasks and calls ``CAN_Uninitialize`` on the
    handle. Answering ``False`` sends the sidecar down its reopen, which
    opens a new ``can.Bus`` with the same kwargs (``CAN_InitializeFD`` /
    ``CAN_Initialize`` on the now-free handle) and closes the old channel
    again, a no-op. If that open raises, the closed channel stays
    current."""
    ch.close()  # type: ignore[attr-defined]
    return False


def _arm_auto_reset(bus: object, ctx: StrategyContext) -> None:
    from can.interfaces.pcan.basic import (  # type: ignore[import-untyped]
        PCAN_BUSOFF_AUTORESET,
        PCAN_PARAMETER_ON,
    )

    _require_pcan(bus)
    result = bus.m_objPCANBasic.SetValue(  # type: ignore[attr-defined]
        bus.m_PcanHandle,  # type: ignore[attr-defined]
        PCAN_BUSOFF_AUTORESET,
        PCAN_PARAMETER_ON,
    )
    if result != _PCAN_ERROR_OK:
        raise OSError(f"PCAN_BUSOFF_AUTORESET refused: 0x{int(result):X}")


def auto_reset_recover(ch: object, ctx: StrategyContext) -> bool:
    """Nothing to do at recovery time: the driver resets the controller
    itself. Answers ``True`` so the sidecar does not reopen."""
    return True


def uninit_init_same_handle(ch: object, ctx: StrategyContext) -> bool:
    """``CAN_Uninitialize`` then ``CAN_InitializeFD`` (``CAN_Initialize``
    on a classic bus) on the handle the bus holds, keeping the python-can
    object.

    Initialisation resets the parameters python-can and the sidecar set
    at open, so they are set again in the same order: error frames on,
    echo frames on unless listen-only, status frames off, and on Windows
    the receive event python-can waits on."""
    from can.interfaces.pcan.basic import (  # type: ignore[import-untyped]
        PCAN_ALLOW_ECHO_FRAMES,
        PCAN_ALLOW_ERROR_FRAMES,
        PCAN_ALLOW_STATUS_FRAMES,
        PCAN_BAUD_500K,
        PCAN_BITRATES,
        PCAN_PARAMETER_OFF,
        PCAN_PARAMETER_ON,
        PCAN_RECEIVE_EVENT,
    )

    bus = _bus(ch)
    _require_pcan(bus)
    api = bus.m_objPCANBasic  # type: ignore[attr-defined]
    handle = bus.m_PcanHandle  # type: ignore[attr-defined]
    api.Uninitialize(handle)
    if ctx.config.fd:
        result = api.InitializeFD(handle, bus.fd_bitrate)  # type: ignore[attr-defined]
    else:
        rate = PCAN_BITRATES.get(ctx.config.bitrate_bps or 500_000, PCAN_BAUD_500K)
        result = api.Initialize(handle, rate)
    if result != _PCAN_ERROR_OK:
        raise OSError(f"CAN_Initialize on the held handle returned 0x{int(result):X}")
    params = [(PCAN_ALLOW_ERROR_FRAMES, PCAN_PARAMETER_ON)]
    if not ctx.config.listen_only:
        params.append((PCAN_ALLOW_ECHO_FRAMES, PCAN_PARAMETER_ON))
    params.append((PCAN_ALLOW_STATUS_FRAMES, PCAN_PARAMETER_OFF))
    event = getattr(bus, "_recv_event", None)
    if event is not None:
        params.append((PCAN_RECEIVE_EVENT, event))
    for param, value in params:
        result = api.SetValue(handle, param, value)
        if result != _PCAN_ERROR_OK:
            raise OSError(f"CAN_SetValue({int(param)}) returned 0x{int(result):X}")
    return True


#: The ladder, in the order the live runs take it.
STRATEGIES: dict[str, Strategy] = {
    s.name: s
    for s in (
        Strategy("sidecar", None),
        Strategy("state_active", state_active),
        Strategy("bus_reset", bus_reset),
        Strategy("close_then_open", close_then_open),
        Strategy(
            "auto_reset", auto_reset_recover, on_open=_arm_auto_reset, pcan_only=True
        ),
        Strategy("uninit_init_same_handle", uninit_init_same_handle, pcan_only=True),
    )
}
