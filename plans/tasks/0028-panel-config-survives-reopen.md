# Task 28 — Panel Config Survives Close + Reopen

A view's configuration is lost when its panel is closed and reopened
within a running session. Close a configured **plot** panel (signals
picked, areas laid out, cursors placed) via the dockview tab's ✕, reopen
it from the Project panel's Elements list → it comes back **empty**.
Reopening a saved *project* restores it fine.

## Root cause

Plot and trace panels store their configuration only in the **dockview
panel `params`**, not on the model element. The `ProjectElement` for a
plot/trace carries only `{ kind, id, name, sources }`
(`apps/gui/src/types.ts`); the signal `areas`, cursors, measurement
selection, column layout, mode, etc. live in `params`, mirrored there by
`api.updateParameters` (`PlotPanel.tsx`, `TracePanel.tsx`).

The two persistence paths diverge:

- **Project save/restore works** because the project file serializes the
  whole dockview layout (`api.toJSON()`, including each panel's params);
  restore replays it.
- **In-session close + reopen loses config** because the ✕ disposes the
  panel *and its params*, and `ProjectPanel.openElement` then fabricates
  fresh params `{ elementId }` with no config — the panel reads
  `areasFromParams(undefined)` → one empty area.

Closing a panel does **not** remove the element from the registry (only
the explicit "Remove element" action does), so the element is still
listed and reopenable — just stripped of its config.

This is GUI-architecture drift (CLAUDE.md "thin views over a paged
model": domain config belongs in the model, not the view): the plot's
signal selection is deliberate model state, equivalent to `sources`, yet
it lives in view-local panel params.

## Design

Persist each view-backed element's config **on the model element**, as
an opaque `config` blob, and keep mirroring it into the dockview params.

- **Opaque blob, not typed fields.** Add a single
  `config?: PanelViewConfig` (`Record<string, unknown>`) to the `trace`
  and `plot` element variants. The panel keeps its existing tolerant
  param-parsers; only the *source object* it parses changes. The host
  round-trips `elements` opaquely, so this is additive — no schema bump.
- **Read order.** A panel hydrates from `element.config ?? params ??
  defaults`. The element wins (survives reopen); `params` is the
  fallback for older projects and for the unsaved-workspace restore.
- **Dual-write, deliberately.** The persist effect writes the blob to
  *both* the element (via `registry.update`) and the dockview params
  (via `api.updateParameters`). The element covers in-session reopen and
  project save; the params copy is still required because the
  **unsaved-workspace `localStorage` layout** (`onDidLayoutChange` →
  `toJSON`) is the only thing that restores panels across an app restart
  with no project open, and it does not persist the registry.
- **No spurious dirty / render churn.** `applyElementPatch`'s no-op
  check must compare the `config` object by *content* (deep), since the
  effect rebuilds a fresh blob each run. Without it, mounting a panel
  whose state already equals the stored config would allocate a new
  registry array → mark the project dirty on open and re-fire registry
  consumers. Extend `patchIsNoOp` with a recursive value-equality
  helper (same rationale already documented for the array fields and the
  transmit sinks-sync loop).
- **Scope: element-backed views only** — plot and trace. ColorMap
  already stores its config on the element; transmit/rbs keep only
  `elementId` in params (their config lives in host-side stores). The
  singleton panels (Dbc, System Messages, Project Graph) lose view state
  on close+reopen too, but have no element to hang config on — out of
  scope here (would need a separate panel-id-keyed store); note in the
  backlog if it bites.

## Exit criteria

- Closing a configured plot panel and reopening it from the Elements
  list restores its areas / signals / cursors within the same session.
  Driven by a failing test: an element carrying `config` mounts a panel
  whose `params` lack the config, and the configured signals render.
- The trace panel restores mode / columns / auto-scroll the same way,
  under the same test shape.
- Editing a panel's config mirrors onto the element (`registry.update`
  with the new `config`) **and** the dockview params.
- Opening a saved project does not spuriously mark it dirty from the
  panel-config persist path (deep no-op check covered by a unit test).
- `PanelViewConfig` / the `config` field carry rustdoc-equivalent
  TS-doc; the `types.ts` element-config comment reflects the new
  model-owned location.
