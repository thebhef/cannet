"""The shared-interface layer: one open channel per physical interface,
fanned out to every subscribed session, plus the rx / pack / state / tx
pump threads that drive it (ADR 0022).

:class:`_SharedInterface` owns the reference-counted channel lifecycle
and the four pump threads; :class:`_InterfaceRegistry` is the
process-wide map from interface id to its :class:`_SharedInterface`,
holding early ``ConfigureBus`` state so a config that arrives before any
subscribe is applied at the next open.

The bus-fault model is ADR 0060's. The receive pump folds every error
frame into the interface's bus-error episode
(:class:`~.episodes.EpisodeAccumulator`) and forwards only the first N
of each episode as rows. The state pump reads the controller every
:data:`_STATE_POLL_INTERVAL_S`, publishes ``InterfaceState`` on change
and at least every :data:`_STATE_HEARTBEAT_S`, republishes an open
episode, and recovers the channel: a bus-off reset and a silent-queue
reopen (ADR 0039), and a flush of a transmit queue that has accepted
nothing for :data:`_STUCK_QUEUE_FLUSH_AFTER_S`. Refused transmits are
counted into the sending session's
:class:`~.outbox.SessionOutbox`, never sent one envelope each, and a
full per-interface transmit queue refuses at once, so one interface
never holds back another.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Optional

from cannet_python_wire import frame_to_proto
from cannet_python_wire._proto import cannet_pb2 as pb

from .. import driver as drv
from .episodes import EpisodeAccumulator
from .helpers import (
    _interface_state,
    _log_envelope,
    _state_name_to_proto,
)
from .outbox import SessionOutbox

_log = logging.getLogger(__name__)


#: Pump drains for at most this many nanoseconds after the first
#: frame in a batch before flushing. Bounds the wall-clock latency the
#: pump adds to a frame.
_BATCH_FLUSH_NS = 5_000_000  # 5 ms

#: Per-interface TX-worker queue depth. Deep enough to absorb a
#: same-tick burst of periodics (hundreds of messages sharing a phase)
#: without rejecting; shallow enough that sustained saturation surfaces
#: as a ``queue_full`` refusal within ~a queue-drain rather than
#: unbounded latency. A full queue refuses at once (ADR 0060 rule 6):
#: the session's request thread serves every interface on the session,
#: so waiting on one interface's queue would pace them all to it.
_TX_QUEUE_MAX = 256

#: Hard cap on frames per ``FrameBatch`` envelope. Sized so a saturated
#: multi-channel bus (~200k frames/s) still fits one batch inside the
#: flush window — bigger means fewer envelopes per second, which is the
#: dominant amortization win. Per-envelope protobuf encode at this size
#: is still well under a millisecond on CPython; the envelope is ~80 KB
#: of classic-CAN payload, well below gRPC's default 4 MB message cap.
_BATCH_MAX_FRAMES = 2048

#: How often the state-poll thread re-reads the controller's
#: fault-confinement state and error counters (ADR 0060 rule 5). It is
#: also the cadence an open bus-error episode is republished at, so a
#: fault reaches the host within about a poll of its first error frame.
#: Cheap on every backend that exposes it; on backends that don't, the
#: read returns the default (ACTIVE / 0 / 0).
_STATE_POLL_INTERVAL_S = 0.25

#: ``InterfaceState`` is published on change and at least this often
#: regardless, each carrying when it was read (ADR 0060 rule 5), so a
#: reading that has stopped arriving is visibly stale rather than
#: silently unchanged.
_STATE_HEARTBEAT_S = 1.0

#: How long a controller may read bus-off before the state poll resets
#: it. The controller's own way back -- 128 occurrences of 11 recessive
#: bits -- takes milliseconds at any bitrate, so a controller still
#: bus-off after a second is latched: the driver is holding it there
#: until something resets it. Several poll intervals, so one stale
#: reading cannot trigger a reset on its own.
_BUS_OFF_RESET_AFTER_S = 1.0

#: How long a channel may refuse every send as queue-full, with none
#: accepted, before the state poll flushes its transmit queue (ADR 0060
#: rule 7). On a working bus a full queue frees a slot every frame time,
#: so a second without one accepted send is thousands of frame times:
#: the queue is not draining, and the frames in it are older than any
#: period worth sending. The flush is repeated at most this often while
#: the shape persists. Not applied to a bus-off controller, which the
#: bus-off reset owns.
_STUCK_QUEUE_FLUSH_AFTER_S = 1.0

#: How long a channel whose driver is refusing sends with a full transmit
#: queue may go without receiving anything -- no data frame, no error
#: frame -- before the state poll reopens it (ADR 0039). A controller
#: that is retransmitting into a fault reports every attempt as an error
#: frame, so silence on top of a full queue means the controller is not
#: transmitting at all and nothing on the wire will restart it; the
#: flush (:data:`_STUCK_QUEUE_FLUSH_AFTER_S`) has already been tried by
#: then and does not re-initialise a controller. Many poll intervals: a
#: refusal is judged against a run of silence, never one quiet pass.
_QUEUE_FULL_SILENCE_REOPEN_AFTER_S = 2.0

#: How often the reader thread logs its driver-read rate and rx-queue
#: depth. Diagnostic only: comparing the read rate here against the
#: host's append rate localises frame loss to *before* Python (driver RX
#: overrun → read rate already short) versus *after* the read (queue
#: backing up → loss downstream in pack/wire). Logged to stderr, which
#: the host bridges into the System Messages panel.
_RX_STATS_INTERVAL_NS = 2_000_000_000  # 2 s


def _echoes_dropped_field(ch: drv.OpenChannel) -> str:
    """The rx stats line's ``echoes_dropped=`` field: echoes of our own
    frames the driver withheld because the transmitter was error-passive,
    so they carry no proof any node acknowledged them. Running total for
    the channel. Empty for a driver that gates nothing (no
    ``echoes_dropped`` method), so the line does not claim a zero nobody
    counted."""
    read = getattr(ch, "echoes_dropped", None)
    if not callable(read):
        return ""
    return f" echoes_dropped={int(read())}"


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
        # Serialises everything that closes or opens the channel --
        # attach, detach, reconfigure and the state poll's reopens -- so
        # a reopen can run its open without ``_lock`` held: ``transmit``
        # takes ``_lock`` on the session's one request thread and must
        # never wait on hardware (ADR 0060 rule 6). Always taken before
        # ``_lock``, never while holding it.
        self._open_lock = threading.Lock()
        self._config = initial_config
        self._channel: Optional[drv.OpenChannel] = None
        # Why a subscribed interface has no channel: a reopen closed the
        # old channel and the open after it raised. ``None`` otherwise.
        # While it is set the state poll retries the open every pass.
        self._reopen_error: Optional[str] = None
        # The channel most recently swapped away by `reconfigure` and
        # not yet garbage-collected -- lets `_rx_pump` recognise a
        # `recv()` failure on it as the close doing its job, not a
        # fault. See `reconfigure` for why this can't reuse `_stop`.
        self._reconfigure_closing_channel: Optional[drv.OpenChannel] = None
        # Ordered subscriber list; values are gRPC-Session outboxes.
        # We keep it as a list (not a set) so iteration order is
        # deterministic for tests.
        self._outboxes: list[SessionOutbox] = []
        # This interface's bus-error episodes (ADR 0060 rules 1-2). Kept
        # across reopens: a reset or flush mid-fault is the same blast.
        self._episodes = EpisodeAccumulator(channel_id)
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
        # Last rx-overrun count published, or ``None`` for a backend
        # that does not report receive loss at all. The two are
        # different answers -- a backend that watches and has seen none
        # says 0 -- so this is tri-state on purpose and the wire field
        # is left unset for ``None``.
        self._last_rx_overruns: Optional[int] = None
        # Monotonic time of the last `InterfaceState` publish, for the
        # heartbeat. Owned by the state poll.
        self._last_publish_s: Optional[float] = None
        # Rollovers of the backend's own receive timer already reported
        # to subscribers. The driver corrects the stamps; this is what
        # turns each correction into one operator-visible line, and it
        # is only ever compared against the *current* channel's count,
        # so it resets with the baseline below.
        self._reported_timer_wraps = 0
        # When the state poll first read the current run of bus-off, or
        # ``None`` outside one. Owned by the state poll's thread. A reset
        # clears it, so a bus that recovers and drops again is timed from
        # its new start; a reset that fails leaves it, so the next pass
        # that still reads bus-off tries again.
        self._bus_off_since: Optional[float] = None
        # Whether the current bus-off run has already had a reset fail,
        # so a reset that keeps failing warns once per run, not per pass.
        self._bus_off_reset_failing = False
        # The channel and monotonic time of the latest send its driver
        # refused as bus-off (``TxRejected.bus_off``), or ``None``; an
        # accepted send clears it. Written by the tx pump, read by the
        # state poll, which counts it as a bus-off reading (ADR 0039).
        self._bus_off_refused: Optional[tuple[drv.OpenChannel, float]] = None
        # When the rx pump last read anything off the channel (monotonic
        # seconds), and the channel and time of the latest send its
        # driver refused with a full transmit queue. Written by the rx
        # and tx pumps, read by the state poll, each a single reference
        # assignment. ``_last_rx_s`` starts at open and is not reset by
        # a reopen: a fresh channel that is still receiving nothing is
        # the same silence. The refusal carries its channel so that one
        # from a channel already reopened never condemns the fresh one.
        self._last_rx_s = 0.0
        self._queue_full_refused: Optional[tuple[drv.OpenChannel, float]] = None
        # Whether the current run of queue-full reopens has already had
        # one fail, so a failure that repeats warns once per run.
        self._queue_full_reopen_failing = False
        # The channel and time of the first queue-full refusal since its
        # last accepted send (or last flush), or ``None``: how long it
        # has refused everything (ADR 0060 rule 7). Written by the tx
        # pump, read and cleared by the state poll.
        self._queue_full_since: Optional[tuple[drv.OpenChannel, float]] = None
        # Whether this run of flushes -- flushes with no accepted send
        # between them -- has logged its info line, and whether a flush
        # in it has failed, so each says so once per run.
        self._flush_run_logged = False
        self._flush_failing = False
        # Transmit-side counters, emitted alongside the rx stats on the
        # rx pump's periodic tick. `transmit` runs on gRPC handler
        # threads while the tick reads/resets on the rx thread, so a
        # dedicated lightweight lock guards them (held only for the
        # integer updates, never across ``ch.send``). `max_send_ns` is
        # the worst single ``ch.send`` duration in the interval — the
        # signal that distinguishes a host-side late send from a
        # sidecar/driver TX-buffer stall. The count is of frames the
        # driver accepted into its transmit queue, not frames the bus
        # carried: those come back as the driver's echo on the rx path.
        self._tx_stats_lock = threading.Lock()
        self._tx_count = 0
        self._tx_count_total = 0
        self._tx_max_send_ns = 0
        # Sends offered to this interface (every `transmit` call) and
        # refused (by this queue or by the driver) in the interval: with
        # `queued_to_driver` they tell "nothing offered" from "everything
        # refused" in the log, which the accepted count alone cannot.
        self._tx_offered = 0
        self._tx_refused = 0
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
        # on hardware. The queue is bounded, and a full queue refuses the
        # frame at once rather than blocking the reader -- saturation
        # stays visible, and stays this interface's alone.
        self._tx_queue: "queue.Queue[Optional[tuple[drv.Frame, SessionOutbox]]]" = (
            queue.Queue(maxsize=_TX_QUEUE_MAX)
        )
        self._tx_thread: Optional[threading.Thread] = None

    @property
    def channel_id(self) -> str:
        return self._channel_id

    def set_error_row_cap(self, cap: Optional[int]) -> None:
        """The error-row cap for this interface's next episodes (ADR 0060
        rule 2); ``None`` is the default. An open episode keeps its own."""
        self._episodes.set_cap(cap)

    def attach(self, outbox: SessionOutbox) -> None:
        """Register ``outbox`` as a subscriber.

        Opens the underlying channel on the first attach. Pushes the
        current :class:`InterfaceState` snapshot to ``outbox`` so
        every subscriber gets one regardless of when it joined.
        Raises whatever the driver raises (``KeyError`` for unknown id,
        ``OSError`` for open failures) on the *first* attach; later
        attaches reuse the already-open channel -- or, while a failed
        reopen is being retried, join the retry rather than open again.
        """
        with self._open_lock, self._lock:
            if outbox not in self._outboxes:
                self._outboxes.append(outbox)
            if self._channel is None and self._reopen_error is None:
                self._open_locked()
            snapshot_state = self._last_state
            snapshot_tec = self._last_tec
            snapshot_rec = self._last_rec
            snapshot_overruns = self._last_rx_overruns
        outbox.put(
            pb.Envelope(
                interface_state=_interface_state(
                    channel_id=self._channel_id,
                    state=snapshot_state,
                    tec=snapshot_tec,
                    rec=snapshot_rec,
                    rx_overruns=snapshot_overruns,
                )
            )
        )

    def detach(self, outbox: SessionOutbox) -> bool:
        """Drop ``outbox`` from the subscriber list.

        Returns ``True`` when this was the last subscriber and the
        channel has been closed (so the registry can drop the entry).
        """
        with self._open_lock, self._lock:
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

    def transmit(self, frame: drv.Frame, outbox: SessionOutbox) -> None:
        """Queue ``frame`` for the TX worker.

        Raises :class:`drv.TxRejected` synchronously when the interface
        has no channel (closed, or a failed reopen being retried) or its
        TX queue is full -- at once, never waiting (ADR 0060 rule 6): the
        caller is the session's one request thread, and every other
        interface on the session is behind it. Refusals discovered on the
        worker are counted into ``outbox``'s refusal summary for this
        interface.
        """
        with self._tx_stats_lock:
            self._tx_offered += 1
        with self._lock:
            ch = self._channel
            reopen_error = self._reopen_error
        try:
            if ch is None:
                raise self._no_channel_refusal(reopen_error)
            try:
                self._tx_queue.put_nowait((frame, outbox))
            except queue.Full:
                raise drv.TxRejected(
                    f"{self._channel_id}: tx queue full ({_TX_QUEUE_MAX} frames)",
                    reason=drv.REFUSAL_QUEUE_FULL,
                ) from None
        except drv.TxRejected:
            with self._tx_stats_lock:
                self._tx_refused += 1
            raise

    def _no_channel_refusal(self, reopen_error: Optional[str]) -> drv.TxRejected:
        """The refusal of a send offered while there is no channel: the
        interface is closed, or -- ``reopen_error`` set -- a reopen
        closed the old channel and could not open the fresh one, which
        the state poll is retrying."""
        cid = self._channel_id
        if reopen_error is None:
            message = f"{cid}: interface closed"
        else:
            message = f"{cid}: no channel, reopen failed and is retried: {reopen_error}"
        return drv.TxRejected(message, reason=drv.REFUSAL_CLOSED)

    def _tx_pump(self) -> None:
        """TX worker thread. Drains the per-interface queue and owns
        every ``ch.send``: a slow send (device TX-buffer stall,
        python-can overhead) delays only this interface's queue, never
        the gRPC reader thread. Send timing feeds the periodic tx-stats
        line: `max_send` is the worst single send in the interval,
        `max_gap` the worst idle between sends (upstream delivery
        burstiness) - reading both disambiguates where a stall lives."""
        cid = self._channel_id
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
            with self._lock:
                ch = self._channel
                reopen_error = self._reopen_error
            if ch is None:
                self._count_tx_refused()
                refusal = self._no_channel_refusal(reopen_error)
                outbox.refuse(cid, refusal.reason, str(refusal))
                continue
            t0 = time.monotonic_ns()
            try:
                ch.send(frame)
            except drv.TxRejected as e:
                self._count_tx_refused()
                self._note_tx_refused(ch, e, now_s=time.monotonic())
                outbox.refuse(cid, e.reason, str(e))
                continue
            except Exception as e:  # noqa: BLE001 - worker must survive
                msg = f"send on {cid} failed: {e}"
                _log.warning(msg)
                self._count_tx_refused()
                outbox.refuse(cid, drv.REFUSAL_OTHER, msg)
                continue
            self._note_tx_accepted(ch, now_s=time.monotonic())
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
        new channel on its next loop iteration — but only when
        ``new_config`` actually differs from the live one. A
        ``ConfigureBus`` that changes nothing on the open side (the
        error-row cap travels separately, via
        :meth:`set_error_row_cap`) is a no-op here, so a cap-only
        change does not drop and re-initialise a live bus (ADR 0060).
        The old channel is closed before the new one is opened (see
        :meth:`_replace_channel`), so if the open fails the interface is
        left with no channel: a ``LogMessage`` goes to every subscriber,
        the state reads unavailable, and the state poll retries the open
        with this config every pass. While a failed reopen is being
        retried, a reconfigure only changes the config the retry uses.
        """
        with self._open_lock:
            with self._lock:
                old = self._channel
                unchanged = old is not None and new_config == self._config
                self._config = new_config
            if old is None:
                _log.debug(
                    "reconfigure %s deferred to next open: %r",
                    self._channel_id,
                    new_config,
                )
                return
            if unchanged:
                _log.debug(
                    "reconfigure %s: open config unchanged, not reopening: %r",
                    self._channel_id,
                    new_config,
                )
                return
            _log.debug("reopening %s with %r", self._channel_id, new_config)
            try:
                self._replace_channel(old)
            except Exception as e:  # noqa: BLE001
                msg = f"reconfigure {self._channel_id} failed: {e}"
                _log.warning(msg)
                # The traceback goes to the debug sink only: the warning
                # above is what stderr (and so the System Messages panel)
                # already carried, and raising the file's detail must not
                # raise the panel's.
                _log.debug("reconfigure %s failed", self._channel_id, exc_info=True)
                self._broadcast_error(pb.LOG_LEVEL_ERROR, msg)
                return
            with self._lock:
                self._reset_state_baseline_locked()

    def _replace_channel(self, old: Optional[drv.OpenChannel]) -> drv.OpenChannel:
        """Close ``old`` -- the current channel, or ``None`` when a failed
        reopen left none -- then open a fresh channel with the current
        config and make it the current one. The caller holds
        :attr:`_open_lock` and not :attr:`_lock`.

        Close first, open second (ADR 0039): a handle cannot be opened
        twice by one process -- PCAN-Basic answers ``CAN_Initialize`` on
        a handle this process still holds with ``PCAN_ERROR_INITIALIZE``,
        every time -- so an open made while the old channel is still
        held can never succeed on PEAK.

        If the open raises, the interface has no channel: the closed one
        is not left current, where it would read as a channel that is
        fine, and the receive pump would spin on reads that return at
        once. :attr:`_reopen_error` says why, sends are refused with it,
        ``unavailable`` is published, and the state poll retries the open
        every pass (:meth:`_retry_open`). Re-raises what the open raised.

        The published state is deliberately left alone on success:
        subscribers were told what the old channel read, and the next
        pass has to be able to tell them otherwise. Counts restart with
        the fresh channel.
        """
        with self._lock:
            self._channel = None
            # `old` is about to be closed out from under any in-flight
            # `ch.recv()` the rx pump is blocked on -- the same race
            # `_close_locked` has, but this is a swap, not a shutdown,
            # so `_stop` stays clear (overloading it here would make a
            # genuine shutdown mid-swap look like a swap instead).
            if old is not None:
                self._reconfigure_closing_channel = old
            config = self._config
        if old is not None:
            self._close_swapped(old)
        try:
            new = self._driver.open(self._channel_id, config)
        except Exception as e:
            with self._lock:
                self._reopen_error = str(e) or type(e).__name__
            self._publish_state(pb.CONTROLLER_STATE_UNAVAILABLE, 0, 0, None)
            raise
        with self._lock:
            self._channel = new
            self._reopen_error = None
            self._last_rx_overruns = None
            self._reported_timer_wraps = 0
        return new

    @staticmethod
    def _close_swapped(old: drv.OpenChannel) -> None:
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
        self._last_rx_s = time.monotonic()
        self._queue_full_refused = None
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
        # Nobody left to reopen it for: the retry ends here.
        self._reopen_error = None
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
        # A reopened channel counts overruns from zero, and the wire
        # field says "since it was opened", so the baseline drops the
        # previous channel's total rather than carrying it forward.
        self._last_rx_overruns = None
        # Same reasoning, and the stakes are higher: a fresh channel's
        # timer-rollover count starts at zero too, so a report left at
        # the old channel's total would swallow the new channel's first
        # rollover entirely.
        self._reported_timer_wraps = 0

    def _current_channel(self) -> Optional[drv.OpenChannel]:
        with self._lock:
            return self._channel

    def _outbox_snapshot(self) -> list[SessionOutbox]:
        with self._lock:
            return list(self._outboxes)

    def _broadcast_error(self, level: "pb.LogLevel.V", message: str) -> None:
        """Fan a ``LogMessage`` envelope out to every subscribed outbox.

        Builds the envelope once and puts it on each subscriber's outbox.
        Takes :attr:`_lock`, which is not reentrant: never call it with
        the lock held.
        """
        env = _log_envelope(level, message)
        for ob in self._outbox_snapshot():
            ob.put(env)

    def _note_error_frame(
        self, ch: drv.OpenChannel, frame: drv.Frame, now_s: float
    ) -> bool:
        """Fold an error frame into the interface's bus-error episode
        (ADR 0060 rule 1) and publish what that opens or closes. Returns
        whether the frame is one of the episode's first-N rows (rule 2);
        the rest are counted and not forwarded.

        The driver says what it can about the frame through its optional
        ``classify_error``; one that does not, or fails to, has the frame
        counted as kind ``unknown``.
        """
        classify = getattr(ch, "classify_error", None)
        err = drv.BusError()
        if callable(classify):
            try:
                err = classify(frame)
            except Exception:  # noqa: BLE001 - one frame, not the pump
                err = drv.BusError()
        row, reports = self._episodes.on_error(err, frame.timestamp_ns, now_s)
        self._publish_episodes(reports)
        return row

    def _publish_episodes(self, reports: list[pb.BusErrorEpisode]) -> None:
        if not reports:
            return
        outboxes = self._outbox_snapshot()
        for report in reports:
            env = pb.Envelope(bus_error_episode=report)
            for ob in outboxes:
                ob.put(env)

    def _rx_pump(self) -> None:
        """Reader thread. Stays minimal so PCAN's recv queue drains as
        fast as physically possible: block on ``ch.recv``, push the raw
        ``Frame`` onto ``self._rx_queue``, repeat. Protobuf encoding,
        batching, and outbox fan-out happen on the packer thread.

        Error frames are the exception to "push every frame": each is
        folded into the interface's bus-error episode here, and only the
        episode's first N go on to the packer as rows (ADR 0060)."""
        cid = self._channel_id
        read = 0
        read_total = 0
        # Error frames and echoes of our own frames read in the stats
        # interval: with `read=` they tell a fault (errors) from our
        # queue draining (echoes) from traffic on the bus.
        errors = 0
        echoes = 0
        # Whether the current read is inside a run of failures, so the
        # 10 Hz retry loop reports one line per episode rather than one
        # per attempt.
        read_failing = False
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
                    # One line per episode. The retry below runs at
                    # 10 Hz for as long as the fault lasts, and the
                    # operator's log is a panel with a rate-limit
                    # budget, not a trace: repeating the same sentence
                    # ten times a second buries everything else. A read
                    # that succeeds re-arms it, so a second episode is
                    # still reported.
                    if not read_failing:
                        read_failing = True
                        _log.warning("rx for %s failed: %s", cid, e)
                    if self._stop.wait(0.1):
                        break
                    continue
                read_failing = False
                if frame is not None:
                    now_s = time.monotonic()
                    self._note_rx(now_s=now_s)
                    read += 1
                    read_total += 1
                    if frame.kind == drv.FrameKind.ERROR:
                        errors += 1
                        if self._note_error_frame(ch, frame, now_s):
                            self._rx_queue.put(frame)
                    else:
                        if not frame.is_rx:
                            echoes += 1
                        self._publish_episodes(
                            self._episodes.on_frame(frame.timestamp_ns)
                        )
                        self._rx_queue.put(frame)
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
                        offered = self._tx_offered
                        refused = self._tx_refused
                        self._tx_count = 0
                        self._tx_max_send_ns = 0
                        self._tx_max_gap_ns = 0
                        self._tx_offered = 0
                        self._tx_refused = 0
                    if read > 0 or tx > 0 or offered > 0:

                        def per_s(n: int) -> float:
                            return n / secs if secs > 0 else 0.0

                        _log.info(
                            "rx stats %s: read=%.0f/s total=%d queue=%d "
                            "errors=%.0f/s echoes=%.0f/s%s",
                            cid,
                            per_s(read),
                            read_total,
                            self._rx_queue.qsize(),
                            per_s(errors),
                            per_s(echoes),
                            _echoes_dropped_field(ch),
                        )
                        _log.info(
                            "tx stats %s: queued_to_driver=%.0f/s total=%d "
                            "offered=%.0f/s refused=%.0f/s "
                            "max_send=%.2f ms max_gap=%.2f ms",
                            cid,
                            per_s(tx),
                            tx_total,
                            per_s(offered),
                            per_s(refused),
                            tx_max_ns / 1e6,
                            tx_max_gap_ns / 1e6,
                        )
                    read = errors = echoes = 0
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
                return frame_to_proto(frame)
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

    def _publish_state(
        self,
        mapped: "pb.ControllerState.V",
        tec: int,
        rec: int,
        rx_overruns: Optional[int] = None,
        *,
        now_s: Optional[float] = None,
    ) -> None:
        """Broadcast an :class:`InterfaceState` if this differs from the
        last one published, or if the last one is a heartbeat old. The
        single place a controller state leaves the interface, so the
        state poll and any other discovery of the controller's condition
        cannot disagree about what subscribers were last told.

        ``now_s`` is the poll's monotonic reading. An unchanged reading
        is republished once :data:`_STATE_HEARTBEAT_S` has passed since
        the last publish (ADR 0060 rule 5): every envelope carries when
        it was read, so a reader can tell a reading that has stopped
        arriving from one that is simply unchanged. Republishing costs
        one keyed slot on each session's control lane, which a newer
        reading replaces.

        ``rx_overruns`` rides the same envelope and the same gate: it
        moves rarely (a bus that is losing frames is a bus in trouble,
        not a bus at work)."""
        with self._lock:
            unchanged = (
                mapped == self._last_state
                and tec == self._last_tec
                and rec == self._last_rec
                and rx_overruns == self._last_rx_overruns
            )
            due = (
                now_s is not None
                and self._last_publish_s is not None
                and now_s - self._last_publish_s >= _STATE_HEARTBEAT_S
            )
            if unchanged and not due:
                return
            self._last_state = mapped
            self._last_tec = tec
            self._last_rec = rec
            self._last_rx_overruns = rx_overruns
            if now_s is not None:
                self._last_publish_s = now_s
            outboxes = list(self._outboxes)
        env = pb.Envelope(
            interface_state=_interface_state(
                channel_id=self._channel_id,
                state=mapped,
                tec=tec,
                rec=rec,
                rx_overruns=rx_overruns,
            )
        )
        for ob in outboxes:
            ob.put(env)

    def _state_pump(self) -> None:
        while not self._stop.is_set():
            if self._stop.wait(_STATE_POLL_INTERVAL_S):
                break
            self._poll_pass(now_s=time.monotonic())

    def _poll_pass(self, *, now_s: float) -> None:
        """One state-poll pass: :meth:`_poll_state` on the current
        channel, or, when a failed reopen left none, another try at the
        open (:meth:`_retry_open`)."""
        ch = self._current_channel()
        if ch is None:
            self._retry_open(now_s)
            return
        self._poll_state(ch, now_s=now_s)

    def _retry_open(self, now_s: float) -> None:
        """Try again the open a reopen could not complete. Once a pass --
        the poll's own cadence, never a tighter loop -- for as long as
        the interface is subscribed and has no channel. A failure is
        logged at debug (the first one was warned where it happened) and
        keeps the state ``unavailable``; success is logged at info, as
        the bus-off line when a bus-off reset had asked for the reopen."""
        cid = self._channel_id
        with self._open_lock:
            with self._lock:
                if (
                    self._channel is not None
                    or self._reopen_error is None
                    or self._stop.is_set()
                ):
                    return
            try:
                self._replace_channel(None)
            except Exception as e:  # noqa: BLE001
                _log.debug("reopen of %s failed again: %s", cid, e)
                self._publish_state(
                    pb.CONTROLLER_STATE_UNAVAILABLE, 0, 0, None, now_s=now_s
                )
                self._publish_episodes(self._episodes.tick(now_s, 0, 0))
                return
        # Whichever recovery's reopen failed, its run of failures is over.
        self._queue_full_reopen_failing = False
        self._flush_failing = False
        since = self._bus_off_since
        if since is not None:
            _log.info(
                "%s was bus-off for %.1f s; reopened the channel", cid, now_s - since
            )
            self._bus_off_since = None
            self._bus_off_reset_failing = False
        else:
            _log.info("%s reopened the channel after a failed open", cid)

    def _poll_state(self, ch: drv.OpenChannel, *, now_s: float) -> None:
        """One pass of the state poll: read the controller, publish what
        it says, republish or close the open bus-error episode, and
        recover the channel -- reset it if it has read bus-off for longer
        than it could take to come back by itself, reopen it if its queue
        is full in silence, flush it if its queue has accepted nothing
        for a second. ``now_s`` is a monotonic reading, passed in so the
        thresholds can be tested without waiting them out.

        A send the driver refused as bus-off within the last
        :data:`_BUS_OFF_RESET_AFTER_S` counts as a bus-off reading
        whatever the state read says (ADR 0039): PEAK's status word and
        its writes can disagree, and after a failed open the status word
        reads unavailable while the writes still refuse."""
        cid = self._channel_id
        self._report_timer_wraps(ch)
        if self._last_publish_s is None:
            # The heartbeat counts from the first pass: the subscribe
            # snapshot was each session's own, not a publish to all.
            self._last_publish_s = now_s
        refused = self._bus_off_refused
        refusing_bus_off = (
            refused is not None
            and refused[0] is ch
            and now_s - refused[1] < _BUS_OFF_RESET_AFTER_S
        )
        try:
            st = ch.state()
        except Exception as e:  # noqa: BLE001
            # A controller read that fails is not silence: the
            # driver could not reach the interface. Publishing that
            # is the whole point of the poll — swallowing it left an
            # unplugged adapter reading error-active forever.
            _log.debug("state poll for %s failed: %s", cid, e)
            self._publish_state(
                pb.CONTROLLER_STATE_UNAVAILABLE,
                0,
                0,
                self._read_rx_overruns(ch),
                now_s=now_s,
            )
            self._publish_episodes(self._episodes.tick(now_s, 0, 0))
            if refusing_bus_off:
                self._time_bus_off(ch, now_s)
            else:
                self._bus_off_since = None
            return
        self._publish_state(
            _state_name_to_proto(st.state),
            st.tec,
            st.rec,
            self._read_rx_overruns(ch),
            now_s=now_s,
        )
        self._publish_episodes(self._episodes.tick(now_s, st.tec, st.rec))
        if st.state != drv.STATE_BUS_OFF and not refusing_bus_off:
            self._bus_off_since = None
            self._bus_off_reset_failing = False
            if not self._reopen_if_queue_full_in_silence(ch, now_s):
                self._flush_if_queue_stuck(ch, now_s)
            return
        self._time_bus_off(ch, now_s)

    def _time_bus_off(self, ch: drv.OpenChannel, now_s: float) -> None:
        """This pass read ``ch`` bus-off: start the run, or reset the
        controller once the run is :data:`_BUS_OFF_RESET_AFTER_S` old."""
        if self._bus_off_since is None:
            self._bus_off_since = now_s
            return
        if now_s - self._bus_off_since >= _BUS_OFF_RESET_AFTER_S:
            self._reset_bus_off(ch, now_s - self._bus_off_since)

    def _flush_if_queue_stuck(self, ch: drv.OpenChannel, now_s: float) -> None:
        """Flush the transmit queue of a channel whose driver has refused
        every send as queue-full for :data:`_STUCK_QUEUE_FLUSH_AFTER_S`,
        with none accepted, whether or not frames are arriving (ADR 0060
        rule 7). The caller has already ruled out bus-off.

        Refusals that have stopped are not a stuck queue -- nobody is
        sending, so nothing says it is not draining -- so the latest
        queue-full refusal must also fall inside the window. A flush
        restarts the window, so while the shape persists the channel is
        flushed at most once per window.

        In place through the driver's ``flush_tx`` where it has one,
        otherwise by reopening the channel. Each flush is counted into
        every subscribed session's queue-full refusal summary; the first
        of a run is logged at info, the rest at debug.
        """
        since = self._queue_full_since
        refused = self._queue_full_refused
        if (
            since is None
            or since[0] is not ch
            or refused is None
            or refused[0] is not ch
        ):
            return
        window = _STUCK_QUEUE_FLUSH_AFTER_S
        if now_s - since[1] < window or now_s - refused[1] >= window:
            return
        cid = self._channel_id
        try:
            flush = getattr(ch, "flush_tx", None)
            in_place = bool(flush()) if callable(flush) else False
            if not in_place and not self._reopen(ch):
                return
        except Exception as e:  # noqa: BLE001
            if not self._flush_failing:
                self._flush_failing = True
                _log.warning("transmit-queue flush of %s failed: %s", cid, e)
            else:
                _log.debug("transmit-queue flush of %s failed again: %s", cid, e)
            return
        self._queue_full_since = None
        self._flush_failing = False
        how = "flushed its transmit queue" if in_place else "reopened the channel"
        if not self._flush_run_logged:
            self._flush_run_logged = True
            _log.info(
                "%s refused every send with its transmit queue full for %.1f s; %s",
                cid,
                now_s - since[1],
                how,
            )
        else:
            _log.debug("%s still refusing queue-full; %s again", cid, how)
        now_ns = time.time_ns()
        for ob in self._outbox_snapshot():
            ob.note_flush(cid, now_ns=now_ns)

    def _reset_bus_off(self, ch: drv.OpenChannel, held_s: float) -> None:
        """Reset a controller latched bus-off (ADR 0039): in place
        through the driver's ``reset`` where it has one, otherwise by
        reopening the channel with its current config.

        Bus-off is transient by nature -- the bus is usable again the
        moment whatever drove the controller off it is gone -- but a
        controller that is bus-off transmits nothing, so its error
        counters cannot fall and nothing on the wire brings it back.
        """
        cid = self._channel_id
        try:
            reset = getattr(ch, "reset", None)
            in_place = bool(reset()) if callable(reset) else False
            if not in_place and not self._reopen(ch):
                # Swapped or closed since this pass read it; the fresh
                # channel gets its own count.
                self._bus_off_since = None
                return
        except Exception as e:  # noqa: BLE001
            # Retried on the next pass -- the poll's own cadence, never a
            # tighter loop: a reset that raised, on the next pass that
            # still reads bus-off; an open that raised after the close,
            # by the poll's retry of the open, while this run's start
            # stays for its log line. One warning per run of failures;
            # the rest go to the debug sink.
            if not self._bus_off_reset_failing:
                self._bus_off_reset_failing = True
                _log.warning("bus-off reset of %s failed: %s", cid, e)
            else:
                _log.debug("bus-off reset of %s failed again: %s", cid, e)
            return
        _log.info(
            "%s was bus-off for %.1f s; %s",
            cid,
            held_s,
            "reset the controller" if in_place else "reopened the channel",
        )
        self._bus_off_since = None
        self._bus_off_reset_failing = False

    def _reopen(self, ch: drv.OpenChannel) -> bool:
        """Close ``ch``, then open a fresh channel with the current
        config, through :meth:`_replace_channel` as a bus configuration
        change does. ``False`` when ``ch`` is no longer the current
        channel, so there was nothing to reopen. Raises whatever the open
        raises, with ``ch`` closed and no channel current; the state
        poll retries the open from there."""
        with self._open_lock:
            with self._lock:
                if self._channel is not ch:
                    return False
            self._replace_channel(ch)
        return True

    def _note_rx(self, *, now_s: float) -> None:
        """The rx pump read a frame -- data, echo or error frame -- at
        monotonic ``now_s``."""
        self._last_rx_s = now_s

    def _note_tx_refused(
        self, ch: drv.OpenChannel, error: drv.TxRejected, *, now_s: float
    ) -> None:
        """The driver refused a send on ``ch`` at monotonic ``now_s``.
        Only a full transmit queue is remembered, by the driver's own
        classification (:attr:`~cannet_local_sidecar.driver.TxRejected
        .queue_full`): the latest such refusal for the silent-queue
        reopen, and the first since the last accepted send for the
        stuck-queue flush. A refusal the driver classified as bus-off
        (:attr:`~cannet_local_sidecar.driver.TxRejected.bus_off`) is
        remembered too, for the bus-off reset."""
        if error.queue_full:
            self._queue_full_refused = (ch, now_s)
            since = self._queue_full_since
            if since is None or since[0] is not ch:
                self._queue_full_since = (ch, now_s)
        if getattr(error, "bus_off", False):
            self._bus_off_refused = (ch, now_s)

    def _note_tx_accepted(self, ch: drv.OpenChannel, *, now_s: float) -> None:
        """The driver accepted a send on ``ch`` at monotonic ``now_s``:
        its queue is draining, so the stuck-queue second starts over and
        the next flush, if one comes, starts a new run; and a controller
        taking frames is not bus-off, whatever an earlier refusal said."""
        self._bus_off_refused = None
        self._queue_full_since = None
        self._flush_run_logged = False
        self._flush_failing = False

    def _count_tx_refused(self) -> None:
        with self._tx_stats_lock:
            self._tx_refused += 1

    def _reopen_if_queue_full_in_silence(
        self, ch: drv.OpenChannel, now_s: float
    ) -> bool:
        """Reopen a channel whose controller has stopped transmitting
        without saying so (ADR 0039): its driver has refused a send with
        a full transmit queue within the last
        :data:`_QUEUE_FULL_SILENCE_REOPEN_AFTER_S`, and nothing at all
        has been received for that long. Returns whether it tried, so
        the same pass does not also flush.

        Silence without refusals is an idle bus. A full queue while
        frames arrive is flushed instead (ADR 0060 rule 7), which empties
        the queue without re-initialising a controller that is working;
        a controller that is neither sending nor erroring -- the shape a
        PEAK channel took when its driver reset it from bus-off behind a
        full transmit queue -- needs the re-initialisation, which only a
        reopen gives. Checked once per state-poll pass, so a shape that
        persists is reopened at most once a pass.
        """
        refused = self._queue_full_refused
        if refused is None or refused[0] is not ch:
            return False
        window = _QUEUE_FULL_SILENCE_REOPEN_AFTER_S
        silent_s = now_s - self._last_rx_s
        if silent_s < window or now_s - refused[1] >= window:
            return False
        cid = self._channel_id
        try:
            if not self._reopen(ch):
                return True
        except Exception as e:  # noqa: BLE001
            if not self._queue_full_reopen_failing:
                self._queue_full_reopen_failing = True
                _log.warning("queue-full reopen of %s failed: %s", cid, e)
            else:
                _log.debug("queue-full reopen of %s failed again: %s", cid, e)
            return True
        self._queue_full_reopen_failing = False
        _log.info(
            "%s refused sends with its transmit queue full and received "
            "nothing for %.1f s; reopened the channel",
            cid,
            silent_s,
        )
        return True

    def _report_timer_wraps(self, ch: drv.OpenChannel) -> None:
        """Emit one WARNING ``LogMessage`` per rollover of the channel's
        receive timer that subscribers have not been told about yet.

        The driver corrects the timestamps on its own receive thread
        (python-can's Kvaser backend reads a 32-bit tick counter and
        adds no rollover handling of its own), which leaves nothing in
        the frame stream to show that it happened -- a corrected capture
        looks exactly like one that never wrapped. The count is the only
        evidence, so the state poll reads it on its own cadence, the
        same way it reads the overrun count, and the operator's system
        log carries a line per rollover. A rollover is an 11 h 56 m
        event, so reporting it up to half a second late costs nothing
        and keeps the receive thread in its recv loop.

        Backends with no rollovers to report have no ``timer_wraps`` at
        all; the read failing is that answer, not a fault.
        """
        try:
            wraps = int(ch.timer_wraps())
        except Exception:  # noqa: BLE001
            return
        while self._reported_timer_wraps < wraps:
            self._reported_timer_wraps += 1
            self._broadcast_error(
                pb.LOG_LEVEL_WARN,
                f"{self._channel_id}: adapter receive timer wrapped "
                f"(#{self._reported_timer_wraps} since open); receive "
                f"timestamps after it are being corrected",
            )

    def _read_rx_overruns(self, ch: drv.OpenChannel) -> Optional[int]:
        """The channel's rx-overrun count, or the last one published if
        this read failed.

        The counters are unlike the state beside them: the state is a
        reading of how the controller is *now*, so a failed read must
        replace it, while an overrun count is a record of frames already
        lost. Losing sight of the channel does not un-lose them, so a
        read that fails keeps the last figure rather than retracting it
        to ``None``.

        Read immediately after :meth:`~cannet_local_sidecar.driver
        .OpenChannel.state`, which is the contract that lets a backend
        derive both from one device read.
        """
        try:
            return ch.rx_loss()
        except Exception:  # noqa: BLE001
            with self._lock:
                return self._last_rx_overruns


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
        # Error-row caps from `ConfigureBus` (ADR 0060 rule 2), kept like
        # the configs so a cap that arrives before the open applies to it.
        self._caps: dict[str, Optional[int]] = {}

    def subscribe(
        self,
        channel_id: str,
        outbox: SessionOutbox,
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
                shared.set_error_row_cap(self._caps.get(channel_id))
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
        outbox: SessionOutbox,
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

    def set_error_row_cap(self, channel_id: str, cap: Optional[int]) -> None:
        """The error-row cap for ``channel_id`` (ADR 0060 rule 2);
        ``None`` restores the default. Takes effect from the interface's
        next bus-error episode, and is remembered for its next open."""
        with self._lock:
            self._caps[channel_id] = cap
            shared = self._interfaces.get(channel_id)
        if shared is not None:
            shared.set_error_row_cap(cap)

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
        outbox: SessionOutbox,
    ) -> None:
        with self._lock:
            shared = self._interfaces.get(channel_id)
        if shared is None:
            raise KeyError(channel_id)
        shared.transmit(frame, outbox)
