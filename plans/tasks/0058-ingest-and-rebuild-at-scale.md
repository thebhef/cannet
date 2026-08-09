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
this: the window closes promptly during a rebuild. The **trace store's**
shutdown flush and `clear_scratch_on_exit` behaviors stay as they are
(owner, 2026-08-08). Amended (owner, 2026-08-09): the *pyramid* flush
58.C added beside them is in scope and must stop blocking exit — dirty
mapped pages are written back by the OS on a normal process death, and
the cost of asking for them synchronously is seconds on the one path
that must never make the user wait. The periodic flusher keeps
exit-time residue small either way.

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

### 2026-08-08 — phase 58.C, item 3 (persist signal pyramids across restore)

Branch `task58c-pyramid-persistence`, off `task58b-import-dialog`
(a1caf96).

| commit | subject |
| --- | --- |
| 89c4c8b | `feat(spill)`: reopen a persisted sample sequence from its length alone |
| e962994 | `feat(gui)`: persist the signal pyramids and the key they are valid against |
| 3c634e5 | `feat(gui)`: reuse a restored capture's pyramids instead of rebuilding them |
| 91477f9 | `test(gui)`: measure the first use after a restore, per signal count |
| b7ce054 | `perf(spill)`: map a whole pyramid set back in one parallel open |

Tests after the slice: `cannet-spill` 61 + 1 ignored (was 57),
`cannet-gui` 512 + 4 ignored benchmarks (was 501 + 4). `cargo clippy
--workspace --all-targets` clean. No frontend code touched — the
restore is host-side and `restore_scratch_capture` keeps its wire shape.

**What landed**

- `SampleSeq::reopen` / `reopen_many` (`cannet-spill`): a persisted run
  maps back from `(len, first_slot)` alone, because the segment chain's
  geometry is deterministic in its length. The sequence still carries no
  manifest of its own; the caller records those two numbers, because the
  caller is what decides validity.
- `SignalCacheStore::persist` / `restore` and a `pyramids.json` manifest
  under the pyramid scratch: one row per cached signal (key, decode
  cursor, all-time extent, each level's `(len, first_slot, folded)`) plus
  the `PyramidValidity` the whole set may be reused against.
- The validity key, and where each part comes from:
  - **capture identity** — a `capture_id` UUID minted on every
    `write_scratch_identity`, i.e. on every capture start, stored beside
    the project id in DS-7's `identity.json`. Stable across relaunches of
    one capture (a reload does not re-identify), distinct for the next.
    Chosen over "project id + frame count" because a frame index only
    means anything within one capture and two captures of a project
    collide on both of those.
  - **DBC set** — an FNV-1a fingerprint over each loaded database's path,
    bus scoping and load position (which is decode priority), plus the
    file's size and mtime, so an edit under an unchanged path invalidates.
  - **eviction low-water** — the raw store's windowed-ring mark.
  - plus one bound checked rather than keyed: no decode cursor may sit
    past the restored store's tip (a crash can persist a pyramid ahead of
    the raw store's last flush, and a cursor past the tip never revisits
    the frames it skipped).
- Lifecycle: `restamp_scratch_for_capture` now wipes the pyramids, so a
  BLF import — which starts its session inside the pump, not through
  Clear — wipes them too (it previously did not, which persistence would
  have turned from a latent hole into a wrong plot). `clear_trace_store`
  drops its own now-duplicate wipe.
- `invalidate_derived_caches` calls the new `invalidate_dbcs` instead of
  `clear`. It drops the live decode state exactly as before but leaves an
  unjudged *staged* set alone. **This is the one judgement call in the
  phase**: the boot sequence loads a project's DBCs before it restores
  that project's capture, so the old unconditional wipe would have made
  reuse impossible in every real launch. A staged set is not decode state
  — it is a candidate whose own recorded DBC fingerprint is part of the
  check — so the `app_state.rs` invariant holds in substance, and the
  regression at `tests.rs:770+` stays green untouched. Once adopted, a
  set is live like any other and the next DBC change wipes it.
