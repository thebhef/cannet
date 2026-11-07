"""The sidecar's transmit and state rules under a bus fault (ADR 0060
rules 4, 5 and 7): refusals summarised with a reason, the state cadence
and heartbeat, a PEAK bus-status read that is a fault rather than a lost
adapter, and the flush of a transmit queue that accepts nothing."""

from __future__ import annotations

import logging
import queue
import sys
import time
from pathlib import Path
from typing import Optional


def _ensure_on_path() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


_ensure_on_path()

import pytest  # noqa: E402
from cannet_python_wire._proto import cannet_pb2 as pb  # noqa: E402

from cannet_local_sidecar import driver as drv  # noqa: E402
from cannet_local_sidecar.driver_python_can import PythonCanChannel  # noqa: E402
from cannet_local_sidecar.server import service  # noqa: E402
from cannet_local_sidecar.server import shared_interface as si  # noqa: E402
from cannet_local_sidecar.server.outbox import SessionOutbox  # noqa: E402


def _frame(i: int = 0) -> drv.Frame:
    return drv.Frame(
        timestamp_ns=i,
        can_id=0x100,
        extended=False,
        is_rx=True,
        data=b"\x00",
        kind=drv.FrameKind.CLASSIC,
        dlc=1,
    )


def _drain(box: SessionOutbox, timeout_s: float = 0.5) -> list[pb.Envelope]:
    out = []
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            out.append(box.get(timeout=0.05))
        except queue.Empty:
            if out:
                break
    return out


# ---- D5: every vendor's queue-full is recognised ---------------------------


class _CanError(Exception):
    def __init__(self, text: str, error_code: Optional[int] = None) -> None:
        super().__init__(text)
        self.error_code = error_code


class _RefusingBus:
    def __init__(self, error: Exception) -> None:
        self._error = error

    def send(self, msg) -> None:
        raise self._error


def _refusal(error: Exception) -> drv.TxRejected:
    ch = PythonCanChannel(
        channel_id="t:0", bus=_RefusingBus(error), listen_only=False, fd=False
    )
    with pytest.raises(drv.TxRejected) as info:
        ch.send(_frame())
    return info.value


@pytest.mark.parametrize(
    "error",
    [
        _CanError("Failed to send: The transmit queue is full"),  # PEAK QXMTFULL
        _CanError(
            "Failed to send: Transmit buffer in CAN controller is full"
        ),  # XMTFULL
        _CanError("Transmit buffer overflow", error_code=-13),  # Kvaser canERR_TXBUFOFL
        _CanError(
            "xlCanTransmit failed (XL_ERR_QUEUE_IS_FULL)", error_code=11
        ),  # Vector
    ],
)
def test_each_vendors_full_transmit_queue_is_queue_full(error: Exception) -> None:
    assert _refusal(error).reason == drv.REFUSAL_QUEUE_FULL


def test_a_kvaser_code_that_is_not_queue_full_is_other() -> None:
    assert _refusal(_CanError("Timeout", error_code=-7)).reason == drv.REFUSAL_OTHER


def test_a_peak_bus_off_refusal_says_bus_off() -> None:
    """PCAN_ERROR_BUSOFF's text. The wire reason stays ``other``; the
    flag is what arms the state poll's bus-off reset (ADR 0039)."""
    refused = _refusal(
        _CanError("Failed to send: Bus error: the CAN controller is in bus-off state")
    )
    assert refused.bus_off and refused.reason == drv.REFUSAL_OTHER


@pytest.mark.parametrize(
    "error",
    [
        _CanError("Failed to send: The transmit queue is full"),
        _CanError("Transmit buffer overflow", error_code=-13),
        _CanError("Failed to send: Bus error: the CAN controller is error passive"),
    ],
)
def test_other_refusals_do_not_say_bus_off(error: Exception) -> None:
    assert not _refusal(error).bus_off


