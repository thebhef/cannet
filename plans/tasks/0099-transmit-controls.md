# Task 99 — Transmit Controls: One Idiom, One State

Opened by owner instruction 2026-08-20, from 0.9.0 usage feedback.
Three observations that are one question wearing three hats — **what
commands transmission, and how is its state shown?**

> - space to send idiom: in RBS rows, enables/disables transmission.
>   should send manual messages or start/stop periodic messages in TX
>   panel.
> - the RBS doesn't send messages with no cycle time, which is good.
>   The GUI should show that; the green dot is a weird additional
>   control we could get rid of.
> - The killswitch feature doesn't make sense to me. It just seems
>   redundant with the 'run' checkbox.

Grouped deliberately: fixing them separately would mean three
independent answers to "what does this control do", which is the
problem.

## Item A — the Space idiom stops at the RBS panel

The gridview already defines Space as *"the panel's primary action on
the cursor's row"* (`useGridview.ts`), and takes care to leave a focused
button alone so the press does not fire twice. In the RBS panel that
primary action is enable/disable.

The transmit panel has no equivalent. It has `sendOnce` and
`start_periodic_transmit` (`TransmitPanel.tsx`) driven only by buttons.
The owner wants the same idiom there: **Space sends a manual message,
or starts/stops a periodic one.**

The row's kind decides which — a periodic row toggles, a one-shot row
fires. That is the shape to confirm at grooming.

## Item B — the green dot, and showing "this cannot run"

Two different dots exist and only one is at issue:

- `bus.connected ? "rbs-dot rbs-dot-on"` — a bus connection indicator.
- `m.running && <span className="rbs-dot rbs-dot-on" title="scheduled" />`
  — the per-message scheduled indicator.

The second is the one to remove. The owner's substantive point is that
the *useful* fact is not currently shown: **a message with no cycle
time cannot run**, and the model already knows it —
`RbsMessageView.periodMs` is documented as *"Effective period (override
else `GenMsgCycleTime`); `null` = none anywhere, the message can't
run."* So the host has the fact and the GUI shows a dot for the
opposite condition.

Replace the dot with a legible statement of why a row will not
transmit. The RBS signals grid (task 89 phase 6) already established a
status vocabulary for a related question — **Muted** is defined there
as "the message won't play regardless of what it carries" — and the
same vocabulary should serve here rather than a second one.

## Item C — the kill switch versus 'run'

`rbs_set_kill_switch` sets `rbs.kill_switch`; the panel renders a
"Kill-switch ON" button. Separately the element carries `run`, a
persisted project field, and `RbsMessageView.running` is documented as
`run && enables && !kill-switch`.

So there are two global stops in series, and the owner cannot tell them
apart. The distinction that presumably motivated the kill switch is
persistence: `run` is written to the project and survives a reload,
while the kill switch is session-scoped and instantaneous. Whether that
distinction is worth a second control is exactly what the owner is
questioning.

**Note for sequencing:** task 88 phase 7 is adding a third way
transmission stops — an RBS element and its periodics stop when a
referenced database reloads. That lands first and this task inherits
it, which strengthens the case for one coherent story about stopping.

## Open questions — grooming

