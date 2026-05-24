# ADR 0012 — Project panel is the inventory surface; project graph is the wiring surface

Status: accepted (2026-05-23)

## Decision

The project has two GUI surfaces with distinct roles:

- **Project panel**
  ([`apps/gui/src/ProjectPanel.tsx`](../../apps/gui/src/ProjectPanel.tsx))
  — the *inventory* surface. Optimised for "what's in this project"
  and "open the file actions I need."
- **Project graph**
  ([`apps/gui/src/ProjectGraphPanel.tsx`](../../apps/gui/src/ProjectGraphPanel.tsx))
  — the *spatial* surface. Optimised for "show me what feeds what."

Both are views over the same `Project`
([`apps/gui/src/types.ts`](../../apps/gui/src/types.ts), host
[`apps/gui/src-tauri/src/project.rs`](../../apps/gui/src-tauri/src/project.rs)
— see [ADR 0011](0011-project-file-format.md)) routed through
`ProjectContext` (file-IO actions, top-level bus / connection state,
DBC list + per-bus scoping) and `ElementRegistryContext` (the element
list — `trace` / `plot` / `transmit` / `filter` — and the `source`
wiring between filters and consumers). Changes from either surface go
through the same callbacks, so the two stay in sync without an
explicit sync step.

### Project panel owns

- New / Open / Save / Save As.
- BLF / remote-server connection state + Connect / Disconnect.
- DBC list — add, remove, reload-all, per-DBC bus-scoping checkboxes.
- Logical-bus list — add, rename, remove; speed / FD hints inline.
- Interface-binding list — server + interface → bus dropdown.
- Element list with Open / Focus / Remove.

### Project graph owns

- Adding a filter element (toolbar button in the panel header).
- Drag-connecting a filter / bus output onto a consumer's `source`
  input.
- Drag-connecting a filter's output onto another filter's input.
- Removing a node (which removes the underlying element / clears the
  wiring).
- Viewport pan / zoom + per-node positions, persisted in the panel's
  dockview `params` (these are presentation, not part of the project
  schema).

### Explicit no-s

- Project panel does *not* own visual wiring between filters, buses,
  and consumers — that happens in the graph view.
- Project graph does *not* own adding a trace / plot / transmit
  panel — those are added through the main toolbar; the graph just
  shows them once they exist. It also does not own DBC scoping,
  which stays a per-DBC affordance on the project panel because a
  DBC isn't a graph node (it's a decode lens applied per consumer).

## Why

The list-oriented panel is the right shape for "give me an overview
and the basic file / connection actions." Graph nodes are heavier to
inspect when all you want is "which DBCs are loaded."

The graph is the right shape for the wiring story (filter A feeds
trace B; bus C is consumed by D and E). That story is hard to read
out of a flat list, and the graph view encodes it as one glance.

Splitting concerns this way also means we can iterate on either
surface — adding a triggers panel, say — without rewriting the
other.

## Consequences

- New affordances land on the surface whose role they match. A
  "what's in the project" question grows the project panel; a "what
  feeds what" affordance grows the graph. If a new affordance
  doesn't fit either ("clearly file-IO" vs "clearly wiring"), the
  ambiguity is a signal to redesign the affordance, not to
  duplicate it.
- `plans/project-panel-design.md` (the Phase-6 source for this ADR)
  dissolves; this ADR replaces it.
