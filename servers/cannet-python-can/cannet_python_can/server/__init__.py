"""gRPC service implementation: hardware-server wire model (ADR 0022).

The service implements the hardware-server wire contract:

- Each physical interface is opened **once**, shared across every
  session that subscribes to it; a reference count on subscriptions
  drives start (first ``Subscribe``) and stop (last ``Unsubscribe``).
- One rx pump per shared interface fans every received ``FrameBatch``
  out to every subscribed session's outbox.
- ``Body::ConfigureBus`` updates the interface's :class:`OpenConfig`;
  if the interface is currently open the bus is closed and reopened
  with the new config. Conflict semantics across concurrent clients
  are deliberately left to whatever the underlying python-can backend
  does.
- ``Body::InterfaceState`` is pushed: a snapshot on each subscribe,
  and a fresh push whenever the controller's fault-confinement state
  or its TEC / REC counters change.
- ``LogMessage`` envelopes are emitted for vendor-level info / warn /
  error events tagged with ``sidecar:python-can``.

The rx pump's batching policy (drain up to ``_BATCH_FLUSH_NS`` /
``_BATCH_MAX_FRAMES``) is unchanged from the original per-session
pump; it just runs once per interface instead of once per
(session, interface) pair.
"""

from __future__ import annotations

import logging
import queue
import threading
from typing import Iterator, Optional

import grpc

from .. import driver as drv
from .._proto import cannet_pb2 as pb
from .._proto import cannet_pb2_grpc as pb_grpc
from .helpers import (
    DEFAULT_DRIVER_MODULE,
    DRIVER_MODULE_ENV,
    WIRE_SOURCE,
    _configure_to_open_config,
    _error_envelope,
    _log_envelope,
    _proto_to_frame,
    load_driver,
)
from .helpers import _frame_to_proto as _frame_to_proto
from .shared_interface import _BATCH_MAX_FRAMES as _BATCH_MAX_FRAMES
from .shared_interface import _InterfaceRegistry
from .shared_interface import _SharedInterface as _SharedInterface

_log = logging.getLogger(__name__)


#: How often a parked ``WatchInterfaces`` stream wakes to re-check
#: ``context.is_active()``. This is a liveness safety-net only — it does
#: **not** drive enumeration. ADR 0016 leaves the re-enumeration cadence
#: to the server "[depending on] how cheap enumeration is on this
#: backend"; on PCAN the global ``GetValue(PCAN_ATTACHED_CHANNELS)`` call
#: serialises against ``CAN_Write`` in the driver, so re-enumerating on a
#: timer stalled active transmits (~150 ms hiccups every poll). The
#: sidecar therefore enumerates only on a ``WatchInterfaces`` subscribe
#: and on an explicit ``ListInterfaces`` pull (the GUI's "Discover"
#: button), never on a timer while channels are open.
_WATCH_LIVENESS_RECHECK_S = 5.0


