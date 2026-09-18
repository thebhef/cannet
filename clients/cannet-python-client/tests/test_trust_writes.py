"""Writing the trust store.

The GUI wrote this file first and still owns its schema, so every write
here has to be additive: what the GUI put in a document has to survive
a write by this package byte for byte, including fields this build has
never heard of.
"""

from __future__ import annotations

import json
from pathlib import Path

from cannet_python_client import trust

FINGERPRINT = "SHA256:4EMRWrqj5MtP7Lxx4DjdNGUhBPIUijAl4UZekXCJwAc"
OTHER_FINGERPRINT = "SHA256:qF3RmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
TOKEN = "KMGqFEndqRji-y-f4Ej48LJZBu7Bjg2IfmRVMv-jHZE"


def write(path: Path, document: object) -> None:
    path.write_text(json.dumps(document), encoding="utf-8")


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_a_pin_and_a_token_round_trip_through_the_file(tmp_path: Path) -> None:
    path = tmp_path / "servers.json"
    trust.accept_fingerprint("bench.local:50051", FINGERPRINT, TOKEN, path=path)

    entry = trust.read_servers(path)["bench.local:50051"]
    assert entry.fingerprint == FINGERPRINT
    assert entry.token == TOKEN
    assert not entry.insecure
    # The document the GUI parses: one `servers` object, nothing else.
    assert read(path) == {
        "servers": {"bench.local:50051": {"fingerprint": FINGERPRINT, "token": TOKEN}}
    }


def test_an_entry_is_filed_under_the_key_the_gui_files_it_under(tmp_path: Path) -> None:
    path = tmp_path / "servers.json"
    trust.accept_fingerprint("https://Bench.Local:50051", FINGERPRINT, None, path=path)
    assert list(read(path)["servers"]) == ["bench.local:50051"]


def test_accepting_an_identity_clears_an_earlier_unprotected_choice(
    tmp_path: Path,
) -> None:
    # The server is reachable over TLS after all, so the stored "connect
    # without protection" answer is no longer the operator's decision.
    path = tmp_path / "servers.json"
    trust.accept_insecure("bench:50051", path=path)
    trust.accept_fingerprint("bench:50051", FINGERPRINT, TOKEN, path=path)

    entry = trust.read_servers(path)["bench:50051"]
    assert entry.fingerprint == FINGERPRINT
    assert not entry.insecure
    assert "insecure" not in read(path)["servers"]["bench:50051"]


def test_accepting_an_unprotected_connection_drops_any_pin_and_token(
    tmp_path: Path,
) -> None:
    # ADR 0041: a credential never rides an unencrypted channel, so the
    # token cannot be left behind for the plaintext path to pick up.
    path = tmp_path / "servers.json"
    trust.accept_fingerprint("bench:50051", FINGERPRINT, TOKEN, path=path)
    trust.accept_insecure("bench:50051", path=path)

    entry = trust.read_servers(path)["bench:50051"]
    assert entry.insecure
    assert entry.fingerprint is None
    assert entry.token is None
    assert read(path)["servers"]["bench:50051"] == {"insecure": True}


def test_what_the_gui_wrote_survives_a_write_here(tmp_path: Path) -> None:
    # The GUI owns the schema and may grow fields. Dropping one we do
    # not understand would silently undo a GUI release's work, so a
    # write preserves every key on every entry — the one being edited
    # included — and anything at the top level beside `servers`.
    path = tmp_path / "servers.json"
    write(
        path,
        {
            "version": 7,
            "servers": {
                "bench:50051": {"manual": True, "nickname": "the bench rig"},
                "rig-2:50051": {"fingerprint": OTHER_FINGERPRINT, "colour": "red"},
            },
        },
    )

    trust.accept_fingerprint("bench:50051", FINGERPRINT, TOKEN, path=path)

    assert read(path) == {
        "version": 7,
        "servers": {
            "bench:50051": {
                "manual": True,
                "nickname": "the bench rig",
                "fingerprint": FINGERPRINT,
                "token": TOKEN,
            },
            "rig-2:50051": {"fingerprint": OTHER_FINGERPRINT, "colour": "red"},
        },
    }


def test_forgetting_removes_one_entry_and_leaves_the_rest_alone(
    tmp_path: Path,
) -> None:
    path = tmp_path / "servers.json"
    trust.accept_fingerprint("bench:50051", FINGERPRINT, TOKEN, path=path)
    trust.accept_fingerprint("rig-2:50051", OTHER_FINGERPRINT, None, path=path)

    assert trust.forget("bench:50051", path=path) is True

    assert list(read(path)["servers"]) == ["rig-2:50051"]
    # No husk: the next connection to it is back at first contact.
    assert "bench:50051" not in trust.read_servers(path)


def test_forgetting_something_nobody_accepted_says_so_rather_than_writing(
    tmp_path: Path,
) -> None:
    path = tmp_path / "servers.json"
    assert trust.forget("bench:50051", path=path) is False
    assert not path.exists()


def test_a_write_leaves_no_temporary_file_behind(tmp_path: Path) -> None:
    # Temp-file + rename, so a crash mid-write cannot leave a file that
    # parses as "nothing is trusted" and silently re-prompts.
    path = tmp_path / "servers.json"
    trust.accept_fingerprint("bench:50051", FINGERPRINT, TOKEN, path=path)
    assert [p.name for p in tmp_path.iterdir()] == ["servers.json"]


def test_the_directory_is_created_when_it_is_not_there_yet(tmp_path: Path) -> None:
    # First contact on a machine that has never run the GUI.
    path = tmp_path / "dev.cannet.app" / "servers.json"
    trust.accept_insecure("old-rig:50051", path=path)
    assert trust.read_servers(path)["old-rig:50051"].insecure


def test_a_name_finds_the_one_entry_stored_for_it(tmp_path: Path) -> None:
    path = tmp_path / "servers.json"
    trust.accept_fingerprint("bench:50051", FINGERPRINT, None, path=path)
    servers = trust.read_servers(path)
    assert trust.match_key("bench", servers) == "bench:50051"
    assert trust.match_key("BENCH:50051", servers) == "bench:50051"
    assert trust.match_key("rig-2", servers) is None
