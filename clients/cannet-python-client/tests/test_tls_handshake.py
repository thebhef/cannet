"""The pinning handshake itself, against a real TLS-terminating server.

`tests/test_tls.py` pins the arithmetic around a pin — the fingerprint
form, the comparison, the name selection — in isolation, because
neither debug server used to terminate TLS at all. `tls_vbus_server`
(`tests/conftest.py`) closes that gap: `cannet-server debug vbus
--tls-dir <dir>` serves the virtual bus over TLS against a freshly
generated identity, so these tests exercise the real handshake a
hardware server's pinned client goes through.

Built by hand, not through `can.Bus(interface="cannet", server=...)`:
`trust.resolve` always answers a loopback address plaintext
(`trust.is_local`), which is correct for the trust store's real job
but means a loopback TLS server can only be reached by constructing
its `ServerTarget` directly, the way `tests/test_protocol_gate.py`
already does for its own in-process fakes.
"""

from __future__ import annotations

import can
import pytest

from cannet_python_client import tls
from cannet_python_client.session import Session
from cannet_python_client.trust import ServerTarget

FACTORY = "virtual:bus0"

#: Short: a wrong pin is refused before any RPC, so this only needs to
#: cover one TLS handshake's worth of latency, not a server timeout.
REFUSAL_TIMEOUT_S = 5.0


def test_a_pinned_session_subscribes_and_exchanges_a_frame_over_tls(
    tls_vbus_server: tuple[str, str],
) -> None:
    address, fingerprint = tls_vbus_server
    target = ServerTarget(address=address, fingerprint=fingerprint)
    sender = Session(target, FACTORY, timeout=15.0)
    receiver = Session(target, FACTORY, timeout=15.0)
    try:
        sender.send([can.Message(arbitration_id=0x123, data=b"\x01\x02\x03\x04")])
        got = receiver.recv(timeout=5.0)
    finally:
        sender.close()
        receiver.close()
    assert got is not None, "no frame arrived over the TLS-terminating session"
    assert got.arbitration_id == 0x123
    assert bytes(got.data) == b"\x01\x02\x03\x04"


def test_a_wrong_pin_is_refused_at_the_handshake_not_a_hang(
    tls_vbus_server: tuple[str, str],
) -> None:
    address, _fingerprint = tls_vbus_server
    wrong_pin = tls.fingerprint_of(b"not this server's certificate")
    target = ServerTarget(address=address, fingerprint=wrong_pin)
    # The pin is checked against the certificate fetched over an
    # unverified handshake before any gRPC channel — let alone a
    # `Session` — exists, so the constructor never gets as far as
    # opening one; `timeout` bounds that fetch, not a server-side wait.
    with pytest.raises(tls.PinMismatch) as excinfo:
        Session(target, FACTORY, timeout=REFUSAL_TIMEOUT_S)
    assert wrong_pin in str(excinfo.value)
