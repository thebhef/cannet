"""The one list of servers this machine knows about, and what a name
for one means.

The GUI's Servers panel merges what is advertising on the subnet over
what has been accepted here, and shows the result as one row per server.
This is the same merge for a machine with no GUI, and it is a model
fact, not a rendering (ADR 0003): whether a row is trusted and whether
it is currently answering are things the merge decides, and the command
line only prints what it is given.

**A server that is switched off is still a row.** The store is the thing
this list manages, so forgetting a server must not require waiting for
it to come back.

What "trusted" is allowed to mean is exactly what
:func:`cannet_python_client.trust.resolve` — the connection planner —
does with the same address and entry: a row is trusted when the next
connection goes through without a question, which is a pin, an explicit
unprotected choice, or a loopback address, reached in the clear and
never asked about. A stored token on its own is not trust; the
connection would still stop at the certificate.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Mapping, Sequence
from pathlib import Path

from . import trust
from .browse import DEFAULT_BROWSE_TIMEOUT_S, Discover, DiscoveredServer, browse

#: Nothing stored that would carry a connection through: first contact
#: still has to be accepted.
NEW = "new"

#: A stored decision reaches this server without asking.
TRUSTED = "trusted"

#: Reached in the clear, because the operator said so once. A subset of
#: trusted that is worth seeing on its own, since it is the one row that
#: carries no protection.
UNPROTECTED = "unprotected"


class UnknownServer(trust.TrustError):
    """A name matches nothing stored and nothing advertising."""


@dataclasses.dataclass(frozen=True)
class ServerRow:
    """One server, as a list renders it.

    Fields that only a live advertisement carries are ``None`` for a row
    that exists purely because something was accepted for it.
    """

    address: str
    name: str | None = None
    host: str | None = None
    version: str | None = None
    #: Advertising right now. A stored server that is off is a row with
    #: this ``False``, never an absent row.
    online: bool = False
    trust: str = NEW
    fingerprint: str | None = None
    #: Whether a token is stored — never the token itself: nothing that
    #: renders a row has a use for the value.
    has_token: bool = False
    #: The address was put in the list by hand. Not a trust decision.
    manual: bool = False


def trust_state(address: str, entry: trust.TrustEntry) -> str:
    """Where one server stands with this machine.

    Trusted is not a second reading of the store: it is whether the
    connection planner has a plan at all, so a row cannot come to a
    different conclusion than the connection it describes.
    """
    try:
        trust.resolve(address, servers={trust.server_key(address): entry})
    except trust.ServerNotTrusted:
        return NEW
    if entry.insecure and not entry.fingerprint:
        return UNPROTECTED
    return TRUSTED


def merge(
    discovered: Sequence[DiscoveredServer],
    servers: Mapping[str, trust.TrustEntry],
) -> list[ServerRow]:
    """The browse laid over the store, one row per server.

    Keyed by :func:`cannet_python_client.trust.server_key` throughout,
    because that is what the store files entries under: a browsed
    ``192.168.1.10:50051`` and an accepted one are the same server.

    Answering servers come first, then by the label the row leads with —
    a server going offline drops to the bottom rather than leaving a gap
    in the middle of the list.
    """
    rows: dict[str, ServerRow] = {}
    for address, entry in servers.items():
        key = trust.server_key(address)
        rows[key] = ServerRow(
            address=key,
            trust=trust_state(key, entry),
            fingerprint=entry.fingerprint,
            has_token=entry.token is not None,
            manual=entry.manual,
        )
    for server in discovered:
        key = trust.server_key(server.address)
        row = rows.get(key) or ServerRow(
            address=key, trust=trust_state(key, trust.TrustEntry())
        )
        rows[key] = dataclasses.replace(
            row,
            name=server.name,
            host=server.host,
            version=server.version,
            online=True,
        )
    return sorted(
        rows.values(), key=lambda row: (not row.online, _label(row), row.address)
    )


def _label(row: ServerRow) -> str:
    """What the row leads with: its instance name, or its address."""
    return row.name or row.address


def known_servers(
    *,
    timeout: float = DEFAULT_BROWSE_TIMEOUT_S,
    path: Path | str | None = None,
    discover: Discover | None = None,
) -> list[ServerRow]:
    """:func:`merge` over a one-shot browse and the machine's store."""
    return merge((discover or browse)(timeout), trust.read_servers(path))


def resolve_address(
    server: str,
    *,
    servers: Mapping[str, trust.TrustEntry],
    discover: Discover | None = None,
    timeout: float = DEFAULT_BROWSE_TIMEOUT_S,
) -> str:
    """The ``host:port`` a name on the command line means.

    The store answers first and without touching the network: a name
    that was accepted once is that entry, whatever is on the subnet
    today. An address is taken as typed. Only a bare name nothing is
    stored for is looked for among the advertising servers — by instance
    name or by the machine's own name — and a name two of them answer to
    is refused rather than guessed at.
    """
    key = trust.match_key(server, servers)
    if key is not None:
        return key
    address = trust.server_key(server)
    if trust.split_authority(address)[1] is not None:
        return address
    if trust.is_local(address):
        # Nothing is ever accepted for loopback, so there is no entry
        # for a bare name to have matched.
        return f"{address}:{trust.DEFAULT_PORT}"
    candidates = sorted(
        {
            found.address
            for found in (discover or browse)(timeout)
            if _answers_to(found, address)
        }
    )
    if len(candidates) > 1:
        raise trust.AmbiguousServer(
            f"{server!r} is advertised by several servers ({', '.join(candidates)}); "
            "name the one you mean as host:port"
        )
    if not candidates:
        raise UnknownServer(
            f"nothing is stored for {server!r} and nothing advertising answers to "
            "it; give it as host:port, or check `cannet-client list`"
        )
    return candidates[0]


def _answers_to(found: DiscoveredServer, name: str) -> bool:
    """Whether an advertising server is the one ``name`` asks for: its
    instance name, or the machine it runs on — with or without the
    ``.local`` the responder publishes."""
    host = (found.host or "").lower()
    return name in {found.name.lower(), host, host.removesuffix(".local")}


def forget(server: str, *, path: Path | str | None = None) -> str | None:
    """Drop what is stored for ``server``, returning the address that
    was dropped, or ``None`` when nothing was stored for it.

    The same act as removing the row in the GUI's Servers panel: the pin,
    the token and any unprotected choice go together, and the next
    connection starts over at trust on first use.
    """
    key = trust.match_key(server, trust.read_servers(path))
    if key is None or not trust.forget(key, path=path):
        return None
    return key