def test_the_wrappers_own_refusals_carry_their_reasons() -> None:
    lo = PythonCanChannel(channel_id="t:0", bus=None, listen_only=True, fd=False)
    with pytest.raises(drv.TxRejected) as info:
        lo.send(_frame())
    assert info.value.reason == drv.REFUSAL_LISTEN_ONLY
    classic = PythonCanChannel(channel_id="t:0", bus=None, listen_only=False, fd=False)
    fd_frame = drv.Frame(
        timestamp_ns=0,
        can_id=1,
        extended=False,
        is_rx=True,
        data=bytes(12),
        kind=drv.FrameKind.FD,
        dlc=12,
    )
    with pytest.raises(drv.TxRejected) as info:
        classic.send(fd_frame)
    assert info.value.reason == drv.REFUSAL_INCOMPATIBLE
    classic.close()
    with pytest.raises(drv.TxRejected) as info:
        classic.send(_frame())
    assert info.value.reason == drv.REFUSAL_CLOSED


# ---- D10: a PEAK bus-status read is a fault reading ------------------------


class _BusStatusRecvBus:
    """python-can's PcanBus raises its operation error, text only, when a
    Read returns a bus-status result."""

    m_objPCANBasic = object()

    def __init__(self, text: str, status: int) -> None:
        self._text = text
        self._status = status

    def recv(self, timeout: float):
        raise RuntimeError(self._text)

    def status(self) -> int:
        return self._status


@pytest.mark.parametrize(
    ("text", "status", "state"),
    [
        ("Bus error: the CAN controller is in bus-off state", 0x10, drv.STATE_BUS_OFF),
        ("Bus error: the CAN controller is error passive", 0x00, drv.STATE_PASSIVE),
    ],
)
def test_a_peak_bus_status_read_is_a_fault_not_an_unplugged_adapter(
    text: str, status: int, state: str
) -> None:
    ch = PythonCanChannel(
        channel_id="pcan:x",
        bus=_BusStatusRecvBus(text, status),
        listen_only=False,
        fd=False,
    )
    assert ch.recv(0.0) is None  # not raised: nothing went missing
    assert ch.state().state == state


def test_a_bus_status_read_paces_the_reader_rather_than_spinning() -> None:
    """A bus-off controller answers every Read with the status at once;
    returning ``None`` at once would turn the receive loop into a busy
    one for as long as the fault lasts."""
    ch = PythonCanChannel(
        channel_id="pcan:x",
        bus=_BusStatusRecvBus(
            "Bus error: the CAN controller is in bus-off state", 0x10
        ),
        listen_only=False,
        fd=False,
    )
    t0 = time.monotonic()
    for _ in range(5):
        assert ch.recv(0.25) is None
    assert time.monotonic() - t0 >= 5 * dpc_pause() * 0.9


def dpc_pause() -> float:
    from cannet_local_sidecar import driver_python_can as dpc

    return dpc._PCAN_RECV_FAULT_PAUSE_S


def test_any_other_peak_read_failure_is_still_unavailable() -> None:
    ch = PythonCanChannel(
        channel_id="pcan:x",
        bus=_BusStatusRecvBus("The handle is invalid", 0x1C00),
        listen_only=False,
        fd=False,
    )
    with pytest.raises(RuntimeError):
        ch.recv(0.0)
    assert ch.state().state == drv.STATE_UNAVAILABLE


# ---- shared-interface fakes -------------------------------------------------


class _Channel:
    def __init__(self, channel_id: str) -> None:
        self.channel_id = channel_id
        self._q: "queue.Queue[drv.Frame]" = queue.Queue()
        self._state = drv.ControllerState()
        self.refuse: Optional[drv.TxRejected] = None
        self.sent = 0
        self.flushes = 0
        self.closed = False

    def recv(self, timeout_s: float) -> Optional[drv.Frame]:
        try:
            return self._q.get(timeout=timeout_s)
        except queue.Empty:
            return None

    def send(self, frame: drv.Frame) -> None:
        if self.refuse is not None:
            raise self.refuse
        self.sent += 1

    def state(self) -> drv.ControllerState:
        return self._state

    def close(self) -> None:
        self.closed = True


