"""Bus-error episodes counted at the source, and the error-row cap
(ADR 0060 rules 1 and 2).

Three layers: the per-interface accumulator on its own, each vendor's
error-frame classification in the python-can driver, and the receive
pump that feeds one into the other and forwards only the first N rows.
"""

from __future__ import annotations

import collections
import queue
import sys
import threading
import time
from pathlib import Path
from typing import Optional


def _ensure_on_path() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


_ensure_on_path()

import pytest  # noqa: E402
from cannet_python_wire._proto import cannet_pb2 as pb  # noqa: E402

from cannet_local_sidecar import driver as drv  # noqa: E402
from cannet_local_sidecar import driver_python_can as dpc  # noqa: E402
from cannet_local_sidecar.driver_python_can import PythonCanChannel  # noqa: E402
from cannet_local_sidecar.server import episodes as ep  # noqa: E402
from cannet_local_sidecar.server import shared_interface as si  # noqa: E402
from cannet_local_sidecar.server.outbox import SessionOutbox  # noqa: E402

_S = 1_000_000_000
_ACK_TX = drv.BusError(kind="ack", direction="tx", tec=128, rec=0)


# ---- the accumulator --------------------------------------------------------


def test_the_first_error_opens_an_episode_and_reports_it_at_once() -> None:
    acc = ep.EpisodeAccumulator("a")
    row, reports = acc.on_error(_ACK_TX, 5 * _S, 100.0)
    assert row is True
    [r] = reports
    assert (r.interface_id, r.seq, r.count, r.open) == ("a", 1, 1, True)
    assert (r.first_ns, r.last_ns, r.tec, r.rec) == (5 * _S, 5 * _S, 128, 0)
    assert (r.count_by_kind.ack, r.tx_count, r.rx_count) == (1, 1, 0)


def test_only_the_first_n_error_frames_of_an_episode_are_rows() -> None:
    acc = ep.EpisodeAccumulator("a", cap=3)
    rows = [acc.on_error(_ACK_TX, 5 * _S + i, 100.0)[0] for i in range(10)]
    assert rows == [True] * 3 + [False] * 7
    [r] = acc.tick(100.1, 128, 0)
    assert (r.count, r.open) == (10, True)


def test_an_episode_closes_after_a_second_without_an_error_and_the_cap_resets() -> None:
    acc = ep.EpisodeAccumulator("a", cap=2)
    for i in range(5):
        acc.on_error(_ACK_TX, 5 * _S + i, 100.0)
    assert acc.tick(100.9, 0, 0)[0].open is True
    [closed] = acc.tick(101.0, 0, 0)
    assert (closed.seq, closed.count, closed.open) == (1, 5, False)
    assert acc.tick(101.25, 0, 0) == []
    row, [opened] = acc.on_error(_ACK_TX, 9 * _S, 103.0)
    assert row is True
    assert (opened.seq, opened.count, opened.open) == (2, 1, True)