- ADR 0047 records the decision, the key, the two lifecycle rules and the
  rejected alternatives; ADR 0002's on-disk table points at it.

**The measurement**

Harness: the existing `bench_first_use_rebuild`, extended (not replaced)
with the restore arm — persist, reopen the cache store on the same root
as a launch does, restore, serve the same windows — and with a
`CANNET_BENCH_SIGNALS` dimension beside the existing
`CANNET_BENCH_FRAMES`. Synthetic capture, one message per signal, the
capture round-robining them. Run with:

```sh
CANNET_BENCH_SIGNALS=96 cargo test -p cannet-gui --release \
    bench_first_use_rebuild -- --ignored --nocapture
```

Release, 4 M synthetic frames, first use of *every* signal:

| signals | rebuild | restore + serve | speedup |
| --- | --- | --- | --- |
| 1 | 1.77 s | 0.15 s | 11.5× |
| 32 | 2.35 s | 1.36 s | 1.7× |
| 96 | 3.61 s | 2.87 s | 1.3× |

Release, 96 signals, against capture length — the number that matters,
because it is the *shape* not the ratio at one size:

| frames | rebuild | restore + serve |
| --- | --- | --- |
| 1 M | 1.71 s | 1.99 s |
| 4 M | 3.61 s | 2.87 s |
| 16 M | 9.80 s | 4.51 s |

The rebuild is `O(capture)`; the restore is `O(pyramid segment files)`,
which grows with the *points* a signal has (level-0 segments cap at
65 536 entries), not with the frames scanned to find them. Over 16× the
capture the rebuild grows 5.7× and the restore 2.3×, so the two diverge
and keep diverging.

Debug build (the regime 58.A showed the reported multi-minute symptom
lives in), 1 M frames over 96 signals: rebuild **5.63 s**, restore +
serve **1.87 s** — 3.0×. Extrapolating the linear rebuild to the
reference workload's 6.5 M frames puts a dev-build relaunch at ~37 s of
rebuild against a restore that stays around 3 s.

**A negative result, and the cut it forced.** The first working version
made the launch *slower*: at 4 M frames over 96 signals the restore took
**13.76 s** against a 3.38 s rebuild.

- *Hypothesis.* The restore is not doing decode work, so its cost is the
  segment-file `mmap`s — and they were being issued one pyramid *level*
  at a time, so `open_segments`' 16-way widening (added for the raw store
  because mapping a just-written file on Windows is ~14 ms of pure
  waiting) ran at a width of about four.
- *Experiment.* Batch every level of every signal into one
  `open_segments` call and re-run the same three signal counts.
- *Data.* 96 signals at 4 M frames: 13.76 s → 3.06 s. 32 signals:
  4.86 s → 1.35 s. 1 signal (already one batch, so the control): 0.21 s →
  0.15 s, inside noise.
- *Conclusion.* Confirmed: ~4.5× where the batch is wide, nothing where
  it isn't. `SampleSeq::reopen_many` is that batch; `reopen` is it with
  one run. The remaining ~1 ms/file is the crate's documented 16-way
  floor, not decode.

### 2026-08-08 — phase 58.D, item 4 (one decode pass per message)

Branch `task58d-decode-sharing`, off `task58c-pyramid-persistence`
(db8ef07).

| commit | subject |
| --- | --- |
| 87cc507 | `test(gui)`: pin the per-signal decode semantics of a catch-up |
| ad1e362 | `perf(gui)`: catch a message's signals up in one decode pass |
| 7c052ed | `test(gui)`: measure a first-use rebuild per signals-per-message |
| 4d5a6ab | `docs(gui)`: cite the first-DBC-wins rule where it is actually stated |

Tests after the slice: `cannet-gui` 522 + 4 ignored benchmarks (was
512 + 4). `cargo clippy -p cannet-gui --all-targets` clean. No other
crate and no frontend code touched — `sample_signals` and
`signal_min_max` keep their wire shapes; the change is entirely behind
them.

**What landed**

