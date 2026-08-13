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
  pinned 1.96.0. Bumping the pin deliberately, fixing any new clippy
  lints in the same change, is the price of adoption — paid in
  phase 2 (now 1.97.1).

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

- **2026-08-12 — committed example MDF (owner).** `examples/` gains a
  demo `.mf4` beside `cannet-demo.blf`, same conventions (small,
  deterministic seeded generator script, README table entry): example
  CAN traffic decodable with `cannet-demo.dbc`, **event markers**
  (EV blocks), and **message-independent signal groups** (file-backed
  signals) — so every Task 38 surface is exercisable from a fresh
  clone. Synthetic content only.

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
data would also double-count.

**2026-08-12 — resolved (owner): recognise shape 3 and skip it.**
Shape 1 plus the project DBC reproduces it, so importing it can only
double-count; skipping is symmetric with the export ruling, which
declines to write shape 3 for the same reason. The skip is reported,
never silent: the reader lists every skipped group with its source
path, name and signal count, and the channel scan carries the same
list so the import dialog can say what it is leaving behind.

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

### 2026-08-12 — phase 2: the MDF reader crate

`rust-toolchain.toml` moved **1.96.0 → 1.97.1** first, in its own
commit, since `mdf4-rs` 0.6 declares that MSRV. The bump was clean:
`cargo clippy --workspace --all-targets` warning-free with no new
pedantic lints to fix, `cargo fmt --all --check` clean, and
`cargo test --workspace` green. README § Prerequisites points at the
toolchain file rather than naming a version, so it needed no edit.

**Fixture corpus, committed.** The phase-1 generator landed at
`crates/cannet-mdf/tests/fixtures/gen_fixtures.py`, grown from 7
fixtures to **9**: the wrinkle matrix plus `sorted_finalized_dbcdecoded`
(a logger file that also carries shape-3 groups) and `signal_only`
(the shape-2-only file the reader must reject). asammdf will not set
`cg_flags` bit 1 on an ordinary signal group, so the generator patches
that byte on the decoded groups to match what real files carry —
bus-event set, plain-bus-event clear. Nine files, 2.9–8.1 KB, each
with an `expected/*.json`; the generator re-reads everything it writes
and checks it against the JSON it just wrote. The Rust suite reads
only the committed pair, so `cargo test` stays Python-free.

**The crate.** `crates/cannet-mdf` — `MdfCanFrameSource` (a
`CanFrameSource`), `scan_mdf` (the census `scan_blf` is the model
for), `signal_groups()` for shape 2 and `skipped_decoded_groups()`
for shape 3. **20 tests**: nine per-fixture decodes compared field by
field against the expected JSON, the unfinalized-equals-finalized
twin check, cross-group timestamp ordering, the census-agrees-with-
decode check over eight fixtures, shape-2 extraction, shape-3
skip-and-report, shape-2-only rejection, and the source-path
classifier's unit tests.

**DZ, and why there is no pre-pass.** The eval left the choice as
"temp file or byte patching". Neither was needed once the block-graph
walk moved in-repo, which it had to for an unrelated reason:
`mdf4-rs`'s `MDF`/`ChannelGroup`/`Channel` handles borrow an
`MdfFile` the crate only constructs privately from a path, so a
source that holds its position between `next_frame` calls would have
to be self-referential — and that same privacy is what puts the
DZ-aware `resolved_data_blocks` out of reach. Owning `HD → DG → CG →
CN` and holding records as `(chunk, offset)` indices answers both:
a `##DZ` inflates into an owned chunk beside the borrowed `##DT`
ranges, and the cursor is plain integers. `mdf4-rs` keeps the block
parsers, the value decoder, the CC conversions and the DZ inflate.

