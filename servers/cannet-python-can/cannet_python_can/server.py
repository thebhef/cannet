"""gRPC service implementation: wire-protocol surface on top of the
internal :mod:`cannet_python_can.driver` adapter.

The service is a faithful Python port of `cannet-server`'s replay
service, scoped to live hardware: ``ListInterfaces`` enumerates the
driver's channels, ``Session`` opens a bidirectional stream that
- subscribes channels on demand,
- streams ``FrameBatch`` envelopes per channel,
- accepts client-originated ``FrameBatch`` envelopes as transmits,
- reports ``Error`` for unknown / unsubscribed channels and
  ``Error.CODE_TX_REJECTED`` for a rejected transmit,
- emits ``LogMessage`` envelopes for vendor-level info / warn / error
  events tagged with ``sidecar:python-can``.

The implementation is deliberately small; one Subscribe spawns one
worker thread that pulls frames out of the driver and drops them onto
the response stream as size-1 batches. Phase-8's perf envelope is
"one device per channel, vendor SDK is the bottleneck", so we are
not trying to be clever with batching yet.
"""

from __future__ import annotations

import importlib
import logging
import os
import queue
import threading
import time
from typing import Iterator, Optional

import grpc

from . import driver as drv
from ._proto import cannet_pb2 as pb
from ._proto import cannet_pb2_grpc as pb_grpc

_log = logging.getLogger(__name__)

#: The sidecar wire log tag. The GUI host watches for this exact prefix
#: when bridging incoming ``LogMessage`` envelopes into the System
#: Messages panel.
WIRE_SOURCE = "sidecar:python-can"

#: Environment variable that lets the user pick an alternative driver
#: module (must expose a top-level ``Driver()`` callable returning a
#: :class:`cannet_python_can.driver.Driver`-shaped object).
DRIVER_MODULE_ENV = "CANNET_DRIVER_MODULE"
DEFAULT_DRIVER_MODULE = "cannet_python_can.driver_python_can"


def load_driver() -> drv.Driver:
    """Resolve the active driver module and instantiate it.

    Falls back to the python-can-backed default. Looks for a top-level
    callable named ``Driver`` (or its lower-case ``driver``); a module
    that exposes the protocol directly works too.
    """
    name = os.environ.get(DRIVER_MODULE_ENV, DEFAULT_DRIVER_MODULE)
    mod = importlib.import_module(name)
    factory = (
        getattr(mod, "Driver", None)
        or getattr(mod, "PythonCanDriver", None)
        or getattr(mod, "driver", None)
    )
    if factory is None:
        raise RuntimeError(
            f"driver module {name!r} exposes no Driver/PythonCanDriver/driver"
        )
    return factory()


def _now_ns() -> int:
    return time.monotonic_ns()


def _frame_to_proto(frame: drv.Frame) -> pb.Frame:
    kind = pb.FRAME_KIND_CLASSIC
    if frame.is_error:
        kind = pb.FRAME_KIND_ERROR
    elif frame.is_remote:
        kind = pb.FRAME_KIND_REMOTE
    elif frame.fd:
        kind = pb.FRAME_KIND_FD
    return pb.Frame(
        timestamp_ns=frame.timestamp_ns,
        can_id=frame.can_id,
        extended=frame.extended,
        direction=pb.DIRECTION_RX if frame.is_rx else pb.DIRECTION_TX,
        kind=kind,
        data=frame.data,
        brs=frame.brs,
        esi=frame.esi,
        dlc=frame.dlc,
    )


def _proto_to_frame(p: pb.Frame) -> drv.Frame:
    return drv.Frame(
        timestamp_ns=p.timestamp_ns or _now_ns(),
        can_id=p.can_id,
        extended=p.extended,
        is_rx=p.direction == pb.DIRECTION_RX,
        data=bytes(p.data),
        fd=p.kind == pb.FRAME_KIND_FD,
        brs=p.brs,
        esi=p.esi,
        is_remote=p.kind == pb.FRAME_KIND_REMOTE,
        is_error=p.kind == pb.FRAME_KIND_ERROR,
        dlc=p.dlc,
    )


def _log_envelope(level: "pb.LogLevel.V", message: str) -> pb.Envelope:
    return pb.Envelope(
        log=pb.LogMessage(
            timestamp_ns=_now_ns(),
            level=level,
            source=WIRE_SOURCE,
            message=message,
        )
    )


def _error_envelope(code: "pb.Error.Code.V", message: str) -> pb.Envelope:
    return pb.Envelope(error=pb.Error(code=code, message=message))


class _Subscription:
    """Per-(session, interface) state: an open channel + a pump thread."""

    def __init__(
        self,
        *,
        channel: drv.OpenChannel,
        outbox: "queue.Queue[pb.Envelope]",
    ) -> None:
        self.channel = channel
        self._outbox = outbox
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._pump, name=f"rx-{channel.channel_id}", daemon=True
        )
        self._thread.start()

    def _pump(self) -> None:
        cid = self.channel.channel_id
        try:
            while not self._stop.is_set():
                frame = self.channel.recv(timeout_s=0.25)
                if frame is None:
                    continue
                batch = pb.FrameBatch(interface_id=cid, frames=[_frame_to_proto(frame)])
                self._outbox.put(pb.Envelope(frame_batch=batch))
        except Exception as e:  # noqa: BLE001 - the wire layer reports it.
            _log.warning("rx pump for %s failed: %s", cid, e)
            self._outbox.put(
                _log_envelope(pb.LOG_LEVEL_ERROR, f"rx pump for {cid} failed: {e}")
            )
        finally:
            try:
                self.channel.close()
            except Exception:  # noqa: BLE001 - best-effort
                pass

    def stop(self) -> None:
        self._stop.set()


