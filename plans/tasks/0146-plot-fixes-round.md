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

- **Hover cost of `Points: On`** (owner, 2026-09-21): reported that
  `Points: On` is "back to being a performance disaster on long
  traces". Ruled, as a fix phase on top of the feedback stack:
  1. the hover-driven chrome moves to an **overlay canvas** stacked
     over uPlot's, so a pointer move or a cursor placement never
     redraws the series layer — same placement, same look, pinned by a
     `drawSeries` counter;
  2. sample markers are **fill-only** (`points.width: 0`), size
     unchanged;
  3. the ADR 0031 harness gains **`--show-points <auto|off|on>`**,
     forcing the mode for a run without persisting it;
  4. one reading under `on`, one release build, one 60 s run.

  The 2026-09-20 tip reading below was taken with ev-zonal's persisted
  `showPoints: "auto"`, so it never measured `on` at all — which is
  how an uncapped `on` shipped with no reading against it.

- **Square markers** (owner, 2026-09-21): `Points: On` is still far
  worse than `auto` on a real project — a panel of three plot areas
  and thirteen series over a multi-GB capture, where every pan, zoom
  and live tick rebuilds up to `4 · max_points` markers per series.
  Three rulings:
  1. **Collapse markers within a pixel column.** The served points in
     one column are its first, last, min and max; markers that would
     land within a marker's side of each other (same device-pixel
     position, or overlapping) draw once. A held signal goes to one
     marker per column, a noisy one to two — its min and its max —
     each still on a sample. Nothing that leaves a column's extreme
     bare: never a stride, never a cap.
  2. **Markers are squares, drawn as a batched rect path.** A custom
     `points.paths` for every series returns one `Path2D` of
     axis-aligned rects, pixel-snapped to integer device pixels, side
     equal to today's disc diameter (`points.size` at the pixel
     ratio); `width: 0` stays, fill only. Hover markers on the
     overlay canvas keep their current look — one per series is no
     cost. Lane markers keep `laneMarkerInk` as their fill.
  3. **Sprite-blit shapes are backlogged, not built.** Marker shapes
     (circle, triangle, diamond, cross, plus) via a pre-rendered
     sprite blitted per marker and cached per shape / colour / size /
     DPR; a per-panel default marker beside the `Points:` chip; an
     optional `marker` on a colormap rule (ADR 0029) drawn in the
     rule's colour, which needs the host to serve a point's raw value
     beside its physical one because rules key on raw. Squares only
     for now.

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

## Blockers / side effects

- **A wide ΔH chip is clipped by the y gutter.** The H chips draw in
  the negotiated y gutter (~52 px) and deliberately do not ask it for
  width — a gutter that grew with a transient reading would slide every
  plot box in the stack sideways as the cursor was placed. So `ΔH` plus
  a long value (an exponential, say) loses its right-hand characters at
  the plot box's edge. The full value is in the side panel and in the
  measurement strip, both unchanged. Filed for a ruling.

## Status log

### 2026-09-21 — second fix phase: square markers, collapsed per pixel column

Branch `fix-plot-square-markers` off `fix-plot-hover-overlay`, one
squashed commit. Frontend only — `plotPoints.ts` and two test files —
plus ADR 0026, this file and `plans/backlog.md`. No host code, and no
`PlotArea.tsx` change: the panel already spreads whatever
`showPointsToUplot` returns into every series' `points`, so the new
`paths` reaches lanes and lines alike through the existing seam.

#### Observation → experiment → cause

Observation (owner, 2026-09-21): `Points: On` is still substantially
worse than `auto` on a real project — three plot areas, thirteen
series, a multi-GB capture.

The previous phase's experiment measured the *shape* of the cost (uPlot
rebuilds a series' point path on every repaint; `width: 0` removes one
of the two passes over it). What it left unmeasured is what the
remaining pass builds. Experiment, against uPlot 1.6.32 itself with a
recording `Path2D` and a real `drawSeries` — now a committed test
rather than a throwaway — over one 2000-sample series on a 526 px plot
box, one repaint, flushed:

| one repaint, 2000 served samples, 526 px box | path ops |
| --- | --- |
| uPlot's own builder, sawtooth | 2000 `arc` (+ 2000 `moveTo`) |
| square builder, sawtooth (two distinct values per column) | 1051 `rect`, 0 `arc` |
| square builder, held at one value | 526 `rect` — one per pixel column |

So the primitive count halves on a noisy series and drops ~4x on a held
one, and each surviving primitive is a pixel-aligned rect rather than
four cubic Béziers flattened and anti-aliased at raster. On the scratch
layout below — 13 series, ~2100 px wide areas, a serve of up to
`4 · max_points` per series — the before case is ~10^5 arcs per data
repaint.

#### What landed

- `collapseMarkerSquares(centres, side)` in `plotPoints.ts`: flat
  `[x, y, ...]` device-pixel centres in, flat top-left corners out (flat
  both ways so a repaint allocates two arrays, not one per marker).
  Groups by rounded device-pixel column and drops a marker whose square
  would land on pixels a marker already kept **in that column** covers.
  Never across columns — two neighbouring columns whose extremes are a
  pixel apart both draw, per the ruling.
- `squareMarkerPaths` — the `points.paths` builder. One `Path2D` of
  `rect`s, side = `points.size` at the canvas pixel ratio (the diameter
  the disc had, since `width` is 0), corners snapped to integers, a null
  stroke path, and the clip inflated by one marker exactly as uPlot's
  own builder inflates it. `showPointsToUplot` returns it in all three
  modes, beside `width: 0`.
