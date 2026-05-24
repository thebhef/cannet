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


def serve(
    address: str,
    *,
    driver: Optional[drv.Driver] = None,
    fallback_attempts: int = 3,
) -> tuple[grpc.Server, str]:
    """Build and start a gRPC server bound near ``address``.

    ``address`` is ``host:port``; ``port == 0`` asks the OS for any free
    ephemeral port (the supported "random port" path — collisions are
    impossible because the kernel only returns unused ports). A non-zero
    port is honoured first; if its bind raises, the function logs a
    warning and falls back to ``host:0`` for up to ``fallback_attempts``
    tries before giving up.

    Returns ``(server, bound_address)`` where ``bound_address`` is the
    actually-bound ``host:port`` string. The host writes it onto the
    sidecar's banner so the GUI host learns the port without a side
    channel.
    """
    server = grpc.server(_thread_pool())
    pb_grpc.add_CannetServerServicer_to_server(
        CannetServerService(driver or load_driver()), server
    )
    bound = bind_with_retry(server, address, fallback_attempts=fallback_attempts)
    server.start()
    return server, bound


def bind_with_retry(
    server: grpc.Server, address: str, *, fallback_attempts: int = 3
) -> str:
    """Add an insecure port to ``server``, falling back to ``host:0``.

    Returns the actually-bound ``host:port`` string. Raises
    :class:`OSError` if every attempt fails (which only happens when the
    OS is out of ephemeral ports — the ``:0`` fallback otherwise always
    succeeds).
    """
    host, requested_port = _split_address(address)
    if requested_port != 0:
        try:
            bound_port = server.add_insecure_port(f"{host}:{requested_port}")
        except RuntimeError as e:
            _log.warning(
                "bind to requested port %d failed (%s); falling back to a random port",
                requested_port,
                e,
            )
        else:
            if bound_port != 0:
                return f"{host}:{bound_port}"
    for attempt in range(1, fallback_attempts + 1):
        try:
            bound_port = server.add_insecure_port(f"{host}:0")
        except RuntimeError as e:
            _log.warning("random-port bind attempt %d failed: %s", attempt, e)
            continue
        if bound_port != 0:
            return f"{host}:{bound_port}"
    raise OSError(
        f"failed to bind sidecar near {address!r} after "
        f"{fallback_attempts} random-port fallback attempts"
    )


def _split_address(address: str) -> tuple[str, int]:
    """Parse ``host:port`` into ``(host, port)``; ``port`` defaults to 0.

    Liberal on input: ``"127.0.0.1"`` (no colon) is read as port 0, and
    a non-numeric port string raises :class:`ValueError`. IPv6 literals
    must be bracketed (``"[::1]:50061"``) per the standard.
    """
    if address.startswith("["):
        end = address.rfind("]")
        if end < 0:
            raise ValueError(f"unterminated IPv6 literal: {address!r}")
        host = address[: end + 1]
        rest = address[end + 1 :]
    else:
        last = address.rfind(":")
        if last < 0:
            return address, 0
        host = address[:last]
        rest = address[last:]
    if not rest:
        return host, 0
    if not rest.startswith(":"):
        raise ValueError(f"malformed address: {address!r}")
    port_str = rest[1:]
    if not port_str:
        return host, 0
    return host, int(port_str)


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
    "bind_with_retry",
    "load_driver",
    "serve",
]
