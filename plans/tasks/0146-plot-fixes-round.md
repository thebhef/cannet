# Task 146 — A Round of Plot Fixes

Opened by owner instruction 2026-09-19 from user feedback (ungroomed
items 8–12). **Executes now, on the current stack.** Grooming in
progress.

## Why

Five plot-panel defects and rough edges reported from real use. Each
is small; together they are one coherent pass over the plot panel's
rendering.

## Scope

The five items, verbatim from the feedback:

1. **All points**: with show-points on, the rendered points don't
   align with the extrema in the signals and it looks weird, as if
   we're extrapolating.
2. **Bus markers** in the plot panel should follow enable/disable in
   the events panel.
3. **Empty plot areas** should still render the grid and cursors.
4. **Cursor handles/labels** appearing over signals is unfortunate;
   maybe add gutters?
5. **Point markers** still don't show up right on enum lanes.

## Findings (2026-09-19 survey)

Governing ADR: 0026 (plot areas compose, axes configure). Marker
invariants there: "an enum lane draws its own sample markers", "a
marker sits only on a sample", hover reveals markers on every area.

1. **All points.** The host pyramid and `decimate_min_max` keep real
   argmin/argmax samples per bucket, emitted in index order, so the
   served series alternates min, max, min, max at up to
   `2 × max_points + 2` points (~2 × 1.4 × canvas width). The
   frontend then thins markers with a **uniform index stride** to
   `MAX_POINT_MARKERS = 500` (`plotPoints.ts` `sampleMarkerColumns`).
   Most extrema get no dot, and an even stride aliases onto one leg
   of the envelope — a run of dots hugging one side while the line
   oscillates through both, which reads as extrapolation. The
   markers are on the line; the wrong ones are chosen. Secondary:
   `splitExtrapolatedRows` blanks cells inside an extrapolated
   stretch, so a marker there vanishes. `auto` mode goes through a
   different floor; the defect is specific to `on`.
2. **Bus markers vs events panel.** Per-kind visibility is a React
   `useState` inside `useEventKindFilter`, instantiated separately by
   the events panel, the trace panel and the plot panel (which has
   its own checklist in the toolbar overflow menu). The plot honours
   a filter — its own. ADR 0035 says "visibility is still
   view-local", so following the events panel is a **change of a
   recorded decision**. "Bus markers" are `busError`, grouped with
   `truncation` under Diagnostics; not toggleable alone today.
   Adjacent bug: `PlotPanel.tsx` `reportBase` ignores `areaId`
   (last writer wins), so an empty area beside a populated one
   clobbers `baseSeconds` to null and every event marker disappears.
3. **Empty areas.** An empty area does build a uPlot instance and
   canvas, but its resample early-returns without `setScale` on x or
   y; both scales are `auto: false`, uPlot hides an axis whose scale
   has no min, and `valToPos` yields NaN so the draw hook paints
   nothing. `applyXAll` would seed x, but only runs when some area
   has an extent, so a panel of only empty areas never gets a window.
4. **Cursor handles.** There are no handles: cursors are placed by
   click and moved only by clicking again. All cursor chrome (A/B
   time chips, Δt, H1/H2 value chips, ΔH, event label chips) draws
   inside a clip on the data area. Gutter space that already exists:
   the y gutter (52 px, panel-negotiated), and an x strip under every
   axis (18 px blank under upper axes, ~50 px under the bottom one).
   The side panel already shows H1/H2/ΔH; `PlotMeasurements.tsx` is
   the foot strip. Cursor info lives in three places today.
