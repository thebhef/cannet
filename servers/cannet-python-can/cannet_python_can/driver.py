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
import enum
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

    The four identity fields carry what the vendor's own enumeration
    says about the hardware, for the wire ``Interface`` message of the
    same names. **Every one of them is optional and absent means
    absent**: each backend exposes a different subset and some expose
    none at all, so a backend fills in what it read and leaves the rest
    ``None`` rather than substituting a placeholder. A readout that
    invents a firmware version is worse than one that admits it does
    not know.

    ``driver_name`` is the odd one out: it names the driver stack the
    channel was enumerated *through*, which is a fact about this
    sidecar's own path to the device rather than a device readback, so
    it can be present where all three of the others are absent.
    """

    id: str
    display_name: str
    fd_capable: bool = False
    driver_name: Optional[str] = None
    driver_version: Optional[str] = None
    firmware_version: Optional[str] = None
    serial_number: Optional[str] = None


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
#: Either error counter has passed 95 but neither has reached 128. The
#: controller still communicates and its error flags are still dominant,
#: so this is not one of ISO 11898-1's three confinement states -- it is
#: the warning limit the standard defines on the way to error-passive,
#: and every vendor's status word reports it. Without a name for it a
#: fault that never gets past the warning limit is indistinguishable
#: from a healthy bus, which is what an unplugged CAN cable looked like.
STATE_WARNING = "warning"
STATE_PASSIVE = "passive"
STATE_BUS_OFF = "bus_off"
#: Not a fault-confinement state: the driver can no longer reach the
#: interface, so there is no controller left to report on. A backend
#: returns this when a device read fails outright, which is what a
#: removed USB adapter looks like from here.
STATE_UNAVAILABLE = "unavailable"


@dataclasses.dataclass(frozen=True)
class ControllerState:
    """Snapshot of a controller's ISO 11898-1 fault-confinement state.

    ``state`` is one of :data:`STATE_ACTIVE`, :data:`STATE_WARNING`,
    :data:`STATE_PASSIVE`, :data:`STATE_BUS_OFF` or
    :data:`STATE_UNAVAILABLE`. ``tec`` / ``rec`` are the current
    Transmit / Receive Error Counters; backends that don't expose them
    report 0, and an unavailable interface reports 0 for both because
    nothing is reading them.
    """

    state: str = STATE_ACTIVE
    tec: int = 0
    rec: int = 0


#: Fault-confinement states ordered by how bad they are, so two
#: independent readings of the same controller can be combined without
#: either being able to talk the other down. :data:`STATE_UNAVAILABLE`
#: is deliberately absent: it is not a point on this scale but the
#: absence of a controller to place on it, and it short-circuits.
_STATE_SEVERITY = {
    STATE_ACTIVE: 0,
    STATE_WARNING: 1,
    STATE_PASSIVE: 2,
    STATE_BUS_OFF: 3,
}


def worse_state(a: str, b: str) -> str:
    """The more severe of two fault-confinement readings.

    A controller has one state, but a backend can offer two views of it
    that disagree -- PEAK's ``CAN_GetStatus`` word and its error frames'
    counters did exactly that on the bench, the word saying "warning"
    while the counters said 128, i.e. error-passive. Neither view is
    allowed to lower the other: a status bit set means the controller
    set it, and a counter over a threshold means the controller counted
    past it.
    """
    return a if _STATE_SEVERITY.get(a, 0) >= _STATE_SEVERITY.get(b, 0) else b


def state_from_counters(tec: int, rec: int) -> str:
    """ISO 11898-1 fault confinement, read off the error counters.

    The counters *are* the state machine: the standard defines
    error-passive as either counter above 127 and bus-off as the
    transmit counter above 255, and both fall again on every successful
    transmission or reception, so recovery needs no separate signal. 96
    is the standard's warning limit.

    The receive counter cannot take a controller bus-off -- only a
    transmitter removes itself from the wire -- which is why the two are
    thresholded separately rather than folded into one worst-counter
    figure first.
    """
    if tec > 255:
        return STATE_BUS_OFF
    if tec > 127 or rec > 127:
        return STATE_PASSIVE
    if tec > 95 or rec > 95:
        return STATE_WARNING
    return STATE_ACTIVE


class FrameKind(enum.Enum):
    """The kind of a CAN frame — exactly one per frame.

    Replaces the independent ``is_error`` / ``is_remote`` / ``fd``
    booleans a driver backend reports: those allowed contradictory
    combinations and forced an error > remote > fd priority ladder to be
    re-derived at every boundary. Mirrors the wire ``FrameKind`` enum;
    :mod:`cannet_python_can.server` maps between the two directly.
    """

    CLASSIC = "classic"
    FD = "fd"
    REMOTE = "remote"
    ERROR = "error"

    @classmethod
    def from_flags(cls, *, is_error: bool, is_remote: bool, is_fd: bool) -> "FrameKind":
        """Collapse a backend's independent frame-type booleans (e.g.
        python-can's ``Message.is_error_frame`` / ``is_remote_frame`` /
        ``is_fd``) into a single kind, applying the
        error > remote > fd > classic priority ladder. This is the one
        place the ladder lives."""
        if is_error:
            return cls.ERROR
        if is_remote:
            return cls.REMOTE
        if is_fd:
            return cls.FD
        return cls.CLASSIC


@dataclasses.dataclass(frozen=True)
class Frame:
    """One CAN frame in either direction.

    Mirrors the fields the wire-level ``Frame`` message carries; the
    sidecar's ``server.py`` translates between this dataclass and the
    proto. Keeping the driver surface free of generated proto types
    makes alternative-driver authors' lives easier.

    ``kind`` is the single source of truth for the frame's type;
    ``brs`` / ``esi`` are meaningful only when ``kind`` is
    :attr:`FrameKind.FD`.
    """

    timestamp_ns: int
    can_id: int
    extended: bool
    is_rx: bool
    data: bytes
    kind: FrameKind = FrameKind.CLASSIC
    brs: bool = False
    esi: bool = False
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
        :data:`STATE_ACTIVE` with zero counters. A backend whose device
        read fails — the adapter is gone, the handle is invalid —
        reports :data:`STATE_UNAVAILABLE` rather than the healthy
        default, so "we cannot reach it" never reads as "it is fine".

        Where a backend exposes the error counters, the state is
        :func:`state_from_counters` over them rather than whatever the
        vendor's status word says on its own: the counters are what ISO
        11898-1 defines confinement on, and a status word that
        under-reports cannot be told apart from a healthy bus.
        """

    def rx_loss(self) -> Optional[int]:
        """Receive overruns the backend has reported since this channel
        was opened, or ``None`` where the backend reports no such thing.

        A count of **reports, not of lost frames**. No vendor says how
        many frames an overrun swallowed — PEAK sets a bit in its status
        word, Vector sets a flag on an event — so a backend that
        returned anything else would be inventing a quantity. What the
        number answers is whether the trace is the whole of what the bus
        sent: zero says yes, and any other value says no by an amount
        nobody measured.

        ``None`` is not zero, and the two must not be conflated: zero is
        a backend that watches for loss and has seen none, ``None`` is a
        backend that does not watch. A reader that rendered the second
        as the first would claim a completeness nobody measured.

        Called by the state poll immediately after :meth:`state`, so a
        backend may derive the answer from the same device read rather
        than making a second one.
        """

    def close(self) -> None:
        """Idempotent. Cleans up any vendor resources."""


__all__ = [
    "Channel",
    "ControllerState",
    "Driver",
    "Frame",
    "FrameKind",
    "OpenChannel",
    "OpenConfig",
    "STATE_ACTIVE",
    "STATE_BUS_OFF",
    "STATE_PASSIVE",
    "STATE_UNAVAILABLE",
    "STATE_WARNING",
    "TxRejected",
    "state_from_counters",
    "worse_state",
]
