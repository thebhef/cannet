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
`plans/phased-implementation.md` Phases 11-12,
[windowed-model-convergence.md](windowed-model-convergence.md), and
the normative ADRs
[`../docs/adr/0001-indefinite-length-capture.md`](../docs/adr/0001-indefinite-length-capture.md)
(requirement) and
[`../docs/adr/0002-disk-spill-store.md`](../docs/adr/0002-disk-spill-store.md)
(design):

- **PlotPanel `resample` — model state in a view.** `traceRangesRef`,
  the capture-lifetime per-signal min/max latch held in a React ref,
  is model state. Resolved by **Phase 16 Slice 4** — the latch moves
  host-side as a `min_max` query.
- **By-ID view — unpaged snapshot, client-side sort.** Resolved by
  **Phase 16 Slice 3** — by-ID pages through the shared `RowPage`
  primitive and sorts host-side.
- **Filtered trace — frontend cap + host scan complexity.** Two
  distinct deviations:
  - *View-side:* `TracePanel.tsx`'s `chronoFiltered` array, capped at
    `FILTERED_CAP`, holds match history in the frontend. Resolved by
    **Phase 16 Slice 2** — the filtered path moves to the shared
    `RowPage` primitive and the cap is removed.
  - *Model-side:* the host filter scan is O(capture) today; Slice 2
    brings it to O(window) on the in-RAM `Vec`; **Phase 17** makes it
    O(page) via the materialized filter index — ADR 0002 **DS-3**, where
    every predicate is id-narrowable against the DBC so no index build
    is an O(capture) scan.
- **Unbounded decoded-sample cache.** Scheduled into **Phase 17** as
  ADR 0002 **DS-5** — a per-signal min/max **resolution pyramid**,
  built lazily on first plot and by-id-accelerated, that `DecimatedRange`
  reads at the coarsest level above `maxPoints` so "fit data" stays
  bounded at 10^9 frames.