**Local verification against the user corpus** (14 files, nothing
committed, no names or identifiers recorded here). All 14 open and
decode. Frame counts and time spans match the phase-1 numbers exactly
(7,645–21,982 frames each). A SHA-256 over every frame's id, extended
flag, length, bus channel and payload bytes matched an asammdf oracle
recomputed the same way on **14 of 14** files. Signal-group extraction
was compared row by row against asammdf: **452 rows, 0 mismatches** on
name, group index, unit, sample count, series sum, and first/last
absolute nanosecond timestamp. The 18-per-file groups asammdf and the
reader both leave out are VLSD text channels, not numeric series.
Shape-3 detection found 28–29 decoded groups per file, matching the
oracle's count.

Still outstanding for this task: the `import_mdf` GUI command with its
channel→bus mapping dialog, the model work for file-backed signals,
and the whole export side.

### 2026-08-12 — phase 3: the `import_mdf` GUI command

`scan_mdf_channels` + `import_mdf` land in `cannet-gui`, mirroring
`scan_blf_channels` / `open_log` field for field: the same one-pass
census, the same `run_pump` pipeline (generic over `CanFrameSource`,
so an `MdfCanFrameSource` runs through it unchanged) wrapped in a
`WindowedSource` for the import-range filter (ADR 0046), `BusChannel`
playing the role a BLF channel number plays (ADR 0023). Shape-3
(per-message DBC-decoded) groups the reader skips are never silent:
`scan_mdf_channels` logs them via `sys_info` and projects them into
`MdfScanResult` (`SkippedDecodedGroupInfo`) so the mapping dialog can
say what it is leaving behind, per the grooming pass's ruling. The
message-independent signal-group count rides the same scan result
(`signal_group_count`) so the phase that actually imports them won't
need to reshape this command. A signal-shape file surfaces
`MdfSourceError::SignalFile`'s message as `Err(String)` instead of
scanning as an empty capture.

**4 new host tests** (`apps/gui/src-tauri/src/tests.rs`), mirroring the
BLF import tests over `cannet-mdf`'s committed phase-1/2 fixtures —
tested at the same level those do (the frame pipeline directly, not
the `async` Tauri command, which needs an `AppHandle` the test suite
has no harness for): frames land with absolute timestamps and mapped
buses (`sorted_finalized_classic`, 60 frames), the import-range window
keeps only in-range frames (boundaries inclusive), skipped decoded
groups surface with the right per-group signal counts
(`sorted_finalized_dbcdecoded`), and the `signal_only` fixture produces
a clear, typed error string on both `scan_mdf` and
`MdfCanFrameSource::open`. `cargo test -p cannet-gui`: 549 passed, 0
failed, 6 ignored (4 of the 549 are the new tests). `cargo clippy -p
cannet-gui --all-targets` and `cargo fmt --all --check` clean.

**Frontend.** Open MDF… mirrors Open BLF… — a toolbar item, an
`mdf.open` command (palette + toolbar), a `.mf4`-filtered file dialog,
a "Scanning …" status-line notice while the census walks
(`scanningMdfPath`, alongside the existing `scanningBlfPath`), and
`BlfChannelMapModal` reused for the mapping step. The grooming note's
prediction — "it should need only the scan-result wiring" — mostly
held: `scan`'s shape (channels/frame_count/timestamps/markers) and the
mapping-persistence helpers (`blf_channel_maps`, keyed by path +
channel count alone, so an `.mf4` path needs no format-specific
counterpart) were reused with zero changes. Two things needed real
(if small) additions, recorded as the finding the grooming note asked
for: a `format` prop ("BLF"/"MDF") for the dialog's title text, and
two new optional props — a skipped-decoded-groups list and a
message-independent-signal-group count — since the reader crate's
"never silent" design means the dialog has to say what an MDF import
is leaving behind, which a BLF import never needs to say. `LogState`
(`statusLine.ts`) widens `result` from `OpenLogResult` to a
`BlfResult | ImportMdfResult` union (`CaptureResult`) so the window
title, capture label, and status line work for either source; a new
`capturePath` helper is the one place that reads across the two
field names.

