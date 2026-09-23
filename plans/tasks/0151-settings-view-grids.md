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

- **The units row space does not restore its own scroll offset.** Task
  150 phase 1 gave the settings view a `scrollTopRef` that puts
  `.settings-list`'s offset back after dockview removes and re-adds the
  panel's element; the new inner scroller has no equivalent, so it
  reopens at the top. That restore is keyed on `shownCount`, which is
  not a re-attach signal, so replicating it inside the section would be
  guesswork rather than a fix. Net effect is still an improvement: the
  offset `.settings-list` restores is now a short list's, not a
  2289-row one's, so it lands where the user left it far more often.
- **A filter every row matches costs ~1.5 s to render** (numbers
  above) — unchanged from the flat table, because the rows are not
  virtualised. Only reachable by typing a needle that matches
  everything; the ordinary filter narrows and is ~30 ms.
- (Blocker closed) The units and caches row spaces now both restore
  their scroll offset across a settings-panel hide/show, via the shared
  `useScrollRestore` hook. No new side effects observed.
- 2026-09-23 (phase 2, overseer) — the 2289-row disclosure test in
  `UnitCustomizations.scale.dom.test.tsx` failed once under the phase-2
  agent's full-suite run and passed on every rerun: 2 agent reruns, 5
  isolated runs (~560 ms each) and one full suite by the overseer, all
  green. Not reproduced; recorded so a second sighting is not a first.

## Status log

- 2026-09-22 — opened; survey and rulings above.
- 2026-09-23 — **phase 1 (the units table as a gridview) landed** on
  `task151-units-gridview` (`1c619d8b`, one commit, no squash).
  `UnitCustomizations.tsx` is a gridview (ADR 0044) instead of a
  `<table>`: **dimension branches over unit leaves**, in a bounded row
  space of its own (`.unit-customizations-grid`, `max-height: 24rem;
  overflow-y: auto`) inside the settings view, so `.settings-list` no
  longer scrolls through 2289 unit rows. **Modelled on
  `LoggerFileGrid`** — a branch/leaf tree over `arrayRowSpace` with a
  view-local expanded set, a `rowDomIdRef` forward reference and the
  "scroll it just into view" `scrollToRow` — rendering rows as plain
  elements the way `BlfChannelMapModal`'s markers list does rather than
  through `gridviewColumns`: the settings renderer has no params blob,
  so a resizable/reorderable/hideable column set would be a gesture
  that forgets itself on every reopen. Branch ids are `dim:<label>`,
  leaf ids `unit:<base>/<prefix>`; a row the host gives no dimension
  (a refused definition) hangs under a **"no dimension"** branch.
  **The per-row dimension cell is gone** — the branch a row hangs under
  is what says its dimension, and repeating it on each row is the
  redundancy the grouping removes.
  **Disclosure** per § Rulings: a branch opens by itself the *first*
  time this project is seen to hold something on one of its units (a
  non-builtIn mapping or a composition) — on load for the dimensions
  already customized, and on the spot for a unit just composed, so
  `LPM` lands visibly. Only the first time, tracked in a `seeded` ref:
  a branch the user then shuts stays shut. While a filter is typed the
  branches are headings over its matches (`isOpen = filtering ||
  expanded.has(id)`, and branch rows are not `expandable` then — there
  is nothing behind a caret to disclose).
  **Render cost, reported not gated** (throwaway jsdom probe, 2289 rows
  over 109 dimensions, 3 runs, deleted before the commit): opening the
  section **1554 / 1319 / 1262 ms → 168 / 80 / 62 ms**; clearing the
  filter back to everything **1228 / 1217 / 1267 ms → 51 / 35 / 45 ms**.
  A filter *every* row matches still costs **1654 / 1572 / 1437 ms** —
  the same order as the old table, since no virtualiser was added (a
  technology-inventory decision this task rules out). The default
  disclosure is what keeps that cost off the open.
  **Tests**: the existing units dom tests moved over unchanged in what
  they assert. Two adaptations were unavoidable and are documented in
  the file's header comment: `rowFor` now opens the branch the host
  puts a unit under before reaching for the row, and the
  dimension-order assertion reads one branch label per dimension where
  the flat table repeated the label on every row of one
  (`["current","temperature","time","voltage","volume"]`, formerly with
  `"time"` twice). New: `UnitCustomizations.scale.dom.test.tsx` (3
  tests) mounts the section inside a `.settings-list` at 2289 rows and
  pins that every branch and leaf row is inside the row space, that the
  row space is what carries `overflow-y: auto` and a `max-height`
  (asserted against `index.css?raw` — jsdom does no layout), that the
  section opens with exactly one dimension expanded, and that the
  filter expands its matches and collapses back; and a keyboard test in
  the dom suite walks a dimension open with Right, steps onto a unit
  with Down and back out with Left. 3645 frontend tests, `pnpm build`
  clean, release host built.
  **Composition entry, alias, mapping rows and the ratio scale column
  are untouched** — the entry, `check_unit_definition`, the two-scope
  checkboxes and the delete control are the same code; the ratio
  family's scale column is host-side (task 149 phase 2) and this diff
  reaches no Rust.
  For phase 2: `ProjectCachesList` in `settingControls.tsx` can reuse
  the same shape (plain rows in a bounded `arrayRowSpace` gridview, no
  column framework) — a flat leaf-only space, so no `expanded` set is
  needed.
