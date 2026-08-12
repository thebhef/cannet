# Task 38 — MDF (MF4) Import and Export

Read **and write** ASAM MDF 4.x bus-logging files, so MDF
**round-trips**: a capture read in can be written back out.

Import: target the logger-file shape (raw `CAN_DataFrame` bus events,
as written by CSS Electronics CANedge, Vector loggers, python-can):
frames in, decoded with the project DBCs — exactly the BLF import
flow. The existing `CanFrameSource` seam absorbs this without model
changes.

Export: write a capture back out as MDF 4.x. Why MDF as the export
format: vendor-neutral and read by every major toolchain, and better
equipped than BLF for
[ADR 0010](../../docs/adr/0010-no-sidecar-files.md) — AT attachment
blocks are a sanctioned in-file embedding mechanism (DBC-in-logfile
is standard practice from 4.10), and MD blocks carry custom XML.

## Grooming notes

- **2026-08-12 — import and export are one task (owner).** Excluding
  write from this task didn't make sense; one exit-criteria set
  including round-trip.
- **2026-08-12 — one evaluate-dependency pass for read + write
  (owner).** Write capability is a first-class eval criterion
  alongside read (write → re-read → asammdf-validate on the same
  fixtures); outcome is one library for both, or an explicit
  two-library split, recorded in `technology-inventory.md`.
  Selection weight still favors read (import lands first): reads
  excellently + writes adequately beats the reverse.
- **2026-08-12 — export writes what the model holds (owner).** Raw
  frames as bus-logging channel groups **and** message-independent
  signals as their own signal channel groups — the true inverse of
  import. Not written: DBC-decoded signals as channels (that's
  measurement export, out of scope). The project DBC rides along as
  an AT attachment (ADR 0010's in-file embedding, standard from
  MDF 4.10).
- **2026-08-12 — asammdf is a dev/CI-time oracle, not a runtime
  dependency.** A uv-run script generates the committed synthetic
  fixtures (sorted/unsorted × finalized/unfinalized × classic/FD ×
  DZ) plus expected-decode JSON; the default Rust suite compares
  against committed expectations, Python-free. Round-trip validation
  (asammdf re-reads our exports) runs as an isolated integration
  check in the Linux CI job. User-provided MDF data stays out of the
  repo; it serves the eval and manual verification only.

## Model gap: message-independent signals

Example MDF data is available from a user (kept out of the repo, like
all user-provided example data) that includes **message-independent
signals** — MDF records signal channels directly in a channel group,
with no bus message carrying them. Our model has no such concept yet:
every signal hangs off a DBC message. It should by the time this
task is done.

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
pattern) before writing code — covering **read and write** per the
grooming note above — against real fixtures from CANedge,
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

- **2026-08-12 — message-independent signals: one model, provenance
  decides the fill (owner).** Every signal is a `SignalCache` entry
  (series + resolution pyramid, paged serve); **decode provenance**
  says how it fills. DBC-backed entries fill by decoding frames on
  catch-up and keep their `(message, bus)` link accessible where
  needed; file-backed entries fill from the imported signal channel
  group — a one-time read that completes — and have no message link.
  Same store, serve path, and pyramid persistence for both. Addition:
  file-backed level-0 series persist under the capture's spill dir
  beside the frames (the source file plays the role frames play for
  rebuild). Views: file-backed signals appear in series-shaped
  surfaces (catalog, plot, signal grid) marked by source; trace views
  are untouched (no frames to show); DBC reload never touches them.
- **2026-08-12 — export by provenance.** DBC-backed signals export
  as their frames + the DBC as AT attachment (re-import re-decodes
  identically); file-backed signals export verbatim as signal
  channel groups. BLF save (`save_capture`) carries frames only —
  file-backed signals do not survive it; the BLF save path warns
  when the capture contains file-backed signals it is about to drop.
  MDF is the full-fidelity save.

- **2026-08-12 — one save gesture, format picked in the dialog
  (owner).** `capture.save` stays the single command; the save
  dialog's filter list grows "ASAM MDF (`.mf4`)" beside "Vector BLF
  (`.blf`)"; the chosen filter reaches the host as an explicit format
  parameter (never sniffed from the path) and one host command routes
  to the BLF or MDF writer. The dropped-file-backed-signals warning
  fires when BLF is chosen.

- **2026-08-12 — round-trip fidelity contract (owner).** Import →
  export → re-import preserves exactly: frame content (id + extended,
  payload, DLC, FD flags EDL/BRS/ESI, remote/error frames);
  frame-accurate absolute timestamps (ADR 0024 — exported HD start +
  per-frame offsets reproduce the original nanoseconds); bus mapping
  by the BLF rule (ordered project bus list ↔ `BusChannel` 1:1);
  trace event markers ↔ MDF EV blocks including time and text; and
  file-backed signal series + name/unit/conversion metadata verbatim.
  Allowed to differ: physical block layout, sortedness/finalization
  (we always write sorted + finalized), compression, writer-tool
  metadata. Verified by the asammdf-oracle integration check.

## Later (not this task)

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
- Export: a capture written to MDF 4.x, validated by asammdf and
  Vector's MDF Validator; import → export round-trip preserves what
  the grooming pass pins as fidelity-critical.
- Message-independent signals exist in the model (shape per
  grooming) and survive the round-trip.
- README + technology-inventory updated; rustdoc on the new crate root.
