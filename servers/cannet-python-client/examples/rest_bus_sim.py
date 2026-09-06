"""A rest-of-bus simulation against a cannet server, in python-can.

Opens a bus on a trusted server, answers one request id, and sends a
heartbeat on a cadence — the shape of a test-bench application, and a
complete example of what this package adds to python-can: nothing at
the call sites, and a `server=` where an application would otherwise
carry a device handle.

Run it against the in-tree virtual bus, which needs no hardware and no
trust decision::

    cargo run -p cannet-server -- debug vbus
    uv run --project servers/cannet-python-client python \\
        servers/cannet-python-client/examples/rest_bus_sim.py

or against a real adapter on a server this machine has accepted in the
cannet GUI::

    ... rest_bus_sim.py --server bench --channel pcan:PCAN_USBBUS1 \\
        --bitrate 500000
"""

from __future__ import annotations

import argparse
import time

import can

#: The id this simulation answers, and the one it answers with.
REQUEST_ID = 0x7A0
RESPONSE_ID = 0x7A8
HEARTBEAT_ID = 0x100


class Responder(can.Listener):
    """Answer every request frame, and count what went past."""

    def __init__(self, bus: can.BusABC) -> None:
        self.bus = bus
        self.seen = 0

    def on_message_received(self, msg: can.Message) -> None:
        self.seen += 1
        if msg.arbitration_id != REQUEST_ID:
            return
        self.bus.send(
            can.Message(
                arbitration_id=RESPONSE_ID,
                is_extended_id=False,
                data=bytes(msg.data)[:4],
            )
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--server",
        default="localhost",
        help="a server this machine trusts, by name or host:port",
    )
    parser.add_argument("--channel", default="virtual:bus0", help="the interface id")
    parser.add_argument("--bitrate", type=int, default=None)
    parser.add_argument("--seconds", type=float, default=10.0)
    args = parser.parse_args()

    # No cannet import anywhere in this file: python-can resolves
    # `interface="cannet"` through this package's entry point.
    with can.Bus(
        interface="cannet",
        server=args.server,
        channel=args.channel,
        bitrate=args.bitrate,
    ) as bus:
        print(f"open: {bus.channel_info}")

        responder = Responder(bus)
        notifier = can.Notifier(bus, [responder], timeout=1.0)
        heartbeat = bus.send_periodic(
            can.Message(arbitration_id=HEARTBEAT_ID, data=b"\x00" * 8), period=0.1
        )
        try:
            time.sleep(args.seconds)
        finally:
            heartbeat.stop()
            notifier.stop()

        print(f"state: {bus.state.name}, frames seen: {responder.seen}")
        # What the peer said about frames it would not carry. On an
        # otherwise empty virtual bus this is where the heartbeats go:
        # a transmit that reached no participant is one frame's
        # problem, not the session's.
        for tally in bus.rejections.snapshot():
            print(f"rejected x{tally.count}: {tally.last_message}")


if __name__ == "__main__":
    main()
