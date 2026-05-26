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

One Subscribe spawns one worker thread that pulls frames out of the
driver. The thread blocks for the first frame, then drains
non-blocking up to ``_BATCH_FLUSH_NS`` or ``_BATCH_MAX_FRAMES`` and
emits one ``FrameBatch`` envelope per drain. At low rates this is a
single-frame envelope (same as a strict one-frame-per-envelope pump);
at high rates it amortizes protobuf allocation, the outbox lock
hand-off, the GIL hand-off between the pump and the session-yield
thread, and the per-envelope gRPC overhead across N frames. Without
this, CPython tops out around 5k frames/s on a single channel — the
Rust BLF replay clears 60k+/s with one-frame envelopes because in
Rust the per-envelope cost is trivial; in Python it dominates.
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


def _interfaces_equal(a: list[pb.Interface], b: list[pb.Interface]) -> bool:
    """Identity comparison for the watcher's change-detection.

    Two snapshots are equal if they have the same ids in the same order
    and matching display_name + fd_capable fields. Order matters
    because the driver's enumeration order is itself meaningful (it
    mirrors the vendor's slot ordering). We use a tuple comparison
    rather than ``==`` on the proto messages so unknown future fields
    on ``pb.Interface`` can't accidentally fail equality.
    """
    if len(a) != len(b):
        return False
    return all(
        x.id == y.id
        and x.display_name == y.display_name
        and x.fd_capable == y.fd_capable
        for x, y in zip(a, b)
    )


#: Pump drains for at most this many nanoseconds after the first
#: frame in a batch before flushing. Bounds the wall-clock latency the
#: pump adds to a frame.
_BATCH_FLUSH_NS = 5_000_000  # 5 ms

#: Hard cap on frames per ``FrameBatch`` envelope. Sized so a saturated
#: multi-channel bus (~200k frames/s) still fits one batch inside the
#: flush window — bigger means fewer envelopes per second, which is the
#: dominant amortization win. Per-envelope protobuf encode at this size
#: is still well under a millisecond on CPython; the envelope is ~80 KB
#: of classic-CAN payload, well below gRPC's default 4 MB message cap.
_BATCH_MAX_FRAMES = 2048


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
                # Block for the first frame so an idle channel doesn't
                # spin the CPU.
                frame = self.channel.recv(timeout_s=0.25)
                if frame is None:
                    continue
                batch_frames = [_frame_to_proto(frame)]
                # Drain anything python-can already has buffered, plus
                # whatever arrives within the flush window, up to the
                # batch cap. ``recv(timeout=0)`` is the non-blocking
                # poll used to peel buffered frames off the driver
                # without re-entering a wait.
                deadline = time.monotonic_ns() + _BATCH_FLUSH_NS
                while len(batch_frames) < _BATCH_MAX_FRAMES:
                    if self._stop.is_set():
                        break
                    next_frame = self.channel.recv(timeout_s=0.0)
                    if next_frame is None:
                        if time.monotonic_ns() >= deadline:
                            break
                        # No buffered frame yet but the window hasn't
                        # closed; wait for a fresh one with whatever
                        # time remains.
                        remaining_s = (
                            deadline - time.monotonic_ns()
                        ) / 1_000_000_000
                        if remaining_s <= 0:
                            break
                        next_frame = self.channel.recv(timeout_s=remaining_s)
                        if next_frame is None:
                            break
                    batch_frames.append(_frame_to_proto(next_frame))
                self._outbox.put(
                    pb.Envelope(
                        frame_batch=pb.FrameBatch(
                            interface_id=cid, frames=batch_frames
                        )
                    )
                )
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


#: How often the background watcher thread re-enumerates the driver's
#: channel set. Cheap enough on every supported backend that this is
#: effectively-free at 5s; the cadence is a server-side decision per
#: ADR 0016, not a client-side preference.
_WATCH_POLL_INTERVAL_S = 5.0


