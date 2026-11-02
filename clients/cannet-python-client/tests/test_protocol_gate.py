"""The protocol-major gate (ADR 0059).

Every connection this client makes asks `ServerInfo` first and refuses
a server whose package list does not hold ours, before the `Session`
stream is opened and before any credential goes out.

The in-process fake here serves the real `cannet.v1` service while its
`ServerInfo` claims `cannet.v2` and nothing else — the shape of the
future this rule exists for. It binds explicit loopback and advertises
nothing.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Iterator
from concurrent import futures

import grpc
import pytest
from cannet_python_wire import PROTOCOL_PACKAGE
from cannet_python_wire._proto import cannet_info_pb2 as info_pb
from cannet_python_wire._proto import cannet_info_pb2_grpc as info_grpc
from cannet_python_wire._proto import cannet_pb2_grpc as pb_grpc

from cannet_python_client import IncompatibleProtocol, Session, server_info
from cannet_python_client.session import list_interfaces
from cannet_python_client.trust import ServerTarget


class _FakeInfo(info_grpc.CannetInfoServicer):
    """Answers with whatever package list it was built with — the only
    way to stand up a server from a major this repository does not
    implement."""

    def __init__(self, packages: list[str]) -> None:
        self._packages = packages

    def ServerInfo(
        self, request: info_pb.ServerInfoRequest, context: grpc.ServicerContext
    ) -> info_pb.ServerInfoResponse:
        return info_pb.ServerInfoResponse(
            packages=self._packages, version="v9.9.9", instance_name="future"
        )


@contextlib.contextmanager
def fake_server(packages: list[str] | None) -> Iterator[str]:
    """A server carrying the real `cannet.v1` service, and a `ServerInfo`
    that claims `packages` — or none at all when `packages` is `None`,
    which is what a peer built before the rule looks like."""
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=2))
    # The `CannetServer` service is registered but never implemented:
    # the refusal has to come from `ServerInfo`, not from the session
    # RPC being absent.
    pb_grpc.add_CannetServerServicer_to_server(pb_grpc.CannetServerServicer(), server)
    if packages is not None:
        info_grpc.add_CannetInfoServicer_to_server(_FakeInfo(packages), server)
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    try:
        yield f"127.0.0.1:{port}"
    finally:
        server.stop(grace=0)


def target(address: str) -> ServerTarget:
    return ServerTarget(address=address)


def test_a_server_serving_another_major_is_refused_with_both_sides_named() -> None:
    with (
        fake_server(["cannet.v2"]) as address,
        pytest.raises(IncompatibleProtocol) as caught,
    ):
        Session(target(address), "virtual:bus0", timeout=5.0)
    assert caught.value.served == ["cannet.v2"]
    # The same sentence the Rust client, the GUI and the CLI show.
    assert str(caught.value) == "serves cannet.v2; this client speaks cannet.v1"


def test_a_server_that_cannot_be_asked_at_all_is_refused_too() -> None:
    # `ServerInfo` itself is UNIMPLEMENTED: a peer that predates the
    # rule, so nothing it answers can be read as agreement about the
    # wire.
    with (
        fake_server(None) as address,
        pytest.raises(IncompatibleProtocol) as caught,
    ):
        Session(target(address), "virtual:bus0", timeout=5.0)
    assert caught.value.served == []
    assert str(caught.value).endswith(f"this client speaks {PROTOCOL_PACKAGE}")


SECRET = "secret-words-never-logged"


def test_a_failed_attempt_leaves_breadcrumbs_and_never_the_token(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with (
        caplog.at_level(logging.DEBUG, logger="cannet_python_client.session"),
        fake_server(None) as address,
        pytest.raises(IncompatibleProtocol),
    ):
        list_interfaces(ServerTarget(address=address, token=SECRET), timeout=5.0)
    assert f"{address}: connecting (plaintext)" in caplog.text
    assert f"{address}: failed to connect" in caplog.text
    assert SECRET not in caplog.text


def test_a_refused_rpc_after_connecting_is_logged_too(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # `ListInterfaces` is registered but not implemented, so the server
    # answers `ServerInfo` and then fails the call that follows.
    with (
        caplog.at_level(logging.DEBUG, logger="cannet_python_client.session"),
        fake_server(["cannet.v1"]) as address,
        pytest.raises(grpc.RpcError),
    ):
        list_interfaces(ServerTarget(address=address, token=SECRET), timeout=5.0)
    assert f"{address}: connected (plaintext)" in caplog.text
    assert f"{address}: ListInterfaces failed: UNIMPLEMENTED" in caplog.text
    assert SECRET not in caplog.text


def test_a_target_never_prints_its_token() -> None:
    assert SECRET not in repr(ServerTarget(address="bench:50051", token=SECRET))


def test_a_server_serving_our_major_among_others_is_accepted(
    vbus_server: str,
) -> None:
    # The deprecation window the rule promises. A real `debug vbus`
    # server is used because the gate has to *pass* here and then the
    # session has to come up.
    session = Session(target(vbus_server), "virtual:bus0", timeout=15.0)
    try:
        assert session.allocated_id is not None
    finally:
        session.close()


def test_server_info_reports_what_the_server_says_about_itself(
    vbus_server: str,
) -> None:
    # The same answer the CLI's protocol column is built from.
    channel = grpc.insecure_channel(vbus_server)
    try:
        answer = server_info(channel, target(vbus_server), 15.0)
    finally:
        channel.close()
    assert PROTOCOL_PACKAGE in list(answer.packages)
    assert answer.version != ""
