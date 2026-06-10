"""Tests for the python-can ``Message`` → driver ``Frame`` timestamp
contract.

The trace view captures the first frame's timestamp as the zero point
for its relative-time column and assumes all subsequent frames are on
the same monotonic clock. The model layer must hold that contract — if
``msg.timestamp`` is missing for some frame and the conversion silently
falls back to a *different* clock (e.g., ``time.monotonic_ns()`` while
hardware-stamped frames use Unix-epoch ns from python-can's PCAN
backend), later renders show wildly-negative deltas the moment a
fallback frame slips in.

These tests lock in: hardware-provided timestamps pass through
unchanged, and the missing-timestamp fallback stays on the Unix-epoch
nanosecond scale (matching what python-can produces for hardware
stamps).
"""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


from cannet_python_can.driver_python_can import _msg_to_frame  # noqa: E402


@dataclass
class _FakeMsg:
    """Just enough of python-can's ``Message`` shape for ``_msg_to_frame``."""

    timestamp: float = 0.0
    arbitration_id: int = 0x100
    is_extended_id: bool = False
    is_tx: bool = False
    data: bytes = b""
    is_fd: bool = False
    bitrate_switch: bool = False
    error_state_indicator: bool = False
    is_remote_frame: bool = False
    is_error_frame: bool = False
    dlc: Optional[int] = None

    def __post_init__(self) -> None:
        if self.dlc is None:
            self.dlc = len(self.data)


def test_hardware_timestamp_passes_through_unchanged() -> None:
    """A normal hardware-stamped Message (python-can sets
    ``msg.timestamp`` from PCAN's microsecond hardware counter, plus
    Unix-epoch boot offset) must convert to the same ns value."""
    # Late-2025-ish Unix-epoch seconds; precision well within f64.
    msg = _FakeMsg(timestamp=1780261000.123456, data=b"\x01\x02\x03")
    frame = _msg_to_frame(msg)
    assert frame.timestamp_ns == int(1780261000.123456 * 1_000_000_000)


def test_missing_timestamp_falls_back_to_unix_epoch_ns_not_monotonic() -> None:
    """If a Message arrives with no timestamp (the python-can default
    ``timestamp=0.0`` for backends that don't fill it in, or status
    frames that omit it), the fallback must stay on the same Unix-epoch
    scale as hardware-stamped frames. A ``time.monotonic_ns()`` fallback
    would produce a value ~3 orders of magnitude smaller — when mixed
    into a session of hardware-stamped frames, the view's "first frame
    is the zero point" assumption breaks and timestamps go wildly
    negative.

    We bracket the call with two ``time.time_ns()`` reads; the result
    must land in that window, which a monotonic-relative fallback never
    would.
    """
    before = time.time_ns()
    frame = _msg_to_frame(_FakeMsg(timestamp=0.0))
    after = time.time_ns()
    assert before <= frame.timestamp_ns <= after, (
        f"fallback timestamp {frame.timestamp_ns} is outside the wall-clock "
        f"window [{before}, {after}] — likely on a different clock than "
        f"hardware-stamped frames (e.g., time.monotonic_ns())."
    )
