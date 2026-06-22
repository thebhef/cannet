"""Tests for the server-side ``WatchInterfaces`` subscription.

Drives ``CannetServerService`` against a stub driver whose enumeration
can be mutated at runtime, covering the seed-on-subscribe snapshot, the
no-timer-repoll policy (enumeration contends with transmit on PCAN, so
refresh is an explicit ``ListInterfaces`` pull), and clean exit on
context cancel — all without any vendor SDKs.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


from cannet_python_can import driver as drv  # noqa: E402
from cannet_python_can import server as srv  # noqa: E402
from cannet_python_can._proto import cannet_pb2 as pb  # noqa: E402


class _StubDriver:
    """Driver shim whose channel list is mutable from the test thread."""

    def __init__(self, channels: list[drv.Channel]) -> None:
        self._channels = list(channels)
        self._lock = threading.Lock()

    def list_channels(self) -> list[drv.Channel]:
        with self._lock:
            return list(self._channels)

    def set(self, channels: list[drv.Channel]) -> None:
        with self._lock:
            self._channels = list(channels)

    def open(self, channel_id: str, config: drv.OpenConfig) -> drv.OpenChannel:
        raise KeyError(channel_id)


class _StubContext:
    """Minimal stand-in for ``grpc.ServicerContext`` so we can call
    ``WatchInterfaces`` directly from a test thread."""

    def __init__(self) -> None:
        self._active = True
        self._callbacks: list = []

    def is_active(self) -> bool:
        return self._active

    def add_callback(self, cb) -> None:
        self._callbacks.append(cb)

    def cancel(self) -> None:
        self._active = False
        for cb in self._callbacks:
            cb()


def _ch(id_: str, *, fd: bool = False, display: str | None = None) -> drv.Channel:
    return drv.Channel(id=id_, display_name=display or id_, fd_capable=fd)


def _drain(it, n: int, timeout_s: float = 2.0) -> list[pb.InterfaceList]:
    """Pull `n` items off the watcher iterator from a background thread,
    with a hard timeout so a stuck watcher fails the test rather than
    hanging the suite."""
    out: list[pb.InterfaceList] = []
    err: list[BaseException] = []

    def _run() -> None:
        try:
            for _ in range(n):
                out.append(next(it))
        except BaseException as e:  # noqa: BLE001
            err.append(e)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout_s)
    assert not t.is_alive(), f"watcher did not yield {n} items within {timeout_s}s"
    if err:
        raise err[0]
    return out


def test_watch_emits_initial_snapshot_immediately() -> None:
    driver = _StubDriver([_ch("can0"), _ch("can1", fd=True)])
    svc = srv.CannetServerService(driver, watch_recheck_interval_s=0.05)
    ctx = _StubContext()

    it = svc.WatchInterfaces(pb.WatchInterfacesRequest(), ctx)
    snapshots = _drain(it, 1)
    ctx.cancel()
    # Drain any final yields the cancel may unblock.
    list(it)

    assert len(snapshots) == 1
    ids = [i.id for i in snapshots[0].interfaces]
    assert ids == ["can0", "can1"]
    assert snapshots[0].interfaces[1].fd_capable is True


def test_watch_does_not_repoll_hotplug_but_explicit_list_reflects_it() -> None:
    """Server-side cadence policy (ADR 0016): the PCAN-backed sidecar
    does not re-enumerate on a timer — that call contends with active
    transmits — so a hot-plug after subscribe is *not* pushed through the
    watch stream. The change is picked up by an explicit `ListInterfaces`
    pull (the GUI's "Discover" button)."""
    driver = _StubDriver([_ch("can0")])
    svc = srv.CannetServerService(driver, watch_recheck_interval_s=0.05)
    ctx = _StubContext()

    it = svc.WatchInterfaces(pb.WatchInterfacesRequest(), ctx)
    [first] = _drain(it, 1)
    assert [i.id for i in first.interfaces] == ["can0"]

    # Hot-plug a second interface. The watch stream must NOT push a fresh
    # snapshot — there is no timer poll. `_drain` times out (raising
    # AssertionError) because no second item ever arrives.
    driver.set([_ch("can0"), _ch("can1", fd=True)])
    with pytest.raises(AssertionError):
        _drain(it, 1, timeout_s=0.3)

    # But an explicit pull reflects the new hardware immediately.
    listed = svc.ListInterfaces(pb.ListInterfacesRequest(), ctx)
    assert [i.id for i in listed.interfaces] == ["can0", "can1"]
    assert listed.interfaces[1].fd_capable is True

    # The drain thread is still parked inside the generator; cancelling
    # wakes it so the daemon exits cleanly at teardown.
    ctx.cancel()


def test_watch_does_not_repeat_unchanged_snapshots() -> None:
    """A stable subscription must not retrigger yields — the GUI host's
    event channel stays quiet on quiet hardware."""
    driver = _StubDriver([_ch("can0")])
    svc = srv.CannetServerService(driver, watch_recheck_interval_s=0.05)
    ctx = _StubContext()

    it = svc.WatchInterfaces(pb.WatchInterfacesRequest(), ctx)
    _drain(it, 1)

    # Let several poll ticks elapse with no driver mutation.
    time.sleep(0.3)

    # No additional snapshot should be sitting in the iterator. We
    # confirm by asserting `_drain` would time out — which it does by
    # raising AssertionError. The drain thread is left waiting on the
    # generator; cancelling the context wakes it so the daemon exits
    # cleanly at test teardown.
    with pytest.raises(AssertionError):
        _drain(it, 1, timeout_s=0.2)

    ctx.cancel()


def test_watch_exits_on_context_cancel() -> None:
    """Disconnect-wakes-watcher: cancelling the context must unblock
    any waiter without the test having to time out."""
    driver = _StubDriver([_ch("can0")])
    svc = srv.CannetServerService(driver, watch_recheck_interval_s=0.05)
    ctx = _StubContext()

    it = svc.WatchInterfaces(pb.WatchInterfacesRequest(), ctx)
    _drain(it, 1)

    done = threading.Event()

    def _consume() -> None:
        for _ in it:
            pass
        done.set()

    t = threading.Thread(target=_consume, daemon=True)
    t.start()
    # Sit in `wait_for` for a moment, then cancel.
    time.sleep(0.1)
    ctx.cancel()
    assert done.wait(timeout=1.0), "watcher did not exit on context cancel"
