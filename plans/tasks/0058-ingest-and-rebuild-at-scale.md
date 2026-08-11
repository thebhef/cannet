# Task 58 — Ingest & Rebuild at Scale

Groomed 2026-08-08 from a real user workload (details kept out of the
repo by owner instruction; shape: a ~348 MiB-uncompressed BLF, 6.53 M
frames over 5400 s, plotted through a view resolving ~96
pattern-derived signals across 7 areas, the cell-style messages each
carrying ~16 of those signals). Observed on that workload:

- BLF import took 121 s (~54 k frames/s) — ~45× real-time for a local
  file read.
- After import (and again after every relaunch), all plots sat on the
  indeterminate `building…` placeholder for multiple minutes (dev
  build) while the signal pyramids rebuilt; the health log was the
  only sign of progress (`pyramid=` cache growing).
- During the rebuild the app could not be exited nominally.
- During the import, open plots stopped updating.

Three exploration maps (import path, catch-up/decode sharing, exit
path) were produced 2026-08-08 and their findings are folded in below.

## Items

### 1. One-pass import through the one shared pipeline

**Findings (code read):** import is a 3-pass design — `scan_blf_channels`
fully decodes up to 200 k frames only to read `frame.channel`
(`capture.rs:424-455`); `open_log` (a sync command, so main-thread)
then runs `read_notes_from_blf`, a complete second decode of the whole
file just to find marker records (`capture.rs:77`, `:237-266`), before
the pump starts. The pump itself is the shared `run_pump`
(`session.rs:798-860`) — correctly one pathway — but pays per frame:
~4 heap allocations (BLF payload `to_vec`, `route_channel` bus clone,
`FrameKey` bus clone, retention clone), 3 string hashes, one global
store-mutex acquire, one `Instant::now`
(`trace_store/mod.rs:423-490`, `cannet-blf/src/lib.rs:228`,
`session.rs:769-778`). The flusher also rewrites `derived.json` whole
every 2 s and walks the directory twice per tick (`flush.rs:282,303,
324-365`).

**Owner rulings (2026-08-08):**

- **One ingest pathway, period.** File imports stream through the same
  live path; no import-specific fork (an import-only batched append
  was proposed and rejected). Optimizations land in the shared path so
  live sessions benefit too. Check whether an ADR already states this
  for the `CanFrameSource` seam; reinforce it or write one.
- The notes/marker pass dies: markers are collected during the one
  import pass.
- `open_log` becomes async (off the main thread), like its siblings.
- The channel scan becomes a **header-only walk of the whole file** —
  no payload decode, exact channel census (the 200 k cap and its quiet
  truncation hole go away). Floor cost is inflating every container
  (~1-2 s at this size), accepted.

Profile before cutting: attribute the 18.5 µs/frame budget, land the
cuts the data names, re-measure at the 6.5 M scale.

### 2. Import dialog: metadata, markers, time range

The header-only full scan naturally yields first/last timestamps and
sees every marker record (rare; decoding just those is ~free). Owner
rulings (2026-08-08): the channel-mapping dialog gains capture
duration, wall-clock start, and other cheap header metadata; a
**collapsible gridview of markers/events with timestamps**; and
**selectable start/end time range** for the import (implemented as
skip-before/stop-after in the one shared pump path).

### 3. Persist signal pyramids across restore

Today restore wipes the pyramids and the filter index; first use
rebuilds from frame zero — so every relaunch with a big cache re-pays
a multi-minute rebuild even though frames restore in ~1 s. The
pyramids are already on-disk mmap structures (`signal_cache.rs`);
`clear`/`reroot` are what discard them. Owner ruling (2026-08-08):
**stop deleting them** — disk retained between sessions is only the
pyramid size (~230 MB on the reference workload, proportional to
plotted signals), not worth the rebuild time. Validity discipline
required: keyed to capture identity + DBC set + eviction low-water;
wiped as today on trace clear or DBC change (`app_state.rs:282-291`
invariants, regression at `tests.rs:770+`).

