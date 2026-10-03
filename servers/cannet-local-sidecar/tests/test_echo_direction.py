"""The driver's transmit echo comes off the channel as a transmitted
frame.

A python-can bus opened with ``receive_own_messages=True`` hands back
each frame the adapter put on the wire through the ordinary ``recv``,
marked ``Message.is_rx == False``. That echo is the record of a
transmit; the channel must not turn it into a received frame.
Hardware-free: a stub bus returns real ``can.Message`` objects.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional


def _ensure_on_path() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


_ensure_on_path()

import can  # noqa: E402

from cannet_local_sidecar.driver_python_can import PythonCanChannel  # noqa: E402


class _Bus:
    def __init__(self, messages: list[can.Message]) -> None:
        self._messages = list(messages)
        self.state = "ACTIVE"

    def recv(self, timeout: float) -> Optional[can.Message]:
        return self._messages.pop(0) if self._messages else None

    def shutdown(self) -> None:
        pass


def _recv_one(msg: can.Message):
    ch = PythonCanChannel(
        channel_id="pcan:PCAN_USBBUS1(h:0x51, ch:0)",
        bus=_Bus([msg]),
        listen_only=False,
        fd=False,
    )
    frame = ch.recv(timeout_s=0.0)
    assert frame is not None
    return frame


def test_an_echo_is_a_transmitted_frame() -> None:
    frame = _recv_one(can.Message(arbitration_id=0x123, data=b"\x01", is_rx=False))
    assert frame.is_rx is False


def test_a_received_message_is_a_received_frame() -> None:
    frame = _recv_one(can.Message(arbitration_id=0x123, data=b"\x01"))
    assert frame.is_rx is True