class CannetServerService(pb_grpc.CannetServerServicer):
    """Service entry points called by the gRPC framework."""

    def __init__(self, driver: drv.Driver) -> None:
        self._driver = driver

    # ----- ListInterfaces ---------------------------------------------------

    def ListInterfaces(
        self, request: pb.ListInterfacesRequest, context: grpc.ServicerContext
    ) -> pb.InterfaceList:
        channels = list(self._driver.list_channels())
        ifaces = [
            pb.Interface(
                id=c.id, display_name=c.display_name, fd_capable=c.fd_capable
            )
            for c in channels
        ]
        _log.info("ListInterfaces -> %d channels", len(ifaces))
        return pb.InterfaceList(interfaces=ifaces)

    # ----- Session ----------------------------------------------------------

    def Session(
        self,
        request_iterator: Iterator[pb.Envelope],
        context: grpc.ServicerContext,
    ) -> Iterator[pb.Envelope]:
        """Bidirectional stream. See `cannet.proto`'s `Session` rpc."""

        outbox: "queue.Queue[Optional[pb.Envelope]]" = queue.Queue()
        subscriptions: dict[str, _Subscription] = {}

        def cleanup() -> None:
            for sub in subscriptions.values():
                sub.stop()
            subscriptions.clear()
            outbox.put(None)

        def request_pump() -> None:
            try:
                # Greeting log: lets the host show a "sidecar:python-can
                # connected" message in System Messages without a side
                # channel.
                outbox.put(
                    _log_envelope(
                        pb.LOG_LEVEL_INFO, "session opened by cannet-python-can"
                    )
                )
                for env in request_iterator:
                    body = env.WhichOneof("body")
                    if body == "subscribe":
                        self._handle_subscribe(env.subscribe, subscriptions, outbox)
                    elif body == "unsubscribe":
                        self._handle_unsubscribe(env.unsubscribe, subscriptions, outbox)
                    elif body == "frame_batch":
                        self._handle_tx(env.frame_batch, subscriptions, outbox)
                    elif body == "error":
                        _log.info("client error envelope: %s", env.error.message)
                    elif body == "log":
                        _log.info("client log envelope: %s", env.log.message)
            except grpc.RpcError as e:  # noqa: PERF203 - one-off
                _log.info("session ended: %s", e)
            except Exception as e:  # noqa: BLE001
                _log.exception("session pump crashed")
                outbox.put(
                    _log_envelope(pb.LOG_LEVEL_ERROR, f"session pump crashed: {e}")
                )
            finally:
                cleanup()

        threading.Thread(target=request_pump, name="session-req", daemon=True).start()

        while True:
            env = outbox.get()
            if env is None:
                return
            yield env

    def _handle_subscribe(
        self,
        sub: pb.Subscribe,
        subscriptions: dict[str, _Subscription],
        outbox: "queue.Queue[Optional[pb.Envelope]]",
    ) -> None:
        cid = sub.interface_id
        if cid in subscriptions:
            return  # idempotent
        try:
            channel = self._driver.open(cid, drv.OpenConfig())
        except KeyError:
            outbox.put(
                _error_envelope(
                    pb.Error.CODE_UNKNOWN_INTERFACE, f"unknown interface {cid}"
                )
            )
            return
        except OSError as e:
            outbox.put(
                _log_envelope(pb.LOG_LEVEL_ERROR, f"open {cid} failed: {e}")
            )
            outbox.put(
                _error_envelope(
                    pb.Error.CODE_UNKNOWN_INTERFACE, f"open {cid} failed: {e}"
                )
            )
            return
        subscriptions[cid] = _Subscription(channel=channel, outbox=outbox)  # type: ignore[arg-type]

    def _handle_unsubscribe(
        self,
        unsub: pb.Unsubscribe,
        subscriptions: dict[str, _Subscription],
        outbox: "queue.Queue[Optional[pb.Envelope]]",
    ) -> None:
        sub = subscriptions.pop(unsub.interface_id, None)
        if sub is not None:
            sub.stop()

    def _handle_tx(
        self,
        batch: pb.FrameBatch,
        subscriptions: dict[str, _Subscription],
        outbox: "queue.Queue[Optional[pb.Envelope]]",
    ) -> None:
        sub = subscriptions.get(batch.interface_id)
        if sub is None:
            outbox.put(
                _error_envelope(
                    pb.Error.CODE_NOT_SUBSCRIBED,
                    f"transmit on unsubscribed {batch.interface_id}",
                )
            )
            return
        for proto_frame in batch.frames:
            frame = _proto_to_frame(proto_frame)
            try:
                sub.channel.send(frame)
            except drv.TxRejected as e:
                outbox.put(
                    _error_envelope(pb.Error.CODE_TX_REJECTED, str(e))
                )


def serve(address: str, *, driver: Optional[drv.Driver] = None) -> grpc.Server:
    """Build and start a gRPC server bound to ``address``.

    Returns the running ``grpc.Server`` so the caller can ``wait_for_termination``
    or trigger a graceful ``stop``.
    """
    server = grpc.server(_thread_pool())
    pb_grpc.add_CannetServerServicer_to_server(
        CannetServerService(driver or load_driver()), server
    )
    server.add_insecure_port(address)
    server.start()
    return server


def _thread_pool():
    # Late import: the sidecar must start even on a Python without
    # `concurrent.futures` lazy-loading quirks.
    from concurrent import futures

    return futures.ThreadPoolExecutor(max_workers=16)


__all__ = [
    "CannetServerService",
    "DEFAULT_DRIVER_MODULE",
    "DRIVER_MODULE_ENV",
    "WIRE_SOURCE",
    "load_driver",
    "serve",
]