### 4. One decode pass per message

`catch_up` decodes the full message then picks one signal
(`signal_sampler.rs:98-99` → `decode.rs:86-116`), so N signals of one
message re-fetch and re-decode the same frames N times (the reference
workload's cell messages: ~16×). The grooming map
(2026-08-08, catch-up explorer) records the full repeated-work
inventory, the grouping design (group by `(message_id, extended)`,
bus filter stays per-target, drive the chunk cursor from
`min(next_index)` and use the currently-discarded frame index to gate
per-target cursors), and hazards H1-H11 — notably **H3: per-signal
"first DBC wins" must be preserved exactly** (a naive
decode-with-first-matching-DBC silently changes provenance when DBCs
overlap), H4 heterogeneous cursors, H5 bus scoping, H10 the
index-parallel result contract. The injectable-fetch test seam and the
`bench_first_use_rebuild` harness already exist — extend, don't
replace.

### 5. Rebuild off the global signal-cache mutex

One `Mutex<Caches>` is held across the *entire* catch-up in both
`slice` and `min_max` (`signal_cache.rs:571,584,604,616`): one cold
area serializes every other plot in the app, the min/max sidecar
blocks behind it, and — the exit-hang root — every stalled async
command parks a tokio worker, starving the close path's `rbs_dirty`
await (`App.tsx:1792`) so `destroy()` is never reached. The flusher's
`evict_below` parks on the same mutex. Fix the granularity (per-key /
per-message locking, or rebuild outside the map lock) while keeping
`reroot`'s invariant (root and caches move together) and evict
atomicity (`folded` never below `first_slot`). Exit contract after
this: the window closes promptly during a rebuild. The shutdown flush
and `clear_scratch_on_exit` behaviors stay as they are (owner,
2026-08-08): the periodic flusher keeps exit-time residue small.

### 6. Incremental paint — points stream in, `building…` only briefly

**Owner ruling (2026-08-08): no determinate progress bar.** The plot
shows the placeholder only until points start streaming, then paints
incrementally as the rebuild advances. Mapped blockers this must
clear: `slice` is all-or-nothing (needs a bounded-work call returning
partial + more-pending), `useDecimatedRange`'s `fetchKey` memo would
dedupe identical partial requests (needs a generation/completeness
token), and `useFirstSampleWait` settles on first outcome (needs a
first-paint vs complete split; `PlotArea.tsx:1357`, pins at
`PlotPanel.dom.test.tsx:1627,1655,4586,4736` updated deliberately,
never weakened). This also covers the freeze-during-import symptom:
plots keep painting while ingest runs.

## Non-goals

- No import-specific ingest pipeline (rejected; see item 1).
- No marked-progress UI (rejected; see item 6).
- No change to shutdown flush or clear-scratch-on-exit semantics.
- User capture data never enters the repo: regression fixtures are
  synthesized (the existing synthetic-capture patterns from the
  task-57 measurements apply).

## Phases (presented to owner 2026-08-08; go pending)

Chained off `task57e-restore-experience`, strictly sequential, one new
branch per phase, main working tree, orchestrator reviews diffs
between phases. 58.A's first commit is the plan docs (this file,
0059, 0060, roadmap).

- **58.A** `task58a-one-pass-import` (Opus) — item 1: notes folded
  into the pump pass, `open_log` async, header-only exact channel
  scan, shared-path profiling + cuts, one-ingest-pathway ADR.
  ADR-0031 gate after.
- **58.B** `task58b-import-dialog` (Sonnet) — item 2: dialog
  metadata, markers gridview, time-range selection.
- **58.C** `task58c-pyramid-persistence` (Opus) — item 3; measured
  relaunch before/after at multi-million-frame scale (synthetic).
- **58.D** `task58d-decode-sharing` (Opus) — item 4; hazards H1-H11
  per the grooming map; bench before/after.