Scope trim, not an oversight: no Recent-MDFs list. `recentBlfs.ts`'s
persisted MRU and toolbar dropdown aren't duplicated for MDF paths in
this phase — the exit criteria ask for channel scan + mapping, not
MRU parity, and the channel-mapping persistence (the thing the exit
criteria do name) is already shared. Worth adding later if it's
missed in practice.

**5 new frontend tests**: `BlfChannelMapModal.dom.test.tsx` grew three
(title switches BLF/MDF, skipped-groups list renders/hides, the
signal-group-count notice), a new `statusLine.test.ts` case for the
MDF scanning notice, and a new `App.mdfScanNotice.dom.test.tsx`
mirroring `App.blfScanNotice.dom.test.tsx` for the Open MDF… trigger.
`pnpm --dir apps/gui test`: 147 files / 1912 tests passed (was 146 /
1908). `pnpm --dir apps/gui build` clean.

**Local verification**, all 14 files of the phase-1/2 user corpus
(kept out of the repo; nothing identifying recorded here), run through
the same two calls `scan_mdf_channels` / `import_mdf` make
(`cannet_mdf::scan_mdf` + a full `MdfCanFrameSource` drain) via a
throwaway example deleted after the run: all 14 open, scan, and decode
without error; frame counts land at 7,645–21,982 per file — matching
phase 2's numbers exactly, low and high end included — and the census
count agrees with the full-decode count on every file (0 discrepancy).
Skipped-decoded-group counts are 28–29 per file, matching phase 2's
oracle-verified numbers.

Branch `task38c-gui-import` off `task38b-mdf-reader` (tip `6c2c05b`),
two commits: `1012077` "feat(gui): add scan_mdf_channels + import_mdf
host commands", `c913bf7` "feat(gui): wire MDF import into the
file-open surface".

Still outstanding for this task: the model work for file-backed
signals and message-independent-signal import (phase 4), and the whole
export side (phase 5).

### 2026-08-12 — phase 4: file-backed signals

The model gap is closed. Every signal is a `SignalCache` entry and
**decode provenance decides the fill**, exactly as the ruling states:
a DBC-backed entry decodes frames of its `(message, bus)` on catch-up,
a file-backed entry fills once from an imported signal channel group
and is then complete. Everything after the fill is shared — one store,
one resolution pyramid, one paged serve, one persistence path under the
capture's spill dir.

**Where provenance lives.** In the cache key, not beside it: a
file-backed series has no bus and its `slot` is the source file's
channel-group index, so the two namespaces cannot alias (a group index
and a message id are unrelated numbers that would otherwise collide).
The wire identity `signal_identity` / `signalKey` gained a third flag
value — `f` beside `s`/`x` — for the same reason, and stays
byte-for-byte identical across host and frontend.

**What follows from the fill, each pinned by a test.** A file-backed
serve is `complete` the moment the series exists and catch-up skips it;
a query for one the import never filled creates nothing (nothing could
ever fill it); a DBC-set change leaves them and their level files alone,
within a session *and* across a relaunch — the restore now judges the
two provenances separately, a DBC-backed row against the whole
`PyramidValidity` and a file-backed row against `capture_id` alone; the
raw store's ring eviction leaves them whole, because nothing could
re-derive what it would trim; a new capture still takes them with it.

**Import.** `import_mdf` reads `signal_groups()` before handing the
source to the pump and fills after `run_pump` returns — not before,
since the pump mints the capture identity on its first frame and that
wipes the caches. The import range (ADR 0046) bounds the fill as
`WindowedSource` bounds the frames; a signal with nothing in range is
not filled at all. The mapping dialog stopped saying the groups were
found but not imported, and the system log reports signals/samples/groups.

