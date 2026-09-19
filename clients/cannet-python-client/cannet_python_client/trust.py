"""The server trust store, as a read contract.

``servers.json`` is written by the cannet GUI and read here. It is the
machine's record of which servers have been accepted and what to
present to them, and this package never writes it: a first-contact
decision needs a human to compare a fingerprint against what the
server printed, and a library has nobody to ask.

Location
========

The file is ``servers.json`` inside the GUI's per-user config
directory, which is the platform-standard config directory plus the
application identifier ``dev.cannet.app``:

===========  ==================================================
Windows      ``%APPDATA%\\dev.cannet.app\\servers.json``
macOS        ``~/Library/Application Support/dev.cannet.app/servers.json``
Linux        ``$XDG_CONFIG_HOME/dev.cannet.app/servers.json``
             (``~/.config`` when ``XDG_CONFIG_HOME`` is unset)
===========  ==================================================

Schema
======

One JSON object with a single ``servers`` key, mapping a normalised
``host:port`` to what the machine holds for that server. Every field of
an entry is optional::

    {
      "servers": {
        "bench.local:50051": {
          "fingerprint": "SHA256:4EMRWrqj5MtP7Lxx4DjdNGUhBPIUijAl4UZekXCJwAc",
          "token": "KMGqFEndqRji-y-f4Ej48LJZBu7Bjg2IfmRVMv-jHZE"
        },
        "old-rig:50051": { "insecure": true },
        "127.0.0.1:50052": { "manual": true }
      }
    }

``fingerprint``
    The accepted certificate fingerprint, in the ``SHA256:`` +
    unpadded-base64 form the server prints and the operator compares.
``token``
    The bearer token to present on every RPC. **Stored in the clear**,
    so it must never be logged; :class:`ServerTarget` redacts it.
``insecure``
    The operator explicitly chose to reach this routable address
    without protection — the client-side mirror of the server's own
    ``--no-tls``. Never a default and never inferred from a failure.
``manual``
    The address was typed into the Servers panel by hand. It carries no
    connection decision at all.

The key is the address with any ``scheme://`` removed and lower-cased.
A server that moves is a different entry: a pin vouches for an identity
*at an address*, so accepting one address says nothing about another.

Unknown keys are ignored. The GUI owns this document and may grow
fields; a reader that refused to parse one would break on an unrelated
GUI release.

Reading the plan
================

:func:`resolve` turns a server name into a :class:`ServerTarget`,
applying the same rules as the GUI's own connection planner (ADR 0041):
a loopback address is plaintext whatever is stored, a pinned server is
*always* dialled pinned, and only a server with nothing pinned may use
a stored "connect without protection" choice. A credential never rides
an unencrypted channel, so a plaintext target carries no token.
"""

from __future__ import annotations

import dataclasses
import ipaddress
import json
import os
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

#: File name inside the config directory.
SERVERS_FILE = "servers.json"

#: The GUI's application identifier, which is also its config
#: directory's name.
APP_IDENTIFIER = "dev.cannet.app"

#: The wire's default port, used when a bare server name matches no
#: stored entry and names a loopback address.
DEFAULT_PORT = 50051

_IS_WINDOWS = os.name == "nt"
_IS_MACOS = sys.platform == "darwin"


class TrustError(Exception):
    """Base for every failure to turn a server name into a plan."""


class ServerNotTrusted(TrustError):
    """Nothing is stored for this server, and it is not loopback.

    The GUI answers first contact with a dialog that shows the
    fingerprint the server presented. There is no library equivalent —
    accept the server in the GUI once, and every client on the machine
    inherits the decision.
    """


class AmbiguousServer(TrustError):
    """A bare name matches several stored servers.

    Neither is more right than the other, and picking one would
    silently open the wrong bus. Name the port too.
    """


@dataclasses.dataclass(frozen=True)
class TrustEntry:
    """One server's entry, exactly as the document spells it."""

    fingerprint: str | None = None
    token: str | None = None
    insecure: bool = False
    manual: bool = False

    def __repr__(self) -> str:
        # The token is a credential; a `{entry!r}` in a log line or an
        # exception must not carry it.
        redacted = "<redacted>" if self.token else None
        return (
            f"TrustEntry(fingerprint={self.fingerprint!r}, token={redacted!r}, "
            f"insecure={self.insecure!r}, manual={self.manual!r})"
        )


@dataclasses.dataclass(frozen=True)
class ServerTarget:
    """How one server is to be reached: the address, and the protection.

    ``fingerprint`` present means TLS pinned to that certificate, with
    ``token`` presented as an ``authorization: Bearer`` credential on
    every RPC. ``fingerprint`` absent means plaintext, and then ``token``
    is always ``None`` — a credential never rides an unencrypted
    channel.
    """

    address: str
    fingerprint: str | None = None
    token: str | None = None

    @property
    def plaintext(self) -> bool:
        """Whether this target is reached without TLS."""
        return self.fingerprint is None

    @property
    def host(self) -> str:
        return split_authority(self.address)[0]

    @property
    def port(self) -> int:
        return split_authority(self.address)[1] or DEFAULT_PORT

    def __repr__(self) -> str:
        redacted = "<redacted>" if self.token else None
        return (
            f"ServerTarget(address={self.address!r}, "
            f"fingerprint={self.fingerprint!r}, token={redacted!r})"
        )


