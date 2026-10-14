"""Load harness: does a bus fault's refusal traffic slow frame delivery?

A bus fault reaches the sidecar as two streams at once: error frames on
the rx path (each a ``FrameBatch`` row) and refused sends on the tx path
(each its own ``Error`` envelope, ADR 0039). This harness drives both at
a fixed, modest, paced rate through the real :mod:`.service` /
:mod:`.shared_interface` pipeline and a real gRPC ``Session`` on
loopback, and measures what a client receives: frames/s, envelopes/s and
refusals/s, plus the deepest the per-session outbox got.

The first test answers one question: is the sidecar-to-client stream
bound by the number of envelopes rather than the number of frames? Each
load runs in three modes -- no refusals, one ``Error`` envelope per refused frame (the
wire today), and refusals coalesced to one envelope per 250 ms -- so a
frame rate that rises when the refusal envelopes are coalesced away is
the envelope bound showing. The second checks the other direction: that
sends keep reaching the channel while the client is not reading and the
response stream backs up into the sidecar's outbox.

No hardware is opened: the channel is a fake that paces error frames by
sleeping until each is due and refuses every send as a full transmit
queue (the second test has it accept them). The client runs in a child python process so its own work does
not share the sidecar's interpreter lock, which the real host's client
does not either. The server binds loopback only and advertises nothing.

Slow (about two minutes), so it is skipped by default; run it with
``uv run --extra dev pytest -m slow tests/test_fault_load.py -s`` and
read the table it prints.
"""

from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()

import pytest  # noqa: E402
from cannet_python_wire._proto import cannet_pb2 as pb  # noqa: E402

from cannet_local_sidecar import driver as drv  # noqa: E402
from cannet_local_sidecar.driver import Frame  # noqa: E402

#: Seconds a run settles before its window opens, and how long it runs.
_WARMUP_S = 2.0
_WINDOW_S = 10.0
#: How long after the client stops sending it keeps reading the backlog.
_DRAIN_CAP_S = 20.0
#: One coalesced refusal envelope per this many seconds (4 Hz).
_COALESCE_PERIOD_S = 0.25
_COALESCED_PREFIX = "coalesced refusals: "


@dataclass(frozen=True)
class _Load:
    name: str
    interfaces: int
    error_frames_per_s: float  # per interface
    sends_per_s: float  # per interface


#: The 2026-10-04 cable-pull retest: two channels each reading ~3.6 k
#: error frames/s, ~800 periodic sends/s each refused (~1.6 k/s total).
#: The second load doubles the error frames, the per-interface reading
#: of the same figures.
_LOADS = (
    _Load("bench 2x3.6k", 2, 3_600.0, 800.0),
    _Load("2x7.2k", 2, 7_200.0, 800.0),
)
_MODES = ("no refusals", "per-frame", "coalesced 4 Hz")


def _error_frame(n: int) -> Frame:
    # The shape a PEAK acknowledge-error frame has: bit error, transmit
    # direction, REC 0, TEC 128.
    return Frame(
        timestamp_ns=time.time_ns(),
        can_id=0x1,
        extended=False,
        is_rx=True,
        data=bytes([0x00, 0x1B, 0x00, 0x80]),
        kind=drv.FrameKind.ERROR,
        dlc=4,
    )


class _PacedFaultChannel:
    """Error frames at a fixed rate, and every send refused as queue-full
    (or, with ``refuse=False``, accepted and its time recorded).

    ``recv`` hands out every frame already due and otherwise sleeps until
    the next one is (bounded by the timeout), so the load is paced by the
    clock and the thread is idle between frames."""

    def __init__(self, channel_id: str, rate: float, refuse: bool = True) -> None:
        self.channel_id = channel_id
        self._refuse = refuse
        self.accepted_at: list[float] = []
        self._period = 1.0 / rate
        self._t0 = time.monotonic()
        self._n = 0
        self._closed = False
        self._closed_at: Optional[float] = None
        self.refused = 0

    def recv(self, timeout_s: float) -> Optional[Frame]:
        if self._closed:
            return None
        due = self._t0 + self._n * self._period
        wait = due - time.monotonic()
        if wait > 0:
            time.sleep(min(wait, timeout_s))
            if self._closed or due > time.monotonic():
                return None
        self._n += 1
        return _error_frame(self._n)

    def send(self, frame: Frame) -> None:
        if not self._refuse:
            self.accepted_at.append(time.monotonic() - self._t0)
            return
        self.refused += 1
        raise drv.TxRejected(
            f"{self.channel_id}: The transmit queue is full", queue_full=True
        )

    def state(self) -> drv.ControllerState:
        return drv.ControllerState(state=drv.STATE_PASSIVE, tec=128, rec=0)

    def rx_loss(self) -> Optional[int]:
        return None

    def close(self) -> None:
        self._closed = True
        self._closed_at = time.monotonic()

    def offered_per_s(self) -> float:
        end = self._closed_at or time.monotonic()
        return self._n / (end - self._t0)


