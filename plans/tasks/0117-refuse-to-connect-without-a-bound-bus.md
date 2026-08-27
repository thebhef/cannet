# 0117 — Refuse to Connect Without a Bound Bus

> **Opened 2026-08-25** at the owner's instruction — *"loud fail. capture
> new task."* — from queue item **1.34**, out of the 2026-08-24 owner walk
> of [`owner-review-queue.md`](../owner-review-queue.md) § 1. Fully ruled;
> no open questions.

**Ruled:** *"we should refuse to connect if there's no busses in the
project, or if there's no interface assigned to the bus. We should also
default to there being one bus in a project."*

| | State today |
|---|---|
| No buses at all | **already refused** — but by the empty-binding-list guard, which tells the user to add a *binding* when what is missing is a *bus*. A message fix. |
| A bus with no interface | **the real gap.** The guard tests the list, not each bus, so any unbound bus in a multi-bus project is silently dead. `handleConnect` already has `buses` and a `busName` helper in scope. |
| A new project has a bus | **missing** — `handleNewProject` sets `setBuses([])`. |

## Work

- **Loud fail, per bus** — ruled 2026-08-25, over a disabled Connect.
  Consistent with the existing guard, and it can name the offending bus.
- **The empty-project message names the missing bus**, not a binding.
- **A new project starts with one bus, named `Bus 1`** — matching the
  existing Add bus control, which already names them
  `` `Bus ${buses.length + 1}` `` at
  [`ProjectPanel.tsx:442`](../../apps/gui/src/ProjectPanel.tsx#L442).

## Exit criteria

1. **Connecting with any unbound bus fails loudly and names it**, pinned
   by a test.
2. **The empty-project refusal names the bus**, pinned by a test.
3. **A new project has one bus called `Bus 1`**, pinned by a test.
4. **Queue row 1.34 struck** with the date.
5. **Full CI green** — six jobs, each named with its command.

## Evidence

[`App.tsx:1646-1652`](../../apps/gui/src/App.tsx#L1646-L1652) (the guard),
[`:1688-1689`](../../apps/gui/src/App.tsx#L1688-L1689) (`buses` and
`busName` in scope), [`:2071`](../../apps/gui/src/App.tsx#L2071)
(`handleNewProject`).
