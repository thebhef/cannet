"""`CannetBus` against `cannet-server debug vbus`.

The virtual bus is the one hardware-free server that carries traffic
both ways, so this is where the `BusABC` promises are checked: recv,
iteration, `Notifier`, send, shutdown, and what a per-frame rejection
does to a session that must survive it.
"""

from __future__ import annotations

import can
import pytest

from cannet_python_client import CannetBus

FACTORY = "virtual:bus0"


def open_bus(address: str, **kwargs) -> CannetBus:
    return can.Bus(  # type: ignore[no-any-return]
        interface="cannet", channel=FACTORY, server=address, **kwargs
    )


@pytest.fixture
def bus(vbus_server: str):
    with open_bus(vbus_server) as bus:
        yield bus


@pytest.fixture
def peer(vbus_server: str):
    with open_bus(vbus_server) as bus:
        yield bus


def test_can_bus_opens_one_with_no_cannet_specific_import(vbus_server: str) -> None:
    # The entry point is the whole point: an application names the
    # interface and never imports this package.
    with can.Bus(interface="cannet", channel=FACTORY, server=vbus_server) as bus:
        assert type(bus).__name__ == "CannetBus"
        assert FACTORY in bus.channel_info
        assert vbus_server in bus.channel_info


def test_a_factory_id_waits_for_the_participant_the_server_allocates(bus) -> None:
    # ADR 0021: the subscribe against the factory is answered with an
    # InterfaceAllocated naming the participant, and that id — not the
    # factory id — is what transmits are addressed to.
    assert bus.allocated_id is not None
    assert bus.allocated_id.startswith(f"{FACTORY}/")
    assert bus.allocated_id in bus.channel_info


def test_a_frame_sent_on_one_bus_arrives_on_another(bus, peer) -> None:
    sent = can.Message(
        arbitration_id=0x123, is_extended_id=False, data=b"\x01\x02\x03\x04"
    )
    bus.send(sent)

    got = peer.recv(timeout=5.0)
    assert got is not None
    assert got.arbitration_id == 0x123
    assert not got.is_extended_id
    assert bytes(got.data) == b"\x01\x02\x03\x04"
    assert got.dlc == 4
    assert got.timestamp > 0


def test_an_extended_frame_keeps_its_id_width(bus, peer) -> None:
    # 11-bit and 29-bit ids overlap numerically, so losing the flag
    # silently renames the frame.
    bus.send(can.Message(arbitration_id=0x1ABCDEF, is_extended_id=True, data=b"\xff"))
    got = peer.recv(timeout=5.0)
    assert got is not None
    assert got.is_extended_id
    assert got.arbitration_id == 0x1ABCDEF


def test_iteration_yields_what_recv_would(bus, peer) -> None:
    bus.send(can.Message(arbitration_id=0x201, data=b"\xaa"))
    got = next(iter(peer))
    assert got.arbitration_id == 0x201


def test_a_notifier_delivers_to_a_listener(bus, peer) -> None:
    reader = can.BufferedReader()
    notifier = can.Notifier(peer, [reader], timeout=1.0)
    try:
        bus.send(can.Message(arbitration_id=0x301, data=b"\xbb"))
        got = reader.get_message(timeout=5.0)
    finally:
        notifier.stop()
    assert got is not None
    assert got.arbitration_id == 0x301


def test_recv_returns_none_when_nothing_arrives_inside_the_timeout(bus) -> None:
    # BusABC's contract, and the thing a poll loop depends on: a quiet
    # bus is None, not a raise and not a block.
    assert bus.recv(timeout=0.2) is None


def test_a_transmit_nobody_hears_is_tallied_and_leaves_the_session_running(
    vbus_server: str,
) -> None:
    # The virtual bus answers a transmit that reached no participant
    # with CODE_NO_ACKNOWLEDGER. That is one frame's problem, not the
    # session's — a lone rest-of-bus simulation must keep running.
    with open_bus(vbus_server) as lonely:
        lonely.send(can.Message(arbitration_id=0x400, data=b"\x00"))
        deadline_reached = True
        for _ in range(50):
            if lonely.rejections.total:
                deadline_reached = False
                break
            lonely.recv(timeout=0.1)
        assert not deadline_reached, "the peer never reported the rejection"

        tally = lonely.rejections.snapshot()[0]
        assert tally.count >= 1
        # Still alive: a quiet bus, not a raise.
        assert lonely.recv(timeout=0.2) is None


def test_subscribing_to_an_interface_the_server_does_not_have_raises(
    vbus_server: str,
) -> None:
    # CODE_UNKNOWN_INTERFACE is session-fatal. An ordinary subscribe is
    # not acknowledged by the wire, so — as in `cannet-client` — the
    # session comes up at the speed of the subscribe and the error
    # surfaces on the next read rather than stalling the constructor
    # on a reply that may never come.
    with (
        can.Bus(interface="cannet", channel="ghost:0", server=vbus_server) as bus,
        pytest.raises(can.CanOperationError),
    ):
        bus.recv(timeout=5.0)


def test_a_factory_subscribe_that_the_server_refuses_fails_at_construction(
    vbus_server: str,
) -> None:
    # A factory id *is* acknowledged — the constructor is already
    # waiting for the allocation, so an error arriving instead of one
    # has somewhere to go.
    with pytest.raises(can.CanInitializationError):
        can.Bus(interface="cannet", channel="virtual:ghost", server=vbus_server)


def test_a_server_nothing_is_stored_for_is_refused_at_construction() -> None:
    with pytest.raises(can.CanInitializationError):
        can.Bus(interface="cannet", channel=FACTORY, server="stranger.invalid:50051")


def test_shutdown_stops_the_session_and_is_idempotent(vbus_server: str) -> None:
    bus = open_bus(vbus_server)
    bus.shutdown()
    bus.shutdown()
    with pytest.raises(can.CanOperationError):
        bus.send(can.Message(arbitration_id=1, data=b""))


def test_state_reads_active_while_the_peer_reports_no_fault(bus) -> None:
    # The virtual bus has no controller and sends no InterfaceState.
    # python-can's BusState has no "unknown", so an unreported bus
    # reads as active; `controller_state` is where the difference
    # between "reported healthy" and "said nothing" survives.
    assert bus.state is can.BusState.ACTIVE
    assert bus.controller_state is None
