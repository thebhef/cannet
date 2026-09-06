"""``ServerInfo``: what this sidecar is, asked before anything else.

One unary RPC in the unversioned ``cannet`` package (ADR 0059). It
states the protocol packages this sidecar serves — today exactly
:data:`cannet_python_wire.PROTOCOL_PACKAGE` — so a client speaking a
different major is told so in a sentence rather than discovering it
as an ``UNIMPLEMENTED`` on its first real call.

The sidecar binds loopback and carries no bearer token of its own, so
"unauthenticated" costs nothing here; the point of the rule lives on
``cannet-server``, which gates every other RPC and deliberately not
this one.
"""

from __future__ import annotations

import logging

import grpc

from cannet_python_wire import PROTOCOL_PACKAGE
from cannet_python_wire._proto import cannet_info_pb2 as info_pb
from cannet_python_wire._proto import cannet_info_pb2_grpc as info_pb_grpc

from .. import __version__

_log = logging.getLogger(__name__)


class ServerInfoService(info_pb_grpc.CannetInfoServicer):
    """Answers with the packages served, the build version, the name.

    ``instance_name`` is empty by default: the sidecar is a loopback
    child of whoever launched it and advertises nothing, so it answers
    to no name of its own.
    """

    def __init__(self, *, instance_name: str = "") -> None:
        self._instance_name = instance_name

    def ServerInfo(  # noqa: N802 — the gRPC method name is the wire's
        self, request: info_pb.ServerInfoRequest, context: grpc.ServicerContext
    ) -> info_pb.ServerInfoResponse:
        _log.debug("ServerInfo -> %s", PROTOCOL_PACKAGE)
        return info_pb.ServerInfoResponse(
            packages=[PROTOCOL_PACKAGE],
            version=__version__,
            instance_name=self._instance_name,
        )
