"""asammdf oracle for the cannet MDF writer.

Opens a file written by ``cargo run -p cannet-mdf --example export_sample``
with Python asammdf — the ecosystem's reference implementation — and checks
that an outside reader sees exactly the capture that went in: the
bus-logging map, every frame field for field, the message-independent
signal groups, the timeline events, and the embedded attachment.

This is a **dev/CI-time oracle, never a runtime dependency**. The default
``cargo test`` suite proves the writer against this crate's own reader and
needs no Python; this script is the independent second opinion, run as an
isolated integration check::

    cargo run -p cannet-mdf --example export_sample -- /tmp/sample.mf4
    uv run --with asammdf --with numpy python \\
        crates/cannet-mdf/tests/fixtures/validate_export.py /tmp/sample.mf4

The example writes ``<out>.json`` beside the file listing what it wrote;
this script compares the file against that, so the two never drift.
A non-zero exit means asammdf disagrees with the writer.
"""

from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

from asammdf import MDF

ID_UNFIN_STD_FLAGS = 60  # u16, per the MDF 4.1 identification block

STRUCTURES = ("CAN_DataFrame", "CAN_ErrorFrame", "CAN_RemoteFrame")

# Every scalar member of a bus-logging structure, and the key it carries in
# the expectations JSON.
MEMBERS = {
    "BusChannel": "bus_channel",
    "ID": "id",
    "IDE": "ide",
    "DLC": None,  # derived from the payload length, checked via DataLength
    "DataLength": "data_length",
    "Dir": "dir",
    "EDL": "edl",
    "BRS": "brs",
    "ESI": "esi",
}


def abs_ns(start_ns: int, seconds: float) -> int:
    """Master seconds -> absolute nanoseconds, cannet's tie rule.

    ``math.floor(x + 0.5)`` rather than ``round(x)``: Rust's ``f64::round``
    breaks a tie away from zero and Python's ``round`` breaks it to even,
    so a master sample whose nanoseconds land on exactly ``.5`` would
    otherwise read one nanosecond apart in the two languages and make
    this oracle disagree with the reader over nothing.
    """
    return start_ns + math.floor(float(seconds) * 1e9 + 0.5)


def group_indices(mdf: MDF) -> dict[str, int]:
    """Channel-group index of each bus-logging structure, by structure name."""
    out = {}
    for i, grp in enumerate(mdf.groups):
        names = [c.name for c in grp.channels]
        for structure in STRUCTURES:
            if structure in names:
                out[structure] = i
    return out


def check_frames(mdf: MDF, expected, start_ns: int, problems: list[str]) -> None:
    groups = group_indices(mdf)
    for structure in STRUCTURES:
        if structure not in groups:
            problems.append(f"no channel group carries {structure}")
    want: dict[str, list] = {s: [] for s in STRUCTURES}
    for frame in expected:
        want[frame["structure"]].append(frame)

    for structure, frames in want.items():
        gi = groups.get(structure)
        if gi is None:
            continue
        cycles = mdf.groups[gi].channel_group.cycles_nr
        if cycles != len(frames):
            problems.append(f"{structure}: {cycles} cycles, expected {len(frames)}")
            continue
        if not frames:
            continue
        columns = {
            member: mdf.get(f"{structure}.{member}", group=gi).samples
            for member in MEMBERS
        }
        payload = mdf.get(f"{structure}.DataBytes", group=gi).samples
        times = mdf.get(f"{structure}.ID", group=gi).timestamps
        for i, frame in enumerate(frames):
            for member, key in MEMBERS.items():
                if key is None:
                    continue
                got = int(columns[member][i])
                if got != frame[key]:
                    problems.append(
                        f"{structure}[{i}] {member} {got} != {frame[key]}"
                    )
            got_hex = bytes(payload[i][: frame["data_length"]]).hex()
            if got_hex != frame["data_hex"]:
                problems.append(
                    f"{structure}[{i}] DataBytes {got_hex} != {frame['data_hex']}"
                )
            got_ns = abs_ns(start_ns, times[i])
            if got_ns != frame["t_abs_ns"]:
                problems.append(
                    f"{structure}[{i}] t {got_ns} != {frame['t_abs_ns']}"
                )


