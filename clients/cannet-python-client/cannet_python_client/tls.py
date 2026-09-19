"""Certificate pinning for a gRPC channel.

The Rust client pins by fingerprint: it terminates TLS itself and
refuses any certificate whose SHA-256 is not the accepted one. Python's
gRPC bindings expose no verifier hook, so the closest equivalent — and
what this module builds — is to *fetch* the server's certificate, check
its fingerprint against the accepted one, and then hand that exact
certificate to gRPC as the channel's **sole** trust root.

The two are equivalent in what they accept: a channel whose only root
is one self-signed end-entity certificate can complete a handshake with
that certificate and nothing else. What differs is that OpenSSL still
runs a hostname check, which by then can only decide *which of the
certificate's own names* to dial under — never which certificate to
accept. :func:`target_name` picks one the certificate carries, and
`grpc.ssl_target_name_override` supplies it.

The fingerprint form is the server's: ``SHA256:`` followed by unpadded
standard-alphabet base64 of the SHA-256 of the certificate's DER, 43
characters. That is OpenSSH's host-key form, which is what the server
prints at startup and what the operator eyeball-compares in the GUI.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import socket
import ssl
from collections.abc import Mapping, Sequence
from typing import Any

import grpc

#: The prefix the server prints and the trust store holds.
FINGERPRINT_PREFIX = "SHA256:"

#: Length of unpadded base64 of a 32-byte digest.
_DIGEST_B64_LEN = 43

#: How long the certificate probe waits for a handshake.
DEFAULT_PROBE_TIMEOUT_S = 10.0


class BadFingerprint(ValueError):
    """A stored fingerprint is not one.

    A hard error rather than a downgrade to an unpinned connection: the
    store has been edited into a state that cannot be honoured, and
    quietly connecting without a pin is the one thing a pin exists to
    prevent.
    """


class PinMismatch(Exception):
    """The server presented a certificate that is not the pinned one."""


def fingerprint_of(der: bytes) -> str:
    """The pin form of the certificate whose DER encoding is ``der``."""
    digest = hashlib.sha256(der).digest()
    return FINGERPRINT_PREFIX + base64.b64encode(digest).decode("ascii").rstrip("=")


def parse_fingerprint(text: str) -> str:
    """Validate a stored fingerprint and return it canonicalised.

    Raises :class:`BadFingerprint` for anything that is not the
    server's display form.
    """
    if not text.startswith(FINGERPRINT_PREFIX):
        raise BadFingerprint(f"{text!r} is not a {FINGERPRINT_PREFIX} fingerprint")
    encoded = text[len(FINGERPRINT_PREFIX) :]
    if len(encoded) != _DIGEST_B64_LEN:
        raise BadFingerprint(
            f"{text!r} is {len(encoded)} base64 characters, not {_DIGEST_B64_LEN}"
        )
    try:
        digest = base64.b64decode(encoded + "=", validate=True)
    except (ValueError, binascii.Error) as exc:
        raise BadFingerprint(f"{text!r} is not standard-alphabet base64") from exc
    if len(digest) != 32:
        raise BadFingerprint(f"{text!r} does not decode to a SHA-256 digest")
    return text


def check_pin(der: bytes, expected: str) -> None:
    """Raise unless ``der`` is the certificate ``expected`` names.

    The report carries both fingerprints, because the only way out is
    for a human to compare them against what the server printed.
    """
    parse_fingerprint(expected)
    observed = fingerprint_of(der)
    if observed != expected:
        raise PinMismatch(
            f"the server presented {observed}, but {expected} is pinned for it; "
            "accept the new identity in the cannet GUI if the server was "
            "reinstalled, and investigate otherwise"
        )


def certificate_names(peercert: Mapping[str, Any]) -> list[str]:
    """Every name a parsed peer certificate claims.

    Subject alternative names first — the only ones a modern verifier
    looks at — falling back to the common name for a certificate that
    carries none.
    """
    names = [
        str(value)
        for kind, value in peercert.get("subjectAltName", ())
        if kind in ("DNS", "IP Address")
    ]
    if names:
        return names
    return [
        str(value)
        for relative_name in peercert.get("subject", ())
        for key, value in relative_name
        if key == "commonName"
    ]


def target_name(names: Sequence[str], host: str) -> str:
    """Which of ``names`` to dial the pinned channel under.

    The host as typed whenever the certificate carries it, so the
    override stays invisible; otherwise any name it does carry. A
    certificate with no names at all leaves ``host`` alone — there is
    nothing better to say, and the pin has already decided what is
    acceptable.
    """
    if host in names or not names:
        return host
    return names[0]


def peer_certificate(
    host: str, port: int, timeout: float = DEFAULT_PROBE_TIMEOUT_S
) -> tuple[bytes, list[str]]:
    """Fetch ``host:port``'s certificate: its DER and the names it claims.

    Two handshakes, because they answer different questions and the
    second cannot be asked before the first is answered. The first
    verifies nothing and exists only to see the certificate; the second
    trusts that exact certificate as its own root, which is what makes
    OpenSSL parse and hand back the name list. No credential is sent on
    either — this runs before the pin is checked.
    """
    unverified = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    unverified.check_hostname = False
    unverified.verify_mode = ssl.CERT_NONE
    der = _handshake(host, port, timeout, unverified, binary=True)

    verified = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    # The names are what this handshake is for, so it must not fail on
    # one; the certificate itself is already fixed by being the root.
    verified.check_hostname = False
    verified.load_verify_locations(cadata=ssl.DER_cert_to_PEM_cert(der))
    try:
        parsed = _handshake(host, port, timeout, verified, binary=False)
    except ssl.SSLError:
        # A certificate OpenSSL will not chain to itself (an
        # intermediate-signed one, say) still pins fine; it just cannot
        # tell us its names this way.
        return der, []
    return der, certificate_names(parsed or {})


def _handshake(
    host: str, port: int, timeout: float, context: ssl.SSLContext, *, binary: bool
) -> Any:
    with (
        socket.create_connection((host, port), timeout=timeout) as raw,
        context.wrap_socket(raw, server_hostname=host) as secured,
    ):
        return secured.getpeercert(binary_form=binary)


def channel_credentials(der: bytes) -> grpc.ChannelCredentials:
    """Channel credentials whose sole trust root is this certificate."""
    return grpc.ssl_channel_credentials(
        root_certificates=ssl.DER_cert_to_PEM_cert(der).encode("ascii")
    )
