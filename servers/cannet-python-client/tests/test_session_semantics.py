"""Session semantics, as decided rather than as observed.

The debug servers accept whatever order envelopes arrive in and drop
`ConfigureBus` outright, so an integration test cannot tell a session
that configures first from one that does not. These pin the decisions
themselves — they are the contract a hardware server depends on.
"""

from __future__ import annotations

from cannet_python_can._proto import cannet_pb2 as pb

from cannet_python_client import session


def bodies(envelopes: list[pb.Envelope]) -> list[str]:
    return [e.WhichOneof("body") for e in envelopes]


def test_configure_bus_is_sent_before_the_subscribe_it_configures() -> None:
    # A hardware interface opened by the subscribe must already know
    # its rate: the other order costs a close+reopen, and frames go
    # missing in that window.
    envelopes = session.opening_envelopes(
        "pcan:PCAN_USBBUS1",
        config=session.BusConfig(bitrate=500_000, fd=False, data_bitrate=None),
    )
    assert bodies(envelopes) == ["configure_bus", "subscribe"]
    assert envelopes[0].configure_bus.interface_id == "pcan:PCAN_USBBUS1"
    assert envelopes[0].configure_bus.speed_bps == 500_000
    assert envelopes[1].subscribe.interface_id == "pcan:PCAN_USBBUS1"


def test_no_configuration_means_no_configure_bus_envelope() -> None:
    # A replay or virtual-bus interface has nothing to configure, and
    # sending a zeroed ConfigureBus would ask a hardware server to open
    # at no bitrate at all.
    assert bodies(session.opening_envelopes("blf:0", config=None)) == ["subscribe"]


def test_fd_carries_the_data_phase_rate_and_classic_leaves_it_zero() -> None:
    fd = session.opening_envelopes(
        "vector:app(ch:0)",
        config=session.BusConfig(bitrate=500_000, fd=True, data_bitrate=2_000_000),
    )[0].configure_bus
    assert fd.fd_enabled
    assert fd.fd_data_speed_bps == 2_000_000

    classic = session.opening_envelopes(
        "vector:app(ch:0)",
        config=session.BusConfig(bitrate=500_000, fd=False, data_bitrate=None),
    )[0].configure_bus
    assert not classic.fd_enabled
    assert classic.fd_data_speed_bps == 0


def test_a_bare_virtual_scheme_id_is_a_factory_and_waits_for_an_allocation() -> None:
    # ADR 0021: subscribing to the factory allocates a participant and
    # the server names it in an InterfaceAllocated envelope. The
    # allocated ids and the bridges hang off it with a `/`, and those
    # are ordinary interfaces that allocate nothing.
    assert session.wants_allocation("virtual:bus0")
    assert not session.wants_allocation("virtual:bus0/p1")
    assert not session.wants_allocation("virtual:bus0/bridge-rig")
    assert not session.wants_allocation("blf:0")
    assert not session.wants_allocation("pcan:PCAN_USBBUS1")


def test_a_subscription_takes_only_the_batches_addressed_to_it() -> None:
    # The whole addressing model rests on this: a session sees every
    # interface the server sends it, and must keep the one it named.
    assert session.batch_belongs("blf:0", effective_id="blf:0", factory_id=None)
    assert not session.batch_belongs("blf:1", effective_id="blf:0", factory_id=None)


def test_a_factory_subscription_takes_every_participant_on_its_bus() -> None:
    # A virtual bus tags each fan-out batch with the *sender's*
    # allocated id (ADR 0021), not the receiver's, so matching only the
    # allocated id would deliver nothing at all.
    belongs = {"effective_id": "virtual:bus0/p1", "factory_id": "virtual:bus0"}
    assert session.batch_belongs("virtual:bus0/p1", **belongs)
    assert session.batch_belongs("virtual:bus0/p2", **belongs)
    assert session.batch_belongs("virtual:bus0/bridge-rig", **belongs)
    assert not session.batch_belongs("virtual:bus1/p0", **belongs)
    assert not session.batch_belongs("blf:0", **belongs)


def test_the_three_per_frame_codes_are_the_ones_that_do_not_end_the_session() -> None:
    # The split the Rust client draws, and for the same reason: these
    # three describe one transmit, and an unrecognised code is treated
    # as fatal so a future variant cannot be swallowed in silence.
    assert session.is_per_frame_error(pb.Error.CODE_TX_REJECTED)
    assert session.is_per_frame_error(pb.Error.CODE_NOT_SUBSCRIBED)
    assert session.is_per_frame_error(pb.Error.CODE_NO_ACKNOWLEDGER)

    assert not session.is_per_frame_error(pb.Error.CODE_UNKNOWN_INTERFACE)
    assert not session.is_per_frame_error(pb.Error.CODE_BUSY)
    assert not session.is_per_frame_error(pb.Error.CODE_UNSPECIFIED)
    assert not session.is_per_frame_error(999)


def test_a_rejection_flood_is_a_tally_and_not_a_log() -> None:
    # A peer refusing transmits at bus rate produces thousands a
    # second; what is kept has to be bounded by the code space rather
    # than by how long the peer keeps refusing.
    errors = session.PerFrameErrors()
    for i in range(10_000):
        errors.record(pb.Error.CODE_TX_REJECTED, f"refused {i}")
    errors.record(pb.Error.CODE_NO_ACKNOWLEDGER, "nobody listening")

    assert errors.total == 10_001
    assert len(errors.snapshot()) == 2
    tx = next(t for t in errors.snapshot() if t.code == pb.Error.CODE_TX_REJECTED)
    assert tx.count == 10_000
    assert tx.last_message == "refused 9999"


def test_a_session_fatal_code_is_not_counted_as_a_rejection() -> None:
    # Counting it here would have a readout report a transmit problem
    # for what is actually a connection failure.
    errors = session.PerFrameErrors()
    errors.record(pb.Error.CODE_BUSY, "single-client server")
    errors.record(pb.Error.CODE_UNKNOWN_INTERFACE, "no such interface")
    assert errors.total == 0
    assert errors.snapshot() == []


def test_only_the_first_of_a_code_is_reported_as_new() -> None:
    # What separates the line worth logging from the flood behind it:
    # the rest are the same fault repeating and belong to the tally.
    errors = session.PerFrameErrors()
    assert errors.record(pb.Error.CODE_TX_REJECTED, "listen-only") is True
    assert errors.record(pb.Error.CODE_TX_REJECTED, "listen-only") is False
    assert errors.record(pb.Error.CODE_NO_ACKNOWLEDGER, "nobody there") is True
    assert errors.record(pb.Error.CODE_BUSY, "not per-frame") is False


def test_an_empty_message_does_not_erase_the_one_that_explained_it() -> None:
    errors = session.PerFrameErrors()
    errors.record(pb.Error.CODE_TX_REJECTED, "bus is listen-only")
    errors.record(pb.Error.CODE_TX_REJECTED, "")
    assert errors.snapshot()[0].last_message == "bus is listen-only"
    assert errors.snapshot()[0].count == 2
