"""The gRPC servicer and the server bootstrap (ADR 0022).

:class:`CannetServerService` is the ``CannetServerServicer`` the gRPC
framework dispatches to: it owns the :class:`_InterfaceRegistry`, wires
``ListInterfaces`` / ``WatchInterfaces`` to :mod:`.enumeration`, and runs
the bidirectional ``Session`` stream (subscribe / unsubscribe / transmit /
configure). :func:`serve` builds and starts a bound server around it.

Every command here leaves a ``debug`` record carrying its arguments and
its outcome (with the driver's traceback on a failure), because that is
the only trail a post-mortem of a per-channel connect failure has. The
records are ``debug`` on purpose: they exist for the ``--log-file`` sink,
which always records at debug, and must not change what stderr — and so
the System Messages panel — shows at the level the user chose. The
frame paths are the deliberate exception: ``FrameBatch`` is not logged
per batch or per frame, only its lifecycle and faults. See
``cannet_python_can.__main__``'s module docstring for the two-sink model
and the streaming boundary.
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
from .enumeration import (
    _WATCH_LIVENESS_RECHECK_S,
    enumerate_interfaces,
    watch_interfaces,
)
from .helpers import (
    _configure_to_open_config,
    _error_envelope,
    _log_envelope,
    _proto_to_frame,
    load_driver,
)
from .shared_interface import _InterfaceRegistry

_log = logging.getLogger(__name__)


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

    # ----- ListInterfaces / WatchInterfaces ---------------------------------

    def ListInterfaces(
        self, request: pb.ListInterfacesRequest, context: grpc.ServicerContext
    ) -> pb.InterfaceList:
        ifaces = enumerate_interfaces(self._driver)
        _log.info("ListInterfaces -> %d channels", len(ifaces))
        # The count alone can't answer "is the channel I want missing?".
        _log.debug(
            "ListInterfaces -> %s",
            [
                (i.id, i.display_name, "fd" if i.fd_capable else "classic")
                for i in ifaces
            ],
        )
        return pb.InterfaceList(interfaces=ifaces)

    def WatchInterfaces(
        self,
        request: pb.WatchInterfacesRequest,
        context: grpc.ServicerContext,
    ) -> Iterator[pb.InterfaceList]:
        """See :func:`.enumeration.watch_interfaces`."""
        _log.debug("WatchInterfaces stream opened")
        try:
            yield from watch_interfaces(
                self._driver,
                context,
                recheck_interval_s=self._watch_recheck_interval_s,
            )
        finally:
            _log.debug("WatchInterfaces stream closed")

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
            # A session ending is a disconnect for every interface it
            # still held — the reason a channel went quiet.
            if subscribed:
                _log.debug("Session closing; releasing %s", sorted(subscribed))
            for cid in list(subscribed):
                self._registry.unsubscribe(cid, outbox)
            subscribed.clear()
            outbox.put(None)

        def request_pump() -> None:
            try:
                _log.debug("Session opened")
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
        _log.debug("Subscribe interface_id=%s", cid)
        if cid in subscribed:
            _log.debug("Subscribe %s -> ok (already subscribed in this session)", cid)
            return  # idempotent within a session
        try:
            self._registry.subscribe(cid, outbox)
        except KeyError:
            _log.debug("Subscribe %s -> unknown interface", cid, exc_info=True)
            outbox.put(
                _error_envelope(
                    pb.Error.CODE_UNKNOWN_INTERFACE, f"unknown interface {cid}"
                )
            )
            return
        except OSError as e:
            # The whole point of the debug logfile: a channel that
            # refuses to open (the one dead channel on an otherwise
            # working card) leaves the driver's own traceback behind,
            # not just the one-line message the client is sent.
            _log.debug("Subscribe %s -> open failed", cid, exc_info=True)
            outbox.put(_log_envelope(pb.LOG_LEVEL_ERROR, f"open {cid} failed: {e}"))
            outbox.put(
                _error_envelope(
                    pb.Error.CODE_UNKNOWN_INTERFACE, f"open {cid} failed: {e}"
                )
            )
            return
        subscribed.add(cid)
        _log.debug("Subscribe %s -> ok", cid)

    def _handle_unsubscribe(
        self,
        unsub: pb.Unsubscribe,
        subscribed: set[str],
        outbox: "queue.Queue[Optional[pb.Envelope]]",
    ) -> None:
        cid = unsub.interface_id
        _log.debug("Unsubscribe interface_id=%s", cid)
        if cid not in subscribed:
            _log.debug("Unsubscribe %s -> not subscribed in this session", cid)
            return
        self._registry.unsubscribe(cid, outbox)
        subscribed.discard(cid)
        _log.debug("Unsubscribe %s -> ok", cid)

    def _handle_tx(
        self,
        batch: pb.FrameBatch,
        subscribed: set[str],
        outbox: "queue.Queue[Optional[pb.Envelope]]",
    ) -> None:
        """Transmit a wire ``FrameBatch``.

        **Not logged**, deliberately — not per frame, not per batch. A
        saturated bus reaches this method thousands of times a second,
        so a record here would rotate the whole logfile budget away in
        seconds and put a logging call on the hot path. Transmit
        failures already reach the client as ``TX_REJECTED`` envelopes,
        and the interface's lifecycle (open / reconfigure / close, with
        tracebacks) is logged where it happens.
        """
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
        # Requested (as it came off the wire) alongside applied (what the
        # driver is handed): a bitrate that silently doesn't take is
        # otherwise indistinguishable from one that was never asked for.
        _log.debug(
            "ConfigureBus interface_id=%s requested=speed_bps=%d "
            "fd_data_speed_bps=%d fd_enabled=%s applied=%r",
            cid,
            cfg.speed_bps,
            cfg.fd_data_speed_bps,
            bool(cfg.fd_enabled),
            config,
        )
        try:
            self._registry.reconfigure(cid, config)
        except Exception as e:  # noqa: BLE001
            _log.debug("ConfigureBus %s -> failed", cid, exc_info=True)
            outbox.put(
                _log_envelope(
                    pb.LOG_LEVEL_ERROR,
                    f"configure {cid} failed: {e}",
                )
            )
        else:
            _log.debug("ConfigureBus %s -> ok", cid)


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
