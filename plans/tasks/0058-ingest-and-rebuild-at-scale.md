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
