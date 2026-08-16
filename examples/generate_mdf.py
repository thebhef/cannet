#!/usr/bin/env python3
"""Generate the cannet-demo.mf4 fixture — the demo trace as ASAM MDF.

Same 10 s of traffic as ``cannet-demo.blf`` (this reads that file rather
than re-deriving the waveforms, so the two fixtures can never drift),
plus the two things an MDF carries that a BLF cannot:

* **event markers** — ``##EV`` blocks with a time and a text, which
  cannet imports as session notes;
* **message-independent signal channel groups** — named value series
  with units and no bus message behind them, which cannet imports as
  file-backed signals. One of them is *coded*: its conversion block is
  a value→text table, so its import carries the labels of an enum lane.

Deterministic: the frames come from the committed BLF, and the extra
signal series are seeded, so the output is byte-identical across runs.

Run:
    uv run --with asammdf --with numpy --with python-can generate_mdf.py

The frames land in a `CAN_DataFrame` bus-logging channel group, written
the way real logger files write one: the structured array's *field
names* are the canonical dotted channel names, which is what makes
asammdf emit one ``##CN`` per member under the structure channel.
"""

from __future__ import annotations

import datetime
import math
import random
from pathlib import Path

import can
import numpy as np
from asammdf import MDF, Signal
from asammdf.blocks import v4_constants as v4c
from asammdf.blocks.source_utils import Source
from asammdf.blocks.v4_blocks import EventBlock

HERE = Path(__file__).resolve().parent
BLF_PATH = HERE / "cannet-demo.blf"
MDF_PATH = HERE / "cannet-demo.mf4"

# Fixed wall clock for the capture's `hd_start_time_ns`, so the demo
# opens at a sensible date instead of at whenever it was generated.
START_TIME = datetime.datetime(2024, 3, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)

DURATION_S = 10.0
SEED = 0x0FFE71DF
# Every demo frame fits 32 payload bytes (AdasState is the widest).
PAYLOAD_BYTES = 32
# The logical bus every demo frame is on; 1-based on disk, so cannet's
# channel→bus mapping dialog offers exactly one row.
BUS_CHANNEL = 1

CAN_SOURCE = Source("CAN", "CAN", "", Source.SOURCE_BUS, Source.BUS_TYPE_CAN)

# Markers a user might have dropped while watching this run. The id is
# what cannet keys a note by; the color is optional.
EVENTS = [
    (0.000, "run start", "demo-0", None),
    (2.000, "gear shift", "demo-1", "#FF8800"),
    (5.000, "GPS fix", "demo-2", None),
    (9.500, "run end", "demo-3", "#3388FF"),
]


def bus_dtype() -> np.dtype:
    """The `CAN_DataFrame` record layout, dotted field names and all."""
    return np.dtype(
        [
            ("CAN_DataFrame.BusChannel", "<u1"),
            ("CAN_DataFrame.ID", "<u4"),
            ("CAN_DataFrame.IDE", "<u1"),
            ("CAN_DataFrame.DLC", "<u1"),
            ("CAN_DataFrame.DataLength", "<u1"),
            ("CAN_DataFrame.DataBytes", f"({PAYLOAD_BYTES},)u1"),
            ("CAN_DataFrame.Dir", "<u1"),
            ("CAN_DataFrame.EDL", "<u1"),
            ("CAN_DataFrame.BRS", "<u1"),
            ("CAN_DataFrame.ESI", "<u1"),
        ]
    )


def read_demo_frames() -> tuple[np.ndarray, np.ndarray]:
    """The committed demo BLF as (timestamps, `CAN_DataFrame` records)."""
    rows = []
    with can.BLFReader(str(BLF_PATH)) as reader:
        for msg in reader:
            rows.append(msg)
    rows.sort(key=lambda m: m.timestamp)

    arr = np.zeros(len(rows), dtype=bus_dtype())
    times = np.zeros(len(rows), dtype="f8")
    base = rows[0].timestamp if rows else 0.0
    for i, msg in enumerate(rows):
        times[i] = msg.timestamp - base
        arr["CAN_DataFrame.BusChannel"][i] = BUS_CHANNEL
        arr["CAN_DataFrame.ID"][i] = msg.arbitration_id
        arr["CAN_DataFrame.IDE"][i] = int(msg.is_extended_id)
        arr["CAN_DataFrame.DLC"][i] = msg.dlc
        arr["CAN_DataFrame.DataLength"][i] = len(msg.data)
        arr["CAN_DataFrame.DataBytes"][i, : len(msg.data)] = np.frombuffer(
            bytes(msg.data), dtype="u1"
        )
        arr["CAN_DataFrame.Dir"][i] = 0  # every demo frame is received
        arr["CAN_DataFrame.EDL"][i] = int(msg.is_fd)
        arr["CAN_DataFrame.BRS"][i] = int(msg.bitrate_switch)
        arr["CAN_DataFrame.ESI"][i] = int(msg.error_state_indicator)
    return times, arr


