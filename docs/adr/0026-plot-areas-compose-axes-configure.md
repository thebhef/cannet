# ADR 0026 — Plot areas compose signals; axes configure how they're viewed

Status: accepted (2026-06-09; partially shipped — see "Implementation
status"); amended (2026-08-21) — **an axis draws one scale**: every
series on an axis is normalised by the union of what is drawn there,
replacing the per-unit-group auto-scaling that let a series be drawn at
an amplitude its axis never stated; amended (2026-08-21) — **a
single-enum axis's y gutter carries raw codes, not value names.**

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
| **unified** | one axis; all series overlaid | **one scale** — the union of every visible series on the axis |
| **per-unit** | one axis per unit, plus one shared **enum-lanes** axis | one scale per axis, the union of that unit's data; all enum series collect onto a single stacked-lane axis |
| **individual** | one axis per series | each axis auto-scaled to its one series |

**An axis draws one scale.** Every series on an axis is normalised by
the same range — the union of what each visible series holds — so the
range the axis labels is the range each series was drawn against. A
series scaled privately under a shared axis is drawn at an amplitude
the axis never states, and nothing on screen contradicts it: a -200..0 A
current overlaid with a -1.5..0 companion filled the canvas while the
gutter read -1.5..0. Separating series that are not comparable is what
the y-axis **mode** is for — `per-unit` gives each unit its own axis,
`individual` gives each series one — not a second scale hidden under a
single axis.

**The visible y-scale labels are always a real signal's engineering
values — never a 0–1 ratio.** Each axis labels its ticks through one
signal's unit and value range: the parent area's **primary signal**
(the user picks it by clicking a series) when that signal is on the
axis, otherwise the axis's own first ranged signal. In per-unit mode
each axis is a different unit, so the primary is on at most one of them
and every other axis labels through its own first signal — a volts /
amps / percent stack reads V, A, % rather than all `0.0–1.0`. Where
several units are overlaid on one axis (unified mode) only the chosen
signal's unit is named, but the *numbers* are true of every series
drawn there, since they all share the axis's scale. This is the rule
that fixes the bug where the y axis sometimes showed `0.0–1.0` instead
of the selected signal's units. (The blank-gutter enum-lanes axis is
exempt — its tiles carry the labels; see below.)

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
the actual value. **Its y gutter carries the raw codes and not their
names.** The ribbon already names the value where the reader is
looking, so a second copy of every name running down the gutter buys
nothing and costs it the width of the table's longest entry. The codes
stay, because they are the only positions on that axis that mean
anything and they are what gives the reader a sense of scale — but the
value table decides which positions may carry a tick, never how many
do: the axis thins them to its own tick density, so a several-hundred-
entry table draws the ticks that fit rather than one per entry. Under
**unified** mode an enum plots as a plain
numeric line with no labels (a text box per overlaid enum would be
noise). "Lane" is an axis *render style*, not a new structural level.

