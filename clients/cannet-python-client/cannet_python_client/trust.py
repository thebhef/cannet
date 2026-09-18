"""The server trust store.

``servers.json`` is the machine's record of which servers have been
accepted and what to present to them. The cannet GUI writes it and owns
its schema; this package is its **second writer**, through the
``cannet-client`` command line, which puts the same acceptance workflow
in front of an operator on a machine with no GUI. Every client on the
machine inherits whichever of the two wrote the decision.

Importing this module for the library's own use writes nothing: a
first-contact decision needs a human to compare a fingerprint against
what the server printed, so it is the command line — which has someone
to ask — that calls :func:`accept_fingerprint` and
:func:`accept_insecure`.

Because the GUI owns the document and may grow fields, a write here is
additive: the entry being edited and every other entry keep whatever
they already carried, including keys this build has never heard of, and
the file is replaced by temp-file + rename so a crash mid-write cannot
leave one that parses as "nothing is trusted".

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
from collections.abc import Callable, Mapping
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

    First contact is answered by a person comparing the fingerprint the
    server presented against the one it printed — the GUI's dialog, or
    ``cannet-client connect``. There is no library equivalent, and
    either acceptance is inherited by every client on the machine.
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


def match_key(server: str, servers: Mapping[str, TrustEntry]) -> str | None:
    """The stored key ``server`` names, or ``None`` for no match.

    A bare name matches the one entry stored for it; an address matches
    only itself.
    """
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
    key = match_key(server, store)
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
        f"accept it once (`cannet-client connect {address}`, or the cannet "
        "GUI's Servers panel) and every client on this machine inherits "
        "the decision"
    )


# --- writing ----------------------------------------------------------


def _document(path: Path) -> dict[str, Any]:
    """The file exactly as it is, or an empty document.

    Deliberately the raw JSON rather than :func:`read_servers`' parsed
    entries: a write has to put back what it did not touch, and what it
    did not touch includes keys this build does not know about.
    """
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return dict(document) if isinstance(document, Mapping) else {}


def _write(path: Path, document: Mapping[str, Any]) -> None:
    """Replace ``path`` with ``document``, atomically.

    Temp sibling + rename, matching the GUI's own writer byte for byte
    in layout (two-space indent), so the two writers do not reformat the
    file back and forth under each other.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(document, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def _servers_of(document: Mapping[str, Any]) -> dict[str, Any]:
    raw = document.get("servers")
    return dict(raw) if isinstance(raw, Mapping) else {}


def _update(
    address: str, edit: Callable[[dict[str, Any]], None], path: Path | str | None
) -> str:
    """Apply ``edit`` to ``address``'s entry and write the file back,
    returning the key the entry is filed under.

    Every other entry, every other key on this entry, and anything
    beside ``servers`` at the top level is carried across untouched. An
    entry the edit empties is removed, so nothing is left behind that
    says nothing.
    """
    target = Path(path) if path is not None else servers_file()
    document = _document(target)
    servers = _servers_of(document)
    key = server_key(address)
    existing = servers.get(key)
    entry: dict[str, Any] = dict(existing) if isinstance(existing, Mapping) else {}
    edit(entry)
    if entry:
        servers[key] = entry
    else:
        servers.pop(key, None)
    document["servers"] = servers
    _write(target, document)
    return key


def accept_fingerprint(
    address: str,
    fingerprint: str,
    token: str | None = None,
    *,
    path: Path | str | None = None,
) -> str:
    """Pin ``fingerprint`` for ``address``, storing ``token`` alongside.

    The write behind trust-on-first-use and behind re-accepting an
    identity that changed: in either case a person has just compared the
    string against the one the server printed, so it replaces whatever
    was pinned before. It also clears any earlier "connect without
    protection" choice — the server is reachable over TLS after all.

    An empty or absent ``token`` leaves whatever is stored alone; a
    server that needs no credential simply has none.
    """

    def edit(entry: dict[str, Any]) -> None:
        entry["fingerprint"] = fingerprint
        entry.pop("insecure", None)
        if token:
            entry["token"] = token

    return _update(address, edit, path)


def accept_insecure(address: str, *, path: Path | str | None = None) -> str:
    """Record that the operator chose to reach ``address`` unprotected.

    The client-side mirror of the server's own ``--no-tls``: it exists
    only as a stored answer to an explicit question, is scoped to one
    server, and drops any pin and token, because a credential must never
    ride an unencrypted channel (ADR 0041).
    """

    def edit(entry: dict[str, Any]) -> None:
        entry["insecure"] = True
        entry.pop("fingerprint", None)
        entry.pop("token", None)

    return _update(address, edit, path)


def forget(address: str, *, path: Path | str | None = None) -> bool:
    """Drop everything stored for ``address``, reporting whether there
    was anything to drop.

    The next connection to it starts over at trust on first use. A
    server nothing is stored for is not an error and is not a write:
    there is no file to create in order to record an absence.
    """
    target = Path(path) if path is not None else servers_file()
    document = _document(target)
    if server_key(address) not in _servers_of(document):
        return False
    _update(address, lambda entry: entry.clear(), target)
    return True
