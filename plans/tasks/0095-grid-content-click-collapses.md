# Task 95 — Clicking Grid Content Collapses the Row It Belongs To

Opened by owner instruction 2026-08-20, from 0.9.0 usage feedback:

> gridview; in trace view, clicking on signals collapses the message.
> It should require a click on the message to collapse it. This is true
> for other gridviews as well; expected behavior is to select rows in
> the content grid, not to collapse the gridview.

## The defect, confirmed in code

In `TraceView.tsx` the trace row's **root element** carries an
`onClick` that calls `onToggle(frameRowId(frame), …)` whenever the
frame is decoded. The expanded signal list — `<div className="signals">`
— is a **child of that same element**. So a click anywhere in the
expanded content bubbles to the row handler and collapses the row the
user was reading.

This is a structural mistake rather than a missing guard: the toggle
target is the whole row instead of the message line, so any content
rendered inside an expanded row inherits collapse-on-click.

## What the expected behaviour is

The owner states it: **clicking content selects a row in the content
grid; only clicking the message collapses it.** The gridview already
has a selection model (`gridviewSelection.ts`) and a cursor, and
`useGridview` already exposes `onRowClick` with modifiers — so
selection is not new machinery, it simply is not reachable from inside
an expanded row.

## Scope

- The collapse affordance is the **message line** (and the existing
  keyboard expand/collapse), not the row's whole footprint.
- Clicks inside expanded content **select** within that content.
- **Sweep every gridview**, per the owner's "this is true for other
  gridviews as well". The candidates are the panels with expandable
  rows: the trace view, the RBS panel, the signals panel, and any
  gridview added since (`*.gridview.dom.test.tsx` enumerates them).
  Each either has the bug or is pinned with a test proving it does not.
- Keep one shared behaviour. The point of the gridview primitives is
  that panels do not each decide what a click means; a per-panel fix in
  four places would be the wrong shape.

## Open questions — grooming

- ~~What does selecting inside expanded content mean for the selection
  model?~~ **Resolved 2026-08-20 (owner): expanded content becomes real
  rows.** A signal inside an expanded frame gets an id in the row space
  rather than being a blob rendered inside one row. Selection, the
  cursor and keyboard navigation then work through content for free,
  and the "content is a blob inside a row" special case — which is what
  caused this bug — is gone rather than guarded.

  This is the larger change and the task is sized accordingly: the
  height and virtualization code (`expandedRowHeight`,
  `expandedExtraHeightOf`, `buildPlacements` in `TraceView.tsx`)
  currently derives an expanded row's height from a signal *count* and
  places one tall row; it has to place N ordinary rows instead. Expect
  the row-space adapter (`arrayRowSpace` / `GridviewAdapter`) to need a
  child-bearing variant, since today's adapter is flat.

  Phase this so the virtualization change lands separately from the
  click behaviour — the click fix is the observable outcome, the row
  space is the machinery under it, and mixing them makes the diff
  unreviewable.
- ~~Is drag-select inside content expected too?~~ **Decided by the
  overseer 2026-08-20: yes, and it follows for free.** Once expanded
  content is made of real rows, drag-select is the row space's existing
  behaviour rather than a feature to add. The thing to watch is the
  opposite — that the trace row's existing `onDragStart` (dragging a
  signal out to a plot) still works from a content row and is not
  swallowed by selection.

## Exit criteria (draft — firm at grooming)

- Clicking a signal inside an expanded trace row does not collapse it;
  tested.
- Clicking the message line still collapses it; tested.
- Every gridview with expandable rows is either fixed or has a test
  pinning that it was already correct.
- One shared implementation — no per-panel copy of the click rule.