- `signal_sampler::sample_shared` — decode one frame **once** for
  several signals of the same message, writing one `Option<f64>` per
  requested name into a caller-owned scratch buffer (so a per-frame
  loop allocates nothing). It replaces `sample_one`, which decoded the
  whole message and kept one value.
- `catch_up_group_chunked` — the catch-up scan, now over a *group* of
  targets sharing a `(message_id, extended)`. It keeps the chunked
  walk 58.C's first-use work depends on, and keeps three things per
  target through the shared pass:
  - **provenance**: each name takes the first loaded database that
    yields *that name*, so where two databases overlap on a message,
    two of its signals still resolve to two different databases;
  - **bus scoping**: the filter is the target's, so two series on one
    id scoped to different buses keep their own frame sets;
  - **cursors**: the scan starts at the group's `min(next_index)` and
    the frame index each fetch returns — previously discarded — gates
    each target, so a series joining a message already being plotted
    reads the whole history while the incumbents append nothing twice.
- `SignalCacheStore::slice_many` / `min_max_many` take the batch the
  two commands already had, group it, and catch each group up once.
  `slice` / `min_max` remain as the one-query form (a group of one),
  which is exactly what the catch-up did before — so the equivalence
  arm and the old benchmark shape are both still expressible.

**The red-green anchor, and its falsification**

The equivalence test came first and is the bar: over a capture mixing
two overlapping databases, bus tags, a multiplexed message, an extended
id and undecodable frames — longer than one scan chunk — the grouped
path must produce the same served windows *and* the same pyramids as
catching each signal up alone: every level slot for slot, plus the fold
cursors, decode cursors and all-time extents.

- *Hypothesis.* The tests pin the hazard they claim to: a shared pass
  that resolved one database per **message** would be caught.
- *Experiment.* Break `sample_shared` to stop at the first database
  that decodes the message, and run the suite.
- *Data.* Six tests fail — the equivalence anchor, both provenance pins
  (cache-level and sampler-level), the heterogeneous-cursor test, the
  group fetch-count test, and the mid-capture-join test.
- *Conclusion.* The pins are live, not decorative. Reverted; suite green.

**The measurement**

`bench_first_use_rebuild`, extended (not replaced) with a
`CANNET_BENCH_SIGNALS_PER_MSG` dimension — the same signal count packed
into fewer, wider FD messages, which is the cell-style shape this item
was groomed from — and with **both** arms over one capture: the shared
pass a plot fetch runs, and the same signals caught up one at a time
(the catch-up before this change). The arms assert equal series before
their times are compared, so the ratio is over identical output. The
shared arm runs first, on cold pages, so the ratio is a lower bound.

```sh
CANNET_BENCH_FRAMES=2000000 CANNET_BENCH_SIGNALS=96 \
CANNET_BENCH_SIGNALS_PER_MSG=16 cargo test -p cannet-gui --release \
    bench_first_use_rebuild -- --ignored --nocapture
```

Release, 2 M synthetic frames, 96 signals, first use of every signal:

| signals/message | per signal (before) | shared pass (after) | speedup |
| --- | --- | --- | --- |
| 1 (control) | 2.90 s | 2.97 s | 1.0× |
| 4 | 8.59 s | 3.94 s | 2.2× |
| 16 | 73.93 s | 10.85 s | 6.8× |

The control is the point: at one signal per message a group has one
member and there is nothing to share, so the two arms measure the same
work and agree inside noise. The win is the *repeat* — at 16 signals
per message the old path fetched each frame 16 times and fully decoded
it 16 times, keeping one of 16 values each pass.

It is not 16× because a decode is not the only cost, and because
`decode_raw` decodes every signal of the message either way: the shared
pass still does 16 signal-decodes per frame, it just does them once
instead of 16 times. The residue is the fetch, the per-frame filtering
and the 16 pyramid appends, which are paid per signal in both arms.

Debug build (the regime 58.A showed the reported multi-minute symptom
lives in), 200 k frames, 96 signals at 16 per message: per signal
**110.03 s**, shared **13.91 s** — **7.9×**. Both arms are linear in
capture length, so the ratio is the number that carries; the absolute
figures do not extrapolate to the reference capture, because this
synthetic puts *every* frame on one of the six plotted messages while a
real capture's plotted messages are a fraction of its traffic.

