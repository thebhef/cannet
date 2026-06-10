# Task 15 — Plot Refinements

Plot-panel ergonomics: rendering points on the plot (a tri-state
"show points" toggle) plus a cluster of plot-area / axis improvements.
Vocabulary follows
[ADR 0026](../../docs/adr/0026-plot-areas-compose-axes-configure.md):
a **plot panel** holds **plot areas** (curated signal groups); each
area lays its **series** across one or more **axes** per its **y-axis
mode**; an axis has a y **scale** driven by its **primary signal**.

What lands:

- **Show-points control** — a tri-state toggle on the plot panel
  toolbar (next to "fit data" / "fit y" / "follow live"):
  `auto` (default) / `off` / `on`. `auto` uses uPlot's
  density-aware mode (`points: { show: "auto" }`); `off` forces
  no points; `on` forces points always. Applies to every series
  in the panel (all axes).
- **Y-axis mode** — a per-plot-area selector choosing how the area's
  series lay out across axes:
  - unified: one axis; all series overlaid (unit groups scaled per
    *unit-based y-scale* below).
  - per-unit: one axis per unit; each enum series gets its own axis.
  - individual: one axis per series.

  y scales are always auto-derived from the data — there is no
  fixed-range option (the old `yMode` fixed half is removed).
- **Unit-based y-scale** — on an axis, series sharing a unit (volts,
  amps, etc; units from the DBC) share one y scale, and each unit
  group auto-scales independently to fill the axis. The visible y
  ticks show the axis's **primary signal**'s real engineering values
  — never a 0–1 ratio. The user picks the primary signal by clicking
  a series.
- **Enum logic-analyzer lane** — when an enum series has its own axis
  (per-unit / individual), it renders as a logic-analyzer lane:
  plotted numerically (points honour the show-points control) with a
  high-opacity text box overlaid on each constant-value segment
  showing the enum label. Under unified mode an enum plots as a plain
  numeric line with no labels.
- **Per-series colour picker** — choose a series' colour in the plot.
- **Colour-wheel seeding on drop** — a dragged-in series starts at
  the colour-wheel index for the count of series already in the plot
  area. The colour wheel is at least 16 colours deep.
- **X-axis cursor value label** — the x-axis cursor's time label
  appears on every axis.

ADRs:

- [`docs/adr/0026-plot-areas-compose-axes-configure.md`](../../docs/adr/0026-plot-areas-compose-axes-configure.md)
  — plot panel → plot area → axis → series hierarchy; y-axis mode
  (unified / per-unit / individual); primary-signal real-unit labels;
  enum logic-analyzer lane; axis ↔ uPlot instance.

Exit criteria:

- The plot toolbar surfaces the tri-state show-points control;
  switching to `on` shows points on every series; `off` hides them;
  `auto` defers to uPlot.
- Each plot area surfaces a y-axis-mode selector; unified, per-unit,
  and individual all lay out axes as described.
- On an axis, series group and scale by unit, each unit group
  auto-scaling to fill; the y ticks show the primary signal's real
  units, never a 0–1 ratio. Clicking a series promotes it to the
  axis's primary signal.
- y scales are auto-derived; no fixed-range control remains.
- An enum series on its own axis (non-unified mode) renders as a
  logic-analyzer lane — numeric points plus overlaid enum-text boxes;
  under unified mode it renders as a plain numeric line.
- Series colours can be changed after a series is added to the plot.
- A dropped series's colour-wheel index is offset by the series
  already in the plot area; the wheel is at least 16 colours deep.
- The x-axis cursor's time label is visible on every axis, and stays
  visible as plot areas are added and removed.
- Doc updates:
  - ADR 0026 reflects the shipped behaviour.
  - All relevant backlog items removed.
