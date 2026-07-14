"""Tests for the wire-layer timestamp clock contract.

Everything the sidecar stamps itself must be on the same Unix-epoch
nanosecond clock as hardware-stamped RX frames (python-can's
``msg.timestamp`` scale) and the GUI's own wall-clock stamps. A
``time.monotonic_ns()`` stamp is a third clock ~3 orders of magnitude
smaller; a capture mixing it with wall-clock frames breaks every
consumer that anchors on the first frame's timestamp (the plot's
x-axis lands off-canvas — the same bug the virtual bus had).

Covers the two self-stamped paths in ``server.py``: the TX-frame
fallback in ``_proto_to_frame`` (a transmit request arriving without a
timestamp) and ``_log_envelope``.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


from cannet_python_can import server as srv  # noqa: E402
from cannet_python_can._proto import cannet_pb2 as pb  # noqa: E402


def test_proto_to_frame_timestamp_fallback_is_wall_clock() -> None:
    before = time.time_ns()
    frame = srv._proto_to_frame(pb.Frame(timestamp_ns=0, can_id=0x100))
    after = time.time_ns()
    assert before <= frame.timestamp_ns <= after, (
        f"TX-frame fallback timestamp {frame.timestamp_ns} is outside the "
        f"wall-clock window [{before}, {after}] — likely on a different "
        f"clock (e.g. time.monotonic_ns())."
    )


def test_log_envelope_timestamp_is_wall_clock() -> None:
    before = time.time_ns()
    env = srv._log_envelope(pb.LOG_LEVEL_INFO, "hello")
    after = time.time_ns()
    assert before <= env.log.timestamp_ns <= after, (
        f"log timestamp {env.log.timestamp_ns} is outside the wall-clock "
        f"window [{before}, {after}] — likely on a different clock."
    )
