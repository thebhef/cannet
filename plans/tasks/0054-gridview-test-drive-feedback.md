# Task 54 — Gridview Test-Drive Feedback

Two defects from the owner's first drive of the task-51 gridview
(2026-08-06), the day it landed. Both are regressions or gaps in the
migrated surfaces; both should start from a failing test that
reproduces what the owner saw.

## Items

### 1. Signal-row drag area is too small

Dragging a signal row works only on the signal *name* text; the whole
row should be the drag source. Owner's note: "I suspect there's some
negative-value special case code here" — check the signal view's
drag-source wiring for a special case (value cells or some value
range bypassing the drag handler) and widen the source to the row.
Verify against the other migrated surfaces while there — the D9 rule
(the row drags the message / the signal) implies row-sized drag
targets everywhere.

**Grooming (2026-08-07):** The small drag surface is not a stray
special case — it is deliberate, per ADR 0045's grip rule ("rows that
hold inputs or buttons are not themselves draggable";
`SignalsPanel.tsx` cites it at the name-cell grip). The
negative-value hypothesis is refuted: the signal-row render path has
no value-dependent DOM branch. **Owner ruling: the rule changes.**
Rows are draggable to the fullest extent possible without interfering
with interaction on input fields, and no special affordance is made
for inner controls until one proves necessary. Item 1 therefore
includes amending ADR 0045's grip rule to match (whole-row drag is
the norm; an inner drag source like `DecodedSignalCell` suppresses
the row drag via stopPropagation) and restating the
`SignalsPanel.sections.dom.test.tsx` assertion that currently pins
"the section button is not inside a draggable" to its real intent.

### 2. Keyboard-only entry into RBS row content regressed

With keyboard only, the RBS content area (the per-message signal
table with its inputs) can no longer be entered and edited. The
gridview key table says Tab enters row content, and the C2 migration
carried tests for it — but real usage says it's broken. Find the
actual failure (dispatcher suppression eating Tab, focus order,
content not reachable from the container focus) with a DOM test that
reproduces the keyboard-only path end to end, then fix.

**Grooming (2026-08-07):** Root cause found by code read: the
ADR-0044 Tab contract ("Tab moves into the row's interactive
content") was never implemented in any panel — `useGridview.ts` lets
Tab fall through to native document focus order, so Tab lands on the
container's first tab stop, not the cursor row. Compounding gaps:
RbsPanel / DbcPanel / TransmitPanel never focus the grid container on
row click (focus stays on `<body>`; arrows dead), and
`ValidatedInput` blurs to `<body>` on Enter/Escape so the next Tab
restarts from the document top. **Owner ruling: this is a missing
part of the common control — implement it in the shared gridview
layer**, not as RBS patchwork: Tab (container focused) → cursor
row's first focusable element, Shift+Tab symmetric, commit/Escape
returns focus to the container, and the three panels missing
focus-on-click get it.

## Exit criteria

- A signal row drags from anywhere on the row (not just the name),
  with a test pinning the wider target; ADR 0045's grip rule is
  amended to the whole-row-drag norm in the same change.
- A keyboard-only user can Tab from the RBS grid into the cursor
  row's content, edit a value, and leave; DOM test reproduces the
  broken path first. The Tab contract lands in the shared gridview
  layer (all panels), RbsPanel/DbcPanel/TransmitPanel gain
  focus-on-click, and commit/Escape returns focus to the container
  — matching what ADR 0044 already documents.
