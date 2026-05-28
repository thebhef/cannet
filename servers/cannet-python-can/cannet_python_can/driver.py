"""Internal driver-adapter interface for the python-can sidecar.

The sidecar's wire-level code (``server.py``) talks only to the
:class:`Driver` protocol defined here, never directly to
``python-can``. A user who wants to swap out the driver library — for
LGPL reasons, performance reasons, or to add a new backend — writes a
new module with the same surface and points
:envvar:`CANNET_DRIVER_MODULE` at it. The default implementation is
:mod:`cannet_python_can.driver_python_can`.

The driver interface is intentionally narrow: enumerate, open, close,
receive, send, and report controller state. Bus speed / FD
configuration travels through :meth:`Driver.open` (and is refreshed at
runtime via close+reopen when the wire layer receives a
``ConfigureBus`` envelope).
"""

from __future__ import annotations

import dataclasses
from typing import Iterable, Optional, Protocol


@dataclasses.dataclass(frozen=True)
class Channel:
    """One enumerable hardware channel.

    ``id`` is the wire-level ``Interface.id`` reported by
    ``ListInterfaces``. The grammar is
    ``<vendor>:<body>(<key:value>, <key:value>, …)`` — the body is the
    vendor-specific routing key python-can needs, and the parens
    carry identity metadata the host persists. Examples:

    - ``vector:VN1640A(SN:12345, ch:0)``
    - ``kvaser:1(SN:67890, ch:0)``
    - ``pcan:PCAN_USBBUS1(h:0x51, ch:0)``
    - ``pcan:PCAN_USBBUS1(h:0x51, ch:0, uid:42)`` (user set a PCAN-View
      device id)

    For Vector, the paren ``SN:`` field is the open-path key:
    :func:`_bus_kwargs_for` passes ``serial=`` + ``channel=`` to
    python-can so the driver resolves the physical channel directly
    via ``get_channel_configs`` and never calls ``xlGetApplConfig``.
    For other vendors the body alone is enough to open the channel —
    the paren metadata is identity-only.

    ``display_name`` is the user-facing label, e.g.
    ``"Vector VN1640A (SN:12345) ch0"``.
    """

    id: str
    display_name: str
    fd_capable: bool = False


@dataclasses.dataclass(frozen=True)
class OpenConfig:
    """Per-interface configuration applied when a channel is opened.

    The wire ``ConfigureBus`` envelope (ADR 0022) maps onto this
    struct: ``speed_bps`` → :attr:`bitrate_bps`,
    ``fd_data_speed_bps`` → :attr:`data_bitrate_bps`,
    ``fd_enabled`` → :attr:`fd`. ``listen_only`` is not on the wire
    today; the server passes the default.
    """

    bitrate_bps: Optional[int] = None
    data_bitrate_bps: Optional[int] = None
    fd: bool = False
    listen_only: bool = False


#: Controller state names returned by :meth:`OpenChannel.state`.
#: Mapped by the wire layer onto the ``ControllerState`` proto enum.
STATE_ACTIVE = "active"
STATE_PASSIVE = "passive"
STATE_BUS_OFF = "bus_off"


@dataclasses.dataclass(frozen=True)
class ControllerState:
    """Snapshot of a controller's ISO 11898-1 fault-confinement state.

    ``state`` is one of :data:`STATE_ACTIVE`, :data:`STATE_PASSIVE`,
    :data:`STATE_BUS_OFF`. ``tec`` / ``rec`` are the current Transmit /
    Receive Error Counters; backends that don't expose them report 0.
    """

    state: str = STATE_ACTIVE
    tec: int = 0
    rec: int = 0


@dataclasses.dataclass(frozen=True)
class Frame:
    """One CAN frame in either direction.

    Mirrors the fields the wire-level ``Frame`` message carries; the
    sidecar's ``server.py`` translates between this dataclass and the
    proto. Keeping the driver surface free of generated proto types
    makes alternative-driver authors' lives easier.
    """

    timestamp_ns: int
    can_id: int
    extended: bool
    is_rx: bool
    data: bytes
    fd: bool = False
    brs: bool = False
    esi: bool = False
    is_remote: bool = False
    is_error: bool = False
    dlc: int = 0


class TxRejected(Exception):
    """Raised by :meth:`Driver.send` when the driver refused the frame.

    The sidecar's wire layer maps this onto ``Error.CODE_TX_REJECTED``
    (read-only / listen-only / bus-off / vendor-specific). The
    accompanying message is forwarded verbatim.
    """


class Driver(Protocol):
    """Adapter protocol for swappable hardware-driver libraries.

    Implementations must be safe to call from a single thread per
    open channel; the sidecar runs one rx loop and one tx queue per
    subscribed interface.
    """

    def list_channels(self) -> Iterable[Channel]:
        """Enumerate available channels across all supported vendors."""

    def open(self, channel_id: str, config: OpenConfig) -> "OpenChannel":
        """Open a single channel for rx/tx."""


class OpenChannel(Protocol):
    """Handle to an opened channel."""

    channel_id: str

    def recv(self, timeout_s: float) -> Optional[Frame]:
        """Block up to ``timeout_s`` for a frame; ``None`` on timeout."""

    def send(self, frame: Frame) -> None:
        """Send ``frame``. Raises :class:`TxRejected` if refused."""

    def state(self) -> ControllerState:
        """Return the controller's current fault-confinement state.

        Backends that don't expose state report
        :data:`STATE_ACTIVE` with zero counters.
        """

    def close(self) -> None:
        """Idempotent. Cleans up any vendor resources."""


__all__ = [
    "Channel",
    "ControllerState",
    "Driver",
    "Frame",
    "OpenChannel",
    "OpenConfig",
    "STATE_ACTIVE",
    "STATE_BUS_OFF",
    "STATE_PASSIVE",
    "TxRejected",
]
