"""``ServerInfo`` on the sidecar (ADR 0059).

Every cannet client asks which protocol packages a server serves before
it makes its first real call, so a sidecar that does not answer is one
nothing can connect to. These tests drive the RPC over a real loopback
channel, which is the only way to prove the servicer is actually
registered on the server :func:`serve` builds.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


import grpc  # noqa: E402

from cannet_python_can import __version__  # noqa: E402
from cannet_python_can import server as srv  # noqa: E402
from cannet_python_wire._proto import cannet_info_pb2 as info_pb  # noqa: E402
from cannet_python_wire._proto import cannet_info_pb2_grpc as info_grpc  # noqa: E402
from cannet_python_can.driver import Channel, Driver  # noqa: E402


class _NoChannels(Driver):
    """The driver surface with no hardware behind it.

    `ServerInfo` has nothing to do with interfaces, which is the point:
    it has to answer on a sidecar that enumerated nothing at all.
    """

    def list_channels(self) -> list[Channel]:
        return []

    def open_channel(self, channel_id, config):  # type: ignore[no-untyped-def]
        raise NotImplementedError


@pytest.fixture
def running_sidecar():
    server, bound = srv.serve("127.0.0.1:0", driver=_NoChannels())
    try:
        yield bound
    finally:
        server.stop(grace=0)


def test_server_info_answers_with_the_package_this_build_serves(
    running_sidecar: str,
) -> None:
    with grpc.insecure_channel(running_sidecar) as channel:
        answer = info_grpc.CannetInfoStub(channel).ServerInfo(
            info_pb.ServerInfoRequest()
        )
    assert list(answer.packages) == ["cannet.v1"]
    assert answer.version == __version__
    # The sidecar is a loopback child and advertises nothing, so it
    # answers to no name of its own. Absent, never a placeholder.
    assert answer.instance_name == ""


def test_the_served_package_is_the_proto_package_the_stubs_came_from() -> None:
    # The two have to be the same string, and nothing else checks it:
    # a regenerated `cannet.proto` under a new package would otherwise
    # leave this sidecar advertising a major it no longer speaks.
    from cannet_python_wire import PROTOCOL_PACKAGE
    from cannet_python_wire._proto import cannet_pb2

    assert cannet_pb2.DESCRIPTOR.package == PROTOCOL_PACKAGE, (
        "the package the stubs were generated from is the one to advertise"
    )


def test_server_info_is_answered_with_no_credential(running_sidecar: str) -> None:
    # The sidecar gates nothing, but the RPC is defined as
    # unauthenticated on every cannet server (ADR 0059) and a client
    # presenting a stale credential must still get the answer.
    metadata = (("authorization", "Bearer not-a-token-anyone-minted"),)
    with grpc.insecure_channel(running_sidecar) as channel:
        answer = info_grpc.CannetInfoStub(channel).ServerInfo(
            info_pb.ServerInfoRequest(), metadata=metadata
        )
    assert list(answer.packages) == ["cannet.v1"]
