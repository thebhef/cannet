# Windowed-model convergence

Status: Slice 0 shipped. Slices 1-4 are **Phase 10** of
`plans/phased-implementation.md`; the indefinite-length / disk-spill
work they are designed against is **Phase 11**.

This is the canonical statement of the GUI's **thin views over a
windowed model** principle and the coordinated plan to converge on it.
`plans/ui-architecture-backlog.md` tracked the individual deviations;
they are now scheduled into Phases 10 and 11. Domain terms — capture,
capture model, derived projection, view, trace, by-ID view, series,
filter predicate — are defined in [`../docs/CONTEXT.md`](../docs/CONTEXT.md).

## Principle

Every data-bearing GUI view is a **window over the host-side capture
model**. The host owns the data and every fact derived from it: row
order, sort, decimation, frame rate, extent, and the time↔index
mapping. A view owns only its scroll position, selection, and
rendering. A view must never re-derive a model fact in JS.

The host is the model; the view is thin.

"The capture model" is not one structure. It is a **single source of
truth** — the raw frame store — plus **derived projections** computed
from it: the decoded-signal cache, the latest-by-id snapshot, the
per-signal min/max latch. The raw store is authoritative and complete;
a projection is bounded and rebuildable, never a second source of
truth.

## What the model must hold

A capture is **indefinite-length**: multi-hour to multi-day sessions,
10^7 to 10^9 frames. Every historical row stays addressable for the
life of the capture — the user can scroll, filter, or plot any point
in it. GUI interactions stay responsive (< 100 ms, 60 fps) decoupled
from the ingest rate.

Two consequences shape everything below:

- The raw frame store cannot be RAM-resident. At 10^9 frames it spills
  to disk as a **random-access indexed** store (frame index → file
  offset), so any row is O(1) to fetch. It is *not* a ring buffer and
  *not* bounded scrollback — no historical row is ever evicted or made
  unreachable. This is Phase 11; see
  [`../docs/adr/0001-indefinite-length-capture.md`](../docs/adr/0001-indefinite-length-capture.md).
- Any projection that holds per-frame data is also unbounded and must
  not stay RAM-resident: the decoded-signal cache needs a decimated
  persistent tier, the by-id occurrence lists must not be kept whole.
  A projection is bounded or rebuildable by construction.

The GUI side — the four hand-rolled view caches — must page against
this model without ever assuming the capture fits in RAM. That is what
this convergence delivers.

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

## Two accessors, one lifecycle

The four views do not share an *accessor* — but they do not need three
either. They divide into **two** access patterns:

| Pattern | Addressed by | Result | Views |
|---|---|---|---|
| Row page | row index `[off, off+limit)` | exact rows | raw chrono, filtered chrono, by-ID |
| Decimated range | time `[t0, t1]` + pixel budget | **lossy** min/max buckets | plot |

A row page is offset/limit paging over a host-resolved ordered list.
What the list *is* varies — the raw trace in arrival order, the
filtered trace, or the by-id snapshot sorted by a column — but the
*addressing* is identical: a row index into an ordered list, returning
`{ rows, total }`. By-ID is **not** a third pattern: its row count is
bounded by id-space rather than capture length, but it is still
addressed by row index, and it pages and virtualizes exactly like the
chrono views. (An earlier draft of this doc called by-ID a distinct
"keyed snapshot" accessor and considered exempting it from paging —
that conflated *what the list is* with *how it is addressed*, and the
exemption would have meant a second, simpler code path beside the
shared one: more surface, not less.)

The plot genuinely cannot be a row page: its "limit" is a pixel budget
and its result is lossy — "page 3 of RPM" is meaningless.

So convergence is **one lifecycle contract, two accessors**.

## Layer A — the windowed-source contract

The host accessor signatures are **frozen in Slice 1 as disk-spill-
ready** trait/command signatures — random-access, async, paged — so
Phase 11 is a second implementation behind the same surface, not a
redesign.

Every windowed host response carries, alongside its payload:

- **`extent`** — model-owned bounds. `count` for row-addressed views;
  `{ firstSeconds, lastSeconds }` for the time-addressed plot. Extent
  advances on every capture growth tick; it is cheap and drives only
  the scrollbar.
- **positioning** — the echoed `offset` / `t0,t1` so the view places
  the payload without arithmetic.

Every windowed *frontend* source exposes a shared lifecycle:

- a **request descriptor** — serializable; an unchanged descriptor
  means no round-trip. The descriptor carries everything that
  determines the result: the window, the filter predicate, the sort
  key, decode settings.
- a **content `version`** — bumped only when data *inside the
  requested window* changes; distinct from `extent`.