**Views.** `list_signals` appends them to the DBC-derived catalog and
`fetch_signal_page` serves them beside the DBC-backed rows, selected by
the same canonical-path patterns (ADR 0038) with empty bus and ECU
segments (`//Analog/EngineSpeed`). Their value/time/count/rate describe
the *whole imported series*, read off the pyramid by the model — no
frame in the trace window carries them. Trace views untouched. A
bus-wired view has no file-backed rows, the same rule that excludes an
unassigned-bus descriptor. Marking follows the existing per-signal
metadata pattern: the message column carries the source channel group
plus a `file` badge, the picker shows `(file-backed)` where a
DBC-backed signal shows its ECU, and both strings live in one module so
two surfaces cannot mark the same thing differently. The catalog also
refetches on `log-finished` — it is no longer purely a function of the
DBC set.

**BLF save.** `save_capture` warns (`capture`-tagged `sys_warn`, the
channel its existing precision warning uses) naming the file-backed
signals the format cannot carry. Warn, not block.

**Tests.** `cargo test -p cannet-gui`: **566 passed**, 0 failed, 6
ignored (was 549 — 17 new: 8 in `signal_cache`, 9 in `tests.rs`).
`pnpm --dir apps/gui test`: **147 files / 1917 tests** (was 147 / 1912
— 5 new: the file-backed grid badge, the picker source segment, two
`signalKey` provenance cases, the catalog's import refetch, and the
mapping-dialog notice rewritten). `cargo clippy -p cannet-gui
--all-targets`, `cargo fmt --all --check`, `pnpm --dir apps/gui build`
all clean.

**Perf gate** (ADR 0031, this phase touches the signal-cache data
path). Release GUI via `pnpm --dir apps/gui tauri build --no-bundle`,
60 s ev-zonal capture with `--perf-interact scrub`
(`docs/performance-measurements/frontend/2026-08-12-2c65e78-task38d.json`),
then `cannet-perf-measurement check` against the committed
`baseline.json`: **passed, 33/33 metrics ok**, nothing promoted. rx
1610.2 / tx 1608.7 fps (expected 1608 ±15 %), retention 1.001/1.001,
`longtask_ms_per_s_mean` 0.0 (baseline 1.3), `lag_ms_max` 3.1 (27.1),
`jank_fraction` 0.000 (0.017), `flush_ms_mean` 4.44 (ceiling 25),
`tx_late_ms_mean` 5.33 (ceiling 18), `jsheap_mb_peak` 75.6 (71.6),
`renderer_mb_peak` 304.9 (319.3), `tree_mb_peak` 727.7 (743.3),
`rx_gap_p95_ratio_worst` 1.185 (1.196). Host modes: tracebuffer
25000.1 fps, grpc 2907.6, hardware-peak 999.7 — all ok.

**Local verification**, the same 14-file user corpus phases 1–3 used
(kept out of the repo; nothing identifying recorded here), run through
`signal_groups()` + `fill_file_backed` via a throwaway example deleted
after the run. All 14 open and fill. **452 file-backed signals across
the corpus, 3,823 samples** — the signal count matches phase 2's
oracle-verified 452 rows exactly. Per file: 32–35 signal groups, one
channel each, 65–436 samples; the listing round-trips (`file_signals()`
reports the same signal and sample counts that were filled, on every
file). Level-0 spill is 32–69 KB per file across 32–67 segment files,
pyramid depth 1–2 — these series are short, so the pyramid barely grows
past level 0. Fill time 31–83 ms per file, dominated by the reader's
whole-file materialisation. The corpus's signal channels carry no unit
string, so the unit column is empty for all 452; rate is defined for
every signal with ≥2 samples (32 per file).

Still outstanding for this task: the whole export side (phase 5).

### 2026-08-12 — phase 5: MDF export and the round-trip

The round-trip closes. `MdfCaptureWriter` in `cannet-mdf` writes a
capture back out as a **sorted, finalized MDF 4.10** file and
`MdfCanFrameSource` reads what it wrote, field for field.

