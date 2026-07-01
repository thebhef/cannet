# Task 17 — Windowed-Model Convergence

Converge the GUI's four hand-rolled view caches — raw chronological
trace, filtered trace, by-ID table, and plot — onto the single
windowed-source contract defined in
[ADR 0025](../../docs/adr/0025-frontend-windowed-source-contract.md):
one frontend primitive and one set of host accessor signatures
(`RowPage`, `DecimatedRange`) in place of four bespoke caches.

The principle this serves — thin views over a host-side model — is
[ADR 0003](../../docs/adr/0003-tauri-shell-react-frontend.md) and
CLAUDE.md § GUI architecture; the indefinite-length model the contract
is designed against is
[ADR 0001](../../docs/adr/0001-indefinite-length-capture.md) /
[ADR 0002](../../docs/adr/0002-disk-spill-store.md). Domain terms —
capture, derived projection, view, trace, by-ID view, series, filter
predicate — are in [`../../docs/CONTEXT.md`](../../docs/CONTEXT.md).

This is a **view-side** refactor; it lands against the current in-RAM
`TraceStore` `Vec`. Slice 1 freezes the host accessor signatures
disk-spill-ready, so Task 18 (the disk-spill store) is a second
implementation behind them, not a redesign.

## Why now

Four views each hand-roll their own window cache, invalidation, and
extent bookkeeping:

| View | Host command | Hand-rolled cache |
| --- | --- | --- |
| Chrono trace (raw) | `fetch_trace_range` | `App.tsx` `chunkCache` / `refreshChunk` |
| Chrono trace (filtered) | `fetch_trace_range` + predicate | `TracePanel.tsx` `chronoFiltered`, capped at `FILTERED_CAP` |
| By-ID table | `fetch_latest_by_id` | refetched whole every grow tick; sorted in `ByIdTable.tsx` |
| Plot | `sample_signals` | `PlotArea` `cacheRef` / `fetchKey` / `fps` / `traceRangesRef` |

Each independently re-implements a request memo-key, invalidation on
re-anchor and on buffer clear, an epoch bump to re-render, and
incremental tail catch-up as the buffer grows. CLAUDE.md calls
hand-rolled caching the expensive-to-review surface — and this one has
already shipped a bug (Slice 0).

## Slices

Each slice ships independently and leaves the app working and tested
(`pnpm --dir apps/gui test`, `cargo test -p cannet-gui`). Slices 1-4
land against the in-RAM `Vec`; Task 18 swaps the host implementation
behind the frozen contract.

### Slice 0 — Plot extent: stop extrapolating ✅ shipped

Shipped in `ad76899`. `PlotArea.resample`
([PlotPanel.tsx](../../apps/gui/src/PlotPanel.tsx)) used to compute the
live-edge time as `winFrames / cache.fps`, where `cache.fps` was
latched once on the first non-empty fetch. Under a non-uniform
aggregate frame rate — e.g. two servers streaming staggered onto
different buses — the latched rate drifted from steady state, so "fit
data" and follow-live snapped the x-axis to a wrong extent.

The `cache.fps` latch is gone. The plot extent now comes straight from
the host's `SignalsSample.last_seconds` (stored as `cache.lastT`); the
visible-x slice still travels separately in `from_seconds` /
`to_seconds`. `decodeSignalsSample`'s `last_seconds` handling is
covered by `plotData.test.ts`.

Independently shippable — no dependency on Slices 1-4.

### Slice 1 — The contract, with raw chrono as reference

Extract the Layer-A lifecycle (ADR 0025) into the shared primitive
(`useWindowedQuery`); make raw chrono (`App.tsx`
`chunkCache`/`refreshChunk` behind `TraceData`) its first consumer.
**Also freeze the host accessor contract** — `RowPage` and
`DecimatedRange` as explicit, disk-spill-ready trait/command signatures
(random-access, async, paged) — so Task 18 is a second implementation
behind them, not a redesign. Frontend behavior is unchanged.

Acceptance:

