"""The fault-recovery bench: does a bus-off recovery bring a channel back?

The bench runs the sidecar in-process -- the real ``service`` /
``shared_interface`` pipeline behind ``serve("127.0.0.1:0")``, loopback
only, nothing advertised -- and drives it as a ``cannet.v1`` client the
way cannet does: ``ConfigureBus`` and ``Subscribe`` for two channels on
one wire, then sequence-numbered transmits both ways, reading back
``InterfaceState``, ``BusErrorEpisode``, ``TxRefusals`` and frames.
Before the channels open it swaps the sidecar's bus-off recovery (the
channel ``reset`` the state poll calls, ADR 0039) for the strategy under
test (:mod:`.strategies`). Nothing here changes the shipped sidecar.

**Traffic.** ``rate`` frames/s each way (default 800), at the longest
payload the bus takes: 8 bytes classic, 64 bytes FD; with FD on, every
other frame is classic-format. The first 8 payload bytes are the
direction's sequence number and the send time in ms since the run
started, both little-endian ``uint32``.

**Found** is the first of the channel under test reading ``state() !=
active`` or a send on it refused; both are recorded, and the gap
between them. **Recovered** is the partner receiving the bench's frames
count for count: a run of ``recovery_window_s`` (default 1 s), begun
after the fault was found, whose sequence numbers are contiguous, none
older than 250 ms when it arrives, none repeated, and whose newest is
within a quarter second of sends of the newest sent. A stale transmit
queue replaying after a reset breaks the run.

**Record.** Each run writes ``<out>/<UTC>-<strategy>/events.jsonl`` --
every reading as it arrives, the sidecar's own log lines, the strategy's
calls -- and ``table.md``: a row per 250 ms while the fault lasts and
per second otherwise, columns ``t | state() | status word | TEC | REC |
sent/s | accepted/s | refused (reason) | partner rx/s | seq gap |
strategy event``, then a verdict line. The sources are sampled side by
side and never merged: ``state()``, TEC and REC are the sidecar's latest
``InterfaceState``; the status word is the backend's own read at the
row's end (``CAN_GetStatus`` on PEAK); accepted is what the driver took
into its queue; refused is the sidecar's ``TxRefusals``; partner rx is
what arrived. On PEAK a status read is a ``CAN_GetStatus`` -- which,
with ``PCAN_BUSOFF_AUTORESET`` on, is where the driver resets the
controller.

**CLI.**

- ``run --under-test ID --partner ID --strategy NAME [--rate N]
  [--classic] [--bitrate N] [--data-bitrate N] [--no-timeout]
  [--driver fake --scenario NAME] [--out DIR]``: waits for the fault,
  then for the recovery, 10 s each unless ``--no-timeout``; exits 0
  recovered, 1 not, 2 refused to start. ``--driver fake`` runs a
  scenario from :mod:`.fake` end to end.
- ``wait EVENT [--run DIR]``: blocks until ``EVENT`` (``found``,
  ``recovered``, ``verdict``, ...) appears in the run's events file --
  the newest run under ``--out`` unless ``--run`` names one -- and
  prints it.

PCAN handles are exclusive per process: the bench refuses to start,
naming the driver's error, when either channel does not open.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import json
import logging
import struct
import sys
import threading
import time
from pathlib import Path
from typing import IO, Any, Iterator, Optional

import grpc
from cannet_python_wire._proto import cannet_pb2 as pb
from cannet_python_wire._proto import cannet_pb2_grpc as pb_grpc
from google.protobuf.json_format import MessageToDict

from .. import driver as drv
from . import fake
from . import strategies as strat

#: Where runs land unless ``--out`` says otherwise: ``perf/bus-recovery``
#: at the repository root.
DEFAULT_OUT = Path(__file__).resolve().parents[4] / "perf" / "bus-recovery"

#: The bench's two CAN IDs: under test → partner, and back.
U2P_ID = 0x7A0
P2U_ID = 0x7A1

_SAMPLE_S = 0.25
#: Samples per row outside an episode: 1 Hz.
_IDLE_EVERY = 4
#: A frame older than this when it arrives is stale.
_STALE_MS = 250
#: How long the bench waits for both channels to open.
_SUBSCRIBE_TIMEOUT_S = 5.0

_STATE_NAMES = {
    pb.CONTROLLER_STATE_ACTIVE: "active",
    pb.CONTROLLER_STATE_WARNING: "warning",
    pb.CONTROLLER_STATE_PASSIVE: "passive",
    pb.CONTROLLER_STATE_BUS_OFF: "bus_off",
    pb.CONTROLLER_STATE_UNAVAILABLE: "unavailable",
}
_REASON_NAMES = {
    pb.TX_REFUSAL_REASON_QUEUE_FULL: drv.REFUSAL_QUEUE_FULL,
    pb.TX_REFUSAL_REASON_CLOSED: drv.REFUSAL_CLOSED,
    pb.TX_REFUSAL_REASON_LISTEN_ONLY: drv.REFUSAL_LISTEN_ONLY,
    pb.TX_REFUSAL_REASON_INCOMPATIBLE: drv.REFUSAL_INCOMPATIBLE,
    pb.TX_REFUSAL_REASON_OTHER: drv.REFUSAL_OTHER,
}
_COLUMNS = (
    "t",
    "state()",
    "status word",
    "TEC",
    "REC",
    "sent/s",
    "accepted/s",
    "refused (reason)",
    "partner rx/s",
    "seq gap",
    "strategy event",
)


class BenchRefused(RuntimeError):
    """A channel did not open, so the bench did not start."""


@dataclasses.dataclass
class BenchConfig:
    """One run. The default bus is ev-zonal's: FD, 500 kbit/s nominal,
    2 Mbit/s data."""

    under_test: str
    partner: str
    strategy: str = "sidecar"
    rate: float = 800.0
    fd: bool = True
    bitrate: int = 500_000
    data_bitrate: int = 2_000_000
    out: Path = DEFAULT_OUT
    recovery_window_s: float = 1.0
    #: What drives the channels, for the table's header.
    driver_label: str = "python-can"
    #: Print events to stdout as they happen (the CLI).
    echo: bool = False


def _new_row() -> dict:
    return {
        "sent": 0,
        "accepted": 0,
        "refused": {},
        "flushes": 0,
        "partner_rx": 0,
        "missing": 0,
        "back": 0,
        "stale": 0,
        "strategy": [],
    }


class _Stream:
    """One direction's sequence-numbered frames: what was sent, what
    arrived, and the current clean run."""

    def __init__(self) -> None:
        self.next_seq = 0
        self.last_rx: Optional[int] = None
        self.run_first: Optional[int] = None
        self.run_start_s: Optional[float] = None

    def note_rx(
        self, seq: int, sent_ms: int, now_s: float, now_ms: int
    ) -> tuple[int, int, int]:
        """Account one arrival; returns (missing, back, stale)."""
        missing = back = 0
        if self.last_rx is not None:
            if seq <= self.last_rx:
                back = 1
            elif seq > self.last_rx + 1:
                missing = seq - self.last_rx - 1
        stale = 1 if (now_ms - sent_ms) & 0xFFFFFFFF > _STALE_MS else 0
        if not back:
            self.last_rx = seq
        if back or stale:
            self.run_first = self.run_start_s = None
        elif missing or self.run_start_s is None:
            self.run_first, self.run_start_s = seq, now_s
        return missing, back, stale

    def break_run(self) -> None:
        self.run_first = self.run_start_s = None


class _BenchDriver:
    """The driver the in-process sidecar is given: opens through the
    real one, then swaps each channel's ``reset`` for the strategy's
    recovery and wraps ``send`` / ``close`` so the bench sees them."""

    def __init__(self, inner: drv.Driver, strategy: strat.Strategy, bench: "Bench"):
        self._inner = inner
        self._strategy = strategy
        self._bench = bench
        self._opens: dict[str, int] = {}
        #: The channel most recently opened per interface id.
        self.current: dict[str, object] = {}

    def list_channels(self):
        return self._inner.list_channels()

    def open(self, channel_id: str, config: drv.OpenConfig):
        n = self._opens.get(channel_id, 0)
        self._opens[channel_id] = n + 1
        note = self._bench._strategy_event
        try:
            ch = self._inner.open(channel_id, config)
        except Exception as e:
            if n:
                note(channel_id, f"open raised: {e}")
            raise
        ctx = strat.StrategyContext(channel_id=channel_id, config=config)
        s = self._strategy
        try:
            bus = ch._bus  # type: ignore[attr-defined]
            if s.pcan_only:
                strat._require_pcan(bus)
            if s.on_open is not None:
                s.on_open(bus, ctx)
        except Exception as e:
            ch.close()
            raise OSError(f"open {channel_id}: strategy {s.name}: {e}") from e
        if n:
            note(channel_id, "opened")
        self._wrap(ch, ctx)
        self.current[channel_id] = ch
        return ch

    def _wrap(self, ch, ctx: strat.StrategyContext) -> None:
        cid = ctx.channel_id
        note = self._bench._strategy_event
        recover = self._strategy.recover
        own_reset, own_send, own_close = ch.reset, ch.send, ch.close
        name = self._strategy.name

        def reset() -> bool:
            try:
                if recover is None:
                    result = own_reset()
                else:
                    result = recover(ch, ctx)
            except Exception as e:
                note(cid, f"{name} raised: {e}")
                raise
            note(cid, f"{name} -> {result}")
            return result

        def send(frame) -> None:
            own_send(frame)
            self._bench._accepted(cid)

        def close() -> None:
            note(cid, "closed")
            own_close()

        # Instance attributes shadow the methods; the sidecar looks them
        # up per call, so this is the whole injection.
        setattr(ch, "reset", reset)
        setattr(ch, "send", send)
        setattr(ch, "close", close)


class Bench:
    """One run of the bench against ``driver``. :meth:`start`, then
    :meth:`wait_for_fault` / :meth:`wait_for_recovery`, then
    :meth:`stop`, which writes the table and returns the verdict."""

    def __init__(self, driver: drv.Driver, config: BenchConfig) -> None:
        if config.strategy not in strat.STRATEGIES:
            raise ValueError(
                f"unknown strategy {config.strategy!r}; one of "
                f"{', '.join(strat.STRATEGIES)}"
            )
        self.config = config
        self._driver = _BenchDriver(driver, strat.STRATEGIES[config.strategy], self)
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        run_dir = config.out / f"{stamp}-{config.strategy}"
        n = 1
        while run_dir.exists():
            n += 1
            run_dir = config.out / f"{stamp}-{config.strategy}-{n}"
        self.run_dir = run_dir
        self.rows: list[dict] = []
        self.found: Optional[dict] = None
        self.recovered: Optional[dict] = None
        self.first_state_t: Optional[float] = None
        self.first_refusal_t: Optional[float] = None
        self._lock = threading.Lock()
        self._seen = threading.Condition()
        self._seen_events: set[str] = set()
        self._stop = threading.Event()
        self._go = threading.Event()
        self._streams = {U2P_ID: _Stream(), P2U_ID: _Stream()}
        self._row = _new_row()
        self._row_start = 0.0
        self._states: dict[str, tuple[str, int, int]] = {}
        self._startup_error: Optional[str] = None
        self._t0 = time.monotonic()
        self._found_s: Optional[float] = None
        self._events: Optional[IO[str]] = None
        self._log_handler: Optional[logging.Handler] = None
        self._old_level = logging.NOTSET
        self._server: Optional[grpc.Server] = None
        self._channel: Optional[grpc.Channel] = None
        self._call: Any = None
        self._threads: list[threading.Thread] = []

    # ----- lifecycle -------------------------------------------------------

    def start(self) -> None:
        from ..server import service

        cfg = self.config
        self.run_dir.mkdir(parents=True)
        self._events = open(
            self.run_dir / "events.jsonl", "a", encoding="utf-8", newline="\n"
        )
        self._t0 = time.monotonic()
        self._row_start = self._t0
        self._capture_sidecar_log()
        self._emit(
            "started",
            under_test=cfg.under_test,
            partner=cfg.partner,
            strategy=cfg.strategy,
            rate=cfg.rate,
            fd=cfg.fd,
            bitrate=cfg.bitrate,
            data_bitrate=cfg.data_bitrate,
            driver=cfg.driver_label,
        )
        self._server, address = service.serve("127.0.0.1:0", driver=self._driver)
        self._channel = grpc.insecure_channel(address)
        stub = pb_grpc.CannetServerStub(self._channel)
        self._call = stub.Session(self._requests())
        self._spawn(self._read, "bench-read")
        deadline = time.monotonic() + _SUBSCRIBE_TIMEOUT_S
        with self._seen:
            while (
                self._startup_error is None
                and not {cfg.under_test, cfg.partner} <= self._states.keys()
            ):
                left = deadline - time.monotonic()
                if left <= 0:
                    self._startup_error = "no answer to Subscribe within 5 s"
                    break
                self._seen.wait(left)
        if self._startup_error is not None:
            error = self._startup_error
            self._emit("refused", error=error)
            self._shutdown()
            self._close_events()
            raise BenchRefused(
                f"{error} -- PCAN handles are exclusive per process: close "
                f"both channels in cannet (or whatever holds them) and run "
                f"again"
            )
        self._spawn(self._sample, "bench-sample")
        self._go.set()
        self._emit("armed")

    def stop(self) -> str:
        """Stop the run, write ``table.md`` and return the verdict line."""
        self._shutdown()
        verdict = self.verdict()
        self._emit("verdict", text=verdict)
        self._write_table(verdict)
        self._close_events()
        return verdict

    def _close_events(self) -> None:
        with self._seen:
            if self._events is not None:
                self._events.close()
                self._events = None

    def _shutdown(self) -> None:
        self._stop.set()
        if self._call is not None:
            self._call.cancel()
        if self._channel is not None:
            self._channel.close()
        if self._server is not None:
            self._server.stop(0).wait(2.0)
        for t in self._threads:
            t.join(timeout=2.0)
        self._release_sidecar_log()

    def _spawn(self, target, name: str) -> None:
        t = threading.Thread(target=target, name=name, daemon=True)
        self._threads.append(t)
        t.start()

    # ----- waiting ---------------------------------------------------------

    def wait_for(self, event: str, timeout: Optional[float] = 10.0) -> bool:
        """Whether ``event`` was emitted within ``timeout`` s (``None``:
        however long it takes)."""
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._seen:
            while event not in self._seen_events:
                left = None if deadline is None else deadline - time.monotonic()
                if left is not None and left <= 0:
                    return False
                self._seen.wait(left)
            return True

    def wait_for_fault(self, timeout: Optional[float] = 10.0) -> Optional[dict]:
        return self.found if self.wait_for("found", timeout) else None

    def wait_for_recovery(self, timeout: Optional[float] = 10.0) -> Optional[dict]:
        return self.recovered if self.wait_for("recovered", timeout) else None

    def note(self, event: str, **fields) -> None:
        """Record something the caller did -- a fault injected, a cable
        reported plugged -- in the run's events."""
        self._emit(event, **fields)

    # ----- the client ------------------------------------------------------

    def _requests(self) -> Iterator[pb.Envelope]:
        cfg = self.config
        for cid in (cfg.under_test, cfg.partner):
            yield pb.Envelope(
                configure_bus=pb.ConfigureBus(
                    interface_id=cid,
                    speed_bps=cfg.bitrate,
                    fd_data_speed_bps=cfg.data_bitrate if cfg.fd else 0,
                    fd_enabled=cfg.fd,
                )
            )
        for cid in (cfg.under_test, cfg.partner):
            yield pb.Envelope(subscribe=pb.Subscribe(interface_id=cid))
        while not self._go.wait(0.05):
            if self._stop.is_set():
                return
        period = 1.0 / cfg.rate
        due = time.monotonic()
        while not self._stop.is_set():
            now = time.monotonic()
            if now < due:
                time.sleep(due - now)
                continue
            # Periods missed by more than 100 ms are dropped, as the
            # host's periodic scheduler drops them, rather than sent as
            # a burst.
            if now - due > 0.1:
                due = now
            due += period
            yield self._batch(U2P_ID, cfg.under_test)
            yield self._batch(P2U_ID, cfg.partner)

    def _batch(self, can_id: int, interface_id: str) -> pb.Envelope:
        stream = self._streams[can_id]
        seq = stream.next_seq
        stream.next_seq += 1
        fd_frame = self.config.fd and seq % 2 == 0
        length = 64 if fd_frame else 8
        data = struct.pack("<II", seq & 0xFFFFFFFF, self._ms()) + bytes(length - 8)
        if can_id == U2P_ID:
            with self._lock:
                self._row["sent"] += 1
        frame = pb.Frame(
            can_id=can_id,
            kind=pb.FRAME_KIND_FD if fd_frame else pb.FRAME_KIND_CLASSIC,
            data=data,
            dlc=length,
            brs=fd_frame,
        )
        return pb.Envelope(
            frame_batch=pb.FrameBatch(interface_id=interface_id, frames=[frame])
        )

    def _read(self) -> None:
        try:
            for env in self._call:
                body = env.WhichOneof("body")
                now = time.monotonic()
                if body == "interface_state":
                    self._on_state(env.interface_state)
                elif body == "tx_refusals":
                    self._on_refusals(env.tx_refusals, now)
                elif body == "frame_batch":
                    self._on_frames(env.frame_batch, now)
                elif body == "error":
                    self._emit("sidecar_error", message=env.error.message)
                    if not self._go.is_set():
                        with self._seen:
                            self._startup_error = env.error.message
                            self._seen.notify_all()
                elif body in ("bus_error_episode", "frames_dropped", "log"):
                    self._emit(body, **_raw(getattr(env, body)))
        except grpc.RpcError:
            pass

    def _on_state(self, st) -> None:
        name = _STATE_NAMES.get(st.state, str(st.state))
        reading = (name, st.tec, st.rec)
        with self._seen:
            changed = self._states.get(st.interface_id) != reading
            self._states[st.interface_id] = reading
            self._seen.notify_all()
        if changed:
            self._emit("state", **_raw(st))
        if (
            st.interface_id == self.config.under_test
            and self._go.is_set()
            and name != "active"
            and self.first_state_t is None
        ):
            self.first_state_t = self._t()
            self._emit("state_not_active", state=name, tec=st.tec, rec=st.rec)
            self._maybe_found("state")

    def _on_refusals(self, r, now: float) -> None:
        self._emit("tx_refusals", **_raw(r))
        if r.interface_id != self.config.under_test:
            return
        reason = _REASON_NAMES.get(r.reason, str(r.reason))
        with self._lock:
            refused = self._row["refused"]
            refused[reason] = refused.get(reason, 0) + r.count
            self._row["flushes"] += r.flush_count
        if self._go.is_set() and r.count and self.first_refusal_t is None:
            self.first_refusal_t = self._t()
            self._emit("first_refusal", reason=reason, message=r.last_message)
            self._maybe_found("refusal")

    def _maybe_found(self, via: str) -> None:
        with self._lock:
            if self.found is not None:
                return
            self._found_s = time.monotonic()
            self.found = {"t": self._t(), "via": via}
            self._streams[U2P_ID].break_run()
        self._emit("found", **self.found)

    def _on_frames(self, batch, now: float) -> None:
        cfg = self.config
        now_ms = self._ms()
        for f in batch.frames:
            if (
                f.kind == pb.FRAME_KIND_ERROR
                or f.direction != pb.DIRECTION_RX
                or len(f.data) < 8
            ):
                continue
            if batch.interface_id == cfg.partner and f.can_id == U2P_ID:
                stream = self._streams[U2P_ID]
            elif batch.interface_id == cfg.under_test and f.can_id == P2U_ID:
                stream = self._streams[P2U_ID]
                seq, sent_ms = struct.unpack_from("<II", f.data)
                stream.note_rx(seq, sent_ms, now, now_ms)
                continue
            else:
                continue
            seq, sent_ms = struct.unpack_from("<II", f.data)
            with self._lock:
                missing, back, stale = stream.note_rx(seq, sent_ms, now, now_ms)
                row = self._row
                row["partner_rx"] += 1
                row["missing"] += missing
                row["back"] += back
                row["stale"] += stale
                recovered = self._recovered_by(stream, seq, now)
            if recovered is not None:
                self._emit("recovered", **recovered)

    def _recovered_by(self, stream: _Stream, seq: int, now: float) -> Optional[dict]:
        """The recovery this arrival completes, if it completes one.
        Called under the lock."""
        if (
            self.found is None
            or self.recovered is not None
            or stream.run_start_s is None
            or stream.run_first is None
            or self._found_s is None
            or stream.run_start_s < self._found_s
            or now - stream.run_start_s < self.config.recovery_window_s
        ):
            return None
        behind = (stream.next_seq - 1) - seq
        if behind > self.config.rate * 0.25 + 1:
            return None
        start_t = stream.run_start_s - self._t0
        self.recovered = {
            "run_start_t": round(start_t, 3),
            "after_found_s": round(start_t - self.found["t"], 3),
            "first_seq": stream.run_first,
            "through_seq": seq,
            "frames": seq - stream.run_first + 1,
            "behind": behind,
        }
        return self.recovered

    # ----- sampling --------------------------------------------------------

    def _sample(self) -> None:
        n = 0
        while not self._stop.wait(_SAMPLE_S):
            n += 1
            ut = self.config.under_test
            with self._seen:
                state, tec, rec = self._states.get(ut, ("?", 0, 0))
            with self._lock:
                episode = (
                    self.found is not None and self.recovered is None
                ) or state != "active"
            if not episode and n % _IDLE_EVERY:
                continue
            status = self._status_word()
            now = time.monotonic()
            with self._lock:
                row, self._row = self._row, _new_row()
                elapsed = now - self._row_start
                self._row_start = now
            row.update(
                t=self._t(),
                elapsed_s=round(elapsed, 3),
                state=state,
                status=status,
                tec=tec,
                rec=rec,
            )
            self.rows.append(row)
            self._emit("sample", **row)

    def _status_word(self) -> str:
        ch = self._driver.current.get(self.config.under_test)
        read = getattr(getattr(ch, "_bus", None), "status", None)
        if not callable(read):
            return "n/a"
        try:
            return f"0x{int(read()):05X}"
        except Exception as e:  # noqa: BLE001 - a reading like any other
            return f"raised: {e}"

    def _accepted(self, interface_id: str) -> None:
        if interface_id == self.config.under_test:
            with self._lock:
                self._row["accepted"] += 1

    def _strategy_event(self, interface_id: str, what: str) -> None:
        who = "ut" if interface_id == self.config.under_test else "partner"
        with self._lock:
            self._row["strategy"].append(f"{who}: {what}")
        self._emit("strategy", interface_id=interface_id, what=what)

    # ----- the sidecar's log -------------------------------------------------

    def _capture_sidecar_log(self) -> None:
        bench = self

        class _ToEvents(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                bench._emit(
                    "sidecar_log",
                    level=record.levelname,
                    logger=record.name,
                    message=record.getMessage(),
                )

        # The shared interface's recovery lines are DEBUG after the first
        # ("failed again"); the run wants every one.
        shared = logging.getLogger("cannet_local_sidecar.server.shared_interface")
        self._old_level = shared.level
        shared.setLevel(logging.DEBUG)
        self._log_handler = _ToEvents(logging.DEBUG)
        logging.getLogger("cannet_local_sidecar").addHandler(self._log_handler)

    def _release_sidecar_log(self) -> None:
        if self._log_handler is None:
            return
        logging.getLogger("cannet_local_sidecar").removeHandler(self._log_handler)
        logging.getLogger("cannet_local_sidecar.server.shared_interface").setLevel(
            self._old_level
        )
        self._log_handler = None

    # ----- the record ------------------------------------------------------

    def _t(self) -> float:
        return round(time.monotonic() - self._t0, 3)

    def _ms(self) -> int:
        return int((time.monotonic() - self._t0) * 1000) & 0xFFFFFFFF

    def _emit(self, event: str, **fields) -> None:
        line = {
            "t": self._t(),
            "utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds"),
            "event": event,
            **fields,
        }
        text = json.dumps(line, default=str)
        with self._seen:
            if self._events is not None:
                self._events.write(text + "\n")
                self._events.flush()
            self._seen_events.add(event)
            self._seen.notify_all()
        if self.config.echo and event not in _QUIET_EVENTS:
            print(text, flush=True)

    def verdict(self) -> str:
        parts = [f"verdict: strategy {self.config.strategy}"]
        if self.found is None:
            parts.append("no fault found")
        else:
            parts.append(f"found t={self.found['t']:.3f} s via {self.found['via']}")
            parts.append(_when("state != active", self.first_state_t))
            parts.append(_when("first refusal", self.first_refusal_t))
            if self.first_state_t is not None and self.first_refusal_t is not None:
                gap = abs(self.first_state_t - self.first_refusal_t)
                parts.append(f"gap {gap:.3f} s")
        if self.recovered is not None:
            parts.append(
                f"recovered t={self.recovered['run_start_t']:.3f} s, "
                f"{self.recovered['after_found_s']:.3f} s after found"
            )
        elif self.found is not None:
            parts.append(f"not recovered by t={self._t():.3f} s")
        return "; ".join(parts)

    def _write_table(self, verdict: str) -> None:
        cfg = self.config
        bus = (
            f"FD {cfg.bitrate}/{cfg.data_bitrate} bit/s"
            if cfg.fd
            else f"classic {cfg.bitrate} bit/s"
        )
        lines = [
            f"# Fault-recovery run {self.run_dir.name}",
            "",
            f"- strategy `{cfg.strategy}`; under test `{cfg.under_test}`; "
            f"partner `{cfg.partner}`; driver {cfg.driver_label}",
            f"- {cfg.rate:.0f} frames/s each way; {bus}",
            "- every reading: `events.jsonl` beside this file",
            "",
            "| " + " | ".join(_COLUMNS) + " |",
            "|" + "---|" * len(_COLUMNS),
        ]
        lines += ["| " + " | ".join(table_cells(row)) + " |" for row in self.rows]
        lines += ["", verdict, ""]
        (self.run_dir / "table.md").write_text("\n".join(lines), encoding="utf-8")


