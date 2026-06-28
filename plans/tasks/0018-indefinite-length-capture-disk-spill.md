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
  - **Step 5.3 — the DS-7 scratch lifecycle, sliced into several
    independently-landable parts** (it spans a new disk-store reopen
    surface, a `Project` schema migration, host wiring, the pyramid
    residency bound, scratch-persisted events, and the by-id derived-state
    shape — too much for one reviewable diff):
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
        round-trips). ~~**Watch item for Step 7:** the cadence uses the
        full `flush()` (every mapped segment)…~~ **Resolved** — it showed
        up earlier than 10^8 frames: the full-chain synchronous flush held
        the append lock ~110 ms every `TRACE_FLUSH_TICK`, stalling
        ingest/transmit on a periodic sawtooth (confirmed by moving the
        sawtooth's period when the tick changed). Fixed two ways: the flush
        is now **incremental** (only segments dirtied since the last flush;
        sealed segments are synced once) and **asynchronous**
        (`msync(MS_ASYNC)`, not a per-segment `fsync`), with a synchronous
        flush only on clean shutdown — see ADR 0002 DS-2. A
        `flush_ms`/`tx_late_ms` host-jitter gate (ADR 0031) was added so
        this regression class is caught by the perf test, since throughput
        averages are structurally blind to a sub-second stall.
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
    - **Step 5.3d — done.** Disk-back the DS-5 pyramids in `current/`
      (the residency bound). New `cannet-spill::SampleSeq`: an append-only
      run of `(t_seconds, value)` pairs on a geometric mmap'd segment chain
      (64→65 536 entries, doubling — the by-id postings' layout, 16-byte
      records). `signal_cache`'s pyramid is now `Vec<SampleSeq>` instead of
      `Vec<Vec<SamplePoint>>`, rooted at a `signals/` subdir of the scratch,
      so the resident set is only the segment handles plus recently-served
      windows — the kernel pages cold history out (before this, level 0 +
      the higher levels were `O(matches per signal)` in RAM). A pyramid is
      *derived* state, so it carries **no reopen manifest**: the raw store
      is the source of truth, and `SignalCacheStore::clear` /construction
      wipes the dir, with the next serve rebuilding the pyramid on disk from
      the reopened frames. New `SampleSeq` tests (round-trip across
      geometric segments, lazy file creation, prefix isolation, flush) and a
      `signal_cache` test asserting levels spill to `sig.*` files and
      `clear` wipes them.
    - **Step 5.3e — done.** Events (notes) persist with the scratch — the
      durable-kind persistence of the event model
      ([ADR 0035](../../docs/adr/0035-timeline-event-model.md)). Before this,
      5.3c persisted only the raw frames, derived state, and identity; the
      session-scoped `NotesStore` was written *only* into a `.blf` on Save
      Capture and reloaded *only* from a `.blf` on Open Capture, so a trace
      that spilled to disk and reopened through the manifest gate
      (`try_reload`) came back with its frames but an empty event list —
      cursors placed during the live capture lost on the very reopen DS-7
      promises is lossless. Now the notes ride the scratch as their own
      `current/notes.json` (atomic temp-file + rename), restored in the open
      gate and wiped on Clear/Start. **`NotesStore` owns its persistence**
      (the `SignalCacheStore::new(dir)` pattern): built with
      `with_scratch(dir)`, it rewrites `notes.json` on **every edit** —
      *not* the frame-flush cadence. That distinction is load-bearing: notes
      are user data that changes independently of ingest, so a marker added
      to a *stopped, reloaded* trace (no new frames, no flush tick) must
      still reach disk — the first cut persisted on the flush tick and lost
      exactly those edits. `TraceStore` stays ignorant of events (the orphan
      `scratch_dir()` getter was removed); the host gives `NotesStore` the
      same `current/` dir, `restore_scratch_capture` restores after a
      successful `try_reload` and emits `notes-changed`, and
      `restamp_scratch_for_capture` wipes on reset. The BLF path is unchanged
      and remains the export/import home; this is purely the scratch's own
      copy. One `notes` unit test asserts a manual edit with **no frame
      activity** round-trips through `notes.json`, an edit on the stopped
      store re-persists, and `wipe_scratch` drops it so a later restore
      misses.
    - **Step 5.3f — By-id derived state holds the full newest frame, not a
      raw-store index. Not yet started.** The host `latest` map keys a
      `FrameKey` to a frame *index* (5.3c persists that index in
      `derived.json`), and the live by-id grid resolves it with a raw
      `read_frame` at display time. That makes the derived state — which is
      meant to be self-contained host state bounded by id-space (the
      `cannet-spill` crate doc's raw-vs-derived split) — actually a pointer
      into the `O(capture)` raw store. It works only while every index stays
      valid: a latent coupling today that becomes a *correctness* bug the
      moment Step 6 eviction can drop the segment an index points at (a rare
      id's last sighting vanishes from the grid, and a persisted index can
      dangle below a reloaded low-water mark). Retain the full newest
      `RawTraceFrame` per key instead (still id-space bounded) and persist
      the *frame*, not the index, in `derived.json`, so the by-id snapshot
      is self-contained and survives both eviction and reload. This is
      derived-state model completion, not eviction behaviour, so it lands in
      Step 5 with the rest of the derived state; Step 6 eviction then merely
      relies on it. Verify: the by-id newest snapshot round-trips through
      `derived.json` carrying the full frame; a stopped reloaded trace shows
      each key's last value with no raw read.
- **Steps 6–7 — not started** (Step 5 completes once 5.3f lands; it gates
  Step 6).

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
- **The pyramid bounds *serve cost* (`O(max_points)`); the residency
  bound is disk-backing it (done in 5.3d).** Every level is now an mmap'd
  `cannet-spill::SampleSeq` under `current/signals/`, so a level's
  `O(matches per signal)` bytes live on disk and the resident set is the
  segment handles plus recently-served windows. A pyramid is derived
  state, so 5.3d chose lazy rebuild from the reopened raw store over a
  pyramid manifest — the append-only layout *is* reload-compatible, but
  re-deriving is simpler and the raw store is the single source of truth.
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
- **Step 6 — Configurable scratch cap + windowed-ring eviction.** A
  user-set maximum on the disk-spill scratch size (bytes; default off /
  unbounded), persisted in `settings.json` ([ADR 0034](../../docs/adr/0034-settings-vs-state-and-custom-settings-panel.md))
  and edited through the custom settings panel that also carries the
  `clear scratch cache on exit` toggle. Over-limit behaviour is **drop
  oldest**: the raw store becomes a windowed ring — when the scratch
  exceeds the cap the oldest sealed segments are dropped and a **low-water
  mark** rises, relaxing the DS-1 random-access contract (rows below the
  mark are no longer addressable). That relaxation + the low-water mark
  land as an update to [ADR 0002](../../docs/adr/0002-disk-spill-store.md).
  Sub-slices:
    - **Step 6a — Settings infrastructure ([ADR 0034](../../docs/adr/0034-settings-vs-state-and-custom-settings-panel.md)).**
      The cap and the `clear scratch cache on exit` toggle need a home that
      does not exist yet. Split machine state from user intent: rename the
      existing `preferences.json` → `state.json` (host-derived UI state,
      [ADR 0032](../../docs/adr/0032-machine-local-ui-state-host-side.md))
      and add a new `settings.json` (user intent) behind a `settings.rs`
      module carrying `scratch_cap_bytes` (default null / unbounded) and
      `clear_scratch_on_exit` (default false). Build the flat in-repo
      settings panel (no schema-form dependency — ADR 0034) and a
      `panel.show.settings` command-palette entry to open it. The two cap
      fields are inert until 6c reads them. Verify: `state.json` round-trips
      the renamed prefs; `settings.json` round-trips both new fields at
      their defaults; the panel opens from the palette and edits both.
    - **Step 6b — Low-water mark + explicit `Evicted` read contract.**
      `read_frame` / `read_ts` today guard only the upper bound
      (`idx >= len → None`); below the mark they would index a dropped
      segment and panic. Add a `first_index` floor and an explicit
      evicted/unavailable read result, and move `first_last_ts` off the
      hardcoded index 0 onto the mark. The collection reads (`slice`,
      `matching_frames_indexed`, …) already `filter_map` over `read_frame`,
      so they tolerate the gap once the primitive returns the evicted
      result rather than panicking. TDD: append past a tiny cap; assert
      evicted reads return the unavailable result (no panic) and
      `first_last_ts` tracks the mark.
    - **Step 6c — Windowed-ring eviction.** Enforce the cap: drop the oldest
      sealed meta/payload segments and the by-id postings below the mark,
      raise the low-water mark, delete the segment files. The by-id live
      grid stays correct across the drop because 5.3f retains the full
      newest frame per key (not a now-evicted index). Verify: a capture past
      the cap holds the dir size at the cap; reopen across an eviction is
      intact above the mark.
    - **Step 6d — Truncation as a derived event.** Surface the low-water
      `(idx, ts)` as a derived, non-persisted, non-exported event
      ([ADR 0035](../../docs/adr/0035-timeline-event-model.md)), rendered as
      a plot cursor and a trace floor row ("history truncated here"),
      created/moved whenever a chunk is dropped. It stays distinct from the
      view's time origin ([ADR 0024](../../docs/adr/0024-trace-like-view-timing.md)).
      Verify: dropping a chunk moves the marker; it never exports to BLF or
      persists to the scratch. (The general event-row surface — notes and
      other kinds at arbitrary timestamps, needing ts→index placement — is
      an ADR 0035 consequence tracked in the backlog; this slice wires only
      the truncation floor row.)
    - **Step 6e — Trace-panel show/hide events.** A view-local "show events"
      toggle in the trace panel's existing sources context menu
      (`SourcesContextMenu`) controlling whether event rows render in the
      trace. Verify: the toggle shows/hides the event rows without
      refetching frames.
  Verify (step): capturing past the cap drops oldest and holds the dir at
  the cap; reads below the mark return the evicted result, not a panic; the
  cap round-trips through the settings panel; the truncation marker shows in
  plot and trace and moves on eviction; the by-id grid keeps a rare id's
  last value across eviction.
- **Step 7 — Benchmark.** A documented benchmark covering scroll /
  filter / plot of deep history, confirming GUI interactions stay
  < 100 ms / 60 fps with a 10^8+-frame capture open. Also **captures the
  frontend memory baseline** (ADR 0031): the renderer / JS-heap peak and
  drift gates and the host process-memory split are instrumented (`diag.rs`
  `GaugeSpread::slope_per_min`, `crash::MemSampler`, `frontend.rs`), but
  stay inert until a baseline carries them — a deep-history run is the
  representative-length, sustained-capture scenario that arms them, so the
  baseline regen lands here. This is also where the disk-backed-pyramid
  residency win (5.3d) is confirmed against host RSS holding flat.

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

## Periodic-flush lock contention (fixed)

**Problem.** `TraceStore::flush` (`TRACE_FLUSH_TICK` = 2 s) held the
trace-store **append lock** 80–145 ms while it `fsync`'d every mapped segment
and rewrote the manifest + derived state. Ingest and transmit append through
that lock, so the transmit scheduler fired ~110 ms late every 2 s — a periodic
TX/RX stutter invisible to per-second fps (the catch-up burst refills the gap;
retention held 1.0). Causally confirmed: moving the tick to 10 s moved the
stall to 10 s, 1:1.

**Fix.**

- *Incremental flush* — re-sync only segments dirtied since the last flush;
  sealed segments are immutable, synced once as the tail. `DiskRawStore` /
  `ByIdIndex` carry a `flushed_*` watermark, so per-flush work is `O(segments
  since last flush)` — normally one. The load-bearing fix at 10^8 frames
  (resolved Step-5.3c-i watch item above).
- *Async msync* — periodic flush uses `flush_async` (`MS_ASYNC` /
  `FlushViewOfFile`), not device `fsync`. Reopen-after-restart still works (the
  page cache backs the mapping); only trailing-window power-loss durability
  relaxes — fine for ephemeral scratch. A sync `flush()` runs on clean
  shutdown. ADR 0002 DS-2.

**Detection.** The host stamps two jitter gauges into the ADR-0031 capture from
a lock-free `diag::HostMetrics` — `flush_ms` (lock-hold) and `tx_late_ms`
(scheduler wake lateness) — gated on their **mean** (≤ 25 / ≤ 18 ms). Mean, not
peak: it catches the systematic per-flush regression and shrugs off one-off OS
writeback spikes (a peak gate flaps). These are the *only* metrics that see the
stall; throughput and retention never moved.

**Result.** Stutter gone. Pre-fix the live capture failed both gates (flush 38,
tx-late 27, every other metric green); post-fix 15 / 8.6. A 1200 s / 1.23 M-frame
soak holds at flush 9.8, tx-late 5.2, retention 1.0 — the fix scales.

### Deferred — off-lock manifest/derived writes

Residual `flush_ms` **peaks** (~68 ms; mean ~15) are work still under the lock:
the manifest write (by-id directory + bus table, temp + rename), the
derived-state write, and ~20 per-id msyncs — an occasional slow rename spikes
the peak. Crush it with a **two-phase flush**:

- *Locked:* async-msync the dirtied segments; snapshot the manifest inputs
  (watermarks, bus-intern, by-id directory) and derived state. Release.
- *Unlocked:* serialize and write both files (temp + atomic rename).

Safe because appends only *append*: a concurrent append lands in the next
checkpoint, so the off-lock manifest names a durable *prefix* — and reopen
already tolerates an undercounting manifest (reloads the prefix; next flush
catches up). Needs `DiskRawStore` to split msync from manifest-write
(`flush_segments(sync)` + `manifest_bytes()`) and `TraceStore::flush_with` to
snapshot-then-write outside the lock. Under-lock cost then drops to just the
async msync (single-digit ms), and the gate can tighten to a peak ceiling.

Dropped alternatives: a by-id *dirty set* (marginal — every id gets a frame
each tick) and reopen-rebuild of the by-id tail (conflicts with DS-3's
no-`O(capture)`-reopen).

## Reloaded plot shows only a trailing ~10 s window (bug, root cause confirmed)

**Symptom.** After a scratch reload, a plot intermittently shows only the
recent slice of a signal, not the full restored span. Recovered manually by
Follow-Live → Fit-Data → un-Follow-Live.

**Not the host — proven from the live scratch.** Raw store reopens losslessly
(`manifest len = 1267578`; each by-id length = sum of its two per-bus
`derived.json` counts). All 26 pyramids rebuild complete (~57627 pts over the
full 579 s, read from the `(t,v)` f64 pairs). Trace table renders complete.
Data's all loaded; the plot just isn't *showing* it. (Debug note: pyramid
level files are pre-allocated — file size is capacity; real length is the
count of non-zero `t_seconds`, not `bytes/16`.)

**Root cause.** `PlotPanel.onAreaResampled` slides the x-window to the live
edge when Follow-Live is on (the default):

```js
const width = sync set ? sync.xMax - sync.xMin : DEFAULT_FOLLOW_WIDTH_SECONDS; // 10
applyXAll(Math.max(0, ext - width), ext, null);   // visible x = [ext-width, ext]
```

On restore `ext` jumps to ~579 s; if the slide fires before x-sync is set,
`width = 10` ⇒ last 10 s of 579 visible (rest off-screen). Intermittent: if an
earlier resample/fit set x-sync to the full span first, `width` is the full
span and it stays whole. A restored trace is **stopped** — no live edge — so a
trailing window is the wrong default.

**Fix (decided — fit once on restore).** Only apply the trailing slide when
`trace.status === "running"`; otherwise take the existing fit branch (`xMax ==
null → applyXAll(0, ext)`). Fits a stopped span to `[0, ext]` once (next slide
no-ops — x-sync now set, and `width` becomes the full span). Pause untouched
(x-sync already set). Extract a pure `followXWindow(followLive, running, xMin,
xMax, ext) → {min,max} | null` (with `DEFAULT_FOLLOW_WIDTH_SECONDS`) and
unit-test it: stopped+`ext ≫ width` → `[0, ext]`; running → `[ext-width, ext]`;
x-sync set → `null`.

*Dropped:* persisting per-trace x positions (ADR 0032 state) — would fight
follow-live; fit-on-restore suffices.

## Separate latent bug — derived caches not invalidated on DBC change

Found while investigating the above; **not** the clean-cold-open trigger
(the awaited open path keeps it from firing there), but real and worth fixing.

The per-signal pyramid (`signal_cache.rs`) and the active filter index are
*derived* state rebuilt lazily on first serve. `SignalCache::catch_up`
advances `next_index` to the store tip **unconditionally** — frames it
couldn't decode (the signal's DBC not yet loaded, or dropped by the bus
filter) are skipped and never revisited. `signal_caches.clear()` has exactly
one caller, `clear_trace_store`; `load_dbc` / `set_dbc_buses` / `remove_dbc` /
`clear_dbcs` and the FS-watcher reload mutate the DBC set and call only
`rbs::refresh_all_elements`. So a DBC that arrives or changes *after* a
signal's cache exists leaves it stale with no rebuild — and on a stopped
reloaded trace (no future appends) it stays empty/partial forever. The active
filter index has the same gap (keyed by predicate + session start, rebuilt on
predicate change but not on DBC change).

This is the failure mode ADR 0033 ("build a model layer's dependencies before
the layer itself") targets. ADR 0033 chose **ordering** and explicitly
*rejected* per-view re-validation — which covers the initial open but **not**
an in-session DBC change (notably the async FS-watcher reload, which has no
open-path sequence point to await). ADR 0033 consequence bullet 2 already
commits to "rebuilding dependent state" on reloads; for a derived cache that
means *dropping* it so it re-derives, which is currently unimplemented.

**Fix (proposed).** On any DBC-set mutation, `signal_caches.clear()` and reset
the active `filter_index` to `None`; both rebuild on next serve against the
now-settled DBC set, and DBC changes are rare so the cost is acceptable. This
is *clear-and-rebuild*, not the incremental per-view re-validation ADR 0033
rejected, so it stays within the ADR's spirit — but ADR 0033 should be amended
to note in-session DBC changes need this invalidation. TDD: build a signal
cache against a stopped store with the DBC absent, load the DBC, assert the
next slice returns the full series.