- **58.E** `task58e-cache-lock-split` (Opus) — item 5; exit works
  during a rebuild, tested.
- **58.F** `task58f-incremental-paint` (Opus) — item 6; final
  ADR-0031 gate + exit-criteria walk.

## Exit criteria

- Import runs as one decode pass (plus the header-only scan), off the
  main thread, through the shared pump; the per-frame budget is
  profiled before/after with the cuts attributed, and the measured
  import time at the 6.5 M-frame scale is recorded (target: multiples
  of the 54 k frames/s baseline; the two whole-file extra passes are
  gone).
- The mapping dialog shows exact channel census, duration, wall-clock
  start, a collapsible markers gridview, and honors a selected import
  time range (tested at the scan and pump seams).
- A relaunch with a large restored capture paints plots without a
  rebuild (pyramids persisted and validated; measured before/after).
- N signals of one message catch up with one decode pass (equivalence
  and provenance semantics pinned by tests; `bench_first_use_rebuild`
  before/after recorded).
- A cold rebuild in one area no longer blocks other areas' sampling,
  min/max, eviction, or app exit (tested at the lock seam; exit works
  during a rebuild).
- Plots paint incrementally during rebuild and during import;
  `building…` appears only until first points (dom-tested).
- ADR for the one-ingest-pathway rule reinforced or written; docs
  updated with behavior changes; ADR-0031 gate green (multi-run) after
  ingest-path changes and at completion.

## Status log

### 2026-08-08 — phase 58.A, item 1 (one-pass import)

Branch `task58a-one-pass-import`, off `task57e-restore-experience`
(048dd8b).

| commit | subject |
| --- | --- |
| d0a8806 | `docs(plans)`: groom tasks 58-60 and reorder the roadmap |
| 0993e5e | `perf(blf)`: take the channel census from a header-only walk |
| 0a83076 | `test(gui)`: benchmark what a BLF import spends per frame |
| 5d08f94 | `perf(gui)`: fold the BLF marker pass into the import's one walk |
| 3dbbd9a | `test(gui)`: attribute the ingest budget to the store and the bus id |
| d263a97 | `docs(adr)`: record the one-ingest-pathway rule |

Tests after the slice: `cannet-blf` 106 + 1 integration (was 104),
`cannet-spill` 57, `cannet-gui` 500 + 4 ignored benchmarks
(`bench_blf_import` is the new one). Clippy clean
across the workspace with `--all-targets`. No frontend code touched —
`open_log` and `scan_blf_channels` keep their wire shapes, and the
frontend already `await`ed both.

**What landed**

- `cannet_blf::scan_blf` — a header-only walk (`BlfReader::next_raw_object`)
  that reads each object's channel field out of its bytes with no
  per-type decode and no payload allocation. Exact over the whole file:
  the 200 000-frame cap and its silent truncation are gone.
  First/last timestamps and every `GLOBAL_MARKER` fall out of the same
  walk, so 58.B's dialog metadata, markers gridview and time-range
  selection can consume it without a second pass.
- The notes pre-pass is deleted. `BlfCanFrameSource::on_marker` hands
  markers to a sink as the pump walks past them, so the import is one
  walk of the file. `read_notes_from_blf` and its whole-file second
  decode are gone; the round-trip tests now read a capture back the way
  the import does.
- `open_log` is `async`, so nothing whole-file runs on the main thread.
- ADR 0046 records the one-ingest-pathway rule, the rejected
  import-specific batched append, and the single sanctioned extra walk
  (the pre-census).

**Profiling — the measuring experiment**

Harness: `bench_blf_import` (`cargo test -p cannet-gui --release
bench_blf_import -- --ignored --nocapture`), a synthesized BLF — 4
channels, 512 ids, 8-byte xorshift payloads so it deflates like a real
recording, `CANNET_BENCH_FRAMES` to set the size. Every phase walks the
same file, so the numbers subtract. Run-to-run spread is about ±10 % on
the disk-backed phases.

