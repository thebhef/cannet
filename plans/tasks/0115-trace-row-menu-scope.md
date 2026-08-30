# 0115 — Trace Row Menus Keep Only the Event Action

> **Opened 2026-08-25** from queue item **1.23**, out of the 2026-08-24
> owner walk of [`owner-review-queue.md`](../owner-review-queue.md) § 1.
> Fully ruled; no open questions.

**Ruled:** *"trace rows shouldn't show the filtering; those are for the
trace panel, not a message. The create event item is accepted and works
fine."* Then, on where the picker lives instead:

> *"the button bar portion of the view is the only place I ever wanted
> those items to appear in the trace view."*

So there was never a question about keeping the affordance reachable — the
button bar is its home and always was.

## Work

- A right-click on a trace frame row **stops offering the sources picker**
  and any other panel-scoped filtering item.
- **Create event stays** on the row menu; it is accepted and works.
- The button bar keeps what it has. Nothing moves *into* it.

## Exit criteria

1. **A frame row's context menu offers the event action and nothing
   panel-scoped**, pinned by a test.
2. **The button bar's items are unchanged**, pinned by the test that
   already covers it.
3. **Queue row 1.23 struck** with the date.
4. **Full CI green** — six jobs, each named with its command.

## Status log

- 2026-08-27: Implemented. `TracePanel`'s frame-row right-click
  (`handleFrameContextMenu`) now renders a new, minimal `FrameRowMenu`
  (`apps/gui/src/TracePanel.tsx`) with just the create-event action —
  no sources checklist. A right-click that hits no row is unaffected:
  it still opens `SourcesContextMenu` (`apps/gui/src/SourcesPicker.tsx`),
  which lost its now-dead `rowAction` prop (it was TracePanel's only
  caller). New CSS shell `.trace-row-menu` / `.trace-row-menu-action`
  in `apps/gui/src/index.css`, mirroring `.sources-context-menu`'s
  look; the `--leading` divider variant that only `rowAction` used is
  removed. `TracePanel.dom.test.tsx`'s row-menu tests were rewritten
  test-first (watched red, then green) to assert the checklist is
  absent on a row and still present on a background right-click. The
  button bar itself is untouched, so its existing coverage stands
  unchanged (exit criterion 2).
- 2026-08-27: Queue row 1.23 could not be struck as written — see
  Blockers below for what was done instead.

## Blockers / side effects

- Exit criterion 3 ("queue row 1.23 struck with the date") is stale:
  `plans/owner-review-queue.md` was reframed 2026-08-26 from a
  numbered queue into a plain acceptance checklist keyed by task
  number, and no longer has any "1.23"-style row to strike — the
  reframe commit (`aaa1e77d`) already sits in this branch's history.
  Closest faithful reading: added this task to that file's
  `## Acceptance` list, the same way every other landed task is
  tracked there, so it's picked up on the next owner walk. No other
  action fit the file's current shape.
