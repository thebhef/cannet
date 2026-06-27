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
- **Step 5 — Retire the in-RAM `Vec` store (DS-6).** The disk-backed
  store becomes the only production path; the `Vec` implementation
  moves to a test double behind the `TraceStore` trait. Verify: the
  production path constructs only the disk store; the suite stays
  green through the test double.
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
