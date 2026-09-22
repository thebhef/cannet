# Task 151 — The Settings View's Grids Are Gridviews

Opened by owner instruction 2026-09-22, from using tasks 149 and 150
on this stack. **Executes now, on the current stack.** Grooming in
progress.

## Why

From the owner, 2026-09-22:

1. The units table (settings view, Units section) should have its
   own scroller. After task 149 it lists 2289 rows, and the whole
   settings view scrolls through them.
2. Is the units table our gridview, the control the trace, signals
   and events views use? (It is not — see § Findings.) Use the
   gridview.
3. Everything that is a grid in the settings view is a gridview.
4. The Servers panel should be a gridview too, and the owner had
   originally specified it to live in the settings view, not as a
   view of its own.
5. The new units are comprehensive "but currently a bit
   overwhelming" — which is what the grouping and collapsing a
   gridview brings.

## Findings (2026-09-22 survey)

- **The units table is a plain HTML table** (`UnitCustomizations.tsx`,
  `<table className="unit-customizations-table">`) rendering every
  row the filter leaves, with no scroller of its own: it scrolls with
  the settings view's `.settings-list` container. It was added on
  this stack, after the gridview existed, so it is not a holdout —
  it is a one-off that should not have been written. `docs/CONTEXT.md`'s
  gridview entry: "_Avoid_: per-panel one-off row interaction."
- **The gridview** (ADR 0044, `useGridview`) is instantiated by
  twelve views today: trace, signals, view signals, database, RBS,
  transmit, logger file grid, BLF channel map, by-id table and the
  gridview filter. Branch nodes structure rows; leaves are rows; a
  row cursor, selection and disclosures come with it.
- **The settings view's grids** are the custom-setting renderers in
  `settingControls.tsx`: `project-caches` (`ProjectCachesList`, a
  flex column of rows) and the units section (`UnitCustomizations`).
  Nothing else in the settings view is tabular.
- **The Servers panel** (`ServersPanel.tsx`) is a singleton panel of
  `ServerRowView` rows in a `servers-list` div, a toolbar, an
  add-by-hand entry and trust/forget actions (ADR 0041). No
  gridview. `docs/CONTEXT.md` defines "Servers panel" as the
  singleton panel; the roadmap's CLI task names its affordances.
- **The picker render cost** task 149 queued (all ~920 base rows
  rendered on open, ~215 ms in jsdom to clear the filter) is the
  same shape one level down; it is folded in here rather than
  answered with a virtualiser.

## Rulings

- **Use the gridview** (owner, 2026-09-22, Q1). The units table
  becomes a gridview with a dimension as a branch node and a unit as
  a leaf row, its own bounded scrolling row space inside the
  settings view, the existing filter kept.
- **Everything that is a grid in the settings view** (owner,
  2026-09-22, Q2): the project caches list too.
- **The Servers panel is a gridview and lives in the settings view**
  (owner, 2026-09-22). Overseer's reading: a Servers section of the
  settings view, the same rows and actions, the singleton panel
  retired; the command palette's Servers entry opens the settings
  view at that section; ADR 0041 and `docs/CONTEXT.md` amended.
- **Grouping and the filter** (owner, 2026-09-22): the units table
  has no groups today; the owner does not want the rows flattened,
  and the filter is required. Overseer's reading: dimension branches
  as ruled above, the task-149 filter kept; default disclosure is the
  overseer's call — every branch collapsed on open except one holding
  a unit the project maps or customizes, the filter expanding what it
  matches. One line to flip if it reads wrong.
- **The Servers command palette entry stays** (owner, 2026-09-22),
  opening the settings view scrolled to the Servers section.

Settled by the overseer, open to reversal:

- **The unit picker** (the math signal editor's Units button, and
  after task 149 phase 3 the View signals panel's) has the same
  920-row shape. It stays the two-column picker with its filter and
  is out of scope here; a gridview inside a popover is a different
  control.

## Open questions

(none — ruled 2026-09-22.)

## Phases

1. **The units table as a gridview.** Dimension branches, unit
   leaves, own bounded row space, filter kept, default disclosure per
   § Rulings; the existing units dom tests move over; a
   gridview dom test at scale (2289 rows) pins scroll containment.
2. **The project caches list as a gridview.** One leaf per project
   directory, the task-150 row content and controls kept, own row
   space.
3. **Servers into the settings view.** The Servers section as a
   gridview (rows, toolbar, add-by-hand, trust and forget), the
   singleton panel retired, the command palette entry re-pointed,
   ADR 0041 and `docs/CONTEXT.md` amended, README's Servers passages
   updated.

## Exit criteria

1. The units section is a gridview: dimensions are branch nodes,
   units leaves; it scrolls inside its own bounded row space and the
   settings view's own scroll no longer walks through unit rows.
2. The units filter, the composition entry, the mapping rows and the
   ratio scale column behave as they did after task 149 (their tests
   pass over the gridview).
3. The project caches list is a gridview with the task-150 row
   content and controls intact (its tests pass over the gridview).
4. The Servers rows are a gridview section of the settings view; the
   command palette reaches it; every ADR 0041 affordance (trust, token,
   forget, add by hand) works there, tested.
5. `docs/CONTEXT.md` and ADR 0041 describe the Servers section; README
   reflects it; no view in the settings view renders rows outside the
   gridview.
6. Tests cover 1–5.

## Blockers / side effects

(none yet)

## Status log

- 2026-09-22 — opened; survey and rulings above.
