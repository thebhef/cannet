"""``can.detect_available_configs()`` against the trust store.

Detection dials every server the trust store names and asks
`ListInterfaces`; a server that never answers must contribute nothing
rather than fail the whole scan.
"""

from __future__ import annotations

import json
from pathlib import Path

import can
import pytest

from cannet_python_client import trust
from cannet_python_client.bus import _detect_configs


def test_reachable_servers_each_contribute_their_interfaces(
    vbus_server: str, replay_server: str
) -> None:
    servers = {
        vbus_server: trust.TrustEntry(),
        replay_server: trust.TrustEntry(),
    }
    configs = _detect_configs(servers, timeout=5.0)
    by_server: dict[str, set[str]] = {}
    for config in configs:
        assert config["interface"] == "cannet"
        by_server.setdefault(config["server"], set()).add(config["channel"])
    assert by_server[vbus_server] == {"virtual:bus0"}
    assert "blf:0" in by_server[replay_server]


def test_an_unreachable_server_contributes_nothing() -> None:
    # Nothing is listening on this loopback port.
    configs = _detect_configs({"127.0.0.1:1": trust.TrustEntry()}, timeout=0.5)
    assert configs == []


def test_one_unreachable_server_does_not_stop_the_scan_of_the_rest(
    vbus_server: str,
) -> None:
    servers = {
        "127.0.0.1:1": trust.TrustEntry(),
        vbus_server: trust.TrustEntry(),
    }
    configs = _detect_configs(servers, timeout=1.0)
    assert {c["channel"] for c in configs} == {"virtual:bus0"}


def test_a_server_nothing_is_stored_for_is_treated_as_unreachable() -> None:
    # `resolve` raises `ServerNotTrusted` for a non-loopback address
    # with no entry; detection is not the place that decides trust, so
    # it just moves on like any other failure to reach the server.
    configs = _detect_configs(
        {"stranger.invalid:50051": trust.TrustEntry()}, timeout=0.5
    )
    assert configs == []


def test_can_detect_available_configs_finds_the_cannet_interface(
    vbus_server: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The end-to-end path: a real `servers.json` on disk, found through
    # `can.detect_available_configs()` the way an application would
    # call it — no cannet-specific import beyond selecting the plugin.
    # `config_dir` is monkeypatched directly rather than the platform
    # env var it reads, so this runs the same on every OS.
    config_dir = tmp_path / trust.APP_IDENTIFIER
    config_dir.mkdir()
    monkeypatch.setattr(trust, "config_dir", lambda: config_dir)
    (config_dir / trust.SERVERS_FILE).write_text(
        json.dumps({"servers": {vbus_server: {"manual": True}}})
    )

    configs = can.detect_available_configs(interfaces="cannet", timeout=5.0)

    assert any(
        c["interface"] == "cannet" and c["channel"] == "virtual:bus0" for c in configs
    )
