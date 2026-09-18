"""The list of servers this machine knows about, and what a name on the
command line means.

The merge is the GUI's: what is advertising on the subnet, over what
has been accepted here. A server that is switched off is still a row —
forgetting it must not require waiting for it to come back.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from cannet_python_client import servers, trust
from cannet_python_client.browse import DiscoveredServer

FINGERPRINT = "SHA256:4EMRWrqj5MtP7Lxx4DjdNGUhBPIUijAl4UZekXCJwAc"


def advertised(name: str, address: str, **kwargs: object) -> DiscoveredServer:
    return DiscoveredServer(
        name=name,
        address=address,
        host=kwargs.get("host"),  # type: ignore[arg-type]
        version=kwargs.get("version"),  # type: ignore[arg-type]
    )


def pinned(token: str | None = None) -> trust.TrustEntry:
    return trust.TrustEntry(fingerprint=FINGERPRINT, token=token)


# --- the merge --------------------------------------------------------


def test_a_trusted_server_that_is_switched_off_is_still_a_row() -> None:
    rows = servers.merge([], {"bench:50051": pinned()})
    assert [(r.address, r.trust, r.online) for r in rows] == [
        ("bench:50051", servers.TRUSTED, False)
    ]


def test_a_server_advertising_that_nobody_has_accepted_is_new() -> None:
    rows = servers.merge([advertised("rig", "192.168.1.10:50051")], {})
    assert [(r.name, r.address, r.trust, r.online) for r in rows] == [
        ("rig", "192.168.1.10:50051", servers.NEW, True)
    ]


def test_one_server_in_both_sources_is_one_row_carrying_both_facts() -> None:
    rows = servers.merge(
        [advertised("bench", "BENCH:50051", host="bench.local", version="0.4.0")],
        {"bench:50051": pinned("tok")},
    )
    assert len(rows) == 1
    row = rows[0]
    assert (row.address, row.name, row.host, row.version) == (
        "bench:50051",
        "bench",
        "bench.local",
        "0.4.0",
    )
    assert row.online and row.trust == servers.TRUSTED
    assert row.fingerprint == FINGERPRINT
    # Never the token itself: nothing that renders a row has a use for
    # the value.
    assert row.has_token is True
    assert not hasattr(row, "token")


def test_an_accepted_unprotected_server_says_so_rather_than_reading_as_trusted() -> (
    None
):
    rows = servers.merge([], {"old-rig:50051": trust.TrustEntry(insecure=True)})
    assert rows[0].trust == servers.UNPROTECTED


def test_a_stored_token_on_its_own_is_not_trust() -> None:
    # The connection would still stop at the certificate.
    rows = servers.merge([], {"bench:50051": trust.TrustEntry(token="tok")})
    assert rows[0].trust == servers.NEW


def test_a_loopback_row_is_reached_without_ever_being_asked_about() -> None:
    rows = servers.merge([], {"127.0.0.1:50052": trust.TrustEntry(manual=True)})
    assert rows[0].trust == servers.TRUSTED
    assert rows[0].manual


def test_servers_that_answer_come_first_then_by_the_label_the_row_leads_with() -> None:
    rows = servers.merge(
        [advertised("zulu", "10.0.0.9:50051")],
        {"alpha:50051": pinned(), "10.0.0.9:50051": pinned()},
    )
    assert [r.address for r in rows] == ["10.0.0.9:50051", "alpha:50051"]


# --- what a name on the command line means ----------------------------


class Browse:
    """A browse that records whether it was needed."""

    def __init__(self, *found: DiscoveredServer) -> None:
        self.found = list(found)
        self.calls = 0

    def __call__(self, timeout: float) -> list[DiscoveredServer]:
        self.calls += 1
        return self.found


def test_an_address_is_taken_as_typed_without_a_browse() -> None:
    browse = Browse()
    assert servers.resolve_address("Bench:50051", servers={}, discover=browse) == (
        "bench:50051"
    )
    assert browse.calls == 0


def test_a_name_the_store_holds_is_answered_by_the_store() -> None:
    browse = Browse()
    stored = {"bench:50051": pinned()}
    assert servers.resolve_address("bench", servers=stored, discover=browse) == (
        "bench:50051"
    )
    assert browse.calls == 0


def test_a_name_nothing_is_stored_for_is_looked_for_on_the_subnet() -> None:
    browse = Browse(advertised("bench", "192.168.1.10:50051"))
    assert servers.resolve_address("BENCH", servers={}, discover=browse) == (
        "192.168.1.10:50051"
    )
    assert browse.calls == 1


def test_a_name_two_servers_are_advertising_is_refused_rather_than_guessed() -> None:
    browse = Browse(
        advertised("bench", "192.168.1.10:50051"),
        advertised("bench", "192.168.1.11:50051"),
    )
    with pytest.raises(trust.AmbiguousServer) as excinfo:
        servers.resolve_address("bench", servers={}, discover=browse)
    assert "192.168.1.10:50051" in str(excinfo.value)


def test_a_bare_loopback_name_takes_the_wires_default_port() -> None:
    browse = Browse()
    assert servers.resolve_address("localhost", servers={}, discover=browse) == (
        "localhost:50051"
    )
    assert browse.calls == 0


def test_a_name_nobody_knows_says_so() -> None:
    with pytest.raises(servers.UnknownServer) as excinfo:
        servers.resolve_address("bench", servers={}, discover=Browse())
    assert "bench" in str(excinfo.value)


# --- forgetting -------------------------------------------------------


def test_forgetting_a_server_by_name_takes_the_entry_out(tmp_path: Path) -> None:
    path = tmp_path / "servers.json"
    trust.accept_fingerprint("bench:50051", FINGERPRINT, "tok", path=path)

    assert servers.forget("bench", path=path) == "bench:50051"

    # Back to trust on first use: nothing is stored, so the next connect
    # has a question to ask again.
    assert trust.read_servers(path) == {}


def test_forgetting_something_that_was_never_accepted_reports_nothing(
    tmp_path: Path,
) -> None:
    assert servers.forget("bench", path=tmp_path / "servers.json") is None