- 2026-09-23 — **phase 2 (the project caches list as a gridview)
  landed** on `task151-caches-gridview`, from `task151-units-gridview`
  (`49c23573`, one commit, no squash needed — the branch never had a
  second commit). `ProjectCachesList.tsx` is a gridview (ADR 0044)
  instead of a flex column: **one leaf row per project directory, no
  branches** — there is nothing to group cache directories under — in
  its own bounded row space (`.project-caches-grid`, `max-height: 24rem;
  overflow-y: auto`) inside `.project-caches`, so the settings view's
  own scroll no longer walks through it. **Modelled on
  `UnitCustomizations.tsx`**, itself modelled on `LoggerFileGrid`: rows
  as plain elements over `arrayRowSpace`, not through the column
  framework (the settings renderer has no params blob to persist a
  resizable/reorderable layout in). Simpler than the units section's
  tree markup, though — no branches at all, so the row markup follows
  `BlfChannelMapModal`'s flat markers list instead: plain divs carrying
  `grid.rowDomId`, a `cursor`/`selected` class and `onClick ->
  grid.onRowClick`, no `role="tree"`/`aria-level` tree semantics that
  would have nothing to describe. **Every row from task 150 is
  unchanged**: name leading with the directory path as a secondary line
  and in the tooltip, state badge, location chip (`project dir` /
  `auto-located`) with its tooltip, the pending-size ellipsis and the
  `N projects · measuring…` header, `Save as…`, `Clear data cache`, and
  the two-stage trash `Delete` disabled on the active row. `Clear all
  data caches` stays a plain header button outside the row space, as
  ruled. Reloading on `project-dir-changed` and on the settings view
  being shown is unchanged (`shown` from `SettingsShownContext`, read
  once and reused for both the reload effect and the new scroll-restore
  hook).
  **Tests**: every existing assertion in `ProjectCachesList.dom.test.tsx`
  held with **no selector adaptation** — the row and control class names
  didn't move, only the wrapper's interaction model did, so
  `screen.getByText` / `getByRole` queries were already selector-stable.
  Two new tests: a `"the gridview"` describe block walks the row cursor
  with ArrowDown/ArrowUp and checks `aria-activedescendant` against each
  row's dom id (exit criterion 2 — keyboard); and a scroll-restore test
  under the re-root describe block (below).
  **Blocker fixed (§ Blockers item 3, both row spaces).** Pulled the
  save/restore-`scrollTop` mechanism `SettingsPanel.tsx` already used for
  `.settings-list` into a shared hook, `useScrollRestore.ts`: it takes
  the container ref (the row spaces already need one for their own
  scroll-a-row-into-view arithmetic) and a shown count, and returns the
  `onScroll` handler to wire up. `shownCount` is a parameter rather than
  read from context *inside* the hook, because `SettingsPanel` is
  `SettingsShownContext`'s own producer and so is not inside its own
  subtree — it passes its local counter directly; `UnitCustomizations`
  and `ProjectCachesList` are reached through the custom-setting
  renderer table, so each reads the count via
  `useContext(SettingsShownContext)` and passes it through. Three call
  sites, one mechanism, no second copy. `SettingsPanel.tsx` was
  refactored onto it (behaviourally identical — same ref, same
  layout-effect timing) so all three inner/outer scrollers share one
  implementation rather than the outer one setting a precedent nothing
  followed. Dom test first, red then green, at both call sites that
  needed the fix: scroll the row space, reset `scrollTop` to simulate
  what a real dockview detach/reattach does (jsdom performs no such
  detach on a plain rerender, so the reset stands in for it), bump
  `SettingsShownContext`'s value the way a hide/show does, assert the
  offset is back. One test added to `UnitCustomizations.dom.test.tsx`
  ("scroll restore across a settings-panel hide and show") and one to
  `ProjectCachesList.dom.test.tsx`.
  **Docs**: README's Project caches passage gained one sentence — "The
  list scrolls in a bounded space of its own rather than in the
  settings view's list" — matching the units passage's existing wording
  for the same fact. `docs/CONTEXT.md`'s gridview entry and ADR 0044
  enumerate no instantiations (confirmed, as phase 1 found), so neither
  needed a line; ADR 0042 §5 describes actions and re-rooting, not row
  markup, so it is unreached by this diff (phase 1/2/3 of task 150 made
  the same call).
  **Checks**: `pnpm --dir apps/gui test` — full suite, 248 files / 3648
  tests green on two consecutive runs (one run of the full suite showed
  a single unrelated failure in `UnitCustomizations.scale.dom.test.tsx`
  — the 2289-row disclosure test from phase 1, which this diff does not
  touch the logic of — not reproduced on two immediate reruns; treated
  as a pre-existing timing flake in a heavy jsdom test under this
  session's full-suite load, not a regression from this phase).
  `pnpm --dir apps/gui build` clean (tsc -b + vite). Comment-references
  grep clean (two draft comments that named "Task 150 phase 1" were
  reworded before committing). No CRLF flips despite the false alarm a
  raw `grep -c $'\r'` gave on this shell — confirmed with a byte-level
  check (`\r` immediately before `\n`) that every touched file,
  including README.md, kept its original line ending.

## Exit criteria verdicts (2026-09-23, after phase 2)

| # | Verdict |
| --- | --- |
| 1 | met — dimensions are branch nodes and units leaves in one `arrayRowSpace` row space; `.unit-customizations-grid` carries the bound and the scrollbar, and a scale dom test pins that every row is inside it and inside `.settings-list` |
| 2 | met — the filter, the composition entry (`LPM = L / min`), the mapping rows and the two-scope checkboxes are the same code and their dom tests pass over the gridview; the ratio scale column is host-side and unreached by this diff |
| 3 | met — `ProjectCachesList` is a gridview (ADR 0044) with one leaf row per project directory, its own bounded row space (`.project-caches-grid`), and every task-150 row content/control intact; its dom tests pass over the gridview with no assertion changes |
| 4 | n/a this phase (Servers section — phase 3) |
| 5 | partly, further toward done — README's caches passage now says the list scrolls in its own space; "no view in the settings view renders rows outside the gridview" is still not fully true — the Servers section is phase 3 |
| 6 | met for 1–3 — 20 dom tests over the caches gridview (18 moved unchanged + 1 keyboard-cursor test + 1 scroll-restore test), plus 1 new scroll-restore test in `UnitCustomizations.dom.test.tsx` closing phase 1's blocker for that row space too |