class _PacedFaultDriver:
    def __init__(self, interfaces: int, rate: float, refuse: bool = True) -> None:
        self._ids = [f"fault:{i}" for i in range(interfaces)]
        self._rate = rate
        self._refuse = refuse
        self.opened: list[_PacedFaultChannel] = []

    def list_channels(self):
        return [drv.Channel(id=i, display_name=i) for i in self._ids]

    def open(self, channel_id: str, config: drv.OpenConfig) -> _PacedFaultChannel:
        if channel_id not in self._ids:
            raise KeyError(channel_id)
        ch = _PacedFaultChannel(channel_id, self._rate, self._refuse)
        self.opened.append(ch)
        return ch

    def is_active(self) -> bool:
        return True


class _Outboxes:
    """Stands in for the ``queue`` module inside :mod:`.service`, so every
    session outbox is an :class:`_InstrumentedOutbox` that records its
    peak depth and, when asked, coalesces refusal envelopes."""

    def __init__(self, coalesce: bool) -> None:
        self.coalesce = coalesce
        self.made: list[_InstrumentedOutbox] = []
        self.Empty = queue.Empty
        self.Full = queue.Full

    def Queue(self, maxsize: int = 0) -> "_InstrumentedOutbox":  # noqa: N802
        ob = _InstrumentedOutbox(self.coalesce)
        self.made.append(ob)
        return ob


class _InstrumentedOutbox(queue.Queue):
    def __init__(self, coalesce: bool) -> None:
        super().__init__()
        self._coalesce = coalesce
        self._lock_c = threading.Lock()
        self._pending = 0
        self._last_flush = time.monotonic()
        self.peak_depth = 0

    def put(self, item, block=True, timeout=None):  # type: ignore[override]
        if (
            self._coalesce
            and item is not None
            and item.WhichOneof("body") == "error"
            and item.error.code == pb.Error.CODE_TX_REJECTED
        ):
            with self._lock_c:
                self._pending += 1
                now = time.monotonic()
                if now - self._last_flush < _COALESCE_PERIOD_S:
                    return
                count, self._pending, self._last_flush = self._pending, 0, now
            item = pb.Envelope(
                error=pb.Error(
                    code=pb.Error.CODE_TX_REJECTED,
                    message=f"{_COALESCED_PREFIX}{count}",
                )
            )
        super().put(item, block, timeout)
        depth = self.qsize()
        if depth > self.peak_depth:
            self.peak_depth = depth