def test_the_frames_own_clock_closes_an_episode_too() -> None:
    """A stamp a second after the last error closes the episode even if
    the poll has not got there yet -- whether the stamp is the next
    error's (which then opens a fresh episode) or a data frame's."""
    acc = ep.EpisodeAccumulator("a")
    acc.on_error(_ACK_TX, 5 * _S, 100.0)
    row, reports = acc.on_error(_ACK_TX, 6 * _S, 100.0)
    assert row is True
    assert [(r.seq, r.open) for r in reports] == [(1, False), (2, True)]
    assert acc.on_frame(6 * _S + _S // 2) == []
    [closed] = acc.on_frame(7 * _S)
    assert (closed.seq, closed.open) == (2, False)


def test_a_counter_update_is_not_counted_and_opens_nothing() -> None:
    acc = ep.EpisodeAccumulator("a")
    row, reports = acc.on_error(
        drv.BusError(tec=40, rec=3, counted=False), 5 * _S, 100.0
    )
    assert (row, reports) == (False, [])
    assert acc.tick(100.25, 0, 0) == []
    # ... but its counters are the episode's starting reading.
    acc2 = ep.EpisodeAccumulator("a")
    acc2.on_error(_ACK_TX, 5 * _S, 100.0)
    acc2.on_error(drv.BusError(tec=136, rec=0, counted=False), 5 * _S + 1, 100.0)
    [r] = acc2.tick(100.25, 0, 0)
    assert (r.count, r.tec) == (1, 136)


def test_a_vendor_without_counters_in_its_frames_takes_the_polled_ones() -> None:
    acc = ep.EpisodeAccumulator("a")
    acc.on_error(drv.BusError(), 5 * _S, 100.0)
    [r] = acc.tick(100.25, 200, 7)
    assert (r.tec, r.rec, r.count_by_kind.unknown) == (200, 7, 1)


def test_a_new_cap_applies_from_the_next_episode() -> None:
    acc = ep.EpisodeAccumulator("a", cap=2)
    acc.on_error(_ACK_TX, 5 * _S, 100.0)
    acc.set_cap(5)
    rows = [acc.on_error(_ACK_TX, 5 * _S + i, 100.0)[0] for i in range(1, 6)]
    assert rows.count(True) == 1  # the open episode keeps its cap of 2
    acc.tick(102.0, 0, 0)
    rows = [acc.on_error(_ACK_TX, 9 * _S + i, 103.0)[0] for i in range(8)]
    assert rows.count(True) == 5
    acc.set_cap(None)
    assert acc.cap == ep._DEFAULT_ERROR_ROW_CAP == 16


# ---- PEAK: kind, direction and counters out of the error frame -------------


@pytest.mark.parametrize(
    ("can_id", "position", "kind"),
    [
        (1, 0x02, "bit"),
        (2, 0x02, "form"),
        (4, 0x02, "stuff"),
        (8, 0x02, "other"),
        (1, 0x19, "ack"),  # an error in the acknowledge slot
        (8, 0x1B, "ack"),  # or the acknowledge delimiter
        (3, 0x02, "unknown"),  # not one of PEAK's four codes
    ],
)
def test_peak_kind_comes_from_the_id_and_the_bit_position(
    can_id: int, position: int, kind: str
) -> None:
    err = dpc._pcan_bus_error(can_id, bytes([0x00, position, 0x05, 0x80]))
    assert (err.kind, err.counted, err.tec, err.rec) == (kind, True, 0x80, 0x05)


@pytest.mark.parametrize(("byte0", "direction"), [(0x00, "tx"), (0x01, "rx")])
def test_peak_direction_is_byte_zero(byte0: int, direction: str) -> None:
    assert dpc._pcan_bus_error(1, bytes([byte0, 0x02, 0, 0])).direction == direction


def test_a_peak_id_zero_frame_is_a_counter_update() -> None:
    err = dpc._pcan_bus_error(0, bytes([0x00, 0x00, 0x00, 0x60]))
    assert (err.counted, err.tec, err.rec) == (False, 0x60, 0)


def test_a_short_peak_payload_classifies_without_counters() -> None:
    err = dpc._pcan_bus_error(2, b"\x01")
    assert (err.kind, err.direction, err.tec, err.rec) == ("form", "rx", None, None)


class _PcanErrMsg:
    def __init__(self, can_id: int, data: bytes) -> None:
        self.timestamp = 1_700_000_000.0
        self.arbitration_id = can_id
        self.is_extended_id = False
        self.is_rx = True
        self.is_error_frame = True
        self.is_remote_frame = False
        self.is_fd = False
        self.bitrate_switch = False
        self.error_state_indicator = False
        self.data = data
        self.dlc = len(data)


class _PcanBus:
    m_objPCANBasic = object()

    def __init__(self, msgs: list) -> None:
        self._msgs = list(msgs)

    def status(self) -> int:
        return 0

    def recv(self, timeout: float):
        return self._msgs.pop(0) if self._msgs else None


def test_the_python_can_channel_classifies_what_it_received() -> None:
    bus = _PcanBus([_PcanErrMsg(1, bytes([0x00, 0x19, 0x00, 0x80]))])
    ch = PythonCanChannel(channel_id="pcan:x", bus=bus, listen_only=False, fd=False)
    frame = ch.recv(0.0)
    assert frame is not None and frame.kind == drv.FrameKind.ERROR
    assert ch.classify_error(frame) == drv.BusError(
        kind="ack", direction="tx", tec=0x80, rec=0
    )


# ---- Vector: FD error events are consumed, classic and Kvaser are unknown ---


def test_the_xl_error_constants_match_python_cans_own_definitions() -> None:
    from can.interfaces.vector import xldefine

    tags = xldefine.XL_CANFD_RX_EventTags
    assert dpc._XL_CANFD_EVENT_TAG_RX_ERROR == tags.XL_CAN_EV_TAG_RX_ERROR
    assert dpc._XL_CANFD_EVENT_TAG_TX_ERROR == tags.XL_CAN_EV_TAG_TX_ERROR
    codes = xldefine.XL_CANFD_RX_EV_ERROR_errorCode
    assert dpc._XL_CAN_ERRC_KIND == {
        int(codes.XL_CAN_ERRC_BIT_ERROR): "bit",
        int(codes.XL_CAN_ERRC_FORM_ERROR): "form",
        int(codes.XL_CAN_ERRC_STUFF_ERROR): "stuff",
        int(codes.XL_CAN_ERRC_OTHER_ERROR): "other",
        int(codes.XL_CAN_ERRC_CRC_ERROR): "crc",
        int(codes.XL_CAN_ERRC_ACK_ERROR): "ack",
        int(codes.XL_CAN_ERRC_NACK_ERROR): "ack",
        int(codes.XL_CAN_ERRC_OVLD_ERROR): "other",
        int(codes.XL_CAN_ERRC_EXCPT_ERROR): "other",
    }


class _TagData:
    def __init__(self, **fields: object) -> None:
        self.__dict__.update(fields)


class _FdErrorEvent:
    def __init__(self, tag: int, code: int, stamp_ns: int) -> None:
        self.tag = tag
        self.timeStamp = stamp_ns  # noqa: N815 - the XL field's own name
        self.tagData = _TagData(canError=_TagData(errorCode=code))  # noqa: N815


def test_an_fd_error_event_is_recorded_by_the_hook() -> None:
    cls = dpc._chip_state_vector_bus_class()
    bus = cls.__new__(cls)
    bus._time_offset = 1_700_000_000.0
    bus.handle_canfd_event(
        _FdErrorEvent(dpc._XL_CANFD_EVENT_TAG_TX_ERROR, 6, 2_000_000_000)
    )
    bus.handle_canfd_event(
        _FdErrorEvent(dpc._XL_CANFD_EVENT_TAG_RX_ERROR, 3, 3_000_000_000)
    )
    assert list(bus.error_events) == [
        ("tx", 6, 1_700_000_002.0),
        ("rx", 3, 1_700_000_003.0),
    ]


class _VectorFdBus:
    def __init__(self, events: list) -> None:
        self.error_events = collections.deque(events)
        self.chip_state = (0x02, 136, 0)
        self.recvs = 0

    def request_chip_state(self) -> None:
        pass

    def recv(self, timeout: float):
        self.recvs += 1
        return None


def test_the_channel_hands_an_fd_error_event_back_as_an_error_frame() -> None:
    stamp_s = round(time.time()) - 5.0
    bus = _VectorFdBus([("tx", 6, stamp_s)])
    ch = PythonCanChannel(
        channel_id="vector:x(ch:0)", bus=bus, listen_only=False, fd=True
    )
    frame = ch.recv(0.0)
    assert frame is not None and frame.kind == drv.FrameKind.ERROR
    assert frame.timestamp_ns == int(stamp_s) * 1_000_000_000
    assert bus.recvs == 0, "a pending event is handed back before reading more"
    assert ch.classify_error(frame) == drv.BusError(kind="ack", direction="tx")
    assert ch.recv(0.0) is None


class _ClassicErrMsg(_PcanErrMsg):
    pass


class _PlainBus:
    def __init__(self, msgs: list) -> None:
        self._msgs = list(msgs)

    def recv(self, timeout: float):
        return self._msgs.pop(0) if self._msgs else None


def test_a_vendor_that_reports_no_kind_classifies_as_unknown() -> None:
    ch = PythonCanChannel(
        channel_id="kvaser:0",
        bus=_PlainBus([_ClassicErrMsg(0, b"")]),
        listen_only=False,
        fd=False,
    )
    frame = ch.recv(0.0)
    assert frame is not None
    assert ch.classify_error(frame) == drv.BusError()


# ---- the receive pump: episodes out, first N rows forwarded -----------------


def _error_frame(ts_ns: int, can_id: int = 1) -> drv.Frame:
    return drv.Frame(
        timestamp_ns=ts_ns,
        can_id=can_id,
        extended=False,
        is_rx=True,
        data=bytes([0x00, 0x19, 0x00, 0x80]),
        kind=drv.FrameKind.ERROR,
        dlc=4,
    )


class _ErrorChannel:
    """Hands out queued frames and classifies the way PEAK does."""

    def __init__(self, channel_id: str) -> None:
        self.channel_id = channel_id
        self._q: "queue.Queue[drv.Frame]" = queue.Queue()

    def enqueue(self, frame: drv.Frame) -> None:
        self._q.put(frame)

    def recv(self, timeout_s: float) -> Optional[drv.Frame]:
        try:
            return self._q.get(timeout=timeout_s)
        except queue.Empty:
            return None

    def classify_error(self, frame: drv.Frame) -> drv.BusError:
        return dpc._pcan_bus_error(frame.can_id, frame.data)

    def send(self, frame: drv.Frame) -> None:
        pass

    def state(self) -> drv.ControllerState:
        return drv.ControllerState()

    def close(self) -> None:
        pass


class _Driver:
    def __init__(self) -> None:
        self.opened: list[_ErrorChannel] = []

    def list_channels(self):
        return [drv.Channel(id="e:0", display_name="e")]

    def open(self, channel_id: str, config: drv.OpenConfig) -> _ErrorChannel:
        ch = _ErrorChannel(channel_id)
        self.opened.append(ch)
        return ch


def _collect(box: SessionOutbox, until, timeout_s: float = 3.0) -> list[pb.Envelope]:
    got: list[pb.Envelope] = []
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline and not until(got):
        try:
            got.append(box.get(timeout=0.05))
        except queue.Empty:
            pass
    return got


def test_the_pump_forwards_only_the_first_rows_and_reports_the_episode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(si, "_STATE_POLL_INTERVAL_S", 0.05)
    reg = si._InterfaceRegistry(_Driver())
    reg.set_error_row_cap("e:0", 4)
    box = SessionOutbox()
    reg.subscribe("e:0", box)
    try:
        ch = reg._interfaces["e:0"]._channel
        t0 = time.time_ns()
        ch.enqueue(_error_frame(t0, can_id=0))  # counter update: no row
        for i in range(50):
            ch.enqueue(_error_frame(t0 + i))

        def closed(got: list) -> bool:
            return any(
                e.HasField("bus_error_episode") and not e.bus_error_episode.open
                for e in got
            )

        got = _collect(box, closed)
    finally:
        reg.unsubscribe("e:0", box)
    rows = [f for e in got if e.HasField("frame_batch") for f in e.frame_batch.frames]
    assert len(rows) == 4
    reports = [e.bus_error_episode for e in got if e.HasField("bus_error_episode")]
    assert reports[0].open is True
    final = reports[-1]
    assert (final.seq, final.count, final.count_by_kind.ack, final.tx_count) == (
        1,
        50,
        50,
        50,
    )
    assert final.open is False


def test_an_open_episode_is_republished_at_the_poll_cadence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(si, "_STATE_POLL_INTERVAL_S", 0.05)
    reg = si._InterfaceRegistry(_Driver())
    box = SessionOutbox()
    reg.subscribe("e:0", box)
    stop = threading.Event()
    try:
        ch = reg._interfaces["e:0"]._channel

        def feed() -> None:
            while not stop.wait(0.01):
                ch.enqueue(_error_frame(time.time_ns()))

        threading.Thread(target=feed, daemon=True).start()
        seen: list[pb.BusErrorEpisode] = []
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            try:
                env = box.get(timeout=0.05)
            except queue.Empty:
                continue
            if env.HasField("bus_error_episode"):
                seen.append(env.bus_error_episode)
    finally:
        stop.set()
        reg.unsubscribe("e:0", box)
    assert len(seen) >= 5
    assert all(r.open and r.seq == 1 for r in seen)
    counts = [r.count for r in seen]
    assert counts == sorted(counts) and counts[-1] > counts[0]
