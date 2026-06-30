# Task 18 — Indefinite-Length Capture (Disk-Spill)

Capture indefinite-length (10^7–10^9 frames, multi-hour→multi-day): spill raw
frame store to disk, every historical row still addressable. Req
[ADR 0001](../../docs/adr/0001-indefinite-length-capture.md) (random-access,
loss-free); on-disk format + I/O **normative**
[ADR 0002](../../docs/adr/0002-disk-spill-store.md). Model-side twin of the
frontend windowed-source: 2nd impl of `RowPage`/`DecimatedRange`
([ADR 0025](../../docs/adr/0025-frontend-windowed-source-contract.md)) — no
contract/view change. Disk-spill store = live working store (ephemeral
scratch), not export; explicit `.blf` "Save Capture" separate.

ADR 0002 (DS-1..DS-8):

- **DS-1** raw store = 2 append-only files: fixed 27 B meta records (arithmetic
  random access) + packed payload blob.
- **DS-2** write-through; readers mmap (page cache = hot tier) + RAM ring
  bridges un-flushed tail. periodic flush async msync, sync flush clean shutdown.
- **DS-3** by-id + per-filter indexes = mmap files. every predicate
  id-narrowable vs DBC → no O(capture) index build.
- **DS-4** every family = fixed pre-allocated segments mapped whole + valid-len
  watermark (the reopen manifest).
- **DS-5** decoded-signal cache = per-signal min/max resolution pyramid.
- **DS-6** disk store = only prod path; in-RAM `Vec` → test double.
- **DS-7** scratch = single `current/` dir under OS cache dir. wiped only when
  session buffer is (Clear / Start), never exit/crash → prior session at launch
  loads as stopped historical trace.
- **DS-8** opt-in scratch cap (bytes, default unbounded). over-cap =
  drop-oldest windowed ring: one low-water mark rises, every family front-trims
  segments below it. relaxes DS-1 random-access below mark. DS-1..7 hold when
  cap unset.

## Status (branch `0018-disk-spill-11`, not merged)

- **Step 1 done** — `cannet-spill`: `RawStore` trait, `MemRawStore` (double),
  `DiskRawStore` (mmap meta+payload + RAM ring). gui `TraceStore` = thin facade
  over `Box<dyn RawStore>`.
- **Step 2 done** — `ByIdIndex`: per-id append-only mmap posting lists,
  geometric segments (64→65536 doubling).
- **Step 3 done** — `FilterIndex` (membership + build + `page` +
  `built_through`) + gui `filter::resolve_candidates`. `CandidateSource` seam +
  `refresh_filter_index`. perf `filter-bench`.
- **Step 4 done** — `SignalCacheStore` per-signal min/max pyramid (L0 raw
  decoded; Ln = per-bucket min/max over `PYRAMID_BRANCH`=8). `slice(max_points)`
  serves coarsest level > budget → O(max_points). perf `signal-bench`.
- **Step 5 done** — disk store live in prod + filtered-fetch on filter index +
  DS-7 scratch lifecycle.
  - **5.1** — `AppState` boots `TraceStore::new_disk(<OS cache>/cannet/current)`;
    RAM-store fallback if scratch unavailable. `dirs` dep.
  - **5.2** — `fetch_filtered_trace` from filter index, not scan.
    `ActiveFilterIndex` keyed `(predicate, session_start_ns)`; window →
    match-position via 2× `FilterIndex::position_of`; page = random-access
    slice. O(log n + page). old scan helpers retired.
  - **5.3a** — persistent watermark + reopen (spill only). `flush` writes
    `manifest.json` (version, DiskConfig, len/payload_cursor, bus_intern, by-id
    dir). `reopen(dir)` remaps without truncate, rebuilds by-id from len
    (geometry deterministic), refills ring from tail. `serde`/`serde_json` dep.
  - **5.3b** — `project_id: Uuid` on `Project` (additive serde-default field, no
    schema bump — `transmit_frames` pattern). `save_project` anchors id to
    target file. `uuid` dep.
  - **5.3c-i** — durability cadence. `TraceStore::flush` + `spawn_trace_flusher`
    2 s (`TRACE_FLUSH_TICK`), skip tick if buffer not grown. flush incremental
    (only segments dirtied since last; `flushed_*` watermark) + async
    (`msync MS_ASYNC`), sync only clean shutdown. `flush_ms`/`tx_late_ms`
    ADR-0031 gate.
  - **5.3c rest** — boot stops wiping (`open_empty` preserves files). facade
    owns `scratch_dir`, writes `identity.json` (project_id, on start) +
    `derived.json` (session_start_ns + per-key newest-index/count, on flush).
    derived = persist, NOT rebuild-from-by-id (would collapse same-id-multi-bus,
    by-id keyed `(id,ext)` only). gate: `open_project`→`try_reload(project_id)`
    swaps store + restores derived + records `active_project_id`. reset on
    Clear/Start via `restamp_scratch_for_capture`. frontend
    `restore_scratch_capture` + open-path ordering (ADR 0033: DBCs→RBS→views→
    replay, each awaited).
  - **5.3d** — disk-back pyramids. `cannet-spill::SampleSeq` (append-only (t,v)
    f64 pairs, geometric mmap chain, 16 B records). pyramid = `Vec<SampleSeq>`
    under `current/signals/`. derived → no manifest, rebuilt from reopened
    frames on serve.
  - **5.3e** — notes persist with scratch
    ([ADR 0035](../../docs/adr/0035-timeline-event-model.md)).
    `NotesStore::with_scratch(dir)` rewrites `current/notes.json` on **every
    edit** (not flush cadence — stopped trace gets no flush). restored in open
    gate, wiped on Clear/Start. BLF path unchanged.
