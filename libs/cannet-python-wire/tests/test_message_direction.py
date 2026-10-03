"""Direction across the python-can ``Message`` → wire ``Frame`` seam.

python-can marks a frame the adapter itself transmitted — the echo a
bus opened with ``receive_own_messages=True`` hands back through the
ordinary receive path — with ``Message.is_rx == False``. ``Message``
has no ``is_tx``; reading one mapped every echo to a received frame.
"""

from __future__ import annotations

import sys
from pathlib import Path


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


import can  # noqa: E402

from cannet_python_wire import frame_to_proto, message_to_frame  # noqa: E402
from cannet_python_wire._proto import cannet_pb2 as pb  # noqa: E402


def test_an_echoed_message_is_a_transmitted_frame() -> None:
    msg = can.Message(arbitration_id=0x123, data=b"\x01", is_rx=False)
    frame = message_to_frame(msg)
    assert frame.is_rx is False
    assert frame_to_proto(frame).direction == pb.DIRECTION_TX


def test_a_received_message_is_a_received_frame() -> None:
    msg = can.Message(arbitration_id=0x123, data=b"\x01")
    assert msg.is_rx, "python-can's default is a received frame"
    frame = message_to_frame(msg)
    assert frame.is_rx is True
    assert frame_to_proto(frame).direction == pb.DIRECTION_RX