5. **Enum-lane markers.** Four mechanisms, most likely first: (a) a
   lane requests `categorical`, served by `reduce_transitions`
   (first point of each run), so over budget every marker lands on a
   tile edge and the density information ADR 0026 says markers exist
   for is gone — markers appear and vanish with zoom; (b) the marker
   is painted in the tile's own accent on top of a tint of that
   accent, near-invisible (labels solved this with `laneLabelInk`,
   markers did not); (c) marker y is the band-normalised value, the
   tile is the centred 60 % of the band, so for a two-code enum code
   0 sits in the gap; (d) the same stride aliasing as item 1. Prior
   fixes: `25b00229` (markers on the series' own samples),
   `ad7eb638` (hover markers on lanes), `61379f88` (categorical
   serve — the fix that introduced (a)).

Tests: `PlotArea.draw.test.ts` (recording 2D context) is where 1, 4
and 5 regressions belong; `PlotPanel.dom.test.tsx` mocks uPlot
without a canvas so it can pin data, not ink.

## Rulings

- **All points** (owner, 2026-09-20): the 500-marker cap was a
  performance measure, and it may predate many later plot
  performance improvements. So: `Points: On` draws one marker per
  served sample with no cap; the phase measures it with the ADR 0031
  harness and reports the number. If it costs real frame time, the
  fallback is thinning that keeps both legs of every min/max pair,
  never a uniform stride.

- **Bus markers** (owner, 2026-09-20): visibility stays view-local,
  ADR 0035 unchanged. The defect is discoverability: the plot's
  checklist exists only in the toolbar's right-click menu. The plot
  toolbar gets the trace panel's pattern — a visible "Events" chip
  revealing the `EventKindFilter` checklist — and the right-click
  menu copy goes, so there is one control. `busError` stays grouped
  under Diagnostics. Folded in: `PlotPanel.tsx` `reportBase` keys by
  area (today last-writer-wins, so an empty area beside a populated
  one nulls `baseSeconds` and every event marker disappears).

- **Empty areas** (owner, 2026-09-20): an empty area draws the
  shared x grid, the time ticks, and the time cursors A and B,
  placeable by click, over the panel's shared x window. No y
  gridlines and no y scale — the y gutter is blank, as on the
  enum-lanes axis. When no area in the panel has an extent, the x
  window seeds from the session timeline's extent (a host-side model
  fact), so a fresh panel with one empty area shows a grid over the
  capture's span and follows live. The side-panel hint stays.

- **Cursor and event chrome** (owner, 2026-09-20): no new drag
  interaction; the chrome leaves the data area for gutters. Two new
  gutters, once per panel, anchored to the drawing axes the way the
  existing chrome already is (`topDrawingAxis` / `bottomDrawingAxis`)
  so they survive a collapse:
  - a **top gutter** above the top drawing axis holding the event
    label chips, which grows to fit up to two lines of text (the
    existing `wrapMarkerLabel` limit);
  - a **time-cursor gutter** between the bottom drawing axis's plot
    box and its x-axis tick labels, holding the A and B time chips
    and Δt. The time labels remain; they move, they do not go.
  The cursor lines stay on the canvas. H1/H2 value chips and ΔH move
  into the y gutter at the cursor's y on their axis (overseer's
  recommendation, not objected to). Vertical space taken by the two
  gutters is the cost; the top gutter takes only what its current
  labels need.

- **Enum lanes** (owner, 2026-09-20): the lane is an overlay; the
  enum value is plotted under it. Unify the lane onto the ordinary
  series machinery: served, plotted and marked exactly like a numeric
  stepped series, with the tiles an overlay computed from runs of
  equal consecutive served values. The categorical reducer
  (`reduce_transitions`, `window_categorical`, the `categorical`
  fetch flag) and the lane's private marker pass in `drawEnumTiles`
  go. The all-points fix then covers lanes, and marker ink and
  marker y are no longer separate problems. An investigation goes
  first: reproduce the scenario that motivated `61379f88` against
  the plain serve and confirm held states survive at resolvable
  zoom. If a held code is lost, the fix is in the shared fold —
  keep a bucket's first and last sample beside its min and max,
  which a stepped numeric line needs too — not a separate reducer.
  Applies to the single-enum ribbon as well. ADR 0026 amended.

## Phases

1. **Lane serve investigation.** Rebuild the `61379f88` V2 scenario
   (fast-cycling and long-held codes over a window wider than the
   point budget) and serve it through the plain min/max path.
   Verdict with data in this file: held states survive → unify as
   is; a resolvable held code is lost → the shared fold keeps
   first/last beside min/max, and that lands in phase 2. No product
   code lands; a test fixture may.
2. **Markers.** All points: `Points: On` marks every served sample,
   the stride thinning goes, measured with the ADR 0031 harness
   (pair-preserving fallback only if the number says so). Lanes: the
   unification above per phase 1's verdict; categorical reducer and
   private marker pass deleted; tiles from served runs; ADR 0026
   amended. Perf reading after.
3. **Gutters.** The top gutter for event labels (grows to two lines)
   and the time-cursor gutter above the x axis for A/B/Δt, once per
   panel, anchored to the drawing axes so they survive a collapse;
   H1/H2/ΔH into the y gutter. Cursor lines stay on the canvas. No
   drag.
4. **Panel plumbing.** Empty areas draw the x grid, ticks and
   placeable A/B over the shared window, seeded from the session
   extent when no area has one; `reportBase` keyed by area; the
   Events chip in the plot toolbar revealing the checklist, the
   right-click menu copy removed.

## Exit criteria

