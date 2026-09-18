"""How this machine reaches one server, and what it asks before it does.

The client half of ADR 0041, as a state machine that owns the decision
and hands every question it cannot answer to an :class:`Operator` — the
person at the terminal, in ``cannet-client connect``; a fake, in the
tests. Nothing here reads input or prints anything.

The four paths
==============

- **Local** (loopback, ``localhost``): plaintext, unconditionally. The
  server itself lets these run unprotected.
- **Pinned**: the certificate is fetched and checked against the stored
  fingerprint, and the stored token rides every RPC. A mismatch is
  refused — no retry, no fallback to plaintext, no re-prompt.
- **Trust on first use**: nothing stored, so the observed fingerprint
  goes to the operator, who compares it against what the server printed
  at startup and, if it matches, hands over the banner's token. Both are
  stored, and every client on the machine inherits them.
- **Explicitly unprotected**: a probe that never reached a certificate
  means the endpoint is not speaking TLS (a server run ``--no-tls``) or
  is not there. There is no silent fallback: the operator is asked, and
  only a stored answer lets a later connection go out in the clear.

A pinned server that is not answering is *not* offered in the clear:
that question belongs to first contact, and asking it here would make
"the server is down" a route to dropping a server's protection.

The stored decision is then proved with one authenticated
``ListInterfaces`` — a token nobody checked is a token that fails later,
in an application, with no one there to compare fingerprints. That call
asks ``ServerInfo`` first, like every connection this package makes
(ADR 0059), so a server speaking a protocol major this client does not
is refused here — with a sentence naming both sides — rather than in an
application later.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

import grpc

from . import session, tls, trust

#: How long the certificate probe and the verifying RPC each wait. The
#: operator is watching this run, so it is short enough to fail while
#: they are still looking at it.
DEFAULT_CONNECT_TIMEOUT_S = 10.0

#: What :attr:`Connection.stored` says when a pin (and any token) was
#: written.
PIN = "pin"

#: What :attr:`Connection.stored` says when an unprotected connection
#: was accepted.
UNPROTECTED = "unprotected"


class Refused(trust.TrustError):
    """The connection did not happen: the operator said no, or there
    was nothing to say yes to."""


class Operator(Protocol):
    """The questions this flow cannot answer for itself."""

    def accept_identity(self, address: str, fingerprint: str) -> bool:
        """Is ``fingerprint`` the one ``address`` printed at startup?"""

    def token_for(self, address: str) -> str:
        """The token from that same banner. Empty means the server
        needs none."""

    def accept_unprotected(self, address: str, detail: str) -> bool:
        """``address`` is not answering with a certificate (``detail``
        is the transport's own words). Reach it in the clear anyway?"""


@dataclasses.dataclass(frozen=True)
class Connection:
    """A server reached, and what reaching it decided.

    ``stored`` names what was written to the trust store on the way —
    :data:`PIN`, :data:`UNPROTECTED`, or ``None`` when the connection
    rested on something already stored (or on nothing, for loopback).
    """

    target: trust.ServerTarget
    interfaces: list[Any]
    stored: str | None = None


#: The certificate fetch, as this module calls one: the seam the tests
#: replace, and what keeps the default suite off the network.
Probe = Callable[[str, int, float], tuple[bytes, list[str]]]

#: The authenticated RPC that proves the decision works.
Verify = Callable[[trust.ServerTarget, float], Sequence[Any]]


def connect(
    address: str,
    *,
    operator: Operator,
    servers: Mapping[str, trust.TrustEntry] | None = None,
    path: Path | str | None = None,
    probe: Probe | None = None,
    verify: Verify | None = None,
    timeout: float = DEFAULT_CONNECT_TIMEOUT_S,
) -> Connection:
    """Reach ``address``, asking ``operator`` whatever only a person can
    answer, and prove it with one authenticated RPC.

    ``address`` is a ``host:port`` — a name is turned into one by
    :func:`cannet_python_client.servers.resolve_address` first, so that
    the browse this flow needs is the one the caller already ran.
    """
    store = trust.read_servers(path) if servers is None else servers
    entry = store.get(trust.server_key(address), trust.TrustEntry())
    stored: str | None = None

    if trust.is_local(address) or (entry.insecure and not entry.fingerprint):
        # A decision that is already made: loopback is never asked
        # about, and an accepted unprotected choice is not asked twice.
        # Neither reaches for a certificate there is no point in having.
        target = trust.resolve(address, servers=store)
    else:
        try:
            der, _names = (probe or tls.peer_certificate)(*_authority(address), timeout)
        except OSError as exc:
            target = _unprotected(address, entry, operator, exc, path)
            stored = UNPROTECTED
        else:
            observed = tls.fingerprint_of(der)
            if entry.fingerprint:
                # Raises `PinMismatch`, carrying both fingerprints,
                # because the only way out is for a person to compare
                # them against what the server printed.
                tls.check_pin(der, entry.fingerprint)
                target = trust.ServerTarget(address, entry.fingerprint, entry.token)
            else:
                target = _first_contact(address, observed, operator, path)
                stored = PIN

    return Connection(
        target=target, interfaces=_verified(target, verify, timeout), stored=stored
    )


def _authority(address: str) -> tuple[str, int]:
    host, port = trust.split_authority(address)
    return host, port or trust.DEFAULT_PORT


def _first_contact(
    address: str, observed: str, operator: Operator, path: Path | str | None
) -> trust.ServerTarget:
    """Put the certificate in front of the operator, and store what they
    accept."""
    if not operator.accept_identity(address, observed):
        raise Refused(
            f"{observed} was not accepted for {address}; nothing was stored and "
            "nothing was sent"
        )
    token = operator.token_for(address).strip() or None
    trust.accept_fingerprint(address, observed, token, path=path)
    return trust.ServerTarget(address, observed, token)


def _unprotected(
    address: str,
    entry: trust.TrustEntry,
    operator: Operator,
    error: OSError,
    path: Path | str | None,
) -> trust.ServerTarget:
    """Nothing answered with a certificate. Ask — never fall back."""
    if entry.fingerprint:
        raise Refused(
            f"{address} is pinned but did not answer with a certificate ({error}); "
            "it is down, or something else is on that port"
        )
    if not operator.accept_unprotected(address, str(error)):
        raise Refused(
            f"{address} was not reached: nothing goes out in the clear unasked"
        )
    trust.accept_insecure(address, path=path)
    return trust.ServerTarget(address)


def _verified(
    target: trust.ServerTarget, verify: Verify | None, timeout: float
) -> list[Any]:
    """One authenticated ``ListInterfaces``: the proof that what is
    stored actually opens a bus."""
    try:
        return list((verify or session.list_interfaces)(target, timeout))
    except session.IncompatibleProtocol as exc:
        # The server is there and answering; it just does not serve the
        # protocol major this client speaks (ADR 0059). Terminal, and
        # the sentence names both sides, so nothing here rewords it.
        raise Refused(f"{target.address} {exc}") from exc
    except grpc.RpcError as exc:
        if isinstance(exc, grpc.Call) and exc.code() == grpc.StatusCode.UNAUTHENTICATED:
            raise Refused(
                f"{target.address} refused the credential; check the token against "
                f"the one it printed, or `cannet-client forget {target.address}` and "
                "accept it again"
            ) from exc
        raise Refused(f"{target.address} refused the connection: {exc}") from exc
    except OSError as exc:
        raise Refused(f"{target.address} could not be reached: {exc}") from exc