class _FlushableChannel(_Channel):
    def flush_tx(self) -> bool:
        self.flushes += 1
        return True


class _Driver:
    def __init__(self, cls=_Channel) -> None:
        self._cls = cls
        self.opened: list[_Channel] = []

    def list_channels(self):
        return [drv.Channel(id="f:0", display_name="f")]

    def open(self, channel_id: str, config: drv.OpenConfig) -> _Channel:
        ch = self._cls(channel_id)
        self.opened.append(ch)
        return ch


_QUEUE_FULL = drv.TxRejected("The transmit queue is full", queue_full=True)


@pytest.fixture
def hand_polled(monkeypatch: pytest.MonkeyPatch):
    """A subscribed interface whose state poll is driven by hand."""
    monkeypatch.setattr(si, "_STATE_POLL_INTERVAL_S", 3600.0)
    created: list = []

    def make(cls=_FlushableChannel):
        driver = _Driver(cls)
        reg = si._InterfaceRegistry(driver)
        box = SessionOutbox()
        shared = reg.subscribe("f:0", box)
        created.append((reg, box))
        return driver, shared, box

    yield make
    for reg, box in created:
        reg.unsubscribe("f:0", box)


# ---- rule 4: refusals summarised, with a reason ----------------------------


def test_driver_refusals_reach_the_sender_as_one_summary_not_an_error_each(
    hand_polled,
) -> None:
    driver, shared, box = hand_polled()
    _drain(box)
    driver.opened[0].refuse = _QUEUE_FULL
    for i in range(200):
        shared.transmit(_frame(i), box)
    got = _drain(box, timeout_s=1.0)
    assert not any(e.HasField("error") for e in got)
    summaries = [e.tx_refusals for e in got if e.HasField("tx_refusals")]
    assert 1 <= len(summaries) <= 3
    assert sum(s.count for s in summaries) == 200
    assert {s.reason for s in summaries} == {pb.TX_REFUSAL_REASON_QUEUE_FULL}
    assert {s.interface_id for s in summaries} == {"f:0"}


def test_service_level_refusals_carry_their_reasons() -> None:
    box = SessionOutbox()
    svc = service.CannetServerService(_Driver())
    bad = pb.Frame(can_id=1, kind=pb.FRAME_KIND_UNSPECIFIED)
    svc._handle_tx(pb.FrameBatch(interface_id="f:0", frames=[bad]), set(), box)
    svc._handle_tx(pb.FrameBatch(interface_id="f:0", frames=[bad]), {"f:0"}, box)
    good = pb.Frame(can_id=1, kind=pb.FRAME_KIND_CLASSIC, dlc=0)
    svc._handle_tx(pb.FrameBatch(interface_id="f:0", frames=[good]), {"f:0"}, box)
    got = _drain(box)
    assert not any(e.HasField("error") for e in got)
    counts: dict[int, int] = {}
    for e in got:
        counts[e.tx_refusals.reason] = (
            counts.get(e.tx_refusals.reason, 0) + e.tx_refusals.count
        )
    assert counts == {
        # not subscribed in this session; subscribed, but no interface open
        pb.TX_REFUSAL_REASON_CLOSED: 2,
        pb.TX_REFUSAL_REASON_INCOMPATIBLE: 1,  # undecodable frame
    }


def test_a_full_sidecar_queue_refuses_at_once(hand_polled, monkeypatch) -> None:
    """Rule 6: the request thread never waits on an interface's queue."""
    monkeypatch.setattr(si, "_TX_QUEUE_MAX", 4)
    driver, shared, box = hand_polled()
    shared._tx_queue = queue.Queue(maxsize=4)  # a worker that never drains it
    for i in range(4):
        shared._tx_queue.put_nowait(None)
    t0 = time.monotonic()
    with pytest.raises(drv.TxRejected) as info:
        shared.transmit(_frame(), box)
    assert time.monotonic() - t0 < 0.05
    assert info.value.reason == drv.REFUSAL_QUEUE_FULL


