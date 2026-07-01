# Task 18 — Indefinite-Length Capture (Disk-Spill)

Make a capture indefinite-length — 10^7 to 10^9 frames, multi-hour to
multi-day — by spilling the raw frame store to disk while keeping
every historical row addressable. [`../../docs/adr/0001-indefinite-length-capture.md`](../../docs/adr/0001-indefinite-length-capture.md)
fixes the requirement (random-access, loss-free);
[`../../docs/adr/0002-disk-spill-store.md`](../../docs/adr/0002-disk-spill-store.md) fixes
the on-disk format and I/O architecture and is **normative for this
task**.

This is the **model-side** counterpart to the frontend
windowed-source convergence: it provides a second implementation of
the `RowPage` / `DecimatedRange` accessor signatures frozen by
[`../../docs/adr/0025-frontend-windowed-source-contract.md`](../../docs/adr/0025-frontend-windowed-source-contract.md)
— no contract change, no view change. (Explicit `.blf` "Save Capture" stays a separate feature; the
disk-spill store is the live working store — ephemeral scratch, not an
export format.)

ADR 0002 in brief: the raw store is two append-only files — fixed-size
~26 B metadata records giving arithmetic random access, plus a packed
payload blob (DS-1); writes are write-through and readers `mmap`, with
the kernel page cache as the hot tier and a RAM ring bridging the
un-flushed tail (DS-2); `by-id` and per-filter indexes are
materialized mmap'd files, every predicate id-narrowable against the
DBC so no index build is an O(capture) scan (DS-3); every file family
is fixed-size pre-allocated segments mapped whole with a valid-length
watermark (DS-4); the decoded-signal cache gains a per-signal min/max
resolution pyramid (DS-5); the disk store is the only production
path, the in-RAM `Vec` retiring to a test double (DS-6); and the
scratch lives in a single `current/` directory under the OS cache
dir and is wiped exactly when the session buffer is — on Clear, or
on Start of a new capture — never on exit or crash, so a prior
session present at launch is loaded as a stopped historical trace
(DS-7).

## Status (in progress, on a working branch — not yet merged)

