# ADR 0019 — Every project element carries a model-owned `name`; views resolve it through a shared resolver

Status: accepted (2026-05-26)

The `Cmd/Ctrl+P` go-to-view palette lists open dockview panels by
their display name. Before this ADR each view fabricated a label
independently — the dockview tab showed `Trace 1` (from a monotonic
counter in a React ref, not persisted), the project graph showed
`Trace a3f2b1` (`${capitalise(el.kind)} ${shortId(el.id)}`), and
the project panel showed a bare `Trace` (`PANEL_TITLE[el.kind]`).
Three different labels for the same element, none editable. A
go-to-view palette built on top of that is broken on day one. This
ADR fixes the convention.

## Decision

**Every `ProjectElement` kind carries a model-owned `name: string`
field.** `bus` and `filter` already did; the rest (`trace`, `plot`,
`transmit`) gain it. The default on creation is
`${Kind} ${nextIndex}` (matching the old dockview tab behaviour,
but stored in the project model rather than a React ref). The field
is additive inside the `elements` records the host round-trips
without interpretation, so `PROJECT_SCHEMA_VERSION` does **not**
bump (ADR 0011 rejects mismatched versions rather than migrating —
a bump would needlessly retire every existing file); elements
loaded without a `name` get the default on project open.

**One shared resolver, used by every view.** A pure function
`elementLabel(el: ProjectElement): string` returns the display
label. It is called by the dockview title bar, the project graph
node, the project panel inventory list, the `Cmd/Ctrl+P` go-to-view
palette, and every future view that names an element. Per-view
relabelling is forbidden — if the resolver's output is wrong for a
view, the resolver gets fixed once.

**One edit surface.** Inline-rename in the project panel — which
already exists for buses — extends to every element kind. Other
views may add inline-rename affordances later, but the project
panel is the canonical edit surface.

## Why

**Three names for one thing are user-hostile.** A user trying to
remember which trace panel they want sees `Trace 1` in the tab,
`Trace a3f2b1` in the graph, and a bare `Trace` in the project
panel. Pressing `Cmd/Ctrl+P` and seeing one more flavour of the
name makes the experience worse, not better.

**Model-owned because per-view counters drift.** Today's `Trace
1` / `Trace 2` are produced by a React ref that resets on full
reload, so reopening a project re-orders the same panels'
numbers. Storing the name in the project model makes it stable.

**One resolver because per-view label code rots in parallel.** A
view added later should not need to invent its own naming. The
resolver is one line per view.

**Default on creation, editable everywhere through one path.**
A name appears immediately (no "untitled" state) and the user can
override it when the default isn't what they want. Forcing the
user to name elements on creation would slow the common case.

## Rejected alternatives

- **Leave the per-view counters; ship go-to-view on the dockview
  tab label only.** Solves the palette in isolation; leaves the
  three-labels-for-one-thing problem intact everywhere else.
- **Compute the name in each view from a shared id prefix
  (`shortId(el.id)`).** Stable but unreadable; the user has no
  way to rename and ends up navigating by hex strings.
- **Per-view editable overrides.** Lets a user set "the project
  panel says X but the graph says Y for this same element".
  Already what we have, by accident. Multiplying labels per
  element multiplies UX confusion.
- **Persist names in the dockview `params`** (panel-local).
  Names disappear if the panel is closed and reopened from the
  project. The project file is the right home — the element
  outlives any single panel instance.

## Consequences

- Every element kind gains a `name` field inside the project file's
  (host-opaque) `elements` records; the schema version is unchanged
  and elements without one are defaulted on open.
- The React ref panel counters (`panelCounterRef` in `App.tsx`)
  are retired; dockview tab titles call `elementLabel(el)`.
- The project graph's per-kind label formatter
  (`projectGraph.ts`) and the project panel's `PANEL_TITLE` map
  (`ProjectPanel.tsx`) call `elementLabel(el)`.
- A new element kind added later must declare a default-name
  scheme on creation and is otherwise free — the resolver and
  the rename UI work without per-kind code.
