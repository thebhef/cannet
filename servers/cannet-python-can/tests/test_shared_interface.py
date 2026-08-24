"""Tests for the hardware-server wire model (ADR 0022).

Covers the four behaviours that distinguish the new
``_SharedInterface`` / ``_InterfaceRegistry`` shape from the
pre-Phase-13 per-session ``_Subscription`` shape:

- **Reference-counted lifecycle.** First ``Subscribe`` opens the
  underlying python-can ``Bus``; last ``Unsubscribe`` closes it.
  Intermediate subscribes / unsubscribes do not.
- **Multi-client fan-out.** Frames received from the channel land on
  every subscribed session's outbox.
- **``ConfigureBus`` plumbing.** A wire ``ConfigureBus`` arriving
  before any subscribe is remembered and applied at the next open; a
  ``ConfigureBus`` arriving while the bus is open closes + reopens
  with the new config.
- **``InterfaceState`` push.** Subscribers receive a snapshot on
  subscribe; subsequent state transitions are broadcast to every
  subscriber.
"""

from __future__ import annotations

import logging
import queue
import sys
import threading
import time
from pathlib import Path
from typing import Optional

import pytest


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


from cannet_python_can import driver as drv  # noqa: E402
from cannet_python_can import server as srv  # noqa: E402
from cannet_python_can.server import shared_interface as si  # noqa: E402
from cannet_python_can._proto import cannet_pb2 as pb  # noqa: E402


def _frame(i: int) -> drv.Frame:
    return drv.Frame(
        timestamp_ns=i,
        can_id=0x100 + i,
        extended=False,
        is_rx=True,
        data=b"\x00",
        kind=drv.FrameKind.CLASSIC,
        brs=False,
        esi=False,
        dlc=1,
    )


class _FakeChannel:
    def __init__(self, channel_id: str = "fake:0") -> None:
        self.channel_id = channel_id
        self._q: "queue.Queue[drv.Frame]" = queue.Queue()
        self._state = drv.ControllerState()
        self.closed = threading.Event()
        self.sent: list[drv.Frame] = []

    def enqueue(self, frame: drv.Frame) -> None:
        self._q.put(frame)

    def recv(self, timeout_s: float) -> Optional[drv.Frame]:
        try:
            return (
                self._q.get(timeout=timeout_s)
                if timeout_s > 0
                else self._q.get_nowait()
            )
        except queue.Empty:
            return None

    def send(self, frame: drv.Frame) -> None:
        self.sent.append(frame)

    def state(self) -> drv.ControllerState:
        return self._state

    def set_state(self, state: drv.ControllerState) -> None:
        self._state = state

    def close(self) -> None:
        self.closed.set()


class _FakeDriver:
    """Driver that hands out a fresh ``_FakeChannel`` on each ``open``."""

    def __init__(self, channel_id: str = "fake:0") -> None:
        self._channel_id = channel_id
        self.opened: list[_FakeChannel] = []
        self.configs: list[drv.OpenConfig] = []

    def list_channels(self):
        return [drv.Channel(id=self._channel_id, display_name="fake")]

    def open(self, channel_id: str, config: drv.OpenConfig) -> _FakeChannel:
        if channel_id != self._channel_id:
            raise KeyError(channel_id)
        ch = _FakeChannel(channel_id=channel_id)
        self.opened.append(ch)
        self.configs.append(config)
        return ch


def _wait_for(predicate, *, timeout_s: float = 2.0, poll_s: float = 0.01) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(poll_s)
    raise AssertionError("predicate did not become true within timeout")


def _drain(
    outbox: "queue.Queue",
    *,
    kind: str,
    count: int = 1,
    timeout_s: float = 2.0,
) -> list:
    """Pull ``count`` envelopes of ``kind`` off ``outbox``."""
    out: list = []
    deadline = time.monotonic() + timeout_s
    while len(out) < count and time.monotonic() < deadline:
        try:
            env = outbox.get(timeout=0.1)
        except queue.Empty:
            continue
        if env.WhichOneof("body") == kind:
            out.append(env)
    if len(out) < count:
        raise AssertionError(f"only got {len(out)}/{count} envelopes of kind {kind!r}")
    return out


# ---- reference-counted lifecycle ------------------------------------------