- **Step 1 — done.** `cannet-spill` crate holds the storage layer:
  `RawStore` trait, in-RAM `MemRawStore` (test double), disk-backed
  `DiskRawStore` (mmap'd metadata + payload segments, RAM ring). gui's
  `TraceStore` is now a thin facade over `Box<dyn RawStore>`.
- **Step 2 — done.** `ByIdIndex`: per-id append-only mmap'd posting
  lists with geometric segments (bounds both RAM and live-mapping count).
- **Step 3 — done.** Spill `FilterIndex` (membership + tested build,
  `page`, `built_through` watermark) and the gui
  `filter::resolve_candidates` predicate→candidate-id resolver are done
  and unit-tested. The `CandidateSource` seam +
  `TraceStore::refresh_filter_index` let the index build against the live
  facade, and the perf harness `filter-bench` subcommand characterizes it
  on the disk store (deep positional page: full scan vs one-time build vs
  per-fetch index page). **The `fetch_filtered_trace` command rewrite
  moved to Step 5** (see below).
- **Step 4 — done.** `SignalCacheStore` now holds a per-signal min/max
  **resolution pyramid** (level 0 = raw decoded series; each higher level
  = per-bucket min/max over `PYRAMID_BRANCH` points of the level below).
  `SignalCacheStore::slice` gained a `max_points` budget and serves a
  range by reading the coarsest level whose in-range count still exceeds
  the budget, so a whole-span serve is `O(max_points)` instead of
  `O(matches)`. Built incrementally on the existing by-id-accelerated
  catch-up. The perf harness `signal-bench` subcommand characterizes it
  (whole-span serve: raw materialize+decimate vs pyramid serve), and three
  `signal_cache` unit tests cover bounded output, spike survival, and
  window-relative level choice.
- **Step 5 — in progress, sliced into three independently-landable
  parts** (the roadmap's Step 5 is large; each slice keeps the app
  working and tested):
  - **Step 5.1 — done.** Production now boots on the disk store: the
    `AppState` in `run()` constructs `TraceStore::new_disk(<OS cache
    dir>/cannet/current)` via `open_trace_store` / `scratch_current_dir`
    (the in-RAM store stays the unit-test/perf double). If the scratch
    dir can't be resolved or opened, it logs and falls back to the in-RAM
    store so the app still boots (capture bounded by RAM). `dirs` is now a
    direct dependency (resolves the per-OS cache dir). The existing
    chunked-scan `fetch_filtered_trace` keeps working through the
    store-independent facade, so the app stays green.
  - **Step 5.2 — done.** `fetch_filtered_trace` is served from the
    materialized filter index, not a window scan. `AppState` holds the
    active `FilterIndex` (`ActiveFilterIndex`) keyed by
    `(predicate, session_start_ns)`: a predicate change or a Clear/new
    capture (which bumps `session_start_ns`) rebuilds it; otherwise each
    call extends it to the tip (`refresh_filter_index`, `O(delta)`,
    candidate-id frames only). The `[scan_start, scan_end)` window maps onto
    a match-position range via two `FilterIndex::position_of` lower-bounds
    (new spill primitive), count is the range width, and the page is a
    random-access `FilterIndex::page` slice — serving is `O(log n + page)`.
    The old chunked-scan helpers (`PageSelector`, `scan_chunk_filtered`,
    `tail_page`) are retired. Verified: gui + spill unit suites, frontend
    suite (wire contract unchanged), and a render-tier perf run/gate.
  - **Step 5.3 — the DS-7 scratch lifecycle, sliced into four
    independently-landable parts** (it spans a new disk-store reopen
    surface, a `Project` schema migration, host wiring, and the pyramid
    residency bound — too much for one reviewable diff):
    - **Step 5.3a — done.** Disk-store persistent watermark + reopen
      (cannet-spill only, no GUI change). `DiskRawStore::flush` now writes
      a `manifest.json` (schema `version`, `DiskConfig`, the `len` /
      `payload_cursor` valid-length watermarks, the RAM-only `bus_intern`
      table, and the by-id `(id, extended, len)` directory).
      `DiskRawStore::reopen(dir)` remaps the existing segment files
      **without truncating them** (new `seg::open_segment`), restores the
      watermarks and bus table, rebuilds each by-id chain from its
      persisted length (`byid::reopen`, geometry deterministic in the
      segment index), and refills the RAM ring from the durable tail —
      `O(segments)`, no capture rebuild scan. Returns `Ok(None)` when no
      manifest exists, `Err` on a corrupt one (caller wipes). `clear` /
      `new` now also drop the manifest so a wiped store never reloads
      stale. `serde`/`serde_json` added to the crate for the manifest (no
      new workspace dependency). 7 new tests (round-trip incl.
      FD/remote/error/bus interning + ring tail; geometric by-id rebuild;
      append-continues-from-watermark; absent / corrupt manifest;
      clear-removes-manifest).
    - **Step 5.3b — done.** `project_id: Uuid` on the `Project` schema —
      the stable identity the DS-7 gate keys on. Added as an *additive
      field with a generating serde default, no `schema_version` bump*
      (the ADR's "schema-version migration" framing was wrong — ADR 0011
      *rejects* non-current versions; the real convention for additive
      fields is the `transmit_frames` pattern, and the ADR text is now
      fixed to say so). Host-managed like `transmit_frames`: the
      frontend's `gatherProject()` omits it, so relying on a frontend
      round-trip would mint a new id every save. Instead `save_project`
      anchors the id to the target file (`existing_project_id` reads the
      id already on disk and preserves it; a brand-new file keeps the
      freshly generated one). New `uuid` dep (v4 + serde). 3 tests
      (generate-when-absent + distinct, preserve-explicit + round-trip,
      file-anchor recovers/None). The field is inert until 5.3c reads it.
    - **Step 5.3c — host wiring, sliced into four** (it spans durability,
      a host identity file, the open gate + reconstruction, and the
      reset path):
      - **Step 5.3c-i — done.** Durability cadence. Discovery:
        `RawStore::flush` was never called in production, so 5.3a's
        manifest was dormant — reopen would always find nothing. Added
        `TraceStore::flush` (locks, delegates to `raw.flush()`; a no-op on
        the in-RAM double) and a `spawn_trace_flusher` task on a 2 s
        cadence (`TRACE_FLUSH_TICK`), skipping a tick when the buffer
        hasn't grown — so an idle/stopped session doesn't rewrite the
        manifest, and the first tick after capture stops still persists
        the final state (a cleanly stopped trace is reloadable within one
        tick). No explicit stop/exit flush needed for correctness. Two
        tests (no-op on the double; disk flush → `DiskRawStore::reopen`
        round-trips). **Watch item for Step 7:** the cadence uses the full
        `flush()` (every mapped segment); at 10^8 frames that's many
        msyncs under the append lock — measure there and make it
        incremental (flush only newly-sealed segments) if it shows up.
      - **Step 5.3c (rest) — done** in one commit (the ii/iii/iv split was
        dropped — they're one lifecycle feature, ~200 lines, not three
        reviewable units). Pieces:
        - **Boot stops wiping.** New `DiskRawStore::open_empty` constructs
          an empty store that *preserves* the on-disk files;
          `TraceStore::new_disk` uses it, so a prior session survives boot
          for the gate to reload (the old `new` wiped at construction,
          which would have destroyed the scratch before any gate ran).
        - **Host scratch files, facade-owned.** The facade holds the
          `scratch_dir` and writes two small JSON files there:
          `identity.json` (`project_id`) on capture start, and
          `derived.json` (`session_start_ns` + per-key newest-index/count)
          on every flush. Both via temp-file + rename.
        - **Derived state — fork P (persist), not rebuild-from-by-id.**
          The facade's `latest`/counts are keyed by the full `(bus,
          channel, id, extended)`; the by-id index is keyed by `(id,
          extended)`, so rebuilding would collapse a same-id-on-multiple-
          buses case (common in multi-bus captures, and it would break
          filter candidate resolution, not just display). Persisting is
          faithful and rides the flush we already added. Rates reset to
          zero (a reloaded trace is stopped).
        - **The gate.** `open_project` calls `TraceStore::try_reload(
          project_id)`: on an `identity.json` match with a reopenable
          store, it swaps in the disk store, restores derived state +
          `session_start_ns`, and the trace comes back stopped; a mismatch
          (or no scratch) leaves it on disk, untouched. Then it records the
          project as `AppState::active_project_id`.
        - **Reset on Clear/Start.** `start_session` (the buffer reset)
          removes `identity.json` + `derived.json` (the raw `clear` already
          dropped segments + manifest); a `restamp_scratch_for_capture`
          helper after each `start_session` (Clear and BLF-replay sites)
          drops the filter index and writes the fresh identity for the
          active project.
        - **Frontend restore + open-path ordering (ADR 0033).** A new
          `restore_scratch_capture` command returns the reloaded count +
          session start; `applyProject` calls it *after* the open clears
          the view, setting each element's window to `restoredTrace` (a
          stopped trace spanning the whole reloaded buffer). This exposed a
          latent race: `applyProject` fired DBC load, RBS register, layout,
          and restore concurrently, so a later-loaded bus's DBC (battery)
          wasn't present when the restored capture first sampled it — that
          bus's plot + filtered view cached empty while the earlier bus
          rendered. Fixed by sequencing the open path (DBCs → RBS → views →
          replayed capture), each stage awaited; captured as ADR 0033.
          Verified end-to-end on the ev-demo project (battery + powertrain
          both restore; no `not loaded` warning wave).
        - 6 tests (spill `open_empty` preserve+reopen; facade reload
          match/mismatch/faithful-multi-bus/session-start; Clear wipes
          identity so a later reload misses) + a `restoredTrace` frontend
          unit test.
        - **Deviation:** `identity.json` records only `project_id`, not the
          project *path* DS-7 mentions. The path is best-effort diagnostic
          ("not the basis for the match"), and writing it at capture start
          would mean threading the active path through `AppState` too —
          omitted as not worth the wiring. Can be added later if a
          diagnostic need appears.
    - **Step 5.3d — not started.** Disk-back the DS-5 pyramids in
      `current/` (residency bound; layout already reload-compatible).
- **Steps 6–7 — not started.**

Deviations / decisions in 5.3a:

- **DS-4's "valid-length watermark" lands as the reopen manifest.** 5.1
  shipped the disk store with `len` / `payload_cursor` / `bus_intern`
  RAM-only (a session was lost on exit); 5.3a persists them so the
  formats are reload-compatible *in practice*, not just in principle.
- **The manifest is a JSON file, not a binary footer.** The reopen
  state is tiny and id-space-bounded; serde_json keeps the
  failure-mode-rich (de)serialization off the hand-written surface and
  the file human-inspectable for debugging.
- **By-id chains rebuild from length alone.** The segment geometry
  (64, 128, … capped at 65 536) is deterministic in the segment index,
  so the manifest stores only each id's `len`; reopen recomputes the
  chain. A shared `seg_capacity(i)` helper replaced the inline
  `(BASE_ENTRIES << i).min(MAX)` at the append site too — same values,
  and it removes a latent left-shift overflow that would have hit an id
  with 58+ segments (~3M occurrences).
- **The project-identity gate file is a *host* concern, not the spill
  manifest.** Keeping `cannet-spill` ignorant of projects: 5.3c writes
  the `project_id` + path record into `current/` separately.

Decisions and deviations recorded so far (to fold into ADR 0002 at
Step 6):

- **The filtered-fetch incremental-count checkpoint is now vestigial.**
  `fetch_filtered_trace` still accepts `prev_count` / `prev_count_end` for
  IPC compatibility but ignores them: the filter index gives an exact count
  in `O(log n)` (two `position_of` searches), so the old O(Δ) checkpoint
  that existed to avoid a full window re-scan is unnecessary. The
  follow-live-tail semantics are preserved (the last `limit` matches in the
  window) but served from the index rather than a backward scan. A later
  cleanup can drop the params from the IPC payload + the frontend; left in
  place here to keep 5.2 a surgical host-only change.
- **The filter index build holds the `databases` lock for its duration.**
  Unlike the retired per-chunk scan (which re-locked `databases` between
  chunks), the index `keep` closure borrows the DBCs across the whole
  synchronous `refresh_filter_index`. The trace-store append lock is still
  released between chunks inside the extend (ingest is not starved), but a
  one-time deep-history *first* build briefly blocks DBC add/remove and the
  tokio worker it runs on. Steady-state extends are `O(delta)` so the hold
  is negligible; the one-time build cost is what Step 7 measures.
- **Intermediate state after Step 5.1: the scratch is wiped on launch,
  not reloaded.** `DiskRawStore::new` clears stale `current/` segments on
  construction, so a prior session is *not yet* reloaded as a stopped
  trace — that (and the `project_id` identity gate that makes a single
  shared `current/` safe across instances) is Step 5.3. Until then the
  observable behaviour matches today's in-RAM store (a session is lost on
  exit); the only new gap is that two concurrent instances would share and
  stomp one `current/` dir, which the 5.3 identity gate closes.

- **`memmap2`'s `unsafe` is contained to the dedicated `cannet-spill`
  crate**, which alone relaxes the workspace `unsafe_code = "forbid"` to
  `deny` + per-site `#[allow]`. Every other crate stays `unsafe`-free.
