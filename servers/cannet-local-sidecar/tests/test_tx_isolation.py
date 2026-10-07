"""One interface's transmit path never delays another's (ADR 0060
rule 6).

A session's transmit requests are read by one thread. If that thread
waits on one interface's transmit queue, every other interface on the
session transmits at the pace of the slowest -- the lockstep the
2026-10-04 bench retest showed, where a PEAK channel refusing every send
held its healthy sibling to a fraction of its period rate. Here
interface A refuses each send slowly (a slept few milliseconds, a driver
taking its time to say "queue full") while interface B accepts at once,
both offered the same rate through the real ``Session`` handler; B must
keep its offered rate.

No hardware, no network: the handler is driven in-process with a paced
request generator, and the fake channels pace by sleeping.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from typing import Optional


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()

from cannet_python_wire._proto import cannet_pb2 as pb  # noqa: E402

from cannet_local_sidecar import driver as drv  # noqa: E402
from cannet_local_sidecar.server import service  # noqa: E402

#: Offered sends per second on each interface -- the bench's periodic
#: rate per channel.
_OFFERED_PER_S = 800.0
#: How long one refused send takes on the slow interface.
_SLOW_REFUSAL_S = 0.005
_WARMUP_S = 0.5
_WINDOW_S = 2.0


class _Channel:
    def __init__(self, channel_id: str, *, slow_refusal_s: float) -> None:
        self.channel_id = channel_id
        self._slow = slow_refusal_s
        self.accepted_at: list[float] = []
        self._closed = threading.Event()

    def recv(self, timeout_s: float) -> Optional[drv.Frame]:
        self._closed.wait(timeout_s)
        return None

    def send(self, frame: drv.Frame) -> None:
        if self._slow:
            time.sleep(self._slow)
            raise drv.TxRejected("The transmit queue is full", queue_full=True)
        self.accepted_at.append(time.monotonic())

    def flush_tx(self) -> bool:
        return True

    def state(self) -> drv.ControllerState:
        return drv.ControllerState()

    def rx_loss(self) -> Optional[int]:
        return None

    def close(self) -> None:
        self._closed.set()


class _Driver:
    def __init__(self) -> None:
        self.channels: dict[str, _Channel] = {}

    def list_channels(self):
        return [drv.Channel(id=i, display_name=i) for i in ("a", "b")]

    def open(self, channel_id: str, config: drv.OpenConfig) -> _Channel:
        ch = _Channel(
            channel_id, slow_refusal_s=_SLOW_REFUSAL_S if channel_id == "a" else 0.0
        )
        self.channels[channel_id] = ch
        return ch


def test_a_slowly_refusing_interface_does_not_hold_back_its_sibling() -> None:
    driver = _Driver()
    svc = service.CannetServerService(driver)
    frame = pb.Frame(can_id=0x123, data=b"\x00" * 8, dlc=8, kind=pb.FRAME_KIND_CLASSIC)
    t_end = time.monotonic() + _WARMUP_S + _WINDOW_S

    def requests():
        for cid in ("a", "b"):
            yield pb.Envelope(subscribe=pb.Subscribe(interface_id=cid))
        t0 = time.monotonic()
        n = 0
        while time.monotonic() < t_end:
            wait = t0 + n / _OFFERED_PER_S - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            for cid in ("a", "b"):
                yield pb.Envelope(
                    frame_batch=pb.FrameBatch(interface_id=cid, frames=[frame])
                )
            n += 1

    responses = svc.Session(requests(), None)
    reader = threading.Thread(target=lambda: [None for _ in responses], daemon=True)
    t_start = time.monotonic()
    reader.start()
    reader.join(timeout=_WARMUP_S + _WINDOW_S + 10)

    b = driver.channels["b"]
    w0 = t_start + _WARMUP_S
    in_window = [t for t in b.accepted_at if w0 <= t < w0 + _WINDOW_S]
    rate = len(in_window) / _WINDOW_S
    print(f"\nB accepted {rate:.0f}/s of {_OFFERED_PER_S:.0f}/s offered")
    assert rate >= 0.9 * _OFFERED_PER_S, (
        f"B held to {rate:.0f}/s of {_OFFERED_PER_S:.0f}/s by A's slow refusals"
    )