def test_first_subscribe_opens_underlying_bus() -> None:
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    outbox: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", outbox)
    assert len(driver.opened) == 1
    assert not driver.opened[0].closed.is_set()


def test_second_subscribe_does_not_reopen() -> None:
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    b: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    reg.subscribe("fake:0", b)
    assert len(driver.opened) == 1


def test_last_unsubscribe_closes_underlying_bus() -> None:
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    b: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    reg.subscribe("fake:0", b)
    reg.unsubscribe("fake:0", a)
    assert not driver.opened[0].closed.is_set(), (
        "channel should stay open while another session is subscribed"
    )
    reg.unsubscribe("fake:0", b)
    _wait_for(lambda: driver.opened[0].closed.is_set())


# ---- multi-client fan-out -------------------------------------------------


def test_received_frame_fans_out_to_every_subscriber() -> None:
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    b: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    reg.subscribe("fake:0", b)
    driver.opened[0].enqueue(_frame(7))

    [env_a] = _drain(a, kind="frame_batch")
    [env_b] = _drain(b, kind="frame_batch")
    assert env_a.frame_batch.frames[0].can_id == 0x107
    assert env_b.frame_batch.frames[0].can_id == 0x107


def test_transmit_from_any_subscriber_reaches_the_shared_bus() -> None:
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    b: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    reg.subscribe("fake:0", b)

    reg.transmit("fake:0", _frame(1), a)
    reg.transmit("fake:0", _frame(2), b)

    # Delivery is asynchronous (per-interface TX worker) but ordered.
    _wait_for(lambda: len(driver.opened[0].sent) == 2)
    sent = driver.opened[0].sent
    assert [f.can_id for f in sent] == [0x101, 0x102]


def test_transmit_does_not_block_on_a_slow_send() -> None:
    """The whole point of the TX worker: ``transmit`` is an enqueue, so
    a slow ``ch.send`` (device TX-buffer stall, ~ms-class python-can
    overhead) never blocks the gRPC reader thread that also carries
    every other interface's traffic."""
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    ch = driver.opened[0]

    release = threading.Event()
    orig_send = ch.send

    def slow_send(frame: drv.Frame) -> None:
        release.wait(2.0)
        orig_send(frame)

    ch.send = slow_send  # type: ignore[method-assign]

    t0 = time.monotonic()
    for i in range(5):
        reg.transmit("fake:0", _frame(i), a)
    enqueue_s = time.monotonic() - t0
    assert enqueue_s < 0.5, f"transmit blocked {enqueue_s:.2f}s on a slow send"
    assert len(ch.sent) == 0, "nothing delivered while the send is stalled"

    release.set()
    _wait_for(lambda: len(ch.sent) == 5)
    assert [f.can_id for f in ch.sent] == [0x100 + i for i in range(5)]


def test_worker_tx_rejected_routes_to_the_submitting_outbox() -> None:
    """A validation failure surfacing from ``ch.send`` still reaches
    the session that transmitted — and only that session — even though
    the send happens on the worker thread."""
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    b: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    reg.subscribe("fake:0", b)
    ch = driver.opened[0]

    def rejecting_send(frame: drv.Frame) -> None:
        raise drv.TxRejected("dlc disagrees with len(data)")

    ch.send = rejecting_send  # type: ignore[method-assign]
    reg.transmit("fake:0", _frame(1), a)

    def a_got_error() -> bool:
        try:
            env = a.get_nowait()
        except queue.Empty:
            return False
        return (
            env.WhichOneof("body") == "error"
            and env.error.code == pb.Error.CODE_TX_REJECTED
        )

    _wait_for(a_got_error)
    # The other session saw nothing (its queue holds only its
    # subscribe-time InterfaceState snapshot).
    leftovers = []
    while True:
        try:
            leftovers.append(b.get_nowait())
        except queue.Empty:
            break
    assert all(e.WhichOneof("body") != "error" for e in leftovers)


def test_transmit_after_close_raises_at_enqueue() -> None:
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    reg.unsubscribe("fake:0", a)
    shared = srv._SharedInterface(
        driver=driver, channel_id="fake:0", initial_config=drv.OpenConfig()
    )
    try:
        shared.transmit(_frame(1), a)
    except drv.TxRejected:
        pass
    else:
        raise AssertionError("transmit on a closed interface must raise")


# ---- ConfigureBus plumbing ------------------------------------------------


