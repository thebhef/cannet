"""One gRPC ``Session`` stream, and the semantics it keeps.

This is the wire layer: it dials the server, opens the bidirectional
``Session`` stream, and pumps envelopes in both directions on a worker
thread. :mod:`cannet_python_client.bus` is the python-can face over it.

The rules here are `cannet-client`'s, deliberately, so a hardware
server sees the same client whichever language it is talking to:

- **``ConfigureBus`` precedes the ``Subscribe`` it configures.** The
  controller then opens at the requested rate the first time round;
  the other order costs a close+reopen, and frames go missing in that
  window.
- **A factory id waits for its allocation.** Subscribing to a
  virtual-bus factory (ADR 0021) is answered with an
  ``InterfaceAllocated`` naming the participant, and that id — not the
  factory id — is what transmits are addressed to. An ordinary
  subscribe has no acknowledgement, so it is ready as soon as it is
  sent: waiting on a reply that a server has no reason to send would
  trade a working session for an indefinite stall.
- **Per-frame errors do not end the session.** ``TX_REJECTED``,
  ``NOT_SUBSCRIBED`` and ``NO_ACKNOWLEDGER`` each describe one
  transmit; they are tallied on :class:`PerFrameErrors` and the stream
  goes on. Every other code — including one this build does not
  recognise, so a future variant cannot be swallowed in silence — ends
  the session and is raised to the reader.
- **Delivered timestamps are corrected for the peer's clock**, via the
  SNTP probe :mod:`cannet_python_client.clock` runs over this same
  stream. A peer that never answers degrades to raw stamps rather than
  holding a session up.

Frame encoding is the sidecar's, imported rather than reimplemented:
`cannet_python_can` holds the checked-in gencode and the
``can.Message`` <-> wire ``Frame`` mappers, and a second copy here
could only drift from it.
"""

from __future__ import annotations

import contextlib
import dataclasses
import logging
import queue
import threading
import time
from collections.abc import Iterator, Sequence
from typing import Any

import grpc
from cannet_python_can._proto import cannet_pb2 as pb
from cannet_python_can._proto import cannet_pb2_grpc as pb_grpc
from cannet_python_can.driver import Frame
from cannet_python_can.driver_python_can import frame_to_message, message_to_frame
from cannet_python_can.server.helpers import frame_to_proto, proto_to_frame

from . import clock, tls
from .trust import ServerTarget

_log = logging.getLogger(__name__)

#: Scheme of the virtual-bus factory ids defined by ADR 0021. A bare
#: id under it is a factory; the allocated participants and the bridges
#: hang off it with a `/` and are ordinary interfaces.
_VIRTUAL_SCHEME = "virtual:"

#: The three codes that describe one transmit rather than the session.
_PER_FRAME_CODES = frozenset(
    {
        pb.Error.CODE_TX_REJECTED,
        pb.Error.CODE_NOT_SUBSCRIBED,
        pb.Error.CODE_NO_ACKNOWLEDGER,
    }
)

#: How long the constructor waits for an allocation before giving up.
DEFAULT_OPEN_TIMEOUT_S = 15.0

#: How long a one-shot `ListInterfaces` call (used by detection) waits
#: for a server to answer. Short: a server that is off or unreachable
#: must not eat much of the caller's own detection budget.
DEFAULT_LIST_TIMEOUT_S = 2.0


def _wall_clock_ns() -> int:
    """Wall-clock nanoseconds since the Unix epoch — the clock the
    wire's timestamps are on, and therefore the one whose distance from
    the server's is worth measuring."""
    return time.time_ns()


class SessionError(Exception):
    """The session failed, or the server ended it with a fatal code."""


class SessionClosed(SessionError):
    """The session is no longer alive."""


@dataclasses.dataclass(frozen=True)
class BusConfig:
    """Hardware configuration to apply before subscribing."""

    bitrate: int | None
    fd: bool
    data_bitrate: int | None


@dataclasses.dataclass
class RejectionTally:
    """One per-frame error code's running tally."""

    code: int
    count: int
    last_message: str


