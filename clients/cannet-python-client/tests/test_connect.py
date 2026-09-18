"""The four ways this machine reaches one server.

The same state machine the GUI's host half runs (ADR 0041): loopback is
plaintext without a question, a pinned server is always dialled pinned,
first contact is a probe the operator has to answer, and an endpoint
that is not speaking TLS is reached in the clear only after an explicit
yes. Nothing here falls back silently, and nothing is stored when the
operator says no.
"""

from __future__ import annotations

import ssl
import types
from pathlib import Path
from typing import Any

import pytest

from cannet_python_client import connect as connect_flow
from cannet_python_client import tls, trust

DER = b"the certificate the server presented"
OTHER_DER = b"a certificate from somewhere else"
FINGERPRINT = tls.fingerprint_of(DER)
OTHER_FINGERPRINT = tls.fingerprint_of(OTHER_DER)
TOKEN = "KMGqFEndqRji-y-f4Ej48LJZBu7Bjg2IfmRVMv-jHZE"


class Operator:
    """A stand-in for the person at the terminal."""

    def __init__(
        self, *, identity: bool = True, unprotected: bool = False, token: str = TOKEN
    ) -> None:
        self._identity = identity
        self._unprotected = unprotected
        self._token = token
        self.asked: list[tuple[str, str]] = []

    def accept_identity(self, address: str, fingerprint: str) -> bool:
        self.asked.append(("identity", fingerprint))
        return self._identity

    def token_for(self, address: str) -> str:
        self.asked.append(("token", address))
        return self._token

    def accept_unprotected(self, address: str, detail: str) -> bool:
        self.asked.append(("unprotected", detail))
        return self._unprotected


class Probe:
    """A certificate fetch that never leaves the process."""

    def __init__(self, der: bytes | None = DER, error: Exception | None = None) -> None:
        self.der = der
        self.error = error
        self.calls: list[tuple[str, int]] = []

    def __call__(self, host: str, port: int, timeout: float) -> tuple[bytes, list[str]]:
        self.calls.append((host, port))
        if self.error is not None:
            raise self.error
        assert self.der is not None
        return self.der, ["bench.local"]


class Verify:
    """The one authenticated RPC that proves the stored decision works."""

    def __init__(self) -> None:
        self.targets: list[trust.ServerTarget] = []

    def __call__(self, target: trust.ServerTarget, timeout: float) -> list[Any]:
        self.targets.append(target)
        return [types.SimpleNamespace(id="virtual:bus0")]


def connect(
    server: str,
    *,
    path: Path,
    operator: Operator | None = None,
    probe: Probe | None = None,
    verify: Verify | None = None,
) -> connect_flow.Connection:
    return connect_flow.connect(
        server,
        operator=operator or Operator(),
        path=path,
        probe=probe or Probe(),
        verify=verify or Verify(),
    )


def store(tmp_path: Path) -> Path:
    return tmp_path / "servers.json"


def test_a_loopback_server_is_plaintext_and_is_asked_nothing(tmp_path: Path) -> None:
    operator, probe, verify = Operator(), Probe(), Verify()
    connection = connect(
        "127.0.0.1:50051",
        path=store(tmp_path),
        operator=operator,
        probe=probe,
        verify=verify,
    )
    assert connection.target.plaintext
    assert connection.stored is None
    assert operator.asked == []
    assert probe.calls == []
    # It still proves the connection with one authenticated RPC.
    assert verify.targets == [connection.target]
    assert [i.id for i in connection.interfaces] == ["virtual:bus0"]
    # Nothing to remember about a server nobody has to accept.
    assert not store(tmp_path).exists()


def test_a_pinned_server_is_dialled_pinned_with_its_stored_token(
    tmp_path: Path,
) -> None:
    path = store(tmp_path)
    trust.accept_fingerprint("bench:50051", FINGERPRINT, TOKEN, path=path)
    operator, probe = Operator(), Probe()

    connection = connect("bench:50051", path=path, operator=operator, probe=probe)

    assert connection.target.fingerprint == FINGERPRINT
    assert connection.target.token == TOKEN
    assert connection.stored is None
    assert operator.asked == []
    assert probe.calls == [("bench", 50051)]


