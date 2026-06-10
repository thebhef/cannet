# ADR 0020 — Filter-defined plot areas: regex-owned content, mode-exclusive with manual, re-evaluated on DBC change

Status: accepted (2026-05-26)

Phase 12 ([`../../plans/phased-implementation.md`](../../plans/phased-implementation.md))
introduces a way to define a plot area's contents by regex over
signal names rather than by adding signals one at a time. The
backlog phrasing was a "dict of `plot area`: `filter string`"; this
ADR records the shape that landed.

## Decision

**A plot area is either filter-mode or manual-mode, never both.**
The area gains an optional `signalFilter: string` field on its
persisted state. When present, the area is *filter-mode*: its
`signals` list is **computed** from every signal whose
`${busName}.${messageName}.${signalName}` matches the regex,
drawn from the panel's existing `sources`-scoped DBC set. When
absent, the area is *manual-mode*: the user picks signals
individually as today. Toggling the mode off clears
`signalFilter` and promotes the most-recently-computed list to
the persisted manual `signals`; toggling on discards manual
selections (with a confirm).

**The regex target includes the bus name.** The matched string is
`${busName}.${messageName}.${signalName}`. Unbound frames render
as `(unassigned)` in the prefix. The plot panel's `sources` filter
still gates the candidate set (e.g. a panel scoped to one bus
never sees signals from another bus, regardless of regex). Most
panels are connected to every bus by default, so the prefix is
the user's primary way to scope to one.

**Re-evaluation triggers.** The regex is re-evaluated whenever a
DBC is added, removed, or reloaded; whenever the panel's
`sources` selection changes; and on app launch (so a project
saved with a filter rehydrates its series). The host emits a
`dbc-changed` event the plot panel listens to; the host computes
the matching signal set and the plot panel renders it.

**Bus rename invalidates regexes that referenced the old name.**
A rename that drops the match count of any plot panel's
`signalFilter` to zero (when it wasn't zero before) surfaces a
warn-level System Messages entry naming the panel and the broken
regex. The user re-edits the regex; we don't try to rewrite it
for them.

## Why

**Mode-exclusive because two-source areas drift.** A "manual list
+ filter overlay" model would let the user add a signal manually,
then change the regex, and see ghost duplicates or unexpected
removals as the two sources fight. Single source per area means
the area's contents are always explicable from one piece of
state.

**Bus name in the target because users typically open one panel
per bus context, not per message.** Without the bus prefix, a
regex like `^.*Speed$` matches `Speed` signals across every bus
the panel can see — usually wrong. With it, `^chassis\..*Speed$`
is the intuitive scope.

**Re-evaluate on DBC change because the user expects "set it and
forget it".** The whole point of filter-defined areas is that
adding a new DBC populates the area with matching signals without
manual re-add. A static one-shot evaluator wouldn't deliver that.

**App-launch re-evaluation because filters are persisted, signal
sets are not.** The project file stores the regex; the matching
signal set is derived. Loading a project resolves the derivation
fresh against whatever DBCs are loaded at that moment.

**Bus renames invalidate, don't auto-migrate, because rewriting a
regex is unsafe.** A regex like `^(chassis|bms)\..*` after
renaming `chassis` → `vehicle` isn't unambiguously rewritable.
We warn and let the user fix it.

## Rejected alternatives

- **(a) Filter overlay on top of manual list.** A
  `signalFilter` field adds matching signals to the area's
  manually-managed list. Two sources, two truths; the user
  has no clean way to "undo what the filter added without
  removing my manual ones".
- **(b) Generator at panel creation time, then plain areas.**
  A wizard at panel-add lets the user enter a `{areaName →
  regex}` dict; areas are created from it once and behave as
  plain manual areas afterwards. Simpler, but loses the "filter
  *defines* the area" semantics. A new DBC loaded later doesn't
  update existing areas.
- **Different regex target — message name only, or signal name
  only.** Strictly less expressive. Plot panels typically span
  buses; the bus prefix is what makes "filter to one bus's CRC
  signals" easy.
- **Auto-migrate bus renames by rewriting the regex.**
  Ambiguous for any non-trivial regex; the alternative — alias
  the old bus name to the new one in the matcher — leaks bus
  rename history into the matcher's contract.

## Consequences

- `PlotPanel`'s `PlotArea` config gains an optional
  `signalFilter: string` field; project schema version
  increments additively.
- The host gains an event the plot panel subscribes to:
  `dbc-changed`. On every fire, every plot area in filter mode
  recomputes its computed `signals` set.
- The plot panel's "add signal" affordance disables in filter
  mode; the area shows the regex and a result count instead of
  the signal list editor.
- Future surfaces that compose signal collections (the signal
  view in Phase 19, math channels in Phase 23) face the same
  filter-vs-manual choice; consistency with this ADR is
  preferred unless their UX forces a different shape.
