"""The session's two lanes (ADR 0060 rule 3) and its refusal summaries
(rule 4): :class:`~cannet_local_sidecar.server.outbox.SessionOutbox`."""

from __future__ import annotations

import queue
import sys
from pathlib import Path


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()

import pytest  # noqa: E402
from cannet_python_wire._proto import cannet_pb2 as pb  # noqa: E402

from cannet_local_sidecar import driver as drv  # noqa: E402
from cannet_local_sidecar.server import outbox as ob  # noqa: E402
from cannet_local_sidecar.server.helpers import _log_envelope  # noqa: E402


class _Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _batch(iface: str, first_ns: int, n: int) -> pb.Envelope:
    return pb.Envelope(
        frame_batch=pb.FrameBatch(
            interface_id=iface,
            frames=[pb.Frame(timestamp_ns=first_ns + i, can_id=1) for i in range(n)],
        )
    )


def _state(iface: str, tec: int) -> pb.Envelope:
    return pb.Envelope(interface_state=pb.InterfaceState(interface_id=iface, tec=tec))


def _episode(iface: str, seq: int, count: int, *, open_: bool, first_ns: int = 0):
    return pb.Envelope(
        bus_error_episode=pb.BusErrorEpisode(
            interface_id=iface,
            seq=seq,
            first_ns=first_ns,
            last_ns=first_ns + 10,
            count=count,
            count_by_kind=pb.ErrorKindCounts(ack=count),
            open=open_,
        )
    )


def _drain(box: ob.SessionOutbox) -> list[pb.Envelope]:
    out = []
    while True:
        try:
            out.append(box.get_nowait())
        except queue.Empty:
            return out


def _bodies(envs: list[pb.Envelope]) -> list[str]:
    return [e.WhichOneof("body") for e in envs]


# ---- control before data ----------------------------------------------------


def test_control_is_drained_before_data_whatever_order_it_arrived_in() -> None:
    box = ob.SessionOutbox()
    box.put(_batch("a", 0, 3))
    box.put(_batch("a", 3, 3))
    box.put(_state("a", 8))
    box.put(_log_envelope(pb.LOG_LEVEL_INFO, "hello"))
    assert _bodies(_drain(box)) == [
        "interface_state",
        "log",
        "frame_batch",
        "frame_batch",
    ]


def test_data_batches_keep_their_arrival_order_across_interfaces() -> None:
    box = ob.SessionOutbox()
    box.put(_batch("a", 0, 1))
    box.put(_batch("b", 100, 1))
    box.put(_batch("a", 1, 1))
    got = [
        (e.frame_batch.interface_id, e.frame_batch.frames[0].timestamp_ns)
        for e in _drain(box)
    ]
    assert got == [("a", 0), ("b", 100), ("a", 1)]


# ---- the control lane is bounded by key ------------------------------------


def test_interface_state_is_latest_wins_per_interface() -> None:
    box = ob.SessionOutbox()
    for tec in range(50):
        box.put(_state("a", tec))
        box.put(_state("b", tec + 100))
    got = _drain(box)
    assert [(e.interface_state.interface_id, e.interface_state.tec) for e in got] == [
        ("a", 49),
        ("b", 149),
    ]
    assert box.peak_control == 2


def test_clock_replies_are_latest_wins_per_session() -> None:
    box = ob.SessionOutbox()
    for t1 in range(10):
        box.put(pb.Envelope(clock_reply=pb.ClockReply(t1=t1, t2=1, t3=2)))
    [env] = _drain(box)
    assert env.clock_reply.t1 == 9


def test_an_episode_report_replaces_only_its_own_seq() -> None:
    """A closing report must never be replaced by the next episode's
    opening one."""
    box = ob.SessionOutbox()
    box.put(_episode("a", 1, 5, open_=True))
    box.put(_episode("a", 1, 9, open_=False))
    box.put(_episode("a", 2, 1, open_=True))
    got = [
        (e.bus_error_episode.seq, e.bus_error_episode.count, e.bus_error_episode.open)
        for e in _drain(box)
    ]
    assert got == [(1, 9, False), (2, 1, True)]


def test_backed_up_closed_episodes_fold_exactly_into_their_successor() -> None:
    box = ob.SessionOutbox()
    for seq in range(1, 6):
        box.put(_episode("a", seq, seq * 10, open_=False, first_ns=seq * 1000))
    box.put(_episode("a", 6, 1, open_=True, first_ns=6000))
    got = _drain(box)
    assert len(got) == ob._EPISODE_REPORTS_PER_INTERFACE
    total = sum(e.bus_error_episode.count for e in got)
    assert total == sum(s * 10 for s in range(1, 6)) + 1
    kinds = sum(e.bus_error_episode.count_by_kind.ack for e in got)
    assert kinds == total
    # The earliest first_ns survives the fold, the latest seq and state win.
    assert got[0].bus_error_episode.first_ns == 1000
    assert got[-1].bus_error_episode.seq == 6
    assert got[-1].bus_error_episode.open is True


def test_a_folded_successor_keeps_its_carry_when_it_is_restated() -> None:
    box = ob.SessionOutbox()
    box.put(_episode("a", 1, 10, open_=False))
    box.put(_episode("a", 2, 20, open_=False))
    box.put(_episode("a", 3, 1, open_=True))  # folds 1 into 2
    box.put(_episode("a", 2, 25, open_=False))  # restated, still carrying 1
    got = _drain(box)
    assert sum(e.bus_error_episode.count for e in got) == 10 + 25 + 1


def test_the_log_lane_is_a_bounded_fifo_that_says_what_it_dropped() -> None:
    box = ob.SessionOutbox(log_max=4)
    for i in range(10):
        box.put(_log_envelope(pb.LOG_LEVEL_INFO, f"line {i}"))
    got = _drain(box)
    assert "6 earlier log message(s) dropped" in got[0].log.message
    assert [e.log.message for e in got[1:]] == [f"line {i}" for i in range(6, 10)]


