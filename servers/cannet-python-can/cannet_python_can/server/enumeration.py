"""Interface enumeration and the ``WatchInterfaces`` subscription (ADR 0016).

Enumeration turns the driver's channel list into wire ``Interface``
records. ``WatchInterfaces`` emits one snapshot and then parks until the
client disconnects: this sidecar does not re-enumerate on a timer,
because on PCAN the global attached-channels query contends with active
transmits (see :data:`_WATCH_LIVENESS_RECHECK_S`). Hot-plug changes are
picked up by an explicit ``ListInterfaces`` pull instead.
"""

from __future__ import annotations

import threading
from typing import Iterator

import grpc

from .. import driver as drv
from .._proto import cannet_pb2 as pb

#: How often a parked ``WatchInterfaces`` stream wakes to re-check
#: ``context.is_active()``. This is a liveness safety-net only — it does
#: **not** drive enumeration. ADR 0016 leaves the re-enumeration cadence
#: to the server "[depending on] how cheap enumeration is on this
#: backend"; on PCAN the global ``GetValue(PCAN_ATTACHED_CHANNELS)`` call
#: serialises against ``CAN_Write`` in the driver, so re-enumerating on a
#: timer stalled active transmits (~150 ms hiccups every poll). The
#: sidecar therefore enumerates only on a ``WatchInterfaces`` subscribe
#: and on an explicit ``ListInterfaces`` pull (the GUI's "Discover"
#: button), never on a timer while channels are open.
_WATCH_LIVENESS_RECHECK_S = 5.0


def enumerate_interfaces(driver: drv.Driver) -> list[pb.Interface]:
    """Snapshot the driver's channels as wire ``Interface`` records."""
    return [
        pb.Interface(id=c.id, display_name=c.display_name, fd_capable=c.fd_capable)
        for c in driver.list_channels()
    ]


def watch_interfaces(
    driver: drv.Driver,
    context: grpc.ServicerContext,
    *,
    recheck_interval_s: float,
) -> Iterator[pb.InterfaceList]:
    """Long-lived subscription to the interface set. ADR 0016.

    Emits the current snapshot once, then parks until the client ends the
    call. This sidecar does **not** re-enumerate on a timer: on the PCAN
    backend that global query contends with active transmits (see
    :data:`_WATCH_LIVENESS_RECHECK_S`), so a hot-plug is not pushed
    through the stream — a client picks it up with an explicit
    ``ListInterfaces`` pull (the GUI's "Discover" button). The stream
    therefore yields exactly once and then waits for cancellation.

    The wire contract (``cannet.proto``) permits a server to push a fresh
    snapshot whenever its interface view changes; this server detects no
    changes, so it emits only the initial snapshot — a compliant
    degenerate case, not a re-publish.

    gRPC invokes the ``add_callback`` hook on client cancel / transport
    drop; it wakes the park loop so the generator returns promptly
    instead of sitting out a full recheck interval.
    """
    yield pb.InterfaceList(interfaces=enumerate_interfaces(driver))
    # Wake-on-disconnect: gRPC fires this on client cancel / transport
    # drop, so the park loop below exits without waiting out the full
    # recheck interval. Registered after the first yield — that is the
    # only point where the stream can block.
    disconnected = threading.Event()
    context.add_callback(disconnected.set)
    while context.is_active():
        if disconnected.wait(timeout=recheck_interval_s):
            return