- Hover markers are untouched: they are drawn on the overlay canvas, one
  per series, and stay discs. A lane's `laneMarkerInk` is still the
  point layer's fill.

#### The readings — one run each, `Points: On`, 13 series

A **scratch** variant of ev-zonal (not in the repo): one plot panel,
three plot areas, thirteen signals at 10 / 100 / 1000 ms — six pack
electrical, four wheel speeds, three tyre pressures — buses, DBCs,
transmit frames and RBS otherwise untouched, with its own `project_id`
so it shares no cache with the baseline project. 60 s,
`--perf-interact scrub`, `--rbs-run-on-start`, `--show-points on`.

| metric | before (`372f6afb`) | after (`c5cf43e1`) | limit |
|---|---|---|---|
| `longtask_ms_per_s` mean / p95 | 0 / 0 | 0 / 0 | 10 / 17 |
| `lag_ms_max` | 2.6 | 5.3 | 40.8 |
| `jank_fraction` | 0 | 0 | 0.05 |
| `jsheap_mb_peak` | 95.7 | 102.9 | 231.2 |
| `jsheap_mb_drift_per_min` | 5.26 | 3.01 | 22.9 |
| **`renderer_mb_peak`** | **408.4** | **323.8** | 697.0 |
| **`renderer_mb_drift_per_min`** | **91.5** | **34.2** | 96.5 |
| `tree_mb_peak` | 829.1 | 741.8 | 1547.4 |
| `tree_mb_drift_per_min` | 131.4 | 64.2 | 154.7 |
| `flush_ms_mean` / `tx_late_ms_mean` | 3.36 / 3.44 | 2.92 / 3.21 | 25 / 18 |
| `rx_fps` / `tx_fps` overall | 1610.0 / 1610.2 | 1607.3 / 1613.2 | +/-15 % of 1608 |
| `rx_gap` ids measured | 174 | 174 | — |
| `interact` performed / missing | 240 / 0 | 266 / 0 | — |

`cannet-perf-measurement check --expected-rx-fps 1608 --expected-tx-fps
1608` **passed all 33 gated metrics on both**. Reports:
`docs/performance-measurements/frontend/2026-09-21-372f6afb-points-on-13series-before.json`
and `2026-09-21-c5cf43e1-points-on-13series-after.json` beside it.

The reading that moved is renderer memory: the peak drops 85 MB and the
drift per minute falls from 91.5 — within 5 % of its limit — to 34.2.
That is the marker path, which was being rebuilt and re-rasterized
thousands of markers at a time, per series, per repaint. The timing
metrics were already at the floor on this rig for both builds
(`longtask` 0, `jank_fraction` 0, `lag_ms_max` single-digit
milliseconds), so they say nothing either way here; `lag_ms_max`
2.6 → 5.3 is inside the run-to-run band this metric has always had.

**The pair is not perfectly controlled, and the bias is conservative.**
The before run started against an empty store; the after run restored
216 339 frames the before run had written, so it carried the heavier
model *and* drove 26 extra `plot.follow-live` gestures the before run's
toolbar had no capture to offer. Both runs are valid on their own terms
— 174 ids, rx/tx within 0.4 % of the offered 1608 f/s, `missing: 0` —
and the after run improved on memory while doing more work, so the
improvement is a lower bound. Not re-run: the economy rule is one run
each, and a controlled repeat could only widen the gap.
`scroll_jank_px` (ungated, ADR 0031) is the one metric the asymmetry
dominates outright — 1.3 → 83 880 — because it measures the *trace*
scroll, and the after run scrolled a 216 k-frame buffer where the
before run scrolled one filling from empty.

#### Tests

| file | added | what they pin |
| --- | --- | --- |
| `plotPoints.test.ts` | 7 | the collapse table — held column → 1, noisy column → 2 (its min and its max), two columns a pixel apart → still 2, a series sparser than the columns → every sample, integer corners, empty in / empty out — and that every mode asks for `squareMarkerPaths` |
| `PlotArea.draw.test.ts` | 3 | a real uPlot's `drawSeries`, with a recording `Path2D`: the point path is `rect`s and not one `arc`, its corners are integers, and a held series collapses to one rect per pixel column — plus the CONTROL that uPlot's own builder draws the same data as arcs |

`PlotArea.draw.test.ts` moves from the node environment to jsdom, since
constructing a real uPlot needs a document. All 81 pre-existing cases in
it pass unchanged; the file gains a hoisted `matchMedia` stub, which is
what uPlot reads its device pixel ratio through at import and which
vitest's jsdom environment does not put on `globalThis`.

#### CI (scoped per-phase set)

| check | command | result |
| --- | --- | --- |
| frontend tests | `pnpm --dir apps/gui test` | 247 files / 3599 tests passed |
| frontend build (typecheck) | `pnpm --dir apps/gui build` | passed (`tsc -b && vite build`) |
| comment-references grep | over `apps/` and `crates/`, untracked included | clean |
| `check_local_paths.py` | over the changed files | clean |
| release build | `pnpm --dir apps/gui tauri build --no-bundle` | `target/release/cannet-gui.exe` |
| Rust lanes, python / MDF / sidecar / wire / proto lanes | — | **unreachable — the diff touches no Rust, `servers/`, `libs/` or `proto/` file** |

No new blockers, and nothing filed to `plans/owner-review-queue.md`.