class CannetServerService(pb_grpc.CannetServerServicer):
    """Service entry points called by the gRPC framework."""

    def __init__(
        self,
        driver: drv.Driver,
        *,
        watch_recheck_interval_s: float = _WATCH_LIVENESS_RECHECK_S,
    ) -> None:
        self._driver = driver
        self._registry = _InterfaceRegistry(driver)
        # How often a parked watcher wakes to re-check `is_active()` — a
        # liveness safety-net, not an enumeration cadence. Tests override
        # it to keep the suite quick.
        self._watch_recheck_interval_s = watch_recheck_interval_s

    # ----- ListInterfaces ---------------------------------------------------

    def ListInterfaces(
        self, request: pb.ListInterfacesRequest, context: grpc.ServicerContext
    ) -> pb.InterfaceList:
        ifaces = self._enumerate_interfaces()
        _log.info("ListInterfaces -> %d channels", len(ifaces))
        return pb.InterfaceList(interfaces=list(ifaces))

    # ----- WatchInterfaces --------------------------------------------------

    def WatchInterfaces(
        self,
        request: pb.WatchInterfacesRequest,
        context: grpc.ServicerContext,
    ) -> Iterator[pb.InterfaceList]:
        """Long-lived subscription to the interface set. ADR 0016.

        Emits the current snapshot once, then parks until the client
        ends the call. This sidecar does **not** re-enumerate on a timer:
        on the PCAN backend that global query contends with active
        transmits (see ``_WATCH_LIVENESS_RECHECK_S``), so a hot-plug is
        not pushed through the stream — a client picks it up with an
        explicit ``ListInterfaces`` pull (the GUI's "Discover" button).
        The stream therefore yields exactly once and then waits for
        cancellation.

        The wire contract (``cannet.proto``) permits a server to push a
        fresh snapshot whenever its interface view changes; this server
        detects no changes, so it emits only the initial snapshot — a
        compliant degenerate case, not a re-publish.

        gRPC invokes the ``add_callback`` hook on client cancel /
        transport drop; it wakes the park loop so the generator returns
        promptly instead of sitting out a full recheck interval.
        """
        yield pb.InterfaceList(interfaces=self._enumerate_interfaces())
        # Wake-on-disconnect: gRPC fires this on client cancel / transport
        # drop, so the park loop below exits without waiting out the full
        # recheck interval. Registered after the first yield — that is the
        # only point where the stream can block.
        disconnected = threading.Event()
        context.add_callback(disconnected.set)
        while context.is_active():
            if disconnected.wait(timeout=self._watch_recheck_interval_s):
                return

    def _enumerate_interfaces(self) -> list[pb.Interface]:
        return [
            pb.Interface(id=c.id, display_name=c.display_name, fd_capable=c.fd_capable)
            for c in self._driver.list_channels()
        ]

    # ----- Session ----------------------------------------------------------

    def Session(
        self,
        request_iterator: Iterator[pb.Envelope],
        context: grpc.ServicerContext,
    ) -> Iterator[pb.Envelope]:
        """Bidirectional stream. See `cannet.proto`'s `Session` rpc."""

        outbox: "queue.Queue[Optional[pb.Envelope]]" = queue.Queue()
        # Per-session set of subscribed interface ids — needed to
        # 1) gate `FrameBatch` (CODE_NOT_SUBSCRIBED if absent) and
        # 2) clean up on session end.
        subscribed: set[str] = set()

        def cleanup() -> None:
            for cid in list(subscribed):
                self._registry.unsubscribe(cid, outbox)
            subscribed.clear()
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
                        self._handle_subscribe(env.subscribe, subscribed, outbox)
                    elif body == "unsubscribe":
                        self._handle_unsubscribe(env.unsubscribe, subscribed, outbox)
                    elif body == "frame_batch":
                        self._handle_tx(env.frame_batch, subscribed, outbox)
                    elif body == "configure_bus":
                        self._handle_configure(env.configure_bus, outbox)
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
        subscribed: set[str],
        outbox: "queue.Queue[Optional[pb.Envelope]]",
    ) -> None:
        cid = sub.interface_id
        if cid in subscribed:
            return  # idempotent within a session
        try:
            self._registry.subscribe(cid, outbox)
        except KeyError:
            outbox.put(
                _error_envelope(
                    pb.Error.CODE_UNKNOWN_INTERFACE, f"unknown interface {cid}"
                )
            )
            return
        except OSError as e:
            outbox.put(_log_envelope(pb.LOG_LEVEL_ERROR, f"open {cid} failed: {e}"))
            outbox.put(
                _error_envelope(
                    pb.Error.CODE_UNKNOWN_INTERFACE, f"open {cid} failed: {e}"
                )
            )
            return
        subscribed.add(cid)

    def _handle_unsubscribe(
        self,
        unsub: pb.Unsubscribe,
        subscribed: set[str],
        outbox: "queue.Queue[Optional[pb.Envelope]]",
    ) -> None:
        cid = unsub.interface_id
        if cid not in subscribed:
            return
        self._registry.unsubscribe(cid, outbox)
        subscribed.discard(cid)

    def _handle_tx(
        self,
        batch: pb.FrameBatch,
        subscribed: set[str],
        outbox: "queue.Queue[Optional[pb.Envelope]]",
    ) -> None:
        cid = batch.interface_id
        if cid not in subscribed:
            outbox.put(
                _error_envelope(
                    pb.Error.CODE_NOT_SUBSCRIBED,
                    f"transmit on unsubscribed {cid}",
                )
            )
            return
        for proto_frame in batch.frames:
            try:
                frame = _proto_to_frame(proto_frame)
            except ValueError as e:
                # A frame the wire model can't decode (unspecified /
                # unrecognised kind) can't be transmitted — reject it
                # rather than silently sending it as classic.
                outbox.put(
                    _error_envelope(
                        pb.Error.CODE_TX_REJECTED,
                        f"undecodable frame on {cid}: {e}",
                    )
                )
                continue
            try:
                self._registry.transmit(cid, frame, outbox)
            except drv.TxRejected as e:
                outbox.put(_error_envelope(pb.Error.CODE_TX_REJECTED, str(e)))
            except KeyError:
                # Interface was closed between the subscribed-check
                # and the transmit — race with another session's last
                # unsubscribe. Surface as TX_REJECTED.
                outbox.put(
                    _error_envelope(
                        pb.Error.CODE_TX_REJECTED,
                        f"interface {cid} closed",
                    )
                )

    def _handle_configure(
        self,
        cfg: pb.ConfigureBus,
        outbox: "queue.Queue[Optional[pb.Envelope]]",
    ) -> None:
        """Apply a wire ``ConfigureBus``.

        Multi-client conflict semantics are deliberately not enforced
        here (ADR 0022 § Known unknowns); whatever the underlying
        python-can backend does on reopen is what the user gets.
        """
        cid = cfg.interface_id
        config = _configure_to_open_config(cfg)
        try:
            self._registry.reconfigure(cid, config)
        except Exception as e:  # noqa: BLE001
            outbox.put(
                _log_envelope(
                    pb.LOG_LEVEL_ERROR,
                    f"configure {cid} failed: {e}",
                )
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
