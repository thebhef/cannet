# ADR 0025 — Frontend windowed-source contract: two accessors over one lifecycle

Status: accepted (2026-06-02)

## Context

The host owns the capture model and every fact derived from it; the
GUI renders thin views over it ([ADR 0003](0003-tauri-shell-react-frontend.md)),
and the capture is indefinite-length so no view may hold it whole
([ADR 0001](0001-indefinite-length-capture.md)). Every data-bearing
view is therefore a **window** over the model: it fetches the slice the
viewport shows and must know when that slice is stale.

Four views do this — raw chronological trace, filtered trace, by-ID
table, and plot. This ADR settles the *contract* they share: how a view
addresses a window, what a windowed response carries, and when a view
must re-fetch. Fixing it once means one frontend primitive and one set
of host signatures instead of four hand-rolled caches, and the same
surface over both the in-RAM and the disk-spilled
([ADR 0002](0002-disk-spill-store.md)) store.

## Decision

### Two access patterns

The views divide into **two** patterns — not one, not three:

| Pattern | Addressed by | Result | Views |
| --- | --- | --- | --- |
| Row page | row index `[off, off+limit)` | exact rows | raw chrono, filtered chrono, by-ID |
| Decimated range | time `[t0, t1]` + pixel budget | lossy min/max buckets | plot |

By-ID is **not** a third pattern: its row count is bounded by id-space
rather than capture length, but it is addressed by row index and pages
exactly like the chrono views. The plot **cannot** be a row page — its
"limit" is a pixel budget and its result is lossy, so "page 3 of RPM"
is meaningless.

### Layer A — the windowed-source lifecycle

Every windowed host **response** carries, alongside its payload:

- **`extent`** — model-owned bounds: `count` for row-addressed views,
  `{ firstSeconds, lastSeconds }` for the plot. It advances on every
  capture growth tick and drives only the scrollbar.
- **positioning** — the echoed `offset` / `t0,t1`, so the view places
  the payload without re-deriving where it goes.

Every windowed frontend **source** exposes:

- a **request descriptor** — serializable, carrying everything that
  determines the result (window, filter predicate, sort key, decode
  settings). An unchanged descriptor means no round-trip.
- a **content `version`** — bumped only when data *inside the requested
  window* changes; distinct from `extent`.
- **invalidation** — the view re-fetches only on re-anchor (the user
  scrolls), a descriptor change, buffer clear/shrink, or — for a window
  anchored to the live edge — growth extending into it.

Two rules keep the lifecycle correct under high ingest:

- **Extent-advance is not content-change.** A view parked in history
  updates its scrollbar from the new `extent` and does *not* re-fetch:
  for a fixed descriptor the row-addressed views are append-only, so new
  frames land only at the tail. This bounds re-fetch cost to actual
  viewport change, not to ingest rate.
- **The filter predicate is part of the descriptor, not a property of
  the capture.** The filtered trace is every frame since the trace's
  start matching the *current* predicate; editing the predicate is a
  descriptor change that re-derives the view over `[start, now]` and
  re-fetches. Append-only history holds only while the descriptor is
  fixed.

### Layer B — the two accessors

- **`RowPage`** — `{ descriptor, offset, limit } → { rows, total }`,
  backed by two host commands because the payload genuinely differs:
  - `fetch_trace_range(predicate?, offset, limit)` — raw chrono (no
    predicate) and filtered chrono (with one).
  - `fetch_by_id_page(predicate?, sortKey, sortDir, offset, limit)` —
    the by-ID view, host-sorted. With a predicate it is the by-ID
    snapshot *of the filtered trace* (every per-id stat computed over
    matching frames only).
- **`DecimatedRange`** — `{ t0, t1, maxPoints } → { points, extent }` —
  the plot. Time-addressed and lossy, with per-bucket min/max so spikes
  survive.

The signatures are **async, paged, and random-access**, independent of
the store behind them: the same surface serves the in-RAM `Vec` and the
disk-spilled store. Scalar model facts (a signal's all-time min/max,
the distinct-id count) are plain queries, not windowed accessors.
Renderer-shaping of already-bounded data (merging series for uPlot)
stays in the view.

## Alternatives considered

- **One unified accessor signature.** Rejected: the plot is
  time-addressed and lossy, a row page is index-addressed and exact.
  Collapsing them forces lossy semantics onto exact views and loses the
  distinction.
- **By-ID as a third "keyed snapshot" accessor, exempt from paging.**
  Rejected: it conflates *what the list is* with *how it is addressed*.
  By-ID is row-index-addressed like the others; exempting it would mean
  a second, simpler code path beside the shared one — more surface, not
  less.
- **Per-view hand-rolled caches (the status quo).** Rejected: four
  independent re-implementations of the same request memo-key,
  invalidation, extent bookkeeping, and tail catch-up — the
  expensive-to-review hand-rolled-caching surface CLAUDE.md warns
  against, which has already shipped a bug.

## Consequences

- The four views converge onto this contract incrementally rather than
  in a big-bang rewrite.
- The `RowPage` / `DecimatedRange` references in
  [ADR 0001](0001-indefinite-length-capture.md) and
  [ADR 0002](0002-disk-spill-store.md) resolve here.
- Swapping the host store (in-RAM `Vec` ↔ disk-spilled) is an
  implementation change behind these signatures, not a contract change.
</content>
