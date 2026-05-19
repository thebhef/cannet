# Windowed-model convergence

Status: proposed. Not yet scheduled into `plans/phased-implementation.md`
— see "Priority and sequencing" below.

This is the canonical statement of the GUI's **thin views over a
windowed model** principle and the coordinated plan to converge on it.
`plans/ui-architecture-backlog.md` tracks the individual deviations;
this doc is the plan that closes them as one piece.

## Principle

Every data-bearing GUI view is a **window over the host-side
`TraceStore`**. The host owns the data and every fact derived from it:
row order, sort, decimation, frame rate, and extent. A view owns only
its scroll position, selection, and rendering. A view must never
re-derive a model fact (rate, extent, time↔index, sort order) in JS.

The host is the model; the view is thin.

## Why now

Four views each hand-roll their own window cache, invalidation, and
extent bookkeeping:

| View | Host command | Hand-rolled cache |
|---|---|---|
| Chrono trace (raw) | `fetch_trace_range` | `App.tsx` `chunkCache` / `refreshChunk` |
| Chrono trace (filtered) | `fetch_trace_range` + predicate | `TracePanel.tsx` `chronoFiltered`, capped at `FILTERED_CAP` |
| By-ID table | `fetch_latest_by_id` | refetched whole every grow tick; sorted in `ByIdTable.tsx` |
| Plot | `sample_signals` | `PlotArea` `cacheRef` / `fetchKey` / `fps` / `traceRangesRef` |

Each independently re-implements: a request memo-key, invalidation on
window re-anchor (`winStart` change) and on buffer clear
(`winEnd < lastWinEnd`), an epoch bump to trigger re-render, and
incremental catch-up as the buffer grows. CLAUDE.md calls hand-rolled
caching the expensive-to-review surface — and this one has already
shipped a bug (Slice 0).

## Not one paging API

The four views do not share an *accessor*. They divide into three
genuinely different access patterns:

| Pattern | Addressed by | Bounded by | Result | Views |
|---|---|---|---|---|
| Sequential window | row index `[off, off+limit)` | row count | exact rows | chrono raw + filtered |
| Keyed snapshot | key (arbitration id) | id-space | latest-per-key | by-ID |
| Decimated range | time `[t0, t1]` + resolution | pixel budget | **lossy** min/max buckets | plot |

A literal `page(offset, limit)` signature fits the first pattern.
By-ID can be expressed as paging over a host-sorted list. The plot
cannot: its "limit" is a pixel budget and its result is lossy — "page
3 of RPM" is meaningless.

So convergence means **one lifecycle contract, three accessors** —
not one signature.

## Layer A — the windowed-source contract

Every windowed host response carries, alongside its payload:

- **`extent`** — model-owned bounds. `count` for row-addressed views;
  `{ firstSeconds, lastSeconds }` for the time-addressed plot.
- **positioning** — the echoed `offset` / `t0,t1` so the view can
  place the payload without arithmetic.

Every windowed *frontend* source exposes a shared lifecycle:

- a **request descriptor** — serializable; an unchanged descriptor
  means no round-trip;
- a **`version`** epoch — bumped when cached data changes;
- **invalidation** on window re-anchor and on buffer clear/shrink;
- **catch-up** — incremental fetch as the buffer grows.

`TraceData` ([apps/gui/src/traceData.ts](apps/gui/src/traceData.ts))
— `{ count, version, getFrame, ensureVisible }` — is the existing,
correct reference for the sequential case. The lifecycle above is
extracted from it into a shared primitive (`useWindowedQuery`, exact
shape settled in Slice 1) so the other accessors reuse it.

## Layer B — the three accessors

- **`RowPage`** — `{ offset, limit } → { rows, total }`. Chrono raw +
  filtered.
- **`KeyedSnapshot`** — `{ sortKey, sortDir } → { rows, total }`,
  host-sorted. By-ID.
- **`DecimatedRange`** — `{ t0, t1, maxPoints } → { points, extent }`.
  Plot.

Each returns through the same Layer-A lifecycle. Series merging for
uPlot stays in the plot view — it is renderer-shaping of
already-bounded data, not a model fact.

## Slices

Each slice ships independently and leaves the app working and tested
(`pnpm --dir apps/gui test`, `cargo test -p cannet-gui`).

### Slice 0 — Plot extent: stop extrapolating

The live bug behind this doc. `PlotArea.resample`
([apps/gui/src/PlotPanel.tsx](apps/gui/src/PlotPanel.tsx)) computes
the live-edge time as `winFrames / cache.fps`, where `cache.fps` is
latched once on the first non-empty fetch. With a non-uniform
aggregate frame rate — e.g. two servers streaming staggered onto
different buses — the latched rate no longer matches steady state, so
"fit data" and follow-live snap the x-axis to a wrong extent (~700 s
observed for ~403 s of data). The error depends on latch timing, so
it presents as flake.