- **DS-6's "TraceStore is a trait" is realized as the `RawStore` trait
  behind the `TraceStore` facade** — one production store
  (`DiskRawStore`), one test double (`MemRawStore`), derived state
  (rates / newest-per-id) written once in the facade.
- **Bus predicates are id-narrowed via "ids seen on the bus"** (derived
  from the facade's existing newest-per-key map) rather than a dedicated
  by-bus index — no new index family, and a per-frame `bus_id` test
  keeps it correct when an id appears on more than one bus (also
  forward-compatible with other frame/bus kinds).
- **The metadata record is 27 B** (ADR DS-1's "~26 B"), the extra byte
  an explicit `channel`.
- **DS-5's pyramid is framed as a property of the decoded *signal*, not
  of the plot.** `SignalCacheStore::slice` serves a value range at a
  point budget; a plot fitting all data is the consumer today, but the
  multi-resolution view is the signal's (so other consumers — export,
  stats — can use it). The harness mode is `signal-bench`, not
  `plot-bench`.
- **The pyramid bounds *serve cost* (`O(max_points)`), not RAM
  residency.** Level 0 (the raw decoded series) still lives in RAM at
  `O(matches per signal)`. The residency bound is disk-backing the
  pyramids in `current/` (DS-7), which lands with the live switchover in
  Step 5 — the pyramid's append-only level layout is already
  reload-compatible by construction.
- **Production runs on `DiskRawStore` as of Step 5.1.** `AppState`
  constructs the disk store rooted at `<OS cache dir>/cannet/current`;
  `MemRawStore` is the unit-test / perf double. The `fetch_filtered_trace`
  rewrite onto the filter index (5.2) and the DS-7 scratch lifecycle (5.3)
  remain.

Steps — each lands independently, leaves the app working and tested
(`cargo test -p cannet-gui`, `pnpm --dir apps/gui test`), and keeps
rustdoc and the README current for what it ships:

- **Step 1 — `TraceStore` trait + disk-backed raw store (DS-1, DS-2,
  DS-4).** Extract `TraceStore` as a trait from the current `Vec`
  implementation. Add the disk-backed raw store: the two append-only
  segmented files, write-through buffered append, mmap'd reads, and the
  RAM ring for the un-flushed tail. `fetch_trace_range` with no
  predicate is served from it. Verify: frames round-trip through the
  disk store; a capture larger than the RAM ring reads back every row
  correctly; segment rollover is exercised.
- **Step 2 — Always-on `by-id` index (DS-3 backbone).** Add the per-id
  append-only mmap'd index files, maintained on every append.
  `fetch_by_id_page` with no predicate is served from it. Verify:
  by-id paging is O(page); a capture spanning many ids pages and sorts
  correctly.
- **Step 3 — Materialized filter index (DS-3).** Add per-filter index
  files. `bus` / `id_range` / `id_list` / `name_regex` predicates
  build by merging `by-id` lists with no frame decode; `signal_equals`
  builds by decoding only its DBC-resolved candidate ids' frames;
  `all` / `any` compose id sets. Indexes drop on predicate change.
  `fetch_trace_range(predicate)` and `fetch_by_id_page(predicate)` are
  O(page). Verify: filtered paging is O(page); `name_regex` builds
  with zero frame decode; `signal_equals` decodes only candidate-id
  frames; a predicate change drops and rebuilds the index.
- **Step 4 — Decimated decoded-sample tier (DS-5).** Give
  `signal_cache::SignalCacheStore` the per-signal min/max resolution
  pyramid; `DecimatedRange` reads the coarsest level above
  `maxPoints`. Pyramids build lazily per signal on first plot,
  by-id-accelerated. Verify: a plot "fit data" over a 10^8-frame
  capture does not re-decode the whole capture; min/max spikes survive
  decimation.
- **Step 5 — Go live: disk store in production + filtered-fetch
  integration + scratch lifecycle (DS-6, DS-7).** The disk-backed store
  becomes the only production path: `AppState` constructs `DiskRawStore`
  (the `Vec` store moves to a test double behind `RawStore`); the
  `fetch_trace_range` / `fetch_by_id_page` / `fetch_filtered_trace`
  commands serve from the disk store, with `fetch_filtered_trace`
  rewritten onto the filter index (`TraceStore::refresh_filter_index` +
  `FilterIndex::page`, preserving the incremental-count and
  follow-live-tail semantics) and the old chunked scan retired for the
  production path; and the DS-7 scratch lifecycle lands (scratch under
  the OS cache dir's `current/`, the `project_id` UUID identity gate in
  `open_project`, reset-on-Clear/Start, load-prior-as-stopped). Verify:
  the production path constructs only the disk store; filtered paging is
  O(page) end to end; the scratch survives a restart and reloads as a
  stopped trace when the project identity matches; the suite stays green
  through the test double.
- **Step 6 — Configurable scratch cap.** A user-set maximum on the
  disk-spill scratch size (configured in bytes; default off /
  unbounded). Exposed through the same settings panel the High-
  Priority backlog's `clear scratch cache on exit` toggle lives in.
  Over-limit behaviour is the design question this step settles —
  either *stop capture* (with a System Messages warning naming the
  cap) or *drop oldest* (turn the raw store into a windowed ring,
  invalidating any historical row reference below the new low-water
  mark). Both have implications for the DS-1 random-access contract;
  the chosen behaviour lands as an update to ADR 0002. Verify:
  capturing past the cap behaves per the chosen contract; the cap
  setting round-trips through the settings panel; the System
  Messages surface explains the boundary.
- **Step 7 — Benchmark.** A documented benchmark covering scroll /
  filter / plot of deep history, confirming GUI interactions stay
  < 100 ms / 60 fps with a 10^8+-frame capture open.

Exit criteria:

- a capture runs past available RAM with no row becoming unreachable;
  scroll / filter / plot of deep history all work;
- the `RowPage` / `DecimatedRange` signatures (ADR 0025) are
  unchanged — only their host implementation is swapped;
- `fetch_trace_range` / `fetch_by_id_page` with a predicate are
  O(page) via the filter index, with no O(capture) scan in any filter
  index build;
- a plot "fit data" over a 10^9-frame capture does not re-decode the
  whole capture;
- the disk-backed store is the only production `TraceStore`; the `Vec`
  store is a test double;
- a documented benchmark shows GUI interactions stay < 100 ms / 60 fps
  with a 10^8+-frame capture open;
- the user-configurable scratch-size cap is wired through the
  settings panel, with the over-limit behaviour documented in an
  ADR-0002 update and surfaced in System Messages when reached;
- backlog items removed: `TraceStore` disk-spill, index the filtered
  trace scan, bound the host-side decoded-sample cache;
- README documents indefinite-length capture and its limits; rustdoc
  covers the `TraceStore` trait and the disk-backed implementation;
  ADR 0002 and the `memmap2` entry in
  `plans/technology-inventory.md` reflect the shipped design.
