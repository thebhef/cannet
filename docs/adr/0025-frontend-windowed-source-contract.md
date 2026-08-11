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

### How the views map onto the model

The model is one append-only sequence of frames. Each view extracts a
different *shape* from it — which is why the contract needs two
accessors, not one and not four:

```text
  model:  frame index → 0   1   2   3   4   5   6   7   8   9  … tip
                        ▓   ░   ▓   ▓   ░   ▒   ▓   ░   ▒   ▓
                        append-only; host also keeps O(1) side indices:
                        newest-per-id, per-id index lists, per-id/bus rates

  raw chrono       a contiguous index range              → RowPage
                   …▓ ░ ▓[▓ ░ ▒ ▓]░ ▒ ▓…                   rows[off, off+limit)

  filtered chrono  the matching subsequence               → RowPage
                   ▓ ░ ▓ ▓ ░ ▒ ▓ ░ ▒ ▓
                   ●     ●         ●   (keep predicate)     matches[off, off+limit)

  by-ID            newest index per id (+ rate, count)    → RowPage
                   collapses the window to one row per id
                   A→6   B→8   C→9

  plot             per-signal indices, bucketed by time   → DecimatedRange
                   sig: 0─2─3─6 …      min/max per pixel column
                   t:   ├──┼──┼──┤     [from, to] seconds, lossy
```

Three of the four extract **rows addressed by index** — a range, a
filtered subsequence, or a newest-per-id collapse — and differ only in
*which* rows, not in how they are addressed or what a row is. The plot is
the odd one out: it is addressed by **time** and its result is **lossy**
(one min/max bucket per pixel), so "page 3 of RPM" is meaningless. That
single distinction is the whole reason for two accessors.

In every case the view holds only its current window; the host does all
index↔time mapping, filtering, newest-per-id selection, rate estimation,
and decimation against the one buffer.

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
- **A live refresh re-fetches what the view is looking at, not page 0.**
  Append-only sources (the chronological tables) grow at one end, so
  "keep up" means re-paging the tail. The by-ID snapshot does not: its
  rows go stale *in place* — latest value, rate, newly-seen ids — with
  no meaningful tail. Refreshing it from offset 0 both re-fetched rows
  the viewport isn't showing and yanked a scrolled view back to the top
  on every tick. The windowed primitive therefore names the two
  behaviours separately (`refresh: "tail" | "window"`), and a source
  picks the one that matches its shape.
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
- **`DecimatedRange`** — `{ t0, t1, maxPoints } → { points, extent,
  complete }` — the plot. Time-addressed and lossy, with per-bucket
  min/max so spikes survive. `complete` is the host's completeness token
  ([ADR 0049](0049-bounded-serves-and-partial-answers.md)): a serve that
  has to build the samples first is bounded in time, so it may answer
  with a prefix, and only this says so. A partial answer is drawn and
  does not satisfy the source's fetch memo, so the next tick continues
  it.

The signatures are **async, paged, and random-access**, independent of
the store behind them: the same surface serves the in-RAM `Vec` and the
disk-spilled store. Scalar model facts (a signal's all-time min/max,
the distinct-id count) are plain queries, not windowed accessors.
Renderer-shaping of already-bounded data (merging series for uPlot)
stays in the view.

### The shape it converges to

One lifecycle under both accessors; each view is a thin source over it,
picking the accessor its result shape needs:

```text
  shared windowed-source lifecycle (Layer A)
  descriptor memo · single-flight · re-anchor on scroll-out ·
  drop-on-descriptor-change · extent tracked separately from content
       │
       ├─ raw chrono   ┐
       │  filtered     ├─ useWindowedQuery ───► RowPage         rows[off, off+limit)
       │  by-ID        ┘  getRow / ensureVisible                index-addressed, exact
       │
       └─ plot           useDecimatedRange ───► DecimatedRange  [t0, t1] + pixel budget
                         visible decimated snapshot             time-addressed, lossy

  scalar model facts (a signal's all-time min/max, distinct-id count)
  are plain queries beside the lifecycle — not windowed accessors.
```

The three row-addressed views share one primitive (`useWindowedQuery`)
and are thin adapters that add only their fetch and descriptor. The plot
cannot be a row page — time-addressed and lossy — so it is that
lifecycle's time-addressed sibling (`useDecimatedRange`), not a fourth
bespoke cache.

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