**What the writer emits.** One data group per channel group (that is
what sorted means), uncompressed `##DT`, `id_unfin_flags` clear.
`CAN_DataFrame`, `CAN_ErrorFrame` and `CAN_RemoteFrame` groups are
**always** written, empty or not, as the corpus's real logger files
carry them — which also means an export of a frameless capture is still
recognisably a logger file rather than a signal file the reader would
reject. Each is a structure channel: one `##CN` spanning the frame at
byte 8, its `cn_composition` reaching one `##CN` per member
(`BusChannel` u16, `ID` u32, `IDE`, `DLC`, `DataLength`, `Dir`, `EDL`,
`BRS`, `ESI`, then `DataBytes` sized once for the group), `cn_flags`
bit 10 set on all of them, `cg_flags` 0x6, a `##SI` bus source. Record
size is 21 + payload bytes; the master is `f64` seconds at byte 0.
File-backed signals go out as **one channel group per signal** (a
channel group is a shared sample axis by definition, and two series
that came from one group need not still share one), each carrying the
source group's `cg_acq_name`.

**Timestamps.** `hd_start_time_ns` is the capture's earliest event —
frames, notes and signal samples all considered, so nothing lands at a
negative offset — and every master sample is seconds relative to it.
Recovery is exact for any capture spanning under ~26 days (past that a
nanosecond is finer than an `f64` second's last bit); pinned by a unit
test over offsets from 1 ns to an hour and by the round-trip tests.

**EV blocks.** A note becomes an `##EV` marker: `ev_tx_name` is the
label, and the note's id and color ride in the event's `##MD` comment
under `common_properties` (`cannet.id`, `cannet.color`) — MDF's own
extension point for tool metadata, the same in-file principle ADR 0010
applies to BLF's `GLOBAL_MARKER`. `ev_sync_base_value` is whole
nanoseconds with `ev_sync_factor` 1e-9, so the marker's time is an
integer on disk. Reading them back is new too
(`MdfCanFrameSource::events()`, also on `scan_mdf`), so an MDF import
now brings notes in the way a BLF import does; an event another tool
wrote gets a synthetic `mdf-event-<n>` id, mirroring `blf-marker-<n>`.

**AT attachments.** The project's DBCs are embedded uncompressed with
their file name and `application/vnd.vector.dbc`, and read back via
`attachments()`. A DBC that has moved since it was loaded is skipped
rather than failing the save.

**Host routing.** `save_capture` takes an explicit `format` and routes
to `write_blf_capture` or `write_mdf_capture`; the
dropped-file-backed-signals warning is now BLF-only. The MDF path reads
the trace store in **chunks** (two passes: one to settle the origin and
the widest payload, since MDF records are a fixed layout, one to write
the records), so it does not add to the whole-capture materialization
the BLF path still does.

**Frontend.** The save dialog's filter list grows "ASAM MDF (`.mf4`)"
beside "Vector BLF (`.blf`)". Recorded conflict, resolved by closest
faithful reading: an OS save dialog reports the chosen filter in
exactly one way — it stamps that filter's extension on the path it
returns — and Tauri's `save()` surfaces nothing else. So the mapping
filter → format lives in `saveFormat.ts` as a pure, unit-tested
function on the frontend, and what crosses the wire is the format. The
ruling's substance holds: the **host** never sniffs the path.

**Tests.** `cargo test -p cannet-mdf`: **43 passed** (was 25 — 9 writer
integration tests, 3 event-comment unit tests, 4 DLC / master-axis unit
tests, plus the block-layout ones). `cargo test -p cannet-gui`: **569
passed**, 0 failed, 6 ignored (was 566 — the full round-trip contract
over `write_mdf_capture`, the synthetic-event-id rule, and the demo MDF
import). `pnpm --dir apps/gui test`: **148 files / 1923 tests** (was
147 / 1917 — `saveFormat.test.ts` and `App.saveCapture.dom.test.tsx`).
`cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt
--all --check` and `pnpm --dir apps/gui build` all clean.

**asammdf oracle, wired into CI.** A new `mdf-export-oracle` job runs
`cargo run -p cannet-mdf --example export_sample` and then
`crates/cannet-mdf/tests/fixtures/validate_export.py` under
`uv run --with asammdf`, deliberately separate from the `rust` job so
`cargo test --workspace` stays Python-free. Locally: 30 frames, 3
signals, 2 events, 1 attachment, CAN buses [1, 2] — OK, with asammdf's
`bus_logging_map['CAN']` non-empty (the thing `mdf4-rs`'s own writer
fails).

**Committed example MDF.** `examples/cannet-demo.mf4` (35 KB, `##DZ`
data blocks) carries the demo BLF's 1810 frames verbatim plus four
`##EV` markers and two message-independent signal groups (`Ambient`:
`AmbientTemp` degC, `CabinHumidity` %; `Charger`: `ChargerPower` kW).
`examples/generate_mdf.py` is seeded and reads the frames out of the
committed BLF rather than re-deriving the waveforms, so the two
fixtures cannot drift; it pins the `##FH` block's time (asammdf's only
non-deterministic field) so regeneration is byte-identical. Written
with asammdf on purpose — a fixture produced by the code under test
cannot catch that code being wrong. A host test drives it through the
same calls `import_mdf` makes: 1810 frames on one bus channel, 3
file-backed signals with their units and group names, 4 notes with
their ids and colors, 0 synthetic ids.