The restore arm (ADR 0047) is measured beside it and now looks better
at the realistic shape than 58.C's log expected: at 16 signals per
message, restore + serve is 5.61 s against the 10.85 s shared rebuild
(1.9×), where at 1 signal per message the two are level (2.92 s vs
2.97 s). 58.C predicted this item would *narrow* the persistence's
margin; over wide messages it widens it instead, because a wider
message makes the rebuild more expensive per frame while the restore
is `O(pyramid segment files)` regardless.

### 2026-08-09 — phase 58.E, item 5 (rebuild off the global signal-cache mutex)

Branch `task58e-cache-lock-split`, off `task58d-decode-sharing`
(026fc01).

| commit | subject |
| --- | --- |
| c6173bc | `test(gui)`: drive the catch-up's fetch seam through the cache store |
| a91f2ed | `perf(gui)`: fetch and decode a catch-up chunk off the cache lock |
| cd9e65f | `perf(gui)`: run the sampling commands off the async runtime's workers |
| 384bd17 | `perf(gui)`: stop blocking exit on a synchronous pyramid flush |
| 4ad1a11 | `test(gui)`: report what a quit now costs the pyramid scratch |

Tests after the slice: `cannet-gui` 525 + 4 ignored benchmarks (was
522 + 4). `cargo clippy --workspace --all-targets` clean. No other crate
and no frontend code touched — `sample_signals` and `signal_min_max`
keep their wire shapes, and `slice` / `slice_many` / `min_max` /
`min_max_many` keep their signatures; only `persist` lost a parameter.

**What landed**

- **The catch-up became plan / scan / apply, per chunk.** The scan
  (`scan_chunk`) fetches a chunk's frames and decodes them for the whole
  message group **holding no cache lock**; the lock is taken to read the
  cursors before it and to append, advance and fold after it. So the
  longest uninterrupted hold went from a whole rebuild — minutes — to
  one chunk's appends, and two cold areas decode in parallel because the
  decode holds nothing. The trace-store fetch also moves off the cache
  lock, so the two locks are no longer nested.
- Two invariants had to be re-established, because a plan can now go
  stale under its own pass:
  - each decoded sample carries the **store frame index** it came from,
    so the append re-applies the per-target cursor gate against the
    cursor as it stands *then* — a frame another pass already covered is
    dropped, never appended twice;
  - a **`generation` counter** on the cache set, bumped by `clear`,
    `invalidate_dbcs`, `reroot` and `restore`. A pass whose generation no
    longer matches discards its chunk instead of appending it, so
    `reroot`'s "root and caches move together" holds unchanged and a
    cleared set can never be re-populated by a rebuild that outlived it.
  - Evict atomicity survives for free: an `evict_below` that slots in
    between two chunks runs entirely under the lock, and
    `SignalCache::evict_below` already clamps `folded` up to the new
    floor, which is the case it was written for. So is the manifest: an
    apply is atomic, so `persist` can only ever observe a chunk boundary.
- **The sampling commands run on the blocking pool.** They were `async
  fn`s that never awaited, so a cold rebuild held the async worker that
  polled it. This is the exit-hang mechanism the item names: with one
  such command per plotted area the runtime ran out of workers and the
  close handler's `rbs_dirty` was never dispatched, so `destroy()` was
  never reached. `off_async_workers` hands both bodies to
  `spawn_blocking`.
- **The shutdown pyramid flush is gone** (the flag 58.C left for this
  phase). The manifest is still written at exit — it is a small JSON file
  through the normal file API — but the level files' dirty pages are left
  to the OS writeback, the same DS-2 relaxation the raw store's periodic
  flush takes. `persist`'s `sync` parameter and
  `SignalCache::flush_levels` went with it. The trace store's own
  synchronous shutdown `flush()` and `clear_scratch_on_exit` are
  untouched (owner non-goal).
