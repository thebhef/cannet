"""Per-command debug logging — what makes the ``--log-file`` useful.

The motivating incident: on one 4-channel Vector card three channels
opened and one refused, and the logs could not say why. These tests pin
the trail that answers it — the command, its arguments, the outcome,
and the driver traceback — and pin the deliberate boundary on the
streaming paths: frame transmits log lifecycle and faults, never
per-frame content.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


from cannet_python_can import driver as drv  # noqa: E402
from cannet_python_can import server as srv  # noqa: E402
from cannet_python_can._proto import cannet_pb2 as pb  # noqa: E402


class _Ctx:
    def is_active(self) -> bool:  # pragma: no cover - unused by these tests
        return True


class _Channel:
    """Minimal open channel: receives nothing, accepts every send."""

    def __init__(self) -> None:
        self.sent: list[drv.Frame] = []

    def recv(self, timeout_s: float):
        return None

    def send(self, frame: drv.Frame) -> None:
        self.sent.append(frame)

    def state(self) -> drv.ControllerState:
        return drv.ControllerState(state=drv.STATE_ACTIVE, tec=0, rec=0)

    def close(self) -> None:
        pass


class _Driver:
    """Two channels; ``ch1`` opens, ``ch2`` refuses — the VN17xx shape."""

    def __init__(self) -> None:
        self.opened: list[tuple[str, drv.OpenConfig]] = []
        self.channel = _Channel()

    def list_channels(self):
        return [
            drv.Channel(id="vector:VN1670(SN:1, ch:1)", display_name="ch1"),
            drv.Channel(id="vector:VN1670(SN:1, ch:2)", display_name="ch2"),
        ]

    def open(self, channel_id: str, config: drv.OpenConfig):
        self.opened.append((channel_id, config))
        if channel_id.endswith("ch:2)"):
            try:
                raise ValueError("XL_ERR_HW_NOT_PRESENT")
            except ValueError as e:
                raise OSError(f"open {channel_id}: {e}") from e
        return self.channel


def _run_session(driver, envelopes: list[pb.Envelope]) -> list[pb.Envelope]:
    svc = srv.CannetServerService(driver)  # type: ignore[arg-type]
    return list(svc.Session(iter(envelopes), _Ctx()))


@pytest.fixture
def debug_log(caplog: pytest.LogCaptureFixture) -> pytest.LogCaptureFixture:
    caplog.set_level(logging.DEBUG, logger="cannet_python_can")
    return caplog


def test_list_interfaces_logs_the_enumerated_ids(
    debug_log: pytest.LogCaptureFixture,
) -> None:
    driver = _Driver()
    svc = srv.CannetServerService(driver)  # type: ignore[arg-type]
    svc.ListInterfaces(pb.ListInterfacesRequest(), _Ctx())
    assert "vector:VN1670(SN:1, ch:1)" in debug_log.text
    assert "vector:VN1670(SN:1, ch:2)" in debug_log.text


def test_subscribe_logs_the_interface_id_and_the_outcome(
    debug_log: pytest.LogCaptureFixture,
) -> None:
    driver = _Driver()
    _run_session(
        driver,
        [pb.Envelope(subscribe=pb.Subscribe(interface_id="vector:VN1670(SN:1, ch:1)"))],
    )
    assert "Subscribe" in debug_log.text
    assert "vector:VN1670(SN:1, ch:1)" in debug_log.text
    assert "ok" in debug_log.text


def test_a_refused_channel_leaves_a_traceback_in_the_log(
    debug_log: pytest.LogCaptureFixture,
) -> None:
    """The VN17xx ch2 case: the file must say *why* the open failed."""
    driver = _Driver()
    _run_session(
        driver,
        [pb.Envelope(subscribe=pb.Subscribe(interface_id="vector:VN1670(SN:1, ch:2)"))],
    )
    assert "vector:VN1670(SN:1, ch:2)" in debug_log.text
    assert "Traceback (most recent call last)" in debug_log.text, (
        "an open failure must carry the driver's traceback"
    )
    assert "XL_ERR_HW_NOT_PRESENT" in debug_log.text, (
        "the vendor's own error text must survive the OSError wrapping"
    )


def test_an_unknown_interface_subscribe_is_logged(
    debug_log: pytest.LogCaptureFixture,
) -> None:
    class Empty:
        def list_channels(self):
            return []

        def open(self, channel_id, config):
            raise KeyError(channel_id)

    _run_session(Empty(), [pb.Envelope(subscribe=pb.Subscribe(interface_id="ghost"))])
    assert "ghost" in debug_log.text
    assert "unknown interface" in debug_log.text


def test_configure_logs_requested_and_applied_parameters(
    debug_log: pytest.LogCaptureFixture,
) -> None:
    driver = _Driver()
    cid = "vector:VN1670(SN:1, ch:1)"
    _run_session(
        driver,
        [
            pb.Envelope(subscribe=pb.Subscribe(interface_id=cid)),
            pb.Envelope(
                configure_bus=pb.ConfigureBus(
                    interface_id=cid,
                    speed_bps=500_000,
                    fd_enabled=True,
                    fd_data_speed_bps=2_000_000,
                )
            ),
        ],
    )
    text = debug_log.text
    assert "ConfigureBus" in text
    # Requested, as it came off the wire …
    assert "speed_bps=500000" in text
    assert "fd_data_speed_bps=2000000" in text
    # … and what the driver was actually handed.
    assert "bitrate_bps=500000" in text
    assert "data_bitrate_bps=2000000" in text
    assert "fd=True" in text


def test_open_and_close_of_a_channel_are_logged(
    debug_log: pytest.LogCaptureFixture,
) -> None:
    driver = _Driver()
    cid = "vector:VN1670(SN:1, ch:1)"
    _run_session(
        driver,
        [
            pb.Envelope(subscribe=pb.Subscribe(interface_id=cid)),
            pb.Envelope(unsubscribe=pb.Unsubscribe(interface_id=cid)),
        ],
    )
    text = debug_log.text.lower()
    assert "opening" in text
    assert "closing" in text or "closed" in text
    assert "unsubscribe" in text


def test_transmits_are_not_logged_per_frame(
    debug_log: pytest.LogCaptureFixture,
) -> None:
    """The streaming boundary. A logged frame is a 5 MB budget spent in
    seconds and a logging call on the hot path; lifecycle and faults are
    logged, frame content never is."""
    driver = _Driver()
    cid = "vector:VN1670(SN:1, ch:1)"
    frames = [
        pb.Frame(can_id=0x1A0 + i, kind=pb.FRAME_KIND_CLASSIC, data=b"\x01\x02")
        for i in range(64)
    ]
    _run_session(
        driver,
        [
            pb.Envelope(subscribe=pb.Subscribe(interface_id=cid)),
            pb.Envelope(frame_batch=pb.FrameBatch(interface_id=cid, frames=frames)),
        ],
    )
    text = debug_log.text
    for i in range(64):
        assert f"{0x1A0 + i:x}" not in text.lower(), "no per-frame content in the log"