### 2026-09-21 — fix phase: the hover overlay, fill-only markers, `--show-points`

Branch `fix-plot-hover-overlay` off `fix-palette-pick-order`, one
squashed commit. Frontend plus one host file (`diag.rs`, for the launch
flag), ADRs 0026 and 0031, README, `docs/CONTEXT.md`.

#### Observation → experiment → cause

Observation (owner, 2026-09-21): `Points: On` is a performance disaster
on long traces. The reading of the code in the brief — uPlot never
caches the point layer, and the plot area redraws on every pointer move
— was taken as a hypothesis, not a cause.

Experiment, against uPlot 1.6.32 itself rather than our wrapper: one
series of 2000 samples with `points.show: true`, a counting
`points.filter` and a wrapped `points.paths`, driven through ten
`redraw(false, false)` calls — the exact call the hover effect made —
each flushed to its own commit. The flush is load-bearing: uPlot
coalesces synchronous redraws into one microtask, so an unflushed loop
measures a single repaint and *looks* like a cache (it read 0 filter
calls before the flush was added). Falsifiable: a cached point layer
runs the filter once and builds the arcs once.

| per 10 repaints, one 2000-sample series | count |
| --- | --- |
| `points.filter` calls | 10 |
| `points.paths` rebuilds | 10 |
| `Path2D.arc` calls | 20 000 |
| `ctx.stroke()` per repaint, default `points.width` | 4 |
| `ctx.stroke()` per repaint, `points.width: 0` | 3 |

Cause confirmed, and the source says why: `drawSeries` rebuilds a
series' line path only when `s._paths == null`, but runs
`points.filter`, `points.paths` and `drawPath` unconditionally. So the
cost is one marker path plus a fill *and* a stroke per series **per
repaint**, and at ev-zonal's serve (`4 · max_points` — a few markers per
canvas pixel column, thousands per series on a wide canvas) every
rAF-coalesced pointer move was paying it for every series of every
stacked area. `width: 0` removes exactly one stroke pass, which is the
marker layer's.

#### `drawSeries` per hover, before and after

| | repaints of the series layer |
| --- | --- |
| before, one pointer move | one `redraw(false, false)` per stacked area → `drawSeries` once per series per area, each rebuilding that series' whole marker path |
| after, one pointer move | **none** — one overlay canvas cleared and repainted per area |
| after, a cursor placement | **none** (same path) |
| after, a live tick / pan / zoom | unchanged — the data moved, so the series layer redraws and repaints the overlay at the end of its `draw` hook |

Pinned by `PlotPanel.dom.test.tsx :: "hover and cursor chrome stay off
the series layer"`, which installs a `drawSeries` counter, asserts a
plain `redraw()` moves it, and then asserts a hover, a second hover and
a click-placed A cursor leave it untouched while the overlay clears and
repaints.

#### The split: by input, not by looks

`drawHoverOverlay` paints on a second canvas stacked inside `u.over`,
sized and offset to the *whole* canvas rather than the plot box, because
the readouts live in the gutters. That also keeps `u.bbox` addressing
the same pixels in both layers, so every function that moved kept its
coordinates and its clip.

| on the overlay canvas | still in uPlot's own draw |
| --- | --- |
| crosshair, A/B and H1/H2 cursor lines | dashed extrapolation stretches |
| hover markers | lane tile labels (tiles stay in `drawAxes`) |
| event lines, extents, label chips | the scroll-jank sample |
| A/B/Δt chips, H1/H2/ΔH chips | |
| the bottom axis's time label | |

That last row is the one mechanical consequence. The label carries the
free cursor's time, so it changes on every pointer move, and an axis can
only be repainted by the redraw this phase exists to remove. uPlot now
gets a blank label — which is what reserves the band and fixes the
position — and the overlay paints the text at the same centred spot, in
the same font and colour. Placement and look are otherwise untouched.

The two effects that called `u.redraw` for chrome (cursors / crosshair /
events, and extents / the lit set) now repaint the overlay.
`eventChipKey`'s `redraw(false, true)` stays: the top gutter is sized by
a padding function, only a layout convergence re-evaluates it, and a
label set changes far more rarely than a pointer moves.

#### Fill-only markers

`showPointsToUplot` returns `width: 0` in every mode. Drawn size is
unchanged — the radius is `(size - width) / 2`, so dropping a 1 px
stroke centred on the arc grows the disc by exactly what that stroke
covered. The middle changes: uPlot's stroked marker defaults to a white
fill, an unstroked one takes the series colour throughout. A lane's
markers already set `fill` (`laneMarkerInk`) and keep it.

#### `--show-points <auto|off|on>`

Parsed in `diag.rs` beside `--perf-interact`, served through
`diag_autostart`, armed in `plotPoints.ts` as a module flag before the
automation opens its project — the same shape `diag.ts` uses for its own
launch-time arming. `PlotPanel` draws `override ?? its own state` and
persists only the state, so a measurement run never edits the project it
measures. It arms autostart but not diag (it shapes what is drawn, not
what is recorded), and the diag scanner skips its value for the same
reason it skips a project path.

#### The reading — one run, `Points: On`

Release build of `3dd860cc` (`tauri build --no-bundle`), ev-zonal, 60 s,
`--perf-interact scrub`, `--rbs-run-on-start`, `--show-points on`;
report
`docs/performance-measurements/frontend/2026-09-21-3dd860cc-points-on-hover-overlay.json`.
`cannet-perf-measurement check --expected-rx-fps 1608 --expected-tx-fps
1608` **passed all 33 gated metrics**.