Release build, 6.5 M frames (99 MiB on disk, ~365 MiB uncompressed):

| phase | wall | µs/frame |
| --- | --- | --- |
| census (header-only, whole file) | 0.82 s | 0.13 |
| markers\* (the removed second decode) | 1.24 s | 0.19 |
| decode (`next_frame` only) | 1.72 s | 0.26 |
| convert (+ `RawTraceFrame::from`, routing, verifier probe) | 2.26 s | 0.35 |
| full/mem (+ `TraceStore::append`, in-RAM raw store) | 5.44 s | 0.84 |
| mem/nobus (full/mem with frames unassigned) | 3.94 s | 0.61 |
| full (+ disk-spill raw store) | 9.60 s | 1.48 |
| full+obs (+ flusher + 10 Hz status/tail readout) | 9.03 s | 1.39 |

Attribution of the ~1.4-1.5 µs/frame shared path: BLF decode 0.26 (18 %),
conversion + routing + verifier probe 0.09 (6 %), the trace store's
derived state 0.49 (34 %), the disk-spill segment write 0.64 (43 %). The
observers are inside run-to-run noise. Carrying a logical bus id costs
0.22-0.23 µs/frame (~15 %) — the routing clone, the `FrameKey` clone and
hash, the retention clone, and the disk store's bus intern.

Import wall clock at that scale: **before** the capped census (~0.05 s
of decode for its 200 k-frame slice) + the marker pass 1.24 s + the pump
9.03 s = **10.3 s, with an inexact channel census**; **after** the exact
census 0.82 s + the pump 9.03 s = **9.9 s**. 720 k frames/s through the
pump — 13× the 54 k frames/s the workload reported.

**The finding that reframes the item.** The 18.5 µs/frame budget is not
reproducible in an optimized build. The same harness on the same file
in a **debug** build, 400 k frames:

| census | markers\* | decode | convert | full/mem | full | full+obs |
| --- | --- | --- | --- | --- | --- | --- |
| 2.69 | 3.17 | 3.70 | 3.85 | 6.72 | 11.18 | 11.36 |

(µs/frame). The old three-pass shape in debug is markers 3.17 + pump
11.36 ≈ 14.6 µs/frame → 68 k frames/s, against the 18.5 µs/frame /
54 k frames/s the workload showed — the same regime. In release the same
three-pass shape is ~2.0 µs/frame → ~490 k frames/s. **The reported
121 s import is a dev-build number**; the equivalent release import of
that capture is ~10 s. The per-frame suspects the code read named
(allocations, string hashes) are real but total ~0.22 µs/frame in
release — they are not what made the import take two minutes.

Hypothesis → experiment → data → conclusion, written out:

- *Hypothesis.* The 18.5 µs/frame is dominated by the per-frame
  allocations, string hashes, store mutex and flusher the code read
  named.
- *Experiment.* Split the pipeline into phases over one synthetic
  capture and time each; repeat in debug and release; run the pump with
  and without the flusher and the 10 Hz readout; run it against the
  in-RAM and the disk raw store; run it with and without bus ids.
- *Data.* The tables above.
- *Conclusion.* Refuted as stated. Build profile accounts for ~7× of the
  budget. Within release, half the remainder is the disk-spill segment
  write and a third is the store's derived state; the observers are
  inside noise, so the flusher is not implicated. The two whole-file
  extra passes were real duplicate work and are gone.

**Cross-check against a real capture** (read locally, read-only; nothing
derived from it is in the repo): a 6 533 199-frame BLF. The header-only
census walks it in 1.00 s against 1.61 s for the decoding walk, and the
two agree exactly on frame count and channel set. The old scan looked at
200 000 of those 6 533 199 frames — 3 % of the file — to decide the
mapping dialog's contents. The ~1 s census floor the owner accepted is
confirmed at 1.00 s.

