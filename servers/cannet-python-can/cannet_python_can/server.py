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


def _configure_to_open_config(cfg: pb.ConfigureBus) -> drv.OpenConfig:
    """Translate a wire ``ConfigureBus`` into an :class:`OpenConfig`.

    ``speed_bps`` / ``fd_data_speed_bps`` of 0 are taken as "unset";
    the OpenConfig field becomes ``None`` so the driver picks its own
    default.
    """
    return drv.OpenConfig(
        bitrate_bps=int(cfg.speed_bps) if cfg.speed_bps else None,
        data_bitrate_bps=(
            int(cfg.fd_data_speed_bps) if cfg.fd_data_speed_bps else None
        ),
        fd=bool(cfg.fd_enabled),
    )


def _state_name_to_proto(name: str) -> "pb.ControllerState.V":
    if name == drv.STATE_PASSIVE:
        return pb.CONTROLLER_STATE_PASSIVE
    if name == drv.STATE_BUS_OFF:
        return pb.CONTROLLER_STATE_BUS_OFF
    return pb.CONTROLLER_STATE_ACTIVE


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

#: How often the state-poll thread re-reads the controller's
#: fault-confinement state. Cheap on every backend that exposes it; on
#: backends that don't, the read returns the default (ACTIVE / 0 / 0)
#: and the watcher does nothing.
_STATE_POLL_INTERVAL_S = 0.5

#: How often the reader thread logs its driver-read rate and rx-queue
#: depth. Diagnostic only: comparing the read rate here against the
#: host's append rate localises frame loss to *before* Python (driver RX
#: overrun → read rate already short) versus *after* the read (queue
#: backing up → loss downstream in pack/wire). Logged to stderr, which
#: the host bridges into the System Messages panel.
_RX_STATS_INTERVAL_NS = 2_000_000_000  # 2 s


