# UI architecture backlog

Known and suspected places where the GUI deviates from the
**thin views over a windowed model** principle — see
[windowed-model-convergence.md](windowed-model-convergence.md), the
canonical statement of the principle and the coordinated, sliced plan
to close these items. This file is a focused companion to
`plans/backlog.md`: same prunable, one-bullet-per-item discipline, but
scoped to the view/model boundary.

When an item is fixed, remove it in the same commit. When a new
deviation is noticed, add it here instead of doing drive-by work.

## Conventions

- One item per heading. Include file paths / symbols so the next
  reader can act without spelunking.
- Tag with `[fix]` (a real deviation to correct), `[review]` (could go
  either way — decide and either fix or document the decision), or
  `[cleanup]`.
- Cross-reference `plans/backlog.md` rather than duplicating items that
  already live there.

## Items

### `[review]` PlotPanel `resample` — signal-processing and model state in a view

`PlotPanel.tsx`'s `resample` (~330 lines) does substantial domain
computation in JS: per-trace auto-normalisation, series merging, and
an fps estimate. Most of it operates on already-paged, bounded data
(≤ `canvasW × 2` points per signal) and is defensible as
renderer-shaping — but `traceRangesRef` (the "widen-only" per-signal
min/max latch) is **capture-lifetime model state held in a React
ref**: it deliberately survives cache anchor resets so it is not
recomputed from the visible window. A per-signal running extent is a
fact the model owns. Decide: expose a `min_max`-style host query
against `SignalCacheStore` and let the view read it, or document why
the latch stays view-side. Series merging for uPlot can reasonably
remain in the view. → [windowed-model-convergence.md](windowed-model-convergence.md)
**Slice 4.**

### `[cleanup]` `decimatePoints` is dead code with a misleading comment

`plotData.ts`'s `decimatePoints` is referenced only by its own test.
Its doc claims it is *"used to keep a plot area's accumulated cache
bounded without a round-trip"* — but the plot cache is no longer
accumulated; each resample replaces it wholesale. Leftover from when
the frontend hoarded plot data. Remove the function, its test, and the
stale comment.

### `[review]` By-ID view fetches an unpaged snapshot and sorts client-side

`TracePanel.tsx` calls `fetch_latest_by_id`, which returns **every**
row (one per arbitration id) — not paged, not virtualized
(`ByIdTable.tsx`) — and re-sorts a copy in JS on every render. It is
refetched and recomputed host-side every grow tick while running. Row
count is bounded by id-space (not capture length), so this is the most
defensible borderline case — but it is still a timeseries-derived view
that neither pages nor virtualizes, with sort logic in the view.
Decide: accept it (and note the bound), or page/virtualize and move
the sort host-side. Related correctness item already in
`plans/backlog.md` (tighten the by-ID snapshot for a paused/stopped
trace). → [windowed-model-convergence.md](windowed-model-convergence.md)
**Slice 3.**

### `[fix]` Frontend extrapolates frame-rate and time→index mapping

`PlotPanel.tsx`'s resample derives an `fps` estimate and uses it to
convert seconds↔frame-indices and to extrapolate the live edge —
arithmetic the model knows precisely. Already tracked in
`plans/backlog.md` as a `[bug]` (latched-fps `liveEdgeT` drift) and a
`[perf]` (time-to-frame mapping) item. Fixed by
[windowed-model-convergence.md](windowed-model-convergence.md)
**Slice 0**: the host already returns the precise value
(`SignalsSample.last_seconds`); the view only has to stop preferring
the `winFrames / fps` extrapolation over it.

## Related items already in `plans/backlog.md`

These are model-side (host) data-volume concerns, not GUI-too-thick,
but they sit on the same boundary — keep them in mind when addressing
the items above:

- `[perf]` Index the filtered trace scan (`fetch_filtered_trace` is
  O(window) per call).
- `[perf]` Bound the host-side decoded-sample cache
  (`signal_cache::SignalCacheStore` is append-only / unbounded).
