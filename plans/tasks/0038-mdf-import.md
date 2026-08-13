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

## Library decision (resolved)

**2026-08-12 — eval verdict.** The evaluate-dependency pass
(per the [ADR 0009](../../docs/adr/0009-dbc-blf-readers.md) pattern)
ran against a user-provided logger corpus and a synthetic
asammdf-generated fixture matrix, with Python asammdf as the oracle.
Outcome is an **explicit read/write split**, recorded in
`technology-inventory.md`:

- **Read: `mdf4-rs` 0.6, adopted** — for its block layer, record
  iteration, record-ID demultiplexing, unfinalized-file recovery and
  CC conversion handling, all of which matched the oracle exactly.
- **Bus-logging composition: ours** — mdf4-rs never follows the
  `##CN` `component_addr` link, so it exposes no
  `CAN_DataFrame.ID`/`.DLC`/`.DataBytes` sub-channels and yields no
  frames on its own. It exposes the link, the parent record slice,
  the mmap and the block parsers, so the layer that walks the
  composition and slices sub-fields is a thin piece of cannet code.
  A spike of it decoded byte-identically to asammdf.
- **Write: ours** — mdf4-rs's bus-logging writer emits a proprietary
  opaque-byte-array layout that asammdf does not recognise as CAN bus
  logging. Its *block serializers* do write `component_addr`, so the
  cannet writer builds conformant composition on top of them.
- **`mdflib` via FFI: rejected** — cmake + a C++ compiler + external
  zlib/expat (vcpkg on Windows) on every machine and CI runner, for a
  ~4.6k-LOC, ~326-`unsafe`-site binding its author calls a proof of
  concept, which does not expose the CAN FD flags the round-trip
  contract requires.

Two consequences the implementation must carry:

- **DZ-compressed data blocks do not read.** mdf4-rs has `DzBlock`
  and `decompress()` behind its `compression` feature, but its
  data-block resolver accepts only `##DT`/`##DV`/`##DL`/`##HL` and
  errors on `##DZ`. CANedge writes DZ and the exit criteria require
  it. Close it upstream, or with an in-repo decompress pre-pass —
  the crate offers only `from_file`, no from-bytes constructor.
- **MSRV.** mdf4-rs 0.6 declares rustc 1.97.0; `rust-toolchain.toml`
  pins 1.96.0. Adopting it means bumping the pin deliberately,
  fixing any new clippy lints in the same change.

Oracles for validation: Python **asammdf** (LGPL, the ecosystem
reference — also generates the fixtures), Vector's free MDF
Validator, and the public spec + ASAM wiki.

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

## A third content shape: DBC-decoded per-message groups

The two-shape table above (logger file vs signal file) turned out to
be incomplete. The user-provided corpus holds **all three shapes in
every file**:

1. a raw `CAN_DataFrame` bus-logging group (plus empty
   `CAN_ErrorFrame` / `CAN_RemoteFrame` groups),
2. message-independent signal channel groups — the model gap above,
3. **DBC-decoded per-message signal groups**: one channel group per
   CAN message ID, carrying that message's decoded signals as plain
   channels, with a bus source whose path reads
   `CAN<n>.CAN_DataFrame.ID=0x<id> EXT=<bool>`.

Shape 3 is what a tool writes when it decodes a capture with a DBC
and saves the result — the thing "export by provenance" deliberately
does *not* write. Import has to decide what to do with it: the frames
in shape 1 already carry the same information, so decoding shape 3
would double-count every signal. Treating it as file-backed signal
data would also double-count. The cheap, honest answer is to
recognise shape 3 by its source path and **skip it**, since shape 1
plus the project DBC reproduces it — but that is a decision this task
still owes an answer to.

## Status log

### 2026-08-12 — phase 1: library evaluation and fixture groundwork

Evaluate-dependency pass covering read and write. Verdict and its
rationale are in "Library decision (resolved)" above and in
`technology-inventory.md`; the numbers behind it:

- **Survey.** `mdf4-rs` is at 0.6.0 (2026-07-20, ~2.4k downloads,
  MIT/Apache-2.0). A binding crate for ihedvall's `mdflib` now exists
  (`mdflib` 0.2.1 / `mdflib-sys` 0.2.2, first published 2026-02) —
  it did not when this task was written, so it was evaluated too.
  `mdf4` and `asammdf` remain single-release and abandoned; `mdfr`
  is not on crates.io.
- **User corpus** (kept out of the repo): 14 MDF 4.10 files, all
  finalized, all sorted, all uncompressed `##DT`, classic CAN only,
  no EV or AT blocks. 7.6k–22k frames each.
- **Read, signal channel groups.** mdf4-rs vs asammdf across all 14
  files: 3,731 channel rows compared (name, unit, sample count,
  series sum, leading samples), **0 discrepancies** — the only two
  differing rows were a 1-ULP difference in the comparison harness's
  own summation.
- **Read, bus-logging groups.** mdf4-rs alone: **0 of 14** files
  yielded frames — it reports the group as just `time` +
  `CAN_DataFrame` because it never follows `cn_composition`. With
  the in-repo composition layer spiked on top: **14 of 14** files
  matched asammdf on frame count and on a SHA-256 over every frame's
  id, extended flag, DLC, bus channel and payload bytes.
- **Read, wrinkle matrix.** Against 7 synthetic fixtures, checked
  against independently generated expected-decode JSON:
  classic, CAN FD (DLC→64-byte payloads, EDL/BRS/ESI), error and
  remote frames, mixed bus-plus-signal, unsorted
  (`dg_rec_id_size`=1, two channel groups per data group), and
  unsorted-plus-unfinalized (`"UnFinMF "`, `id_unfin_flags`=0x5) all
  **matched exactly** — the unfinalized file produced hashes
  identical to its finalized twin. **DZ failed**: `BlockIDError`,
  actual `##DZ`, expected `##DT / ##DV / ##DL / ##HL`.
- **Write.** mdf4-rs's raw CAN logger wrote a 25-frame file. asammdf
  opens it but its bus-logging map is **empty**: the output is two
  groups split by IDE, each record a single opaque 13-byte
  `CAN_DataFrame` byte array with no composition, `cg_flags`=0x0
  (bus-event bit unset). Not interoperable — hence the writer is
  ours.
- **`mdflib` cost, measured not assumed.** Neither cmake nor vcpkg is
  present on the reference dev machine; `mdflib-sys`'s build script
  requires both (plus zlib and expat via `find_package(REQUIRED)`).
  The binding exposes id/dlc/data/bus-channel/timestamp but **no
  `EDL`/`BRS`/`ESI`**, though the underlying C++ has them.

Block-layout facts pinned for the reader implementation (verified
against the fixtures, since two of them were initially recorded
wrong): the ID block's `id_unfin_flags` is a `u16` at **file offset
60** (not 24), and `hd_start_time_ns` is a `u64` at **block-relative
offset 72** — 24 bytes of header plus six links. Unsorted records are
a `dg_rec_id_size`-byte little-endian record ID followed by
`cg_data_bytes + cg_inval_bytes` of payload. In a bus-logging group
the parent `##CN` is a byte-array channel spanning the whole
structure and the sub-channels **overlay** it at their own byte
offsets — a reader must not count both.

**Fixture generator** (built in scratch, lands in the repo next
phase): ~600 lines of Python driven by `uv run --with asammdf`,
emitting 7 fixtures of 3.6–8 KB each plus one expected-decode JSON
per fixture. asammdf writes the sorted/finalized ones directly — the
trick for canonical channel names is to name the numpy structured
array's fields `CAN_DataFrame.ID` and so on, since asammdf writes one
`##CN` per field using the field name verbatim; a bus `Source` is
what sets `cg_flags`=0x6 and the bus-event channel flag. asammdf
cannot write unsorted or unfinalized files, so the generator
post-processes bytes for those. Expected JSON carries timestamps as
integer nanoseconds plus the exact IEEE-754 bit pattern of each
master sample, so no float formatting can drift.

Nothing was committed to the repo but planning-document updates; no
production code exists yet, and the spikes stayed in scratch.