- chrono trace behaves identically (scroll, auto-scroll, clear,
  new-connection re-anchor);
- `App.tsx`'s bespoke chunk-cache bookkeeping is replaced by the
  primitive;
- `RowPage` and `DecimatedRange` are defined as frozen signatures,
  implemented over the in-RAM `Vec` in Slices 2-4 and reimplemented over
  the disk-spilled store in Task 18;
- the primitive has unit tests for descriptor memoisation and for
  invalidation on re-anchor, descriptor change, and buffer clear —
  including that an extent advance alone does not re-fetch a history
  window;
- existing trace tests stay green.

Status (2026-06-26): **shipped.** The primitive is
[`useWindowedQuery`](../../apps/gui/src/useWindowedQuery.ts) — the
Layer-A lifecycle (descriptor memoisation, single-flight fetch, re-anchor
on scroll-out, drop-and-re-anchor on descriptor change, extent tracked
separately from window content) generalised out of `useFilteredTrace`.
Its `extent` input is the hinge: a caller that knows the count cheaply
(raw chrono, from `trace-grew`) passes it and a parked window never
re-fetches; one that does not (the filtered match count) omits it and a
parked stale tick does a count-only refresh. Unit-tested in
[`useWindowedQuery.test.ts`](../../apps/gui/src/useWindowedQuery.test.ts)
(8 cases incl. the extent-advance-no-refetch rule).

Raw chrono converged onto it **per-panel**, symmetric with
`useFilteredTrace`: [`useTrace`](../../apps/gui/src/trace.ts) builds a
`useWindowedQuery` over `[offset, offset+frameCount)`. The App-level
chunk cache is gone — `chunkCacheRef`/`cacheOrderRef`/
`inflightChunksRef`/`refreshChunk`/`fetchChunk`/
`refreshStalePartialChunks`/`CHUNK_SIZE`/`CACHE_CHUNKS` deleted.
`TraceData` shrank to shared model facts plus the two thin accessors
(`epoch`, `fetchRange`, `liveTail`); `getFrame`/`ensureVisible`/`version`
moved off the context onto the per-panel window. The auto-scrolling view
still drives fetches via `ensureVisible`, and the `liveTail` overlay
covers the live edge between them, so follow-live is flicker-free with no
background re-page (matching the old tail-overlay behaviour exactly).

Host contract frozen in [`ipc.rs`](../../apps/gui/src-tauri/src/ipc.rs):
`RowPage<T> { count, start, rows }` is the named row-addressed accessor
response (ADR 0025), with `FilteredTracePage = RowPage<TraceFrameRecord>`
its first instantiation — same wire fields, no frontend change.
`DecimatedRange` names the plot's time-addressed lossy response (the
former `SignalsSample`). Both carry rustdoc declaring them
store-independent so the disk-spilled store (Task 18) is a second
implementation, not a redesign. Filtered/by-ID/plot adopt these in
Slices 2-4. `pnpm --dir apps/gui test` (427) and `cargo test -p
cannet-gui` (186) green; clippy clean.

### Slice 2 — Filtered chrono onto the contract

`fetch_trace_range` gains an optional `FilterPredicate` and returns
`{ total, rows[offset..offset+limit] }` for the predicate-filtered
trace, with `FilterPredicate::needs_decode()` so id/bus predicates skip
decoding non-matches. The filtered `TracePanel` path uses the shared
primitive; `FILTERED_CAP` is removed.

Over the in-RAM `Vec` the host scan is O(window); that is acceptable at
`Vec` scale and is what Task 18's filter index makes O(page) at 10^9
frames.

**Confirmed runtime offender (perf-capture diagnosis).** The current filtered
path re-scans the whole buffer ~8×/s for the scrollbar match-count, and
`scan_window_filtered` holds the `trace_store` mutex for that O(buffer)
scan. Under the RBS repro this contention — not the scan's raw cost — is
what halves per-bus ingest FPS and spaces out RBS transmit as the buffer
grows: the same lock gates RX `append` and tx-confirm `append`, so a
history scan starves live ingest and transmit. Beyond moving onto the
contract, this slice must therefore:

- make the periodic match-count refresh **incremental** — scan only
  frames appended since the last refresh and keep a running per-view
  match count, O(Δ) not O(buffer); and
- **bound the lock-hold** — the filtered scan must not hold the append
  mutex for the full window (snapshot/segment the scan, or read under a
  lock that does not block `append`), so a history scan can never starve
  live ingest or transmit.

Regression test: the virtual-bus reproduction (460 msg/s, 5 ids, filtered
chrono open) must assert per-bus ingest FPS stays flat as the buffer
grows past ~200k — the check that this offender stays dead.

Status (2026-06-26): **shipped.** The bounded lock-hold (done 2026-06-22)
is now joined by the incremental count and the convergence onto the
shared primitive.

- **Convergence.** [`useFilteredTrace`](../../apps/gui/src/useFilteredTrace.ts)
  is now a thin adapter over [`useWindowedQuery`](../../apps/gui/src/useWindowedQuery.ts):
  the generic primitive owns the lifecycle (descriptor memoisation,
  single-flight, re-anchor, drop-on-change); the adapter supplies the
  filtered `fetchPage` and the incremental-count cursor. Its bespoke
  lifecycle (ctxKey, dirty flag, manual single-flight, throttle loop) is
  gone. `TracePanel` is unchanged (same external `FilteredTrace` API).
- **Incremental O(Δ) match-count.** A count-only refresh passes the
  `(prev_count, prev_count_end)` it already knows; the host
  ([`fetch_filtered_trace`](../../apps/gui/src-tauri/src/lib.rs)) seeds
  the count and scans only frames appended since — O(Δ) — returning the
  **full** total (the host owns the count; the view stores it, no JS
  arithmetic on the fact). A row page (or a stale checkpoint) scans the
  window from its start. The page-selection logic is the pure, unit-tested
  [`PageSelector`]; tests cover total / offset / limit / from_end and the
  incremental-equals-full invariant.
- **Regression test.** `crates/cannet-perf-measurement/tests/fps_flat.rs`
  drives a hand-built 5-id schedule past 200k frames with the contending
  filtered scan and asserts `fps_retention >= 0.8` (the diagnosed offender
  drove it toward 0.5). The harness `scan_loop` now models the incremental
  refresh (scans only `[counted_to, len)` each pass), matching the real
  change.

Perf vs the prior baseline (incremental scan): steady-state filtered
contention collapsed — `scan_ms_max` tracebuffer 24.4→0.85 ms (~29×),
grpc 8.25→0.17 ms (~48×), hardware-peak 2.65→0.09 ms; `append_ms_max`
also dropped 4–6× (less total lock contention). `fps_retention` stays
~1.0. The baseline was **re-captured** (2026-06-26) so the new lows are
the reference: the tracebuffer `scan_ms_max` gate is now 6.7 ms (was
53.7), so a reversion to the O(buffer) scan would fail the gate. (The
hardware-peak block kept its last-known-good numbers — the adapter was
transiently idle during the capture; the deterministic tracebuffer/grpc
modes tightly gate the same incremental code path.)

The earlier unit guard
(`append_interleaves_between_chunk_scans_without_a_buffer_wide_lock`)
remains: it asserts an append landing between chunk scans is visible to
the next chunk — the property that lets live ingest proceed mid-scan.

Acceptance:

- the filtered trace pages the full match history, not just the last
  `FILTERED_CAP` matches;
- editing the filter re-derives the filtered trace over `[start, now]`
  against the new predicate (a descriptor change);
- virtualizer indexing stays correct while matches stream in; a flood
  received while scrolled into history does not shift the view;
- the host command is unit-tested for `total`/`offset`/`limit`.

### Slice 3 — By-ID onto the contract

`fetch_by_id_page(predicate?, sortKey, sortDir, offset, limit)` returns
a host-sorted, paged `{ total, rows[offset..offset+limit] }`.
`ByIdTable` reads through the shared `RowPage<T>` primitive exactly like
the chrono views — it pages and virtualizes; the client-side re-sort is
removed and the sort moves host-side.