def config_dir() -> Path:
    """The GUI's per-user config directory."""
    if _IS_WINDOWS:
        base = os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming"
    elif _IS_MACOS:
        base = Path.home() / "Library" / "Application Support"
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config"
    return Path(base) / APP_IDENTIFIER


def servers_file() -> Path:
    """The trust store's path on this machine."""
    return config_dir() / SERVERS_FILE


def strip_scheme(address: str) -> str:
    """``address`` without a leading ``scheme://``."""
    _, sep, rest = address.partition("://")
    return rest if sep else address


def server_key(address: str) -> str:
    """The key an address is filed under: scheme off, lower-cased.

    Case is the only normalisation. ``1.2.3.4:50051`` and
    ``bench:50051`` stay distinct even when they name the same machine,
    which is the point.
    """
    return strip_scheme(address).lower()


def split_authority(address: str) -> tuple[str, int | None]:
    """``address`` as ``(host, port)``, with ``None`` for no port.

    Handles the bracketed IPv6 form. An unbracketed address with
    several colons is not a valid authority, so it is read as a bare
    host rather than guessed at.
    """
    authority = strip_scheme(address)
    if authority.startswith("["):
        host, _, rest = authority[1:].partition("]")
        port = rest[1:] if rest.startswith(":") else ""
        return host, int(port) if port.isdigit() else None
    head, sep, tail = authority.rpartition(":")
    if sep and tail.isdigit() and ":" not in head:
        return head, int(tail)
    return authority, None


def is_local(address: str) -> bool:
    """Whether ``address`` is reached without protection and without a
    question — the host's own rule, so no surface re-derives it."""
    host = split_authority(address)[0]
    if host.lower() == "localhost":
        return True
    try:
        parsed = ipaddress.ip_address(host)
    except ValueError:
        return False
    mapped = getattr(parsed, "ipv4_mapped", None)
    return bool((mapped or parsed).is_loopback)


def _entry_from(raw: Any) -> TrustEntry | None:
    if not isinstance(raw, Mapping):
        return None
    return TrustEntry(
        fingerprint=raw.get("fingerprint") or None,
        token=raw.get("token") or None,
        insecure=bool(raw.get("insecure", False)),
        manual=bool(raw.get("manual", False)),
    )


def read_servers(path: Path | str | None = None) -> dict[str, TrustEntry]:
    """Read the trust store, keyed by normalised ``host:port``.

    A missing, unreadable, or malformed file reads as "nothing is
    trusted" rather than raising — the same best-effort posture the GUI
    takes, and the safe direction: the worst case is that a server has
    to be accepted again.
    """
    target = Path(path) if path is not None else servers_file()
    try:
        document = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(document, Mapping):
        return {}
    raw_servers = document.get("servers")
    if not isinstance(raw_servers, Mapping):
        return {}
    entries = {}
    for address, raw in raw_servers.items():
        entry = _entry_from(raw)
        if entry is not None:
            entries[server_key(str(address))] = entry
    return entries


def _match_key(server: str, servers: Mapping[str, TrustEntry]) -> str | None:
    """The stored key ``server`` names, or ``None`` for no match."""
    key = server_key(server)
    if key in servers:
        return key
    if split_authority(key)[1] is not None:
        return None
    candidates = sorted(k for k in servers if split_authority(k)[0] == key)
    if len(candidates) > 1:
        raise AmbiguousServer(
            f"{server!r} names several trusted servers ({', '.join(candidates)}); "
            "give the port too"
        )
    return candidates[0] if candidates else None


def resolve(
    server: str,
    *,
    servers: Mapping[str, TrustEntry] | None = None,
    path: Path | str | None = None,
) -> ServerTarget:
    """Turn a server name or ``host:port`` into a connection plan.

    ``servers`` overrides the store (the tests' seam); ``path``
    overrides where the store is read from.

    Raises :class:`AmbiguousServer` when a bare name matches more than
    one entry, and :class:`ServerNotTrusted` when nothing is stored for
    a non-loopback address.
    """
    store = read_servers(path) if servers is None else servers
    key = _match_key(server, store)
    address = key if key is not None else server_key(server)
    entry = store.get(key) if key is not None else None

    if is_local(address):
        # A local address is plaintext whatever else is stored, and it
        # is the one case where a port nobody stored can be defaulted:
        # nothing is ever accepted for loopback, so there is no entry
        # for a bare name to match.
        if split_authority(address)[1] is None:
            address = f"{address}:{DEFAULT_PORT}"
        return ServerTarget(address=address)
    if entry is not None and entry.fingerprint:
        # There is no configuration in which a pin degrades to
        # plaintext, so this outranks `insecure`.
        return ServerTarget(
            address=address, fingerprint=entry.fingerprint, token=entry.token
        )
    if entry is not None and entry.insecure:
        # ADR 0041: a credential never rides an unencrypted channel, so
        # any token stored alongside is dropped rather than sent.
        return ServerTarget(address=address)
    raise ServerNotTrusted(
        f"nothing is stored for {address!r} in {servers_file()}; "
        "accept the server in the cannet GUI once and every client on "
        "this machine inherits the decision"
    )
