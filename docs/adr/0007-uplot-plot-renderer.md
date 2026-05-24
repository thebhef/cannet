# ADR 0007 — Plot renderer is uPlot

Status: accepted (2026-05-24)

## Decision

The plot panel renders with **uPlot** (MIT). uPlot is fed
**already-decimated, already-merged** series: the host
min/max-decimates per-signal series down to ≈ the pixel width of
the visible window using a `max_points` hint, and a frontend
module merges those per-signal series onto a shared timeline. The
renderer paints; the model does the work.

The plot panel sits behind a thin adapter — swapping uPlot out is
replacing one panel component plus the merge step, not untangling
state.

## Why uPlot

**Purpose-built for the shape we have.** Many series on a shared
x-axis is uPlot's primary case; everything else evaluated here is
either a general charting library adapted to time-series or a
time-series engine shaped for a different domain.

**Tiny imperative API.** `new uPlot(opts, data, el)` plus
`setData` / `setScale` / `setSize` and a `plugins` hook for
canvas overlays drops into a React panel with no wrapper library.

**Canvas-based, ~50 KB, zero dependencies.** Fast incremental
redraw on append; nothing else has to be loaded for it to render.

**Built-in drag-zoom and readout cursor / legend.** The
interaction affordances the plot panel needs ship with the
library; they're not features we have to build.

## Why decimation is host-side, not in the renderer

**A signal series exceeds the renderer's comfortable redraw size.**
The trace store holds hundreds of thousands to millions of frames,
so a per-signal series can be larger than any canvas plotter will
redraw responsively at full resolution.

**The frontend never holds the un-decimated series.** The host
min/max-decimates (per-bucket extrema, so spikes survive) keyed by
a `max_points` hint that matches the visible window's pixel
width. The frontend receives O(visible-pixels) points, not
O(capture). This is consistent with the GUI's paged-model
contract — views fetch slices on demand and never own the whole
dataset.

**Live plotting is incremental.** Only frames appended since the
previous tick are decoded and folded into a bounded per-signal
cache; the cache re-fetches on overflow. A long capture isn't
re-decoded every tick.

## Consequences

- **Small bus factor.** uPlot is essentially one very-active
  maintainer. Mitigated by the permissive license and the thin
  adapter — fork-and-freeze is cheap if upstream goes dark.
- **A future WebGL renderer can swap in under the same data
  pipeline.** Because the host owns decimation and the frontend
  owns the shared-timeline merge, replacing the canvas painter
  with a WebGL one (regl-plot-style or similar) is a renderer
  swap, not a chart-from-scratch project. The data pipeline
  doesn't move.
- **The pixel-width-driven `max_points` hint is part of the
  contract.** The renderer's viewport size determines how many
  points the host returns; resizing the panel triggers a new
  sample at the new resolution.

## Rejected alternatives

- **dygraphs** (MIT) — the credible fallback. Canvas, mature, good
  live-append story. Owns more of the container and interaction
  model than uPlot, its bundle is several times larger for
  features (range selector, annotations, CSV ingest) the plot
  panel doesn't need, and its release cadence is much slower.
- **Chart.js + chartjs-plugin-streaming + zoom** (MIT) — a
  general charting library, not a time-series engine; poor
  per-update cost and GC pressure at the point counts the plot
  panel hits, plus three packages and a plugin lifecycle to keep
  working.
- **lightweight-charts** (Apache-2.0) — very fast but
  finance-chart-shaped (candles, single price/time pane, fixed
  interaction grammar); mapping arbitrary CAN signals with their
  own units and y-scales onto it fights the API.
- **Apache ECharts** (Apache-2.0) — does everything (including
  streaming via `appendData`), but a large dependency with a
  config-object programming model — disproportionate bundle and
  complexity for one panel in a WebView.
- **Plotly.js** (MIT) — has a WebGL `scattergl` mode but the
  library is ~1 MB+ and D3-based — far heavier than the job
  needs.
- **Highcharts / amCharts** — free for non-commercial use only;
  commercial use requires a paid license. Out per the
  permissively-licensed-forever constraint.
- **Hand-rolled canvas / WebGL renderer** — a *good* one
  (incremental redraw on append, min/max decimation,
  cursor hit-testing, correct pan/zoom scale maths, DPR handling,
  axis tick generation) is most of what uPlot already is, tested
  against a large user base hitting the same edge cases. Revisit
  only as a renderer swap under the existing data pipeline, never
  as a chart-from-scratch.
