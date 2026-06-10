"""Tests for :class:`cannet_python_can.server._Subscription`'s rx pump.

Locks down the batching behaviour the pump relies on for throughput:

- A single frame produces a single-frame envelope (low-rate parity
  with the pre-batching pump).
- A burst of frames already buffered when the pump wakes is drained
  into one envelope, not one envelope per frame.
- The batch cap (``_BATCH_MAX_FRAMES``) is honoured — a 600-frame
  burst splits into two-plus envelopes, never one giant one.

The tests substitute a fake ``OpenChannel`` so they're hardware-free
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
    timeout for the next one. When the test sets ``done``, an empty
    queue returns None immediately so the pump can exit cleanly."""

    def __init__(self, channel_id: str = "fake:0") -> None:
        self.channel_id = channel_id
        self._q: "queue.Queue[Frame]" = queue.Queue()
        self.done = threading.Event()
        self._closed = threading.Event()

    def enqueue(self, frame: Frame) -> None:
        self._q.put(frame)

    def recv(self, timeout_s: float) -> Optional[Frame]:
        try:
            return self._q.get(timeout=timeout_s if timeout_s > 0 else None) \
                if timeout_s > 0 else self._q.get_nowait()
        except queue.Empty:
            return None

    def send(self, frame: Frame) -> None:  # pragma: no cover - rx only
        raise NotImplementedError

    def close(self) -> None:
        self._closed.set()


def _collect_envelopes(outbox: "queue.Queue", *, count: int, timeout_s: float = 2.0):
    """Pull ``count`` envelopes off the outbox or fail with what arrived."""
    envelopes = []
    deadline = time.monotonic() + timeout_s
    while len(envelopes) < count:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError(
                f"only collected {len(envelopes)}/{count} envelopes before timeout"
            )
        try:
            envelopes.append(outbox.get(timeout=remaining))
        except queue.Empty:
            continue
    return envelopes


def test_single_frame_emits_a_single_frame_envelope() -> None:
    """Low-rate parity: one frame in, one envelope out with one frame
    in it. Mirrors the pre-batching behaviour at sub-batching rates."""
    chan = _FakeChannel()
    outbox: "queue.Queue" = queue.Queue()
    chan.enqueue(_frame(0))
    sub = srv._Subscription(channel=chan, outbox=outbox)
    try:
        [env] = _collect_envelopes(outbox, count=1)
        assert env.WhichOneof("body") == "frame_batch"
        assert env.frame_batch.interface_id == "fake:0"
        assert len(env.frame_batch.frames) == 1
        assert env.frame_batch.frames[0].can_id == 0x100
    finally:
        sub.stop()


def test_burst_of_buffered_frames_drains_into_one_envelope() -> None:
    """When a burst of frames is already buffered by the driver, the
    pump should drain the whole burst (up to the cap) into one
    envelope instead of emitting one envelope per frame."""
    chan = _FakeChannel()
    outbox: "queue.Queue" = queue.Queue()
    for i in range(20):
        chan.enqueue(_frame(i))
    sub = srv._Subscription(channel=chan, outbox=outbox)
    try:
        [env] = _collect_envelopes(outbox, count=1)
        assert len(env.frame_batch.frames) == 20
        assert [f.can_id for f in env.frame_batch.frames] == [
            0x100 + i for i in range(20)
        ]
    finally:
        sub.stop()


def test_burst_over_cap_splits_into_multiple_envelopes() -> None:
    """A burst larger than ``_BATCH_MAX_FRAMES`` must produce more
    than one envelope, each capped at the limit."""
    cap = srv._BATCH_MAX_FRAMES
    total = cap * 2 + 5
    chan = _FakeChannel()
    outbox: "queue.Queue" = queue.Queue()
    for i in range(total):
        chan.enqueue(_frame(i))
    sub = srv._Subscription(channel=chan, outbox=outbox)
    try:
        envelopes = []
        seen = 0
        deadline = time.monotonic() + 3.0
        while seen < total and time.monotonic() < deadline:
            try:
                env = outbox.get(timeout=0.5)
            except queue.Empty:
                continue
            envelopes.append(env)
            seen += len(env.frame_batch.frames)
        assert seen == total, (
            f"expected {total} frames across envelopes, got {seen}"
        )
        assert all(
            len(env.frame_batch.frames) <= cap for env in envelopes
        ), "an envelope exceeded the batch cap"
        assert len(envelopes) >= 3, (
            "burst of 2*cap+5 should produce at least 3 envelopes"
        )
    finally:
        sub.stop()