- **invalidation** — a view re-fetches its window only on: re-anchor
  (the user scrolls), a **descriptor change** (filter predicate, sort,
  decode settings), buffer clear/shrink, or — for a window anchored to
  the live edge — growth extending into it (tail-only catch-up).

**Extent-advance is not content-change.** When the capture grows, a
view scrolled into history updates its scrollbar from the new `extent`
and does *not* re-fetch — the raw and filtered traces are append-only
*for a fixed descriptor*, so new frames only ever land at the tail. A
view anchored to the live edge catches up. This keeps re-fetch cost
proportional to actual viewport change, not to ingest rate — critical
at 10^9 frames under high ingest.

The filter predicate is part of the descriptor, not a property of the
capture. The filtered trace is "every frame since the trace's start
that matches the *current* predicate" — so editing the filter is a
descriptor change that re-derives the whole filtered trace over
`[start, now]` against the new predicate and re-fetches the window.
Append-only history holds only while the descriptor is fixed.

`TraceData` ([apps/gui/src/traceData.ts](apps/gui/src/traceData.ts))
— `{ count, version, getFrame, ensureVisible }` — is the existing,
correct reference for the row-page case. The lifecycle above is
extracted from it into a shared primitive (`useWindowedQuery`, exact
shape settled in Slice 1) so the other views reuse it.

## Layer B — the two accessors

- **`RowPage`** — `{ descriptor, offset, limit } → { rows, total }`. A
  generic frontend accessor (`RowPage<T>`) over `useWindowedQuery`;
  `T` is the trace row for chrono, the id-summary row for by-ID. It is
  backed by **two host commands**, because the row payload genuinely
  differs:
  - `fetch_trace_range(predicate?, offset, limit) → { rows, total }` —
    raw chrono (no predicate) and filtered chrono (with one).
  - `fetch_by_id_page(predicate?, sortKey, sortDir, offset, limit) →
    { rows, total }` — the by-ID view. Filterable: with a predicate it
    is the by-ID snapshot *of the filtered trace* — latest-per-id and
    every stat (count, period, last payload) computed over the
    matching frames only. The `FilterPredicate` machinery (incl.
    `needs_decode()`) is built in Slice 2 and reused here.
- **`DecimatedRange`** — `{ t0, t1, maxPoints } → { points, extent }`.
  The plot. Time-addressed, lossy, min/max buckets so spikes survive.

Both return through the same Layer-A lifecycle. Series merging for
uPlot stays in the plot view — renderer-shaping of already-bounded
data, not a model fact.

