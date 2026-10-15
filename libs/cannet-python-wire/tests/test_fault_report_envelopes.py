"""Round trips for the bus-fault reporting envelopes (ADR 0060).

`BusErrorEpisode`, `TxRefusals` and `FramesDropped` are additive
`cannet.v1` server → client control-lane messages (ADR 0059); the
sidecar is what constructs them, so these tests only prove the
generated stubs carry every field through a real
serialise/parse round trip, the same shape as the Rust tests in
``crates/cannet-wire/tests/round_trip.rs``. `InterfaceState.as_of_ns`
and `ConfigureBus.error_row_cap` are additive fields on existing
messages and get one round trip each.
"""

from __future__ import annotations

import sys
from pathlib import Path


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()

from cannet_python_wire._proto import cannet_pb2 as pb  # noqa: E402


def test_bus_error_episode_round_trips() -> None:
    episode = pb.BusErrorEpisode(
        interface_id="peak:0",
        seq=3,
        first_ns=1_000,
        last_ns=2_000,
        count=42,
        count_by_kind=pb.ErrorKindCounts(
            ack=10, bit=5, form=1, stuff=2, crc=0, other=0, unknown=0
        ),
        tx_count=30,
        rx_count=12,
        tec=128,
        rec=0,
        open=True,
    )
    envelope = pb.Envelope(bus_error_episode=episode)

    decoded = pb.Envelope()
    decoded.ParseFromString(envelope.SerializeToString())

    assert decoded.WhichOneof("body") == "bus_error_episode"
    assert decoded.bus_error_episode == episode


def test_tx_refusals_round_trips() -> None:
    refusals = pb.TxRefusals(
        interface_id="pcan:0",
        reason=pb.TX_REFUSAL_REASON_QUEUE_FULL,
        count=800,
        first_ns=1_000,
        last_ns=5_000,
        last_message="The transmit queue is full",
        flush_count=2,
        last_flush_ns=4_500,
    )
    envelope = pb.Envelope(tx_refusals=refusals)

    decoded = pb.Envelope()
    decoded.ParseFromString(envelope.SerializeToString())

    assert decoded.WhichOneof("body") == "tx_refusals"
    assert decoded.tx_refusals == refusals


def test_frames_dropped_round_trips() -> None:
    dropped = pb.FramesDropped(
        interface_id="vector:0",
        count=10_000,
        first_ns=1_000,
        last_ns=9_000,
    )
    envelope = pb.Envelope(frames_dropped=dropped)

    decoded = pb.Envelope()
    decoded.ParseFromString(envelope.SerializeToString())

    assert decoded.WhichOneof("body") == "frames_dropped"
    assert decoded.frames_dropped == dropped


def test_interface_state_as_of_ns_round_trips() -> None:
    state = pb.InterfaceState(
        interface_id="peak:0",
        state=pb.CONTROLLER_STATE_WARNING,
        tec=96,
        rec=0,
        as_of_ns=123_456_789,
    )
    envelope = pb.Envelope(interface_state=state)

    decoded = pb.Envelope()
    decoded.ParseFromString(envelope.SerializeToString())

    assert decoded.interface_state.as_of_ns == 123_456_789


def test_configure_bus_error_row_cap_round_trips_and_stays_unset_by_default() -> None:
    with_cap = pb.ConfigureBus(
        interface_id="peak:0", speed_bps=500_000, error_row_cap=4
    )
    decoded = pb.ConfigureBus()
    decoded.ParseFromString(with_cap.SerializeToString())
    assert decoded.HasField("error_row_cap")
    assert decoded.error_row_cap == 4

    # Unset means "use the server's default (16)" (ADR 0060 rule 2) —
    # the field must round-trip as absent, not as zero.
    without_cap = pb.ConfigureBus(interface_id="peak:0", speed_bps=500_000)
    decoded_without = pb.ConfigureBus()
    decoded_without.ParseFromString(without_cap.SerializeToString())
    assert not decoded_without.HasField("error_row_cap")