The host **already returns the right value**: `SignalsSample.last_seconds`
is `frame_timestamps(from_index, window_end)` over the full trace
window — the visible-x slice travels separately in
`from_seconds`/`to_seconds` and does not affect it. `resample` already
stores it as `cache.lastT`. The bug is only that `resample` prefers
the `winFrames / cache.fps` extrapolation over `cache.lastT`.

Fix: report `cache.lastT` as the extent (both the real-fetch and the
memo-hit paths); delete the `cache.fps` latch and the `winFrames / fps`
branch; correct the now-false comments that claim `cache.lastT` is the
zoomed-slice edge; correct the `resample` docstring's "full signal
extent" to "full window extent" — the panel's areas share one x-axis,
so fit-data fits the capture window, not a per-signal extent.

Acceptance:
- "fit data" sets x to the trace window's true extent for a capture
  whose plotted signal ends before the window does;
- repeated runs under a staggered multi-server rate are stable;
- a regression test covers the extent value;
- the `[fix]` item in `ui-architecture-backlog.md` and the matching
  `[bug]` in `plans/backlog.md` are removed.

Independently shippable — no dependency on Slices 1-4.

### Slice 1 — The contract, with raw chrono as reference

Extract the Layer-A lifecycle into the shared primitive; make raw
chrono (`App.tsx` `chunkCache`/`refreshChunk` behind `TraceData`) its
first consumer. Pure refactor — no behavior change.

Acceptance:
- chrono trace behaves identically (scroll, auto-scroll, clear,
  new-connection re-anchor);
- `App.tsx`'s bespoke chunk-cache bookkeeping is replaced by the
  primitive;
- the primitive has unit tests for descriptor memoisation and for
  invalidation on re-anchor and buffer clear;
- existing trace tests stay green.

### Slice 2 — Filtered chrono onto the contract

Add a host command returning `{ total, rows[offset..offset+limit] }`
for the predicate-filtered trace, with `FilterPredicate::needs_decode()`
so id/bus predicates skip decoding non-matches. The filtered
`TracePanel` path uses the shared primitive; `FILTERED_CAP` is removed.

Acceptance:
- the filtered trace pages the full match history, not just the last
  `FILTERED_CAP` matches;
- virtualizer indexing stays correct while matches stream in; a flood
  received while scrolled into history does not shift the view;
- the host command is unit-tested for `total`/`offset`/`limit`;
- the matching filtered-trace items in `plans/backlog.md` are removed.

### Slice 3 — By-ID onto the contract

`fetch_latest_by_id` (or a successor) returns a host-sorted, paged
`{ total, rows[offset..offset+limit] }`; sort key and direction travel
in the request. `ByIdTable` reads through the shared primitive; the
client-side re-sort is removed.

Row count is bounded by id-space, so paging here is mostly a
uniformity win — a single generous page without virtualization is an
acceptable outcome if virtualization proves to be overkill; decide
within the slice.

Acceptance:
- by-ID rows are sorted host-side; the view holds no sort logic;
- the paused/stopped snapshot-correctness item already in
  `plans/backlog.md` is folded in;
- the `[review]` by-ID item in `ui-architecture-backlog.md` is
  resolved (removed, or replaced with the documented decision).

### Slice 4 — Plot onto the shared cache primitive

Fold `PlotArea`'s `cacheRef` / `fetchKey` memo / anchor-reset logic
onto the shared primitive via the `DecimatedRange` accessor. Move
`traceRangesRef` — the widen-only per-signal min/max latch, which is
capture-lifetime *model* state held in a React ref — host-side as a
`min_max` query against `signal_cache::SignalCacheStore`.

Acceptance:
- plot resample behaviour is unchanged;
- the per-signal extent comes from the host, not a JS ref;
- `resample`'s hand-rolled cache bookkeeping and `traceRangesRef` are
  gone;
- the `[review]` resample item in `ui-architecture-backlog.md` is
  resolved.

## Non-goals

- **One accessor signature.** The three accessors stay distinct; the
  plot stays time-addressed and lossy.
- **A big-bang rewrite.** Slices land one at a time, each leaving the
  app working and tested.
- **Moving rendering host-side.** uPlot series merging and
  virtualizer geometry stay in the view.

## Priority and sequencing

High priority: the duplication actively generates bugs and Slice 0
fixes a shipped one. Slice 0 is independent and should land first.
Slices 1→4 are ordered: 1 establishes the contract, 2 and 3 deliver
real view wins on it, 4 retires the most complex hand-rolled cache.

If this should become a numbered phase in
`plans/phased-implementation.md`, slot it after the current phase
rather than expanding one in flight.