**Local verification, the 14-file user corpus** (kept out of the repo;
nothing identifying recorded here), through a throwaway example deleted
after the run. Every file imported → exported → re-imported: **14 of 14
identical** on frame count, on a digest over every frame's timestamp,
channel, id, addressing mode, direction and payload, on all 452
file-backed series (name, unit, group name, values and timestamps
verbatim) and on the attachment. 7,645–21,982 frames per file, matching
phases 2–4 exactly; exports 247–654 KB, 36–77 ms each.

Then the same 14 exports validated with **asammdf** against their
sources: 14 of 14 match on the frame multiset (bus, id, IDE, length,
payload, absolute ns) and on every message-independent series, with
`bus_logging_map['CAN']` non-empty on every export. That took one
correction, worth recording: 6 of 14 first reported a mismatch, on 2
rows each out of 8,000–21,000. The rows were master samples like
`1.5400390625` s, whose product with 1e9 is exactly `…062.5` — a tie,
which Rust's `f64::round` breaks away from zero and Python's `round`
breaks to even. The oracle now uses `floor(x + 0.5)` to match the
reader. Not a writer bug and not a fidelity loss: cannet's own chain is
self-consistent to the nanosecond either way.

**Blockers / side effects**

- *Conversion metadata is not round-tripped, because the model never
  holds it.* The fidelity contract lists "file-backed signal series +
  name/unit/conversion metadata verbatim", but a file-backed signal
  enters the model as `FileSignalInfo { group, group_name, name, unit }`
  — the source channel's `cc_type` is dropped at import (phase 4), and
  the values it produced are already physical. Closest faithful
  reading: export writes those physical values with no `##CC` block,
  which is what verbatim means for the *series*; the conversion's name
  was provenance the model never carried. Name, unit, values and
  timestamps do round-trip exactly.
- *File-backed signal timestamps round-trip at the model's resolution,
  not the frame timeline's.* The signal cache stores sample times as
  `f64` seconds since the epoch, so a present-day timestamp quantizes
  to ~0.24 µs before export ever sees it. The round-trip test asserts
  within 1 µs and says why; frames are unaffected and exact.
- *Vector's MDF Validator was not run* — it is a Windows GUI tool that
  is not installed on the reference machine. asammdf covers the same
  ground programmatically and is the check CI runs; the exit criteria's
  mention of the Validator is outstanding on that tool alone.
- *No Recent MDFs list still.* A successful MDF save does not promote
  its path anywhere, because `recentBlfs` has no MDF counterpart (the
  phase-3 scope trim). Unchanged by this phase, noted so it is not
  mistaken for a regression.