- ADR 0048 records the rule — *no model lock is held across work whose
  duration scales with the capture* — with the per-entry-lock alternative
  and why bounding the hold was chosen over it. ADR 0047 gains the
  exit-flush decision and names its residual exposure.

**The exit contract, and how it was falsified**

Three would-block probes, each written so a regression *fails* rather
than hangs: a channel `recv_timeout` decides the assertion, and the
blocked rebuild is released either way so every thread joins.

- `a_cold_rebuild_in_one_area_does_not_block_another` — with a rebuild
  of message 256 parked inside its first chunk fetch, another area's
  `slice`, its `min_max` and the flusher's `evict_below` must all
  complete on their own; the rebuild must then still finish whole.
- `the_exit_path_does_not_wait_for_a_cold_rebuild` — same setup; the
  manifest write (`needs_persist` + `persist`) and the whole-cache
  `clear` must complete. Afterwards the cleared set is empty and the
  abandoned rebuild left no file behind it.
- `a_command_body_that_never_yields_does_not_park_an_async_worker` —
  a one-worker tokio runtime with a never-returning command body in
  flight must still dispatch a second command.

Hypothesis → experiment → data → conclusion:

- *Hypothesis.* The probes pin the defect they claim to, rather than
  passing for incidental reasons.
- *Experiment.* Move `scan_chunk` back under the cache lock (the 58.D
  hold, reconstructed in one line); separately, run the command body
  inline instead of on the blocking pool. Run the three probes.
- *Data.* All three fail, each on its own timeout: "another area's
  sampling, min/max and eviction waited for the rebuild", "the exit path
  waited for the rebuild", "a command running a capture-scaled body held
  the only async worker". 30 s each, i.e. they never finished — the
  rebuild is only released after the timeout.
- *Conclusion.* The probes are live. Both experiments reverted; suite
  green.

**The measurement**

Two numbers were checked: what a quit now costs, and whether the extra
buffering the split introduces costs throughput.

*Exit.* The same `bench_first_use_rebuild` call 58.C timed — the
shutdown persist at 96 signals — now takes **3-4 ms**, twice in a row,
against the **7.8-14.3 s** (pyramid built moments before) / **0.7-1.8 s**
(warm) that call measured with the synchronous level flush in it. Three
orders of magnitude, far outside any run-to-run effect.

*Throughput.* Release, 2 M synthetic frames, 96 signals at 16 per
message, two consecutive runs:

| arm | run 1 | run 2 | 58.D, same parameters |
| --- | --- | --- | --- |
| shared pass | 16.32 s | 14.59 s | 10.85 s |
| per signal | 106.15 s | 102.64 s | 73.93 s |
| restore + serve | 6.67 s | 4.93 s | 5.61 s |
| shared vs per-signal | 6.5× | 7.0× | 6.8× |
| working set | 348 B/frame | 348 B/frame | 347 B/frame |

**58.D's absolute figures are not reproducible in this session and the
cross-session comparison is not usable as a before/after.** Every arm is
slower, including the restore arm, which runs *none* of the changed code
(a restored cache's cursor is already at the tip, so its serve is pure
`window()` over mapped pages) — and its own run-to-run spread here is
26 %. What is stable is the ratio the 58.D log said carries: 6.5× and
7.0× against 6.8×, so the decode-sharing win is intact.