def test_first_contact_pins_what_the_operator_compared_and_stores_the_token(
    tmp_path: Path,
) -> None:
    path = store(tmp_path)
    operator = Operator(identity=True, token=TOKEN)

    connection = connect("bench:50051", path=path, operator=operator)

    # The fingerprint the operator is shown is the one the server
    # presented, in the form it printed at startup.
    assert operator.asked == [("identity", FINGERPRINT), ("token", "bench:50051")]
    assert connection.stored == connect_flow.PIN
    assert connection.target.fingerprint == FINGERPRINT
    entry = trust.read_servers(path)["bench:50051"]
    assert entry.fingerprint == FINGERPRINT
    assert entry.token == TOKEN


def test_a_first_contact_the_operator_refuses_stores_nothing(tmp_path: Path) -> None:
    path = store(tmp_path)
    verify = Verify()
    with pytest.raises(connect_flow.Refused):
        connect(
            "bench:50051", path=path, operator=Operator(identity=False), verify=verify
        )
    assert not path.exists()
    assert verify.targets == []


def test_an_endpoint_that_is_not_speaking_tls_is_reached_only_after_a_yes(
    tmp_path: Path,
) -> None:
    path = store(tmp_path)
    operator = Operator(unprotected=True)
    probe = Probe(error=ssl.SSLError("wrong version number"))

    connection = connect("old-rig:50051", path=path, operator=operator, probe=probe)

    assert [kind for kind, _ in operator.asked] == ["unprotected"]
    # The transport's own words reach the question, so "bound routable
    # with --no-tls" is distinguishable from "it is not there".
    assert "wrong version number" in operator.asked[0][1]
    assert connection.target.plaintext
    assert connection.stored == connect_flow.UNPROTECTED
    assert trust.read_servers(path)["old-rig:50051"].insecure


def test_there_is_no_silent_fallback_when_the_operator_says_no(
    tmp_path: Path,
) -> None:
    path = store(tmp_path)
    with pytest.raises(connect_flow.Refused):
        connect(
            "old-rig:50051",
            path=path,
            operator=Operator(unprotected=False),
            probe=Probe(error=OSError("connection refused")),
        )
    assert not path.exists()


def test_a_server_already_accepted_unprotected_is_not_asked_again(
    tmp_path: Path,
) -> None:
    path = store(tmp_path)
    trust.accept_insecure("old-rig:50051", path=path)
    operator, probe = Operator(), Probe()

    connection = connect("old-rig:50051", path=path, operator=operator, probe=probe)

    assert connection.target.plaintext
    assert connection.target.token is None
    assert operator.asked == []
    assert probe.calls == []


def test_a_fingerprint_that_is_not_the_pinned_one_is_refused_outright(
    tmp_path: Path,
) -> None:
    path = store(tmp_path)
    trust.accept_fingerprint("bench:50051", OTHER_FINGERPRINT, TOKEN, path=path)
    operator, verify = Operator(), Verify()

    with pytest.raises(tls.PinMismatch) as excinfo:
        connect("bench:50051", path=path, operator=operator, verify=verify)

    # Both fingerprints, because the only way out is for a human to
    # compare them against what the server printed.
    assert FINGERPRINT in str(excinfo.value)
    assert OTHER_FINGERPRINT in str(excinfo.value)
    # No retry, no fallback, no re-prompt, and nothing sent: the stored
    # pin stands and the credential never went out.
    assert operator.asked == []
    assert verify.targets == []
    assert trust.read_servers(path)["bench:50051"].fingerprint == OTHER_FINGERPRINT


def test_a_pinned_server_that_is_not_answering_is_never_offered_in_the_clear(
    tmp_path: Path,
) -> None:
    # The unprotected question belongs to first contact only. Asking it
    # for a pinned server would make "the server is down" a route to
    # dropping its protection.
    path = store(tmp_path)
    trust.accept_fingerprint("bench:50051", FINGERPRINT, TOKEN, path=path)
    operator = Operator(unprotected=True)

    with pytest.raises(connect_flow.Refused) as excinfo:
        connect(
            "bench:50051",
            path=path,
            operator=operator,
            probe=Probe(error=OSError("connection refused")),
        )

    assert operator.asked == []
    assert "connection refused" in str(excinfo.value)
    assert trust.read_servers(path)["bench:50051"].fingerprint == FINGERPRINT


def test_a_server_that_needs_no_token_is_accepted_without_one(tmp_path: Path) -> None:
    path = store(tmp_path)
    connection = connect(
        "bench:50051", path=path, operator=Operator(identity=True, token="")
    )
    assert connection.target.token is None
    assert trust.read_servers(path)["bench:50051"].token is None


def test_the_connection_never_renders_the_token_it_carries(tmp_path: Path) -> None:
    path = store(tmp_path)
    connection = connect("bench:50051", path=path)
    assert TOKEN not in repr(connection)
