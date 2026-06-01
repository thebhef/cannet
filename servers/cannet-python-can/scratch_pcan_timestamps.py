"""Diagnostic: print raw msg.timestamp deltas from python-can directly.

The trace UI is showing bursty RX timestamps (groups of frames within
microseconds of each other followed by 20-50 ms gaps) for a 10 ms
cyclic — but PCAN-View on the same hardware shows clean 10 ms timing.
The bug is somewhere between PCAN-Basic and our trace; this script
bypasses *everything* except python-can to determine whether the
bursty values come straight out of python-can's `recv()` or are
introduced by our pump / conversion layer.

Selects the PCAN device by ``device_id=0`` (the factory-default UID
shown as ``uid:0`` in our channel enumerator). Defaults to CAN-FD with
500 kbps nominal / 2 Mbps data — change if you want classic CAN.

Run from the server dir:

    uv run python scratch_pcan_timestamps.py

Tx the 10 ms cyclic from another bus (or another tool) while it
runs. Watch the ``dt_ms`` column:

- Steady ~10 ms ± a bit  → python-can is fine, the bug is in our pump
  or _msg_to_frame conversion.
- Clusters of <1 ms gaps then 20-50 ms gaps → python-can / PCAN-Basic
  itself is producing bursty timestamps even when nothing else is in
  the way; the fix has to be on that side.
"""

from __future__ import annotations

import sys

import can
from can import BitTimingFd


def main() -> int:
    # FD at 500k nominal / 2M data — matches the user's TX setup.
    # Bit-timing parameters mirror what our production driver uses
    # (driver_python_can._build_fd_timing): f_clock=80MHz, 80% nominal
    # sample point, 70% data sample point.
    timing = BitTimingFd.from_sample_point(
        f_clock=80_000_000,
        nom_bitrate=500_000,
        nom_sample_point=80,
        data_bitrate=2_000_000,
        data_sample_point=70,
    )
    bus = can.Bus(
        interface="pcan",
        channel="PCAN_USBBUS1",
        timing=timing,
        receive_own_messages=False,
    )

    print("seq, ts_s,                dt_ms,  id,    fd, dlc")
    prev: float | None = None
    n = 0
    try:
        while n < 200:
            msg = bus.recv(timeout=30.0)
            if msg is None:
                print("timeout — no frames received in 30 s", file=sys.stderr)
                break
            dt_ms = "n/a" if prev is None else f"{(msg.timestamp - prev) * 1000:7.3f}"
            n += 1
            print(
                f"{n:3d}, {msg.timestamp:.6f}, {dt_ms}, "
                f"0x{msg.arbitration_id:03X}, {int(msg.is_fd)}, {msg.dlc}"
            )
            prev = msg.timestamp
    finally:
        bus.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