By-ID is filterable: with a predicate it is the by-ID snapshot of the
filtered trace (see ADR 0025). Row count is bounded by id-space, so in
practice the virtualizer fetches few pages — but it is the same code
path, not a special whole-fetch.

Acceptance:

- by-ID rows are sorted host-side; the view holds no sort logic;
- by-ID pages through the same `RowPage` primitive as chrono — no
  separate unpaged path remains;
- a predicate filters by-ID as the snapshot of the filtered trace;
- the paused/stopped snapshot-correctness item already in
  `plans/backlog.md` is folded in.

Status (2026-06-27): **shipped.**

- **Host accessor.** `fetch_latest_by_id` is replaced by
  [`fetch_by_id_page`](../../apps/gui/src-tauri/src/lib.rs), returning a
  `RowPage<ByIdSnapshot>` — the same row-addressed contract the
  chronological/filtered views use (ADR 0025), now its third
  instantiation. It takes `scan_start` / `scan_end`, the panel's sort
  (`sort_key` / `sort_dir`), the project `bus_names` map, and
  `offset` / `limit`; `limit == 0` is a count-only refresh.
- **Sort moved host-side.** The client `sortRows` / `sortValue` /
  `compareValues` (traceColumns.ts) are gone; the host's
  [`sort_by_id`](../../apps/gui/src-tauri/src/lib.rs) orders the *whole*
  snapshot before paging, so a paged view sorts globally rather than
  per-page. `bus_names` rides along so the "bus" column still sorts by
  the project name the user sees (the host knows only bus ids). Unit
  tested (`sort_by_id_*`, the former `sortRows` cases ported to Rust);
  the panel keeps only `nextSort` (header-click → next `SortState`).
- **Paused/stopped snapshot correctness.** The new
  [`TraceStore::latest_in_window`](../../apps/gui/src-tauri/src/trace_store.rs)
  bounds each id's latest frame to `[start, end)`, so a paused/stopped
  window reflects the window it shows rather than the live tip. (No
  discrete by-id item was left in `plans/backlog.md`; the concern was the
  `latest_since` rustdoc caveat, now resolved.) `latest_since` is a thin
  alias for `latest_in_window(since, tip)`; the tip-covering (running)
  case still takes the O(keys) `latest`-map fast path, the bounded
  (historical) case pays one O(window) pass — on a status change, not the
  live tick. Tested (`latest_in_window_bounds_to_the_window_end`).
- **View pages + virtualizes.** [`ByIdTable`](../../apps/gui/src/ByIdTable.tsx)
  now windows the host snapshot with the same scaled virtualizer as
  `TraceView`, reading through [`useByIdView`](../../apps/gui/src/useByIdView.ts)
  — a thin adapter over `useWindowedQuery`, symmetric with
  `useFilteredTrace`. Expand/collapse keys on the stable
  [`byIdRowKey`](../../apps/gui/src/ByIdTable.tsx) (bus:id:ext), not row
  position, so it survives a re-sort or a new id appearing above it;
  expanded *positions* for the virtualizer's height math are derived from
  the loaded rows' keys. The unpaged whole-snapshot `useEffect` (and its
  `rows` state) in `TracePanel` is gone.
- **Filter.** Preserved the existing latest-then-filter semantics (a row
  whose *latest* frame fails the predicate drops, and can reappear once
  the id emits a passing value) — already "the snapshot, filtered," and a
  surgical change; true latest-*matching*-per-id would be a separate
  semantic upgrade.

`pnpm --dir apps/gui test` (424) and `cargo test -p cannet-gui` (195)
green; clippy clean.

Known limitation (logged in `plans/backlog.md`): while *running*, the
live refresh re-pages page 0, so a by-id view scrolled into a later page
(only possible with an unusually large id space) is pulled back to the
top each tick. The common single-page case is unaffected.

### Slice 4 — Plot onto the shared cache primitive