**A cut attempted and reverted.** The retention clone in
`TraceStore::append` was restructured to fill the per-key overlay from a
borrow (`clone_from`) and hand the frame to the raw store by move. It
measured inside run-to-run noise, and the reason is that
`#[derive(Clone)]` does **not** generate a field-wise `clone_from` — the
default `*self = source.clone()` still allocates, so the reorder removed
nothing. Reverted rather than kept as churn. Making it a real cut needs
manual `clone_from` impls on `RawTraceFrame` and `CanFramePayload`, and
the win it would buy (~2 allocations + 2 frees per frame) is below this
harness's noise floor — it needs a dedicated append microbenchmark to
measure, not the whole-file one.

### 2026-08-08 — phase 58.B, item 2 (import dialog: metadata, markers, time range)

Branch `task58b-import-dialog`, off `task58a-one-pass-import` (655ebc9).

| commit | subject |
| --- | --- |
| 572108c | `feat(core)`: add a windowed CanFrameSource for import time ranges |
| 9036809 | `test(blf)`: pin the import time-range filter at the pump seam |
| a943875 | `feat(gui)`: widen the BLF scan and wire an import time range |
| 6e2e8b7 | `feat(gui)`: show capture metadata, markers, and a time range in the BLF dialog |

Tests after the slice: `cannet-core` 41 (was 34), `cannet-blf` 107 + 1
integration (was 106 + 1), `cannet-gui` 501 + 4 ignored benchmarks (was
500 + 4). Frontend: 139 files / 1675 tests (was 138 files — one new
`.dom.test.tsx` — with the modal's existing 3 tests rewritten to the
new prop shape and 6 new ones added). `cargo clippy --workspace
--all-targets` clean; `pnpm --dir apps/gui build` and `tsc -b` clean.

**What landed**

- `cannet_core::WindowedSource<S>` — a `CanFrameSource` wrapper with an
  inclusive `[start_ns, end_ns]` filter, either bound optional. Frames
  before `start_ns` are skipped (the inner source is still walked, so a
  source that surfaces side information mid-walk — the BLF marker sink
  — still sees that prefix); a frame past `end_ns` ends the stream for
  good (`next_frame` returns `None` from then on, the inner source is
  never asked again). This is the ADR-0046 seam the range filter lives
  at: generic over every `CanFrameSource`, not a BLF-specific fork.
  Pinned by 7 unit tests (both-bounds, one-bound, no-bounds,
  exactly-at-start, exactly-at-end, stop-after-never-resumes, empty
  source) plus a `cannet-blf` integration test that wraps a real
  `BlfCanFrameSource`, drains it through the shared `pump()`, and checks
  the marker sink's prefix-only visibility.
- `scan_blf_channels` now returns `BlfScanResult` (channels, frame
  count, first/last timestamp, `start_unix_nanos`, and the file's
  markers projected onto the `Note` shape they'd land in the session
  store as via the existing `note_from_marker`) instead of a bare
  `Vec<u8>`. One scan — still the single header-only walk from 58.A —
  feeds the whole dialog; no second pass was added.
- `open_log` gains optional `start_ns` / `end_ns` and wraps the BLF
  source in `WindowedSource` immediately after the marker sink is
  attached and before the pump thread spawns. Per ADR 0046 the range is
  a filter at the `CanFrameSource` seam, applied on top of the existing
  one-pass import — not a second ingest path. Pinned at the seam by a
  `cannet-gui` test that drives the identical per-frame body `run_pump`
  runs (windowed source → `RawTraceFrame::from` → `route_channel` →
  `TraceStore::append`) against a real disk-backed `TraceStore`: only
  the in-range frames (boundaries inclusive) land in the store. A
  command-level test of `open_log` itself wasn't added — the crate has
  no `tauri::test` mock-`AppHandle` harness, and adding one is a
  dependency-shape decision this phase didn't want to make quietly
  (see Blockers).
