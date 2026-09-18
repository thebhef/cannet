"""Browsing ``_cannet._tcp`` — the servers advertising on this subnet.

**Browse only.** Nothing here registers or advertises a service: this
package is a client, and a client that announced itself would put
instances on the subnet that nothing can connect to.

**Discovery is convenience only** (ADR 0040). An entry in this list says
a machine on the subnet claimed a name; whether to trust what answers at
that address is decided by :mod:`cannet_python_client.connect` (ADR
0041), never here.

One registration resolves once per interface the responder answers on,
so a single server arrives carrying its VM adapter, its link-local
address and its loopback address alongside the one that actually reaches
it. :func:`dial_address` is the ranking that picks one, and it is the
host's: a routable IPv4 address first, then a routable IPv6 address,
then loopback — which reaches a server on *this* machine and nothing
else, so it must never outrank a routable address.
"""

from __future__ import annotations

import contextlib
import dataclasses
import ipaddress
import time
from collections.abc import Callable, Sequence

from zeroconf import ServiceBrowser, ServiceInfo, ServiceListener, Zeroconf

#: The DNS-SD service type `cannet-server` registers.
SERVICE_TYPE = "_cannet._tcp.local."

#: How long a one-shot browse listens before answering. A multicast
#: query is answered within a few hundred milliseconds by a responder
#: that is up; the rest of the window is for the ones that are slow to
#: wake.
DEFAULT_BROWSE_TIMEOUT_S = 3.0

#: How long resolving one instance's SRV and TXT records may take.
_RESOLVE_TIMEOUT_MS = 2000


@dataclasses.dataclass(frozen=True)
class DiscoveredServer:
    """One advertising server, as a connect surface receives it."""

    #: The instance name the server was started with (``--name``, or its
    #: hostname).
    name: str
    #: ``host:port``, ready to hand to the connect path verbatim.
    address: str
    #: The machine the server runs on, from the SRV record's target
    #: host, root dot dropped. Independent of the instance name — two
    #: servers named alike are told apart by this.
    host: str | None = None
    #: The server's release, from its ``ver`` TXT key.
    version: str | None = None
    #: The protocol packages the server serves, from its ``proto`` TXT
    #: key (ADR 0059). ``None`` for a server that advertises none —
    #: "did not say", never "serves nothing".
    protocols: list[str] | None = None


#: A browse, as the rest of the package calls one — the seam the tests
#: replace, and what keeps the default suite off the network and off
#: multicast.
Discover = Callable[[float], Sequence[DiscoveredServer]]


def _dial_rank(address: str) -> int | None:
    """Preference order for :func:`dial_address`; ``None`` is unusable."""
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return None
    if parsed.is_unspecified:
        return None
    if isinstance(parsed, ipaddress.IPv4Address):
        if parsed.is_loopback:
            return 3
        return 2 if parsed.is_link_local else 0
    if parsed.is_loopback:
        return 4
    # An IPv6 link-local address is unusable without the scope
    # identifier, which does not survive into a `host:port` string.
    return None if parsed.is_link_local else 1


def dial_address(addresses: Sequence[str], port: int) -> str | None:
    """The ``host:port`` to dial for an instance, or ``None`` when none
    of its addresses can be dialled.

    Within a rank the numerically lowest address wins, so the choice is
    stable across resolves rather than drifting with iteration order.
    """
    ranked = [
        (rank, ipaddress.ip_address(address))
        for address, rank in ((a, _dial_rank(a)) for a in addresses)
        if rank is not None
    ]
    if not ranked:
        return None
    host = min(ranked, key=lambda pair: (pair[0], pair[1].packed))[1]
    if isinstance(host, ipaddress.IPv6Address):
        return f"[{host}]:{port}"
    return f"{host}:{port}"


def instance_name(fullname: str) -> str:
    """The instance name inside a DNS-SD fullname.

    A fullname that is not ours is returned whole rather than mangled.
    """
    head = fullname.removesuffix(SERVICE_TYPE)
    return head.removesuffix(".") if head != fullname else fullname


def parse_protocols(value: str | None) -> list[str] | None:
    """The ``proto`` TXT value, as the packages it names (ADR 0059).

    ``None`` for a key that is absent *or* names nothing: both are the
    same answer, "this server did not say", and a row must not read as
    incompatible because a responder published a blank string.
    """
    if value is None:
        return None
    packages = [package.strip() for package in value.split(",")]
    named = [package for package in packages if package]
    return named or None


def discovered(info: ServiceInfo) -> DiscoveredServer | None:
    """One resolved advertisement, or ``None`` when it names no address
    this machine can dial.

    An instance with nothing dialable is not something an operator can
    act on, and listing it would only invite a connect that cannot work.
    """
    address = dial_address(info.parsed_addresses(), info.port or 0)
    if address is None:
        return None
    host = (info.server or "").rstrip(".")
    return DiscoveredServer(
        name=instance_name(info.name),
        address=address,
        host=host or None,
        version=info.decoded_properties.get("ver"),
        protocols=parse_protocols(info.decoded_properties.get("proto")),
    )


class _Collector(ServiceListener):
    """Records which instances answered; resolving happens afterwards."""

    def __init__(self) -> None:
        self.names: set[str] = set()

    def add_service(self, zeroconf: Zeroconf, type_: str, name: str) -> None:
        self.names.add(name)

    def update_service(self, zeroconf: Zeroconf, type_: str, name: str) -> None:
        self.names.add(name)

    def remove_service(self, zeroconf: Zeroconf, type_: str, name: str) -> None:
        self.names.discard(name)


def browse(timeout: float = DEFAULT_BROWSE_TIMEOUT_S) -> list[DiscoveredServer]:
    """Listen for ``timeout`` seconds and report what advertised.

    One shot, not a subscription: a command runs, prints what is there,
    and exits. Instances are collected as they answer and resolved after
    the window closes, so a slow SRV lookup cannot eat the listening
    time.
    """
    collector = _Collector()
    zeroconf = Zeroconf()
    try:
        browser = ServiceBrowser(zeroconf, SERVICE_TYPE, listener=collector)
        try:
            time.sleep(max(timeout, 0.0))
        finally:
            browser.cancel()
        servers = []
        for name in sorted(collector.names):
            info = zeroconf.get_service_info(
                SERVICE_TYPE, name, timeout=_RESOLVE_TIMEOUT_MS
            )
            server = discovered(info) if info is not None else None
            if server is not None:
                servers.append(server)
        return servers
    finally:
        with contextlib.suppress(Exception):
            zeroconf.close()