class PerFrameErrors:
    """Per-frame errors the peer reported, counted by code.

    A **tally, not a log**: a peer refusing transmits at bus rate
    produces thousands a second, so what is kept is a count per code
    plus the newest message. Nothing here grows with session length.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_code: dict[int, RejectionTally] = {}

    def record(self, code: int, message: str) -> bool:
        """Record one per-frame error, returning whether it is the first
        of its code.

        A code that is not a per-frame one is dropped rather than
        counted as a guess — it ends the session and reaches the reader
        another way.
        """
        if not is_per_frame_error(code):
            return False
        with self._lock:
            tally = self._by_code.get(code)
            first = tally is None
            if tally is None:
                tally = RejectionTally(code=code, count=0, last_message="")
                self._by_code[code] = tally
            tally.count += 1
            if message:
                tally.last_message = message
        return first

    def snapshot(self) -> list[RejectionTally]:
        """Every code reported so far, in code order."""
        with self._lock:
            return [dataclasses.replace(t) for _, t in sorted(self._by_code.items())]

    @property
    def total(self) -> int:
        """Total reported across every code — the one number a readout
        polls to see whether anything moved."""
        with self._lock:
            return sum(t.count for t in self._by_code.values())


def is_per_frame_error(code: int) -> bool:
    """Whether ``code`` refers to one transmit rather than the session."""
    return code in _PER_FRAME_CODES


def wants_allocation(interface_id: str) -> bool:
    """Whether subscribing to ``interface_id`` allocates a participant.

    A bare ``virtual:`` id is a factory (ADR 0021). The ids that hang
    off one — the allocated participants, the bridges — are ordinary
    interfaces and allocate nothing.
    """
    return interface_id.startswith(_VIRTUAL_SCHEME) and "/" not in interface_id


def batch_belongs(
    interface_id: str, *, effective_id: str, factory_id: str | None
) -> bool:
    """Whether a ``FrameBatch`` tagged ``interface_id`` is this bus's.

    A virtual bus tags each fan-out batch with the *sender's* allocated
    id (ADR 0021), not the receiver's, so a factory subscription takes
    everything under its factory id — that is the whole set of
    participants on the bus it joined. ``factory_id`` is ``None`` for an
    ordinary subscription, which takes only its own id.
    """
    if interface_id == effective_id:
        return True
    return factory_id is not None and interface_id.startswith(f"{factory_id}/")


def opening_envelopes(
    interface_id: str, *, config: BusConfig | None
) -> list[pb.Envelope]:
    """The envelopes that open a subscription, in the order they go out."""
    envelopes = []
    if config is not None:
        envelopes.append(
            pb.Envelope(
                configure_bus=pb.ConfigureBus(
                    interface_id=interface_id,
                    speed_bps=config.bitrate or 0,
                    fd_data_speed_bps=(config.data_bitrate or 0) if config.fd else 0,
                    fd_enabled=config.fd,
                )
            )
        )
    envelopes.append(pb.Envelope(subscribe=pb.Subscribe(interface_id=interface_id)))
    return envelopes


def _bearer_metadata(target: ServerTarget) -> list[tuple[str, str]]:
    """The credential to attach to every RPC on this connection.

    Built once per connection rather than per call: the token gates
    *every* RPC on a protected server (ADR 0041), so the only way not
    to forget it is to not have the choice at the call site.
    """
    if not target.token:
        return []
    return [("authorization", f"Bearer {target.token}")]


def open_channel(target: ServerTarget, timeout: float) -> grpc.Channel:
    """Dial ``target``, terminating TLS against its pin when it has one."""
    if target.plaintext:
        return grpc.insecure_channel(target.address)
    assert target.fingerprint is not None
    der, names = tls.peer_certificate(target.host, target.port, timeout)
    tls.check_pin(der, target.fingerprint)
    return grpc.secure_channel(
        target.address,
        tls.channel_credentials(der),
        options=[
            ("grpc.ssl_target_name_override", tls.target_name(names, target.host)),
        ],
    )


def list_interfaces(target: ServerTarget, timeout: float) -> list[pb.Interface]:
    """One-shot ``ListInterfaces`` against ``target``: dial, ask, hang up.

    Used by detection (:func:`cannet_python_client.bus.CannetBus._detect_available_configs`),
    which needs a snapshot and nothing else — no ``Session``, no
    subscribe. The channel opens and closes within this call, same as
    the Rust client's own ``list_interfaces``.
    """
    channel = open_channel(target, timeout)
    try:
        stub = pb_grpc.CannetServerStub(channel)
        response = stub.ListInterfaces(
            pb.ListInterfacesRequest(),
            timeout=timeout,
            metadata=_bearer_metadata(target),
        )
        return list(response.interfaces)
    finally:
        channel.close()


class _EndOfStream:
    """Queue sentinel: the response stream is over."""


class Session:
    """One open ``Session`` stream against one interface.

    Frames arrive on a worker thread and are handed out by
    :meth:`recv`; :meth:`send` puts a one-frame ``FrameBatch`` on the
    request stream. Closing is idempotent.
    """

    def __init__(
        self,
        target: ServerTarget,
        interface_id: str,
        *,
        config: BusConfig | None = None,
        allocates: bool | None = None,
        timeout: float = DEFAULT_OPEN_TIMEOUT_S,
    ) -> None:
        self.target = target
        self.requested_id = interface_id
        self.rejections = PerFrameErrors()
        self.controller_state: int | None = None
        #: What this session has learned about the peer's clock (see
        #: :mod:`cannet_python_client.clock`). Readable from any thread;
        #: `Message.timestamp` values delivered by :meth:`recv` are
        #: already corrected by it.
        self.clock = clock.SessionClock()

        self._allocates = (
            wants_allocation(interface_id) if allocates is None else allocates
        )
        self._allocated_id: str | None = None
        self._outbox: queue.Queue[pb.Envelope | None] = queue.Queue()
        self._inbox: queue.Queue[Any] = queue.Queue()
        self._ready = threading.Event()
        self._failure: BaseException | None = None
        self._closing = threading.Event()

        # Guards `_slew` (touched by every delivered frame *and* by the
        # clock thread closing a round) and the round's own sample
        # buffer (touched by the clock thread *and* by `_handle` on the
        # pump thread as replies arrive). One lock rather than two: the
        # two thread's critical sections never overlap for long enough
        # for that to cost anything real.
        self._clock_lock = threading.Lock()
        self._slew = clock.OffsetSlew()
        self._clock_samples: list[clock.ClockSample] = []
        self._clock_round_active = False
        self._clock_round_complete = threading.Event()

        self._channel = open_channel(target, timeout)
        stub = pb_grpc.CannetServerStub(self._channel)
        for envelope in opening_envelopes(interface_id, config=config):
            self._outbox.put(envelope)
        self._responses = stub.Session(
            self._requests(), metadata=_bearer_metadata(target)
        )
        self._worker = threading.Thread(
            target=self._pump, name="cannet-session", daemon=True
        )
        self._worker.start()
        # The clock probe runs alongside everything else rather than
        # gating readiness: a session must come up at the speed of its
        # subscribes, and a peer that never answers must cost nothing
        # but a clock left at `STATUS_UNSUPPORTED` once its round closes.
        self._clock_worker = threading.Thread(
            target=self._clock_loop, name="cannet-clock", daemon=True
        )
        self._clock_worker.start()

        # An ordinary subscribe is complete once it is sent, and the
        # constructor deliberately does not look at `_failure` on the
        # way out. It would be a race if it did: a loopback peer can
        # answer with a fatal code before this line runs and not answer
        # before it on a slower link, so the same mistake would raise
        # from the constructor or from the first read depending on
        # timing. It always raises from the first read.
        if self._allocates:
            if not self._ready.wait(timeout):
                self.close()
                raise SessionError(
                    f"{target.address} did not allocate a participant on "
                    f"{interface_id!r} within {timeout:g}s"
                )
            if self._failure is not None:
                self.close()
                raise self._failure

    # --- what the caller reads ----------------------------------------

    @property
    def allocated_id(self) -> str | None:
        """The participant the server allocated, for a factory subscribe."""
        return self._allocated_id

    @property
    def effective_id(self) -> str:
        """The wire id frames arrive with and transmits are addressed to."""
        return self._allocated_id or self.requested_id

    # --- the request half ---------------------------------------------

    def _requests(self) -> Iterator[pb.Envelope]:
        while True:
            envelope = self._outbox.get()
            if envelope is None:
                return
            yield envelope

    def send(self, messages: Sequence[Any]) -> None:
        """Send ``messages`` as one ``FrameBatch`` on this session.

        The wire's batching is sender-side only — the server unbatches —
        so one frame per call is fine, and several due at once pay the
        envelope overhead once.
        """
        if self._closing.is_set():
            raise SessionClosed(f"the session on {self.effective_id!r} is closed")
        if not messages:
            return
        self._outbox.put(
            pb.Envelope(
                frame_batch=pb.FrameBatch(
                    interface_id=self.effective_id,
                    frames=[_message_to_proto(m) for m in messages],
                )
            )
        )

    # --- the response half --------------------------------------------

    def recv(self, timeout: float | None) -> Any | None:
        """The next ``can.Message``, or ``None`` if none arrived in time.

        Raises :class:`SessionError` once the peer has reported a
        session-fatal code or the transport has failed. The failure is
        sticky: every later read raises it too, rather than looking
        like a quiet bus.
        """
        if self._failure is not None:
            raise self._failure
        try:
            item = self._inbox.get(timeout=timeout)
        except queue.Empty:
            return None
        if item is _EndOfStream:
            # Put it back: end of stream is a standing answer, not a
            # one-shot one.
            self._inbox.put(_EndOfStream)
            if self._failure is not None:
                raise self._failure
            return None
        return item

    def _fail(self, error: BaseException) -> None:
        if self._failure is None:
            self._failure = error
        self._ready.set()
        # Wake a reader already blocked in `recv`: without this it
        # would sit out its whole timeout and then report a quiet bus,
        # which is the opposite of what just happened.
        self._inbox.put(_EndOfStream)

    def _pump(self) -> None:
        try:
            for envelope in self._responses:
                self._handle(envelope)
        except grpc.RpcError as exc:
            if not self._closing.is_set():
                self._fail(SessionError(f"the session stream failed: {exc}"))
        except Exception as exc:  # noqa: BLE001 - never lose the reason
            self._fail(SessionError(f"the session stream failed: {exc!r}"))
        finally:
            self._inbox.put(_EndOfStream)
            self._ready.set()

    def _handle(self, envelope: pb.Envelope) -> None:
        body = envelope.WhichOneof("body")
        if body == "frame_batch":
            self._handle_batch(envelope.frame_batch)
        elif body == "interface_allocated":
            self._allocated_id = envelope.interface_allocated.interface_id
            self._ready.set()
        elif body == "error":
            self._handle_error(envelope.error)
        elif body == "interface_state":
            self.controller_state = envelope.interface_state.state
        elif body == "log":
            _log.log(
                _LOG_LEVELS.get(envelope.log.level, logging.INFO),
                "%s: %s",
                envelope.log.source,
                envelope.log.message,
            )
        elif body == "clock_reply":
            self._handle_clock_reply(envelope.clock_reply)

    def _handle_batch(self, batch: pb.FrameBatch) -> None:
        if not batch_belongs(
            batch.interface_id,
            effective_id=self.effective_id,
            factory_id=self.requested_id if self._allocates else None,
        ):
            return
        for proto_frame in batch.frames:
            try:
                frame = proto_to_frame(proto_frame)
                # The one place the peer's clock is corrected for.
                # Everything downstream sees a frame like any other
                # from any other source, which is what keeps a
                # pre-corrected source just a source.
                with self._clock_lock:
                    corrected_ns = self._slew.correct(frame.timestamp_ns)
                    applied_ns = self._slew.applied_ns()
                self.clock.publish_applied(applied_ns)
                message = frame_to_message(frame)
                message.timestamp = corrected_ns / 1_000_000_000
                message.is_rx = frame.is_rx
            except ValueError as exc:
                # An undecodable frame is the wire disagreeing with us
                # about its own encoding; carrying on would deliver
                # silently wrong frames.
                self._fail(SessionError(f"undecodable frame: {exc}"))
                return
            self._inbox.put(message)

    def _handle_clock_reply(self, reply: pb.ClockReply) -> None:
        # t4 first: anything done before sampling it lands in the
        # measured delay.
        t4 = _wall_clock_ns()
        with self._clock_lock:
            if not self._clock_round_active:
                return
            self._clock_samples.append(clock.sample(reply.t1, reply.t2, reply.t3, t4))
            complete = len(self._clock_samples) >= clock.CLOCK_PROBE_COUNT
        if complete:
            # A complete round has no reason to wait out its deadline.
            self._clock_round_complete.set()

    def _handle_error(self, error: pb.Error) -> None:
        if is_per_frame_error(error.code):
            # The first of a code is worth a warning; the rest are the
            # same fault repeating and belong to the tally. A peer
            # refusing transmits at bus rate produces thousands a
            # second, and a line each would bury everything else in the
            # application's log.
            first = self.rejections.record(error.code, error.message)
            _log.log(
                logging.WARNING if first else logging.DEBUG,
                "server reported a per-frame error (%s): %s",
                pb.Error.Code.Name(error.code),
                error.message,
            )
            return
        self._fail(
            SessionError(
                f"{self.target.address} ended the session with "
                f"{pb.Error.Code.Name(error.code)}: {error.message}"
            )
        )

    # --- the clock probe ------------------------------------------------
    #
    # A dedicated thread rather than folding this into `_pump`: replies
    # arrive on the pump thread as they come, but *deciding a round is
    # over* needs a deadline that fires whether or not a reply ever
    # does, and Python has no single-thread equivalent of the Rust
    # client's `tokio::select!` over both a stream and a timer. The
    # policy is unchanged — send a burst, wait, fold to one measurement,
    # keep asking a peer that has ever answered, stop asking one that
    # never has (see `cannet_python_client.clock` for why).

    def _send_probe(self) -> None:
        self._outbox.put(pb.Envelope(clock_probe=pb.ClockProbe(t1=_wall_clock_ns())))

    def _run_probe_round(self) -> None:
        with self._clock_lock:
            self._clock_samples = []
            self._clock_round_active = True
        self._clock_round_complete.clear()
        for i in range(clock.CLOCK_PROBE_COUNT):
            if self._closing.is_set():
                break
            self._send_probe()
            if i < clock.CLOCK_PROBE_COUNT - 1 and self._closing.wait(
                clock.CLOCK_PROBE_SPACING_S
            ):
                break
        if not self._closing.is_set():
            # Woken early once every probe has an answer (see
            # `_handle_clock_reply`), or by `close()` — either way there
            # is nothing left to wait for.
            self._clock_round_complete.wait(clock.CLOCK_PROBE_DEADLINE_S)
        with self._clock_lock:
            self._clock_round_active = False
            samples = self._clock_samples
        if self._closing.is_set():
            return
        measured = self.clock.settle_round(samples, _wall_clock_ns())
        if measured is not None:
            with self._clock_lock:
                self._slew.retarget(measured.offset_ns)
                applied_ns = self._slew.applied_ns()
            self.clock.publish_applied(applied_ns)

    def _clock_loop(self) -> None:
        while True:
            self._run_probe_round()
            if self._closing.is_set():
                return
            if not self.clock.ever_measured():
                # This peer does not recognise the envelopes; asking
                # again inside this session would not change that.
                return
            if self._closing.wait(clock.CLOCK_REPROBE_INTERVAL_S):
                return

    # --- teardown ------------------------------------------------------

    def close(self) -> None:
        """End the session. Idempotent."""
        if self._closing.is_set():
            return
        self._closing.set()
        # Wake a clock thread waiting out a round's deadline; it checks
        # `_closing` as soon as it wakes and returns without settling.
        self._clock_round_complete.set()
        self._outbox.put(None)
        # Best-effort: an already-dead stream is exactly what we wanted.
        with contextlib.suppress(Exception):
            self._responses.cancel()
        self._worker.join(timeout=5.0)
        self._clock_worker.join(timeout=5.0)
        self._channel.close()


_LOG_LEVELS = {
    pb.LOG_LEVEL_INFO: logging.INFO,
    pb.LOG_LEVEL_WARN: logging.WARNING,
    pb.LOG_LEVEL_ERROR: logging.ERROR,
}


def _message_to_proto(message: Any) -> pb.Frame:
    """``can.Message`` -> wire ``Frame``, through the sidecar's mappers.

    Always Tx: the wire's direction field says whether a frame came off
    the bus or was emitted by the sender, and everything sent from here
    is the latter.
    """
    frame: Frame = dataclasses.replace(message_to_frame(message), is_rx=False)
    return frame_to_proto(frame)