def _run(
    load: _Load,
    mode: str,
    monkeypatch: pytest.MonkeyPatch,
    *,
    refuse: bool = True,
    read_pause_s: float = 0.0,
) -> dict:
    from cannet_local_sidecar.server import service

    outboxes = _Outboxes(coalesce=mode == "coalesced 4 Hz")
    monkeypatch.setattr(service, "queue", outboxes)
    driver = _PacedFaultDriver(load.interfaces, load.error_frames_per_s, refuse)
    server, address = service.serve("127.0.0.1:0", driver=driver)
    wall0, cpu0 = time.monotonic(), time.process_time()
    try:
        sends = 0.0 if mode == "no refusals" else load.sends_per_s
        out = subprocess.run(
            [
                sys.executable,
                __file__,
                "--client",
                address,
                ",".join(f"fault:{i}" for i in range(load.interfaces)),
                str(sends),
                str(read_pause_s),
            ],
            capture_output=True,
            text=True,
            timeout=_WARMUP_S + _WINDOW_S + _DRAIN_CAP_S + 30,
            check=True,
        )
        # Whole-run CPU of this process, which is the sidecar's: a figure
        # near 100 % of one core is the interpreter lock saturated.
        sidecar_cpu = (time.process_time() - cpu0) / (time.monotonic() - wall0)
    finally:
        server.stop(0)
        monkeypatch.undo()
    client = json.loads(out.stdout)
    w0, w1 = int(_WARMUP_S), int(_WARMUP_S + _WINDOW_S)
    secs = w1 - w0

    def rate(key: str) -> float:
        return sum(client[key][w0:w1]) / secs

    return {
        "load": load.name,
        "mode": mode,
        "offered_fps": sum(ch.offered_per_s() for ch in driver.opened),
        "frames_per_s": rate("frames"),
        "envelopes_per_s": rate("envelopes"),
        "batches_per_s": rate("batches"),
        "refusals_per_s": rate("refusals"),
        "refused_at_sidecar": sum(ch.refused for ch in driver.opened),
        "outbox_peak": max(ob.peak_depth for ob in outboxes.made),
        "sidecar_cpu": sidecar_cpu,
        "client_cpu": client["cpu_s"] / client["elapsed_s"],
        "drain_s": client["drain_s"],
        "drained": client["drained"],
        "accepted_at": [t for ch in driver.opened for t in ch.accepted_at],
    }


@pytest.mark.slow
def test_refusal_envelopes_against_frame_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [_run(load, mode, monkeypatch) for load in _LOADS for mode in _MODES]
    header = (
        f"{'load':<13} {'mode':<15} {'offered f/s':>11} {'frames/s':>9} "
        f"{'env/s':>7} {'batch/s':>7} {'refusals/s':>10} {'outbox peak':>11} "
        f"{'drain s':>7} {'sidecar cpu':>11} {'client cpu':>10}"
    )
    print("\n" + header)
    for r in rows:
        print(
            f"{r['load']:<13} {r['mode']:<15} {r['offered_fps']:>11.0f} "
            f"{r['frames_per_s']:>9.0f} {r['envelopes_per_s']:>7.0f} "
            f"{r['batches_per_s']:>7.0f} {r['refusals_per_s']:>10.0f} "
            f"{r['outbox_peak']:>11d} {r['drain_s']:>7.1f} "
            f"{r['sidecar_cpu']:>11.0%} {r['client_cpu']:>10.0%}"
        )
    for r in rows:
        # The harness is only evidence if the load it claims arrived: a
        # pacing fault or a dead pump would otherwise measure an idle
        # stream and "pass".
        target = next(lo for lo in _LOADS if lo.name == r["load"])
        assert r["offered_fps"] >= 0.9 * target.interfaces * target.error_frames_per_s
        if r["mode"] != "no refusals":
            assert r["refused_at_sidecar"] > 0
        assert r["drained"], f"{r['load']} / {r['mode']}: backlog never drained"


# ----- the client, run as a child process ---------------------------------