- ~~Remove the kill switch, or keep it and explain it?~~ **Resolved
  2026-08-20 (owner), and wider than the question asked:**

  > Let's lose it and the persisted run state. RBS run should be off on
  > project load, but doesn't need to be cleared by connect/disconnect,
  > unless a new DBC is loaded that impacts the signal keys/RBS mapping
  > panel.

  Four separate changes, each to be implemented deliberately:

  1. **The kill switch goes.** `rbs_set_kill_switch`, `rbs.kill_switch`,
     the `killSwitch` field on the view, the panel button and the
     `rbs.killSwitch` palette command. `running` reduces to
     `run && enables`.
  2. **`run` stops being persisted.** It is currently a field on the
     RBS project element, written to the project file. It becomes
     session state. Per the repo's standing principle on removing a
     feature, this is a clean removal — no migration path and no
     legacy read of the old field; an existing project carrying it is
     simply ignored.
  3. **Run is off on project load.** Which follows from (2), and is the
     safety property the kill switch was carrying: opening a file can
     no longer put frames on a bus.
  4. **Connect / disconnect does not clear run** — a user who armed the
     RBS and reconnected an adapter has not changed their intent.
  5. **Loading a DBC that changes the signal keys / RBS mapping does
     clear run.** The mapping the user armed is no longer the mapping
     that would transmit.

  **Interaction with task 88 phase 7 — check before implementing.**
  Phase 7 (landing ahead of this task) stops RBS elements and periodic
  transmit rows when a referenced database is *reloaded in place*. Item
  5 above is a **superset**: it also covers a newly *loaded* database
  that changes which definition wins for a signal the element
  transmits. So this task extends phase 7's trigger rather than
  duplicating it, and must reuse phase 7's stop path — there must not
  be a second way an RBS element stops.

  **Expect to remove work task 88 phase 7 just added.** Phase 7 landed
  a commit making the project's persisted RBS Run flag follow the host
  when a reload stops an element — correct under today's model, where
  `run` is persisted. Item 2 above deletes that persistence, so part of
  phase 7's handling becomes dead and should be removed here rather
  than left behind. That is the ordinary consequence of a ruling
  arriving after the code, not a phase-7 defect: both land in the same
  release.

  **What "impacts the signal keys / RBS mapping" means** needs pinning
  to something testable rather than judged per case. The natural
  measure already exists: the resolution rule of
  [ADR 0054](../../docs/adr/0054-a-decoded-value-has-one-definition.md)
  — if the winning definition for any signal the element transmits
  changes, the mapping changed. Task 89's mapping panel and task 92's
  shared resolver are where that question is already answered; use
  them rather than inventing a third answer.

- ~~What does Space do on a transmit row?~~ **Resolved 2026-08-20
  (owner): send / toggle, exactly as described.** A one-shot row sends
  once; a periodic row starts or stops. One idiom across both panels,
  no special case.

  **No connection guard is needed, because there is no hazard to guard
  against.** Owner: *"when there's no bus connected, there's nowhere to
  send the message. It doesn't get queued up. You can still toggle
  periodics, but we're just gonna silently not send."* So the rules
  are: Space is always live; a send with no session is a **no-op, not
  an error and not queued**; toggling a periodic still changes its
  state, it simply produces no frames until a bus exists.

  Note for the implementing phase: `TransmitPanel.tsx` already gates
  `sendOnce` on `isConnected`, so the no-op behaviour largely exists —
  confirm it rather than rebuild it, and make sure the periodic toggle
  path behaves the same way (state changes, nothing emitted).

- ~~Does removing the scheduled dot lose anything?~~ **Decided by the
  overseer 2026-08-20: replace it with a status column, not nothing.**
  A running row must still look different from a stopped one — the dot
  is a bad affordance, not a useless one. The replacement is a status
  cell using the vocabulary the RBS signals grid already established
  (task 89 phase 6): the same column says *Muted* for a message that
  cannot run at all, which is exactly the owner's "the GUI should show
  that" for a message with no cycle time. One column answers both
  questions; a dot answered neither well.

## Exit criteria (draft — firm at grooming)

- Space performs the transmit panel's primary action on the cursor's
  row, and does not double-fire on a focused button.
- A message that cannot run says why, in the vocabulary the RBS signals
  grid already uses; the scheduled dot is gone but running state is
  still legible.
- There is exactly one answer to "how do I stop transmitting", and the
  reasons a transmission stops — user, unassign, remove, reload, and a
  newly loaded database that changes the mapping — are consistent
  between the RBS panel and the transmit panel, and all reach the same
  stop path.
- The kill switch is gone: no command, no state, no button.
- `run` is not persisted; opening a project never transmits. Tested.
- Connect and disconnect leave `run` alone; tested.
- README reflects whatever the controls now are.
