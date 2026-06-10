"""Bind / random-port-retry tests for the sidecar.

These exercise the behaviour the GUI host relies on: a default sidecar
launch must always come up bound to *some* port, even when the
requested port is already taken — so the "random port selection on
start" backlog item is met without the host needing to retry.
"""

from __future__ import annotations

import socket
import sys
from pathlib import Path

import pytest


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


from cannet_python_can import server as srv  # noqa: E402


def _make_grpc_server():
    import grpc
    from concurrent import futures

    return grpc.server(futures.ThreadPoolExecutor(max_workers=1))


def test_split_address_parses_host_port() -> None:
    assert srv._split_address("127.0.0.1:50061") == ("127.0.0.1", 50061)


def test_split_address_treats_missing_port_as_zero() -> None:
    assert srv._split_address("127.0.0.1") == ("127.0.0.1", 0)
    assert srv._split_address("127.0.0.1:") == ("127.0.0.1", 0)


def test_split_address_handles_bracketed_ipv6() -> None:
    assert srv._split_address("[::1]:50061") == ("[::1]", 50061)
    assert srv._split_address("[::1]") == ("[::1]", 0)


def test_bind_with_retry_returns_actual_port_when_requesting_zero() -> None:
    server = _make_grpc_server()
    bound = srv.bind_with_retry(server, "127.0.0.1:0")
    host, port = srv._split_address(bound)
    assert host == "127.0.0.1"
    assert port != 0


def test_bind_with_retry_falls_back_when_pinned_port_is_taken() -> None:
    """Hold a socket on a port, then ask the sidecar to bind there.

    The bind must succeed on a different port rather than raising, so a
    user with `lsof`-style port collisions still gets a working sidecar.
    """
    holder = socket.socket()
    try:
        holder.bind(("127.0.0.1", 0))
        taken_port = holder.getsockname()[1]
        server = _make_grpc_server()
        bound = srv.bind_with_retry(
            server, f"127.0.0.1:{taken_port}", fallback_attempts=3
        )
        host, port = srv._split_address(bound)
        assert host == "127.0.0.1"
        assert port != 0
        assert port != taken_port
    finally:
        holder.close()


def test_serve_returns_running_server_and_bound_address() -> None:
    class EmptyDriver:
        def list_channels(self):
            return []

        def open(self, channel_id, config):
            raise KeyError(channel_id)

    server, address = srv.serve("127.0.0.1:0", driver=EmptyDriver())  # type: ignore[arg-type]
    try:
        host, port = srv._split_address(address)
        assert host == "127.0.0.1"
        assert port != 0
    finally:
        server.stop(grace=None)


def test_serve_recovers_from_pinned_port_collision() -> None:
    """End-to-end check that `serve()` ships the fallback path.

    Belt-and-braces against a future refactor accidentally bypassing
    `bind_with_retry` from the public entry point.
    """

    class EmptyDriver:
        def list_channels(self):
            return []

        def open(self, channel_id, config):
            raise KeyError(channel_id)

    holder = socket.socket()
    try:
        holder.bind(("127.0.0.1", 0))
        taken_port = holder.getsockname()[1]
        server, address = srv.serve(
            f"127.0.0.1:{taken_port}",
            driver=EmptyDriver(),  # type: ignore[arg-type]
        )
        try:
            host, port = srv._split_address(address)
            assert host == "127.0.0.1"
            assert port != 0
            assert port != taken_port
        finally:
            server.stop(grace=None)
    finally:
        holder.close()


def test_bind_with_retry_raises_when_all_attempts_fail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If even ``host:0`` keeps failing, the function gives up loudly.

    Simulates the exhaustion case with a stub server that always raises.
    """

    class _AlwaysFailServer:
        def add_insecure_port(self, address: str) -> int:
            raise RuntimeError(f"simulated bind failure on {address}")

    with pytest.raises(OSError, match="failed to bind sidecar"):
        srv.bind_with_retry(
            _AlwaysFailServer(),  # type: ignore[arg-type]
            "127.0.0.1:0",
            fallback_attempts=2,
        )
