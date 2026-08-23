# Task 99 — Transmit Controls: One Idiom, One State

> **Status 2026-08-23 — code-complete, awaiting acceptance.** Landed
> 2026-08-21 on the chain (nothing has merged). The seven exit criteria
> are walked at `## Exit-criteria walk`, all met. **Its acceptance was
> blocked** by task 109 item 7: this task took "Space already works in the
> RBS panel" as a premise, and the premise was false. Task 109 phase 3
> landed the fix and the regression test on 2026-08-23, so the block is
> lifted. Findings still owed a verdict: owner-review-queue 1.10
> (resolved), 1.11, 1.12.

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

## Exit-criteria walk (2026-08-21, branch `task-99-transmit-controls`)

The criteria above were marked *draft — firm at grooming*; treated as
firm and walked one by one.

| Criterion | Verdict | What earns it |
| --- | --- | --- |
| Space performs the transmit panel's primary action on the cursor's row, and does not double-fire on a focused button | **met** | `TransmitPanel.dom.test.tsx`: *Space starts and stops a periodic row instead of sending it*, *Space stops a periodic row that is already running*, and the pre-existing *Space sends the cursor's frame once*. The focused-button exemption is the gridview layer's and is unchanged — `useGridview.dom.test.tsx`'s *leaves Space to a focused button inside a row*. |
| A message that cannot run says why, in the vocabulary the RBS signals grid already uses; the scheduled dot is gone but running state is still legible | **met** | `rbs/view.rs`'s five `message_status` cases, and `RbsPanel.dom.test.tsx`: *says why a row will not transmit, in the signals grid's vocabulary* (which also asserts no `.rbs-dot` is left on a message row), *reads Stopped for a row that could run but is not scheduled*, *reads Running for a scheduled row*. |
| There is exactly one answer to "how do I stop transmitting", and the reasons — user, unassign, remove, reload, and a newly loaded database that changes the mapping — are consistent between the two panels and all reach the same stop path | **met** | `stop_periodic_transmit_inner` still has exactly three callers (the user's Stop, the assignment rule, the reload rule), checked by grep over the crate. Every DBC-set reason now shares one tail, `report_periodics_stopped`, which is also the single place an RBS element is stopped with its rows. The RBS side of a user stop and of a project open is `sync_schedules`, the path the Run toggle has always taken. |
| The kill switch is gone: no command, no state, no button | **met** | A grep for `kill-switch` / `killSwitch` over `README.md docs/ apps/gui/src apps/gui/src-tauri/src crates/` returns nothing. |
| `run` is not persisted; opening a project never transmits. Tested | **met** | Host: `opening_a_project_leaves_no_element_running` (`stop_all_elements`, wired into `open_project` and `close_project`). Frontend: `projectElements.test.ts`'s *normalises an rbs element: path string-or-null, and no run flag at all*, which pins a legacy `run: true` as dropped on load. |
| Connect and disconnect leave `run` alone; tested | **met, with a stated limit** | `connecting_and_disconnecting_a_bus_leave_run_alone` registers a real vbus session over the element's bus and then unregisters it — what the disconnect command does to host state — and asserts the flag and the row's running state on both sides. It cannot drive the `#[tauri::command]` wrappers (the crate has no tauri test harness), so it exercises the state transition rather than the two commands. |
| README reflects whatever the controls now are | **met** | The RBS Run bullet, a new message-status bullet, the transmit Send/cycle bullet's Space paragraph, and the rewritten *Changing what a bus applies stops what it was driving*. |

### Blockers / side effects

- **The perf harness's load was a project field, and is now a flag.**
  ADR 0031's render-tier run generated its bus traffic from the example
  projects' `"run": true` — which is exactly the open-a-file-and-transmit
  the ruling forbids. Removing persistence disarmed it silently: a gate
  run would have connected to an idle bus and reported rates that read
  as a catastrophic regression. Fixed in `a4009bbb` with
  `--rbs-run-on-start`, and the dead field removed from
  `examples/ev-zonal` and `examples/ev-demo`. **The overseer's next gate
  run must pass the new flag**; without it the numbers are meaningless
  rather than merely wrong. No gate was run here (the brief reserves
  it).
- **A landed phase-4 behaviour changed deliberately.** Unassigning a
  database now clears a running RBS element's Run instead of letting the
  row rebuild bring it back. Task 88 phase 4 recorded that asymmetry
  with a reason — `run` was the project's flag mirrored onto the host,
  so the host could not clear it without desynchronising the project —
  and that reason no longer exists. Recorded as a decision, not a
  drive-by.
- **`start` on a transmit row is no longer disabled by a disconnected
  bus.** Not named in the criteria. Left as it was, it would have
  refused what Space now accepts, which is the "two answers for one
  control" this task exists to remove. `send` stays locked, because it
  performs an act rather than a state change.

## Status log

### 2026-08-21 — (branch `task-99-transmit-controls`)

Branched from `task-94-server-defaults` at `71835029`. Five commits,
each green on the full gate before committing (`--no-verify`, with the
hooks' work run by hand first, for the reason task 88 phase 2 recorded).

| commit | subject |
| --- | --- |
| `8c4ec94a` | The RBS kill switch is gone and Run stops being persisted |
| `038623ff` | Space sends a transmit row, or starts and stops a periodic one |
| `2f75f46d` | An RBS message row says whether it will transmit, and why not |
| `9cb6df44` | A database applied over the top of a running row stops it |
| `a4009bbb` | A measurement launch arms the simulation with `--rbs-run-on-start` |

Counts. Rust `cannet-gui` **837 → 850** (6 ignored throughout);
`cargo test --workspace` 47 binaries, 0 failures. Frontend **2499 across
190 files → 2504 across 189** — one file fewer because
`App.rbsRunStopped.dom.test.tsx` went with the behaviour it covered.
`cargo clippy --workspace --all-targets` clean but for the pre-existing
`redundant_closure` in `crates/cannet-dbc/src/tests.rs`; `cargo fmt
--all -- --check`, `tsc --noEmit` and `vite build` clean.

#### What "a DBC load that changes the mapping" resolved to, and the control that proves it

**Observation.** Three stop rules existed. `stop_periodics_left_unbacked`
(unassign / remove) stopped a firing row once *no* database assigned to
its bus defined its message. `stop_periodics_driven_by` (reload) stopped
a row the reloaded path was driving either side of the swap. Neither
fires when a database is *applied* to a bus and outranks the one a row
is transmitting from: `assigning_a_database_stops_nothing` pinned that
as correct, on the grounds that growing a bus's candidate list cannot
take a candidate away.

**Hypothesis.** Growing the list *can* take the candidate away — not the
existence of a definition, but the winning one. Under ADR 0054 the
message's definition on a bus is the first eligible database in load
order, so a database applied ahead of the incumbent becomes the new
winner and the next frame out carries an encoding the user never armed.

**Experiment.** Two DBCs defining the same message with different signal
factors, `first.dbc` loaded ahead of `second.dbc`. A running row on a
bus `second.dbc` is assigned to; then `first.dbc` is assigned to the
same bus. Against it, two controls that a "stop on any DBC touch" rule
would fail: the **same gesture with the load order swapped** (the newly
applied database defines the message and still loses the contest), and
the **same database applied to a bus the row does not live on**.

**Data.** Before the change: the positive case reported `[]` (red), both
controls `[]` (green). After: positive `["row"]`, controls `[]`. The RBS
counterparts behave identically —
`a_database_assigned_over_the_top_stops_the_rbs_element_it_took_over`
and `a_database_assigned_that_wins_nothing_leaves_the_rbs_element_running`
— and the element case additionally asserts the row stays stopped
through the rebuild the announcement runs, which only a stopped
*element* produces.

**Conclusion.** The measure is the winning definition, asked either side
of the gesture, and it lives in the function unassign and remove already
call — `stop_periodics_whose_backing_changed`, now taking the path the
gesture names. No fourth stop was written:
`stop_periodic_transmit_inner` still has exactly three callers.

**One case is deliberately outside the rule**, and it is the one that
made phase 4's `a_row_another_assigned_database_still_defines_keeps_firing`
go red on the first, wider implementation: the winner *falling back* to
a database the bus was already applying, when the one in front of it is
unassigned. The owner's ruling is about a DBC being **loaded** —
*"unless a new DBC is loaded that impacts the signal keys/RBS mapping
panel"* — and the brief warns that erring permissive is worse than the
bug. A fallback brings nothing new into the picture; it is the
resolution rule doing what it always does. So the rule fires on "nothing
applies it any more" or "the database this gesture names took it over",
and phase 4's decision stands.

#### Is removing persisted run a schema change? No.

The Rust project model holds elements as `Vec<serde_json::Value>`
(`project.rs`), so nothing about `PROJECT_SCHEMA_VERSION` moves and an
older file parses unchanged. The field lived only in the frontend's
`ProjectElement` type. An old project carrying `"run": true` therefore
loads fine and the flag is inert — and `normalizeElement` now *drops* it
rather than spreading it through, so it cannot be written back out
either. Pinned by *normalises an rbs element: path string-or-null, and
no run flag at all*. No migration, no legacy read, per the standing
principle on removing a feature. The two example projects carried the
field and were cleaned in `a4009bbb`.

#### Tests turned around, and why

Six, each deliberately:

- `rows_register_and_schedules_follow_the_anded_enables` lost its
  kill-switch leg — the control it exercised no longer exists.
- `normalizeElement`'s *run strictly boolean* became *no run flag at
  all*, and gained the legacy-field case as its replacement assertion.
- `RbsPanel`'s *pushes the Run flag through the element model
  (project-persisted)* became *writes Run straight to the host, and
  reads it back off the view* — same gesture, opposite ownership, and it
  also asserts the panel writes **nothing** to the project element.
- *drops an RBS element's path and run flag* became *drops an RBS
  element's path*; the mask's job is unchanged, its subject is one field
  smaller.
- *Space sends nothing when the frame's bus is not connected* became
  *Space is not guarded on a connection: the send is a silent no-op, the
  toggle still lands*. The owner ruled the guard out; the no-op half it
  was really asserting is kept and the periodic half is added.
- `App.rbsRunStopped.dom.test.tsx` was deleted with the effect it
  covered — App writing `run: false` onto the project element when the
  host stopped one. With a single copy of the flag there is nothing to
  keep in step. `App.elementUndo.dom.test.tsx`'s host stub grew a Run
  flag instead, because the panel's checkbox now reads the host.

#### Red observed, including where a passing test proves nothing

Every behavioural change was written test-first. Two of the tests pin
behaviour that already held, so a green first run would have proved
nothing; both were falsified with a throw-away mutation of the shipping
code, then the mutation reverted:

| test | mutation | result |
| --- | --- | --- |
| `connecting_and_disconnecting_a_bus_leave_run_alone` | `unregister_sessions` clears every Run flag | red on *disconnecting must not clear Run* |
| the three transmit-panel Space cases | `onPrimaryAction`'s periodic branch removed | all three red |

`git diff` on `session.rs` and `TransmitPanel.tsx` after reverting each
mutation was empty.

#### The signals grid's Muted was left alone, on purpose

The overseer's decision was that the message row's status column should
use the vocabulary the RBS signals grid established, and *Muted* carries
the same meaning in both. Folding the new "no cycle time" condition into
the **per-signal** grid's own `muted` was considered and rejected: that
grid answers where a value came from, not whether the message plays, and
the change would have reclassified every field of every message whose
DBC declares no `GenMsgCycleTime`. Measured rather than assumed: adding
the condition to `build_rbs_signal_rows` turns two of that module's four
cases red (`statuses_reflect_the_encoders_own_report`,
`a_bad_enum_label_reads_unknown_value_not_not_encoded`) — every field of
a message whose DBC gives no cycle time reclassifies from Default /
Unknown Value to Muted. One word, two questions, each answered where it belongs.
