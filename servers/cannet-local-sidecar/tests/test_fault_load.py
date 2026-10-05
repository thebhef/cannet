"""Load harness: does the session stream stay bounded and current under
a bus fault (ADR 0060)?

A bus fault reaches the sidecar as two streams at once: error frames on
the rx path and refused sends on the tx path. This harness drives both
at a fixed, modest, paced rate through the real :mod:`.service` /
:mod:`.shared_interface` pipeline and a real gRPC ``Session`` on
loopback, and measures what a client receives: rows, bus-error episode
counts, refusal summaries and envelopes per second, plus how deep the
session's two lanes got.

- The first test runs the 2026-10-04 bench load (and twice its error
  rate) with and without refusals, and asserts the fault model's
  bounds: every error frame is counted into an episode while at most
  the error-row cap of them arrive as rows; refusals arrive as
  summaries at no more than about 4 Hz per interface and add up to what
  the channel refused; the control lane never holds more than its keys;
  the data lane never more than its cap.
- The second has the client stop reading while it keeps sending, with
  data frames on the bus: sends must keep reaching the channel, and the
  data lane must drop its oldest batches -- and say so -- rather than
  grow.
- The third is the lockstep the bench showed, end to end: one
  interface refusing each send slowly must not hold its sibling below
  its offered rate.

No hardware is opened: the channel is a fake that paces its frames by
sleeping until each is due. The client runs in a child python process so
its own work does not share the sidecar's interpreter lock, which the
real host's client does not either. The server binds loopback only and
advertises nothing.

Slow (about a minute and a half), so it is skipped by default; run it
with ``uv run --extra dev pytest -m slow tests/test_fault_load.py -s``
and read the tables it prints.
"""

from __future__ import annotations

import json
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
from cannet_local_sidecar import driver_python_can as dpc  # noqa: E402
from cannet_local_sidecar.driver import Frame  # noqa: E402

#: Seconds a run settles before its window opens, and how long it runs.
_WARMUP_S = 2.0
_WINDOW_S = 10.0
#: How long after the client stops sending it keeps reading the backlog.
_DRAIN_CAP_S = 20.0


@dataclass(frozen=True)
class _Load:
    name: str
    interfaces: int
    frames_per_s: float  # per interface
    sends_per_s: float  # per interface


#: The 2026-10-04 cable-pull retest: two channels each reading ~3.6 k
#: error frames/s, ~800 periodic sends/s each refused (~1.6 k/s total).
#: The second load doubles the error frames, the per-interface reading
#: of the same figures.
_LOADS = (
    _Load("bench 2x3.6k", 2, 3_600.0, 800.0),
    _Load("2x7.2k", 2, 7_200.0, 800.0),
)
_MODES = ("no refusals", "refusals")


def _error_frame() -> Frame:
    # The shape a PEAK acknowledge-error frame has: bit error, transmit
    # direction, error in the acknowledge delimiter, REC 0, TEC 128.
    return Frame(
        timestamp_ns=time.time_ns(),
        can_id=0x1,
        extended=False,
        is_rx=True,
        data=bytes([0x00, 0x1B, 0x00, 0x80]),
        kind=drv.FrameKind.ERROR,
        dlc=4,
    )


def _data_frame() -> Frame:
    return Frame(
        timestamp_ns=time.time_ns(),
        can_id=0x321,
        extended=False,
        is_rx=True,
        data=b"\x00" * 8,
        kind=drv.FrameKind.CLASSIC,
        dlc=8,
    )


