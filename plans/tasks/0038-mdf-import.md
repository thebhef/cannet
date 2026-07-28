# Task 38 — MDF (MF4) Logger-File Import

Read ASAM MDF 4.x **bus-logging** files as a capture import alongside
BLF. Target the logger-file shape (raw `CAN_DataFrame` bus events, as
written by CSS Electronics CANedge, Vector loggers, python-can): frames
in, decoded with the project DBCs — exactly the BLF import flow. The
existing `CanFrameSource` seam absorbs this without model changes.

## Background

MDF 4.x is a linked graph of typed blocks (HD → DG → CG → CN). A
channel group (CG) defines a fixed record layout with a master time
channel; a **sorted** file supports binary search on the time axis —
a better fit for the paged-view architecture than BLF's flat object
stream. The MDF ≥4.1 "bus logging" associated standard stores raw
traffic as structure channels (`CAN_DataFrame.ID/.DLC/.DataBytes` plus
FD flags `.EDL/.BRS/.ESI`, and `CAN_RemoteFrame`/`CAN_ErrorFrame`
groups).

Two very different content shapes hide behind one `.mf4` extension:

| Shape | Content | This task |
| --- | --- | --- |
| Logger file (CANedge, Vector loggers) | raw bus events; DBC decode applies | **in scope** |
| Signal file (CANape / post-processed) | pre-decoded per-signal channels with conversions/units; no frames | **out of scope** (detect and reject with a clear message) |

Known wrinkles:

- CANedge writes **unsorted, unfinalized** MDF 4.11 (power-loss-safe
  append; block counts/links unpatched). Import must finalize + sort
  (in memory or via a preprocessing pass) before random access.
- Version target: read 4.0–4.2 with 4.1 as the focus; 3.x is legacy
  calibration territory, not CAN capture — out of scope.
- Timestamps: CG master channel is seconds relative to the HD start
  time; the adapter re-absolutizes to `timestamp_ns`, same as the BLF
  adapter does ([ADR 0024](../../docs/adr/0024-trace-like-view-timing.md)).
- Bus mapping: `CAN_DataFrame.BusChannel` plays the role BLF channel
  numbers play; reuse the channel→bus mapping dialog and persistence
  ([ADR 0023](../../docs/adr/0023-logical-bus-vs-interface.md)).

## Library decision (blocking prerequisite)

No Rust MDF crate is battle-hardened yet. Run the evaluate-dependency
process (per the [ADR 0009](../../docs/adr/0009-dbc-blf-readers.md)
pattern) before writing code, against real fixtures from CANedge,
CANape/Vector, and asammdf:

- **`mdf4-rs`** — MIT/Apache-2.0, pure Rust, bus-logging + DBC aware,
  active; but young (0.x, small org).
- **`mdflib` (ihedvall) via FFI** — MIT, the mature open C++ reference
  (reads/writes 3.x–4.2 incl. bus logging); costs a C++ toolchain in
  the build.
- Rejected up front: `mdfr` (GPL-3), `asammdf`-rs / `mdf4` crates
  (single-release / abandoned).

Oracles for validation, whatever is chosen: Python **asammdf**
(LGPL, the ecosystem reference — also generates fixtures), Vector's
free MDF Validator, and the public spec + ASAM wiki. Record the
outcome in `technology-inventory.md`.

## Later (not this task)

- **MF4 export.** MDF is vendor-neutral and read by every major tool
  chain; also better equipped than BLF for
  [ADR 0010](../../docs/adr/0010-no-sidecar-files.md) — AT attachment
  blocks are a sanctioned in-file embedding mechanism (DBC-in-logfile
  is standard practice from 4.10), MD blocks carry custom XML.
- Signal-file (pre-decoded) import.
- LIN/FlexRay/Ethernet bus-event groups (`LIN_Frame`, `ETH_Frame` …) —
  blocked on the multi-protocol model
  ([Task 39](0039-ethernet-signals.md)).

## Exit criteria

- Dependency decision recorded in `technology-inventory.md` (evaluated
  against CANedge + CANape + asammdf fixtures).
- A new crate implements `CanFrameSource` over MDF 4.x bus-logging
  files: sorted and unsorted, finalized and unfinalized, classic CAN +
  CAN FD, remote/error frames, DZ-compressed data blocks.
- `import_mdf` GUI command with channel scan + channel→bus mapping,
  mirroring `import_blf` / `scan_blf_channels`.
- Signal-shape MF4 files are detected and rejected with a clear
  message (not misread as empty captures).
- Timestamps land absolute per ADR 0024; fixture round-trip asserts
  frame-accurate times against an asammdf-decoded reference.
- README + technology-inventory updated; rustdoc on the new crate root.
