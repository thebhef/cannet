# ADR 0026 — Plot areas compose signals; axes configure how they're viewed

Status: accepted (2026-06-09; partially shipped — see "Implementation status")

The plot view grows a level. Until now a plot panel held a flat list
of plot areas, each rendering as exactly one chart. This ADR records
the model that lets a single curated group of signals be laid out
several ways without the user hand-placing charts, and fixes a
long-standing y-axis labelling bug along the way.

## Decision

**The plot view is a four-level hierarchy:**

> **plot panel** → **plot area** → **axis** → **series**

with a clean division of responsibility:

- A **plot area** *composes* — it is a user-curated group of related
  series. Membership is either hand-picked (manual mode) or computed
  from a name regex (filter mode), exactly as
  [ADR 0020](0020-filter-defined-plot-areas.md) defines. A panel holds
  one or more areas, stacked and sharing one x **scale** (time).
- An **axis** *configures* — it is one drawing surface (matplotlib's
  `Axes`): a set of series drawn against one y **scale** and the
  shared x scale. Axes are **not** placed by hand; they are derived
  from the area's **y-axis mode**.

**A plot area carries a y-axis mode** with three values:

| Mode | Axes produced | Scaling |
| --- | --- | --- |
| **unified** | one axis; all series overlaid | each *unit group* auto-scaled independently to fill the axis; same-unit series share one y scale |
| **per-unit** | one axis per unit | each axis auto-scaled to its unit's data; each enum series gets its own axis |
| **individual** | one axis per series | each axis auto-scaled to its one series |

**The visible y-scale labels are always the primary signal's real
engineering values — never a 0–1 ratio.** Each axis has a **primary
signal** (the user picks it by clicking a series; defaults to the
first). Its unit and value range drive the axis's tick labels. When
several unit groups are overlaid on one axis (unified mode), only the
primary's unit is labelled; the other groups are still drawn at their
own auto scale and read via the cursor/legend. This is the rule that
fixes the bug where the y axis sometimes showed `0.0–1.0` instead of
the selected signal's units.

**Y scales are always auto-derived from the data** (matching today's
auto behaviour). There is no fixed user-set `{min,max}` range; the old
`yMode` fixed half is removed.

**Enum series render as a logic-analyzer lane when they have their own
axis** (per-unit / individual): the enum is still plotted numerically
— points honour the show-points control — with a high-opacity label
box overlaid on each constant-value segment showing the enum label.
The boxes sit in a **centered horizontal band** down the middle of
the plot rather than tracking the held value's y position. A value
table with many entries collapses per-value lanes to a few pixels;
decoupling the label band from the value gives the labels all the
room they need, while the stepped line still draws at the actual
value so the user reads "what value" from line height and "which
label" from the centered ribbon. Under unified mode an enum plots as
a plain numeric line with no labels (a text box per overlaid enum
would be noise). "Lane" is an axis *render style*, not a new
structural level.

**Each axis maps to one uPlot instance.** This keeps us consistent
with [ADR 0007](0007-uplot-plot-renderer.md):

- per-unit / individual: several uPlot instances stacked and x-synced
  — exactly the machinery that already stacks multiple plot areas;
- unified: one uPlot instance carrying several *scales* (one per unit)
  with only the primary's axis ticks shown.

The host still min/max-decimates each series; the frontend merge now
targets a per-axis scale set instead of a single shared y scale. ADR
0007's data pipeline is unchanged; this is a usage decision on top of
it.

## Why

**Composition and configuration are different concerns, so they get
different levels.** A user thinks "these signals belong together"
(an area) separately from "show this group as one overlaid chart vs.
one chart per unit" (the mode). Folding them into a single level would
force the user to hand-build the per-unit/individual layouts that the
mode generates for free — and would have no home for ADR 0020's
filter-defined membership, which is an area-level idea.

**Axes are derived, not placed, because hand-placing is the tedium we
are removing.** The whole point of per-unit / individual is that the
area arranges its own signals; making the user create and assign axes
manually would defeat it.

