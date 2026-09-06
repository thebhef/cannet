"""`CannetBus` against `cannet-server debug replay`.

A recorded capture is the receive-only half of the contract: real
frames, real timestamps, more than one interface, and nothing for the
client to transmit.
"""

from __future__ import annotations

import can
import pytest


def test_a_replayed_capture_delivers_frames(replay_server: str) -> None:
    with can.Bus(interface="cannet", channel="blf:0", server=replay_server) as bus:
        assert bus.allocated_id is None  # not a factory id
        frames = [bus.recv(timeout=10.0) for _ in range(20)]
    assert all(f is not None for f in frames)
    assert all(f.timestamp > 0 for f in frames)
    # A capture with only one id in twenty frames would mean the
    # subscription is echoing something rather than replaying.
    assert len({f.arbitration_id for f in frames}) > 1


def test_frames_carry_the_capture_direction(replay_server: str) -> None:
    with can.Bus(interface="cannet", channel="blf:0", server=replay_server) as bus:
        frame = bus.recv(timeout=10.0)
    assert frame is not None
    assert isinstance(frame.is_rx, bool)


def test_an_unknown_interface_surfaces_on_the_first_read(replay_server: str) -> None:
    # Session-fatal, and an ordinary subscribe has no acknowledgement
    # for the constructor to wait on — the same split `cannet-client`
    # draws.
    with (
        can.Bus(interface="cannet", channel="blf:99", server=replay_server) as bus,
        pytest.raises(can.CanOperationError),
    ):
        bus.recv(timeout=5.0)