- Phase 1's verdict is recorded here with the fixture and numbers.
- With `Points: On`, every served sample of a numeric series carries
  a marker; a `PlotArea.draw.test.ts` case pins it, and the harness
  reading for the ev-zonal scenario is recorded in
  `docs/performance-measurements/frontend/`.
- An enum lane is served through the same path as a numeric series;
  `reduce_transitions` and the `categorical` flag no longer exist;
  a lane's markers are uPlot's, drawn on the plotted value, legible
  over the tile; a held state at a window wider than the point
  budget is one tile (test at the width `61379f88` asserted).
- Event label chips draw in a top gutter that is one or two lines
  tall as its labels need; A/B time chips and Δt draw between the
  bottom plot box and the x-axis ticks; none of them draw inside a
  plot box; a collapse of the anchoring axis moves them, not loses
  them.
- An empty plot area shows the x grid, ticks, and A/B cursors that
  can be placed by click; a panel with only an empty area shows the
  session's span and follows live.
- An empty area beside a populated one no longer blanks the panel's
  event markers (regression test on `reportBase`).
- The plot toolbar shows an Events chip; the checklist under it
  hides bus markers; the toolbar right-click menu no longer carries
  the checklist.
- ADR 0026 records the lane unification and the gutters; ADR 0035
  unchanged.

## Status log

### 2026-09-20 — phase 1: lane serve investigation (no product code)

Branch `task146-lane-investigation` off `task142-trace-filter-panel`.
Fixture only:
`apps/gui/src-tauri/src/signal_cache.rs` ::
`plain_min_max_serve_drops_a_held_code_narrower_than_three_pixel_columns`.

**Verdict: a resolvable held code is lost.** Phase 2 changes the
shared fold, as the ruling's second branch says.

#### The scenario `61379f88` asserted

`git show 61379f88` and its status-log A/B: the V2 scenario is
`PackState` 0..=5 on 0x100 at **100 Hz**, stepping on every sample, over
a **301.3 s** window at **`max_points` 2248**; `MainPositiveState` 0..=3
at 10 Hz is the second lane and `MaxCellVoltage` the numeric control.
Its checked-in miniature is `signal_sampler.rs` ::
`runs_survive_a_budget_that_min_max_decimation_would_flatten` (6 codes ×
50-sample holds, budget 4 buckets). Neither holds a code for longer than
a served bucket, so neither answers the resolvable-hold question — the
fixture above adds the hold and sweeps its length.

`max_points` is one point per canvas pixel and the fetch window is padded
by the same fraction the budget is (`PlotArea.tsx`), so **one served
bucket is one canvas pixel column**: here 301.3 s / 2248 = **134 ms**.

#### Observation — the control reproduces the commit's signature

Plain `SignalCache::window(0, tip, 2248)` over 30 130 samples serves
**3768 points carrying two of six codes** ({0, 5}; the lone 3 is the
forced final input sample at t=301.29, the only one in the serve). The
commit's live control measured "mean 2.95, last 2" of 6. Same result.

#### Experiment — hold length swept against the plain serve

One held run of **code 3** (adversarial: strictly between the codes its
bucket neighbours carry, so neither argmin nor argmax) injected mid
capture, length swept 1..64 samples, and its start offset swept 0..47
samples so the verdict is not an artefact of one alignment. Measured on
the real `SignalCache` (pyramid fold + `decimate_min_max`), with a pure
model of the same path validated against it first (`real == model`
exactly at holds 0/13/26/32/100, chosen level 1, decimation bucket 4
level-1 points).

| hold | in columns | served samples carrying code 3 |
| --- | --- | --- |
| ≤ 27 samples (0.27 s) | ≤ 2.01 | **0 at every offset tried** |
| 28–43 samples | 2.09–3.21 | 0 **at some offsets**, ≥1 at others |
| 43 samples @ offset 41 | 3.21 | **0** (confirmed on the real serve) |
| ≥ 44 samples (0.44 s) | ≥ 3.28 | ≥ 1 at every offset |

#### Conclusion

A held enum state up to **3.21 canvas pixel columns wide (430 ms here)
is served with no sample carrying its code at all**. That is not a
coarse tile — the code is absent, so a tiles-from-served-runs overlay
has nothing to draw and no downstream renderer can put it back. A
3-pixel tile is drawable, so the loss is at a resolvable zoom. The
mechanism is the one `61379f88` named, now bounded: min/max keeps a
code only when a run **fully contains** a bucket (then min = max =
code), which at the worst alignment needs ~2 decimation buckets on top
of ~2 pyramid-fold buckets.