The overhead the split could add is bounded and small by construction:
one 24-byte buffer write and read per *appended sample*, on buffers
reused across chunks. At 96 signals over 2 M frames that is ~32 M
samples, so ~0.3 s of a ~15 s rebuild — well under this harness's
measured spread, and consistent with the working-set delta being
unchanged (348 vs 347 B/frame), which is the direct evidence that a
chunk's buffers add nothing to residency.

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
  brief; the orchestrator runs it after. *(58.A)*
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
- **The shutdown's synchronous pyramid flush is the single most
  expensive thing 58.C added to exit**, and it lands in the same area
  item 5 is about. Measured at 96 signals: **7.8-14.3 s** when the
  pyramid was built moments before quitting (every page still dirty), and
  **0.7-1.8 s** on the second consecutive sync — which is what a real
  exit pays, because the pyramid is normally built long before the user
  quits and the OS has written it back by then. It is there for
  consistency with the raw store's own shutdown `flush()` (ADR 0002
  DS-2): it is the one moment a clean guarantee is available, and without
  it a power loss shortly after quit could leave a manifest pointing at
  pages that were never written — a pyramid that passes its validity key
  and serves zeros. The cheaper alternative (async, leaving writeback to
  the OS modified-page writer, which is what `Segment::queue_writeback`
  already does on Windows for every other scratch family) trades that
  guarantee for ~1 s of exit. **Flagged rather than decided**: if 58.E's
  exit contract makes that second matter, the argument for dropping to
  async is that the pyramid is derived state and a torn one costs a
  rebuild, not data. It is also the one place 58.C brushes the non-goal
  "no change to shutdown flush semantics": the trace store's own
  `flush()` is untouched, but a second, separate flush now runs beside it
  in the same exit hook. The periodic tick alone would persist the
  pyramids; the shutdown call is only there for the guarantee, so
  dropping it is a one-line change if the non-goal is read strictly.
  **Resolved in 58.E**: dropped. The manifest is still written at exit;
  the level flush is not. ADR 0047 records the decision and names the
  residual exposure (a power loss between quit and OS writeback costs a
  rebuild of derived samples, whose raw frames were flushed
  synchronously on the same exit).
- **The restore's floor is now segment-open latency, not decode.** ~1
  ms/file at `open_segments`' documented 16-way width, ~33 files per
  plotted signal on a 4 M-frame capture — so ~3 s for 96 signals. Two
  ways further down exist and neither was taken here: widen the parallel
  open for large batches (it is a *latency*-bound wait, so width scales
  almost linearly, but the 16-way constant is a measured tuning decision
  for the raw store and retuning it belongs with its own measurement), or
  make the restore lazy per signal (validate the manifest at restore,
  map a signal's levels on its first serve) so a launch pays nothing and
  each plotted signal pays one batched open. The lazy version is the
  better design but needs a pending-rows state that interacts with
  eviction — the eviction cascade can advance while a row is unmapped, so
  the floor has to be carried and applied at map time. Deliberately left
  out of this phase's scope.
- **The 96-signal ratio in the synthetic is only 1.3× in a release
  build**, which reads as underwhelming next to "minutes → seconds". It
  is an artefact of the harness, not of the feature: the synthetic
  decodes one 16-bit signal out of an 8-byte payload, so its rebuild is
  0.009 µs/frame/signal, an order of magnitude cheaper per frame than the
  reference workload's cell messages. The honest statements are the two
  the data does support — the rebuild is `O(capture)` and the restore is
  not (16× the capture: rebuild ×5.7, restore ×2.3), and in the debug
  regime where the reported symptom lives the ratio is 3.0× at 1 M frames
  and grows linearly from there. Item 4 (one decode pass per message)
  will cut the rebuild side further and narrow this ratio again — that is
  expected and does not undermine the persistence, which removes the work
  rather than speeding it up.
- **`clear_scratch_on_exit` and the pyramids.** With the setting on, exit
  runs `clear_trace_store`, which now wipes the pyramids through
  `restamp_scratch_for_capture` — correct (there is no capture to come
  back to) and no change in kind, but worth naming since that path no
  longer touches `signal_caches` directly.
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
- **The signal-cache mutex is now held for a whole batch, not a whole
  signal.** The catch-up work per fetch dropped 6.8× at the reference
  message width, but a fetch used to take and release the lock once per
  queried signal, and now takes it once for all of them. So the *total*
  hold is much shorter while the single longest uninterrupted hold is
  longer: another view's `min_max`, or the flusher's `evict_below`, used
  to be able to slot in between two signals of a cold rebuild and no
  longer can. This is squarely item 5's territory (per-key / per-message
  locking, or rebuilding outside the map lock) and it is flagged here so
  58.E sizes the hold it has to break up correctly: it is one batch of a
  plot fetch, not one signal. **Resolved in 58.E**: the hold is now one
  chunk's appends, below either shape.