def test_configure_bus_before_subscribe_applied_at_next_open() -> None:
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)

    reg.reconfigure(
        "fake:0",
        drv.OpenConfig(bitrate_bps=500_000, fd=True, data_bitrate_bps=2_000_000),
    )
    outbox: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", outbox)

    assert len(driver.configs) == 1
    cfg = driver.configs[0]
    assert cfg.bitrate_bps == 500_000
    assert cfg.fd is True
    assert cfg.data_bitrate_bps == 2_000_000


def test_configure_bus_while_open_close_and_reopens() -> None:
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    outbox: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", outbox)
    first_channel = driver.opened[0]

    reg.reconfigure("fake:0", drv.OpenConfig(bitrate_bps=250_000))

    _wait_for(lambda: len(driver.opened) == 2)
    second_channel = driver.opened[1]
    _wait_for(lambda: first_channel.closed.is_set())
    assert not second_channel.closed.is_set()
    assert driver.configs[1].bitrate_bps == 250_000


def test_configure_bus_speed_zero_treated_as_unset() -> None:
    """A wire ``ConfigureBus`` with ``speed_bps == 0`` and
    ``fd_data_speed_bps == 0`` translates to ``None`` fields on
    :class:`OpenConfig` — the driver picks its own default."""
    msg = pb.ConfigureBus(
        interface_id="fake:0", speed_bps=0, fd_data_speed_bps=0, fd_enabled=False
    )
    cfg = srv._configure_to_open_config(msg)
    assert cfg.bitrate_bps is None
    assert cfg.data_bitrate_bps is None
    assert cfg.fd is False


# ---- InterfaceState push --------------------------------------------------


def test_subscribe_pushes_state_snapshot() -> None:
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    outbox: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", outbox)

    [env] = _drain(outbox, kind="interface_state")
    assert env.interface_state.interface_id == "fake:0"
    assert env.interface_state.state == pb.CONTROLLER_STATE_ACTIVE
    assert env.interface_state.tec == 0
    assert env.interface_state.rec == 0


def test_state_transition_pushes_to_every_subscriber() -> None:
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    b: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    reg.subscribe("fake:0", b)
    # Drain the initial snapshots so we only count transitions below.
    _drain(a, kind="interface_state")
    _drain(b, kind="interface_state")

    driver.opened[0].set_state(
        drv.ControllerState(state=drv.STATE_PASSIVE, tec=120, rec=0)
    )

    [env_a] = _drain(a, kind="interface_state", timeout_s=3.0)
    [env_b] = _drain(b, kind="interface_state", timeout_s=3.0)
    for env in (env_a, env_b):
        assert env.interface_state.state == pb.CONTROLLER_STATE_PASSIVE
        assert env.interface_state.tec == 120


def test_bus_off_state_maps_to_proto_bus_off() -> None:
    """The driver layer reports ``STATE_BUS_OFF``; the wire layer
    forwards it as ``CONTROLLER_STATE_BUS_OFF``."""
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    outbox: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", outbox)
    _drain(outbox, kind="interface_state")

    driver.opened[0].set_state(
        drv.ControllerState(state=drv.STATE_BUS_OFF, tec=255, rec=120)
    )

    [env] = _drain(outbox, kind="interface_state", timeout_s=3.0)
    assert env.interface_state.state == pb.CONTROLLER_STATE_BUS_OFF
    assert env.interface_state.tec == 255
    assert env.interface_state.rec == 120


def test_warning_state_maps_to_proto_warning() -> None:
    """The counter-derived warning level rides its own wire value; a
    build that folded it into active would show a bus over the ISO
    warning limit as healthy, which is the reading an unplugged CAN
    cable produced."""
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    outbox: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", outbox)
    _drain(outbox, kind="interface_state")

    driver.opened[0].set_state(
        drv.ControllerState(state=drv.STATE_WARNING, tec=104, rec=0)
    )

    [env] = _drain(outbox, kind="interface_state", timeout_s=3.0)
    assert env.interface_state.state == pb.CONTROLLER_STATE_WARNING
    assert env.interface_state.tec == 104


