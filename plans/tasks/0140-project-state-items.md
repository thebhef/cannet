# 0140 — Project State Items

> **Opened 2026-09-06** by owner instruction. **Queued behind the
> in-progress 136 → 137 → 135 stack and task 139** (owner: "we won't
> probably do this until after our work in progress is landed").
> **Needs grooming and a prototype before implementation.**

The ask, in the owner's words:

- add start/stop to RBS and logger items in the project view;
- add a section to the top-level status strip, right-aligned, of
  recently active logger and RBS items — needs prototyping.

## Open questions (for grooming at pickup)

1. **Start/stop vs follows-the-connection.** Task 137 ruled that a
   logger writes exactly while its buses are connected. What does a
   manual stop mean against that — an override latch ("don't log even
   though connected"), and does start while disconnected arm or error?
   Same question for RBS items and their current activation model.
2. **"Recently active".** Definition (currently running? ran this
   session? ran in the last N minutes?), ordering, and cap.
3. **Prototype.** The status-strip section wants an artifact-page
   prototype like `plans/prototypes/export-dialog.html` before
   implementation — layout, affordances (click = goto panel?
   start/stop inline?), and overflow behaviour.

## Phases

(after grooming)

## Exit criteria

(after grooming)

## Status log

(none yet)

## Blockers / side effects

(none yet)
