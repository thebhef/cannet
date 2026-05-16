"""Internal driver-adapter interface for the python-can sidecar.

The sidecar's wire-level code (``server.py``) talks only to the
:class:`Driver` protocol defined here, never directly to
``python-can``. A user who wants to swap out the driver library — for
LGPL reasons, performance reasons, or to add a new backend — writes a
new module with the same surface and points
:envvar:`CANNET_DRIVER_MODULE` at it. The default implementation is
:mod:`cannet_python_can.driver_python_can`.

The driver interface is intentionally narrow: enumerate, open, close,
receive, send. Bus speed / FD configuration travels through
:meth:`Driver.open`; the wire-protocol ``Subscribe`` envelope does not
currently carry these (see ``plans/backlog.md``), so today the GUI
applies the configuration host-side before subscribing.
"""

from __future__ import annotations

import dataclasses
from typing import Iterable, Optional, Protocol


@dataclasses.dataclass(frozen=True)
class Channel:
    """One enumerable hardware channel.

    ``id`` is the wire-level ``Interface.id`` reported by
    ``ListInterfaces``; the wire convention is a vendor-prefixed name
    such as ``vector:VN1640A/ch0``, ``kvaser:0``, or
    ``pcan:PCAN_USBBUS1``. ``display_name`` is the user-facing label.
    """

    id: str
    display_name: str
    fd_capable: bool = False


@dataclasses.dataclass(frozen=True)
class OpenConfig:
    """Per-interface configuration applied when a channel is opened.

    Today the wire ``Subscribe`` envelope only carries
    ``interface_id``; the GUI applies the per-interface bitrate / FD
    settings host-side before subscribing, and the host hands those
    values to :meth:`Driver.open` through this struct. When the
    backlog item that promotes these to the wire lands, the struct
    grows but the driver-side surface does not break.
    """

    bitrate_bps: Optional[int] = None
    data_bitrate_bps: Optional[int] = None
    fd: bool = False
    listen_only: bool = False


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

    def close(self) -> None:
        """Idempotent. Cleans up any vendor resources."""


__all__ = [
    "Channel",
    "Driver",
    "Frame",
    "OpenChannel",
    "OpenConfig",
    "TxRejected",
]
