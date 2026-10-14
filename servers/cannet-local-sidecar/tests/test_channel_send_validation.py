"""Pre-send validation in :class:`PythonCanChannel`.

The wrapper rejects frame shapes that would otherwise reach python-can
and raise a bare ``ValueError("Can only assign sequence of same size")``
from inside a ctypes slice assignment — most often an FD frame on a
classic-mode bus, an oversize payload, or a ``dlc`` that disagrees with
``len(data)``. The user sees a precise ``TxRejected`` instead.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, cast


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


import pytest  # noqa: E402

from cannet_local_sidecar.driver import Frame, FrameKind, TxRejected  # noqa: E402
from cannet_local_sidecar.driver_python_can import PythonCanChannel  # noqa: E402


class _RecordingBus:
    def __init__(self) -> None:
        self.sent: list = []

    def send(self, msg) -> None:
        self.sent.append(msg)


def _frame(
    *, data: bytes = b"", kind: FrameKind = FrameKind.CLASSIC, **overrides
) -> Frame:
    base: dict[str, Any] = {
        "timestamp_ns": 0,
        "can_id": 0x100,
        "extended": False,
        "is_rx": False,
        "data": data,
        "kind": kind,
        "brs": False,
        "esi": False,
        "dlc": 0,
    }
    base.update(overrides)
    return Frame(**base)


def _channel(*, fd: bool, listen_only: bool = False) -> PythonCanChannel:
    return PythonCanChannel(
        channel_id="test:0",
        bus=_RecordingBus(),
        listen_only=listen_only,
        fd=fd,
    )


def test_fd_frame_on_classic_bus_rejected() -> None:
    ch = _channel(fd=False)
    with pytest.raises(TxRejected, match="FD frame on classic-mode bus"):
        ch.send(_frame(kind=FrameKind.FD, data=bytes(12)))


def test_classic_oversize_payload_rejected() -> None:
    ch = _channel(fd=False)
    with pytest.raises(TxRejected, match="exceeds 8-byte limit"):
        ch.send(_frame(data=bytes(9)))


def test_fd_oversize_payload_rejected() -> None:
    ch = _channel(fd=True)
    with pytest.raises(TxRejected, match="exceeds 64-byte limit"):
        ch.send(_frame(kind=FrameKind.FD, data=bytes(65)))


def test_dlc_disagreeing_with_data_length_rejected() -> None:
    ch = _channel(fd=False)
    with pytest.raises(TxRejected, match="dlc=8 differs from data length 3"):
        ch.send(_frame(data=b"\x01\x02\x03", dlc=8))


def test_rtr_on_fd_bus_rejected() -> None:
    ch = _channel(fd=True)
    with pytest.raises(TxRejected, match="remote .* not supported on FD-mode"):
        ch.send(_frame(kind=FrameKind.REMOTE, dlc=4))


def test_classic_rtr_with_nonzero_dlc_passes_through() -> None:
    """python-can's classic-mode send skips the data copy for RTR
    frames, so the dlc/data-mismatch check must not fire on them."""
    ch = _channel(fd=False)
    ch.send(_frame(kind=FrameKind.REMOTE, dlc=8))  # no exception
    bus = cast(_RecordingBus, ch._bus)  # type: ignore[attr-defined]
    assert len(bus.sent) == 1


def test_classic_well_formed_frame_passes() -> None:
    ch = _channel(fd=False)
    ch.send(_frame(data=b"\x01\x02\x03"))
    bus = cast(_RecordingBus, ch._bus)  # type: ignore[attr-defined]
    assert len(bus.sent) == 1


def test_fd_well_formed_frame_passes() -> None:
    ch = _channel(fd=True)
    ch.send(_frame(kind=FrameKind.FD, data=bytes(12)))
    bus = cast(_RecordingBus, ch._bus)  # type: ignore[attr-defined]
    assert len(bus.sent) == 1


def test_listen_only_still_rejects_first() -> None:
    ch = _channel(fd=False, listen_only=True)
    with pytest.raises(TxRejected, match="listen-only"):
        ch.send(_frame(data=b"\x01"))


class _RefusingBus:
    """A bus whose send fails the way python-can's backend raised it."""

    def __init__(self, error: Exception) -> None:
        self._error = error

    def send(self, msg) -> None:
        raise self._error


def _refused_by(error: Exception) -> TxRejected:
    ch = PythonCanChannel(
        channel_id="test:0", bus=_RefusingBus(error), listen_only=False, fd=False
    )
    with pytest.raises(TxRejected) as info:
        ch.send(_frame(data=b"\x01"))
    return info.value


def test_a_driver_reported_full_transmit_queue_is_marked_queue_full() -> None:
    # The text python-can's PcanBus raises for PCAN_ERROR_QXMTFULL:
    # "Failed to send: " + PCAN-Basic's own error text.
    refused = _refused_by(RuntimeError("Failed to send: The transmit queue is full"))
    assert refused.queue_full is True
    assert "transmit queue is full" in str(refused)


def test_any_other_send_failure_is_not_queue_full() -> None:
    refused = _refused_by(
        RuntimeError("Failed to send: The CAN controller is in bus-off state")
    )
    assert refused.queue_full is False


def test_the_wrappers_own_refusals_are_not_queue_full() -> None:
    ch = _channel(fd=False, listen_only=True)
    with pytest.raises(TxRejected) as info:
        ch.send(_frame(data=b"\x01"))
    assert info.value.queue_full is False