# ---- rule 5: cadence and heartbeat -----------------------------------------


def test_the_state_poll_runs_every_250_ms() -> None:
    assert si._STATE_POLL_INTERVAL_S == 0.25


def _states(box: SessionOutbox) -> list[pb.InterfaceState]:
    return [
        e.interface_state for e in _drain(box, 0.1) if e.HasField("interface_state")
    ]


def test_an_unchanged_state_is_republished_every_second_with_its_reading_time(
    hand_polled,
) -> None:
    driver, shared, box = hand_polled()
    _drain(box)
    ch = driver.opened[0]
    ch._state = drv.ControllerState(state=drv.STATE_PASSIVE, tec=128)
    before = time.time_ns()
    shared._poll_state(ch, now_s=10.0)
    [first] = _states(box)
    assert first.as_of_ns >= before
    shared._poll_state(ch, now_s=10.25)
    shared._poll_state(ch, now_s=10.75)
    assert _states(box) == []
    shared._poll_state(ch, now_s=11.0)
    [beat] = _states(box)
    assert beat.state == pb.CONTROLLER_STATE_PASSIVE and beat.as_of_ns >= first.as_of_ns


def test_the_subscribe_snapshot_carries_its_reading_time(hand_polled) -> None:
    before = time.time_ns()
    driver, shared, box = hand_polled()
    [snap] = _states(box)
    assert snap.as_of_ns >= before


# ---- rule 7: a transmit queue that accepts nothing is flushed ---------------


def test_a_queue_refusing_everything_for_a_second_is_flushed_while_frames_arrive(
    hand_polled, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="cannet_local_sidecar")
    driver, shared, box = hand_polled()
    ch = driver.opened[0]
    after = si._STUCK_QUEUE_FLUSH_AFTER_S
    t = 100.0
    while t < 104.0:
        shared._note_tx_refused(ch, _QUEUE_FULL, now_s=t)
        shared._note_rx(now_s=t)  # error frames keep arriving
        t += 0.05
        if abs((t * 4) - round(t * 4)) < 1e-9:
            shared._poll_state(ch, now_s=t)
    assert len(driver.opened) == 1, "a flush, not a reopen"
    # The first flush a second in, then at most one a second after.
    assert 3 <= ch.flushes <= int((104.0 - 100.0) / after)
    infos = [
        r.getMessage()
        for r in caplog.records
        if r.levelno == logging.INFO and "flush" in r.getMessage()
    ]
    assert len(infos) == 1, infos
    flushes = [e.tx_refusals for e in _drain(box) if e.HasField("tx_refusals")]
    assert sum(s.flush_count for s in flushes) == ch.flushes
    assert all(s.last_flush_ns > 0 for s in flushes if s.flush_count)


def test_an_accepted_send_restarts_the_second(hand_polled) -> None:
    driver, shared, box = hand_polled()
    ch = driver.opened[0]
    shared._note_tx_refused(ch, _QUEUE_FULL, now_s=100.0)
    shared._note_tx_accepted(ch, now_s=100.6)
    shared._note_tx_refused(ch, _QUEUE_FULL, now_s=100.7)
    shared._note_rx(now_s=101.2)
    shared._poll_state(ch, now_s=101.25)
    assert ch.flushes == 0
    shared._note_tx_refused(ch, _QUEUE_FULL, now_s=101.6)
    shared._note_rx(now_s=101.7)
    shared._poll_state(ch, now_s=101.75)
    assert ch.flushes == 1


def test_refusals_that_stopped_are_not_flushed(hand_polled) -> None:
    driver, shared, box = hand_polled()
    ch = driver.opened[0]
    shared._note_tx_refused(ch, _QUEUE_FULL, now_s=100.0)
    shared._note_rx(now_s=102.4)
    shared._poll_state(ch, now_s=102.5)
    assert ch.flushes == 0