**Where the plot extrapolates, it says so — it does not stop
drawing.** A plot draws in places its data does not reach: a series is
sample-and-held to the last column its *axis* has, which a faster
neighbour puts well past its own newest sample; a stall between two
samples is drawn as a line straight through it; and a one-sample series
is drawn as a horizontal line across the whole window (below). All of
that is worth drawing — a held state is the best answer there is about
what a signal was last doing — but none of it is a reading, and drawn
identically to the readings it is a claim the data does not support.
So the extrapolated stretches keep their pixels and are **rendered
differently**: a line is dashed, a lane tile is hatched. Nothing is
cut. The alternative — drawing only where there are samples — throws
away the answer to the question the view is usually being asked ("what
is it now?"), and the alternative of leaving it as it was makes the
plot quietly assert things it does not know.

**What counts as extrapolated is a model fact, computed host-side.**
Two rules decide it: a stretch **not bounded by a sample on each side**
(before a series' first, after its last, and both wings of a
one-sample series), and a **gap longer than ten times the series'
typical raw sample interval** — a stale interior stretch is
extrapolation too. The second cannot be evaluated in the frontend,
which sees only what the serve sent: at a coarse zoom those points sit
a decimation bucket apart, so measuring their spacing against a raw
cadence would paint every zoomed-out window as extrapolation, and
measuring it against *their own* spacing would hide every real stall.
The host has the raw series, so it answers both from there — including
confirming each candidate gap against level 0 — and ships the
stretches with the window they describe. The renderer styles them and
re-derives nothing.

The styling itself: a line's extrapolated stretch is **dashed [6, 4]**
in the series' own color and width — same line, drawn without data. A
lane tile keeps its normal fill and takes **45° stripes in the app
background color, 20 px horizontal period at exactly 50 % duty**;
because a 45° stroke's horizontal footprint is `lineWidth·√2`, even
bands need `lineWidth = period / (2·√2)` and the naive `period / 2`
paints ~71 % of each period. A tile only partly stale stripes only the
stale part. A label over stripes gets a halo, stacked passes toward
opacity, as many as the theme asks for — a light theme drawn without a
box would want about twice a dark one, its stripes carrying far more
contrast and swallowing a single pass — except where the theme draws a
solid label box, which is already an opaque plate between the glyphs
and the stripes and does the halo's job. Such a theme asks for **no**
passes: its count is 0, so the count and the box agree instead of the
box quietly overriding a number.

**A name is cut in the middle; a `VAL_` label is cut at the end.** DBC
symbols share prefixes by construction, so end-truncation on a signal
or message name reliably hides the part that tells two apart — every
name-bearing surface therefore renders through `NameText`, which splits
a name past the classic 32-character identifier limit into a
shrinkable head and a kept tail and carries the whole of it as a
tooltip. Enum labels are prose, read left to right, with their
distinguishing word at the front, so they keep ordinary end-ellipsis
and a tooltip — on the canvas as much as in the DOM, which is what
`fitTileLabel` does for a lane tile. A name's rendered width comes from
the column model and never from the name.

**A tile label is drawn on a box whose opacity the theme carries.** The
box is filled in the canvas chip color — effectively the canvas color,
the same backing the cursor and Δ chips take — with the chips' own
geometry: the measured text plus its 4 px padding, 13 px tall (never
taller than the lane band), centred on the label. How solid it is is a
per-theme number, 0 for no box and 1 for a plate. A composite at alpha
0 leaves the canvas as it was, so this is one draw path on every theme
rather than a branch on which themes count as light, and a theme whose
labels already read against the tile is left pixel-identical.

**A tile label's ink is measured, not assumed.** The label used to be
drawn in the tile's accent — the colormap tint, or the series color
where no colormap claims the value — and the tile's fill is a *tint of
that same accent*. On a dark theme the two separate, because the accent
is light and the fill darkens it; on a light theme they collapse, and
the label is drawn a hair off the plate it sits on. So the ink is
chosen per tile by WCAG contrast against the ground that is actually
under the label — the tile's fill composited over the app background,
and then the label box composited over that: the accent wherever it
clears **3:1**, and otherwise the extreme (black or white) **opposite
the theme's background**. A box therefore does not just make the label
legible, it decides what "legible" measures against: on a near-white
plate the stronger tints keep their own color and only the pale ones
fall back.

Three things about that rule are deliberate. The threshold is 3 rather
than 4.5 because a tile label is a short word on a colored plate
(WCAG 1.4.11's non-text tier, and the large-text tier, both sit at 3),
and because 3 is the value that separates the two themes as measured —
the weakest dark-theme tile reads its accent at 3.23:1 and the
strongest light-theme one at 1.80:1 — so it replaces every collapsed
label without disturbing a theme that already reads well. The
replacement follows the theme's polarity rather than whichever extreme
measures highest, because on these grounds the two land within 5 % of
each other and the winner alternates by tint, which would put one
theme's lanes in two different inks on a margin that means nothing. And
the **border** stays the accent whatever the label does: it is read
against the plot background outside the tile, where the accent has all
the contrast it needs, and it is what carries the signal's identity
once the label has stopped.

The halo pairs with the ink rather than being fixed: the app background
wherever the background reads against the ink — which is the striping
color, and is what every case on all three shipping themes takes — and
the opposing extreme where the ink itself landed on the background's
side, since a near-white halo around a white glyph is no halo at all.
It is only *spent* on a theme with no solid box; the box supersedes it
where there is one.

**An enum lane draws its own sample markers.** uPlot's point layer
cannot serve a lane: its `auto` rule reads the density of the *axis*,
and a shared enum-lanes axis carries every enum's samples at once, so
one fast lane suppresses the markers of every slow one — and whatever
survives that is painted over by the tiles, which are 65–75 % opaque
and sit in front of the line by design. A lane needs its markers more
than a line does, not less: a line's shape shows where it was measured,
while a lane's tiles show only its transitions, so without markers
nothing on screen separates a state held through a thousand samples
from one held through none. So a tile axis turns the point layer off
and marks its own served samples, over the tiles, capped at the same
flat marker budget.

**A marker sits only on a sample.** The merged x grid is the union of
every series on the axis and the sample-and-hold gives every series a
value at every column of it, so a marker selected from the grid marks a
series wherever its *neighbours* were read — most densely exactly where
it has least data: across a stopped series' held tail, across the
interior of a stall, and along the whole window a one-sample hline is
drawn over. Both marker renderers — uPlot's point layer for a line, the
lane's own pass for a tile axis — therefore select from the columns
whose x is one of that series' own raw timestamps, and from nothing
else. Neither consults the extrapolated spans, and neither needs to: a
stretch has no sample in it by construction, while the readings that
bound one (a stall's two ends, the last frame before a series stopped)
keep their markers, which is what makes the dashed stretch beside them
legible.

**A hover reveals markers on every area of the panel, lanes included.**
The pointer rests in one plot area, but what it is pointing at is a
moment on the shared timeline, which every stacked area is showing. So
hover markers follow the crosshair's rule rather than the pointer's: one
panel-level hover x, folded from whichever area reported it, and every
area marks the sample nearest it — the area the pointer is in, the ones
above and below it, and the enum-lanes axis alike. uPlot's own per-series
hover point is off: it is a property of the instance whose pointer moved,
so it can never appear in the areas the pointer is not in, and it snaps
to the nearest **merged** column, which is a neighbour's reading as often
as it is this series'. The rule above binds here too — the candidates are
the series' own sample columns, so a hover changes *when* a marker is
drawn and never *where*. A series that has stopped therefore keeps its
marker on its last reading while the pointer moves on past it, which is
the honest picture: the stretch between the two is already drawn as
extrapolation.

The show-points modes compose with this the way they do with everything
else. `off` is off, hover or not. `auto` and `on` both reveal, because
what a hover adds is one marker per series, and neither uPlot's density
rule nor the minimum-sample-count floor has an opinion about a single
column under the pointer — those two govern the *static* markers, which
is where the modes differ. A lane's static markers are drawn under both
modes already (it has no density rule of its own, per the paragraph
above), so what the hover adds to a lane is what it adds to a line: the
pointer's own sample, told apart from the rest.

**Vertical space is fit-to-panel, with draggable splitters.** The
derived axes of a panel always fit its height — no stack-scrolling
once N axes exceed it. Each axis carries a **weight** (flex-grow,
default 1, persisted per derived-axis id); a draggable separator
between two adjacent axes trades weight between that pair (conserving
their sum, clamped to a usable minimum), and double-clicking it
equalizes them. A y-axis-mode change produces new axis ids and so
resets an area's custom weights; the shared enum-lanes axis keeps a
membership-stable id so lane churn doesn't reset its weight.

**An area can be collapsed, and a collapsed area gives up its space —
all of it.** A plot area carries a persisted `collapsed` flag, and a
collapsed area renders as **one heading row**: its name, a
signal-count chip, and its pattern match count when a rule feeds it
(ADR 0020). Nothing else — no canvas, no rows, no per-area chrome, and
the derived axes after the first are not rendered at all, so one
collapsed area is one row however many axes its mode stacks.
Collapsing reclaims the space it took; expanding restores the prior
layout exactly, because the per-axis weights and ranges are keyed by
axis id and a collapse round-trip never writes them. The flag is per
*area*, not per axis, because an area is the curated thing and its axes
are derived: one collapse state, however many axes the mode stacks. An
area whose signals are **all hidden** is collapsed regardless of the
flag — there is nothing to draw on it — which is the rule that already
collapses a fully-hidden axis; that collapse alone *keeps* its
side-panel rows, because a swatch in one of them is the only way to
un-hide a signal, and reducing it to a heading would strand it.

**An axis can be collapsed on its own, and that is layout, not
visibility.** Every axis that has a label of its own — a per-unit unit
group, an individual mode series' lane — carries the same disclosure on
that label. (In unified mode the area *is* the axis, so the area's
toggle is the only one.) A collapsed axis renders as its **label
strip**: no canvas, no rows. Its weight share redistributes to the axes
still drawing, so the stack still fits the panel, and the splitter it
would have traded weight through is suppressed — there is nothing to
trade — with the neighbours pairing across it. Its series stay on the
axis with their `hidden` flags untouched and their membership unchanged:
collapsing an axis is not hiding its signals, and the two must not be
confused because clearing the collapse has to give the axis back exactly
as it was. Collapsed state is persisted per derived-axis id, beside the
axis weights and on the same lifecycle — both describe the layout the
user is looking at, so a y-axis-mode change retires them together.
Collapsing *every* axis of an area is allowed and wedges nothing: each
strip keeps its own toggle, and it is the same shape the all-hidden rule
already reaches.

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
level: an axis is one scale, so a pinned bound applies to every series
drawn on it and there is no question of which series it means.
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
- **Per-unit-group auto-scaling in unified mode.** *Adopted 2026-06-09,
  reversed on amendment 2026-08-21.* Scaling each unit group to fill
  the canvas keeps an overlaid chart of volts and amps readable, where
  one shared min/max flattens whichever has the smaller range. The
  price turned out to be too high: only one group can be labelled, so
  every other group is drawn at an amplitude the axis does not state,
  with nothing on screen to say so. A flat line is honest; a trace two
  orders of magnitude off its own data is not. The modes that separate
  incomparable series (per-unit, individual) cover the case this
  bought.
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
  `on` is capped at a flat maximum of drawn markers across the visible
  range, and `auto` carries a **minimum-sample-count floor**: uPlot's
  automatic rule reads the density of the *axis* — the merged x columns
  every series on it shares — so a series holding a handful of samples
  of its own loses its markers as soon as it is plotted beside a fast
  one. Below the floor the samples are the information, so they stay
  marked; above it uPlot's own answer stands. Both constants live in
  `plotPoints.ts`.
- **A one-sample series draws as a horizontal line** through its value,
  held across the window rather than starting at its own timestamp.
  One point is not a line — there is nothing to draw between a sample
  and itself — and a series whose entire content is one value has no
  shape that the usual pre-first-sample gap could be protecting. The
  *leading* gap rule is unchanged: a series with two or more samples
  still begins where its first one does, and a dash is not drawn there
  either — a stretch nothing is currently drawn across is not made
  honest by adding ink to it. The one-sample series is the deliberate
  exception, and it is an exception in both directions: it is held
  across every column its axis has, including columns other series
  contributed after — and before — its only sample, so **both** its
  wings are drawn, and both are dashed.

  The **trailing** half of that sentence used to read "and is never
  drawn past its data", which the sample-and-hold has never obeyed: a
  merged row carries its last value forward to the end, so every series
  is drawn to the last column its axis has. That overdraw is real and
  worth keeping — see the extrapolation rule above — so what is written
  down is now what the code does: a series *is* drawn past its data,
  and the stretch where it is says so.
- **Y-axis-mode selector** (`unified` / `per-unit` / `individual`)
  sits in each plot area's signal-panel head. Switching modes
  re-stacks the area's canvases. The per-axis derivation is the pure
  `deriveAxesForArea()` helper (covered by unit tests).
- **One y scale per axis.** Every series on an axis shares one scale —
  the union of their observed ranges, computed by the pure
  `axisAutoRange()` helper in `plotData`. *Amended 2026-08-21:* this
  was per unit *group* within an axis, with unitless series each
  keeping a private scale on the grounds that two signals which merely
  both lack a DBC unit are not known to be commensurable. Both splits
  put more than one scale under one set of tick labels, and a series on
  the unlabelled scale was drawn at an amplitude nothing on screen
  stated — the unitless split did so even on a `per-unit` axis, which
  the mode's own definition says is one scale. Three refinements on the
  decision table:
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
  - **A constant series still joins the union.** A signal that never
    moves has a degenerate extent (`hi === lo`) and so cannot be
    normalised on its own; it contributes its one value to the axis's
    union all the same, and is drawn on the axis's scale — a constant
    3000 A limit sits at the top of a 400–3000 A axis rather than at
    the canvas midline beside a 500 A signal filling the canvas.
  - **An axis with no span at all gets a minimum range.** When every
    series is constant at the same value the union has no span, so
    there is nothing to normalise by and no measurement to draw. The
    axis is widened to **±10 % of that value**, centred on it — the
    trace still sits mid-canvas, but the axis labels read the value it
    holds instead of a bare 0–1 that says nothing. At exactly zero the
    proportional band collapses, so the fallback there is an absolute
    **±1**: there is no magnitude to take a fraction of, and ±1 keeps
    the axis in the signal's own units rather than inventing one. A
    constant has no span, so any scale for it is a *choice*, not a
    measurement — this records which choice. The widening happens in
    `axisAutoRange`, on the axis union rather than per signal, so a
    constant sharing an axis with a moving signal still takes the plain
    union above. The midline fallback in the renderer now covers
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
- **Everything the panel says about *when* rides the bottom drawing
  axis** — the x-axis time label, the A/B cursors' letter + time, and
  the cursor delta chip. The cursors are panel-level, so their *lines*
  cross every stacked area; that is what lines a reading in one area up
  with a reading in another. Their timestamps are not repeated down the
  stack: one x is one time however many areas it crosses, and saying it
  once per area is the same number written N times over the data.
  "Bottom drawing axis", not "last axis": a collapsed area is a heading
  row with no canvas, so the chrome falls back up the stack to the
  lowest axis that still has a plot (`bottomDrawingAxis`), and the
  marker labels fall the same way down to `topDrawingAxis`. Tick
  spacing is label-width-aware so zoomed-in elapsed-time labels (more
  fractional digits) don't overlap.
- **Enum-lanes axis.** Per-unit mode collects an area's enums onto one
  shared axis (`deriveAxesForArea` kind `enum-lanes`), fed by a
  panel-level `list_value_tables` fetch (`useValueTables`) reduced to
  the enum-key set. `PlotArea` normalizes each enum into its lane band
  (`plotEnumLanes` helpers: `laneBands` / `laneValueRange` /
  `normalizeIntoLane` / `laneTileBand`), leaves its y gutter blank (but
  still reserved — see "one y gutter for the whole stack"), draws
  stepped series, and paints per-lane tiles via the shared
  `drawEnumTiles(band)` helper. The single-enum axis reuses the same
  helper with one full-height centered band, and draws its own ticks on
  the table's raw codes thinned to uPlot's chosen increment
  (`plotAxisScale.ts::enumTickSplits`), sizing its gutter from the
  numbers it actually draws. Pure `enumSegments()`
  walks the (t, v) arrays; a segment narrower than its label draws as
  much of the label as fits, cut at the end and marked with an ellipsis
  (`fitTileLabel`), and only a segment too narrow for even one
  character plus the mark draws the colored tile without text — and
  without a box, since a plate with no text on it is just a hole in the
  tile's color. Tile labels centre
  on the midpoint of
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
- **Area and axis collapse ride that same path.**
  `PlotAreaConfig.collapsed` and the panel's `axisCollapsed` map (keyed
  by derived-axis id, sparse, pruned to the live axis set like the
  weights) are both folded into the per-axis collapsed flag the panel
  derives — an axis is collapsed when its parent area's flag is set, its
  own entry is set, *or* every signal on it is hidden — so both inherit
  the whole treatment above: flex-grow 0, no canvas, splitter
  suppression and reach-over, and the gesture-replaying placeholder.
  Only the all-hidden case keeps the compact rows; the two deliberate
  collapses render the side panel's head and stop (`heading-only`).
  The area's **▾ / ▸ toggle** sits on the parent head beside the reorder
  grip (one per logical area, like the remove ×), and is inert on an
  area collapsed only by the all-hidden rule: there is no expanded form
  to go to, and its rows are already listed for un-hiding. The axis's
  own toggle sits with the axis's own label, and only exists where that
  label does. A contiguous run of collapsed axes carries **one
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
  one scale, and render style). Today's single-axis path becomes the
  unified case.
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
