"""A python-can interface plugin for cannet servers.

Opening a bus needs nothing from this package::

    import can

    with can.Bus(interface="cannet", server="bench", channel="blf:0") as bus:
        for message in bus:
            ...

python-can resolves ``interface="cannet"`` through the ``can.interface``
entry point this distribution declares, so an application that already
speaks python-can gains a remote bus by naming one. The names below are
for the things python-can has no vocabulary for: which servers the
machine trusts, and what a peer said about frames it would not carry.

Getting a server onto that list is the ``cannet-client`` command this
distribution also ships (:mod:`cannet_python_client.cli`) — the GUI's
accept-a-server workflow, on a terminal. What it decides is importable
too, and is where the rules live rather than in the command:
:mod:`cannet_python_client.servers` for the list of servers and what a
name means, :mod:`cannet_python_client.connect` for the connection flow,
:mod:`cannet_python_client.browse` for the mDNS browse, and
:mod:`cannet_python_client.trust` for the store itself.

Importing this package opens no connection and reads no file.
"""

from .bus import CannetBus
from .session import (
    BusConfig,
    PerFrameErrors,
    RejectionTally,
    Session,
    SessionClosed,
    SessionError,
)
from .tls import BadFingerprint, PinMismatch, fingerprint_of
from .trust import (
    AmbiguousServer,
    ServerNotTrusted,
    ServerTarget,
    TrustEntry,
    TrustError,
    read_servers,
    resolve,
    servers_file,
)

__version__ = "0.1.0"

__all__ = [
    "AmbiguousServer",
    "BadFingerprint",
    "BusConfig",
    "CannetBus",
    "PerFrameErrors",
    "PinMismatch",
    "RejectionTally",
    "ServerNotTrusted",
    "ServerTarget",
    "Session",
    "SessionClosed",
    "SessionError",
    "TrustEntry",
    "TrustError",
    "__version__",
    "fingerprint_of",
    "read_servers",
    "resolve",
    "servers_file",
]