class _SharedInterface:
    """One open physical channel, shared across all subscribed sessions.

    The first subscribing session causes the underlying channel to be
    opened; the last unsubscribing session causes it to be closed.
    Frames received from the channel are broadcast to every subscribed
    outbox; transmits from any subscriber go through the same channel.

    ``ConfigureBus`` flows through :meth:`reconfigure`, which swaps the
    underlying channel in place — the rx and state pumps pick up the
    new channel on their next loop iteration.
    """

    def __init__(
        self,
        *,
        driver: drv.Driver,
        channel_id: str,
        initial_config: drv.OpenConfig,
    ) -> None:
        self._driver = driver
        self._channel_id = channel_id
        self._lock = threading.Lock()
        self._config = initial_config
        self._channel: Optional[drv.OpenChannel] = None
        # Ordered subscriber list; values are gRPC-Session outboxes.
        # We keep it as a list (not a set) so iteration order is
        # deterministic for tests.
        self._outboxes: list["queue.Queue[Optional[pb.Envelope]]"] = []
        self._stop = threading.Event()
        self._rx_thread: Optional[threading.Thread] = None
        self._pack_thread: Optional[threading.Thread] = None
        self._state_thread: Optional[threading.Thread] = None
        # Internal handoff queue between the rx reader thread and the
        # packager thread. The reader's only job is to call
        # ``ch.recv`` and ``put`` the raw ``Frame`` here as fast as
        # possible so PCAN's hardware-bound recv queue stays empty —
        # python-can / PCAN-Basic stamp each frame at the moment
        # ``CAN_ReadFD`` is called, so any backlog in the OS-side
        # queue collapses several real on-wire arrivals into
        # microsecond-apart timestamps. Doing protobuf encoding and
        # outbox fan-out on a separate thread is what keeps the reader
        # in its tight recv loop.
        self._rx_queue: "queue.Queue[drv.Frame]" = queue.Queue()
        # Last-pushed state, used by the state pump to decide whether
        # to emit a fresh ``InterfaceState`` envelope.
        self._last_state: pb.ControllerState.V = pb.CONTROLLER_STATE_ACTIVE
        self._last_tec: int = 0
        self._last_rec: int = 0
        # Transmit-side counters, emitted alongside the rx stats on the
        # rx pump's periodic tick. `transmit` runs on gRPC handler
        # threads while the tick reads/resets on the rx thread, so a
        # dedicated lightweight lock guards them (held only for the
        # integer updates, never across ``ch.send``). `max_send_ns` is
        # the worst single ``ch.send`` duration in the interval — the
        # signal that distinguishes a host-side late send from a
        # sidecar/driver TX-buffer stall.
        self._tx_stats_lock = threading.Lock()
        self._tx_count = 0
        self._tx_count_total = 0
        self._tx_max_send_ns = 0
        # Wall-clock of the previous ``ch.send`` completion, plus the
        # worst idle between one send finishing and the next starting in
        # the interval (`max_gap`). Measured separately from `max_send`
        # so a slow send can't inflate it: a device-side TX stall blocks
        # inside ``ch.send`` while frames keep arriving (max_gap stays
        # small), whereas an upstream delivery burst leaves the sender
        # idle waiting for the next frame (max_gap spikes alongside
        # max_send). Reading both disambiguates where the stall lives.
        self._tx_last_done_ns = 0
        self._tx_max_gap_ns = 0

    @property
    def channel_id(self) -> str:
        return self._channel_id

    def attach(self, outbox: "queue.Queue[Optional[pb.Envelope]]") -> None:
        """Register ``outbox`` as a subscriber.

        Opens the underlying channel on the first attach. Pushes the
        current :class:`InterfaceState` snapshot to ``outbox`` so
        every subscriber gets one regardless of when it joined.
        Raises whatever the driver raises (``KeyError`` for unknown id,
        ``OSError`` for open failures) on the *first* attach; later
        attaches reuse the already-open channel.
        """
        with self._lock:
            if outbox not in self._outboxes:
                self._outboxes.append(outbox)
            if self._channel is None:
                self._open_locked()
            snapshot_state = self._last_state
            snapshot_tec = self._last_tec
            snapshot_rec = self._last_rec
        outbox.put(
            pb.Envelope(
                interface_state=pb.InterfaceState(
                    interface_id=self._channel_id,
                    state=snapshot_state,
                    tec=snapshot_tec,
                    rec=snapshot_rec,
                )
            )
        )

    def detach(self, outbox: "queue.Queue[Optional[pb.Envelope]]") -> bool:
        """Drop ``outbox`` from the subscriber list.

        Returns ``True`` when this was the last subscriber and the
        channel has been closed (so the registry can drop the entry).
        """
        with self._lock:
            try:
                self._outboxes.remove(outbox)
            except ValueError:
                pass
            if self._outboxes:
                return False
            self._close_locked()
            return True

    def has_subscribers(self) -> bool:
        with self._lock:
            return bool(self._outboxes)

    def transmit(self, frame: drv.Frame) -> None:
        with self._lock:
            ch = self._channel
        if ch is None:
            raise drv.TxRejected(f"{self._channel_id}: interface closed")
        # Time the send itself: a slow ``ch.send`` here means the
        # driver's TX buffer is backing up (a sidecar-side stall),
        # which the periodic tx-stats line surfaces as `max_send`.
        t0 = time.monotonic_ns()
        ch.send(frame)
        done = time.monotonic_ns()
        send_ns = done - t0
        with self._tx_stats_lock:
            self._tx_count += 1
            self._tx_count_total += 1
            if send_ns > self._tx_max_send_ns:
                self._tx_max_send_ns = send_ns
            # Idle since the previous send completed — the frame-delivery
            # gap, uncontaminated by this or the prior send's duration.
            if self._tx_last_done_ns:
                gap_ns = t0 - self._tx_last_done_ns
                if gap_ns > self._tx_max_gap_ns:
                    self._tx_max_gap_ns = gap_ns
            self._tx_last_done_ns = done

    def reconfigure(self, new_config: drv.OpenConfig) -> None:
        """Apply a new :class:`OpenConfig`.

        If the interface is currently open, the channel is closed and
        reopened with the new config — the rx pump rolls over to the
        new channel on its next loop iteration. If the open call
        fails, the old channel is kept (and a ``LogMessage`` is
        emitted to every subscriber).
        """
        with self._lock:
            self._config = new_config
            if self._channel is None:
                return
            old = self._channel
            try:
                new = self._driver.open(self._channel_id, new_config)
            except Exception as e:  # noqa: BLE001
                msg = f"reconfigure {self._channel_id} failed: {e}"
                _log.warning(msg)
                outboxes = list(self._outboxes)
                for ob in outboxes:
                    ob.put(_log_envelope(pb.LOG_LEVEL_ERROR, msg))
                return
            self._channel = new
            self._reset_state_baseline_locked()
        try:
            old.close()
        except Exception:  # noqa: BLE001
            pass

    # ---- internal --------------------------------------------------------

    def _open_locked(self) -> None:
        self._channel = self._driver.open(self._channel_id, self._config)
        self._stop.clear()
        self._reset_state_baseline_locked()
        # Fresh handoff queue per open — a previous session's residue
        # would otherwise prepend stale frames to the next one's first
        # batch.
        self._rx_queue = queue.Queue()
        self._rx_thread = threading.Thread(
            target=self._rx_pump,
            name=f"rx-{self._channel_id}",
            daemon=True,
        )
        self._pack_thread = threading.Thread(
            target=self._pack_pump,
            name=f"pack-{self._channel_id}",
            daemon=True,
        )
        self._state_thread = threading.Thread(
            target=self._state_pump,
            name=f"state-{self._channel_id}",
            daemon=True,
        )
        self._rx_thread.start()
        self._pack_thread.start()
        self._state_thread.start()

    def _close_locked(self) -> None:
        self._stop.set()
        ch = self._channel
        self._channel = None
        if ch is not None:
            try:
                ch.close()
            except Exception:  # noqa: BLE001
                pass

    def _reset_state_baseline_locked(self) -> None:
        """Pin the controller-state baseline to ACTIVE / 0 / 0 so the
        first poll after open emits an :class:`InterfaceState` only if
        the controller is actually elsewhere."""
        self._last_state = pb.CONTROLLER_STATE_ACTIVE
        self._last_tec = 0
        self._last_rec = 0

    def _current_channel(self) -> Optional[drv.OpenChannel]:
        with self._lock:
            return self._channel

    def _outbox_snapshot(self) -> list["queue.Queue[Optional[pb.Envelope]]"]:
        with self._lock:
            return list(self._outboxes)

    def _rx_pump(self) -> None:
        """Reader thread. Stays minimal so PCAN's recv queue drains as
        fast as physically possible: block on ``ch.recv``, push the raw
        ``Frame`` onto ``self._rx_queue``, repeat. Protobuf encoding,
        batching, and outbox fan-out happen on the packer thread."""
        cid = self._channel_id
        read = 0
        read_total = 0
        next_stats_ns = time.monotonic_ns() + _RX_STATS_INTERVAL_NS
        try:
            while not self._stop.is_set():
                ch = self._current_channel()
                if ch is None:
                    if self._stop.wait(0.05):
                        break
                    continue
                try:
                    frame = ch.recv(timeout_s=0.25)
                except Exception as e:  # noqa: BLE001
                    _log.warning("rx for %s failed: %s", cid, e)
                    if self._stop.wait(0.1):
                        break
                    continue
                if frame is not None:
                    self._rx_queue.put(frame)
                    read += 1
                    read_total += 1
                # Periodic stats. Checked every loop iteration (recv
                # times out every 0.25 s), not only on frame arrival, so
                # tx stats still emit on a bus that is transmitting but
                # receiving nothing. A fully idle interval (no rx, no tx)
                # is suppressed to keep the log quiet.
                now_ns = time.monotonic_ns()
                if now_ns >= next_stats_ns:
                    secs = (now_ns - next_stats_ns + _RX_STATS_INTERVAL_NS) / 1e9
                    with self._tx_stats_lock:
                        tx = self._tx_count
                        tx_total = self._tx_count_total
                        tx_max_ns = self._tx_max_send_ns
                        tx_max_gap_ns = self._tx_max_gap_ns
                        self._tx_count = 0
                        self._tx_max_send_ns = 0
                        self._tx_max_gap_ns = 0
                    if read > 0 or tx > 0:
                        read_rate = read / secs if secs > 0 else 0.0
                        _log.info(
                            "rx stats %s: read=%.0f/s total=%d queue=%d",
                            cid,
                            read_rate,
                            read_total,
                            self._rx_queue.qsize(),
                        )
                        tx_rate = tx / secs if secs > 0 else 0.0
                        _log.info(
                            "tx stats %s: sent=%.0f/s total=%d "
                            "max_send=%.2f ms max_gap=%.2f ms",
                            cid,
                            tx_rate,
                            tx_total,
                            tx_max_ns / 1e6,
                            tx_max_gap_ns / 1e6,
                        )
                    read = 0
                    next_stats_ns = now_ns + _RX_STATS_INTERVAL_NS
        except Exception as e:  # noqa: BLE001
            _log.warning("rx pump for %s crashed: %s", cid, e)
            err = _log_envelope(pb.LOG_LEVEL_ERROR, f"rx pump for {cid} crashed: {e}")
            for ob in self._outbox_snapshot():
                ob.put(err)

    def _pack_pump(self) -> None:
        """Packager thread. Drains the rx handoff queue, batches frames
        into ``FrameBatch`` envelopes (up to ``_BATCH_FLUSH_NS`` /
        ``_BATCH_MAX_FRAMES``), and fans them out to each subscriber's
        outbox. Decoupling this from the reader keeps protobuf encode
        latency from delaying the next ``ch.recv`` call, which is what
        was letting PCAN's queue back up and collapse timestamps."""
        cid = self._channel_id
        try:
            while not self._stop.is_set():
                try:
                    first = self._rx_queue.get(timeout=0.25)
                except queue.Empty:
                    continue
                batch_frames = [_frame_to_proto(first)]
                deadline = time.monotonic_ns() + _BATCH_FLUSH_NS
                while len(batch_frames) < _BATCH_MAX_FRAMES:
                    if self._stop.is_set():
                        break
                    remaining_ns = deadline - time.monotonic_ns()
                    if remaining_ns <= 0:
                        break
                    try:
                        nxt = self._rx_queue.get(timeout=remaining_ns / 1_000_000_000)
                    except queue.Empty:
                        break
                    batch_frames.append(_frame_to_proto(nxt))
                env = pb.Envelope(
                    frame_batch=pb.FrameBatch(interface_id=cid, frames=batch_frames)
                )
                for ob in self._outbox_snapshot():
                    ob.put(env)
        except Exception as e:  # noqa: BLE001
            _log.warning("pack pump for %s crashed: %s", cid, e)
            err = _log_envelope(pb.LOG_LEVEL_ERROR, f"pack pump for {cid} crashed: {e}")
            for ob in self._outbox_snapshot():
                ob.put(err)

    def _state_pump(self) -> None:
        cid = self._channel_id
        while not self._stop.is_set():
            if self._stop.wait(_STATE_POLL_INTERVAL_S):
                break
            ch = self._current_channel()
            if ch is None:
                continue
            try:
                st = ch.state()
            except Exception as e:  # noqa: BLE001
                _log.debug("state poll for %s failed: %s", cid, e)
                continue
            mapped = _state_name_to_proto(st.state)
            with self._lock:
                if (
                    mapped == self._last_state
                    and st.tec == self._last_tec
                    and st.rec == self._last_rec
                ):
                    continue
                self._last_state = mapped
                self._last_tec = st.tec
                self._last_rec = st.rec
                outboxes = list(self._outboxes)
            env = pb.Envelope(
                interface_state=pb.InterfaceState(
                    interface_id=cid,
                    state=mapped,
                    tec=st.tec,
                    rec=st.rec,
                )
            )
            for ob in outboxes:
                ob.put(env)


