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

### `[cleanup]` `decimatePoints` is dead code with a misleading comment

`plotData.ts`'s `decimatePoints` is referenced only by its own test.
Its doc claims it is *"used to keep a plot area's accumulated cache
bounded without a round-trip"* — but the plot cache is no longer
accumulated; each resample replaces it wholesale. Leftover from when
the frontend hoarded plot data. Remove the function, its test, and the
stale comment.

## Scheduled into phases

The view/model deviations this file tracked are now scheduled — see
`plans/phased-implementation.md` Phases 10-11 and
[windowed-model-convergence.md](windowed-model-convergence.md):

- **PlotPanel `resample` — model state in a view.** `traceRangesRef`,
  the capture-lifetime per-signal min/max latch held in a React ref,
  is model state. Resolved by **Phase 10 Slice 4** — the latch moves
  host-side as a `min_max` query.
- **By-ID view — unpaged snapshot, client-side sort.** Resolved by
  **Phase 10 Slice 3** — by-ID pages through the shared `RowPage`
  primitive and sorts host-side.
- **Filtered-trace scan O(window)** and **unbounded decoded-sample
  cache** — the model-side data-volume deviations — are scheduled into
  **Phase 11** (indefinite-length capture) as the filter index and the
  decimated decoded-sample tier.
