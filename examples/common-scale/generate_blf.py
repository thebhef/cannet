#!/usr/bin/env python3
"""Generate the common-scale.blf fixture from common-scale.dbc.

The task-98 defect, as a file: two signals of very different amplitude
sharing one plot area. Pre-fix, an axis could carry more than one scale
under one set of tick labels, so on a common (unified) axis the
-200..0 A series rendered as -1.5..0 — the companion signal's range.
The pairs here are the two shapes from that investigation's experiment
matrix that reproduced it:

    SmallVolts / BigAmps   mixed units, small-ranged signal listed
                           first — the owner's 0.9.0 observation
                           verbatim on a unified axis.
    SmallBare / BigBare    the same amplitudes with no units, which
                           also broke per-unit mode (unitless signals
                           were one axis group but private scale
                           groups).

Deterministic: no RNG, no wall clock. Every frame is a function of the
constants below, so the fixture is byte-identical across runs.

Run:
    uv run --with python-can --with cantools \
        examples/common-scale/generate_blf.py
"""

from __future__ import annotations

import math
from pathlib import Path

import can
import cantools

HERE = Path(__file__).resolve().parent
DBC_PATH = HERE / "common-scale.dbc"
BLF_PATH = HERE / "common-scale.blf"

DURATION_S = 10.0
PERIOD_S = 0.050


def main() -> None:
    db = cantools.database.load_file(str(DBC_PATH))
    mixed = db.get_message_by_name("MixedPair")
    bare = db.get_message_by_name("BarePair")

    schedule: list[tuple[float, can.Message]] = []
    n = int(round(DURATION_S / PERIOD_S))
    for i in range(n + 1):
        t = round(i * PERIOD_S, 6)
        # Both series sweep their full declared range, so the rendered
        # amplitude is checkable against the axis by eye alone.
        small = -0.75 - 0.75 * math.sin(2 * math.pi * t / 3.0)
        big = -100.0 - 100.0 * math.sin(2 * math.pi * t / 5.0)
        schedule.append(
            (t, _make_msg(mixed, mixed.encode({"SmallVolts": small, "BigAmps": big})))
        )
        schedule.append(
            (t, _make_msg(bare, bare.encode({"SmallBare": small, "BigBare": big})))
        )

    with can.io.BLFWriter(str(BLF_PATH)) as writer:
        for t, msg in schedule:
            msg.timestamp = t
            writer.on_message_received(msg)

    print(f"Wrote {len(schedule)} frames over {DURATION_S} s -> {BLF_PATH}")


def _make_msg(message, data: bytes) -> can.Message:
    return can.Message(
        arbitration_id=message.frame_id,
        is_extended_id=message.is_extended_frame,
        is_fd=False,
        data=data,
        dlc=len(data),
    )


if __name__ == "__main__":
    main()