def check_signals(mdf: MDF, expected, start_ns: int, problems: list[str]) -> None:
    # Signal groups are the ones with no bus-logging structure in them.
    bus = set(group_indices(mdf).values())
    plain = [i for i in range(len(mdf.groups)) if i not in bus]
    if len(plain) != len(expected):
        problems.append(f"{len(plain)} signal group(s), expected {len(expected)}")
        return
    for gi, want in zip(plain, expected):
        grp = mdf.groups[gi]
        acq = grp.channel_group.acq_name or None
        if acq != want["group_name"]:
            problems.append(f"g{gi} acq_name {acq!r} != {want['group_name']!r}")
        signal = mdf.get(want["name"], group=gi)
        if (signal.unit or None) != want["unit"]:
            problems.append(
                f"g{gi} {want['name']} unit {signal.unit!r} != {want['unit']!r}"
            )
        if len(signal.samples) != len(want["values"]):
            problems.append(f"g{gi} {want['name']} sample count mismatch")
            continue
        for k, (value, t_ns) in enumerate(zip(want["values"], want["t_abs_ns"])):
            if float(signal.samples[k]) != float(value):
                problems.append(
                    f"g{gi} {want['name']}[{k}] {signal.samples[k]} != {value}"
                )
            got_ns = abs_ns(start_ns, signal.timestamps[k])
            if got_ns != t_ns:
                problems.append(f"g{gi} {want['name']}[{k}] t {got_ns} != {t_ns}")


def properties_of(comment: str) -> dict[str, str]:
    """The ``common_properties`` of an event comment, as asammdf hands it over."""
    import xml.etree.ElementTree as ET

    if not comment:
        return {}
    root = ET.fromstring(comment)
    return {
        e.attrib["name"]: (e.text or "")
        for e in root.iterfind("./common_properties/e")
    }


def check_events(mdf: MDF, expected, start_ns: int, problems: list[str]) -> None:
    if len(mdf.events) != len(expected):
        problems.append(f"{len(mdf.events)} event(s), expected {len(expected)}")
        return
    for i, (event, want) in enumerate(zip(mdf.events, expected)):
        if event.name != want["name"]:
            problems.append(f"event {i} name {event.name!r} != {want['name']!r}")
        got_ns = abs_ns(start_ns, event.value)
        if got_ns != want["t_abs_ns"]:
            problems.append(f"event {i} t {got_ns} != {want['t_abs_ns']}")
        got_props = properties_of(event.comment)
        if got_props != want["properties"]:
            problems.append(f"event {i} properties {got_props} != {want['properties']}")


def check_attachment(mdf: MDF, want, problems: list[str]) -> None:
    if len(mdf.attachments) != 1:
        problems.append(f"{len(mdf.attachments)} attachment(s), expected 1")
        return
    block = mdf.attachments[0]
    if block.file_name != want["file_name"]:
        problems.append(f"attachment name {block.file_name!r} != {want['file_name']!r}")
    if block.mime != want["mime_type"]:
        problems.append(f"attachment mime {block.mime!r} != {want['mime_type']!r}")
    data, _path, _md5 = mdf.extract_attachment(0)
    if data.hex() != want["data_hex"]:
        problems.append("attachment bytes differ from what was embedded")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    path = Path(sys.argv[1])
    expected = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
    problems: list[str] = []

    raw = path.read_bytes()
    if raw[:8] != b"MDF     ":
        problems.append(f"file identifier {raw[:8]!r} is not a finalized MDF")
    unfin = struct.unpack_from("<H", raw, ID_UNFIN_STD_FLAGS)[0]
    if unfin != 0:
        problems.append(f"id_unfin_flags {unfin:#x}, expected a finalized 0")

    mdf = MDF(path)
    try:
        if mdf.version != "4.10":
            problems.append(f"version {mdf.version} != 4.10")
        start_ns = expected["start_time_ns"]
        if mdf.header.abs_time != start_ns:
            problems.append(f"hd start {mdf.header.abs_time} != {start_ns}")
        can_map = mdf.bus_logging_map.get("CAN") or {}
        if not can_map:
            problems.append("bus_logging_map['CAN'] is empty — not read as bus logging")
        check_frames(mdf, expected["frames"], start_ns, problems)
        check_signals(mdf, expected["signals"], start_ns, problems)
        check_events(mdf, expected["events"], start_ns, problems)
        check_attachment(mdf, expected["attachment"], problems)
    finally:
        mdf.close()

    print(
        f"{path.name}: {len(expected['frames'])} frame(s), "
        f"{len(expected['signals'])} signal(s), {len(expected['events'])} event(s), "
        f"1 attachment, CAN buses {sorted(int(b) for b in can_map)} — "
        + ("OK" if not problems else f"FAIL ({len(problems)})")
    )
    for problem in problems[:20]:
        print("    !", problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
