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

**Grooming (2026-08-07):** The repro (a 0.0–1.0-valued float with a
manual range set in that band rendered offscreen) was observed on
0.7.0 and does **not** reproduce on a live 0.8.1 instance — no
current defect. Owner ruling: **regression-pin and done** — add a
test (if none covers it) walking the repro steps and asserting
in-canvas rendering with correct tick labels, across signal value
shapes (floats, ints, uints) and across the y-axis modes
(unified / per-unit / individual). No bisect of what fixed it; no
speculative rework of the manual-range edge semantics. For the
record, code-read-observed edge shapes (not driving, pinned as
intended by existing tests): one manual bound with no auto range
draws a 0.5 midline with 0.0–1.0 fallback labels
(`plotAxisScale.ts` null return); lane/enum axes ignore manual
ranges; a manual bound applies to every scale group on the axis and
unitless signals each form their own group.

### 2. "Hide others" for series

A hide-others function on a series/selection would be nice — with an
fzf or regex matcher: entering `.?Cell16.?` and working item by item
(next match, previous match) is the workflow to serve.

**Grooming (2026-08-07):** Owner ruling: the intent is **solo** — it
must not touch the other series' persisted `hidden` flags (no bulk
mutation, no pattern-row materialization). It need not be ephemeral,
though: the solo state itself may persist with the panel config like
other view params. Workflow shape (agreed): panel-level solo box
applying across all areas; case-insensitive partial-match regex over
the series display name (entry-time validation, invalid = inert);
pattern entered → only matches visible; next/prev enters step mode —
exactly one match visible, stepping the match list in area order
with a `3/17`-style position indicator, **PgUp/PgDn cycle the
indices** (wrapping); clear/Escape restores the full view. A context
menu on the solo control lists the current matches and lets specific
indices be enabled — i.e. the visible set generalizes from
one-at-a-time to any checked subset of the match list.

### 3. Post-DBC-reload recovery: clear plot + reset start time

Replacing/reloading a DBC with data in the buffer is painful,
especially while updating all the signal selections — just not
responsive. Mitigating workflow (the concrete feature request): clear
the plot view, then a **new button that resets the plot's start time
to 0** so the plot sees all buffered data again from scratch.

**Grooming (2026-08-07):** Confirmed. New **"All data"** button in
the plot's trace controls beside Clear: sets the trace window to
`{start: 0, end: live}` (whole buffer, still following live) and
fits the x-axis to the full range. Serves the DBC-reload recovery:
Clear collapses the window to now → signal re-picking resamples
cheaply → one full-history resample at the end. The window primitive
already exists (`trace.ts` `restoredTrace`, used by project restore).

### 4. Collapsible plot areas

Collapse/expand individual plot areas within a panel.

**Grooming (2026-08-07):** Rides the existing axis-collapse
machinery (auto-collapse when all signals hidden already does
flex-collapse, splitter suppression, placeholder, CSS): a persisted
`collapsed` flag on the area config plus a head toggle; in
individual y-axis mode the flag collapses all the area's derived
axes. Owner additions: (a) areas with **no visible signals collapse
completely** — the side panel entry stays, but the plotted region
gives up all vertical space except a drag handle, and **contiguous
collapsed areas share a single drag handle**; (b) reduce the
*visible* vertical footprint of drag handles/splitters generally,
without shrinking the grab target (thin visual, padded hit area).

### 5. Selected series bolded

The selected series (one or many) render bolded in the plot area, so
the selection is visible in the drawn lines, not only in the side
panel.

