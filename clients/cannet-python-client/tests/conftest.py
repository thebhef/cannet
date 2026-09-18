"""Hardware-free server fixtures.

Every integration test in this suite runs against a `cannet-server`
debug mode on explicit loopback — `debug vbus` for the multi-client
virtual bus and `debug replay` for a recorded capture. Neither
terminates TLS and neither touches hardware, so the whole suite is
reproducible on a machine with no CAN adapter attached.

The binary is a Rust build artifact, so it is not there in a
Python-only checkout; the fixtures skip rather than fail when it is
missing, which keeps the units (the trust store, the fingerprint form,
the envelope order) running everywhere.
"""

from __future__ import annotations

import contextlib
import shutil
import socket
import subprocess
import time
from collections.abc import Iterator, Sequence
from pathlib import Path

import grpc
import pytest
from cannet_python_wire import PROTOCOL_PACKAGE
from cannet_python_wire._proto import cannet_info_pb2 as info_pb
from cannet_python_wire._proto import cannet_info_pb2_grpc as info_grpc

REPO_ROOT = Path(__file__).resolve().parents[3]

#: The capture `debug replay` is pointed at.
DEMO_BLF = REPO_ROOT / "examples" / "cannet-demo.blf"

#: How long a freshly spawned server gets to accept a connection.
STARTUP_TIMEOUT_S = 30.0


class FakeServerInfo(info_grpc.CannetInfoServicer):
    """``ServerInfo`` answering with whatever package list it was built
    with — the only way to stand up a server from a protocol major this
    repository does not implement (ADR 0059)."""

    def __init__(self, packages: Sequence[str] = (PROTOCOL_PACKAGE,)) -> None:
        self._packages = list(packages)

    def ServerInfo(  # noqa: N802 — the gRPC method name is the wire's
        self, request: info_pb.ServerInfoRequest, context: grpc.ServicerContext
    ) -> info_pb.ServerInfoResponse:
        return info_pb.ServerInfoResponse(
            packages=self._packages, version="v0.0.0-test", instance_name="fake"
        )


def add_server_info(
    server: grpc.Server, packages: Sequence[str] = (PROTOCOL_PACKAGE,)
) -> None:
    """Mount ``ServerInfo`` on an in-process fake.

    Every connection this client makes asks it first (ADR 0059), so a
    fake without it is one nothing here can reach — it fails with
    ``UNIMPLEMENTED`` before the test's own subject is exercised.
    """
    info_grpc.add_CannetInfoServicer_to_server(FakeServerInfo(packages), server)


def server_binary() -> Path | None:
    """The `cannet-server` build artifact, debug preferred.

    Only these canonical paths are ever run: a copy of the binary
    elsewhere is a different executable as far as a host firewall is
    concerned, and would sit on a prompt nobody is there to answer.
    """
    for profile in ("debug", "release"):
        for name in ("cannet-server", "cannet-server.exe"):
            candidate = REPO_ROOT / "target" / profile / name
            if candidate.is_file():
                return candidate
    found = shutil.which("cannet-server")
    return Path(found) if found else None


def free_loopback_port() -> int:
    """A port nothing is listening on, taken by binding and releasing.

    Loopback is explicit here and in every `--bind` below: a listening
    socket on a routable interface is what a firewall prompts about.
    """
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_until_accepting(port: int, process: subprocess.Popen) -> None:
    deadline = time.monotonic() + STARTUP_TIMEOUT_S
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                f"cannet-server exited with {process.returncode} before listening"
            )
        with contextlib.closing(
            socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        ) as probe:
            probe.settimeout(0.25)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.05)
    raise TimeoutError(f"cannet-server did not accept on 127.0.0.1:{port}")


@contextlib.contextmanager
def spawn_server(*args: str) -> Iterator[str]:
    """Run `cannet-server <args> --bind 127.0.0.1:<free port>` and yield
    the address, tearing the process down afterwards."""
    binary = server_binary()
    if binary is None:
        pytest.skip("cannet-server is not built (cargo build -p cannet-server)")
    port = free_loopback_port()
    address = f"127.0.0.1:{port}"
    process = subprocess.Popen(
        [str(binary), *args, "--bind", address],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_until_accepting(port, process)
        yield address
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:  # pragma: no cover - a wedged server
            process.kill()
            process.wait(timeout=10)


@pytest.fixture(scope="module")
def vbus_server() -> Iterator[str]:
    """`cannet-server debug vbus`: one factory interface, `virtual:bus0`."""
    with spawn_server("debug", "vbus") as address:
        yield address


@pytest.fixture(scope="module")
def replay_server() -> Iterator[str]:
    """`cannet-server debug replay`: the demo capture on a loop, streamed
    as fast as the consumer drains (the default `--rate 0`)."""
    if not DEMO_BLF.is_file():
        pytest.skip(f"{DEMO_BLF} is missing")
    with spawn_server("debug", "replay", str(DEMO_BLF)) as address:
        yield address