def test_a_pinned_controller_publishes_once_however_long_the_fault_lasts() -> None:
    """Coalescing, where it has to happen.

    A transmitter driving an open circuit produced about 5,200 error
    frames a second on the bench, each one carrying the counters this
    state is derived from. Publishing an ``InterfaceState`` per frame
    would flood every subscriber; the poll's own cadence plus the
    publish-on-change gate is what keeps it to one envelope per actual
    transition. Three poll intervals with the counters pinned must
    produce exactly one.
    """
    driver = _FakeDriver()
    reg = srv._InterfaceRegistry(driver)
    outbox: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", outbox)
    _drain(outbox, kind="interface_state")

    driver.opened[0].set_state(
        drv.ControllerState(state=drv.STATE_PASSIVE, tec=128, rec=0)
    )
    _drain(outbox, kind="interface_state", timeout_s=3.0)

    time.sleep(si._STATE_POLL_INTERVAL_S * 3)
    extra = []
    while True:
        try:
            env = outbox.get_nowait()
        except queue.Empty:
            break
        if env.WhichOneof("body") == "interface_state":
            extra.append(env)
    assert extra == [], "a pinned controller re-published while nothing changed"


# ---- error broadcast (item #23) -------------------------------------------


class _ReopenFailsDriver:
    """Opens the channel successfully once, then fails every reopen so
    the ``reconfigure`` error-broadcast path can be exercised."""

    def __init__(self, channel_id: str = "fake:0") -> None:
        self._channel_id = channel_id
        self.opens = 0
        self.first: Optional[_FakeChannel] = None

    def list_channels(self):
        return [drv.Channel(id=self._channel_id, display_name="fake")]

    def open(self, channel_id: str, config: drv.OpenConfig) -> _FakeChannel:
        if channel_id != self._channel_id:
            raise KeyError(channel_id)
        self.opens += 1
        if self.opens == 1:
            self.first = _FakeChannel(channel_id=channel_id)
            return self.first
        raise OSError("reopen boom")


def _new_shared() -> "srv._SharedInterface":
    return srv._SharedInterface(
        driver=_FakeDriver(), channel_id="fake:0", initial_config=drv.OpenConfig()
    )


def test_broadcast_error_fans_out_to_all_outboxes() -> None:
    shared = _new_shared()
    a: "queue.Queue" = queue.Queue()
    b: "queue.Queue" = queue.Queue()
    shared._outboxes = [a, b]

    shared._broadcast_error(pb.LOG_LEVEL_ERROR, "boom")

    for q in (a, b):
        env = q.get(timeout=1.0)
        assert env.WhichOneof("body") == "log"
        assert env.log.level == pb.LOG_LEVEL_ERROR
        assert env.log.message == "boom"


def test_broadcast_error_under_held_lock_does_not_deadlock() -> None:
    """Regression guard: the ``reconfigure`` call site fans out while
    already holding the non-reentrant ``self._lock``. The helper must
    read the outbox list without re-acquiring the lock — a reentrant
    re-lock would deadlock here. Run on a worker thread with a join
    timeout so a regression fails the test cleanly instead of hanging the
    whole suite."""
    shared = _new_shared()
    a: "queue.Queue" = queue.Queue()
    shared._outboxes = [a]

    def _run() -> None:
        with shared._lock:
            shared._broadcast_error(pb.LOG_LEVEL_ERROR, "held", lock_held=True)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=2.0)
    assert not t.is_alive(), "broadcast under the held lock deadlocked"
    env = a.get(timeout=1.0)
    assert env.log.message == "held"


def test_reconfigure_failure_broadcasts_to_all_subscribers() -> None:
    """End-to-end guard for the lock-held fan-out: a failed reopen keeps
    the old channel and pushes a LOG_LEVEL_ERROR to every subscriber —
    the one broadcast site that runs under ``self._lock``."""
    driver = _ReopenFailsDriver()
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    b: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    reg.subscribe("fake:0", b)
    _drain(a, kind="interface_state")
    _drain(b, kind="interface_state")

    reg.reconfigure("fake:0", drv.OpenConfig(bitrate_bps=250_000))

    for q in (a, b):
        [env] = _drain(q, kind="log")
        assert env.log.level == pb.LOG_LEVEL_ERROR
        assert "reconfigure" in env.log.message
    # Old channel kept open on a failed reopen.
    assert driver.first is not None and not driver.first.closed.is_set()


# ---- close-race logging ---------------------------------------------------