class CannetServerService(pb_grpc.CannetServerServicer):
    """Service entry points called by the gRPC framework."""

    def __init__(
        self,
        driver: drv.Driver,
        *,
        watch_poll_interval_s: float = _WATCH_POLL_INTERVAL_S,
    ) -> None:
        self._driver = driver
        # Shared snapshot cache + sequence counter, both guarded by
        # `_watch_cond`. Watchers block on the condition until the
        # sequence advances past their last-seen value. The poll
        # thread is the only writer.
        self._watch_cond = threading.Condition()
        self._watch_snapshot: list[pb.Interface] = []
        self._watch_seq: int = 0
        self._watch_thread_started = False
        self._watch_lock = threading.Lock()
        # Cadence at which the background poll thread re-enumerates.
        # Defaults to `_WATCH_POLL_INTERVAL_S` (production cadence);
        # tests override it to keep the suite quick.
        self._watch_poll_interval_s = watch_poll_interval_s

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

        Yields the current snapshot immediately, then a fresh snapshot
        every time the background poll thread detects a change. The
        thread is shared across watchers, started lazily on the first
        subscribe.

        The client ending the call wakes any waiter through the
        ``add_callback`` hook below — without it the watcher could
        block in ``cond.wait`` past the point the stream is gone.
        """
        self._ensure_watch_thread()
        # Wake-on-disconnect: gRPC calls this on client cancel /
        # transport drop. Notifying all watchers lets each re-check
        # `context.is_active()` and exit its loop cleanly.
        context.add_callback(self._wake_watchers)

        # Snapshot under the lock, then yield outside it so a slow
        # client can't block the poll thread.
        with self._watch_cond:
            last_seq = self._watch_seq
            current = list(self._watch_snapshot)
        yield pb.InterfaceList(interfaces=current)

        while context.is_active():
            with self._watch_cond:
                # `wait_for` rechecks the predicate on every wake-up,
                # which folds the post-disconnect notify into the
                # `is_active` check we run next.
                self._watch_cond.wait_for(
                    lambda: self._watch_seq != last_seq or not context.is_active(),
                    timeout=self._watch_poll_interval_s,
                )
                if not context.is_active():
                    return
                if self._watch_seq == last_seq:
                    # Spurious wake-up or the timeout fired — loop
                    # without yielding so we don't spam identical
                    # snapshots.
                    continue
                last_seq = self._watch_seq
                current = list(self._watch_snapshot)
            yield pb.InterfaceList(interfaces=current)

    def _enumerate_interfaces(self) -> list[pb.Interface]:
        return [
            pb.Interface(
                id=c.id, display_name=c.display_name, fd_capable=c.fd_capable
            )
            for c in self._driver.list_channels()
        ]

    def _ensure_watch_thread(self) -> None:
        """Lazily start the single shared watcher thread. Idempotent;
        runs once for the service's lifetime."""
        with self._watch_lock:
            if self._watch_thread_started:
                return
            self._watch_thread_started = True
            # Seed the cache so the first watcher's immediate yield
            # matches what `ListInterfaces` would have returned, even
            # before the first poll tick.
            initial = self._enumerate_interfaces()
            with self._watch_cond:
                self._watch_snapshot = initial
                self._watch_seq = 1
            threading.Thread(
                target=self._watch_loop,
                name="watch-interfaces",
                daemon=True,
            ).start()

    def _watch_loop(self) -> None:
        """Poll the driver on `_WATCH_POLL_INTERVAL_S` and publish
        whenever the enumeration changes. The daemon flag means the
        thread is reaped at process exit; the sidecar has no other
        shutdown hook on the service object."""
        while True:
            time.sleep(self._watch_poll_interval_s)
            try:
                fresh = self._enumerate_interfaces()
            except Exception:  # noqa: BLE001
                # Driver enumeration failure should not kill the
                # watcher — log once and try again next tick. A
                # persistent failure shows up as the cache staying
                # stale, which the client sees as "the list hasn't
                # changed."
                _log.exception("watch-interfaces enumeration failed")
                continue
            with self._watch_cond:
                if _interfaces_equal(self._watch_snapshot, fresh):
                    continue
                self._watch_snapshot = fresh
                self._watch_seq += 1
                self._watch_cond.notify_all()
            _log.info(
                "WatchInterfaces -> %d channels (seq %d)",
                len(fresh),
                self._watch_seq,
            )

    def _wake_watchers(self) -> None:
        with self._watch_cond:
            self._watch_cond.notify_all()

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