def _client_main(
    address: str, ids: list[str], sends_per_s: float, read_pause_s: float
) -> None:
    import grpc
    from cannet_python_wire._proto import cannet_pb2_grpc as pb_grpc

    stop_sending = threading.Event()
    # The request stream stays open until the reader is done: ending it
    # would end the session, and the backlog with it.
    done = threading.Event()

    def requests():
        for cid in ids:
            yield pb.Envelope(subscribe=pb.Subscribe(interface_id=cid))
        frame = pb.Frame(
            can_id=0x123, data=b"\x00" * 8, dlc=8, kind=pb.FRAME_KIND_CLASSIC
        )
        t0 = time.monotonic()
        sent = 0
        while not done.is_set():
            if sends_per_s <= 0 or stop_sending.is_set():
                done.wait(0.1)
                continue
            # Every interface sends one single-frame batch per period, as
            # the host's periodic transmit does.
            due = t0 + sent / sends_per_s
            wait = due - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            for cid in ids:
                yield pb.Envelope(
                    frame_batch=pb.FrameBatch(interface_id=cid, frames=[frame])
                )
            sent += 1

    bins = int(_WARMUP_S + _WINDOW_S) + 1
    counts = {k: [0] * bins for k in ("frames", "envelopes", "batches", "refusals")}
    # A paused reader is only a backed-up stream if the transport stops
    # taking bytes for it: without this the receive window grows to
    # megabytes and the client library buffers the whole pause itself.
    options = [("grpc.http2.bdp_probe", 0)] if read_pause_s > 0 else []
    channel = grpc.insecure_channel(address, options=options)
    stub = pb_grpc.CannetServerStub(channel)
    call = stub.Session(requests())
    start = time.monotonic()
    end = start + _WARMUP_S + _WINDOW_S
    drained = False
    drain_start: Optional[float] = None
    drain_s = 0.0

    def watchdog() -> None:
        # Stop sending at the end of the window, then give the backlog
        # the drain cap before cancelling the stream.
        time.sleep(max(0.0, end - time.monotonic()))
        stop_sending.set()
        if not done.wait(_DRAIN_CAP_S):
            call.cancel()

    threading.Thread(target=watchdog, daemon=True).start()
    # A client that falls behind: the requests keep going while nothing
    # is read, so the response stream backs up into the sidecar's outbox.
    time.sleep(read_pause_s)
    try:
        for env in call:
            now = time.monotonic()
            i = int(now - start)
            body = env.WhichOneof("body")
            if now >= end:
                if drain_start is None:
                    drain_start = now
                # The backlog is drained once frames arrive no older than
                # the moment they were read off the fake channel.
                if body == "frame_batch" and env.frame_batch.frames:
                    age = time.time_ns() - env.frame_batch.frames[-1].timestamp_ns
                    if age < 100_000_000:
                        drained = True
                        drain_s = now - end
                        break
                continue
            counts["envelopes"][i] += 1
            if body == "frame_batch":
                counts["batches"][i] += 1
                counts["frames"][i] += len(env.frame_batch.frames)
            elif body == "error" and env.error.code == pb.Error.CODE_TX_REJECTED:
                msg = env.error.message
                counts["refusals"][i] += (
                    int(msg[len(_COALESCED_PREFIX) :])
                    if msg.startswith(_COALESCED_PREFIX)
                    else 1
                )
    except grpc.RpcError:
        pass
    finally:
        stop_sending.set()
        done.set()
        call.cancel()
        channel.close()
    elapsed = time.monotonic() - start
    if drain_start is None:
        drained = False
    json.dump(
        {
            **counts,
            "elapsed_s": elapsed,
            "cpu_s": time.process_time(),
            "drained": drained,
            "drain_s": drain_s,
        },
        sys.stdout,
    )


@pytest.mark.slow
def test_sends_keep_flowing_while_the_response_stream_backs_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every send on a session rides one request stream, read by one
    thread, while everything the sidecar says back rides one response
    stream. If a response stream the client is not keeping up with held
    up the request side, every interface on the session would stop
    transmitting at once. Here the client reads nothing for most of the
    window while it keeps sending, and the channel counts the sends that
    reach it, second by second."""
    load = _LOADS[0]
    pause = _WARMUP_S + _WINDOW_S - 2
    r = _run(load, "sends accepted", monkeypatch, refuse=False, read_pause_s=pause)
    per_s = [0] * int(pause + 2)
    for t in r["accepted_at"]:
        if int(t) < len(per_s):
            per_s[int(t)] += 1
    offered = load.interfaces * load.sends_per_s
    print(f"\noffered {offered:.0f} sends/s; reader paused {pause:.0f} s")
    print("sends reaching the channel, per second:", per_s)
    print(
        f"outbox peak {r['outbox_peak']}; drained {r['drained']} in {r['drain_s']:.1f} s"
    )
    # Vacuous unless the stream really backed up into the sidecar.
    assert r["outbox_peak"] > 1_000, r["outbox_peak"]
    # Seconds 1 .. pause-1: the first second holds the subscribe, the
    # last may straddle the reader starting.
    stalled = [n for n in per_s[1 : int(pause)] if n < 0.9 * offered]
    assert not stalled, f"sends fell below 90 % of offered while unread: {per_s}"


if __name__ == "__main__" and len(sys.argv) == 6 and sys.argv[1] == "--client":
    _client_main(
        sys.argv[2], sys.argv[3].split(","), float(sys.argv[4]), float(sys.argv[5])
    )