class _CloseRacingChannel(_FakeChannel):
    """Fails an in-flight ``recv`` once the channel is closed.

    PCAN-Basic does exactly this: closing the channel while the reader
    thread sits inside ``CAN_ReadFD`` fails that read with
    ``PCAN_ERROR_INITIALIZE`` rather than returning empty-handed.

    ``in_recv`` lets the test close only once the reader is provably
    inside a read, which is the whole point of the race.
    """

    def __init__(self, channel_id: str = "fake:0") -> None:
        super().__init__(channel_id=channel_id)
        self.in_recv = threading.Event()

    def recv(self, timeout_s: float) -> Optional[drv.Frame]:
        self.in_recv.set()
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self.closed.is_set():
                raise OSError(
                    "A PCAN Channel has not been initialized yet or the "
                    "initialization process has failed"
                )
            frame = super().recv(0.01)
            if frame is not None:
                return frame
        return None


class _AlwaysFailingRecvChannel(_FakeChannel):
    """A channel whose reads fail for a reason that is *not* the close —
    a genuine driver fault the operator has to hear about."""

    def recv(self, timeout_s: float) -> Optional[drv.Frame]:
        time.sleep(0.01)
        raise OSError("bus off, or the cable fell out")


class _ChannelDriver(_FakeDriver):
    """``_FakeDriver`` that hands out a caller-chosen channel class."""

    def __init__(self, channel_cls, channel_id: str = "fake:0") -> None:
        super().__init__(channel_id=channel_id)
        self._channel_cls = channel_cls

    def open(self, channel_id: str, config: drv.OpenConfig):
        if channel_id != self._channel_id:
            raise KeyError(channel_id)
        ch = self._channel_cls(channel_id=channel_id)
        self.opened.append(ch)
        self.configs.append(config)
        return ch


def test_nominal_close_does_not_warn_about_the_read_it_interrupted(
    caplog: "pytest.LogCaptureFixture",
) -> None:
    """The last unsubscribe closes the channel out from under a reader
    that is already inside ``recv``. That read failing is the close doing
    its job, not a fault — so it must not reach the operator's log at
    WARNING."""
    caplog.set_level(logging.DEBUG, logger="cannet_python_can")
    driver = _ChannelDriver(_CloseRacingChannel)
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    _drain(a, kind="interface_state")
    _wait_for(lambda: driver.opened[0].in_recv.is_set())

    reg.unsubscribe("fake:0", a)
    _wait_for(lambda: driver.opened[0].closed.is_set())
    # Long enough for the interrupted read to fail and be logged.
    time.sleep(0.2)

    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert warnings == [], f"nominal close warned: {[r.getMessage() for r in warnings]}"


def test_reconfigure_swap_does_not_warn_about_the_read_it_interrupted(
    caplog: "pytest.LogCaptureFixture",
) -> None:
    """A ``ConfigureBus`` on an open interface closes the old channel out
    from under a reader already inside ``recv()`` -- the same race as a
    nominal close, but ``reconfigure`` never sets ``_stop`` (it's a swap,
    not a shutdown). That read failing is still the close doing its job,
    not a fault, so it must not reach the operator's log at WARNING."""
    caplog.set_level(logging.DEBUG, logger="cannet_python_can")
    driver = _ChannelDriver(_CloseRacingChannel)
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    _drain(a, kind="interface_state")
    _wait_for(lambda: driver.opened[0].in_recv.is_set())

    reg.reconfigure("fake:0", drv.OpenConfig(bitrate_bps=250_000))

    _wait_for(lambda: driver.opened[0].closed.is_set())
    # Long enough for the interrupted read to fail and be logged.
    time.sleep(0.2)

    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert warnings == [], (
        f"reconfigure swap warned: {[r.getMessage() for r in warnings]}"
    )


def test_a_read_failure_outside_a_close_still_warns(
    caplog: "pytest.LogCaptureFixture",
) -> None:
    """The counterpart guard: silencing the close race must not silence a
    real driver fault on an interface nobody asked to close."""
    caplog.set_level(logging.DEBUG, logger="cannet_python_can")
    driver = _ChannelDriver(_AlwaysFailingRecvChannel)
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    try:
        _wait_for(
            lambda: any(
                r.levelno >= logging.WARNING
                and "rx for fake:0 failed" in r.getMessage()
                for r in caplog.records
            )
        )
    finally:
        reg.unsubscribe("fake:0", a)


# ---- an interface whose device goes away mid-stream ------------------------