Branch `task38e-mdf-export` off `task38d-file-backed-signals` (tip
`a81aeb9`), five commits: `22dc19f` "feat(mdf): write captures back out
as sorted, finalized MDF 4.10", `991df0e` "test(mdf): validate an MDF
export against asammdf in CI", `1a4ffd1` "feat(gui): route capture.save
to the BLF or the MDF writer", `066796a` "feat(examples): ship the demo
capture as MDF too", `11147c4` "test(mdf): match the reader's tie rule
in the asammdf oracle".

### 2026-08-12 — phase 6: close-out

No feature code — verification only. Also carried one unrelated,
already-pending docs edit that predated this phase: the roadmap's
Task 64 (server installers) insertion, opened by owner ask, committed
first (`609bc05` "docs(plans): open task 64 — server installers") so
it isn't mixed into task 38's own history.

**Perf gate** (ADR 0031, final gate for this task — phase 4 gated the
signal-cache data path, phase 5 added the save/frontend surface
ungated). Release GUI via `pnpm --dir apps/gui tauri build --no-bundle`,
60 s ev-zonal capture with `--perf-interact scrub` against real PCAN
hardware
(`docs/performance-measurements/frontend/2026-08-12-609bc05-task38f-closeout.json`),
then `cannet-perf-measurement check` (with `--expected-rx-fps 1608
--expected-tx-fps 1608`) against the committed `baseline.json`:
**passed, 33/33 metrics ok**, nothing promoted.

| metric | baseline | current | limit | result |
| --- | --- | --- | --- | --- |
| tracebuffer ingest_fps_overall | 25000.114 | 25000.101 | 21250.097 | ok |
| tracebuffer fps_retention | 1.000 | 1.000 | 0.800 | ok |
| tracebuffer append_ms_max | 3.064 | 2.616 | 11.128 | ok |
| tracebuffer scan_ms_max | 0.219 | 0.532 | 5.438 | ok |
| grpc ingest_fps_overall | 2853.805 | 2839.974 | 2425.735 | ok |
| grpc fps_retention | 0.998 | 0.986 | 0.800 | ok |
| grpc append_ms_max | 0.833 | 0.808 | 6.665 | ok |
| grpc scan_ms_max | 0.068 | 0.119 | 5.135 | ok |
| hardware-peak ingest_fps_overall | 999.630 | 999.689 | 849.686 | ok |
| hardware-peak fps_retention | 1.000 | 1.001 | 0.800 | ok |
| hardware-peak append_ms_max | 0.563 | 0.470 | 6.126 | ok |
| hardware-peak scan_ms_max | 0.032 | 0.216 | 5.064 | ok |
| frontend longtask_ms_per_s_mean | 1.300 | 0.000 | 12.600 | ok |
| frontend longtask_ms_per_s_p95 | 0.000 | 0.000 | 17.000 | ok |
| frontend lag_ms_max | 27.100 | 1.400 | 74.200 | ok |
| frontend jank_fraction | 0.017 | 0.000 | 0.083 | ok |
| frontend jsheap_mb_peak | 71.600 | 93.200 | 207.200 | ok |
| frontend jsheap_mb_drift_per_min | 5.693 | 14.827 | 16.386 | ok |
| frontend renderer_mb_peak | 319.258 | 327.051 | 702.516 | ok |
| frontend renderer_mb_drift_per_min | 50.802 | 58.535 | 106.605 | ok |
| frontend host_mb_peak | 58.402 | 58.023 | 180.805 | ok |
| frontend tree_mb_peak | 743.262 | 732.418 | 1550.523 | ok |
| frontend tree_mb_drift_per_min | 80.117 | 88.240 | 165.233 | ok |
| frontend flush_ms_mean | 25.000 | 4.197 | 25.000 | ok |
| frontend tx_late_ms_mean | 18.000 | 4.757 | 18.000 | ok |
| frontend flush_ms_max | 15.176 | 9.657 | 55.352 | ok |
| frontend tx_late_ms_max | 75.947 | 22.929 | 176.894 | ok |
| frontend rx_gap_p95_ratio_worst | 1.196 | 1.156 | 2.893 | ok |
| frontend rx_gap_short_frac_worst | 0.006 | 0.002 | 0.041 | ok |
| frontend rx_fps_retention | 0.999 | 1.001 | 0.800 | ok |
| frontend tx_fps_retention | 0.999 | 1.000 | 0.800 | ok |
| frontend rx_fps_expected | 1608.000 | 1608.152 | 1366.800 | ok |
| frontend tx_fps_expected | 1608.000 | 1609.515 | 1366.800 | ok |

