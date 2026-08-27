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