Fold `PlotArea`'s `cacheRef` / `fetchKey` memo / anchor-reset logic onto
the shared primitive via the `DecimatedRange` accessor. Move
`traceRangesRef` — the widen-only per-signal min/max latch, which is
capture-lifetime *model* state held in a React ref — host-side as a
`min_max` query against the per-signal min/max latch projection.

Over the in-RAM `Vec` the plot samples the current append-only
`SignalCacheStore`; Task 18 gives that projection its decimated
persistent tier so "fit data" stays fast at 10^9 frames.

Acceptance:

- plot resample behaviour is unchanged;
- the per-signal extent comes from the host, not a JS ref;
- `resample`'s hand-rolled cache bookkeeping and `traceRangesRef` are
  gone.

Design note (from a reverted plot report-coalescing experiment). When the rewrite
touches the area→panel reporting, prefer a single report object
(`{ lastT, series, perf/host/rate/cache gauges, base }`) over today's
six-callback fan-out — it's the cleaner shape. But do **not** assume
coalescing those reports buys render-cost: a tactical version that
bundled them and flushed once per `requestAnimationFrame` left the
plot over-render *entirely unchanged* and broke follow-live by
deferring the x-window slide a frame. So measure before adding any
batching, and keep the live-edge slide synchronous with the resample
that produced it. Characterize before cutting: at ~1000 msg/s with plots
open the UI thread runs ~75–100% (~200 `PlotArea` renders/s, 200–767 ms
long-task bursts). Wrap the synchronous resample sections
(`decodeSignalsSample`, the auto-norm / `mergeSeries` block, `u.setData`)
in `diagTime` and correlate the `longtask` spikes with the moving
`render.*` / `plotarea.resample` counter to confirm which is the dominant
task — this slice's paging is expected to retire all three, but localise
so the win is verifiable.

**Confirmed runtime offender + crash (diagnosed 2026-06-25).** This
slice is the structural fix for a renderer-memory crash. `PlotArea.resample`
allocates per tick in the renderer in proportion to plotted-signal count
times update rate: the `sample_signals` response `ArrayBuffer`, the
`mergeSeries` rebuild, and `uPlot.setData`. That is native /
`ArrayBuffer`-backed memory (not the V8 JS heap, not GPU), which V8
reclaims only lazily — so above ~10 Hz the renderer's working set climbs
unbounded instead of sawtoothing. It was reproduced ramping to ~3 GB and
tipping an already-loaded machine into a system-wide OOM that killed
every Chromium process at once (the host, all VS Code windows) with no
per-process Windows Error Report — the hard-to-diagnose "whole tree
vanishes" failure. Isolated to the plots by live bisection: closing the
trace views and idling the IPC changed nothing; closing the plots
dropped the renderer ~600 MB; signal count scaled it linearly; update
rate scaled it. The host-side health recorder (`crash.rs`: `webview_mb`
split by Chromium process role + `jsheap_mb` + `sys_avail_mb`, mirrored
to the rolling on-disk log) is the standing instrument that localised it
and will catch a regression.

Tactical mitigations already applied ahead of this slice — they lower the
*peak* (crash headroom) but leave the per-tick churn, which only paging
removes:

- `decodeSignalsSample` ([plotData.ts](../../apps/gui/src/plotData.ts))
  reads the f64 runs straight from the response buffer via `DataView`
  instead of an aligned `buf.slice()` per signal — removes ~half the
  per-tick external allocation;
- `max_points` lowered from `canvasW * 2` to `canvasW`
  ([PlotPanel.tsx](../../apps/gui/src/PlotPanel.tsx)): the host
  min/max-decimates to `2 * max_points`, so one point per pixel here is
  two per pixel on the wire — the full resolution a min/max envelope can
  show; `canvasW * 2` was a redundant 4 points/pixel. Halves bytes per
  fetch.

