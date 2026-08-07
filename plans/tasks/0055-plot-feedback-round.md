# Task 55 — Plot Feedback Round

Owner feedback from a plot-heavy working session (2026-08-07; four
plot areas × 16 signals each, cell-voltage-style names). Defects
first, then workflow features. Two further items went straight to
the backlog (signal sorting in the side panel; individual-mode axis
blow-up).

## Items

### 1. Manual range broken under the normalized (0.0–1.0) scale

Setting a manual range doesn't really work at all, at least when the
0.0–1.0 normalized scale is applied. Owner's best guess: the range is
applied without considering the properly scaled signal value (raw vs
normalized mismatch). Reproduce first, then root-cause — the fix
must state which space a manual range lives in (engineering units,
presumably) and convert at the seam.

### 2. "Hide others" for series

A hide-others function on a series/selection would be nice — with an
fzf or regex matcher: entering `.?Cell16.?` and working item by item
(next match, previous match) is the workflow to serve.

### 3. Post-DBC-reload recovery: clear plot + reset start time

Replacing/reloading a DBC with data in the buffer is painful,
especially while updating all the signal selections — just not
responsive. Mitigating workflow (the concrete feature request): clear
the plot view, then a **new button that resets the plot's start time
to 0** so the plot sees all buffered data again from scratch.

### 4. Collapsible plot areas

Collapse/expand individual plot areas within a panel.

### 5. Selected series bolded

The selected series (one or many) render bolded in the plot area, so
the selection is visible in the drawn lines, not only in the side
panel.

### 6. Drag plot areas between plot panels

Drag-and-drop a plot area from one plot panel to another. (Moved
here from task 23's roadmap blurb, 2026-08-07 — the owner wants it
with this round. ADR 0045's cross-panel payload machinery is the
likely carrier.)

## Exit criteria

- Manual range behaves correctly on normalized and non-normalized
  scales, with a test pinning the space conversion.
- Hide-others ships with a matcher usable for the `Cell16`
  item-by-item workflow.
- Clear-plot + reset-start-time button ships; reloading a DBC with a
  full buffer has a documented, responsive recovery path.
- Areas collapse/expand; selected series are visually distinct
  (bold) in the plot.
- A plot area drags between plot panels, carrying its series,
  patterns, and y-axis mode intact.

Dropped to backlog 2026-08-07: per-area color-wheel indices (the
observed inconsistency is `stableSignalColor` hashing working as
designed; task 56's generators cover the motivating Cell1–16 case
better).