class _InterfaceRegistry:
    """Process-wide registry of :class:`_SharedInterface` entries.

    The service holds exactly one registry. Each session is a thin
    client: ``Subscribe`` → ``registry.subscribe``,
    ``Unsubscribe`` → ``registry.unsubscribe``,
    ``FrameBatch`` → ``registry.transmit``,
    ``ConfigureBus`` → ``registry.reconfigure``.
    The registry holds the per-interface :class:`OpenConfig` even
    before a session subscribes, so a ``ConfigureBus`` that arrives
    early is applied at the next open.
    """

    def __init__(self, driver: drv.Driver) -> None:
        self._driver = driver
        self._lock = threading.Lock()
        self._interfaces: dict[str, _SharedInterface] = {}
        self._configs: dict[str, drv.OpenConfig] = {}

    def subscribe(
        self,
        channel_id: str,
        outbox: "queue.Queue[Optional[pb.Envelope]]",
    ) -> _SharedInterface:
        with self._lock:
            shared = self._interfaces.get(channel_id)
            new = shared is None
            if new:
                cfg = self._configs.get(channel_id, drv.OpenConfig())
                shared = _SharedInterface(
                    driver=self._driver,
                    channel_id=channel_id,
                    initial_config=cfg,
                )
                self._interfaces[channel_id] = shared
        assert shared is not None
        try:
            shared.attach(outbox)
        except Exception:
            if new:
                with self._lock:
                    self._interfaces.pop(channel_id, None)
            raise
        return shared

    def unsubscribe(
        self,
        channel_id: str,
        outbox: "queue.Queue[Optional[pb.Envelope]]",
    ) -> None:
        with self._lock:
            shared = self._interfaces.get(channel_id)
        if shared is None:
            return
        if shared.detach(outbox):
            with self._lock:
                # Re-check under the lock — another session may have
                # attached between the detach and this pop.
                cur = self._interfaces.get(channel_id)
                if cur is shared and not cur.has_subscribers():
                    self._interfaces.pop(channel_id, None)

    def reconfigure(self, channel_id: str, config: drv.OpenConfig) -> None:
        with self._lock:
            shared = self._interfaces.get(channel_id)
            self._configs[channel_id] = config
        if shared is not None:
            shared.reconfigure(config)

    def transmit(self, channel_id: str, frame: drv.Frame) -> None:
        with self._lock:
            shared = self._interfaces.get(channel_id)
        if shared is None:
            raise KeyError(channel_id)
        shared.transmit(frame)


