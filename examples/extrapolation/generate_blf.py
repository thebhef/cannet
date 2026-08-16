#!/usr/bin/env python3
"""Generate the extrapolation.blf fixture from extrapolation.dbc.

Every series in this trace exists to put one *extrapolated* shape in
front of a renderer (ADR 0026): a stretch of plot that is drawn from a
held value rather than from a reading. The shapes, and what makes each
one one:

    RefLevel      arrives for the whole capture. Nothing about it is
                  extrapolated; it is here so the plot's x window
                  reaches DURATION_S, which is what puts every other
                  series' last sample *inside* the window.
    StoppedLevel  stops at STOP_S. Everything past that is a hold.
    StalledLevel  goes quiet from STALL_FROM_S to STALL_TO_S — an
                  interior gap far past 10x its own cadence.
    OneShotLevel  one frame, at ONESHOT_S. Drawn as a horizontal line
                  with no data on either side of the single sample.
    DenseMode     an enum arriving throughout: solid tiles, and the
                  lane whose sample markers show where the samples are.
    StoppedMode   an enum that stops at LANE_STOP_S with its last
                  transition earlier still, so one tile is part read
                  and part held.
    StalledMode   an enum with an interior stall inside a single held
                  state: a tile stale in its middle.

Deterministic: no RNG, no wall clock. Every frame's payload and
timestamp is a function of the constants below, so the fixture is
byte-identical across runs and machines.

Run:
    uv run --with python-can --with cantools \
        examples/extrapolation/generate_blf.py
"""

from __future__ import annotations

import math
from pathlib import Path

import can
import cantools

HERE = Path(__file__).resolve().parent
DBC_PATH = HERE / "extrapolation.dbc"
BLF_PATH = HERE / "extrapolation.blf"

DURATION_S = 20.0
#: The numeric series that stops, and when.
STOP_S = 8.0
#: The numeric series that stalls, and over what.
STALL_FROM_S, STALL_TO_S = 6.0, 13.0
#: The one-sample series' single frame.
ONESHOT_S = 10.0
#: The enum lane that stops, and its last transition before it does.
LANE_STOP_S, LANE_STOP_TRANSITION_S = 6.0, 3.0
#: The enum lane that stalls, and the transition its stall sits inside.
LANE_STALL_FROM_S, LANE_STALL_TO_S = 7.0, 15.0
LANE_STALL_TRANSITION_S = 3.0


def ticks(period: float, until: float = DURATION_S):
    """Timestamps `0, period, 2*period, …` up to and including `until`."""
    n = int(round(until / period))
    return [round(i * period, 6) for i in range(n + 1)]


def main() -> None:
    db = cantools.database.load_file(str(DBC_PATH))
    schedule: list[tuple[float, can.Message]] = []

    def emit(message_name: str, t: float, values: dict[str, float]) -> None:
        message = db.get_message_by_name(message_name)
        schedule.append((t, _make_msg(message, message.encode(values))))

    # --- numeric series -------------------------------------------------
    # All four share the "%" unit so per-unit mode puts them on one
    # numeric axis, and their bands are separated so the dashes of one
    # are never read as the dashes of another.

    # RefLevel — 50 ms, the whole capture. The window's right edge.
    for t in ticks(0.050):
        emit("RefRamp", t, {"RefLevel": 80.0 + 10.0 * math.sin(2 * math.pi * t / 7.0)})

    # StoppedLevel — 50 ms, silent after STOP_S.
    for t in ticks(0.050, STOP_S):
        emit(
            "StoppedRamp",
            t,
            {"StoppedLevel": 55.0 + 8.0 * math.sin(2 * math.pi * t / 5.0)},
        )

    # StalledLevel — 100 ms, silent between STALL_FROM_S and STALL_TO_S.
    # 70 x its own cadence: an ordinary missed frame is nothing like it.
    for t in ticks(0.100):
        if STALL_FROM_S < t < STALL_TO_S:
            continue
        emit(
            "StalledRamp",
            t,
            {"StalledLevel": 30.0 + 8.0 * math.sin(2 * math.pi * t / 9.0)},
        )

    # OneShotLevel — one frame and no more.
    emit("OneShot", ONESHOT_S, {"OneShotLevel": 12.0})

    # --- enum lanes -----------------------------------------------------

    # DenseMode — 200 ms, the whole capture, a transition every 4 s.
    for t in ticks(0.200):
        emit("DenseState", t, {"DenseMode": min(4, int(t // 4.0))})

    # StoppedMode — 500 ms, silent after LANE_STOP_S. Its last
    # transition is at LANE_STOP_TRANSITION_S, so the tile it opens is
    # read until LANE_STOP_S and held from there to the window's edge.
    for t in ticks(0.500, LANE_STOP_S):
        emit("StoppedState", t, {"StoppedMode": 1 if t >= LANE_STOP_TRANSITION_S else 0})

    # StalledMode — 200 ms with an interior stall that sits *inside* one
    # held state, so the tile it belongs to is stale only in its middle.
    for t in ticks(0.200):
        if LANE_STALL_FROM_S < t < LANE_STALL_TO_S:
            continue
        emit("StalledState", t, {"StalledMode": 2 if t >= LANE_STALL_TRANSITION_S else 0})

    # Chronological order, ties broken by the order emitted above so the
    # file is a function of this script and nothing else.
    schedule.sort(key=lambda x: x[0])

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