class _PacedChannel:
    """Frames at a fixed rate -- error frames, or data frames with
    ``data=True`` -- and sends refused as queue-full (taking
    ``refusal_s`` each), or accepted and their time recorded.

    ``recv`` hands out every frame already due and otherwise sleeps until
    the next one is (bounded by the timeout), so the load is paced by the
    clock and the thread is idle between frames."""

    def __init__(
        self,
        channel_id: str,
        rate: float,
        *,
        refuse: bool,
        data: bool,
        refusal_s: float = 0.0,
    ) -> None:
        self.channel_id = channel_id
        self._refuse = refuse
        self._data = data
        self._refusal_s = refusal_s
        self.accepted_at: list[float] = []
        self._period = 1.0 / rate if rate > 0 else 0.0
        self._t0 = time.monotonic()
        self._n = 0
        self._closed = False
        self._closed_at: Optional[float] = None
        self.refused = 0

    def recv(self, timeout_s: float) -> Optional[Frame]:
        if self._closed:
            return None
        if not self._period:
            time.sleep(timeout_s)
            return None
        due = self._t0 + self._n * self._period
        wait = due - time.monotonic()
        if wait > 0:
            time.sleep(min(wait, timeout_s))
            if self._closed or due > time.monotonic():
                return None
        self._n += 1
        return _data_frame() if self._data else _error_frame()

    def classify_error(self, frame: Frame) -> drv.BusError:
        return dpc._pcan_bus_error(frame.can_id, frame.data)

    def send(self, frame: Frame) -> None:
        if not self._refuse:
            self.accepted_at.append(time.monotonic() - self._t0)
            return
        if self._refusal_s:
            time.sleep(self._refusal_s)
        self.refused += 1
        raise drv.TxRejected(
            f"{self.channel_id}: The transmit queue is full", queue_full=True
        )

    def flush_tx(self) -> bool:
        return True

    def state(self) -> drv.ControllerState:
        return drv.ControllerState(state=drv.STATE_PASSIVE, tec=128, rec=0)

    def rx_loss(self) -> Optional[int]:
        return None

    def close(self) -> None:
        self._closed = True
        self._closed_at = time.monotonic()

    def produced(self) -> int:
        return self._n

    def offered_per_s(self) -> float:
        end = self._closed_at or time.monotonic()
        return self._n / (end - self._t0)


class _PacedDriver:
    def __init__(self, interfaces: int, rate: float, behaviour) -> None:
        self._ids = [f"fault:{i}" for i in range(interfaces)]
        self._rate = rate
        self._behaviour = behaviour
        self.opened: list[_PacedChannel] = []

    def list_channels(self):
        return [drv.Channel(id=i, display_name=i) for i in self._ids]

    def open(self, channel_id: str, config: drv.OpenConfig) -> _PacedChannel:
        if channel_id not in self._ids:
            raise KeyError(channel_id)
        ch = _PacedChannel(
            channel_id, self._rate, **self._behaviour(self._ids.index(channel_id))
        )
        self.opened.append(ch)
        return ch


