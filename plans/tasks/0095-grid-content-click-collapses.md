# Task 95 — Clicking Grid Content Collapses the Row It Belongs To

> **Status 2026-08-23 — code-complete, awaiting acceptance.** All three
> phases landed 2026-08-21 on the chain (nothing has merged). The four
> exit criteria are walked in the status log, all met. Queue item 1.5 (a
> disclosed row's clickable width) was accepted 2026-08-24 (*"feels
> fine"*); 1.6 (editor-face content as rows) became task 113 § 1. Nothing
> is owed here.

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

## Status log

### 2026-08-21 — (branch `task-95-grid-content-rows`)

**Diagnosis, before changing anything.** Observation: with a trace row
open, `fireEvent.click` on a `.signals .signal` line left
`.trace-row.expanded` empty — the row collapsed. Hypothesis: the click
reaches the row's own `onClick` by DOM bubbling, because the content is
a descendant of the row element. Experiment (a throwaway printing test
with two controls that discriminate): (A) click the `.trace-rows`
container background — a delegated container-level handler would
collapse the row here too; (B) click the signal line, first printing
`row.contains(line)`; (C) click the message line. Data: A left the row
open, `contains` was `true`, B collapsed it, C reopened it. Conclusion:
the collapse comes from the row element's own handler reached by
bubbling — not from delegation, and not from anything the content does.
The row's whole footprint was the toggle, and the content sat inside
that footprint.

**Phase 1 — the machinery** (`acac3c6e`). `gridviewContentRows.ts`
splices an open row's disclosed rows into the base space a view
indexes, both directions, and names them from their row's id.
`cursorAction`'s Right on an open leaf now steps into its first content
row, and Left walks back out — the same moves a branch already had. The
pure-layer fixture's "an expanded leaf still occupies exactly one row"
was turned around deliberately: it asserted the model this task
reverses. ADR 0044's node model amended in the same commit.

**Phase 2 — the two trace views** (`e14218f4`). A disclosed signal is a
row of the space with its own id, rendered as a *sibling* of the
message row rather than nested in it, so there is no click to swallow
and no guard to write. Row counting: `TraceView` and `ByIdTable` build
`openRuns` from the walk they already did for `expandedPositions`, and
their adapters' `count` / `rowIdAt` / `indexOf` / `scrollToRow` go
through `contentRowSpace`. Virtualisation: unchanged — a placement's
`height` is still the whole block, so the anchor bound, the spacer and
the sticky viewport measure what they measured before; the message row
is drawn one row tall and the disclosed rows stack under it to the same
total. The runs are the ones the view can *locate*, i.e. the loaded
window; an open row scrolled out of it still contributes its height
through `extraHeight`, exactly as before, and its id resolves to
nothing while it is gone, exactly as every other id outside the window
does. Nothing capture-sized entered frontend state. Selection:
`selectionOrder` lists the loaded page's messages each followed by its
disclosed rows, so Ctrl+A and Shift+click range across them.

**Phase 3 — the sweep** (`6225510f`). The transmit panel had the same
defect by a different route: its expanded face is inside the tile
element and the tile toggles on any click that isn't an interactive
control, so a click on a signal's *name* span collapsed it. Fixed by
excluding the disclosed face from the toggle. The RBS panel, the
Database panel and the signal view were already correct — content is a
sibling of the row, or already real rows — and each now has a test
saying so. ADR 0044 states the rule that covers both content shapes.

**Exit criteria.**

| Criterion | Verdict | Earned by |
| --- | --- | --- |
| Clicking a signal inside an expanded trace row does not collapse it | met | `TraceView.gridview.dom.test.tsx` → "selects a disclosed signal rather than collapsing the message"; `ByIdTable.gridview.dom.test.tsx` → same name |
| Clicking the message line still collapses it | met | both files → "still collapses the message when the message line is clicked" |
| Every gridview with expandable rows is fixed or pinned | met | fixed: the two trace views, `TransmitPanel.dom.test.tsx` → "clicking a signal name in the disclosed face does not collapse the row". pinned: `RbsPanel.gridview.dom.test.tsx` → "clicking inside a disclosed signal table leaves the message open"; `SignalsPanel.gridview.dom.test.tsx` → "clicking a signal inside a section leaves the section open"; `DatabasePanel.dom.test.tsx` → "clicking a row's detail block leaves the row it belongs to open" |
| One shared implementation, no per-panel copy of the click rule | met | `gridviewContentRows.ts` + `DecodedSignalCell` carry the row identity, the placement and the click for both trace views; ADR 0044 states the rule once |

Frontend suite: 2430 → 2449 passing, 185 → 186 files, all green;
`npx tsc --noEmit` and `vite build` clean. No Rust touched.

## Blockers / side effects

- **The ruling reads narrower than "all disclosed content".** Two
  panels disclose an *editor face* rather than a list — the transmit
  tile's frame-shape / byte editors and the RBS message's value cells —
  and those are reached by Tab, not the cursor (ADR 0044 says so
  explicitly, and making them rows would collide with that). They keep
  the same guarantee by the other half of the rule: the toggle is the
  row's own line. Recorded rather than silently redesigned.
- **A disclosed row's clickable width is the line's width (32 rem),**
  not the panel's, because that is where its border and layout already
  were. Clicking to the right of a disclosed line now does nothing
  where it used to collapse the message; it does not select either.
