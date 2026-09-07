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