Together ~1/4 the per-tick allocation — enough to move 15 Hz from an
unbounded climb to a bounded sawtooth, but not to flatten it. Paging the
plot through the shared primitive (decimation / merge / extent host-side,
only the viewport slice shipped) removes the residual `invoke`-buffer +
`mergeSeries` + `uPlot.setData` rebuild the mitigations can't reach — the
reason this slice, not the tactical fixes, is the real cure.

Status (2026-06-27): **part 1 of 2 shipped** (per-signal extent host-side).

- **`traceRangesRef` retired.** The widen-only per-signal min/max latch —
  capture-lifetime *model* state that was living in a React ref — is gone.
  Its all-time extent now comes from the host:
  [`SignalCache`](../../apps/gui/src-tauri/src/signal_cache.rs) maintains
  a running `(lo, hi)` over every decoded sample (the catch-up is factored
  into a shared `catch_up`, used by both `slice` and the new `min_max`),
  and [`signal_min_max`](../../apps/gui/src-tauri/src/lib.rs) returns it
  per signal as a [`SignalExtent`] — a **scalar model query** (ADR 0025),
  not part of the windowed `DecimatedRange` accessor. The plot fetches it
  in parallel with `sample_signals` (only when following live), so it adds
  no wall-clock. `PlotArea`'s auto-norm now resolves its range by mode:
  follow-live → host extent; paused/zoomed → the visible slice's own
  min/max; manual Fit Y → a view-local `manualRangesRef` pin (a user
  display override, which legitimately stays frontend). Host sees every
  sample (not just decimated buckets), so the y-axis is strictly more
  stable than the old latch. `cargo test -p cannet-gui` (203) and `pnpm
  --dir apps/gui test` (424) green; clippy clean; build clean.
- **Remaining (part 2):** fold `cacheRef` / `fetchKey` / anchor-reset onto
  the shared windowed-source lifecycle via a `DecimatedRange` sibling hook
  (`useDecimatedRange`) — ADR 0025 makes the plot the one time-addressed,
  lossy view, so it gets a sibling of `useWindowedQuery`, not that hook
  itself. `resample` keeps only renderer-shaping (auto-norm math,
  `mergeSeries`, enum mode, `uPlot.setData`, the follow-live edge slide).

## Non-goals

- **One accessor signature.** `RowPage` and `DecimatedRange` stay
  distinct; the plot stays time-addressed and lossy.
- **A big-bang rewrite.** Slices land one at a time, each leaving the
  app working and tested.
- **Moving rendering host-side.** uPlot series merging and virtualizer
  geometry stay in the view.
- **Disk-spill itself.** Slices 1-4 land against the in-RAM `Vec`; the
  random-access disk-spilled store is Task 18, behind the
  Slice-1-frozen contract.

## Sequencing

Slices are ordered: 1 establishes the primitive *and* freezes the host
accessor signatures, 2 and 3 deliver real view wins on it, 4 retires
the most complex hand-rolled cache. The convergence is a **view-side**
refactor; the indefinite-length / disk-spill work is the **model-side**
Task 18. They meet only at the host accessor signatures, which Slice 1
freezes — so Slices 1-4 land first against the in-RAM `Vec`, and Task 18
then provides a second implementation of the same frozen contract.

## Exit criteria

- All four data views render through the shared primitive; the bespoke
  per-view caches (`chunkCache`/`refreshChunk`, `chronoFiltered` +
  `FILTERED_CAP`, the client-side by-ID re-sort, `PlotArea`'s
  `cacheRef`/`traceRangesRef`) are gone.
- `RowPage` and `DecimatedRange` exist as frozen, disk-spill-ready host
  signatures per ADR 0025, implemented over the in-RAM `Vec`.
- Filtered chrono pages the full match history; by-ID pages, sorts
  host-side, and is filterable; the plot's per-signal extent is a host
  query.
- Each slice's acceptance list above is met; `pnpm --dir apps/gui test`
  and `cargo test -p cannet-gui` are green.
- The filtered-trace / by-ID items in `plans/backlog.md` are removed.
- README and rustdoc reflect the windowed-source contract (ADR 0025).
</content>