def test_a_bus_off_controller_is_not_flushed(hand_polled) -> None:
    driver, shared, box = hand_polled()
    ch = driver.opened[0]
    ch._state = drv.ControllerState(state=drv.STATE_BUS_OFF, tec=256)
    shared._note_tx_refused(ch, _QUEUE_FULL, now_s=100.0)
    shared._note_tx_refused(ch, _QUEUE_FULL, now_s=101.2)
    shared._note_rx(now_s=101.2)
    shared._poll_state(ch, now_s=101.25)
    assert ch.flushes == 0


def test_a_backend_without_an_in_place_flush_is_reopened(hand_polled) -> None:
    driver, shared, box = hand_polled(_Channel)
    ch = driver.opened[0]
    shared._note_tx_refused(ch, _QUEUE_FULL, now_s=100.0)
    shared._note_tx_refused(ch, _QUEUE_FULL, now_s=101.1)
    shared._note_rx(now_s=101.2)
    shared._poll_state(ch, now_s=101.25)
    assert len(driver.opened) == 2 and ch.closed


def test_python_can_flushes_per_vendor() -> None:
    class Pcan:
        m_objPCANBasic = object()
        resets = 0

        def reset(self) -> bool:
            Pcan.resets += 1
            return True

    class Kvaser:
        _timestamp_offset = 0.0
        flushed = 0

        def flush_tx_buffer(self) -> None:
            Kvaser.flushed += 1

    class Xl:
        calls: list = []

        def xlCanFlushTransmitQueue(self, port, mask) -> None:  # noqa: N802
            Xl.calls.append((port, mask))

    class Vector:
        port_handle = 7
        mask = 3
        xldriver = Xl()

        def request_chip_state(self) -> None:
            pass

        def flush_tx_buffer(self) -> None:
            raise AssertionError("transmits a frame of its own: never call it")

    def ch(bus):
        return PythonCanChannel(channel_id="x", bus=bus, listen_only=False, fd=False)

    assert ch(Pcan()).flush_tx() is True and Pcan.resets == 1
    assert ch(Kvaser()).flush_tx() is True and Kvaser.flushed == 1
    assert ch(Vector()).flush_tx() is True and Xl.calls == [(7, 3)]

    class UnsupportedXl:
        def xlCanFlushTransmitQueue(self, port, mask) -> None:  # noqa: N802
            raise RuntimeError("XL_ERR_NOT_SUPPORTED")

    class OldVector(Vector):
        xldriver = UnsupportedXl()

    assert ch(OldVector()).flush_tx() is False  # fall back to the reopen
    assert ch(object()).flush_tx() is False


# ---- the stats lines ---------------------------------------------------------


def test_the_stats_lines_carry_offered_refused_errors_and_echoes(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(si, "_RX_STATS_INTERVAL_NS", 200_000_000)
    caplog.set_level(logging.INFO, logger="cannet_local_sidecar")
    driver = _Driver(_FlushableChannel)
    reg = si._InterfaceRegistry(driver)
    box = SessionOutbox()
    shared = reg.subscribe("f:0", box)
    try:
        ch = driver.opened[0]
        ch._q.put(_frame())
        ch.refuse = _QUEUE_FULL
        for _ in range(3):
            shared.transmit(_frame(), box)
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and not any(
            "tx stats" in r.getMessage() for r in caplog.records
        ):
            time.sleep(0.02)
    finally:
        reg.unsubscribe("f:0", box)
    rx = next(r.getMessage() for r in caplog.records if "rx stats" in r.getMessage())
    tx = next(r.getMessage() for r in caplog.records if "tx stats" in r.getMessage())
    assert "errors=" in rx and "echoes=" in rx
    assert "offered=" in tx and "refused=" in tx