- `BlfChannelMapModal` takes the widened scan instead of a bare channel
  list. It shows frame count, duration (`formatElapsed`), and
  wall-clock start (`start_unix_nanos`, i.e. the file's own measurement
  origin, not the first frame) — host facts, frontend formatting, per
  the thin-views rule. A collapsible markers gridview (closed by
  default; markers are rare and the dialog is already busy) is built on
  the shared `useGridview`/`gridviewRows` machinery — the same
  interaction layer the trace, RBS, transmit, and DBC panels use — so
  no bespoke list was written. Start/end numeric inputs (seconds
  elapsed from the capture's first frame) resolve to absolute ns for
  `open_log`; left untouched they resolve to `{ startNs: null, endNs:
  null }` so an unfiltered import stays unfiltered rather than routing
  through `WindowedSource` for a range that happens to match the whole
  file.

## Blockers / side effects

- **The disk-spill segment write is ~43 % of the per-frame ingest
  budget** (0.64 µs/frame of 1.48 at 6.5 M frames, release) — the single
  largest item, and larger than the whole BLF decode. It is owned by
  ADR 0002's store (`cannet-spill`: payload placement, meta encode,
  by-id posting, ring push/pop), so cutting it is a raw-store redesign
  rather than an ingest change, and it was out of this phase's scope.
  Recorded with numbers so the decision to open it is made on data.
- **`RawTraceFrame::bus_id: Option<String>` costs 0.22-0.23 µs/frame
  (~15 %)**, measured directly (full/mem vs mem/nobus). An `Arc<str>`,
  or interning the bus in the trace store the way `DiskRawStore` already
  interns it, would remove the per-frame allocations. There are ~297
  `bus_id` references across `cannet-spill`, `cannet-gui` and the
  serialized derived state, so it is its own slice, not a drive-by.
- **Notes now appear at the end of an import rather than before it
  starts.** Inherent to the one-pass ruling: a file's annotations are
  only fully known when its last object has been read. Nothing depends
  on the old ordering (the frontend reconciles on `notes-changed`), but
  it is a visible behaviour change on a long import.
- **README's `cannet-blf/` module blurb still says "Wraps `blf-asc`"**,
  stale since ADR 0009 retired that wrapper and the crate went native.
  Left alone — unrelated to this change, and fixing it inline would be a
  drive-by.
- **The ADR-0031 perf gate was not run** in this phase, per the phase
  brief; the orchestrator runs it after.
- **A narrowed import's notes stop where the pump's walk stops, not
  where the range does.** `WindowedSource` only filters which frames
  reach the sink; it still calls the inner source for every object up
  to (and including) the one that ends the walk. So a marker sitting
  before `start_ns` is still collected as a session note (the walk
  passes it on the way to the range), while a marker after `end_ns` is
  not (the walk never reaches it — that's the "stop after" rule doing
  its job). This is a direct, faithful reading of "the pump's own walk"
  collecting markers (58.A) composed with "reports end-of-stream past
  the end" (ADR 0046): the marker set a narrowed import ends up with is
  exactly what the walk it actually made passed over. Not called out as
  a requirement either way in the owner rulings, so implemented as the
  simplest composition of the two existing rules rather than adding a
  third pass or a marker-side range filter.
- **No `tauri::test` mock-`AppHandle` harness exists in `cannet-gui`**,
  so `open_log`'s own command body (the `WindowedSource` wrap, the
  thread spawn, the panic/error paths) is exercised by compilation +
  manual code review rather than an automated test that calls the
  command itself. The range filter's *behavior* is fully pinned at the
  `CanFrameSource`/pump seam (`cannet-core`, `cannet-blf`, and a
  `cannet-gui` test that runs the identical per-frame body `run_pump`
  is built from against a real `TraceStore`) — what's untested is only
  the thin wiring inside the command. Adding a mock-`AppHandle`
  dependency to close that gap is a call for a future phase to make
  deliberately, not a drive-by here.