# ---- the data lane drops its oldest whole batches ---------------------------


def test_data_overflow_drops_the_oldest_whole_batches_and_says_so() -> None:
    box = ob.SessionOutbox(data_frames_per_interface=10)
    for k in range(5):
        box.put(_batch("a", k * 100, 4))
    box.put(_batch("b", 0, 4))  # another interface's cap is its own
    got = _drain(box)
    dropped = [e.frames_dropped for e in got if e.HasField("frames_dropped")]
    assert len(dropped) == 1
    assert (dropped[0].interface_id, dropped[0].count) == ("a", 12)
    assert (dropped[0].first_ns, dropped[0].last_ns) == (0, 203)
    kept = [e.frame_batch for e in got if e.HasField("frame_batch")]
    assert [(b.interface_id, b.frames[0].timestamp_ns) for b in kept] == [
        ("a", 300),
        ("a", 400),
        ("b", 0),
    ]
    assert box.peak_data_frames <= 10
    assert box.dropped_frames_total == 12


def test_a_drop_is_reported_before_the_data_that_survived_it() -> None:
    box = ob.SessionOutbox(data_frames_per_interface=4)
    box.put(_batch("a", 0, 4))
    box.put(_batch("a", 10, 4))
    assert _bodies(_drain(box)) == ["frames_dropped", "frame_batch"]


# ---- refusals are summarised -----------------------------------------------


def test_the_first_refusal_is_reported_at_once_and_the_rest_coalesce() -> None:
    clock = _Clock()
    box = ob.SessionOutbox(clock=clock)
    box.refuse("a", drv.REFUSAL_QUEUE_FULL, "full", now_ns=1)
    [first] = _drain(box)
    assert first.tx_refusals.count == 1
    assert first.tx_refusals.reason == pb.TX_REFUSAL_REASON_QUEUE_FULL
    for i in range(100):
        box.refuse("a", drv.REFUSAL_QUEUE_FULL, f"full {i}", now_ns=10 + i)
    assert _drain(box) == []  # inside the period
    clock.t += ob._REFUSAL_REPORT_PERIOD_S
    [second] = _drain(box)
    r = second.tx_refusals
    assert (r.count, r.first_ns, r.last_ns, r.last_message) == (100, 10, 109, "full 99")
    clock.t += ob._REFUSAL_REPORT_PERIOD_S
    assert _drain(box) == []  # stopped: nothing more to say


def test_refusals_are_kept_apart_by_interface_and_reason() -> None:
    box = ob.SessionOutbox()
    box.refuse("a", drv.REFUSAL_QUEUE_FULL, "x")
    box.refuse("a", drv.REFUSAL_CLOSED, "y")
    box.refuse("b", drv.REFUSAL_QUEUE_FULL, "z")
    got = {(e.tx_refusals.interface_id, e.tx_refusals.reason) for e in _drain(box)}
    assert got == {
        ("a", pb.TX_REFUSAL_REASON_QUEUE_FULL),
        ("a", pb.TX_REFUSAL_REASON_CLOSED),
        ("b", pb.TX_REFUSAL_REASON_QUEUE_FULL),
    }


def test_a_blocking_get_wakes_for_a_report_that_falls_due() -> None:
    box = ob.SessionOutbox(refusal_period_s=0.05)
    box.refuse("a", drv.REFUSAL_OTHER, "x")
    box.get(timeout=1.0)
    box.refuse("a", drv.REFUSAL_OTHER, "x")
    env = box.get(timeout=1.0)
    assert env.tx_refusals.count == 1


def test_flushes_ride_the_queue_full_summary() -> None:
    box = ob.SessionOutbox()
    box.note_flush("a", now_ns=42)
    [env] = _drain(box)
    r = env.tx_refusals
    assert (r.reason, r.count, r.flush_count, r.last_flush_ns) == (
        pb.TX_REFUSAL_REASON_QUEUE_FULL,
        0,
        1,
        42,
    )


# ---- close ----------------------------------------------------------------


def test_close_drains_what_is_left_then_ends() -> None:
    box = ob.SessionOutbox()
    box.put(_batch("a", 0, 1))
    box.refuse("a", drv.REFUSAL_OTHER, "x")
    box.get()  # the first refusal
    box.refuse("a", drv.REFUSAL_OTHER, "x")  # not yet due
    box.put(None)
    got = []
    while (env := box.get()) is not None:
        got.append(env)
    assert sorted(_bodies(got)) == ["frame_batch", "tx_refusals"]


@pytest.mark.parametrize("timeout", [0.0, 0.01])
def test_an_empty_outbox_times_out_like_a_queue(timeout: float) -> None:
    with pytest.raises(queue.Empty):
        ob.SessionOutbox().get(timeout=timeout)


def test_an_interface_reports_all_its_reasons_in_one_burst_per_period() -> None:
    clock = _Clock()
    box = ob.SessionOutbox(clock=clock)
    box.refuse("a", drv.REFUSAL_QUEUE_FULL, "x")
    box.refuse("a", drv.REFUSAL_OTHER, "y")
    assert len(_drain(box)) == 2  # one burst: both reasons
    box.refuse("a", drv.REFUSAL_OTHER, "y")
    assert _drain(box) == []  # the interface waits out the period
    box.refuse("b", drv.REFUSAL_OTHER, "z")
    assert [e.tx_refusals.interface_id for e in _drain(box)] == ["b"]
    clock.t += ob._REFUSAL_REPORT_PERIOD_S
    assert [e.tx_refusals.interface_id for e in _drain(box)] == ["a"]
