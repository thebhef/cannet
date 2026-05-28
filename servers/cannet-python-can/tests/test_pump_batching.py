"""Tests for :class:`cannet_python_can.server._SharedInterface`'s rx pump.

Locks down the batching behaviour the pump relies on for throughput:

- A single frame produces a single-frame envelope (low-rate parity
  with the pre-batching pump).
- A burst of frames already buffered when the pump wakes is drained
  into one envelope, not one envelope per frame.
- The batch cap (``_BATCH_MAX_FRAMES``) is honoured — a burst over
  the cap splits into multiple envelopes.

The tests substitute a fake driver / channel so they're hardware-free
and deterministic; nothing here depends on real timing.
"""

from __future__ import annotations

import queue
import sys
import threading
import time
from pathlib import Path
from typing import Optional


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


from cannet_python_can import server as srv  # noqa: E402
from cannet_python_can import driver as drv  # noqa: E402
from cannet_python_can.driver import Frame  # noqa: E402


def _frame(i: int) -> Frame:
    return Frame(
        timestamp_ns=i,
        can_id=0x100 + i,
        extended=False,
        is_rx=True,
        data=b"\x00",
        fd=False,
        brs=False,
        esi=False,
        is_remote=False,
        is_error=False,
        dlc=1,
    )


class _FakeChannel:
    """Pops frames from a thread-safe queue; ``recv`` blocks up to the
    timeout for the next one."""

    def __init__(self, channel_id: str = "fake:0") -> None:
        self.channel_id = channel_id
        self._q: "queue.Queue[Frame]" = queue.Queue()
        self._state = drv.ControllerState()
        self.closed = threading.Event()
        self.sent: list[Frame] = []

    def enqueue(self, frame: Frame) -> None:
        self._q.put(frame)

    def recv(self, timeout_s: float) -> Optional[Frame]:
        try:
            return (
                self._q.get(timeout=timeout_s)
                if timeout_s > 0
                else self._q.get_nowait()
            )
        except queue.Empty:
            return None

    def send(self, frame: Frame) -> None:
        self.sent.append(frame)

    def state(self) -> drv.ControllerState:
        return self._state

    def set_state(self, state: drv.ControllerState) -> None:
        self._state = state

    def close(self) -> None:
        self.closed.set()


class _FakeDriver:
    """Driver that hands out a pre-seeded channel on ``open``."""

    def __init__(self, channel_id: str = "fake:0") -> None:
        self._channel_id = channel_id
        self._channels: list[_FakeChannel] = []

    def list_channels(self):
        return [
            drv.Channel(id=self._channel_id, display_name="fake")
        ]

    def open(self, channel_id: str, config: drv.OpenConfig) -> _FakeChannel:
        if channel_id != self._channel_id:
            raise KeyError(channel_id)
        ch = _FakeChannel(channel_id=channel_id)
        self._channels.append(ch)
        return ch

    @property
    def opened(self) -> list[_FakeChannel]:
        return list(self._channels)


def _drain_frame_batches(
    outbox: "queue.Queue", *, until: int, timeout_s: float = 3.0
) -> list:
    """Pull envelopes off ``outbox`` until ``until`` frames have arrived
    across ``FrameBatch`` envelopes (ignoring control envelopes like
    ``InterfaceState`` snapshots)."""
    batches: list = []
    seen = 0
    deadline = time.monotonic() + timeout_s
    while seen < until and time.monotonic() < deadline:
        try:
            env = outbox.get(timeout=0.5)
        except queue.Empty:
            continue
        if env.WhichOneof("body") != "frame_batch":
            continue
        batches.append(env)
        seen += len(env.frame_batch.frames)
    if seen < until:
        raise AssertionError(
            f"only collected {seen}/{until} frames across "
            f"{len(batches)} envelopes before timeout"
        )
    return batches


def _attach_with_frames(
    *, channel_id: str = "fake:0", frames: list[Frame]
) -> tuple[srv._SharedInterface, "queue.Queue", _FakeChannel]:
    """Build a shared interface, attach one outbox, pre-queue ``frames``
    onto the underlying fake channel before the pump wakes.

    The pre-queueing matters: the rx pump's "drain everything already
    buffered into one envelope" path is what these tests exercise, and
    that only fires when the data is already there at the moment the
    pump enters its drain loop.
    """
    driver = _FakeDriver(channel_id=channel_id)
    shared = srv._SharedInterface(
        driver=driver,
        channel_id=channel_id,
        initial_config=drv.OpenConfig(),
    )
    outbox: "queue.Queue" = queue.Queue()
    # Open the channel up front, queue frames, then attach. ``attach``
    # is what triggers the pump-start path; queueing first guarantees
    # the burst is already buffered when the pump enters its drain
    # loop, which is what the batching test wants to observe.
    with shared._lock:
        shared._open_locked()
        # ``_open_locked`` opens the channel via the driver; pull it
        # back out so the test can enqueue frames before attach.
        ch = shared._channel
    assert isinstance(ch, _FakeChannel)
    for f in frames:
        ch.enqueue(f)
    # Now attach: the pump is already running and will see the queued
    # burst on its very first wake.
    shared._outboxes.append(outbox)
    # Push an initial state snapshot to the outbox (mirroring what
    # ``attach`` does for production callers).
    return shared, outbox, ch


def test_single_frame_emits_a_single_frame_envelope() -> None:
    """Low-rate parity: one frame in, one envelope out with one frame
    in it. Mirrors the pre-batching behaviour at sub-batching rates."""
    shared, outbox, _ch = _attach_with_frames(frames=[_frame(0)])
    try:
        [env] = _drain_frame_batches(outbox, until=1)
        assert env.frame_batch.interface_id == "fake:0"
        assert len(env.frame_batch.frames) == 1
        assert env.frame_batch.frames[0].can_id == 0x100
    finally:
        shared._stop.set()


def test_burst_of_buffered_frames_drains_into_one_envelope() -> None:
    """When a burst of frames is already buffered by the driver, the
    pump should drain the whole burst (up to the cap) into one
    envelope instead of emitting one envelope per frame."""
    burst = [_frame(i) for i in range(20)]
    shared, outbox, _ch = _attach_with_frames(frames=burst)
    try:
        [env] = _drain_frame_batches(outbox, until=20)
        assert len(env.frame_batch.frames) == 20
        assert [f.can_id for f in env.frame_batch.frames] == [
            0x100 + i for i in range(20)
        ]
    finally:
        shared._stop.set()


def test_burst_over_cap_splits_into_multiple_envelopes() -> None:
    """A burst larger than ``_BATCH_MAX_FRAMES`` must produce more
    than one envelope, each capped at the limit."""
    cap = srv._BATCH_MAX_FRAMES
    total = cap * 2 + 5
    burst = [_frame(i) for i in range(total)]
    shared, outbox, _ch = _attach_with_frames(frames=burst)
    try:
        envelopes = _drain_frame_batches(outbox, until=total)
        seen = sum(len(env.frame_batch.frames) for env in envelopes)
        assert seen == total
        assert all(
            len(env.frame_batch.frames) <= cap for env in envelopes
        ), "an envelope exceeded the batch cap"
        assert len(envelopes) >= 3, (
            "burst of 2*cap+5 should produce at least 3 envelopes"
        )
    finally:
        shared._stop.set()