class _DyingChannel(_FakeChannel):
    """A virtual channel torn down mid-stream — the closest analogue of a
    USB adapter being unplugged that exists without one. Reads and
    controller-state polls both start raising once ``dead`` is set, the
    way python-can raises when its handle no longer names hardware."""

    def __init__(self, channel_id: str = "fake:0") -> None:
        super().__init__(channel_id=channel_id)
        self.dead = threading.Event()
        self.recv_calls = 0

    def recv(self, timeout_s: float) -> Optional[drv.Frame]:
        self.recv_calls += 1
        if self.dead.is_set():
            time.sleep(0.01)
            raise OSError("PCAN_ERROR_ILLHW: hardware handle is invalid")
        return super().recv(timeout_s)

    def state(self) -> drv.ControllerState:
        if self.dead.is_set():
            raise OSError("PCAN_ERROR_ILLHW: hardware handle is invalid")
        return super().state()


def test_an_interface_whose_device_disappears_is_reported_unavailable() -> None:
    """The defect this covers: an adapter unplugged mid-session produced
    no envelope of any kind. Reads failed at 10 Hz into stderr, the state
    poll's own failure was swallowed at debug level, and every subscriber
    went on believing the controller was error-active."""
    driver = _ChannelDriver(_DyingChannel)
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    try:
        [snapshot] = _drain(a, kind="interface_state")
        assert snapshot.interface_state.state == pb.CONTROLLER_STATE_ACTIVE

        driver.opened[0].dead.set()

        [gone] = _drain(a, kind="interface_state", timeout_s=3.0)
        assert gone.interface_state.state == pb.CONTROLLER_STATE_UNAVAILABLE
        assert gone.interface_state.interface_id == "fake:0"
    finally:
        reg.unsubscribe("fake:0", a)


def test_an_interface_that_comes_back_is_reported_active_again() -> None:
    """The control: unavailable has to be a transition, not a terminal
    state. Nothing else re-arms it, so a channel that stayed unavailable
    after the adapter returned would keep its bus parked all session."""
    driver = _ChannelDriver(_DyingChannel)
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    try:
        _drain(a, kind="interface_state")
        driver.opened[0].dead.set()
        [gone] = _drain(a, kind="interface_state", timeout_s=3.0)
        assert gone.interface_state.state == pb.CONTROLLER_STATE_UNAVAILABLE

        driver.opened[0].dead.clear()
        [back] = _drain(a, kind="interface_state", timeout_s=3.0)
        assert back.interface_state.state == pb.CONTROLLER_STATE_ACTIVE
    finally:
        reg.unsubscribe("fake:0", a)


def test_a_persistent_read_failure_is_logged_once_not_at_the_retry_rate(
    caplog: "pytest.LogCaptureFixture",
) -> None:
    """The rx pump retries a failed read every 100 ms forever. Logging
    each attempt put ten lines a second into the operator's System
    Messages panel for as long as the adapter stayed out, which spends
    the panel's rate-limit budget on one repeated sentence. One line per
    episode; the recovery re-arms it."""
    caplog.set_level(logging.DEBUG, logger="cannet_python_can")
    driver = _ChannelDriver(_DyingChannel)
    reg = srv._InterfaceRegistry(driver)
    a: "queue.Queue" = queue.Queue()
    reg.subscribe("fake:0", a)
    try:
        _drain(a, kind="interface_state")
        channel = driver.opened[0]
        channel.dead.set()
        _wait_for(lambda: channel.recv_calls > 12, timeout_s=3.0)
        failures = [
            r
            for r in caplog.records
            if r.levelno >= logging.WARNING and "rx for fake:0 failed" in r.getMessage()
        ]
        assert len(failures) == 1, (
            f"{len(failures)} warnings for one episode: "
            f"{[r.getMessage() for r in failures]}"
        )

        channel.dead.clear()
        _wait_for(lambda: not channel.dead.is_set())
        time.sleep(0.3)
        channel.dead.set()
        _wait_for(
            lambda: (
                len(
                    [
                        r
                        for r in caplog.records
                        if r.levelno >= logging.WARNING
                        and "rx for fake:0 failed" in r.getMessage()
                    ]
                )
                == 2
            ),
            timeout_s=3.0,
        )
    finally:
        reg.unsubscribe("fake:0", a)