#: Events not echoed to stdout: they arrive several times a second.
_QUIET_EVENTS = frozenset(
    {"sample", "state", "tx_refusals", "bus_error_episode", "sidecar_log"}
)


def _when(what: str, t: Optional[float]) -> str:
    return f"{what} t={t:.3f} s" if t is not None else f"{what} never"


def _raw(message) -> dict:
    return MessageToDict(message, preserving_proto_field_name=True)


def table_cells(row: dict) -> list[str]:
    """A sample as the table's cells: rates per second over the row's
    own interval, everything else as read."""
    el = row["elapsed_s"] or _SAMPLE_S

    def rate(n: int) -> str:
        return f"{n / el:.0f}"

    refused = ", ".join(
        f"{rate(n)} {reason}" for reason, n in sorted(row["refused"].items())
    )
    if row["flushes"]:
        refused += f"{', ' if refused else ''}flush x{row['flushes']}"
    gap = str(row["missing"])
    if row["back"]:
        gap += f" back {row['back']}"
    if row["stale"]:
        gap += f" stale {row['stale']}"
    cells = [
        f"{row['t']:.3f}",
        row["state"],
        row["status"],
        str(row["tec"]),
        str(row["rec"]),
        rate(row["sent"]),
        rate(row["accepted"]),
        refused or "0",
        rate(row["partner_rx"]),
        gap,
        "; ".join(row["strategy"]),
    ]
    return [c.replace("|", "\\|") for c in cells]