**Grooming (2026-08-07):** There is no series-selection model yet —
that was task 49's prerequisite. Owner ruling: **pull the selection
model in from task 49** — item 5 lands the multi-select selection
model (threaded through signal rows / derived axes / pattern
materialization, per task 49's notes) and bolds the selected
series (live width function, same pattern as the live stroke-color
function, no uPlot rebuild). Task 49 retains the bulk actions on
that selection (hide, remove, recolor, add-several).

### 6. Drag plot areas between plot panels

Drag-and-drop a plot area from one plot panel to another. (Moved
here from task 23's roadmap blurb, 2026-08-07 — the owner wants it
with this round. ADR 0045's cross-panel payload machinery is the
likely carrier.)

**Grooming (2026-08-07):** Confirmed: cross-panel drop is a **move**
(area leaves the source panel, lands at the drop position in the
target's stack); payload is the serialized area config (series,
patterns, y-axis mode, primary, collapsed) plus the source panel's
`axisScales` entries for the area's derived axes; layout weights do
not travel; same-panel drop stays the existing reorder;
**Ctrl+drag between plot panels is copy** (the source keeps its
area; the copy gets a fresh area id). Dropping an
area on **other receptive (non-plot) panels adds** rather than
moves, and at this time that case degrades to the signal payload —
the area drag also sets the ADR-0045 signal payload (signals +
patterns) so existing signal-drop targets just work.

## Exit criteria

- The manual-range regression matrix exists and passes: the 0.7.0
  repro steps pinned across value shapes (float/int/uint) × y-axis
  modes (unified/per-unit/individual). No behavior change expected.
- Solo ships: panel-level regex box, matches-only view, step mode
  with next/prev + PgUp/PgDn and a position indicator, context menu
  enabling a checked subset; other series' `hidden` flags never
  mutated; usable for the `Cell16` item-by-item workflow.
- "All data" button ships beside Clear (window to `{start: 0,
  live}`, x fit); reloading a DBC with a full buffer has a
  documented, responsive recovery path.
- Areas collapse/expand via a persisted per-area toggle; areas with
  no visible signals fully collapse to a drag handle (one handle
  per contiguous collapsed run); splitter/handle visible height
  shrinks without shrinking the grab target.
- Selected series (task 49's per-area selection) render bold in the
  plot.
- A plot area drags between plot panels — move by default,
  **Ctrl+drag = copy** — carrying series, patterns, y-axis mode,
  primary, collapsed state, and its manual axis ranges; weights do
  not travel; a drop on a non-plot receptive panel degrades to the
  ADR-0045 signal payload.

Dropped to backlog 2026-08-07: per-area color-wheel indices (the
observed inconsistency is `stableSignalColor` hashing working as
designed; task 56's generators cover the motivating Cell1–16 case
better).

## Status log

- **2026-08-08 (item 1, manual-range regression matrix):** Landed on
  `task55a-manual-range-matrix`. Test-only, no behavior change — the
  grooming note's repro (a manual range within a 0.0-1.0-valued
  signal's own band rendering offscreen) does not reproduce; every new
  test passed on its first run. `a3f1365` pins `resolveAxisRange`'s
  engineering-units contract in `plotAxisScale.test.ts` for the three
  value shapes (float 0.0-1.0, uint 0-255, signed int -128..127), each
  with a manual range wider than the auto/follow-live extent so a
  broken override would be observable; `resolveAxisRange` takes no
  y-axis-mode argument, so the mode dimension isn't meaningful at that
  level. `68485dd` walks the real pipeline
  (`PlotPanel.dom.test.tsx`'s "PlotArea y-normalisation" suite, new
  "manual-range regression matrix (task 55 item 1)" block): float
  across all three y-axis modes (unified/per-unit/individual, per the
  grooming note), plus one DOM spot check each for int (per-unit) and
  uint (individual) — 5 new DOM tests plus 3 new pure tests. `apps/gui`
  test suite: 1496 → 1504 passing (130 files), `pnpm --dir apps/gui
  build` green throughout. Matrix coverage:

  | value shape | unified | per-unit | individual |
  | --- | --- | --- | --- |
  | float (0.0-1.0) | DOM | DOM | DOM |
  | int (-128..127) | pure | DOM | pure |
  | uint (0-255) | pure | pure | DOM |

  ("pure" = `resolveAxisRange`-level in `plotAxisScale.test.ts`,
  mode-invariant by construction; "DOM" = the full normalisation
  pipeline in `PlotPanel.dom.test.tsx`.)

- **2026-08-08 (cleanup, describe-title task references):** Landed on
  `task55b-all-data-button`, `4b70b8c`. Two test `describe` titles
  named "task 55 item 1" — source (including tests) never names a task
  number per the working agreement. Renamed to just "manual-range
  regression matrix" in both `plotAxisScale.test.ts` and
  `PlotPanel.dom.test.tsx`; no behavior change. `apps/gui` test suite:
  1504 passing (130 files, unchanged count), build green.

- **2026-08-08 (item 3, "All data" button):** Landed on
  `task55b-all-data-button`, `3e6135e`. New button beside Clear in the
  plot's trace controls, widening the window to the whole session
  buffer and fitting the x-axis to it — the DBC-reload recovery path
  (Clear collapses the window for a cheap signal re-pick, All data
  widens back out for one full-history resample).
  - `trace.ts` gains `allDataTrace(s, n)`, `clearKeepingState`'s
    mirror: widens to `[0, n)` instead of collapsing to empty,
    preserving run state — running stays running (`freshTrace(0)`,
    so it keeps growing and is "still following live" per the
    grooming note), stopped/paused become the full buffer to date via
    `restoredTrace`'s shape (the same primitive project restore
    uses, as the grooming note pointed at). `useTrace` exposes it as
    `TraceHandle.allData`.
  - `TraceControls` gains an optional `onAllData` prop — the button
    renders only when supplied, so only the plot shows it (the trace
    panel and signals panel share the same component and stay
    unchanged).
  - `PlotPanel`'s existing `fitData` body is split into a parameterized
    `fitToRange(start, ws, we)`; `fitData` calls it with the window's
    own (possibly still-parked) `sharedStart()`/`winStart`/`winEnd` as
    before (no behavior change — confirmed by the untouched "Fit Data
    over a parked window" suite staying green), and the new
    `handleAllData` calls it with the explicit whole-buffer bounds
    `(0, 0, capture.count)` — sidestepping the render-timing problem of
    reading `winStart`/`winEnd` before the just-issued window-widening
    state update has propagated.
  - Tests: `trace.test.ts` pins `allDataTrace`'s three run-state cases;
    `PlotPanel.dom.test.tsx` adds a "PlotPanel All data button" suite —
    the button renders beside Clear, clicking it widens a parked
    stopped window to `{start: 0, end: bufferCount}` and fits the
    x-axis starting at 0 (not the old parked start, which is what
    distinguishes it from plain Fit Data), and a running window stays
    running afterward. `apps/gui` test suite: 1504 → 1508 passing (130
    files); `pnpm --dir apps/gui build` green throughout.
  - README's plot section documents the button and the Clear-then-All-data
    recovery workflow, in the same commit.

## Blockers / side effects

- None from item 1. No matrix cell failed; nothing to fix in that phase.
- Item 3: the grooming note's literal `{start: 0, end: live}` reads as
  a frozen window (a concrete `end`), but "still following live" only
  holds if the trace keeps its running `end: null`. Implemented the
  closest faithful reading — `allDataTrace` mirrors `clearKeepingState`
  and preserves run state (running trace gets `end: null`, so it truly
  keeps following live; a stopped/paused trace gets the frozen
  `{start: 0, end: n}` shape the note describes literally). No
  redesign beyond that; flagging the literal-vs-intent gap in the note
  for the record.
