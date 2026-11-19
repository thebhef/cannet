# Task 176 — Decimated Plots Share Their Columns

> **Opened 2026-11-19** from the owner's report that, with task 174 in,
> the solo-paged TR03 plots survive but switching back to the
> "all groups" view hangs the frontend. Implemented the same day.

## Why

Task 174 stopped the plot paying for signals it does not draw. Its
"not in scope" line is this task: the merge's cost in what **is**
drawn.

`mergeSeries` builds uPlot's aligned table: one x column per distinct
timestamp across every series on the axis, and one row per series
across all of them. A decimated serve keeps each column's first, last,
min and max sample **at that sample's own time**, and signals from
different messages almost never share a time. So the union is about
`signals × 4 × pixel columns`, and the table is that times the signal
count again.

On the 3840 px TR03 window the plot asks for ~4600 columns (canvas plus
fetch margin), so ~15 k points per signal. With all 576 signals
visible the union runs to millions of columns and the table to
billions of cells. 2026-11-19 14:24 PST: the renderer climbed from 0.4
to 3.1 GB in under two minutes with no UI heartbeat, alive and busy —
the run-up to the 11-18 out-of-memory kills, now reached by drawing the
signals rather than by holding them.

## Scope

1. **A decimated serve puts its points on a shared column grid.** The
   grid is a property of the request — the window `[from, to)` and the
   point budget — anchored at a whole multiple of the column width, so
   every signal served for one request bins against the same columns,
   and a window that slides by less than its width keeps its columns.
   Each kept point is reported at a fixed position in its column by its
   rank there (first, middle(s), last), so a column contributes at most
   five distinct times however many signals share the axis.
2. **What stays at its true time:**
   - a series served raw (it fits the budget — the zoomed-in case);
   - points outside the grid (the boundary samples a slice carries so a
     line runs off each edge);
   - every point in the column holding the series' first or last
     served point, so where a series starts and its live edge are
     exact;
   - the bus-error serve, whose delta property reads real sample times.
3. **Extrapolated spans follow the points they are bounded by.** A span
   end that is a served sample moves with that sample, so the
   frontend's dashed stretches still start and end on a sample of the
   series.

### What this does not change

- **Values.** No value moves, so each column's min and max — the
  envelope and the y-scale fitted to it — are what they were.
- **Interpolation.** A series is still linear between its own
  consecutive samples (ADR 0026); only where those samples sit inside
  their pixel column moves, by less than one column.
- **Which samples are kept**, beyond the grid itself: the reduction is
  the same first/last/min/max per column, and its guarantees (a run
  held a column survives; a narrower one keeps its change within a
  column) are stated in columns already.

### Trade-off taken

A decimated sample's reported time is its column's, not its own: off by
less than one pixel column. A readout or cursor placed on a decimated
envelope reads that position; zoomed in to where the series fits the
budget, every time is exact again.

### Not in scope

- The remaining cost of many visible signals: ~5 columns per pixel
  shared, plus each series' own unsnapped ends, is still
  `signals × ~25 k` cells for 576 signals on one axis at this width —
  bounded and linear in the signal count, but not small.
- Follow + Fit, whose window widens every tick, re-bins every tick, as
  it already did.

## Exit criteria

- [x] Decimated signals with unrelated sample times, served over one
      window, use at most five times per column between them, plus each
      one's own ends and off-grid points — where unsnapped they grew
      with every signal. *`signal_sampler` unit test.*
- [x] Snapping keeps every value, keeps each point in its own column, and
      keeps each series strictly increasing in time.
      *`signal_sampler` unit test.*
- [x] A window that slides by less than a column reports a sample at the
      same time. *`signal_sampler` unit test.*
- [x] A raw serve is not moved; a serve says whether it decimated.
      *`signal_cache` unit test.*
- [x] An extrapolated span bounded by served samples moves with them.
      *`sampling` unit test.*
- [x] Docs: ADR 0026's serve paragraph says where a decimated sample is
      reported.
- [ ] On the TR03 project, the "all groups" view with all 576 signals
      draws without hanging the renderer. *Owner, live.*
