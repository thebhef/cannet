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
  - **Step 5.2 — not started.** Rewrite `fetch_filtered_trace` onto the
    filter index (`refresh_filter_index` + `FilterIndex::page`), with the
    active index held on `AppState`.
  - **Step 5.3 — not started.** The DS-7 scratch lifecycle: `project_id`
    UUID identity gate in `open_project`, reset-on-Clear/Start, and
    load-prior-as-stopped (needs a new disk-store *reload* capability —
    `DiskRawStore::new` currently wipes stale segments on construction).
- **Steps 6–7 — not started.**

Decisions and deviations recorded so far (to fold into ADR 0002 at
Step 6):

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
