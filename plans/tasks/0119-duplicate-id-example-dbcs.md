# 0119 — Example DBCs for the Duplicate-Id Collision

> **Opened 2026-08-25** from queue item **1.33a**, out of the 2026-08-24
> owner walk of [`owner-review-queue.md`](../owner-review-queue.md) § 1.
> **A deliverable for the owner to review against, not a behaviour
> change.**

**Said:** *"I wasn't expecting changes to the database for this. I'll need
to review."* Then, on what reviewing needs:

> *"I need example DBCs to test with"*

**The behaviour under review:** where two databases assigned to one bus
define the same message id, the Database panel marks the **loser** and
leaves the winner unmarked.

## Work

Two DBCs that collide on one bus, under
[`examples/`](../../examples/) beside the existing sets (`ev-zonal`,
`ev-demo`, `extrapolation`, `time-origins`), plus a project that assigns
both to the same bus so the collision appears on open.

Then a short recipe: open the project, look here, this is what is marked
and this is what is not.

## Open

- **Does this get its own example set, or extend an existing one?**
  Recommend its own small set — extending `ev-zonal` would change the
  project the perf harness measures ([ADR
  0031](../../docs/adr/0031-gui-performance-automation-self-driving.md)), and a baseline can
  outlive the project it describes.
- **How much of a real bus should the DBCs carry?** Recommend the minimum
  that shows a collision and a non-collision side by side, so the marking
  rule is legible rather than buried.

## Exit criteria

1. **Opening the example project shows the collision** in the Database
   panel, in a running build.
2. **The recipe is written down** — where to look, what is marked, what is
   not.
3. **The perf harness's project is untouched.**
4. **The owner has looked**, and queue row 1.33a is struck with their
   verdict — accept the marking as-is, or a follow-up task.