#: How often a parked ``WatchInterfaces`` stream wakes to re-check
#: ``context.is_active()``. This is a liveness safety-net only — it does
#: **not** drive enumeration. ADR 0016 leaves the re-enumeration cadence
#: to the server "[depending on] how cheap enumeration is on this
#: backend"; on PCAN the global ``GetValue(PCAN_ATTACHED_CHANNELS)`` call
#: serialises against ``CAN_Write`` in the driver, so re-enumerating on a
#: timer stalled active transmits (~150 ms hiccups every poll). The
#: sidecar therefore enumerates only on subscribe (the seed) and on an
#: explicit ``ListInterfaces`` pull (the GUI's "Discover" button), never
#: on a timer while channels are open.
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
        # Shared snapshot cache + sequence counter, both guarded by
        # `_watch_cond`. Watchers block on the condition until the
        # sequence advances past their last-seen value. The cache is
        # seeded once on first subscribe and re-published only by an
        # explicit pull — nothing re-enumerates on a timer.
        self._watch_cond = threading.Condition()
        self._watch_snapshot: list[pb.Interface] = []
        self._watch_seq: int = 0
        self._watch_seeded = False
        self._watch_lock = threading.Lock()
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

        Yields the current snapshot immediately, then a fresh snapshot
        whenever the shared cache's sequence advances. On the PCAN
        backend the cache is *not* re-enumerated on a timer (that call
        contends with active transmits — see
        ``_WATCH_LIVENESS_RECHECK_S``), so in practice a parked stream
        yields once and then waits; a hot-plug is picked up by the next
        explicit ``ListInterfaces`` pull rather than pushed here.

        The client ending the call wakes any waiter through the
        ``add_callback`` hook below — without it the watcher could
        block in ``cond.wait`` past the point the stream is gone.
        """
        self._ensure_watch_seeded()
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
                    timeout=self._watch_recheck_interval_s,
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
            pb.Interface(id=c.id, display_name=c.display_name, fd_capable=c.fd_capable)
            for c in self._driver.list_channels()
        ]

    def _ensure_watch_seeded(self) -> None:
        """Seed the shared interface cache once, on the first subscribe.
        Idempotent; runs a single enumeration for the service's lifetime.

        This is the only enumeration the watch path triggers: ADR 0016
        leaves the re-enumeration cadence to the server, and on PCAN a
        periodic re-enumeration contends with active transmits (see
        ``_WATCH_LIVENESS_RECHECK_S``), so subsequent refreshes come from
        an explicit ``ListInterfaces`` pull, not a timer."""
        with self._watch_lock:
            if self._watch_seeded:
                return
            self._watch_seeded = True
            # Seed the cache so the first watcher's immediate yield
            # matches what `ListInterfaces` would have returned.
            initial = self._enumerate_interfaces()
            with self._watch_cond:
                self._watch_snapshot = initial
                self._watch_seq = 1

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
            frame = _proto_to_frame(proto_frame)
            try:
                self._registry.transmit(cid, frame)
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
