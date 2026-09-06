"""The trust store read contract: where ``servers.json`` lives, what it
holds, and how naming a server turns into a connection plan.

These are the tests for the half of the library that needs no server at
all — the file is the GUI's, and this package only reads it.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from cannet_python_client import trust


def write_store(tmp_path: Path, doc: dict) -> Path:
    path = tmp_path / trust.SERVERS_FILE
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


# --- where the file is -------------------------------------------------


def test_the_store_is_the_gui_config_dir_plus_servers_json() -> None:
    # The location is a contract with the GUI, not a preference: the
    # file this package reads is the one the Servers panel writes.
    assert trust.servers_file().name == "servers.json"
    assert trust.servers_file().parent.name == trust.APP_IDENTIFIER
    assert trust.APP_IDENTIFIER == "dev.cannet.app"


@pytest.mark.skipif(os.name != "nt", reason="Windows config-dir rule")
def test_on_windows_the_config_dir_is_appdata() -> None:
    assert trust.config_dir() == Path(os.environ["APPDATA"]) / trust.APP_IDENTIFIER


@pytest.mark.skipif(os.name == "nt", reason="XDG / macOS config-dir rule")
def test_off_windows_the_config_dir_follows_xdg_or_the_mac_location(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", "/tmp/xdg")
    if trust._IS_MACOS:
        assert trust.config_dir().parts[-3:] == (
            "Library",
            "Application Support",
            trust.APP_IDENTIFIER,
        )
    else:
        assert trust.config_dir() == Path("/tmp/xdg") / trust.APP_IDENTIFIER


# --- what the file holds -----------------------------------------------


def test_the_schema_round_trips_the_four_fields_the_gui_writes(
    tmp_path: Path,
) -> None:
    path = write_store(
        tmp_path,
        {
            "servers": {
                "bench:50051": {
                    "fingerprint": "SHA256:aaa",
                    "token": "s3cr3t-value",
                },
                "127.0.0.1:50052": {"manual": True},
                "old:50051": {"insecure": True},
            }
        },
    )
    servers = trust.read_servers(path)
    assert servers["bench:50051"] == trust.TrustEntry(
        fingerprint="SHA256:aaa", token="s3cr3t-value"
    )
    assert servers["127.0.0.1:50052"] == trust.TrustEntry(manual=True)
    assert servers["old:50051"] == trust.TrustEntry(insecure=True)


def test_a_missing_or_corrupt_store_reads_as_nothing_is_trusted(
    tmp_path: Path,
) -> None:
    # Same posture as the host's own reader: the worst case is that a
    # server has to be accepted in the GUI again, never an exception
    # out of an unrelated call.
    assert trust.read_servers(tmp_path / "nope.json") == {}
    (tmp_path / "servers.json").write_text("not json", encoding="utf-8")
    assert trust.read_servers(tmp_path / "servers.json") == {}
    (tmp_path / "servers.json").write_text("[1,2,3]", encoding="utf-8")
    assert trust.read_servers(tmp_path / "servers.json") == {}


def test_unknown_keys_in_an_entry_do_not_break_the_read(tmp_path: Path) -> None:
    # The GUI owns this document and may grow fields; a client that
    # refused to parse one would break on an unrelated GUI release.
    path = write_store(
        tmp_path, {"servers": {"bench:50051": {"fingerprint": "SHA256:a", "future": 1}}}
    )
    assert trust.read_servers(path)["bench:50051"].fingerprint == "SHA256:a"


def test_the_key_is_the_address_with_the_scheme_off_and_the_host_lowercased() -> None:
    assert trust.server_key("https://Bench:50051") == "bench:50051"
    assert trust.server_key("bench:50051") == "bench:50051"
    assert trust.server_key("[::1]:50051") == "[::1]:50051"


# --- naming a server ---------------------------------------------------

STORE = {
    "bench:50051": trust.TrustEntry(fingerprint="SHA256:aaa", token="s3cr3t-value"),
    "bench:50052": trust.TrustEntry(fingerprint="SHA256:bbb"),
    "rig.local:50051": trust.TrustEntry(insecure=True),
    "127.0.0.1:50053": trust.TrustEntry(manual=True),
}


def test_a_host_and_port_resolves_to_its_pin_and_token() -> None:
    target = trust.resolve("bench:50051", servers=STORE)
    assert target.address == "bench:50051"
    assert target.fingerprint == "SHA256:aaa"
    assert target.token == "s3cr3t-value"
    assert not target.plaintext


def test_a_bare_name_resolves_when_the_store_holds_exactly_one_of_them() -> None:
    # "Callers name a server" — and the port is the wire's business,
    # not something worth retyping when only one entry can be meant.
    target = trust.resolve("rig.local", servers=STORE)
    assert target.address == "rig.local:50051"
    assert target.plaintext


def test_a_bare_name_on_a_non_default_port_still_resolves_uniquely() -> None:
    store = {"solo:50099": trust.TrustEntry(fingerprint="SHA256:ccc")}
    assert trust.resolve("solo", servers=store).address == "solo:50099"


def test_a_name_matching_several_ports_is_refused_rather_than_guessed() -> None:
    # bench is trusted on two ports and neither is more right than the
    # other; picking one would silently open the wrong bus.
    with pytest.raises(trust.AmbiguousServer) as excinfo:
        trust.resolve("bench", servers=STORE)
    assert "bench:50051" in str(excinfo.value)
    assert "bench:50052" in str(excinfo.value)


def test_a_bare_loopback_name_takes_the_wire_default_port() -> None:
    # Nothing is ever stored for loopback, so there is no entry to
    # match — but the debug servers all sit on the default port and
    # naming one must not require a port nobody chose.
    assert trust.resolve("localhost", servers={}).address == "localhost:50051"
    assert trust.DEFAULT_PORT == 50051


def test_a_server_nothing_is_stored_for_is_refused_not_probed() -> None:
    # The GUI answers first contact with a dialog. A library has no
    # user to ask, so it must not invent an answer.
    with pytest.raises(trust.ServerNotTrusted):
        trust.resolve("stranger:50051", servers=STORE)


def test_loopback_is_plaintext_whatever_the_store_says() -> None:
    # Mirrors the host's own rule: a local address is reached without
    # protection and without a question, which is what makes the
    # hardware-free test servers usable with no store at all.
    for address in ("127.0.0.1:50051", "localhost:50051", "[::1]:50051"):
        target = trust.resolve(address, servers={})
        assert target.address == address
        assert target.plaintext
        assert target.fingerprint is None


def test_a_stored_insecure_choice_carries_no_credential() -> None:
    # ADR 0041: a credential never rides an unencrypted channel, so an
    # entry that somehow holds both is read as the weaker of the two.
    store = {"old:50051": trust.TrustEntry(insecure=True, token="s3cr3t-value")}
    target = trust.resolve("old:50051", servers=store)
    assert target.plaintext
    assert target.token is None


def test_a_pin_wins_over_an_insecure_flag() -> None:
    # There is no configuration in which a pin degrades to plaintext.
    store = {"both:50051": trust.TrustEntry(fingerprint="SHA256:aaa", insecure=True)}
    assert not trust.resolve("both:50051", servers=store).plaintext


def test_the_token_is_never_rendered_by_repr() -> None:
    # The one hygiene rule that has to live at the type: a `{target!r}`
    # in someone's log line must not carry the credential.
    rendered = repr(trust.resolve("bench:50051", servers=STORE))
    assert "s3cr3t-value" not in rendered
    assert "SHA256:aaa" in rendered