Not everything host-side is a windowed accessor: scalar model facts (a
signal's all-time min/max, the distinct-id count) are plain queries.
The two accessors are the *windowed* contract.

## Slices

Each slice ships independently and leaves the app working and tested
(`pnpm --dir apps/gui test`, `cargo test -p cannet-gui`). Slices 1-4
land against the current in-RAM `TraceStore` `Vec`; Phase 11 swaps the
host implementation behind the frozen contract.

### Slice 0 — Plot extent: stop extrapolating ✅ shipped

Shipped in `ad76899`. `PlotArea.resample`
([apps/gui/src/PlotPanel.tsx](apps/gui/src/PlotPanel.tsx)) used to
compute the live-edge time as `winFrames / cache.fps`, where
`cache.fps` was latched once on the first non-empty fetch. Under a
non-uniform aggregate frame rate — e.g. two servers streaming
staggered onto different buses — the latched rate drifted from steady
state, so "fit data" and follow-live snapped the x-axis to a wrong
extent.

The `cache.fps` latch is gone. The plot extent now comes straight from
the host's `SignalsSample.last_seconds` (stored as `cache.lastT`); the
visible-x slice still travels separately in `from_seconds` /
`to_seconds`. `decodeSignalsSample`'s `last_seconds` handling is
covered by `plotData.test.ts`.

Independently shippable — no dependency on Slices 1-4.

### Slice 1 — The contract, with raw chrono as reference

Extract the Layer-A lifecycle into the shared primitive
(`useWindowedQuery`); make raw chrono (`App.tsx`
`chunkCache`/`refreshChunk` behind `TraceData`) its first consumer.
**Also freeze the host accessor contract** — `RowPage` and
`DecimatedRange` as explicit, disk-spill-ready trait/command
signatures (random-access, async, paged) — so Phase 11 is a second
implementation behind them, not a redesign. Frontend behavior is
unchanged.

Acceptance:
- chrono trace behaves identically (scroll, auto-scroll, clear,
  new-connection re-anchor);
- `App.tsx`'s bespoke chunk-cache bookkeeping is replaced by the
  primitive;
- `RowPage` and `DecimatedRange` are defined as frozen signatures,
  documented as implemented over the in-RAM `Vec` in Slices 2-4 and
  reimplemented over the disk-spilled store in Phase 11;
- the primitive has unit tests for descriptor memoisation and for
  invalidation on re-anchor, descriptor change, and buffer clear —
  including that an extent advance alone does not re-fetch a history
  window;
- existing trace tests stay green.

### Slice 2 — Filtered chrono onto the contract

`fetch_trace_range` gains an optional `FilterPredicate` and returns
`{ total, rows[offset..offset+limit] }` for the predicate-filtered
trace, with `FilterPredicate::needs_decode()` so id/bus predicates
skip decoding non-matches. The filtered `TracePanel` path uses the
shared primitive; `FILTERED_CAP` is removed.

Over the in-RAM `Vec` the host scan is O(window); that is acceptable
at `Vec` scale and is what Phase 11's filter index makes O(page) at
10^9 frames.

Acceptance:
- the filtered trace pages the full match history, not just the last
  `FILTERED_CAP` matches;
- editing the filter re-derives the filtered trace over `[start, now]`
  against the new predicate (a descriptor change);
- virtualizer indexing stays correct while matches stream in; a flood
  received while scrolled into history does not shift the view;
- the host command is unit-tested for `total`/`offset`/`limit`.

### Slice 3 — By-ID onto the contract

`fetch_by_id_page(predicate?, sortKey, sortDir, offset, limit)`
returns a host-sorted, paged `{ total, rows[offset..offset+limit] }`.
`ByIdTable` reads through the shared `RowPage<T>` primitive exactly
like the chrono views — it pages and virtualizes; the client-side
re-sort is removed and the sort moves host-side.

By-ID is filterable: with a predicate it is the by-ID snapshot of the
filtered trace (see Layer B). Row count is bounded by id-space, so in
practice the virtualizer fetches few pages — but it is the same code
path, not a special whole-fetch.

Acceptance:
- by-ID rows are sorted host-side; the view holds no sort logic;
- by-ID pages through the same `RowPage` primitive as chrono — no
  separate unpaged path;
- a predicate filters by-ID as the snapshot of the filtered trace;
- the paused/stopped snapshot-correctness item already in
  `plans/backlog.md` is folded in;
- the by-ID deviation listed in `ui-architecture-backlog.md` is
  removed.

### Slice 4 — Plot onto the shared cache primitive

Fold `PlotArea`'s `cacheRef` / `fetchKey` memo / anchor-reset logic
onto the shared primitive via the `DecimatedRange` accessor. Move
`traceRangesRef` — the widen-only per-signal min/max latch, which is
capture-lifetime *model* state held in a React ref — host-side as a
`min_max` query against the per-signal min/max latch projection.

Over the in-RAM `Vec` the plot samples the current append-only
`SignalCacheStore`; Phase 11 gives that projection its decimated
persistent tier so "fit data" stays fast at 10^9 frames.

Acceptance:
- plot resample behaviour is unchanged;
- the per-signal extent comes from the host, not a JS ref;
- `resample`'s hand-rolled cache bookkeeping and `traceRangesRef` are
  gone;
- the `resample` deviation listed in `ui-architecture-backlog.md` is
  removed.

## Non-goals

- **One accessor signature.** `RowPage` and `DecimatedRange` stay
  distinct; the plot stays time-addressed and lossy.
- **A big-bang rewrite.** Slices land one at a time, each leaving the
  app working and tested.
- **Moving rendering host-side.** uPlot series merging and virtualizer
  geometry stay in the view.
- **Disk-spill itself.** Slices 1-4 land against the in-RAM `Vec`; the
  random-access disk-spilled store is Phase 11, behind the
  Slice-1-frozen contract.

## Priority and sequencing

This is **Phase 10** of `plans/phased-implementation.md`. The
duplication actively generates bugs — Slice 0 (shipped) fixed one.
Slices 1-4 are ordered: 1 establishes the contract *and* freezes the
host accessor signatures, 2 and 3 deliver real view wins on it, 4
retires the most complex hand-rolled cache.

The convergence is a **view-side** refactor; the indefinite-length /
disk-spill work is a **model-side** change (**Phase 11**). They meet
only at the host accessor signatures, which Slice 1 freezes. So Slices
1-4 land first, against the in-RAM `Vec`; Phase 11 then provides a
second implementation of the same frozen contract. See
[`../docs/adr/0001-indefinite-length-capture.md`](../docs/adr/0001-indefinite-length-capture.md).