| metric | baseline | this run | limit |
|---|---|---|---|
| `longtask_ms_per_s` mean / p95 | 0 / 0 | 0 / 0 | 10 / 17 |
| `lag_ms_max` | 10.4 | 5.7 | 40.8 |
| `jank_fraction` | 0 | 0 | 0.05 |
| `jsheap_mb_peak` | 83.6 | 97.1 | 231.2 |
| `renderer_mb_peak` | 316.5 | 330.1 | 697.0 |
| `tree_mb_peak` | 741.7 | 753.4 | 1547.4 |
| `flush_ms_mean` / `tx_late_ms_mean` | 25.0 / 18.0 | 2.8 / 2.8 | 25 / 18 |
| `rx_fps` / `tx_fps` overall | — | 1607.5 / 1611.3 | ±15 % of 1608 |
| `rx_gap` ids measured | — | 174 | — |

Load and gestures sanity-checked before reading any of it: 174 ids
measured, rx/tx within 0.2 % of the offered 1608 f/s, `interact`
`performed: 266`, `missing: 0` across seven gesture kinds. `cannet.log`
carries no error from this run — the only warnings are the usual absent
Vector/Kvaser backends, the unreachable `10.10.10.50` interface the
project also names, and one clock-offset correction that recovered.

The comparand: the 2026-09-20 tip reading was `showPoints: "auto"` (what
ev-zonal persists), so the two runs are not a controlled pair for the
marker cost — this is the first reading of `on` at all. Read as a
series against the baseline, every gated metric is inside its limit and
`lag_ms_max` came in at 5.7 against the 22.4 that run posted.

#### Tests

| file | added | what they pin |
| --- | --- | --- |
| `PlotPanel.dom.test.tsx` | 3 | the `drawSeries` counter above; the overlay canvas is stacked in `u.over`, offset to the canvas origin and pointer-transparent; the launch flag draws `on` over a panel that persists `off`, and persists nothing |
| `PlotArea.draw.test.ts` | 8 | `drawHoverOverlay` puts the crosshair and the pointer's nearest sample down in one pass, honours `off`, keeps every readout out of the plot box, and carries the panel-level gutters only on the axes that anchor them; `drawXAxisTimeLabel`'s text and its position |
| `App.perfCaptureConnect.dom.test.tsx` | 1 | the flag's last hop: the webview arms the override from the launch config, and leaves it unset without one |
| `plotPoints.test.ts` | 2 | `width: 0` in every mode; the override's lifecycle |
| `diag.rs` | 2 | the flag parses, is absent by default, and does not arm diag |

Three existing panel-tier tests moved with the mechanism: the x-axis
label case now reads the drawn text instead of calling the axis's
`label` function, the highlight-repaint case asserts an overlay repaint
with the redraw count *unchanged*, and the enum-axis measurer stub was
taught to leave the overlay's canvas alone. The suite-wide `getContext`
routing (an instance's overlay canvas draws through that instance's own
recorder) is what keeps every other assertion about crosshairs, hover
markers and gutter chips reading the same array in the same order.

#### CI (scoped per-phase set)

| check | command | result |
| --- | --- | --- |
| frontend tests | `pnpm --dir apps/gui test` | 247 files / 3589 tests passed |
| frontend build | `pnpm --dir apps/gui build` | passed (`tsc -b && vite build`) |
| `cargo test -p cannet-gui` | — | 1326 passed |
| `cargo clippy -p cannet-gui --all-targets -- -D warnings` | — | clean |
| `cargo fmt --all -- --check` | — | clean |
| `cargo doc -p cannet-gui --no-deps` | — | clean |
| comment-references grep | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | clean |
| `check_local_paths.py` | over the changed files | clean |
| release build | `pnpm --dir apps/gui tauri build --no-bundle` | `target/release/cannet-gui.exe` |
| python / MDF / sidecar / wire / proto lanes | — | **unreachable — the diff touches no `servers/`, `libs/`, `proto/` or MDF code** |
| `cargo test --workspace`, workspace clippy | — | not run: the only Rust change is `diag.rs`'s launch-flag parser, which no other crate compiles against |

No new blockers. Nothing filed to `plans/owner-review-queue.md` — the
one open item there (the ΔH gutter clip) is phase 3's and is unchanged
by this phase.

### 2026-09-20 — phase 4: panel plumbing (task close-out)

Branch `task146-panel-plumbing` off `task146-gutters`, one squashed
commit. Frontend only — `PlotPanel.tsx`, `PlotArea.tsx`,
`PlotToolbar.tsx`, two test files, ADR 0026, README. No host code.

#### Empty areas: seeded from the session's own span, not derived in JS

Finding 3's three causes are all still true at the top of this phase:
the resample early-returns without a `setScale` for an empty area,
both scales are `auto: false`, and `applyXAll` only ran when some area
had an extent. The ruling's y-axis half needed no new plumbing — an
empty area now takes the *same* blank-gutter axis config the
enum-lanes axis already had (`PlotArea.tsx`: `laneModeAtConstruct ||
emptyAtConstruct`), so it reserves alignment width and draws no grid,
no ticks, no splits, exactly like a lane axis with nothing served.

