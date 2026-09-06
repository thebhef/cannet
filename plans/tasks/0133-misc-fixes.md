# 0133 — Misc Fixes

> **Opened 2026-09-03** by owner instruction, as the collection point
> for small owner-reported fixes that belong to no open task. Add new
> items here rather than opening a task per fix.

## Items

1. **Hex display: leading zeros are preserved** (owner feedback,
   2026-09-03). A hex value renders at its field's full width — a
   byte is two digits, an id and a raw value the width their bit
   length implies — instead of dropping leading zeros. Grooming
   enumerates the surfaces that render hex and pins each with a test.

## Exit criteria

Each item lands with a test that reproduces the reported behaviour
first; the task closes when its list is empty and the owner has seen
the fixes.