- **Step 6 in progress** (6a–6f done, 6g partial) — scratch cap + windowed-ring
  eviction. cap = total `current/` footprint (raw + by-id + filter + pyramids).
  drop-oldest front-trim to shared low-water mark, never rebuild.
  [ADR 0034](../../docs/adr/0034-settings-vs-state-and-custom-settings-panel.md)
  settings, ADR 0002 DS-8.
  - **6a done** — settings infra. `prefs`/`preferences.json` →
    `state`/`state.json` (`Prefs`→`UiState`, `get/set_prefs`→`get/set_state`,
    frontend `hostState`). new `settings.rs`/`settings.json` (user intent):
    `scratch_cap_bytes` (null), `clear_scratch_on_exit` (false), every key
    serialized. flat hand-rolled `SettingsPanel` (no schema-form dep; @rjsf
    stays rejected). palette `project.close`, `app.exit`.
  - **6b done** — low-water mark + evicted-read contract across all 3 trimmable
    chains (raw, pyramids, filter) BEFORE any trim. raw `first_index` floor
    (`read_frame`/`read_ts`→None below); pyramid per-level `first_slot`
    (`evict_below`, partition clamps); filter `first_pos`. mark set only in tests
    here. 3 tests.
  - **6c done** — raw windowed-ring eviction + retention overlay.
    `DiskRawStore::evict_below(first_index)` drops sealed meta/payload segments
    fully below mark, deletes files; `meta_seg_base`/`payload_seg_base` keep
    indices absolute; mark in manifest. host raises mark on flush when footprint
    > cap. **6c-C eager overlay** `latest_frame: HashMap<FrameKey,
    RawTraceFrame>` on every append (one clone, id-space-bounded) → global
    latest-by-id read serves it, evicted index never blanks grid row; rides
    `derived.json`. + evict-before-flush manifest fix.
  - **6d done** — per-id/derived front-trim closes cap. by-id trim in
    `evict_below` (per-id `first_slot`/`seg_base`, manifest v3);
    `SampleSeq`/`SignalCacheStore::evict_below(ts)` pyramid trim by truncation
    time; `FilterIndex::evict_below` (drop segs + `first_pos` + `seg_base`).
    flusher drives all when `low_water` advances. filtered view needs no
    frontend change (`traceWindow` clamp covers).
  - **6e+6f done (merged)** — timeline-event model
    ([ADR 0035](../../docs/adr/0035-timeline-event-model.md)). frames stay
    index-paged; events = separate fetch-whole channel, merged at view by ts
    (`Frame|Event` base). (1) truncation marker (derived, non-persisted,
    non-exported floor row + plot cursor, moves with mark); (2) events
    interleaved into chronological trace (`eventMerge.ts`) + singleton
    `EventsPanel`; (3) name+colour edit end-to-end (`notes.rs` `kind`+`color`,
    BLF `foreground_color` round-trip, inline edit). cross-panel goto
    (`gotoEvent.ts`). one timestamp origin (`frame.ts − session_start` elapsed,
    `formatElapsed`; plot x-origin = session start). live-window legibility
    precursor: `first_index` on `trace-grew` + `traceWindow` clamp fixes
    blank-placeholder rows.
  - **6g partial** — honest residency metric. status-line pairs `scratch_bytes`
    (store on-disk, pre-allocated incl. zero-pad + cold) + `mem_bytes`
    (whole-process RSS) — NOT complementary (mapped pages counted in both; RSS =
    whole host). replace RSS half with store resident estimate (mapped-resident
    bytes, or RAM-ring + working-window proxy). *done:* status reads "retained of
    total frames" off `count − firstIndex`. *open:* residency metric, label
    `RAM`→`host`, pyramid count not depth, split `other` (by-id/filter/JSON).
- **Step 7 not started** — benchmark: scroll/filter/plot deep history
  < 100 ms / 60 fps @ 10^8+ frames. arm ADR-0031 frontend-memory baseline
  (deep-history run). confirm disk-backed-pyramid residency vs flat host RSS.

