"""Synthetic MF4 fixture generator for the cannet MDF 4.x reader.

Emits a fixture matrix (sorted/unsorted x finalized/unfinalized x classic/FD x
DT/DZ, plus the two non-logger content shapes the reader must classify) and an
``expected/`` directory of JSON ground-truth files.

The committed ``.mf4`` files and their ``expected/*.json`` are what the Rust
suite reads, so the default ``cargo test`` needs no Python and no asammdf.
This script only has to run when a fixture changes; regenerating requires
Python plus asammdf, which is a dev-time oracle and never a runtime
dependency:

    uv run --with asammdf --with numpy python gen_fixtures.py

It rewrites every fixture and every expectation in place, then re-reads each
result through asammdf and checks it against the JSON it just wrote — a
non-zero exit means the corpus on disk does not match its own ground truth.

Timestamps are recorded as integer nanoseconds *and* as the exact IEEE-754
bit pattern of the stored master sample, so no float formatting can drift
between the two languages.

All content is invented; nothing is derived from any real capture.
"""

from __future__ import annotations

import datetime
import json
import shutil
import struct
import sys
from pathlib import Path

import numpy as np
from asammdf import MDF, Signal
from asammdf.blocks.source_utils import Source

HERE = Path(__file__).resolve().parent
OUT = HERE
EXPECTED = HERE / "expected"
TMP = HERE / "_tmp"

# --- MDF4 block field offsets (ASAM MDF 4.1; cross-checked against
# --- asammdf/blocks/v4_constants.py FMT_* struct formats).
HD_ADDR = 0x40
ID_FILE_IDENTIFICATION = 0  # 8s, "MDF     " or "UnFinMF "
ID_UNFIN_STD_FLAGS = 60  # u16
ID_UNFIN_CUSTOM_FLAGS = 62  # u16
BLOCK_LEN = 8  # u64, in every ##XX common header
BLOCK_LINKS_NR = 16  # u64
BLOCK_DATA = 24  # first link starts here too
HD_FIRST_DG = 24  # u64 link
DG_NEXT_DG = 24  # u64 link
DG_FIRST_CG = 32  # u64 link
DG_DATA_BLOCK = 40  # u64 link
DG_RECORD_ID_LEN = 56  # u8
CG_NEXT_CG = 24  # u64 link
CG_RECORD_ID = 72  # u64
CG_CYCLES_NR = 80  # u64
CG_FLAGS = 88  # u16
CG_SAMPLES_BYTE_NR = 96  # u32
CG_INVAL_BYTE_NR = 100  # u32

FLAG_UNFIN_UPDATE_CG_COUNTER = 0x1
FLAG_UNFIN_UPDATE_LAST_DT_LENGTH = 0x4

START_TIME = datetime.datetime(2024, 3, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)
START_NS = 1709294400_000_000_000  # asserted against the written HD block

CAN_SRC = Source("CAN", "CAN", "", Source.SOURCE_BUS, Source.BUS_TYPE_CAN)

# CAN FD DLC -> payload byte count
DLC_TO_LEN = {i: i for i in range(9)}
DLC_TO_LEN.update({9: 12, 10: 16, 11: 20, 12: 24, 13: 32, 14: 48, 15: 64})


# --------------------------------------------------------------------------
# synthetic frame content
# --------------------------------------------------------------------------
def payload(seed: int, n: int) -> bytes:
    return bytes(((seed * 7 + j * 31 + 0x5A) & 0xFF) for j in range(n))


def classic_frames(count: int, bus: int, base_ns: int, step_ns: int, seed0: int):
    """Deterministic classic-CAN frames, ascending in time."""
    ids = [(0x100, 0), (0x1A5, 0), (0x18FEE125, 1), (0x7FF, 0), (0x0CF00400, 1)]
    out = []
    for i in range(count):
        can_id, ide = ids[i % len(ids)]
        dlc = (i % 9)
        out.append(
            {
                "t_ns": base_ns + i * step_ns,
                "bus_channel": bus,
                "id": can_id,
                "ide": ide,
                "dlc": dlc,
                "data_length": dlc,
                "data": payload(seed0 + i, dlc),
                "dir": i % 2,
                "edl": 0,
                "brs": 0,
                "esi": 0,
            }
        )
    return out


