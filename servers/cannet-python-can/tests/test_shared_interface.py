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


from cannet_python_can import driver as drv  # noqa: E402
from cannet_python_can import server as srv  # noqa: E402
from cannet_python_can._proto import cannet_pb2 as pb  # noqa: E402


def _frame(i: int) -> drv.Frame:
    return drv.Frame(
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
        raise AssertionError(
            f"only got {len(out)}/{count} envelopes of kind {kind!r}"
        )
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

    reg.transmit("fake:0", _frame(1))
    reg.transmit("fake:0", _frame(2))

    sent = driver.opened[0].sent
    assert [f.can_id for f in sent] == [0x101, 0x102]


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