`cannet.log` carries no errors for the run; the only warning is the
pre-existing, expected "vxlapi not found" (no Vector XL hardware on
this machine, unrelated to PCAN).

**Doc-gap sweep.** No gaps found; nothing changed.

- README's MDF sections (import mirroring BLF end to end, shape-3
  skip-and-report, file-backed signals, the Save Capture BLF/MDF
  comparison table, `##DT` uncompressed / sorted / finalized writer
  behaviour) are all present and match what phases 3–5 shipped.
- `examples/README.md`'s Files table and "What the MDF adds" section
  already document `cannet-demo.mf4` (added phase 5); consistent with
  the README and this task file — no drift across the three.
- `crates/README.md`'s `cannet-mdf` entry names `MdfCaptureWriter` and
  what it writes.
- `plans/technology-inventory.md`'s MDF entry marks the in-repo-writer
  decision settled, with the asammdf-validated numbers.
- `RUSTDOCFLAGS="-D warnings" cargo doc -p cannet-mdf --no-deps`:
  clean, zero warnings.
- Vector's MDF Validator is still not run (a Windows GUI tool not
  installed on the reference machine, per phase 5) — unchanged,
  outstanding on that one exit-criterion clause alone.

Branch `task38f-closeout` off `task38e-mdf-export` (tip `6cf3eaf`), two
commits: `609bc05` "docs(plans): open task 64 — server installers" (the
pre-existing, task-38-unrelated plans edit), and this status-log +
perf-report commit.

## Exit-criteria walk (2026-08-12, orchestrator)

- **Dependency decision recorded** — met. `mdf4-rs` (read) +
  in-repo composition/writer, `mdflib` FFI rejected on measured
  cost; exercised against user-provided logger files and asammdf
  synthetics. Caveat, recorded honestly: no CANape/Vector-written
  sample file was available to the eval — the corpus + fixtures
  covered the logger shape and all block wrinkles instead.
- **Reader crate** — met. `cannet-mdf` implements `CanFrameSource`
  over sorted/unsorted × finalized/unfinalized × classic/FD ×
  remote/error × DZ (committed fixture per cell; 14/14 user files
  byte-hash-equal to the asammdf oracle).
- **`import_mdf` + channel scan/mapping** — met (mirrors
  `import_blf`; mapping persistence shared unchanged).
- **Signal-shape rejection** — met (typed error, user-facing
  message, fixture-tested).
- **Absolute timestamps (ADR 0024) + fixture round-trip vs
  asammdf** — met (nanosecond-exact on frames; expected-decode JSON
  pins IEEE-754 bit patterns).
- **Export validated; round-trip preserves the fidelity list** —
  met via asammdf (committed CI oracle + 14/14 local corpus
  round-trips). **Vector MDF Validator clause open**: Windows GUI
  tool not installed on the dev machine — owner runs it once
  (e.g. against `examples/cannet-demo.mf4`) or waives the clause.
- **Message-independent signals in the model, survive round-trip** —
  met (file-backed `SignalCache` provenance; 452/452 series verbatim;
  1 µs sample-time caveat recorded in phase 5's blockers).
- **README + technology-inventory + rustdoc** — met (phase-6 sweep
  found no gaps).
