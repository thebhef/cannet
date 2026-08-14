"""The shared-interface layer: one open channel per physical interface,
fanned out to every subscribed session, plus the rx / pack / state / tx
pump threads that drive it (ADR 0022).

:class:`_SharedInterface` owns the reference-counted channel lifecycle
and the four pump threads; :class:`_InterfaceRegistry` is the
process-wide map from interface id to its :class:`_SharedInterface`,
holding early ``ConfigureBus`` state so a config that arrives before any
subscribe is applied at the next open.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Optional

from .. import driver as drv
from .._proto import cannet_pb2 as pb
from .helpers import (
    _error_envelope,
    _frame_to_proto,
    _log_envelope,
    _state_name_to_proto,
)

_log = logging.getLogger(__name__)


#: Pump drains for at most this many nanoseconds after the first
#: frame in a batch before flushing. Bounds the wall-clock latency the
#: pump adds to a frame.
_BATCH_FLUSH_NS = 5_000_000  # 5 ms

#: Per-interface TX-worker queue depth. Deep enough to absorb a
#: same-tick burst of periodics (hundreds of messages sharing a phase)
#: without rejecting; shallow enough that sustained saturation surfaces
#: as TX_REJECTED within ~a queue-drain rather than unbounded latency.
_TX_QUEUE_MAX = 256
#: How long ``transmit`` may block on a full TX queue before rejecting.
_TX_ENQUEUE_GRACE_S = 0.25

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
        # The channel most recently swapped away by `reconfigure` and
        # not yet garbage-collected -- lets `_rx_pump` recognise a
        # `recv()` failure on it as the close doing its job, not a
        # fault. See `reconfigure` for why this can't reuse `_stop`.
        self._reconfigure_closing_channel: Optional[drv.OpenChannel] = None
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
        # Per-interface TX worker (measured 2026-07-25): ``ch.send`` costs
        # ~0.3-1 ms (python-can + ctypes + GIL), and it used to run inline
        # on the session's single gRPC reader thread - every interface's
        # sends serialized there, saturating at ~1 kHz total and bursting
        # the wire. ``transmit`` now enqueues; this worker owns the sends,
        # so interfaces transmit in parallel and the reader never blocks
        # on hardware. The queue is bounded: a full queue rejects the
        # frame (TX_REJECTED) after a short block rather than stalling
        # the reader indefinitely - saturation stays visible.
        self._tx_queue: "queue.Queue[Optional[tuple[drv.Frame, queue.Queue[Optional[pb.Envelope]]]]]" = queue.Queue(
            maxsize=_TX_QUEUE_MAX
        )
        self._tx_thread: Optional[threading.Thread] = None

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

    def transmit(
        self,
        frame: drv.Frame,
        outbox: "queue.Queue[Optional[pb.Envelope]]",
    ) -> None:
        """Queue ``frame`` for the TX worker.

        Raises :class:`drv.TxRejected` synchronously when the interface
        is closed or the TX queue stays full past a short grace (the
        worker is stalled or saturated). Send errors discovered on the
        worker are routed back to ``outbox`` as ``TX_REJECTED``
        envelopes.
        """
        with self._lock:
            ch = self._channel
        if ch is None:
            raise drv.TxRejected(f"{self._channel_id}: interface closed")
        try:
            self._tx_queue.put((frame, outbox), timeout=_TX_ENQUEUE_GRACE_S)
        except queue.Full:
            raise drv.TxRejected(
                f"{self._channel_id}: tx queue full ({_TX_QUEUE_MAX} frames)"
            ) from None

    def _tx_pump(self) -> None:
        """TX worker thread. Drains the per-interface queue and owns
        every ``ch.send``: a slow send (device TX-buffer stall,
        python-can overhead) delays only this interface's queue, never
        the gRPC reader thread. Send timing feeds the periodic tx-stats
        line: `max_send` is the worst single send in the interval,
        `max_gap` the worst idle between sends (upstream delivery
        burstiness) - reading both disambiguates where a stall lives."""
        while True:
            try:
                item = self._tx_queue.get(timeout=0.1)
            except queue.Empty:
                if self._stop.is_set():
                    return
                continue
            if item is None:
                return
            frame, outbox = item
            ch = self._current_channel()
            if ch is None:
                outbox.put(
                    _error_envelope(
                        pb.Error.CODE_TX_REJECTED,
                        f"{self._channel_id}: interface closed",
                    )
                )
                continue
            t0 = time.monotonic_ns()
            try:
                ch.send(frame)
            except drv.TxRejected as e:
                outbox.put(_error_envelope(pb.Error.CODE_TX_REJECTED, str(e)))
                continue
            except Exception as e:  # noqa: BLE001 - worker must survive
                msg = f"send on {self._channel_id} failed: {e}"
                _log.warning(msg)
                outbox.put(_error_envelope(pb.Error.CODE_TX_REJECTED, msg))
                continue
            done = time.monotonic_ns()
            send_ns = done - t0
            with self._tx_stats_lock:
                self._tx_count += 1
                self._tx_count_total += 1
                if send_ns > self._tx_max_send_ns:
                    self._tx_max_send_ns = send_ns
                # Idle since the previous send completed - the
                # frame-delivery gap, uncontaminated by this or the
                # prior send's duration.
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
                _log.debug(
                    "reconfigure %s deferred to next open: %r",
                    self._channel_id,
                    new_config,
                )
                return
            old = self._channel
            _log.debug("reopening %s with %r", self._channel_id, new_config)
            try:
                new = self._driver.open(self._channel_id, new_config)
            except Exception as e:  # noqa: BLE001
                msg = f"reconfigure {self._channel_id} failed: {e}"
                _log.warning(msg)
                # The traceback goes to the debug sink only: the warning
                # above is what stderr (and so the System Messages panel)
                # already carried, and raising the file's detail must not
                # raise the panel's.
                _log.debug("reconfigure %s failed", self._channel_id, exc_info=True)
                self._broadcast_error(pb.LOG_LEVEL_ERROR, msg, lock_held=True)
                return
            self._channel = new
            self._reset_state_baseline_locked()
            # `old` is about to be closed out from under any in-flight
            # `ch.recv()` the rx pump is blocked on -- the same race
            # `_close_locked` has, but this is a swap, not a shutdown,
            # so `_stop` stays clear (overloading it here would make a
            # genuine shutdown mid-reconfigure look like a swap instead).
            self._reconfigure_closing_channel = old
        try:
            old.close()
        except Exception:  # noqa: BLE001
            pass

    # ---- internal --------------------------------------------------------

    def _open_locked(self) -> None:
        # The open attempt and the config it carries, logged before the
        # call: when the driver refuses (or hangs), this line is the
        # last thing in the file and names the channel and parameters
        # that did it. The caller logs the traceback.
        _log.debug("opening %s with %r", self._channel_id, self._config)
        self._channel = self._driver.open(self._channel_id, self._config)
        _log.debug("opened %s", self._channel_id)
        self._stop.clear()
        self._reset_state_baseline_locked()
        # Fresh handoff queues per open — a previous session's residue
        # would otherwise prepend stale frames to the next one's first
        # batch / first send.
        self._rx_queue = queue.Queue()
        self._tx_queue = queue.Queue(maxsize=_TX_QUEUE_MAX)
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
        self._tx_thread = threading.Thread(
            target=self._tx_pump,
            name=f"tx-{self._channel_id}",
            daemon=True,
        )
        self._rx_thread.start()
        self._pack_thread.start()
        self._state_thread.start()
        self._tx_thread.start()

    def _close_locked(self) -> None:
        _log.debug("closing %s", self._channel_id)
        self._stop.set()
        # Best-effort prompt wake for the TX worker; if the queue is
        # full it exits on its next 100 ms stop-flag poll instead.
        try:
            self._tx_queue.put_nowait(None)
        except queue.Full:
            pass
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

    def _broadcast_error(
        self, level: "pb.LogLevel.V", message: str, *, lock_held: bool = False
    ) -> None:
        """Fan a ``LogMessage`` envelope out to every subscribed outbox.

        Builds the envelope once and puts it on each subscriber's outbox.
        Callers that already hold :attr:`_lock` (only :meth:`reconfigure`,
        which fans out mid-reconfigure) must pass ``lock_held=True``: the
        helper then reads :attr:`_outboxes` directly instead of taking the
        non-reentrant lock a second time, which would deadlock.
        """
        env = _log_envelope(level, message)
        outboxes = list(self._outboxes) if lock_held else self._outbox_snapshot()
        for ob in outboxes:
            ob.put(env)

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
                    if self._stop.is_set():
                        # The close we were told about (``_stop`` is set
                        # before the channel is closed) landed while this
                        # read was in flight — PCAN-Basic fails the
                        # in-flight ``CAN_ReadFD`` with
                        # PCAN_ERROR_INITIALIZE rather than returning
                        # empty-handed. That is the close working, not a
                        # fault, so it stays out of the operator's log.
                        _log.debug("rx for %s ended at close: %s", cid, e)
                        break
                    with self._lock:
                        swapped_away = ch is self._reconfigure_closing_channel
                    if swapped_away:
                        # Same race as the close above, minus the
                        # shutdown: the interface stays open on the new
                        # channel, so keep pumping rather than breaking.
                        _log.debug("rx for %s ended at reconfigure swap: %s", cid, e)
                        continue
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
            self._broadcast_error(pb.LOG_LEVEL_ERROR, f"rx pump for {cid} crashed: {e}")

    def _pack_pump(self) -> None:
        """Packager thread. Drains the rx handoff queue, batches frames
        into ``FrameBatch`` envelopes (up to ``_BATCH_FLUSH_NS`` /
        ``_BATCH_MAX_FRAMES``), and fans them out to each subscriber's
        outbox. Decoupling this from the reader keeps protobuf encode
        latency from delaying the next ``ch.recv`` call, which is what
        was letting PCAN's queue back up and collapse timestamps."""
        cid = self._channel_id
        dropped = 0

        def _encode(frame: drv.Frame):
            # A frame the wire format can't encode (e.g. a garbage
            # driver timestamp over uint64 max) must cost one frame,
            # not the pump thread — a dead pump leaves the interface
            # "connected" while silently discarding all traffic. Log
            # the first drop only; a driver emitting garbage on every
            # frame would otherwise flood the system log.
            nonlocal dropped
            try:
                return _frame_to_proto(frame)
            except ValueError as e:
                dropped += 1
                if dropped == 1:
                    _log.warning("dropping unencodable frame on %s: %s", cid, e)
                    self._broadcast_error(
                        pb.LOG_LEVEL_ERROR,
                        f"dropping unencodable frame on {cid}: {e} "
                        f"(further drops suppressed)",
                    )
                return None

        try:
            while not self._stop.is_set():
                try:
                    first = self._rx_queue.get(timeout=0.25)
                except queue.Empty:
                    continue
                batch_frames = [_encode(first)]
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
                    batch_frames.append(_encode(nxt))
                batch_frames = [f for f in batch_frames if f is not None]
                if not batch_frames:
                    continue
                env = pb.Envelope(
                    frame_batch=pb.FrameBatch(interface_id=cid, frames=batch_frames)
                )
                for ob in self._outbox_snapshot():
                    ob.put(env)
        except Exception as e:  # noqa: BLE001
            _log.warning("pack pump for %s crashed: %s", cid, e)
            self._broadcast_error(
                pb.LOG_LEVEL_ERROR, f"pack pump for {cid} crashed: {e}"
            )

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

    def transmit(
        self,
        channel_id: str,
        frame: drv.Frame,
        outbox: "queue.Queue[Optional[pb.Envelope]]",
    ) -> None:
        with self._lock:
            shared = self._interfaces.get(channel_id)
        if shared is None:
            raise KeyError(channel_id)
        shared.transmit(frame, outbox)