The **single-enum ribbon does not differ**: `PlotArea.tsx:2009` sets
`categorical: laneModeRef.current || enumActivePre`, so the ribbon and
the lanes axis share `window_categorical` today and would share
`window` after unification. The verdict covers both.

#### What the fold change must guarantee — one sentence phase 2 tests

> Every maximal run of equal consecutive raw samples that spans at least
> **two served buckets** must contribute at least one served sample
> carrying that run's value, at **every alignment** of the run against
> the bucket grid.

At the V2 width/budget that is a hold of 21 samples (0.21 s, 1.57
columns) instead of today's 44 (0.44 s, 3.28 columns).

**Where the change goes, measured.** Three variants over the same
alignment sweep (largest hold lost at *some* offset; smaller is better):

| variant | largest hold lost | control serve size | pyramid points above L0 |
| --- | --- | --- | --- |
| fold min/max, decimate min/max (today) | 0.43 s = **3.21 col** | 3768 | 10 034 |
| fold min/max, **decimate first+last+min/max** | 0.20 s = **1.49 col** | 5651 (+50 %) | 10 034 |
| fold first+last+min/max, decimate the same | 0.64 s = **4.78 col**, no safe hold ≤ 64 | 2339 | 23 425 (+133 %) |

So first/last belongs in **`decimate_min_max` only**. Putting it in
`SignalCache::fold` too makes fidelity *worse*: a fatter level makes
`window`'s "coarsest level still over budget" rule land a level higher,
whose points span more raw samples, and it costs 2.3× the pyramid.

#### Consequences phase 2 inherits

- First/last raises the serve from 3768 to 5651 points on this
  scenario (+50 %), and the output bound from `2·max_points + 2` to
  `4·max_points + 2`. Phase 2 also drops the 500-marker cap, so that
  is 5651 markers where there were 500 — the harness reading phase 2
  takes is over the *combined* change, and the pair-preserving
  fallback the all-points ruling names should be sized against this
  number, not against 3768.
- First/last is what a **stepped numeric line** needs anyway (a step
  renderer holds a value to the next sample, so a bucket's last sample
  is the step's end), which is why it is the shared fold and not a
  lane-only reducer.
- The residual 1.49-column loss is the pyramid fold's, not the
  decimation's, and closing it is not available cheaply — see the
  third row above. Recorded in the owner review queue.

#### Phase 2 size estimate

| where | what | rough |
| --- | --- | --- |
| `signal_sampler.rs` | first/last in `decimate_min_max`; delete `reduce_transitions` + 2 tests; update the module rustdoc | −90 / +40 |
| `signal_cache.rs` | delete `window_categorical` (~95 lines incl. rustdoc), `Reduction`, the `slice_many` branch, 4 categorical-serve tests; update `window` rustdoc; new held-run serve test | −350 / +80 |
| `sampling.rs` | drop the `categorical` arg and its plumbing | −25 / +5 |
| `useDecimatedRange.ts` + test | drop `categorical` from the request type and the fetch memo key | −20 / +5 |
| `PlotArea.tsx` | drop the flag; tiles from runs of equal served values; delete the lane's private marker pass | −80 / +60 |
| `plotEnumLanes.ts` (325 lines) + `plotPoints.ts` (219) | tiles from served runs; stride thinning out | −120 / +80 |
| `PlotArea.draw.test.ts`, `PlotPanel.dom.test.tsx`, `plotEnumLanes.test.ts` | the mock categorical reducer goes; lane marker cases move to uPlot's markers | −150 / +120 |
| ADR 0026 | lane unification recorded | +25 |

**≈ 850 removed, ≈ 420 added, ~10 files** — net a deletion, which is
the shape the ruling intends. It is still a large phase because the
marker work rides with it; if it sprawls, the natural split is host
(fold + reducer deletion) then frontend (tiles + markers).

- 2026-09-19 — task opened from ungroomed feedback items 8–12;
  grooming started.
- 2026-09-20 — all-points ruled: no cap, measure, pair-preserving
  fallback. Bus markers ruled: view-local stays; visible Events chip
  in the plot toolbar; `reportBase` per-area fix folded in. Empty
  areas ruled: x grid, ticks, placeable A/B over the shared window,
  seeded from the session extent when nothing else has one. Chrome
  ruled: top gutter for event labels (≤2 lines), a time-cursor
  gutter above the x axis for A/B/Δt, no drag. Lanes ruled: unify
  onto the ordinary series machinery, investigation first. Phases
  cut, exit criteria drafted. Grooming complete.
