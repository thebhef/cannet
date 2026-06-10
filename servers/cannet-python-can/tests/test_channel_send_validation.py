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


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


import pytest  # noqa: E402

from cannet_python_can.driver import Frame, TxRejected  # noqa: E402
from cannet_python_can.driver_python_can import PythonCanChannel  # noqa: E402


class _RecordingBus:
    def __init__(self) -> None:
        self.sent: list = []

    def send(self, msg) -> None:
        self.sent.append(msg)


def _frame(*, data: bytes = b"", **overrides) -> Frame:
    base = {
        "timestamp_ns": 0,
        "can_id": 0x100,
        "extended": False,
        "is_rx": False,
        "data": data,
        "fd": False,
        "brs": False,
        "esi": False,
        "is_remote": False,
        "is_error": False,
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
        ch.send(_frame(fd=True, data=bytes(12)))


def test_classic_oversize_payload_rejected() -> None:
    ch = _channel(fd=False)
    with pytest.raises(TxRejected, match="exceeds 8-byte limit"):
        ch.send(_frame(data=bytes(9)))


def test_fd_oversize_payload_rejected() -> None:
    ch = _channel(fd=True)
    with pytest.raises(TxRejected, match="exceeds 64-byte limit"):
        ch.send(_frame(fd=True, data=bytes(65)))


def test_dlc_disagreeing_with_data_length_rejected() -> None:
    ch = _channel(fd=False)
    with pytest.raises(TxRejected, match="dlc=8 differs from data length 3"):
        ch.send(_frame(data=b"\x01\x02\x03", dlc=8))


def test_rtr_on_fd_bus_rejected() -> None:
    ch = _channel(fd=True)
    with pytest.raises(TxRejected, match="remote .* not supported on FD-mode"):
        ch.send(_frame(is_remote=True, dlc=4))


def test_classic_rtr_with_nonzero_dlc_passes_through() -> None:
    """python-can's classic-mode send skips the data copy for RTR
    frames, so the dlc/data-mismatch check must not fire on them."""
    ch = _channel(fd=False)
    ch.send(_frame(is_remote=True, dlc=8))  # no exception
    bus = ch._bus  # type: ignore[attr-defined]
    assert len(bus.sent) == 1


def test_classic_well_formed_frame_passes() -> None:
    ch = _channel(fd=False)
    ch.send(_frame(data=b"\x01\x02\x03"))
    bus = ch._bus  # type: ignore[attr-defined]
    assert len(bus.sent) == 1


def test_fd_well_formed_frame_passes() -> None:
    ch = _channel(fd=True)
    ch.send(_frame(fd=True, data=bytes(12)))
    bus = ch._bus  # type: ignore[attr-defined]
    assert len(bus.sent) == 1


def test_listen_only_still_rejects_first() -> None:
    ch = _channel(fd=False, listen_only=True)
    with pytest.raises(TxRejected, match="listen-only"):
        ch.send(_frame(data=b"\x01"))