def _run(
    load: _Load,
    monkeypatch: pytest.MonkeyPatch,
    *,
    sends: bool,
    behaviour,
    read_pause_s: float = 0.0,
) -> dict:
    from cannet_local_sidecar.server import outbox as ob
    from cannet_local_sidecar.server import service

    made: list[ob.SessionOutbox] = []

    def recording_outbox() -> ob.SessionOutbox:
        box = ob.SessionOutbox()
        made.append(box)
        return box

    monkeypatch.setattr(service, "SessionOutbox", recording_outbox)
    driver = _PacedDriver(load.interfaces, load.frames_per_s, behaviour)
    server, address = service.serve("127.0.0.1:0", driver=driver)
    wall0, cpu0 = time.monotonic(), time.process_time()
    try:
        out = subprocess.run(
            [
                sys.executable,
                __file__,
                "--client",
                address,
                ",".join(f"fault:{i}" for i in range(load.interfaces)),
                str(load.sends_per_s if sends else 0.0),
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
        "offered_fps": sum(ch.offered_per_s() for ch in driver.opened),
        "produced": sum(ch.produced() for ch in driver.opened),
        "rows_per_s": rate("frames"),
        "rows_total": client["rows_total"],
        "episode_count": client["episode_count"],
        "episodes": client["episodes"],
        "envelopes_per_s": rate("envelopes"),
        "control_per_s": rate("control"),
        "refusals_per_s": rate("refusals"),
        "refusals_total": client["refusals_total"],
        "refusal_envelopes_peak_per_s": max(
            client["refusal_envelopes"][w0:w1], default=0
        )
        / load.interfaces,
        "refused_at_sidecar": sum(ch.refused for ch in driver.opened),
        "control_peak": max(box.peak_control for box in made),
        "data_peak": max(box.peak_data_frames for box in made),
        "dropped_at_sidecar": sum(box.dropped_frames_total for box in made),
        "dropped_reported": client["dropped_reported"],
        "sidecar_cpu": sidecar_cpu,
        "client_cpu": client["cpu_s"] / client["elapsed_s"],
        "drain_s": client["drain_s"],
        "drained": client["drained"],
        "accepted_at": {ch.channel_id: list(ch.accepted_at) for ch in driver.opened},
    }


def _control_lane_bound(interfaces: int) -> int:
    """The most slots a session's control lane can hold: per interface
    one state, the episode reports the lane keeps, one drop note; one
    clock reply; and the log FIFO."""
    from cannet_local_sidecar.server import outbox as ob

    per_interface = 1 + ob._EPISODE_REPORTS_PER_INTERFACE + 1
    return interfaces * per_interface + 1 + ob._LOG_LANE_MAX


@pytest.mark.slow
def test_a_fault_stays_bounded_and_counted_end_to_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cannet_local_sidecar.server import episodes as ep
    from cannet_local_sidecar.server import outbox as ob

    rows = []
    for load in _LOADS:
        for mode in _MODES:
            r = _run(
                load,
                monkeypatch,
                sends=mode == "refusals",
                behaviour=lambda i: {"refuse": True, "data": False},
            )
            r["mode"] = mode
            rows.append(r)
    header = (
        f"{'load':<13} {'mode':<11} {'offered f/s':>11} {'counted f/s':>11} "
        f"{'rows':>5} {'env/s':>6} {'ctl/s':>6} {'refusals/s':>10} "
        f"{'refusal env/s/if':>16} {'ctl peak':>8} {'data peak':>9} "
        f"{'sidecar cpu':>11} {'client cpu':>10}"
    )
    print("\n" + header)
    for r in rows:
        counted_fps = r["episode_count"] / (_WARMUP_S + _WINDOW_S)
        print(
            f"{r['load']:<13} {r['mode']:<11} {r['offered_fps']:>11.0f} "
            f"{counted_fps:>11.0f} {r['rows_total']:>5d} "
            f"{r['envelopes_per_s']:>6.0f} {r['control_per_s']:>6.0f} "
            f"{r['refusals_per_s']:>10.0f} {r['refusal_envelopes_peak_per_s']:>16.1f} "
            f"{r['control_peak']:>8d} {r['data_peak']:>9d} "
            f"{r['sidecar_cpu']:>11.0%} {r['client_cpu']:>10.0%}"
        )
    for r in rows:
        target = next(lo for lo in _LOADS if lo.name == r["load"])
        label = f"{r['load']} / {r['mode']}"
        # The harness is only evidence if the load it claims arrived: a
        # pacing fault or a dead pump would otherwise measure an idle
        # stream and "pass".
        assert r["offered_fps"] >= 0.9 * target.interfaces * target.frames_per_s
        # Every error frame is counted, and only the cap of each
        # episode arrives as rows (rule 2). The final report can trail
        # the last frames by a poll.
        assert r["episode_count"] >= 0.95 * r["produced"], label
        cap = ep._DEFAULT_ERROR_ROW_CAP
        assert r["rows_total"] <= cap * max(1, r["episodes"]), label
        # The lanes are bounded (rule 3).
        assert r["control_peak"] <= _control_lane_bound(target.interfaces), label
        assert r["data_peak"] <= ob._DATA_LANE_FRAMES_PER_INTERFACE, label
        if r["mode"] == "refusals":
            assert r["refused_at_sidecar"] > 0, label
            # Summaries, not an envelope per refusal (rule 4): at most
            # one per 250 ms per interface, one more for the first.
            assert r["refusal_envelopes_peak_per_s"] <= 5, label
            assert r["refusals_total"] >= 0.95 * r["refused_at_sidecar"], label
        assert r["drained"], f"{label}: backlog never drained"


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
    keys = (
        "frames",
        "envelopes",
        "batches",
        "refusals",
        "refusal_envelopes",
        "control",
    )
    counts = {k: [0] * bins for k in keys}
    # Latest count per (interface, episode seq): a report restates its
    # episode's running total, so the last one seen is the total.
    episodes: dict[tuple[str, int], int] = {}
    rows_total = 0
    refusals_total = 0
    dropped_reported = 0
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
    # is read, so the response stream backs up into the sidecar's lanes.
    time.sleep(read_pause_s)
    try:
        for env in call:
            now = time.monotonic()
            i = int(now - start)
            body = env.WhichOneof("body")
            if body == "bus_error_episode":
                e = env.bus_error_episode
                episodes[(e.interface_id, e.seq)] = e.count
            elif body == "tx_refusals":
                refusals_total += env.tx_refusals.count
            elif body == "frames_dropped":
                dropped_reported += env.frames_dropped.count
            elif body == "frame_batch":
                rows_total += sum(
                    1 for f in env.frame_batch.frames if f.kind == pb.FRAME_KIND_ERROR
                )
            if now >= end:
                if drain_start is None:
                    drain_start = now
                # The backlog is drained once frames arrive no older than
                # the moment they were read off the fake channel -- or,
                # on a bus whose only frames are capped error rows, once
                # a fresh episode report does.
                fresh_ns = 0
                if body == "frame_batch" and env.frame_batch.frames:
                    fresh_ns = env.frame_batch.frames[-1].timestamp_ns
                elif body == "bus_error_episode":
                    fresh_ns = env.bus_error_episode.last_ns
                if fresh_ns and time.time_ns() - fresh_ns < 300_000_000:
                    drained = True
                    drain_s = now - end
                    break
                continue
            counts["envelopes"][i] += 1
            if body == "frame_batch":
                counts["batches"][i] += 1
                counts["frames"][i] += len(env.frame_batch.frames)
            else:
                counts["control"][i] += 1
            if body == "tx_refusals":
                counts["refusals"][i] += env.tx_refusals.count
                counts["refusal_envelopes"][i] += 1
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
            "episode_count": sum(episodes.values()),
            "episodes": len(episodes),
            "rows_total": rows_total,
            "refusals_total": refusals_total,
            "dropped_reported": dropped_reported,
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
    reach it, second by second. The bus carries data frames, so the
    data lane fills: it must stop at its cap, drop its oldest batches
    and say how many (ADR 0060 rule 3)."""
    from cannet_local_sidecar.server import outbox as ob

    load = _LOADS[0]
    pause = _WARMUP_S + _WINDOW_S - 2
    r = _run(
        load,
        monkeypatch,
        sends=True,
        behaviour=lambda i: {"refuse": False, "data": True},
        read_pause_s=pause,
    )
    per_s = [0] * int(pause + 2)
    for times in r["accepted_at"].values():
        for t in times:
            if int(t) < len(per_s):
                per_s[int(t)] += 1
    offered = load.interfaces * load.sends_per_s
    print(f"\noffered {offered:.0f} sends/s; reader paused {pause:.0f} s")
    print("sends reaching the channel, per second:", per_s)
    print(
        f"data lane peak {r['data_peak']} frames/interface; dropped "
        f"{r['dropped_at_sidecar']} (reported {r['dropped_reported']}); "
        f"control peak {r['control_peak']}; drained {r['drained']} in "
        f"{r['drain_s']:.1f} s"
    )
    # Vacuous unless the stream really backed up into the sidecar.
    assert r["data_peak"] >= ob._DATA_LANE_FRAMES_PER_INTERFACE * 0.9, r["data_peak"]
    assert r["data_peak"] <= ob._DATA_LANE_FRAMES_PER_INTERFACE
    assert r["dropped_at_sidecar"] > 0
    assert r["dropped_reported"] == r["dropped_at_sidecar"]
    assert r["control_peak"] <= _control_lane_bound(load.interfaces)
    # Seconds 1 .. pause-1: the first second holds the subscribe, the
    # last may straddle the reader starting.
    stalled = [n for n in per_s[1 : int(pause)] if n < 0.9 * offered]
    assert not stalled, f"sends fell below 90 % of offered while unread: {per_s}"


@pytest.mark.slow
def test_a_slowly_refusing_interface_does_not_pace_its_sibling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The lockstep the bench showed, end to end over gRPC: interface 0
    refuses each send after 5 ms, interface 1 accepts at once, both
    offered 800 sends/s. Before ADR 0060 rule 6 the sibling was held to
    the slow refuser's ~180/s."""
    load = _LOADS[0]
    r = _run(
        load,
        monkeypatch,
        sends=True,
        behaviour=lambda i: (
            {"refuse": True, "data": False, "refusal_s": 0.005}
            if i == 0
            else {"refuse": False, "data": False}
        ),
    )
    times = r["accepted_at"]["fault:1"]
    w0, w1 = _WARMUP_S, _WARMUP_S + _WINDOW_S
    rate = sum(1 for t in times if w0 <= t < w1) / _WINDOW_S
    print(
        f"\nhealthy sibling accepted {rate:.0f}/s of {load.sends_per_s:.0f}/s offered"
    )
    assert rate >= 0.9 * load.sends_per_s


if __name__ == "__main__" and len(sys.argv) == 6 and sys.argv[1] == "--client":
    _client_main(
        sys.argv[2], sys.argv[3].split(","), float(sys.argv[4]), float(sys.argv[5])
    )
