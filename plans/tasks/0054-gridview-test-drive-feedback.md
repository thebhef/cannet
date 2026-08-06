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

### 2. Keyboard-only entry into RBS row content regressed

With keyboard only, the RBS content area (the per-message signal
table with its inputs) can no longer be entered and edited. The
gridview key table says Tab enters row content, and the C2 migration
carried tests for it — but real usage says it's broken. Find the
actual failure (dispatcher suppression eating Tab, focus order,
content not reachable from the container focus) with a DOM test that
reproduces the keyboard-only path end to end, then fix.

## Exit criteria

- A signal row drags from anywhere on the row (not just the name),
  with the special case — if one exists — removed and a test pinning
  the wider target.
- A keyboard-only user can Tab from the RBS grid into a row's
  content, edit a value, and leave; DOM test reproduces the broken
  path first.