The x-window half is the new mechanism, in `PlotPanel.tsx`:
`slideXWindow` (already ticking at the resample cadence — even an
empty area's early-return path calls `onAreaResampled` every tick)
falls back to `seedEmptyExtent()` when `sharedExtent()` is null. That
reads the session's span the same way "Fit Data" does — a
`sample_signals` round trip with no signals (`fetchWindowExtent`),
never frames read in JS — and applies it through the same `applyXAll`
every other x-window change uses, so it reaches every uPlot instance
in the panel including the empty one's. It is self-throttled to one
request in flight rather than timer-gated, and a response that lands
after a real area has anchored the window is dropped
(`sharedExtent() != null` re-check before applying). Once *any* area
in the panel resamples a real extent, `sharedExtent()` stops
returning null and the fallback is never called again — pinned by
`PlotPanel.dom.test.tsx :: "stops asking the host for the session
span once the area has its own extent"`.

Click-placeable A/B on an empty area needed no code change: the
click handler (`ready` hook) already worked off `u.posToVal`
unconditional on `signals.length`; the only reason it drew nothing
was the same unset x-scale the grid/ticks needed. The DOM-tier mock's
`posToVal`/`valToPos` are scale-independent (linear stand-ins,
`PlotPanel.dom.test.tsx`'s own doc comment), so the click test there
cannot distinguish the pre-fix from the post-fix behaviour the way
the seeding tests can — it pins that the gesture reaches
`onPlaceCursorX`/persists `cursorX` for an empty area at all, which
is the mechanism-level claim available at that tier; the pixel-level
"the line is actually visible" claim is out of every automated
tier's reach here, same as every other cursor line this file already
declines to pin (see the file's own header comment).

#### `reportBase` keyed by area

`PlotPanel.tsx`'s `reportBase` now keeps a `Map<areaId, secs |
null>` and derives the panel's base from the first populated area's
report, falling back to `null` only when every area's own report is
`null`. An empty area's tick no longer overwrites a populated
sibling's. `forgetAreaState` (on area removal) prunes the map the
same way it already pruned `cursorYByArea` / `seriesByArea`, so a
removed area's stale (possibly non-null) vote does not linger.
Regression: `PlotPanel.dom.test.tsx :: "no longer blanks the panel's
event markers when it sits beside a populated area"` — an empty
area (`a1`, first / topmost) beside a populated one (`a2`) still
shows the note's marker label, checked on `a1` (the label chip draws
on the topmost *drawing* axis) so the test also pins that an empty
area draws event markers at all, not only that its sibling survives.

#### Events chip

`PlotToolbar.tsx` gets the trace panel's own chip-reveals-checklist
pattern: an "Events" chip (`icon="flag"`, same as `TracePanel.tsx`)
toggles a new `showEvents` bar item that places the panel-built
`EventKindFilter` as its own item (so a narrow bar can overflow the
checklist without taking the chip with it). `PlotPanel.tsx` owns the
disclosure state (`showEventsChip`, unpersisted — the trace panel's
own `showEvents` persists because it *also* gates whether events
interleave at all; here the only real content is `eventKinds`, which
was already unpersisted, so the disclosure follows `showPerf`'s
precedent instead) and passes the checklist through as a
pre-rendered node, keeping `PlotToolbar` stateless per its own header
comment. The copy that lived in the toolbar's right-click menu is
gone — one control. `busError` is untouched, still grouped under
Diagnostics (`EVENT_KIND_GROUPS`, `notes.ts`) — nothing here changes
the grouping, only where the control that flips it lives.

#### Deviation: test placement

The phase brief named `PlotArea.draw.test.ts` for the "empty area
draws x grid and ticks, no y grid" case. That file only exercises
the handful of exported *pure* overlay-draw functions
(`drawEnumTiles`, `drawEventLabelChips`, …); x/y grid and tick
rendering is uPlot's own axis renderer from the `axes` option object
built inside the (non-exported) construction effect — not something
this file's harness touches, and not something this phase changed
the shape of. The faithful equivalent — pinning the *axis config* an
empty area constructs uPlot with — already has a precedent one test
above in `PlotPanel.dom.test.tsx`'s DOM tier (`"a lanes axis
constructs uPlot with stepped series and a blank y axis"`, reading
`inst.opts.axes[…]` off the mocked uPlot instance); the new case
(`"constructs uPlot with a blank y axis, and the ordinary x axis
grid and ticks"`) follows that exact precedent instead. Recorded
here rather than forced into a file whose testing model cannot
express the claim.

#### Exit criteria, walked in full (task close-out)

| # | Criterion | Verdict |
| --- | --- | --- |
| 1 | Phase 1's verdict recorded with fixture + numbers | **Done** — phase 1 entry above: a resolvable held code (≥ 2.09 columns) is lost by the plain serve; phase 2 folds first/last into `decimate_min_max`. |
| 2 | `Points: On` marks every served sample; `PlotArea.draw.test.ts` case; harness reading recorded | **Marker behaviour done** (phase 2: cap and stride removed, uncapped). **Perf reading deferred** to the overseer's single ADR 0031 tip run per the owner's economy rule, as phase 2 and 3 also deferred theirs — not run this phase either. |
| 3 | Enum lane served like a numeric series; `reduce_transitions` / `categorical` gone; markers legible over the tile; held state at width is one tile | **Done** (phase 2) — `signal_cache.rs` / `signal_sampler.rs` no longer define either; `PlotArea.tsx` tiles from served runs. |
| 4 | Event label chips in a top gutter (1–2 lines); A/B/Δt between the plot box and x ticks; nothing draws inside a plot box; a collapse moves the chrome | **Done** (phase 3) — `eventChipGutterPx`, the bottom axis's `gap`/`size`; `PlotArea.draw.test.ts` +27, `PlotPanel.dom.test.tsx` +6. |
| 5 | Empty area shows x grid, ticks, placeable A/B; a panel of only an empty area shows the session's span and follows live | **Done** (this phase) — see "Empty areas" above; `PlotPanel.dom.test.tsx :: "empty plot areas"`. |
| 6 | Empty area beside a populated one no longer blanks event markers (`reportBase` regression) | **Done** (this phase) — see "`reportBase` keyed by area" above. |
| 7 | Plot toolbar shows an Events chip; checklist hides bus markers; right-click menu no longer carries it | **Done** (this phase) — see "Events chip" above; `PlotToolbar.dom.test.tsx :: "the Events chip"`, `PlotPanel.dom.test.tsx :: "the plot toolbar's Events chip"`. |
| 8 | ADR 0026 records the lane unification and the gutters; ADR 0035 unchanged | **Done** — lane unification (phase 2) and gutters (phase 3) already recorded; this phase adds the empty-area paragraph. ADR 0035 not touched by any phase. |

#### CI (scoped per-phase set — frontend only, per the owner's economy rule)

| Check | Command | Result |
| --- | --- | --- |
| frontend tests (targeted) | `pnpm --dir apps/gui test -- PlotPanel.dom.test.tsx PlotToolbar.dom.test.tsx PlotArea.draw.test.ts` | 391 passed |
| frontend tests (full) | `pnpm --dir apps/gui test` | 247 files / 3576 tests passed |
| frontend build | `pnpm --dir apps/gui build` | passed (`tsc -b && vite build`) |
| comment-references grep | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | clean |
| `check-local-paths` | `python scripts/check_local_paths.py <changed files>` | clean |
| `cargo fmt --all -- --check` | — | clean (no Rust touched) |
| `cargo test -p cannet-gui`, clippy | — | **unreachable — no host/Rust code touched this phase** |
| python / MDF / sidecar / wire lanes | — | **unreachable — this phase's diff is frontend-only** |
| ADR 0031 perf reading, release build | — | **deferred to the overseer's single stack-tip run**, per the owner's economy rule for this phase |

No new items filed to `plans/owner-review-queue.md` this phase — the
one open item (the ΔH gutter clip) is phase 3's, unchanged.

### 2026-09-20 — phase 3: gutters

Branch `task146-gutters` off `task146-markers`, one squashed commit.
Frontend only — `PlotArea.tsx`, its two test files, ADR 0026. No host
code, no CSS: every readout that moved was already canvas ink.

#### Mechanism: uPlot's own layout, not a DOM overlay

Three candidates for reserving the space (`padding`, axis `size`/`gap`,
a positioned DOM overlay). Taken in that order, and the reason is the
ruling's own word *anchored*:

| gutter | mechanism | why |
| --- | --- | --- |
| top, event labels | `padding[0]`, a **function** | uPlot re-evaluates a padding function every layout cycle, so the gutter follows the labels it holds *and* follows `isFirst` — a collapse hands both the chips and their space to the next axis down, with no state to keep in sync. `u.bbox.top` is then the gutter, exactly. |
| bottom, A/B/Δt | the bottom x axis's `gap` + `size` | The strip belongs *between* the plot box and the tick values, which is what `gap` is. `isLast` already rebuilds the instance, so the reservation moves on collapse for free. Tick marks keep their length: the strip starts below them. |
| y, H1/H2/ΔH | the existing negotiated y gutter | Already reserved, already panel-wide, already latched against churn. |

A DOM overlay was rejected: it would need the plot box's pixels in React
state (a second layout truth to keep in sync with uPlot's), and it
reserves nothing — the chips would float over a plot box that is still
full height, which is the defect. The chrome is drawn, not interactive
(no drag, per the ruling), so there is nothing a DOM node buys.

#### What the gutters cost, in pixels

| gutter | `padding[0]` / axis size | net cost |
| --- | --- | --- |
| top, no labels | 17 px (uPlot's easement, unchanged) | **0** |
| top, labels on one line | 17 + **17** px | +17 px |
| top, a label wrapping to two lines | 17 + **30** px | +30 px |
| time cursors (bottom drawing axis only) | 34 → 51 px, `gap` 5 → 22 | +17 px |
| y (H1/H2/ΔH) | nothing new | 0 |

The chip band is reserved **above** uPlot's 17 px tick easement, not
inside it (overseer review of the first cut, which did take it out of
the easement). One 13 px chip line plus 2 px clearance either side is
17 px, which is the easement's size exactly — so sharing looked free
and was not: the chips are opaque, and an event landing near the top of
a panel covered the topmost y tick label.

**So a panel with event labels pays 17 px of plot height for the top
gutter and 17 px for the time-cursor gutter — 34 px once, for the
whole panel.** A panel whose labels wrap pays 47; a panel with no
events pays 17.

#### What moved, and what deliberately did not

- `vline` and `hline` in the draw hook draw the **line only** now. The
  clip on the data area is released before any chip is drawn, and each
  of the three new functions clips to its own gutter — so "nothing
  draws inside a plot box" is enforced by the clip and pinned by the
  coordinates the tests read back, not by convention.
- **The cursor lines stay on the canvas**, crossing every stacked area
  (the ruling), and the marker lines with them. Only the chips left.
- `PlotMeasurements.tsx`, the side panel and `index.css` are untouched.
- The `Δt` chip used to sit 18 px above the plot's bottom edge, on its
  own row, so it could not collide with A and B. In one gutter row it
  can. It is drawn **first**, so the two readings paint over it: a span
  narrow enough to collide is one where the two times are what you are
  reading.
- **The chip band does not touch uPlot's easement for the topmost y
  tick label.** The first cut of this phase reserved the one-line band
  *inside* that easement, which made a one-line gutter free but let an
  opaque chip cover the tick label. Corrected in review: `padding[0]`
  is easement + band, `drawEventLabelChips` clips to the band alone, and
  a draw-level case (*leaves the tick easement clear…*) plus a
  panel-level one pin that no chip pixel enters it.

#### Where the sizing measurement happens

`eventChipGutterPx` is pure and takes its `measure` — the gutter must be
sized in the same font the chips are painted in, or it is the wrong
height, and the sizing pass runs outside any canvas the draw hook has.
Production passes a module-level scratch 2d context (`measureMarkerLabel`,
the same shape `measureAxisSize` already uses for the y axis), which
falls back to a fixed monospace advance where there is no 2d context —
jsdom, i.e. `PlotPanel.dom.test.tsx`, where it makes the panel-level
gutter assertions mean something instead of always reading "two lines".

A label change is the one redraw that asks uPlot to re-run layout
(`redraw(false, true)`); the crosshair's redraw stays `redraw(false,
false)`, because re-converging axes and padding on every mouse move is
three layout cycles per frame for a number that has not changed.

#### Tests

`PlotArea.draw.test.ts` +27 cases over the recording context (73 in the
file): the gutter arithmetic (`eventChipGutterPx` — one line is free,
two lines cost 13, never three, the widest label wins, a narrow plot
wraps earlier), and each of the three draw functions' *place* — the clip
rect it takes, that every inked op is outside the plot box on the right
side of it, chip-per-cursor positions, the skip rules, and the
highlight's dim/lit ordering.

`PlotPanel.dom.test.tsx` +6 cases (282 in the file), which is where the
collapse claim lives: the chips land above / below the plot box on the
*drawing* axis; the top gutter reserves 17 for a short label, 30 for a
wrapped one, on the top area alone; and both reservations move to the
axis that inherits the chrome when the anchoring area is collapsed
(`padding[0]`, and the x axis's `gap`/`size`).

One fixture change: the uPlot mock's `bbox.top` was `0`, which is a plot
box flush against the canvas edge — a shape uPlot never produces here
(the top padding is also the y tick easement) and one in which "above
the plot box" is unrepresentable. It is now 34: uPlot's 17 px easement
plus the 17 px band a one-line label reserves, which is what these
fixtures draw. No existing assertion moved.

#### Perf and the release build: deferred

Per the owner's economy rule, no ADR 0031 reading and no release build
this phase. The diff adds no per-frame work: the same chips are drawn,
in different places, and the one new computation (the gutter's line
count) runs on a layout cycle rather than a frame.

### 2026-09-20 — phase 2: markers

Two branches off `task146-lane-investigation`, one squashed commit each:
`task146-markers-host` (the serve) then `task146-markers` (the
frontend). Split because the phase-1 estimate held — the host half alone
is −885 / +234 over five files — and the two halves review as different
questions.

#### Host: one serve for every render mode

`decimate_min_max` keeps each bucket's **first and last sample beside
its min and max**, in index order, deduplicated. `reduce_transitions`,
`SignalCache::window_categorical`, the `Reduction` enum,
`slice_many`'s reduction argument and `sample_signals`' `categorical`
flag are deleted. The fold in `SignalCache::fold` is **unchanged** —
phase 1 measured putting first/last there too as *worse* (4.78 columns
lost against 1.49) for 2.3x the pyramid.

Phase 1's guarantee, pinned at two levels:

| test | where |
| --- | --- |
| `a_run_spanning_two_buckets_survives_at_every_alignment` | `signal_sampler.rs` — the reducer, every hold 2..=bucket+1 at every offset |
| `a_held_code_two_pixel_columns_wide_survives_the_serve_at_every_alignment` | `signal_cache.rs` — end to end at the `61379f88` width (301.3 s, 2248 points, 134 ms column), holds 21/28/43/44 samples × 48 offsets |

The second is phase 1's fixture rewritten: the case it asserted was
*lost* (43 samples at offset 41, 3.21 columns) is now asserted served at
every alignment.

**Served-point bound.** `2 · max_points + 2` → **`4 · max_points`**.
Tighter than the `4 · max_points + 2` phase 1 predicted, because the old
`+2` was the endpoint-forcing rule and keeping every bucket's endpoints
subsumes it. On the V2 scenario that is 3768 → 5651 points measured
(+50 %), against a bound of 8992.

#### Frontend: all points, and the lane as an ordinary series

- **`MAX_POINT_MARKERS` and the uniform stride are gone** from
  `sampleMarkerColumns`. `Points: On` marks every served sample. Nothing
  is unbounded by it: the serve is bounded to `4 · max_points` and
  `max_points` is one point per canvas pixel column.
- **Finding 1's secondary — `splitExtrapolatedRows` blanking a marker —
  does not reproduce**, and needed no code change. A span runs between
  two *consecutive served points* (`extrapolated_spans` skips a pair
  with more than one raw sample between), and the blanking runs strictly
  between the columns that bound it, so no sample column of the series
  is ever inside it. Pinned rather than assumed, over all three ruled
  shapes at once (stall, dashed tail, one-sample hline's two wings):
  `PlotArea.draw.test.ts` :: *keeps every marker off the cells the
  extrapolation blanking takes*.
- **The lane's private marker pass is deleted** and the tiles now draw
  in uPlot's `drawAxes` hook, **under** the series layer. That is the
  one structural decision in this half, and it is forced: the exit
  criterion says a lane's markers are uPlot's *and* legible over the
  tile, and a marker painted under a tile cannot be made legible by ink.
  Measured — a black marker under the light theme's `laneFillDefault`
  (alpha 0.75) reads **1.8:1** against the tile it sits under, where the
  project's own bar (`LANE_LABEL_MIN_CONTRAST`) is 3. Only 25 % of the
  dynamic range survives the tile, so no ink clears it. Drawn over the
  tile the same marker is the label's problem exactly, and
  `laneLabelInk` already answers it.
- **The tile labels are held back for the `draw` hook.** Consequence of
  the above: with the whole tile under the series layer, the stepped
  line would cross its own label — for a table with an odd number of
  codes the middle code plots exactly at the label's baseline.
  `drawEnumTiles` now returns its labels and `drawEnumTileLabels` paints
  them after the series layer. The held-back set is small (only tiles
  wide enough to hold a label), so this is not a second pass over the
  segments.
- **A code is normalised into the tile band** (`laneTileBand(band, 0)`
  — the nominal centred 60 %, no pixel floor) instead of the whole lane
  band, so the plotted value and its marker land on the tile. Finding
  5 (c): for a two-code enum, code 0 sat below its own tile entirely.
- **A lane's marker ink is `laneLabelInk` against the tile** — one ink
  per lane, measured against the fill the lane's own accent makes
  (`colorMapLaneFill(accent)` where a colormap targets it, the theme's
  default lane fill otherwise). One per lane and not one per tile
  because uPlot styles a series' point layer once, and because whether
  the accent survives a tinted tile is a property of the theme (dark
  3.23–5.89:1, light 1.03–1.80:1) rather than of the value. The
  single-enum ribbon keeps the plain accent: its line plots the real
  code against a real y scale, so its markers are as often off the
  ribbon as on it.
- The `categorical` request field is gone from `DecimatedRequest` and
  from the fetch memo key; `PlotPanel.dom.test.tsx`'s mock run reducer
  with it.

Exit-criteria tests added: *marks every served sample of a long series,
uncapped* (2001 samples, 2001 markers); *marks a lane's own samples, not
the columns a dense sibling contributes* (through the shared
`points.filter`, not a lane pass); *draws one tile, spanning the run* at
the V2 width and budget; *draws no markers of its own: the point layer
is uPlot's*.

#### Perf: deferred to the stack-tip run

No ADR 0031 harness run and no release build this phase, per the owner's
economy rule — the reading is the overseer's single end-of-day run on
the stack tip, and the exit criterion's "harness reading recorded" is
satisfied by it. Two numbers to read it against, both of which move the
same way:

- **markers**: 5651 per series where there were 500, on the V2
  scenario — the all-points change and the serve change compound;
- **lane tiles**: a lane's tile count is now the count of runs in a
  `4 · max_points` serve rather than the count of *transitions* in a
  run-reduced one. On a rapidly-cycling enum at a wide zoom that is up
  to ~4 tiles per canvas pixel column, each costing a `fillRect`, a
  `strokeRect` and a memoised label fit.

The pair-preserving fallback the all-points ruling names is **not**
implemented; per the ruling it lands only if the tip reading says so,
and it should be sized against 5651, not 3768.

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

### 2026-09-20 — tip perf reading (overseer, after phase 4)

One ADR 0031 capture on the stack tip (`task146-panel-plumbing`,
`25ffdf9e`, release build, ev-zonal, 60 s, `scrub` interaction,
`--rbs-run-on-start`), report
`docs/performance-measurements/frontend/2026-09-20-25ffdf9e-feedback-tip-run1.json`;
`cannet-perf-measurement check` passed all 31 gated metrics against
`baseline.json`. The numbers the all-points and lane rulings asked for:

| metric | baseline | this run | limit |
|---|---|---|---|
| `longtask_ms_per_s` mean / p95 | 0 / 0 | 0 / 0 | 10 / 17 |
| `lag_ms_max` | 10.4 | 22.4 | 40.8 |
| `jank_fraction` | 0 | 0 | 0.05 |
| `jsheap_mb_peak` | 83.6 | 95.4 | 231.2 |
| `renderer_mb_peak` | 316.5 | 329.7 | 697.0 |
| `tree_mb_peak` | 741.7 | 746.2 | 1547.4 |
| `flush_ms_mean` / `tx_late_ms_mean` | 25.0 / 18.0 | 3.0 / 3.1 | 25 / 18 |
| `rx_fps` / `tx_fps` overall | — | 1604.6 / 1612.3 | ±15 % of 1608 |
| `rx_gap` ids measured | — | 174 | — |

Verdict: no marker-cost regression at this load; the pair-preserving
fallback is **not** needed. `lag_ms_max` doubled on a single run, which
is within the band an unchanged build spans (ADR 0031 § single runs);
worth a second look only if the next reading repeats it. The report
stays as a working artifact until close-out folds or deletes it.

Harness note: the first attempt on this build timed out at
"sidecar=not ready" 30 s after a cold 216k-frame restore
(`ui_last_ms` 336, one health tick in 17 s) and the second connected
but captured 0 frames because `--rbs-run-on-start` was omitted; the
third, with the flag, is the reading above.
