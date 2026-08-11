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
| **per-unit** | one axis per unit, plus one shared **enum-lanes** axis | each unit axis auto-scaled to its unit's data; all enum series collect onto a single stacked-lane axis |
| **individual** | one axis per series | each axis auto-scaled to its one series |

**The visible y-scale labels are always a real signal's engineering
values — never a 0–1 ratio.** Each axis labels its ticks through one
signal's unit and value range: the parent area's **primary signal**
(the user picks it by clicking a series) when that signal is on the
axis, otherwise the axis's own first ranged signal. In per-unit mode
each axis is a different unit group, so the primary is on at most one
of them and every other axis labels through its own first signal — a
volts / amps / percent stack reads V, A, % rather than all `0.0–1.0`.
When several unit groups are overlaid on one axis (unified mode), only
the chosen signal's unit is labelled; the other groups are still drawn
at their own auto scale and read via the cursor/legend. This is the
rule that fixes the bug where the y axis sometimes showed `0.0–1.0`
instead of the selected signal's units. (The blank-gutter enum-lanes
axis is exempt — its tiles carry the labels; see below.)

**Y scales are auto-derived from the data, with a per-axis manual
override.** Auto-derivation is the default and the whole behaviour of
an axis nobody has configured. On top of it a user may pin an axis's
**min**, its **max**, or both; an absent bound stays automatic, and a
pinned one beats everything automatic — follow-live's all-time extent
and the paused visible-fit alike. The override is per *axis*, keyed by
derived-axis id like the weights and the log flag, and stored sparsely
so an axis nobody pinned carries no setting at all. The old per-*area*
`yMode` fixed range stays removed and is not migrated onto it: an area
is not an axis, so an old range has no axis to land on.

**A log scale is a property of the axis, not of a signal.** A log
scale changes how a range maps to pixels, and every series drawn on an
axis shares that mapping — so two same-unit signals collected onto one
`per-unit` axis cannot disagree about it. It is therefore set per
axis, keyed by derived-axis id like the axis weights are. A DBC
display hint ([ADR 0043](0043-cannet-dbc-attributes-and-display-authority.md))
may at most act as a default that seeds an axis nothing contradicts;
**it never overrides an explicit per-axis setting**, and an axis whose
signals disagree stays linear. Per-*value* display facts — a radix —
carry no such constraint and may be signal properties.

A log scale brings rules the linear bounds do not. **Its min is
derived, not settable**: a log axis cannot render zero or negatives, so
rather than accept a min and then reject it, the min becomes the
smallest positive value present (snapped down to a decade) and only the
max stays user-settable. **Non-positive points are dropped, not
clamped** — a clamped point sitting on the axis floor reads as a real
reading — so a series with no positive value at all draws nothing, and
the view says so rather than showing a silently empty axis.
**Auto-derived bounds snap to decades** rather than taking the linear
padding, and the ticks land on decade boundaries. A manual min set
before the toggle is *held*, not discarded, so turning log off restores
it.

**Enum series render as logic-analyzer lanes.** In **per-unit** mode
every enum series of an area is pulled off its unit axis onto one
shared **enum-lanes axis**: each enum is a horizontal lane (config
order, top-first), its stepped waveform normalized into the lane's
band with an opaque label tile drawn on each constant-value segment.
A lane's y range is a **table fact** — the value table's raw min/max,
padded — so it is independent of observed data, follow-live extents,
and Fit Y (all designed out for lane axes). The axis draws **nothing in
its y gutter**: the tiles carry the value labels and the side panel
carries identity. It still *reserves* the gutter — see "one gutter for
the stack" below. A colormap ([ADR 0029](0029-signal-value-color-maps.md)) tints each
tile by its held value. A lone enum on a per-unit area is a one-lane
instance of the same axis.

The older **single-enum render** still serves a single enum in
`individual` mode (or a manual area holding one enum): one centered
horizontal label ribbon down the middle of the plot rather than a
per-value lane — decoupling the ribbon from the held value keeps
labels legible where a tall value table would otherwise collapse
per-value lanes to a few pixels, while the stepped line still draws at
the actual value. Under **unified** mode an enum plots as a plain
numeric line with no labels (a text box per overlaid enum would be
noise). "Lane" is an axis *render style*, not a new structural level.

