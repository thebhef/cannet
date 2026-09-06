"""Certificate pinning: the fingerprint form the GUI stores, and the
name a pinned channel is dialled under.

The handshake itself is I/O and is exercised by opening a bus; what is
worth testing in isolation is the arithmetic around it, because a
fingerprint computed in a different encoding than the one the server
prints fails as "pin mismatch" and says nothing about why.
"""

from __future__ import annotations

import base64
import hashlib

import pytest

from cannet_python_client import tls


def test_the_fingerprint_is_the_form_the_server_prints_and_the_gui_stores() -> None:
    # `SHA256:` + unpadded *standard*-alphabet base64 of the SHA-256 of
    # the certificate's DER, 43 characters — OpenSSH's host-key form,
    # which is what an operator eyeball-compares.
    der = b"a certificate, as far as a digest is concerned"
    got = tls.fingerprint_of(der)
    expected = base64.b64encode(hashlib.sha256(der).digest()).decode().rstrip("=")
    assert got == f"SHA256:{expected}"
    assert len(got) == len("SHA256:") + 43
    assert "=" not in got


def test_the_alphabet_is_standard_base64_not_url_safe() -> None:
    # The two alphabets differ only in `+/` vs `-_`, so a mistake here
    # is invisible until a digest happens to contain one of them.
    for i in range(4096):
        der = i.to_bytes(2, "big")
        fingerprint = tls.fingerprint_of(der)
        if "+" in fingerprint or "/" in fingerprint:
            break
    else:  # pragma: no cover - 4096 digests without a `+` or `/` is absurd
        pytest.fail("no digest exercised the standard-alphabet characters")
    digest = hashlib.sha256(der).digest()
    assert fingerprint == "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def test_a_matching_pin_is_accepted_and_a_different_one_is_refused() -> None:
    der = b"the certificate the server presented"
    tls.check_pin(der, tls.fingerprint_of(der))
    with pytest.raises(tls.PinMismatch) as excinfo:
        tls.check_pin(der, tls.fingerprint_of(b"some other certificate"))
    # The report has to carry both, because the only way out is for a
    # human to compare them against what the server printed.
    assert tls.fingerprint_of(der) in str(excinfo.value)


def test_a_stored_fingerprint_that_is_not_one_is_an_error_not_a_downgrade() -> None:
    # A store edited into a state we cannot honour must fail loudly;
    # quietly connecting unpinned would be the one thing a pin exists
    # to prevent.
    for bad in ("", "aaa", "SHA1:aaa", "SHA256:not base64!", "SHA256:c2hvcnQ"):
        with pytest.raises(tls.BadFingerprint):
            tls.check_pin(b"der", bad)


# --- the name a pinned channel is dialled under ------------------------

# The shape `ssl.SSLSocket.getpeercert()` returns.
PEERCERT = {
    "subject": ((("commonName", "cannet"),),),
    "subjectAltName": (
        ("DNS", "localhost"),
        ("IP Address", "127.0.0.1"),
        ("IP Address", "::1"),
    ),
}


def test_the_names_come_from_the_subject_alt_names() -> None:
    assert tls.certificate_names(PEERCERT) == ["localhost", "127.0.0.1", "::1"]


def test_a_certificate_with_no_alt_names_falls_back_to_the_common_name() -> None:
    assert tls.certificate_names({"subject": ((("commonName", "rig"),),)}) == ["rig"]


def test_the_address_host_is_preferred_when_the_certificate_carries_it() -> None:
    # Dialling under the name the user typed keeps the override
    # invisible whenever it can be.
    assert tls.target_name(tls.certificate_names(PEERCERT), "127.0.0.1") == "127.0.0.1"


def test_a_host_the_certificate_does_not_carry_falls_back_to_a_name_it_does() -> None:
    # The sole root is this exact certificate, so the name check can
    # only ever be about *which* of its names to use — never about
    # which certificate to accept.
    assert (
        tls.target_name(tls.certificate_names(PEERCERT), "bench.local") == "localhost"
    )


def test_a_nameless_certificate_leaves_the_host_alone() -> None:
    assert tls.target_name([], "bench.local") == "bench.local"
