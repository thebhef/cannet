# Task 154 — Colour a Selection at Once

Opened by owner instruction 2026-09-22 (ungroomed feedback item,
groomed the same day). **Executes now, on the current stack.**

## Why

From the owner, 2026-09-22: "allow setting color on multiple selected
items in signal panel, plot panel."

## Findings (2026-09-22 survey)

- **Both panels colour one row at a time through the same control.**
  The Signals panel opens the native picker on a right-click of the
  signal name (`SignalsPanel.tsx`, `ColorChip` with `hideBox`) and
  writes one project `signal_colors` entry via `onSetSignalColor`. A
  plot area's signal row opens it on a right-click of the swatch
  (`PlotArea.tsx` `SignalSwatch`) and writes that series' `colorPick`,
  the only colour a plot stores (ADR 0026). Both are the browser's
  `<input type="color">`: one value per pick.
- **Both panels already have a multi-row selection** (gridview, ADR
  0044: click, Ctrl/Cmd+click, Shift+click, Ctrl/Cmd+A), and both
  already fan an action over it: the Signals panel's drag source
  takes "the selection if the dragged row is in it, else the row
  alone" (`SignalsPanel.tsx`), and the plot area's selection context
  menu does bulk Hide / Show with the rule that a right-clicked row
  outside the selection becomes the sole selection first
  (`PlotArea.tsx`, `plot-selection-menu`).
- **The Signals panel's selection set also holds pattern chips** (ADR
  0045). A colour is a per-signal pick (ADR 0026); a pattern names no
  colour.

## Rulings

Settled by the overseer from the code, open to reversal:

- **The pick applies to the selection the row belongs to.** A
  right-click on a name (Signals panel) or a swatch (plot area) whose
  row is in the selection opens one picker, and the chosen colour is
  written to every selected row; a row outside the selection becomes
  the sole selection first — the plot menu's existing rule. One
  colour for all: "setting color" on the selection, not spreading it
  across the wheel.
- **One write per pick.** The Signals panel writes the N
  `signal_colors` entries in one project change; the plot area writes
  the N `colorPick`s in one areas update — one dirty step, one undo.
- **Storage is unchanged.** A plot pick stays per series and a
  Signals-panel pick stays the project entry, as ADR 0026 has them;
  pattern chips in a selection are skipped.

## Open questions

(none.)

## Phases

1. **Both panels.** The Signals panel's name picker and the plot
   area's swatch picker over the selection, the sole-selection rule
   for an unselected row, one write per pick, chips skipped; DOM
   tests for each panel (selection of three, picker once, three rows
   recoloured, one project / areas change; an unselected row recolours
   alone); README's colour passages and ADR 0026's picker bullet say
   the pick covers the selection.

## Exit criteria

1. With three signal rows selected in the Signals panel, a right-click
   on one of their names and a pick recolours all three in one project
   change; a right-click on an unselected row recolours that row
   alone and makes it the selection.
2. The same in a plot area's signal rows through the swatch, writing
   three `colorPick`s in one areas update.
3. Pattern chips in the selection are unaffected; no stored shape
   changes.
4. DOM tests cover 1–3; README and ADR 0026 describe the behaviour.

## Blockers / side effects

(none yet)

## Status log

- 2026-09-22 — opened and groomed from the code; no owner questions.