**Vertical space is fit-to-panel, with draggable splitters.** The
derived axes of a panel always fit its height — no stack-scrolling
once N axes exceed it. Each axis carries a **weight** (flex-grow,
default 1, persisted per derived-axis id); a draggable separator
between two adjacent axes trades weight between that pair (conserving
their sum, clamped to a usable minimum), and double-clicking it
equalizes them. A y-axis-mode change produces new axis ids and so
resets an area's custom weights; the shared enum-lanes axis keeps a
membership-stable id so lane churn doesn't reset its weight.

**An area can be collapsed, and a collapsed area gives up its plot
height.** A plot area carries a persisted `collapsed` flag: every axis
it derives drops its canvas and leaves the fit-to-panel height
distribution, while its side-panel rows stay — so the toggle back, and
the swatches that un-hide signals, stay in reach. The flag is per
*area*, not per axis, because an area is the curated thing and its axes
are derived: one collapse state, however many axes the mode stacks. An
area whose signals are **all hidden** is collapsed regardless of the
flag — there is nothing to draw on it — which is the rule that already
collapses a fully-hidden axis.

**Solo masks the view; it never rewrites what is hidden.** A panel-wide
regex over the canonical signal path (ADR 0038 — the same subject an
area's pattern filter uses) can restrict the panel to the series it
matches. That is a *view* mask composed on top of each series' own
`hidden` flag — a series draws when it is not hidden **and** (solo is
off, or its area matched nothing, or it is in solo's visible set) — not
a bulk edit of the other series' flags. Solo is a question ("show me
these"), and answering it by writing `hidden: true` across the panel
would destroy the answer to a different question the user already gave;
clearing solo must restore the view verbatim, hidden rows included. The
mask is scoped to the areas the pattern found something in: an area
with no match renders exactly as solo-off leaves it, so a pattern aimed
at one area never blanks the rest of the panel. Within an area solo
does apply to, being left with no *solo-visible* series collapses it by
the same all-hidden rule above, and equally without touching its
persisted `collapsed` flag.

**One wheel, and one point where a signal's color is decided.** Every
surface that draws a signal in its own color — the signal view's name
text, a plot series' stroke and swatch — resolves it through a single
precedence rule: an **explicit user pick** (the signal view's
project-level `signal_colors` entry; a plot series' picked color) → a
**generator**, when a project rule derives a wheel index from the
signal's identity → the **stable-by-identity hash** of the signal's
canonical `(bus, message, signal)` key. One key, one theme wheel, one
rule, so a signal nobody picked a color for reads the same in every
view with nothing persisted to make it so. (This is signal
*identity* color. A value→color map ([ADR 0029](0029-signal-value-color-maps.md))
tints a signal's *value* and is a separate question with its own
resolver.)

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

**A manual range is per axis, and additive on the auto-derived
default.** The semantics that once blocked it fall out of the axis
level: an axis is one scale, so a pinned bound applies to every unit
group drawn on it and there is no question of which series it means.
It is an override, not a mode — an unpinned bound keeps auto-scaling —
so nothing an unconfigured panel does changes, and the sparse store
means nothing an unconfigured panel persists changes either.

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
  auto-scales independently to fill the axis. Four refinements on the
  decision table:
  - **Unitless series each keep their own scale.** Two signals that
    merely both lack a DBC unit are not known to be commensurable, and
    pinning them to a shared min/max would flatten whichever has the
    smaller range; "shares a unit" is read as "shares a *declared*
    unit".
  - **Hidden series contribute nothing to the union.** An axis
    auto-scales to its data, and what is hidden is not drawn on the
    axis — so hiding a 3000 A nominal limit rescales the axis to the
    500 A effective one still on it. The per-signal all-time extents
    stay host-owned model facts
    ([ADR 0025](0025-frontend-windowed-source-contract.md)); *which* of
    them an axis unions is a view decision (visibility is view-local
    plot-area config the host has no reason to know), so the selection
    is made in `PlotArea`'s normalisation and the host query is
    unchanged.
  - **A constant series still joins its group.** A signal that never
    moves has a degenerate extent (`hi === lo`) and so cannot be
    normalised on its own; it contributes its one value to its unit
    group's union all the same, and is drawn on the group's scale — a
    constant 3000 A limit sits at the top of a 400–3000 A axis rather
    than at the canvas midline beside a 500 A signal filling the
    canvas.
  - **A group with no span at all gets a minimum range.** When every
    member is constant at the same value the union has no span, so
    there is nothing to normalise by and no measurement to draw. The
    group is widened to **±10 % of that value**, centred on it — the
    trace still sits mid-canvas, but the axis labels read the value it
    holds instead of a bare 0–1 that says nothing. At exactly zero the
    proportional band collapses, so the fallback there is an absolute
    **±1**: there is no magnitude to take a fraction of, and ±1 keeps
    the axis in the signal's own units rather than inventing one. A
    constant has no span, so any scale for it is a *choice*, not a
    measurement — this records which choice. The widening happens in
    `groupScaleRanges`, on the group union rather than per signal, so
    a constant sharing its group with a moving signal still takes the
    plain union above. The midline fallback in the renderer now covers
    only a signal with no range at all (nothing decoded yet), which is
    what keeps the normalise free of a divide-by-zero.
- **Multi-uPlot per area.** Each derived axis is a stacked uPlot
  instance with its own canvas and signal-list slice; the panel-level
  x-sync registry (`xSyncRef` + `registerInstance`) was already
  per-instance, so cursors, zoom, and pan stay coherent across the
  stack. Area-level chrome (filter editor, y-axis-mode selector,
  remove ×) renders only on the first derived axis of each parent.
- **Fixed-range yMode** is gone. The old `yMode: "auto" | {min,max}`
  field is no longer persisted; old projects parse with the field
  ignored, and it is not migrated onto the per-axis manual range above
  — it was a per-*area* range, so there is no axis it can be said to
  have meant.
- **Manual y control** is a context menu on the axis itself:
  right-clicking the y gutter offers a min, a max and a log toggle for
  that derived axis. Both bounds default to empty, meaning the
  auto-derived scale, so an axis nobody opens the menu on is unchanged.
  The settings live in `plotAxisScale.ts` (`AxisScale` + the
  precedence and decade maths, under unit tests) and are persisted
  sparsely as the panel's `axisScales`, keyed by derived-axis id.
  Pruning is on `retainedAxisIds` — every id an area's signals could
  mint in *any* mode — so a setting survives a mode change and retires
  with its signals; a per-unit entry outlives all but the last signal
  of its unit. **Fit Y clears** a manual range rather than writing the
  fitted numbers into it: under a sparse store the two are the same
  intent. The menu is omitted on enum-lanes and single-enum axes,
  whose geometry comes from a value table rather than a value range.
- **Per-series color picker** is on each signal-row's swatch
  (right-click opens the browser's native picker). What it writes is
  the series' `colorPick` — the *only* color a plot stores.
- **One resolution point**, `signalColorResolver.ts`: pick →
  generator → `stableSignalColor` hash over the signal's canonical
  key, bound once per render and read live by the signal view's rows
  and by a plot series' stroke, swatch and lane accent alike. Because
  nothing is stored for an unpicked signal, a generator edit recolors
  every surface at once; a plot area redraws on a `seriesColor` change
  so a stopped plot repaints too. Adding a series stores no color: the old
  seeding — the wheel index equal to the count of series already in
  the target area — is gone, along with the disagreement it produced
  between areas holding the same signals. A `color` stored by that
  seeding is dropped on load rather than read as a pick, since the two
  are indistinguishable, so those series re-resolve; a `colorPick` is
  a pick and stands.
- **Generators** are ambient project elements holding an ordered list
  of regexes over signal *names*; the first rule that both matches and
  yields an integer first capture gives that signal its wheel slot, so
  `Cell(\d+)` aligns `Cell1…Cell16` and two rules capturing the same
  number land on the same slot. Matching is partial and case sensitive
  (`(?i)` opts out). The patterns are user input, so they compile and
  run **host-side** (`signal_generator.rs`, the Rust `regex` crate
  under a pattern-length and `size_limit` cap) and the editor shows the
  host's compile error at entry time; the frontend caches the
  host-evaluated key→slot map (`signalGeneratorContext.tsx`) and never
  executes a pattern.
- **X-axis cursor labels** render the cursor's letter + time on every
  axis (used to only render on the bottom axis). Tick spacing is
  label-width-aware so zoomed-in elapsed-time labels (more fractional
  digits) don't overlap.
- **Enum-lanes axis.** Per-unit mode collects an area's enums onto one
  shared axis (`deriveAxesForArea` kind `enum-lanes`), fed by a
  panel-level `list_value_tables` fetch (`useValueTables`) reduced to
  the enum-key set. `PlotArea` normalizes each enum into its lane band
  (`plotEnumLanes` helpers: `laneBands` / `laneValueRange` /
  `normalizeIntoLane` / `laneTileBand`), leaves its y gutter blank (but
  still reserved — see "one y gutter for the whole stack"), draws
  stepped series, and paints per-lane tiles via the shared
  `drawEnumTiles(band)` helper. The single-enum axis reuses the same
  helper with one full-height centered band. Pure `enumSegments()`
  walks the (t, v) arrays; segments narrower than the label width draw
  the colored tile without text. Tile labels centre on the midpoint of
  the tile's **visible** part (`tileLabelX`), rounded to whole pixels so
  glyphs aren't re-rasterised at a new subpixel phase each frame.
  Centring on the tile's *own* midpoint is rigid against the tile and so
  looks like the more stable choice, but a tile's off-screen edges are
  not model facts: the fetched slice is widened by two boundary points
  either side (`window_slice`), and those are re-fetched every round
  trip, so the tile's midpoint jitters with them — and zoomed in far
  enough they sit whole screens away, pinning the label to an edge. Only
  the visible part is trustworthy. The residual is that a tile with a
  real edge (a value transition) on screen tracks that edge at half the
  scroll rate under follow-live; a tile spanning the viewport — the held
  value, and the case where a moving label reads worst — has no real
  edge in view and stays dead centre.
- **One y gutter for the whole stack.** Every stacked axis draws the
  same x window, so their plot boxes must begin at the same x —
  otherwise the shared cursors, the x gridlines and the enum tiles all
  sit at the right *time* but the wrong *pixel*, and nothing reads
  across the stack. Each axis's left edge is its own y-gutter, and those
  legitimately differ (a numeric axis measures its tick labels; the
  enum-lanes axis needs almost none). So an axis's `axis.size` is a
  *request*: `createGutterCoordinator` collects them panel-wide and
  hands every axis the widest, latched through `axisGutterWidth` so the
  edge doesn't twitch as an auto-fitted scale re-formats its ticks. The
  narrow axes pay for it in blank gutter; a collinear cursor is worth
  more than the pixels. A width change nudges the other axes to
  re-lay-out, since a report reaches them from inside one axis's own
  layout pass and a stopped trace may not redraw again on its own.
- **Fit-to-panel vertical layout + splitters.** Derived axes always
  fit the panel (`.plot-panel-areas` is `overflow: hidden`, not a
  scroll list). Each axis's flex-grow is a persisted weight
  (`axisWeights`, keyed by derived-axis id, pruned to the live set);
  `plotAreaLayout` owns the weight maths (resolve, splitter-delta with
  pair-sum conservation + min-px clamp, equalize) under unit tests. A
  `role="separator"` handle between adjacent axes drags the pair's
  weights and double-clicks to equalize. Its grab band and its visual
  are deliberately separate: a 12px hit area straddling the shared
  border, drawing a 2px line *on* that border when hovered or dragged.
  Plot height is the scarce thing in this panel, so a handle that lights
  up a fat band costs more than it explains — and the grab target need
  not shrink with the ink. The collapsed run's handle follows the same
  split.
- **A hidden signal leaves the layouts it would otherwise drive.**
  Hiding is not just "don't stroke this line": the signal drops out of
  the y-scale union (above), out of the enum-lanes stack, and — when
  it is the last visible signal on an axis — out of the vertical
  height distribution.
  - *Lanes.* `laneBandsForVisible` (`plotEnumLanes`) lays the bands out
    over the *visible* signals and returns `null` for a hidden one, so
    hiding one of three enums re-flows the other two onto a two-lane
    axis instead of leaving a reserved gap. Both consumers use it: the
    resample that normalises each enum into its band, and the tile draw
    hook — which reads the signal list through a live ref, because
    toggling `hidden` deliberately doesn't rebuild the uPlot instance
    (`signalSetKey` excludes it) and a construction-time capture would
    keep drawing the old lane layout over re-flowed data.
  - *Whole axis.* When every signal on a derived axis is
    hidden, the axis is excluded from the fit-to-panel height
    distribution and its canvas is dropped (`.plot-area.collapsed`), while
    its rows stay in the side panel so they remain un-hideable — in the
    side panel's own column, at its own width, since un-hiding means
    clicking a swatch in those rows and a strip that reflowed across the
    empty row would have to be chased. The rows themselves render compact
    (message name folded up beside the signal name) so a collapsed axis
    costs a line or two of panel height. A collapsed axis must not become
    a dead zone in the panel either: it is skipped when pairing splitters
    (`splitterPartnerAbove` — the splitter reaches over it to the axes on
    either side, which is where the weight can actually go), and its
    empty canvas column is a placeholder that replays wheel and pointer
    gestures on a live axis's surface, since it has no uPlot of its own
    to receive them. This covers a fully-hidden numeric axis and a
    fully-hidden enum-lanes axis alike.
- **Area collapse rides that same path.** `PlotAreaConfig.collapsed` is
  folded into the per-axis collapsed flag the panel derives — an axis is
  collapsed when its parent area's flag is set *or* every signal on it
  is hidden — so the flag inherits the whole treatment above: flex-grow
  0, no canvas, compact rows, splitter suppression and reach-over, and
  the gesture-replaying placeholder. The **▾ / ▸ toggle** sits on the
  parent head beside the reorder grip (one per logical area, like the
  remove ×), and is inert on an area collapsed only by the all-hidden
  rule: there is no expanded form to go to, and its rows are already
  listed for un-hiding. A contiguous run of collapsed axes carries **one
  shared drag handle**, on the run's first axis
  (`collapsedRunHeads`) — a band of empty canvas column reads as one
  thing to grab, and a handle per collapsed axis would be a ladder of
  them saying nothing extra. It drags that axis's parent area with the
  same payload the head grip carries, so a collapsed area stays
  reorderable; a drop targets whichever area's row it was released
  over, so an area buried inside a run is targeted by dropping on its
  own side-panel strip.

- **Solo is applied per derived axis, after the axes are derived.**
  `plotSolo.ts` holds the pure model (matcher, match list in panel
  order, visible set, wrapping step, checked subset, sparse persisted
  shape); the panel applies it in `derivedAreaConfigs`, mapping only the
  `hidden` the renderer reads. Masking *after* derivation is what keeps
  a solo change from moving anything structural — the axis set, and so
  every id keyed by it (weights, manual ranges, uPlot instances), is a
  function of the area's signals and its y-axis mode, which the mask
  does not touch. So the whole feature reduces to the hidden-signal
  treatment above: scale unions, lane re-flow, the collapse of an axis
  with nothing left to draw, all for free. A visibility flip repaints
  from the window the area already holds rather than refetching (the
  fetch covers hidden signals, so the bytes would be identical); it
  still resamples, because normalisation happens there.

What's still rough:

- **Primary signal is per *area*, not per axis.** The decision above
  gives each axis its own primary signal; the implementation keeps
  one `primarySignalKey` per plot area, shared by its derived axes.
  Clicking a series sets the area's primary; a derived axis that
  doesn't contain that series falls back to its own first non-hidden
  signal — so in practice each axis labels itself sensibly, but the
  user can't pin a *different* explicit primary on two axes of the
  same area. Lift the key onto the derived axis if that ever bites.
- **Two value-table fetches coexist.** After the panel-level
  `useValueTables` roll-up landed, `PlotArea` still keeps its own
  `useValueTables` for the side-panel readout. Folding the two into
  one downward-passed map is tracked in `plans/backlog.md`.

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
- The manual range and the log flag are additive on top of this model:
  both are per-axis settings stored beside the axis weights, and an
  axis with none behaves exactly as it did before they existed. A
  future DBC-physical-range scaling option is additive the same way.