def fd_frames(count: int, bus: int, base_ns: int, step_ns: int, seed0: int):
    out = []
    for i in range(count):
        dlc = i % 16
        length = DLC_TO_LEN[dlc]
        can_id = (0x200 + (i % 3)) if i % 4 else (0x1CEC0100 + (i % 3))
        ide = 0 if i % 4 else 1
        out.append(
            {
                "t_ns": base_ns + i * step_ns,
                "bus_channel": bus,
                "id": can_id,
                "ide": ide,
                "dlc": dlc,
                "data_length": length,
                "data": payload(seed0 + i, length),
                "dir": 0,
                "edl": 1,
                "brs": i % 2,
                "esi": (i // 2) % 2,
            }
        )
    return out


# --------------------------------------------------------------------------
# asammdf authoring
# --------------------------------------------------------------------------
def bus_dtype(prefix: str, payload_bytes: int, fd: bool, extra: tuple[str, ...] = ()):
    """Structured dtype whose FIELD NAMES are the canonical dotted names.

    asammdf writes one ##CN per structured-array field using the field name
    verbatim, so naming the fields ``CAN_DataFrame.ID`` etc. is what makes a
    re-read yield the canonical dotted channel names.
    """
    fields = [
        (f"{prefix}.BusChannel", "<u1"),
        (f"{prefix}.ID", "<u4"),
        (f"{prefix}.IDE", "<u1"),
        (f"{prefix}.DLC", "<u1"),
        (f"{prefix}.DataLength", "<u1"),
        (f"{prefix}.DataBytes", f"({payload_bytes},)u1"),
        (f"{prefix}.Dir", "<u1"),
    ]
    if fd:
        fields += [(f"{prefix}.EDL", "<u1"), (f"{prefix}.BRS", "<u1"), (f"{prefix}.ESI", "<u1")]
    fields += [(f"{prefix}.{name}", "<u1") for name in extra]
    return np.dtype(fields)


def bus_signal(frames, prefix="CAN_DataFrame", payload_bytes=8, fd=False, extra=()):
    dt = bus_dtype(prefix, payload_bytes, fd, extra)
    arr = np.zeros(len(frames), dtype=dt)
    for i, f in enumerate(frames):
        arr[f"{prefix}.BusChannel"][i] = f["bus_channel"]
        arr[f"{prefix}.ID"][i] = f["id"]
        arr[f"{prefix}.IDE"][i] = f["ide"]
        arr[f"{prefix}.DLC"][i] = f["dlc"]
        arr[f"{prefix}.DataLength"][i] = f["data_length"]
        arr[f"{prefix}.DataBytes"][i, : len(f["data"])] = np.frombuffer(f["data"], dtype="u1")
        arr[f"{prefix}.Dir"][i] = f["dir"]
        if fd:
            arr[f"{prefix}.EDL"][i] = f["edl"]
            arr[f"{prefix}.BRS"][i] = f["brs"]
            arr[f"{prefix}.ESI"][i] = f["esi"]
        for name in extra:
            arr[f"{prefix}.{name}"][i] = f.get(name.lower(), f.get(name, 0))
    return Signal(samples=arr, timestamps=timestamps(frames), name=prefix, source=CAN_SRC)


def timestamps(frames) -> np.ndarray:
    t = np.array([f["t_ns"] for f in frames], dtype="i8") / 1e9
    # ns offsets are whole milliseconds, so the f64 round-trips exactly
    assert np.array_equal(np.rint(t * 1e9).astype("i8"), np.array([f["t_ns"] for f in frames], dtype="i8"))
    return t


def new_mdf() -> MDF:
    m = MDF(version="4.10")
    m.header.start_time = START_TIME
    return m


# --------------------------------------------------------------------------
# byte-level block walking / patching
# --------------------------------------------------------------------------
def u64(buf, off):
    return struct.unpack_from("<Q", buf, off)[0]


def put_u64(buf, off, val):
    struct.pack_into("<Q", buf, off, val)


def put_u16(buf, off, val):
    struct.pack_into("<H", buf, off, val)


def walk(buf):
    """Yield ``(dg_addr, [cg_addr, ...])`` following the HD -> DG -> CG links."""
    dg = u64(buf, HD_ADDR + HD_FIRST_DG)
    while dg:
        cgs = []
        cg = u64(buf, dg + DG_FIRST_CG)
        while cg:
            cgs.append(cg)
            cg = u64(buf, cg + CG_NEXT_CG)
        yield dg, cgs
        dg = u64(buf, dg + DG_NEXT_DG)


def dt_records(buf, dg_addr, rec_size, cycles):
    addr = u64(buf, dg_addr + DG_DATA_BLOCK)
    assert buf[addr : addr + 4] == b"##DT", buf[addr : addr + 4]
    body = addr + BLOCK_DATA
    return [bytes(buf[body + i * rec_size : body + (i + 1) * rec_size]) for i in range(cycles)]


def make_unsorted(src: Path, dst: Path, rec_id_size: int = 1):
    """Fold every DG's channel group into DG0 and interleave the records.

    Records are prefixed with a ``rec_id_size``-byte little-endian record ID,
    which is what ``dg_rec_id_size > 0`` means in MDF4.  Returns the stored
    record-ID sequence so the caller can pin the demux order.
    """
    buf = bytearray(src.read_bytes())
    groups = list(walk(buf))
    assert all(len(cgs) == 1 for _dg, cgs in groups), "expect one CG per DG in the source"

    per_group = []
    for gi, (dg, (cg,)) in enumerate(groups):
        cycles = u64(buf, cg + CG_CYCLES_NR)
        sbn = struct.unpack_from("<I", buf, cg + CG_SAMPLES_BYTE_NR)[0]
        inval = struct.unpack_from("<I", buf, cg + CG_INVAL_BYTE_NR)[0]
        recs = dt_records(buf, dg, sbn + inval, cycles)
        # master channel is written first, at byte offset 0, as f64 seconds
        ts = [struct.unpack_from("<d", r, 0)[0] for r in recs]
        per_group.append({"gi": gi, "dg": dg, "cg": cg, "recs": recs, "ts": ts})

    merged = sorted(
        ((t, g["gi"], i, r) for g in per_group for i, (t, r) in enumerate(zip(g["ts"], g["recs"]))),
        key=lambda x: (x[0], x[1], x[2]),
    )

    id_fmt = {1: "<B", 2: "<H", 4: "<I", 8: "<Q"}[rec_id_size]
    stored_ids = []
    payload_buf = bytearray()
    for _t, gi, _i, rec in merged:
        rid = gi + 1
        stored_ids.append(rid)
        payload_buf += struct.pack(id_fmt, rid) + rec

    # append the new ##DT at EOF (8-byte aligned) and re-point DG0 at it
    while len(buf) % 8:
        buf += b"\0"
    new_dt = len(buf)
    buf += struct.pack("<4sI2Q", b"##DT", 0, BLOCK_DATA + len(payload_buf), 0) + payload_buf

    # the per-DG DT blocks are now orphaned: blank them so the fixture carries
    # no stale duplicate of the frame data (their addresses stay valid padding)
    for g in per_group:
        old_dt = u64(buf, g["dg"] + DG_DATA_BLOCK)
        old_len = u64(buf, old_dt + BLOCK_LEN)
        buf[old_dt + BLOCK_DATA : old_dt + old_len] = b"\0" * (old_len - BLOCK_DATA)
        put_u64(buf, old_dt + BLOCK_LEN, BLOCK_DATA)

    dg0 = groups[0][0]
    buf[dg0 + DG_RECORD_ID_LEN] = rec_id_size
    put_u64(buf, dg0 + DG_DATA_BLOCK, new_dt)
    put_u64(buf, dg0 + DG_NEXT_DG, 0)  # drop the other DGs from the chain
    for gi, (_dg, (cg,)) in enumerate(groups):
        put_u64(buf, cg + CG_RECORD_ID, gi + 1)
        nxt = groups[gi + 1][1][0] if gi + 1 < len(groups) else 0
        put_u64(buf, cg + CG_NEXT_CG, nxt)
    put_u64(buf, dg0 + DG_FIRST_CG, groups[0][1][0])

    dst.write_bytes(bytes(buf))
    return stored_ids, new_dt


def make_unfinalized(path: Path):
    """Leave CG cycle counts and the last DT block length unpatched."""
    buf = bytearray(path.read_bytes())
    buf[ID_FILE_IDENTIFICATION : ID_FILE_IDENTIFICATION + 8] = b"UnFinMF "
    put_u16(buf, ID_UNFIN_STD_FLAGS, FLAG_UNFIN_UPDATE_CG_COUNTER | FLAG_UNFIN_UPDATE_LAST_DT_LENGTH)
    put_u16(buf, ID_UNFIN_CUSTOM_FLAGS, 0)
    last_dt = 0
    for dg, cgs in walk(buf):
        for cg in cgs:
            put_u64(buf, cg + CG_CYCLES_NR, 0)
        last_dt = max(last_dt, u64(buf, dg + DG_DATA_BLOCK))
    # "update of length for last DT block required": header-only length
    put_u64(buf, last_dt + BLOCK_LEN, BLOCK_DATA)
    path.write_bytes(bytes(buf))


# --------------------------------------------------------------------------
# expected/ JSON
# --------------------------------------------------------------------------
def frame_json(idx, f):
    t = f["t_ns"] / 1e9
    return {
        "brs": f["brs"],
        "bus_channel": f["bus_channel"],
        "data_hex": f["data"].hex(),
        "data_length": f["data_length"],
        "dir": f["dir"],
        "dlc": f["dlc"],
        "edl": f["edl"],
        "esi": f["esi"],
        "id": f["id"],
        "ide": f["ide"],
        "index": idx,
        "t_abs_ns": START_NS + f["t_ns"],
        "t_ns": f["t_ns"],
        "t_raw": t,
        "t_raw_hex": "0x" + struct.pack("<d", t).hex(),
    }


def bus_group_json(index, prefix, frames, payload_bytes, fd, extra=()):
    dt = bus_dtype(prefix, payload_bytes, fd, extra)
    return {
        "acq_name": "CAN",
        "channels": ["time", prefix] + list(dt.names),
        "cycles": len(frames),
        "frame_type": prefix,
        "frames": [frame_json(i, f) for i, f in enumerate(frames)],
        "index": index,
        "kind": "bus",
        "payload_field_bytes": payload_bytes,
        # master (f64 seconds) at byte offset 0, then the frame struct
        "record_size": 8 + dt.itemsize,
    }


def signal_group_json(index, acq_name, sigs):
    return {
        "acq_name": acq_name,
        "channels": ["time"] + [s["name"] for s in sigs],
        "cycles": len(sigs[0]["samples"]),
        "index": index,
        "kind": "signal",
        "signals": [
            {
                "name": s["name"],
                "unit": s["unit"],
                "samples": [
                    {"t_abs_ns": START_NS + t, "t_ns": t, "value": v}
                    for t, v in zip(s["t_ns"], s["samples"])
                ],
            }
            for s in sigs
        ],
    }


def write_expected(name, doc):
    EXPECTED.mkdir(parents=True, exist_ok=True)
    (EXPECTED / f"{name}.json").write_text(
        json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def dbc_group_json(index, can_channel, msg_id, extended, sigs):
    """A per-message DBC-decoded signal group — the shape import must skip.

    A tool that decodes a capture with a DBC and saves the result writes one
    channel group per CAN message, its signals as plain channels, tagged with
    a bus source whose path names the frame it came from. Those signals are
    already implied by the raw bus group plus the project DBC, so importing
    them would double-count; the reader recognises them by this source path
    and skips the group.
    """
    ext = "True" if extended else "False"
    return {
        "acq_name": f"CAN{can_channel} message ID={msg_id:#x} EXT={ext}",
        "can_channel": can_channel,
        "channels": ["time"] + [s["name"] for s in sigs],
        "cycles": len(sigs[0]["samples"]),
        "extended": extended,
        "index": index,
        "kind": "dbc_decoded",
        "message_id": msg_id,
        "source_path": f"CAN{can_channel}.CAN_DataFrame.ID={msg_id:#x} EXT={ext}",
    }


def base_doc(name, *, sorted_, finalized, data_block, rec_id_size=0, unfin_flags=0,
             shape="logger"):
    return {
        "data_block": data_block,
        "dg_record_id_size": rec_id_size,
        "file": f"{name}.mf4",
        "finalized": finalized,
        "fixture": name,
        "hd_dst_offset_min": 0,
        "hd_start_time_ns": START_NS,
        "hd_time_flags": 2,
        "hd_tz_offset_min": 0,
        "id_unfin_flags": unfin_flags,
        "mdf_version": "4.10",
        # "logger" = at least one raw bus-logging group, so the file imports.
        # "signal_file" = pre-decoded channels only, which import must reject
        # rather than read as an empty capture.
        "shape": shape,
        "sorted": sorted_,
        "timestamp_rule": "master channel is f64 seconds; t_abs_ns = hd_start_time_ns + round(t_raw * 1e9)",
    }


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------
def gen_sorted_classic():
    name = "sorted_finalized_classic"
    frames = classic_frames(60, bus=1, base_ns=0, step_ns=2_000_000, seed0=3)
    m = new_mdf()
    m.append([bus_signal(frames)], acq_name="CAN")
    m.save(OUT / f"{name}.mf4", overwrite=True)
    m.close()
    doc = base_doc(name, sorted_=True, finalized=True, data_block="DT")
    doc["groups"] = [bus_group_json(0, "CAN_DataFrame", frames, 8, False)]
    write_expected(name, doc)
    return frames


def gen_sorted_fd():
    name = "sorted_finalized_fd"
    frames = fd_frames(40, bus=2, base_ns=1_000_000, step_ns=5_000_000, seed0=11)
    m = new_mdf()
    m.append([bus_signal(frames, payload_bytes=64, fd=True)], acq_name="CAN")
    m.save(OUT / f"{name}.mf4", overwrite=True)
    m.close()
    doc = base_doc(name, sorted_=True, finalized=True, data_block="DT")
    doc["groups"] = [bus_group_json(0, "CAN_DataFrame", frames, 64, True)]
    write_expected(name, doc)


def gen_sorted_dz(frames):
    name = "sorted_finalized_dz"
    m = new_mdf()
    m.append([bus_signal(frames)], acq_name="CAN")
    m.save(OUT / f"{name}.mf4", overwrite=True, compression=1)
    m.close()
    doc = base_doc(name, sorted_=True, finalized=True, data_block="DZ")
    doc["dz_zip_type"] = 0  # 0 = deflate, 1 = transposition + deflate
    doc["dz_original_type"] = "DT"
    doc["groups"] = [bus_group_json(0, "CAN_DataFrame", frames, 8, False)]
    write_expected(name, doc)


def gen_unsorted():
    frames_a = classic_frames(30, bus=1, base_ns=0, step_ns=4_000_000, seed0=21)
    frames_b = classic_frames(25, bus=2, base_ns=1_000_000, step_ns=5_000_000, seed0=57)
    TMP.mkdir(parents=True, exist_ok=True)
    src = TMP / "unsorted_src.mf4"
    m = new_mdf()
    m.append([bus_signal(frames_a)], acq_name="CAN")
    m.append([bus_signal(frames_b)], acq_name="CAN")
    m.save(src, overwrite=True)
    m.close()

    name = "unsorted_finalized_classic"
    stored_ids, _ = make_unsorted(src, OUT / f"{name}.mf4", rec_id_size=1)
    doc = base_doc(name, sorted_=False, finalized=True, data_block="DT", rec_id_size=1)
    doc["stored_record_ids"] = stored_ids
    doc["groups"] = [
        dict(bus_group_json(0, "CAN_DataFrame", frames_a, 8, False), record_id=1),
        dict(bus_group_json(1, "CAN_DataFrame", frames_b, 8, False), record_id=2),
    ]
    write_expected(name, doc)

    name = "unsorted_unfinalized_classic"
    unfin = OUT / f"{name}.mf4"
    shutil.copyfile(OUT / "unsorted_finalized_classic.mf4", unfin)
    make_unfinalized(unfin)
    flags = FLAG_UNFIN_UPDATE_CG_COUNTER | FLAG_UNFIN_UPDATE_LAST_DT_LENGTH
    doc = base_doc(name, sorted_=False, finalized=False, data_block="DT", rec_id_size=1, unfin_flags=flags)
    doc["file_identification"] = "UnFinMF "
    doc["stored_cg_cycle_count"] = 0
    doc["stored_last_dt_block_len"] = 24
    doc["stored_record_ids"] = stored_ids
    doc["recovery_rule"] = (
        "cycle counts must be recovered by scanning the DT payload to EOF; "
        "the last DT block_len is a header-only 24 and must be taken as (file_size - dt_addr)"
    )
    doc["groups"] = [
        dict(bus_group_json(0, "CAN_DataFrame", frames_a, 8, False), record_id=1),
        dict(bus_group_json(1, "CAN_DataFrame", frames_b, 8, False), record_id=2),
    ]
    write_expected(name, doc)


def gen_mixed():
    name = "sorted_finalized_mixed"
    frames = classic_frames(24, bus=1, base_ns=0, step_ns=10_000_000, seed0=5)
    n = 20
    t_ns = [i * 12_000_000 for i in range(n)]
    t = np.array(t_ns, dtype="i8") / 1e9
    rpm = [800.0 + 12.5 * i for i in range(n)]
    temp = [70 + i for i in range(n)]
    m = new_mdf()
    m.append([bus_signal(frames)], acq_name="CAN")
    m.append(
        [
            Signal(np.array(rpm, dtype="f8"), t, name="EngineSpeed", unit="rpm"),
            Signal(np.array(temp, dtype="<i2"), t, name="CoolantTemp", unit="degC"),
        ],
        acq_name="Analog",
    )
    m.save(OUT / f"{name}.mf4", overwrite=True)
    m.close()
    doc = base_doc(name, sorted_=True, finalized=True, data_block="DT")
    doc["groups"] = [
        bus_group_json(0, "CAN_DataFrame", frames, 8, False),
        signal_group_json(
            1,
            "Analog",
            [
                {"name": "EngineSpeed", "unit": "rpm", "t_ns": t_ns, "samples": rpm},
                {"name": "CoolantTemp", "unit": "degC", "t_ns": t_ns, "samples": temp},
            ],
        ),
    ]
    write_expected(name, doc)


def gen_error_remote():
    name = "sorted_finalized_errorremote"
    data = classic_frames(20, bus=1, base_ns=0, step_ns=6_000_000, seed0=31)
    err = classic_frames(6, bus=1, base_ns=3_000_000, step_ns=25_000_000, seed0=71)
    for i, f in enumerate(err):
        f["ErrorType"] = (i % 6) + 1
    rem = classic_frames(8, bus=1, base_ns=2_000_000, step_ns=17_000_000, seed0=91)
    for f in rem:
        f["data"] = b""
        f["data_length"] = 0

    m = new_mdf()
    m.append([bus_signal(data)], acq_name="CAN")
    m.append([bus_signal(err, prefix="CAN_ErrorFrame", extra=("ErrorType",))], acq_name="CAN")
    m.append([bus_signal(rem, prefix="CAN_RemoteFrame")], acq_name="CAN")
    m.save(OUT / f"{name}.mf4", overwrite=True)
    m.close()

    doc = base_doc(name, sorted_=True, finalized=True, data_block="DT")
    g1 = bus_group_json(1, "CAN_ErrorFrame", err, 8, False, extra=("ErrorType",))
    for fj, f in zip(g1["frames"], err):
        fj["error_type"] = f["ErrorType"]
    doc["groups"] = [
        bus_group_json(0, "CAN_DataFrame", data, 8, False),
        g1,
        bus_group_json(2, "CAN_RemoteFrame", rem, 8, False),
    ]
    write_expected(name, doc)


def ramp(n, start, step):
    return [start + step * i for i in range(n)]


CG_FLAG_BUS_EVENT = 0x2


def set_bus_event_flag(path: Path, group_indices):
    """Set ``cg_flags`` bit 1 (bus event) on the listed channel groups.

    A tool that writes DBC-decoded signal groups marks them as bus events
    without the "plain bus event" bit 2 that raw frame groups carry, which is
    how a real capture distinguishes the two. asammdf leaves ``cg_flags`` at 0
    for an ordinary signal group, so the byte is patched here to match what
    the reader meets in the field.
    """
    buf = bytearray(path.read_bytes())
    flat = [cg for _dg, cgs in walk(buf) for cg in cgs]
    for gi in group_indices:
        put_u16(buf, flat[gi] + CG_FLAGS, CG_FLAG_BUS_EVENT)
    path.write_bytes(bytes(buf))


def gen_dbc_decoded():
    """A logger file that *also* carries per-message DBC-decoded groups."""
    name = "sorted_finalized_dbcdecoded"
    frames = classic_frames(18, bus=1, base_ns=0, step_ns=8_000_000, seed0=13)
    n = 15
    t_ns = [i * 9_000_000 for i in range(n)]
    t = np.array(t_ns, dtype="i8") / 1e9
    speed = ramp(n, 1000.0, 25.0)
    gear = ramp(n, 1, 1)
    level = ramp(n, 5.0, 2.5)

    m = new_mdf()
    m.append([bus_signal(frames)], acq_name="CAN")
    for msg_id, ext, sigs in (
        (0x100, False, [("VehSpeed", "km/h", "f8", speed), ("GearPos", "", "<u1", gear)]),
        (0x1A5, False, [("TankLevel", "%", "f8", level)]),
    ):
        ext_s = "True" if ext else "False"
        src = Source(
            f"CAN1 message ID={msg_id:#x} EXT={ext_s}",
            f"CAN1.CAN_DataFrame.ID={msg_id:#x} EXT={ext_s}",
            "",
            Source.SOURCE_BUS,
            Source.BUS_TYPE_CAN,
        )
        m.append(
            [
                Signal(np.array(vals, dtype=dtype), t, name=sname, unit=unit, source=src)
                for sname, unit, dtype, vals in sigs
            ],
            acq_name=f"CAN1 message ID={msg_id:#x} EXT={ext_s}",
            acq_source=src,
        )
    m.save(OUT / f"{name}.mf4", overwrite=True)
    m.close()
    set_bus_event_flag(OUT / f"{name}.mf4", [1, 2])

    doc = base_doc(name, sorted_=True, finalized=True, data_block="DT")
    doc["groups"] = [
        bus_group_json(0, "CAN_DataFrame", frames, 8, False),
        dbc_group_json(1, 1, 0x100, False, [
            {"name": "VehSpeed", "unit": "km/h", "t_ns": t_ns, "samples": speed},
            {"name": "GearPos", "unit": "", "t_ns": t_ns, "samples": gear},
        ]),
        dbc_group_json(2, 1, 0x1A5, False, [
            {"name": "TankLevel", "unit": "%", "t_ns": t_ns, "samples": level},
        ]),
    ]
    write_expected(name, doc)


def gen_signal_only():
    """The signal-file shape: pre-decoded channels, no bus-logging group."""
    name = "signal_only"
    n = 24
    t_ns = [i * 20_000_000 for i in range(n)]
    t = np.array(t_ns, dtype="i8") / 1e9
    torque = ramp(n, -50.0, 7.5)
    state = ramp(n, 0, 1)
    volts = ramp(n, 11.8, 0.05)

    m = new_mdf()
    m.append(
        [
            Signal(np.array(torque, dtype="f8"), t, name="AxleTorque", unit="Nm"),
            Signal(np.array(state, dtype="<u2"), t, name="DriveState", unit=""),
        ],
        acq_name="Powertrain",
    )
    m.append(
        [Signal(np.array(volts, dtype="f8"), t, name="BatteryVolts", unit="V")],
        acq_name="Electrical",
    )
    m.save(OUT / f"{name}.mf4", overwrite=True)
    m.close()

    doc = base_doc(name, sorted_=True, finalized=True, data_block="DT", shape="signal_file")
    doc["groups"] = [
        signal_group_json(0, "Powertrain", [
            {"name": "AxleTorque", "unit": "Nm", "t_ns": t_ns, "samples": torque},
            {"name": "DriveState", "unit": "", "t_ns": t_ns, "samples": state},
        ]),
        signal_group_json(1, "Electrical", [
            {"name": "BatteryVolts", "unit": "V", "t_ns": t_ns, "samples": volts},
        ]),
    ]
    write_expected(name, doc)


# --------------------------------------------------------------------------
# verification
# --------------------------------------------------------------------------
def verify(name):
    path = OUT / f"{name}.mf4"
    doc = json.loads((EXPECTED / f"{name}.json").read_text())
    raw = path.read_bytes()
    problems = []

    unfin = struct.unpack_from("<H", raw, ID_UNFIN_STD_FLAGS)[0]
    if unfin != doc["id_unfin_flags"]:
        problems.append(f"id_unfin_flags {unfin:#x} != {doc['id_unfin_flags']:#x}")

    m = MDF(path)
    if m.header.abs_time != doc["hd_start_time_ns"]:
        problems.append(f"abs_time {m.header.abs_time} != {doc['hd_start_time_ns']}")
    for g in doc["groups"]:
        gi = g["index"]
        grp = m.groups[gi]
        if grp.channel_group.cycles_nr != g["cycles"]:
            problems.append(f"g{gi} cycles {grp.channel_group.cycles_nr} != {g['cycles']}")
        got = [c.name for c in grp.channels]
        if got != g["channels"]:
            problems.append(f"g{gi} channels {got} != {g['channels']}")
        if "record_size" in g:
            rs = grp.channel_group.samples_byte_nr + grp.channel_group.invalidation_bytes_nr
            if rs != g["record_size"]:
                problems.append(f"g{gi} record_size {rs} != {g['record_size']}")
        if g["kind"] == "bus":
            p = g["frame_type"]
            scalars = {
                "bus_channel": "BusChannel",
                "ide": "IDE",
                "dir": "Dir",
                "error_type": "ErrorType",
                "edl": "EDL",
                "brs": "BRS",
                "esi": "ESI",
            }
            for key, ch in scalars.items():
                if f"{p}.{ch}" not in g["channels"]:
                    continue
                vals = m.get(f"{p}.{ch}", group=gi).samples
                for fr in g["frames"]:
                    if int(vals[fr["index"]]) != fr[key]:
                        problems.append(f"g{gi} f{fr['index']} {ch} {int(vals[fr['index']])} != {fr[key]}")
                        break
            ids = m.get(f"{p}.ID", group=gi).samples
            dlc = m.get(f"{p}.DLC", group=gi).samples
            dl = m.get(f"{p}.DataLength", group=gi).samples
            db = m.get(f"{p}.DataBytes", group=gi).samples
            ts = m.get(f"{p}.ID", group=gi).timestamps
            for fr in g["frames"]:
                i = fr["index"]
                if int(ids[i]) != fr["id"]:
                    problems.append(f"g{gi} f{i} id {int(ids[i])} != {fr['id']}")
                if int(dlc[i]) != fr["dlc"]:
                    problems.append(f"g{gi} f{i} dlc {int(dlc[i])} != {fr['dlc']}")
                if int(dl[i]) != fr["data_length"]:
                    problems.append(f"g{gi} f{i} datalength {int(dl[i])} != {fr['data_length']}")
                got_hex = bytes(db[i][: fr["data_length"]]).hex()
                if got_hex != fr["data_hex"]:
                    problems.append(f"g{gi} f{i} data {got_hex} != {fr['data_hex']}")
                if round(float(ts[i]) * 1e9) != fr["t_ns"]:
                    problems.append(f"g{gi} f{i} t {float(ts[i])} != {fr['t_ns']}")
        elif g["kind"] == "dbc_decoded":
            src = grp.channel_group.acq_source
            if src is None or src.path != g["source_path"]:
                problems.append(f"g{gi} source path {src and src.path!r} != {g['source_path']!r}")
            elif src.source_type != 2 or src.bus_type != 2:
                problems.append(f"g{gi} source type/bus {src.source_type}/{src.bus_type} != 2/2")
            # bus-event bit set, plain-bus-event bit clear: this group holds
            # decoded signals, not raw frames
            if grp.channel_group.flags & 0x6 != 0x2:
                problems.append(f"g{gi} cg_flags {grp.channel_group.flags:#x} != 0x2")
        else:
            for s in g["signals"]:
                sig = m.get(s["name"], group=gi)
                if sig.unit != s["unit"]:
                    problems.append(f"g{gi} {s['name']} unit {sig.unit!r} != {s['unit']!r}")
                for k, smp in enumerate(s["samples"]):
                    if float(sig.samples[k]) != float(smp["value"]):
                        problems.append(f"g{gi} {s['name']}[{k}] {sig.samples[k]} != {smp['value']}")
                    if round(float(sig.timestamps[k]) * 1e9) != smp["t_ns"]:
                        problems.append(f"g{gi} {s['name']}[{k}] t mismatch")
    m.close()

    if doc["data_block"] == "DZ":
        if raw.count(b"##DZ") == 0 or raw.count(b"##DT") != 0:
            problems.append(f"expected DZ-only, got DZ={raw.count(b'##DZ')} DT={raw.count(b'##DT')}")
        off = raw.find(b"##DZ")
        # ##DZ: id(0) reserved(4) block_len(8) links_nr(16) orig_type(24,2s)
        #       zip_type(26,u8) reserved(27) param(28,u32) orig_size(32) zip_size(40)
        orig_type, zip_type = struct.unpack_from("<2sB", raw, off + 24)
        if zip_type != doc["dz_zip_type"] or orig_type.decode() != doc["dz_original_type"]:
            problems.append(f"DZ zip_type={zip_type} orig_type={orig_type!r}")
    if doc["dg_record_id_size"]:
        buf = bytearray(raw)
        (dg0, cgs), *rest = list(walk(buf))
        assert not rest, "unsorted fixture must expose a single DG"
        sizes = {
            u64(buf, cg + CG_RECORD_ID): (
                struct.unpack_from("<I", buf, cg + CG_SAMPLES_BYTE_NR)[0]
                + struct.unpack_from("<I", buf, cg + CG_INVAL_BYTE_NR)[0]
            )
            for cg in cgs
        }
        dt = u64(buf, dg0 + DG_DATA_BLOCK)
        rs = doc["dg_record_id_size"]
        got = []
        pos = dt + BLOCK_DATA
        n = sum(g["cycles"] for g in doc["groups"])
        for _ in range(n):
            rid = int.from_bytes(raw[pos : pos + rs], "little")
            got.append(rid)
            pos += rs + sizes[rid]
        if got != doc["stored_record_ids"]:
            problems.append("stored record-ID sequence mismatch")
    return problems


def describe(name):
    path = OUT / f"{name}.mf4"
    raw = path.read_bytes()
    m = MDF(path)
    ngroups = len(m.groups)
    cycles = sum(g.channel_group.cycles_nr for g in m.groups)
    m.close()
    buf = bytearray(raw)
    dg0 = u64(buf, HD_ADDR + HD_FIRST_DG)
    rid_size = buf[dg0 + DG_RECORD_ID_LEN]
    return {
        "file": path.name,
        "size": len(raw),
        "groups": ngroups,
        "cycles": cycles,
        "rec_id_size": rid_size,
        "unfin_flags": struct.unpack_from("<H", raw, ID_UNFIN_STD_FLAGS)[0],
        "dt": raw.count(b"##DT"),
        "dz": raw.count(b"##DZ"),
    }


def main():
    EXPECTED.mkdir(parents=True, exist_ok=True)
    classic = gen_sorted_classic()
    gen_sorted_fd()
    gen_sorted_dz(classic)
    gen_unsorted()
    gen_mixed()
    gen_error_remote()
    gen_dbc_decoded()
    gen_signal_only()
    shutil.rmtree(TMP, ignore_errors=True)

    names = [
        "sorted_finalized_classic",
        "sorted_finalized_fd",
        "sorted_finalized_dz",
        "unsorted_finalized_classic",
        "unsorted_unfinalized_classic",
        "sorted_finalized_mixed",
        "sorted_finalized_errorremote",
        "sorted_finalized_dbcdecoded",
        "signal_only",
    ]
    failed = 0
    for n in names:
        info = describe(n)
        problems = verify(n)
        status = "OK" if not problems else f"FAIL ({len(problems)})"
        print(
            f"{info['file']:<36} {info['size']:>7}B groups={info['groups']} cycles={info['cycles']:>3} "
            f"recid={info['rec_id_size']} unfin={info['unfin_flags']:#04x} "
            f"DT={info['dt']} DZ={info['dz']}  {status}"
        )
        for p in problems[:6]:
            print("    !", p)
        failed += bool(problems)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