def messageless_signals(rnd: random.Random) -> list[tuple[str, list[Signal]]]:
    """Series no CAN message carries — a logger's own analog inputs.

    These are what MDF calls message-independent signal channels and what
    cannet imports as *file-backed signals*: recorded directly, decoded
    by nobody, complete the moment they are read.
    """

    def series(name, unit, period, fn):
        n = int(DURATION_S / period)
        t = np.array([i * period for i in range(n)], dtype="f8")
        values = np.array([fn(i * period) for i in range(n)], dtype="f8")
        return Signal(values, t, name=name, unit=unit)

    def coded_series(name, period, fn, table):
        """A coded channel: raw integer samples plus the value→text
        conversion (`##CC` type 7, TABX) that names each code — what
        cannet renders as a file-backed enum lane."""
        n = int(DURATION_S / period)
        t = np.array([i * period for i in range(n)], dtype="f8")
        values = np.array([fn(i * period) for i in range(n)], dtype="u1")
        conversion = {}
        for i, (code, label) in enumerate(table):
            conversion[f"val_{i}"] = code
            conversion[f"text_{i}"] = label
        return Signal(values, t, name=name, conversion=conversion)

    return [
        (
            "Ambient",
            [
                series(
                    "AmbientTemp",
                    "degC",
                    0.250,
                    lambda t: 18.0
                    + 2.0 * math.sin(2 * math.pi * t / 9.0)
                    + rnd.gauss(0, 0.05),
                ),
                series(
                    "CabinHumidity",
                    "%",
                    0.250,
                    lambda t: 42.0
                    + 6.0 * math.sin(2 * math.pi * t / 11.0)
                    + rnd.gauss(0, 0.2),
                ),
            ],
        ),
        (
            "Charger",
            [
                series(
                    "ChargerPower",
                    "kW",
                    0.500,
                    lambda t: max(0.0, 7.4 * math.sin(2 * math.pi * t / 20.0)),
                ),
                coded_series(
                    "ContactorState",
                    0.500,
                    # The charge contactor's walk: open, precharge the DC
                    # link, close for the bulk of the session, reopen.
                    lambda t: 0 if t < 2.0 else 1 if t < 3.0 else 2 if t < 8.0 else 0,
                    [(0, "Open"), (1, "Precharge"), (2, "Closed")],
                ),
            ],
        ),
    ]


def marker(time_s: float, name: str, note_id: str, color: str | None) -> EventBlock:
    """One `##EV` marker block, timed in whole nanoseconds.

    The id (and the color, when there is one) ride in the event's `##MD`
    comment under `common_properties` — MDF's own extension point for
    tool metadata, which is where cannet keeps them so a note survives a
    save → open round-trip with its identity intact.
    """
    properties = [("cannet.id", note_id)]
    if color:
        properties.append(("cannet.color", color))
    entries = "".join(f'<e name="{k}">{v}</e>' for k, v in properties)
    event = EventBlock(
        event_type=v4c.EVENT_TYPE_MARKER,
        sync_type=v4c.EVENT_SYNC_TYPE_S,
        range_type=v4c.EVENT_RANGE_TYPE_POINT,
        cause=v4c.EVENT_CAUSE_USER,
        sync_base=round(time_s * 1e9),
        sync_factor=1e-9,
        scope_count=0,
        attachment_nr=0,
        flags=0,
    )
    event.name = name
    event.comment = f"<EVcomment><common_properties>{entries}</common_properties></EVcomment>"
    return event


def pin_file_history_time(path: Path, time_ns: int) -> None:
    """Stamp the `##FH` block's time, so the file is byte-reproducible.

    asammdf records the wall clock at save time in the file-history
    block. That is the one thing in the output that changes run to run,
    and a fixture whose bytes churn on every regeneration is a fixture
    nobody can diff — so it is pinned to the capture's own start time.
    """
    HD_ADDR, HD_FH_LINK, FH_TIME = 0x40, 32, 40
    raw = bytearray(path.read_bytes())
    fh_addr = int.from_bytes(raw[HD_ADDR + HD_FH_LINK : HD_ADDR + HD_FH_LINK + 8], "little")
    assert raw[fh_addr : fh_addr + 4] == b"##FH", raw[fh_addr : fh_addr + 4]
    raw[fh_addr + FH_TIME : fh_addr + FH_TIME + 8] = time_ns.to_bytes(8, "little")
    path.write_bytes(bytes(raw))


def main() -> None:
    rnd = random.Random(SEED)
    times, frames = read_demo_frames()

    groups = messageless_signals(rnd)

    mdf = MDF(version="4.10")
    mdf.header.start_time = START_TIME
    mdf.append(
        [Signal(samples=frames, timestamps=times, name="CAN_DataFrame", source=CAN_SOURCE)],
        acq_name="CAN",
    )
    for group_name, signals in groups:
        mdf.append(signals, acq_name=group_name)
    for time_s, name, note_id, color in EVENTS:
        mdf.events.append(marker(time_s, name, note_id, color))
    mdf.save(MDF_PATH, overwrite=True, compression=1)
    mdf.close()
    pin_file_history_time(MDF_PATH, int(START_TIME.timestamp() * 1e9))

    size = MDF_PATH.stat().st_size
    signal_count = sum(len(s) for _, s in groups)
    print(
        f"Wrote {len(frames)} frames over {DURATION_S} s, "
        f"{signal_count} message-independent signal(s) and {len(EVENTS)} event(s) "
        f"-> {MDF_PATH} ({size} bytes)"
    )


if __name__ == "__main__":
    main()
