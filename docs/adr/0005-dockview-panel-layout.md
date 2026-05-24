# ADR 0005 — Multi-panel UI uses `dockview` for the dock layout

Status: accepted (2026-05-24)

## Decision

The Tauri WebView frontend uses **`dockview`** (v6, MIT) for the
multi-panel shell: arbitrary split / tab / drag / resize layouts of
trace, project, plot, and transmit panels inside the single app
window.

Layout state is serialised via dockview's own JSON model
(`api.toJSON()` / `fromJSON()`) and stored verbatim in the project
file — the host does not interpret it. See
[ADR 0011](0011-project-file-format.md) § Decision.

Panel content is plain React behind a thin adapter, so the cost of
swapping dockview out later is bounded to that adapter plus the
on-disk layout-blob migration path.

## Why

**Dock layout is failure-mode-rich UI worth leaning on a vetted
library for.** The drag-and-drop docking state machine, tab and
group geometry, persistent layout serialisation, and pointer-event
handling under split-resize all compound badly when hand-rolled —
exactly the shape this project leans on libraries for.

**TypeScript-native, React-first.** No glue layer between the
library's model and the application's component tree; types flow
through.

**Serialisable layout that drops into the project file.** The
`toJSON()` blob is the unit of persistence. The project file
(ADR 0011) carries it verbatim, so layout round-trips without a
parallel schema in the host.

## Consequences

- **Adapter boundary preserved.** Panel content stays plain React
  behind a thin adapter; the swap cost of replacing dockview is
  scoped to that adapter and a one-shot layout-blob migration.
- **Small bus factor.** dockview is essentially one primary
  maintainer. Mitigated by the adapter boundary above and by the
  permissive license — fork-and-freeze is cheap if upstream goes
  dark.
- **CSS bundle cost.** dockview ships one ≈100 KB CSS bundle
  covering all built-in themes (≈9 KB gzipped). Acceptable for a
  desktop app.
- **Layout-blob opacity in the host.** Per ADR 0011, the host
  treats the dockview blob as opaque; schema migrations that need
  to reach into it walk it deliberately and locally.

## Rejected alternatives

- **`flexlayout-react`** (Apache-2.0) — strong runner-up: mature,
  persistent JSON model, built-in popout windows. Edged out by
  dockview's cleaner TypeScript / React story.
- **`rc-dock`** (MIT) — covers the must-haves but presents an
  older-feeling API alongside dockview with no offsetting advantage.
- **`react-mosaic`** (Apache-2.0) — tiling only, no tabs. Doesn't
  fit a panel-heavy analyzer UI.
- **`golden-layout`** v2 (MIT) — capable and mature, but
  framework-agnostic with no React bindings. Adopting it would
  mean writing and maintaining the React glue ourselves — the
  hand-written failure-mode-rich surface this ADR chose dockview
  to avoid.