- **`decode_raw` still decodes every signal of the message**, so the
  shared pass removes the *repeat* but not the width: a 16-signal
  message costs 16 signal-decodes per frame even for a view plotting
  one of them. Measured in the same run — 0.015 µs/frame/signal at one
  signal per message against 0.057 at sixteen, both shared. Cutting
  that needs a decode entry point that extracts only the requested
  bits, which is a `cannet-dbc` change and interacts with the
  multiplexor (the selector has to be decoded either way). Out of this
  phase's scope; recorded with the numbers so the decision is made on
  data.
- **The shared pass keeps a whole message group's pyramid levels hot at
  once.** The benchmark's working-set delta over the shared arm grows
  with message width — 27 B/frame at one signal per message, 347 B/frame
  at sixteen (release, 2 M frames). That is the pyramid bytes the pass
  writes (sixteen 16-byte points per frame) landing in sixteen mapped
  level files simultaneously rather than one file at a time across
  sixteen sequential passes; the chunked scan still bounds the
  *materialized frames* exactly as before. Only the shared arm is
  sampled, so the comparison with the per-signal arm's residency is
  reasoned, not measured. They are mapped pages, so the kernel reclaims
  them under pressure — named because it is a real change in shape, not
  because it is known to hurt.
- **`signal_sampler::sample_signal` is now the only entry point in that
  module with no production caller** — it was already reached solely by
  its own tests before this phase, and removing pre-existing dead code
  is not this change's business (working agreement, § Surgical changes).
  `sample_one`, which *this* change orphaned, was removed with its test
  replaced by two on `sample_shared`.
- **A concurrent caller can now observe a series mid-rebuild.** A serve
  that slots in between two chunks sees the points decoded so far, where
  it previously waited and saw the finished series. That is the direct
  consequence of bounding the hold, and it is the direction item 6 wants
  — but it means *no caller may infer completeness from a non-empty
  result*. Nothing does today (the plot re-fetches on every tick and the
  cache is authoritative on the next call), and 58.F is where the
  completeness token that makes it explicit belongs.
- **A rebuild interrupted by a clear / re-root / restore loses its
  in-flight chunk's work.** Up to one chunk of fetching and decoding is
  discarded rather than committed. It is not corruption — the cursors
  never moved, so the next serve re-reads the same range — but it is
  wasted work that the previous design could not produce, because the
  clear could not happen until the rebuild had finished.
- **The chunk's decoded samples are buffered before they are appended.**
  Bounded by `CATCH_UP_CHUNK_FRAMES` × the group's target count × 24 B —
  ~6 MB on a 16-signal message, on buffers reused across chunks — and it
  did not move the benchmark's working-set delta (348 B/frame against
  58.D's 347). Named because it is a new allocation that scales with
  message width, not because it is known to hurt.
- **58.D's absolute benchmark figures did not reproduce in this
  session.** Every arm of `bench_first_use_rebuild` at identical
  parameters is 1.2-1.5× slower than 58.D recorded, *including* the
  restore arm, which runs none of the changed code. Its own run-to-run
  spread across two consecutive runs was 26 %. So this harness's absolute
  numbers are not comparable across sessions on this machine and only
  within-session ratios should be quoted from it; a future phase wanting
  an absolute before/after has to run both arms back to back in one
  session. The ratio 58.D said carries (shared vs per-signal) is stable
  at 6.5-7.0× against its 6.8×.
- **The exit-during-rebuild contract is verified at the seam, not in the
  running app.** The three probes drive the cache store and a tokio
  runtime directly; nothing here launches the GUI and closes its window
  during a rebuild. The gap is the same one 58.B recorded — there is no
  `tauri::test` mock-`AppHandle` harness in `cannet-gui`, so the command
  bodies and the `RunEvent::ExitRequested` hook are exercised by
  compilation and review rather than by a test that calls them. What is
  pinned is every mechanism the item named: the lock hold, the manifest
  write, the clear, and the async-worker starvation.
- **The ADR-0031 perf gate was not run** in this phase, per the phase
  brief; the orchestrator runs it after. *(58.D, 58.E)*
