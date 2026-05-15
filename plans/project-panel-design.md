# Project Panel + Project Graph: surface roles

Phase 6 adds a second view onto the project (the graph view) alongside
the existing list-oriented project panel. This note records what each
surface owns so that future work knows where to land an affordance.

## Shared model

Both surfaces are views over the same `Project` (`apps/gui/src/types.ts`,
host `apps/gui/src-tauri/src/project.rs`) routed through:

- `ProjectContext` — file-IO actions, top-level bus / connection state,
  DBC list + per-bus scoping.
- `ElementRegistryContext` — the element list (`trace` / `plot` /
  `transmit` / `filter`) and the `source` wiring between filters and
  consumers.

Changes from either surface go through the same callbacks, so the
two stay in sync without an explicit sync step.

## Project panel (`ProjectPanel.tsx`)

The inventory surface. Optimised for "what's in this project" and
"open the file actions I need".

**Stays**:
- New / Open / Save / Save As.
- BLF / remote-server connection state + Connect / Disconnect.
- DBC list (add, remove, reload-all, per-DBC bus scoping checkboxes).
- Logical-bus list (add, rename, remove; speed/FD hints inline).
- Interface-binding list (server + interface → bus dropdown).
- Element list with Open / Focus / Remove.

**Does not own**:
- Visual wiring between filters, buses, and consumers. That happens in
  the graph view.

## Project graph (`ProjectGraphPanel.tsx`)

The spatial surface. Optimised for "show me what feeds what".

**Owns**:
- Adding a filter element (toolbar button in the panel header).
- Drag-connecting a filter / bus output onto a consumer's `source`
  input.
- Drag-connecting a filter's output onto another filter's input.
- Removing a node (which removes the underlying element / clears the
  wiring).
- Viewport pan / zoom and per-node positions (persisted in the panel's
  dockview `params` — these are presentation, not part of the project
  schema).

**Does not own**:
- Adding a trace / plot / transmit panel. Those are added through the
  main toolbar; the graph just shows them once they exist.
- DBC scoping. That stays a per-DBC affordance on the project panel
  because a DBC isn't a graph node — it's a decode lens applied per
  consumer.

## Rationale

- The list-oriented panel is the right shape for "give me an overview
  and the basic file/connection actions". Graph nodes are heavier to
  inspect when all you want is "which DBCs are loaded".
- The graph is the right shape for the wiring story (filter A feeds
  trace B; bus C is consumed by D and E). That story is hard to read
  out of a flat list and the graph view encodes it as one glance.
- Splitting concerns this way also means we can iterate on either
  surface — adding a triggers panel, say — without rewriting the
  other.