**Cap bug fixed (6c).** cap check measured whole-dir footprint but handed whole
excess to raw-only `evict_oldest_bytes` → over-evicted raw to protected tail
(retained ~0). fix: scale request by raw share (`raw_disk_bytes`/footprint).
test `cap_eviction_does_not_over_evict_raw_for_derived_family_footprint`. +
`trace-grew` `len_and_low_water()` one lock (was 2 → spurious "0 of N"). + **min
effective cap** `MIN_SCRATCH_CAP_BYTES = 100 MiB` (`floored_scratch_cap`, ADR
0002 DS-8): small caps thrashed (floor ~17 MiB = 1 payload seg + 1 filter seg +
never-evictable tail).

**Trim = pure front-truncation.** drop whole leading segment files, raise floor,
bump base offset; surviving rows keep absolute index; no rewrite / compaction /
re-index. zero per-frame work on drop (eager overlay pays one clone/append
instead).

Tests @ latest: spill 46, gui 248, frontend 467, clippy + tsc clean.

## Key decisions

- DS-4 watermark = reopen manifest (JSON not binary footer — tiny,
  id-space-bounded, serde keeps (de)ser off hand-written surface,
  human-inspectable).
- by-id chains rebuild from len alone (`seg_capacity(i)` deterministic; shared
  helper removed latent left-shift overflow at 58+ segments).
- project-identity gate = host concern, not spill manifest (`cannet-spill` stays
  project-ignorant).
- filtered-fetch `prev_count`/`prev_count_end` now vestigial (filter index gives
  exact count O(log n)); kept for IPC compat, drop later.
- filter index build holds `databases` lock for duration (one-time deep build
  briefly blocks DBC add/remove; steady extends O(delta)).
- `memmap2` unsafe contained to `cannet-spill` (relaxes workspace
  `unsafe_code=forbid`→deny + per-site allow); every other crate unsafe-free.
- DS-6 trait = `RawStore` behind `TraceStore` facade (1 prod store, 1 double,
  derived state written once in facade).
- bus predicates id-narrowed via "ids seen on bus" (from newest-per-key map), no
  by-bus index; per-frame `bus_id` test keeps multi-bus correct.
- meta record 27 B (DS-1 "~26"), extra byte = explicit `channel`.
- DS-5 pyramid = property of decoded *signal* not plot (`signal-bench`).
  serve-cost bound O(max_points); residency bound = disk-backing (5.3d, lazy
  rebuild not pyramid manifest).

## Exit criteria

- capture past RAM, no row unreachable; scroll/filter/plot deep history work.
- `RowPage`/`DecimatedRange` sigs (ADR 0025) unchanged — only host impl swapped.
- `fetch_trace_range`/`fetch_by_id_page` w/ predicate O(page), no O(capture)
  scan in any index build.
- plot fit-data over 10^9 capture doesn't re-decode whole.
- disk store = only prod `TraceStore`; `Vec` = double.
- benchmark: GUI < 100 ms / 60 fps @ 10^8+ frames.
- scratch cap wired through settings panel; over-limit in ADR-0002 + System
  Messages.
- backlog removed: TraceStore disk-spill, index filtered scan, bound
  decoded-sample cache.
- README documents indefinite capture + limits; rustdoc on `TraceStore` trait +
  disk impl; ADR 0002 + `memmap2` inventory reflect shipped.

## Fixed: periodic-flush lock contention

**Problem.** `flush` (`TRACE_FLUSH_TICK`=2 s) held append lock 80–145 ms
fsync'ing every segment + manifest. ingest/transmit append through it → TX
scheduler ~110 ms late every 2 s (periodic TX/RX stutter, invisible to per-sec
fps, retention 1.0). confirmed: tick→10 s moved stall→10 s 1:1.

**Fix.** incremental flush (only segments dirtied since last, O(segs)≈1) + async
msync (`MS_ASYNC`/`FlushViewOfFile`, not fsync; sync only clean shutdown).
detect: `flush_ms`/`tx_late_ms` gated on **mean** ≤25/≤18 ms (ADR-0031). result:
pre-fix 38/27 → post-fix 15/8.6; 1200 s/1.23 M soak 9.8/5.2, retention 1.0.

**Deferred — off-lock manifest/derived writes.** residual `flush_ms` peaks
~68 ms = manifest + derived write + ~20 per-id msyncs under lock. two-phase:
locked = async-msync dirtied segs + snapshot manifest inputs; unlocked =
serialize+write (temp+rename). safe: appends only append → off-lock manifest
names durable prefix, reopen tolerates undercount. needs
`flush_segments(sync)`+`manifest_bytes()` split + `flush_with`
snapshot-then-write. dropped alts: by-id dirty set (marginal), reopen-rebuild
by-id tail (conflicts DS-3 no-O(capture)-reopen).