**Primary-signal-driven real-unit labels because a normalised axis is
unreadable.** A `0.0–1.0` y axis tells the user nothing about the
signal they selected. Anchoring the labels to one real unit (the
primary's) keeps the axis meaningful even when other units are
overlaid; the alternative — labelling nothing, or labelling a
synthetic ratio — is the bug we're fixing.

**No fixed range for now because its semantics under multi-unit
overlay and per-unit/individual layouts aren't worked out, and it
isn't needed yet.** Auto-derived scales cover the current need;
re-introducing a fixed range later is additive.

**Axis ↔ uPlot instance because it reuses what already works.**
Multiple x-synced uPlot instances is precisely how stacked plot areas
already render; mapping each axis to an instance means per-unit /
individual layouts fall out of existing machinery rather than needing
a multi-region renderer uPlot doesn't natively provide.

## Rejected alternatives

- **Collapse area and axis into one level.** One stacking concept,
  simpler model — but the user would hand-create every per-unit /
  individual chart, and filter-defined membership (ADR 0020) would
  have nowhere to live. The redundancy between "many areas" and "one
  area, many axes" is intentional: areas are curated, axes are
  derived.
- **One global y scale in unified mode (literal shared min/max).**
  Volts and amps on the same min/max makes one of them a flat line.
  Per-unit-group auto-scaling is what makes an overlaid chart usable.
- **Normalised (0–1) y axis in unified mode.** What we have today by
  accident; unreadable, and the thing this ADR sets out to fix.
- **One uPlot instance per area with faked stacked regions.** uPlot
  has no native multi-region layout; emulating it fights the library
  for no gain over stacked instances.
- **Enum text boxes in unified mode too.** A label per held segment
  across every overlaid enum is visual noise; enums fall back to a
  bare numeric line when sharing an axis.

## Implementation status

Task 15 ships the model with the deviations and rough edges noted
below:

- **Show-points control** (`auto` / `off` / `on`) is on the plot
  toolbar and applies to every series in every axis of the panel.
- **Y-axis-mode selector** (`unified` / `per-unit` / `individual`)
  sits in each plot area's signal-panel head. Switching modes
  re-stacks the area's canvases. The per-axis derivation is the pure
  `deriveAxesForArea()` helper (covered by unit tests).
- **Unit-based y-scale.** Same-unit series on an axis share one y
  scale — the union of their observed ranges, computed by the pure
  `groupScaleRanges()` helper in `plotData` — and each unit group
  auto-scales independently to fill the axis. One refinement on the
  decision table: **unitless series each keep their own scale**. Two
  signals that merely both lack a DBC unit are not known to be
  commensurable, and pinning them to a shared min/max would flatten
  whichever has the smaller range; "shares a unit" is read as
  "shares a *declared* unit".
- **Multi-uPlot per area.** Each derived axis is a stacked uPlot
  instance with its own canvas and signal-list slice; the panel-level
  x-sync registry (`xSyncRef` + `registerInstance`) was already
  per-instance, so cursors, zoom, and pan stay coherent across the
  stack. Area-level chrome (filter editor, y-axis-mode selector,
  remove ×) renders only on the first derived axis of each parent.
- **Fixed-range yMode** is gone. The old `yMode: "auto" | {min,max}`
  field is no longer persisted; old projects parse with the field
  ignored.
- **Per-series colour picker** is on each signal-row's swatch
  (right-click opens the browser's native picker).
- **16-colour wheel** is the seed; a dragged-in series picks its
  colour from the wheel index equal to the count of series already
  in the target area.
- **X-axis cursor labels** render the cursor's letter + time on every
  axis (used to only render on the bottom axis).
- **Logic-analyzer lane overlays.** On an enum-only axis the stepped
  line carries an opaque label box on each constant-value segment,
  centred on the held value and tinted by the series colour. Pure
  `enumSegments()` walks the (t, v) arrays; the draw hook then
  reuses the cursor-label box style. Segments narrower than the
  label width are skipped (the user can zoom in for those).

What's still rough:

- **Primary signal is per *area*, not per axis.** The decision above
  gives each axis its own primary signal; the implementation keeps
  one `primarySignalKey` per plot area, shared by its derived axes.
  Clicking a series sets the area's primary; a derived axis that
  doesn't contain that series falls back to its own first non-hidden
  signal — so in practice each axis labels itself sensibly, but the
  user can't pin a *different* explicit primary on two axes of the
  same area. Lift the key onto the derived axis if that ever bites.
- **Per-unit grouping is unit-based only.** The `deriveAxesForArea`
  helper has an `isEnum` predicate slot to break enum series out
  onto their own axis in per-unit mode, but the panel doesn't
  source it yet (each PlotArea queries `list_value_tables` for its
  signal subset; the panel level doesn't roll up that information).
  In practice today: an enum series in per-unit mode shares an axis
  with anything else of the same unit, so the logic-analyzer lane
  overlay only activates in `individual` mode (or in a manual area
  that holds a single enum signal). The fix is panel-level
  enum-awareness fed into `deriveAxesForArea`'s `isEnum` slot —
  tracked in `plans/backlog.md`.

## Consequences

- `PlotAreaConfig` gains a y-axis-mode field (unified / per-unit /
  individual) and loses the fixed-range half of `yMode`; the project
  schema version increments additively.
- The frontend gains a per-axis derivation step: an area's series +
  y-axis mode → the set of axes (each with its series, primary signal,
  unit-grouped scales, and render style). Today's single-axis path
  becomes the unified case.
- The y-axis labelling bug (normalised `0.0–1.0` instead of the
  primary signal's units) is fixed by the primary-signal rule.
- New domain terms enter the glossary
  ([`../CONTEXT.md`](../CONTEXT.md)): **axis**, **scale**, **y-axis
  mode**, **primary signal**, **logic-analyzer lane** — and "plot
  area" / "plot panel" are pinned to their levels.
- A future fixed-range or DBC-physical-range scaling option is
  additive on top of this model.