def run_trial(
    bench: Bench,
    *,
    fault_timeout: Optional[float] = 10.0,
    recovery_timeout: Optional[float] = 10.0,
    wire: Optional[fake.FakeWire] = None,
    scenario: Optional[fake.Scenario] = None,
    warmup_s: float = 0.5,
) -> str:
    """One trial: start, wait for the fault and then the recovery, stop.
    With a fake ``wire`` and ``scenario`` the bench injects the fault
    itself and clears it ``hold_s`` after finding it; on hardware the
    owner pulls and plugs the cable. Returns the verdict line."""
    bench.start()
    try:
        ut = bench.config.under_test
        if wire is not None and scenario is not None:
            time.sleep(warmup_s)
            fake.apply(wire, scenario.inject, ut)
            bench.note("injected", scenario=scenario.name)
        if bench.wait_for_fault(fault_timeout) is not None:
            if wire is not None and scenario is not None:
                time.sleep(scenario.hold_s)
                fake.apply(wire, scenario.clear, ut)
                bench.note("cleared", scenario=scenario.name)
            bench.wait_for_recovery(recovery_timeout)
    finally:
        verdict = bench.stop()
    return verdict


# ----- CLI ----------------------------------------------------------------------


def wait_for_event(
    event: str,
    *,
    run_dir: Optional[Path] = None,
    out: Path = DEFAULT_OUT,
    timeout: Optional[float] = None,
) -> Optional[dict]:
    """Block until ``event`` appears in ``run_dir``'s events file -- by
    default the newest run under ``out`` once one exists -- and return
    it; ``None`` on ``timeout``."""
    deadline = None if timeout is None else time.monotonic() + timeout
    offset = 0
    while True:
        if run_dir is None:
            runs = sorted(p for p in out.glob("*") if p.is_dir())
            if runs:
                run_dir = runs[-1]
        path = None if run_dir is None else run_dir / "events.jsonl"
        if path is not None and path.exists():
            with open(path, "rb") as f:
                f.seek(offset)
                for line in iter(f.readline, b""):
                    if not line.endswith(b"\n"):
                        break
                    offset += len(line)
                    record = json.loads(line)
                    if record.get("event") == event:
                        return record
        if deadline is not None and time.monotonic() >= deadline:
            return None
        time.sleep(0.25)


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m cannet_local_sidecar.bench.fault_recovery",
        description="Fault-recovery bench: does a bus-off recovery bring a "
        "channel back?",
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="one trial")
    r.add_argument("--under-test", help="channel id, as cannet lists it")
    r.add_argument("--partner", help="channel id on the same wire")
    r.add_argument("--strategy", default="sidecar", choices=list(strat.STRATEGIES))
    r.add_argument("--rate", type=float, default=800.0, help="frames/s each way")
    r.add_argument("--classic", action="store_true", help="classic CAN, not FD")
    r.add_argument("--bitrate", type=int, default=500_000)
    r.add_argument("--data-bitrate", type=int, default=2_000_000)
    r.add_argument("--timeout", type=float, default=10.0, help="s per wait")
    r.add_argument("--no-timeout", action="store_true", help="wait forever")
    r.add_argument("--driver", choices=("python-can", "fake"), default="python-can")
    r.add_argument("--scenario", choices=list(fake.SCENARIOS))
    r.add_argument("--out", type=Path, default=DEFAULT_OUT)
    w = sub.add_parser("wait", help="block until an event appears")
    w.add_argument("event")
    w.add_argument("--run", type=Path, help="run directory (default: newest)")
    w.add_argument("--out", type=Path, default=DEFAULT_OUT)
    w.add_argument("--timeout", type=float, default=None)
    args = p.parse_args(argv)

    if args.cmd == "wait":
        record = wait_for_event(
            args.event, run_dir=args.run, out=args.out, timeout=args.timeout
        )
        if record is None:
            return 1
        print(json.dumps(record), flush=True)
        return 0

    wire = None
    scenario = None
    if args.driver == "fake":
        if args.scenario is None:
            p.error("--driver fake needs --scenario")
        wire = fake.FakeWire()
        driver: drv.Driver = fake.FakeDriver(wire)
        scenario = fake.SCENARIOS[args.scenario]
        ut = args.under_test or wire.handles[0]
        partner = args.partner or wire.handles[1]
        label = f"fake ({args.scenario})"
    else:
        if not (args.under_test and args.partner):
            p.error("--under-test and --partner are required")
        from ..driver_python_can import PythonCanDriver

        driver = PythonCanDriver()
        ut, partner = args.under_test, args.partner
        label = "python-can"
    timeout = None if args.no_timeout else args.timeout
    bench = Bench(
        driver,
        BenchConfig(
            under_test=ut,
            partner=partner,
            strategy=args.strategy,
            rate=args.rate,
            fd=not args.classic,
            bitrate=args.bitrate,
            data_bitrate=args.data_bitrate,
            out=args.out,
            driver_label=label,
            echo=True,
        ),
    )
    print(f"run directory: {bench.run_dir}", flush=True)
    try:
        verdict = run_trial(
            bench,
            fault_timeout=timeout,
            recovery_timeout=timeout,
            wire=wire,
            scenario=scenario,
        )
    except BenchRefused as e:
        print(f"refused to start: {e}", file=sys.stderr, flush=True)
        return 2
    finally:
        if wire is not None:
            wire.close()
    print(verdict, flush=True)
    return 0 if bench.recovered is not None else 1


if __name__ == "__main__":
    sys.exit(main())
