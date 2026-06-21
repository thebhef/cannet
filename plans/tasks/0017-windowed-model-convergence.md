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

### Slice 2 — Filtered chrono onto the contract

`fetch_trace_range` gains an optional `FilterPredicate` and returns
`{ total, rows[offset..offset+limit] }` for the predicate-filtered
trace, with `FilterPredicate::needs_decode()` so id/bus predicates skip
decoding non-matches. The filtered `TracePanel` path uses the shared
primitive; `FILTERED_CAP` is removed.

Over the in-RAM `Vec` the host scan is O(window); that is acceptable at
`Vec` scale and is what Task 18's filter index makes O(page) at 10^9
frames.

**Confirmed runtime offender (Task 21 diagnosis).** The current filtered
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

Status (2026-06-21): the dominant cost — the following-live tail cloning
*every* match in the window under the mutex — is fixed tactically in
`scan_window_filtered` (slide match indices, clone only the last `cap`
once after the scan). The remaining O(window) predicate scan still runs
under the mutex; at `Vec` scale it is cheap, and the incremental
match-count above is what removes it for the full slice / Task 18. The
virtual-bus regression test is still owed.

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

Design note (from a reverted Task 21 experiment). When the rewrite
touches the area→panel reporting, prefer a single report object
(`{ lastT, series, perf/host/rate/cache gauges, base }`) over today's
six-callback fan-out — it's the cleaner shape. But do **not** assume
coalescing those reports buys render-cost: a tactical version that
bundled them and flushed once per `requestAnimationFrame` left the
plot over-render *entirely unchanged* and broke follow-live by
deferring the x-window slide a frame. So measure before adding any
batching, and keep the live-edge slide synchronous with the resample
that produced it.

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