## Open bugs

### Reloaded plot shows only trailing ~10 s window (root cause confirmed)

**Symptom.** scratch reload → plot intermittently shows only recent slice. manual
recover: Follow-Live → Fit-Data → un-Follow-Live.

**Not host (proven from live scratch).** raw reopens lossless (`manifest
len=1267578`; each by-id len = sum of 2 per-bus `derived.json` counts). all 26
pyramids complete (~57627 pts / 579 s, read from (t,v) f64). table complete. data
loaded, plot not *showing* it. (debug: pyramid L files pre-allocated → size =
capacity; real len = count of non-zero `t_seconds`, not bytes/16.)

**Root cause.** `PlotPanel.onAreaResampled` follow-live (default on) slides
x-window to live edge:

```js
const width = sync set ? sync.xMax - sync.xMin : DEFAULT_FOLLOW_WIDTH_SECONDS; // 10
applyXAll(Math.max(0, ext - width), ext, null);   // x = [ext-width, ext]
```

restore → `ext` jumps ~579 s; slide before x-sync set → `width=10` → last 10 s
visible. intermittent: earlier resample/fit sets x-sync full → `width`=full →
stays whole. restored trace stopped (no live edge) → trailing window wrong
default.

**Fix (decided — fit once on restore).** trailing slide only when
`trace.status==="running"`; else fit branch (`xMax==null → applyXAll(0,ext)`).
fits stopped span [0,ext] once (next slide no-ops, width=full). pause untouched.
extract pure `followXWindow(followLive, running, xMin, xMax, ext)→{min,max}|null`,
unit-test. *dropped:* persist per-trace x positions (ADR 0032) — fights
follow-live.

### Cursor-jump on stopped plot shows no data (same class)

**Symptom.** jump between event markers on reloaded (stopped) plot moves x-window
but renders no data there.

**Root cause.** pure x-window change has no refetch trigger on stopped trace.
resample loop gated on `live` → stopped samples once, no interval; re-fires only
on `winStart`/`winEnd`/`followLive` toggle/mount/`fitY`. `gotoNote` does
`applyXAll` (scale only, no fetch) + `setFollowLive(false)`, relying on
followLive→false effect. follow-live already off → no-op → no resample →
`useDecimatedRange` never fetches new slice → uPlot holds old window off-screen.
same gap breaks `fitData`/pan on stopped trace.

**Fix (proposed).** one refetch trigger for any x-window change: bump `xEpoch`
from `applyXAll` callers (`gotoNote`/`fitData`/`onUserXChange`) + per-area
`useEffect(resample,[xEpoch])`. subsumes fit-on-restore refetch — land both
together.

### Derived caches not invalidated on DBC change (latent)

not the clean-cold-open trigger (awaited open path hides it), but real.
`signal_cache` pyramid + active filter index = derived, lazy. `catch_up`
advances `next_index` to tip **unconditionally** → frames it couldn't decode
(DBC not loaded / bus-filtered) skipped forever. `signal_caches.clear()` only
caller = `clear_trace_store`; `load_dbc`/`set_dbc_buses`/`remove_dbc`/
`clear_dbcs` + FS-watcher reload only call `rbs::refresh_all_elements`. DBC
arriving after cache exists → stale, no rebuild; stopped reloaded trace (no
appends) → empty/partial forever. filter index same gap. = ADR 0033 failure mode
(chose ordering, rejected re-validation; covers initial open not in-session /
async-watcher DBC change); consequence-2 ("rebuild dependent state on reload")
unimplemented for derived caches.

**Fix (proposed).** on any DBC-set mutation: `signal_caches.clear()` + reset
active `filter_index`→None (clear-and-rebuild, DBC changes rare). amend ADR 0033.
TDD: cache vs stopped store, DBC absent → load DBC → next slice full series.

## Idea (not scheduled): pyramid in-memory residency knob

pyramid disk-backed (`SampleSeq` mmap) since 5.3d → residency already implicitly
bounded (segment handles + recently-served windows; kernel pages cold out). no
explicit RAM knob (unlike frame ring's `ring_capacity`). two distinct levers,
separate before any work:

- **resident window** (residency lever) — cap hot RAM per level (madvise/pin
  recent N, demand-page rest). mirrors `ring_capacity`. doesn't change contents.
- **`PYRAMID_BRANCH` fan-out** (fidelity/cost lever) — const 8; larger → fewer
  levels, coarser, smaller pyramid (disk+RAM); changes structure, trades
  fidelity for size.

likely intended = resident window (pure RAM bound). distinct from Step 6 disk cap
(on-disk footprint). mmap demand-paging already bounds residency →
optimization/control not correctness. decide lever + whether worth surface before
scheduling.
