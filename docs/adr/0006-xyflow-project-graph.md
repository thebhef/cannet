# ADR 0006 — Project graph uses `@xyflow/react`

Status: accepted (2026-05-24)

## Decision

The project graph view uses **`@xyflow/react`** (formerly
`react-flow`, MIT) for the node-and-edge canvas: bus, DBC, filter,
trace, plot, and transmit nodes, with drag-to-create wiring edges
between them.

The logical wiring model — `buses`, `interface_bindings`, and
`elements` with `filter` / `trace` / `plot` / `transmit` kinds — is
the source of truth in the project schema
([ADR 0011](0011-project-file-format.md)). The graph view stores
only viewport position and per-node positions in its dockview
panel params; it owns no model state. The library boundary is one
panel.

## Why

**Graph interaction is failure-mode-rich UI worth leaning on a
vetted library for.** Drag-to-create edges, custom node renderers,
controllable state, hit-testing, pan/zoom semantics, and a
serialisable layout all compound badly when hand-rolled — exactly
the shape the project leans on libraries for.

**React-first, TypeScript-typed.** Nodes are plain React
components; the controllable state pattern flows through hooks
without a glue layer.

**Thin library boundary.** The view stores only viewport + per-node
positions; everything else is host-owned model state read through
Tauri commands. Swapping xyflow out is replacing one panel
component, not untangling state.

## Consequences

- **Library cost.** xyflow is ≈100 KB JS gzipped plus a small CSS
  bundle. Acceptable for a desktop app.
- **Viewport state rides the project file via ADR 0011.** The
  graph view's dockview params (viewport + per-node positions) sit
  inside the verbatim-layout blob the project file carries; no
  parallel schema in the host.

## Rejected alternatives

- **`cytoscape.js`** (MIT) + React wrapper — graph-algorithms-first
  rather than editing-first; the React integration is glue rather
  than a first-class binding.
- **`d3-force`** / **`d3-zoom`** (ISC) + SVG hand-roll — viable
  for very small graphs, but rebuilds the editing affordances
  xyflow already provides once the project grows past a handful of
  buses / DBCs / filters / consumers.
- **`reaflow`** / **`reagraph`** / **`nivo/network`** — smaller
  bus factor than xyflow and missing the editing affordances
  (drag-to-create-edge, custom node renderers) the project graph
  requires.
