# Task 109 — Usage Feedback From the Chip-Era Build

Opened by owner instruction 2026-08-22, from test-driving the branch
chain that carries tasks 101 / 106 / 19 / 108. Ten observations: three
defects, two surfaces that say too much, three project-management
affordances that do not exist as buttons, and two panels that do not
behave like the grid rows they sit on.

## Status

Groomed with the owner 2026-08-22. Six phases. Phases 1 and 2 landed;
see the status log.

Two of the observations are **acceptance blockers for tasks already
finished** (owner-review-queue § 4) and are carried here rather than
reopening those tasks:

- **Item 2 blocks task 101.** Its hardware verification
  (owner-review-queue 3.14) was run and failed.
- **Item 7 blocks task 99.** It shipped on a premise this observation
  falsifies.

## The observations, as reported

Verbatim, so the record keeps the owner's own words:

1. signals view contains nothing if no signals need attention (does this
   need to have existed when views were created in the project to get
   populated?)
2. I unplugged the PEAK dongles and did not observe any indication that
   there was an issue with the bus. One side's utilization dropped to 0
   and the other remained pretty steady. the pack bus trace continued
   getting updates like it thought it was sending
3. I wanted the labels with the frames/second, bus load, etc. in the
   status panel to be left justified. I don't think we need the
   "streaming from 1 server (2 interfaces)" type label when we're
   connected. I still want that UI when we're loading a trace
4. (new) we should have a new project button in the top level button bar
   and palette
5. (new) we should have a recent projects list in the top level button
   bar and palette
6. save as button as a submenu of the save button. clicking on the save
   button should just save though
7. spacebar still doesn't activate/deactivate rbs messages, it scrolls
8. seeing weird highlighting during keyboard nav in the trace panel; the
   entire box gets highlighted on leftarrow
9. disconnect all button in the project view seems redundant or
   misleading - just remove it
10. signals should behave like grid rows too; they're still kinda awkward

## Grooming (overseer + owner, 2026-08-22)

Read the code first, so the phases implement rather than discover.

### 1 — the view-signals panel is empty

The panel is `ViewSignalsPanel.tsx`, fed by the host's
`view_signals.rs` registry, which the **frontend pushes to** —
`viewSignalsPush.ts`'s `usePushViewSignals`, called by every view that
references signals, on mount and on config change, un-pushing on
unmount.

Three hypotheses were ranked before the owner ruled. Two survive as
things the phase still has to check; the middle one the owner has now
decided rather than investigated.

- **Not the status filter.** `viewSignalsFilter.ts` is explicit that
  "nothing selected is no filter", so an empty status selection cannot
  produce an empty grid. The attention count is a badge, not a filter.
- **Pattern-selected signals are never pushed** — by design, in the
  module's own words: *"A **pattern** … is re-evaluated against the
  live catalog on every render — it has no recorded configuration for
  the database to have drifted from, and it cannot go stale the way a
  manual pick can, so it is never pushed."* A project whose views
  select signals by pattern therefore has an empty panel, which is the
  reported symptom.
- **The owner's parenthetical** — a push that only happens for views
  mounted after the panel exists. The hook's `useEffect` runs on mount
  regardless of whether the panel exists, so this is unlikely, but it
  is cheap to falsify and must be falsified rather than argued away.

**Owner ruling 2026-08-22: the pattern exclusion is wrong.**
*"May be the pattern-based exception you mentioned but I think the
exception is wrong. Those fields do dynamically update but I still
want them in the list."* The owner grants the premise — a pattern's
matches do re-evaluate live — and rejects the conclusion drawn from
it. A signal a view is actually using belongs in the list of signals
that view uses, whether the view named it or matched it.

This is cheaper than "a model change" made it sound, because the wire
shape already carries the case:

| Fact | Where |
|---|---|
| `messageName` and `unit` on a `ViewSignalRef` are already `Option<String>` | `view_signals.rs:121`–`123` |
| identity-only refs already ship — the colormap target and a transmit frame's counter/CRC signal push no recorded fields | `colorMapViewSignalRefs`, `transmitViewSignalRefs` |
| the host already handles them: `serving.is_none()` → Not Decoded, and the drift comparison only runs where a recorded field exists | `view_signals.rs:498`, `:543`–`:557` |

So a pattern-resolved row pushes as **identity only** and needs no
host change. It can read Decoded, Not Decoded or Ambiguous, and never
Scale or Stale — which is correct rather than a gap, since there is no
recorded comparand for it to have drifted from. That property is the
thing to write down in the module doc, which currently records the
opposite decision and must be rewritten in the same commit.

The work is frontend-side and lands in the pure builders, where it
stays unit-testable: `plotViewSignalRefs`, `signalsViewSignalRefs` and
the signal-generator rule case take the view's **resolved matches**
alongside its persisted picks, instead of the persisted picks alone.
Pattern resolution already happens inside the panels against the live
catalog; the builders receive its output.

Three consequences the phase owns:

- **The attention badge counts pattern rows.** A pattern matching a
  signal no database serves now contributes to `attention_count`.
  Wanted — that is the panel's job — but it is a visible change to a
  shipped number.
- **Row count follows pattern breadth.** A wide pattern puts every
  match in the panel. Check the grid at a realistic breadth rather
  than assuming.
- **Re-push churn is bounded but real.** Matches change whenever the
  catalog does — a DBC loads, a bus assignment changes. The hook
  already skips a re-push that is equal by value
  (`usePushViewSignals`'s `lastSent`), so churn tracks actual change;
  confirm that holds when the input is a resolved set rather than a
  stored list.

**The symptom still has to be confirmed cured.** The ruling settles
what belongs in the list, not that the exclusion was the whole cause.
If the owner's project populates after this change, the third
hypothesis dies with it; if it is still empty, that hypothesis is live
and the phase follows it.

### 2 — the unplugged PEAK dongle

Task 101 shipped bus health: `InterfaceState` with controller state and
TEC/REC, `busError` events, host-side bus load, the panel. **This
observation is that task's hardware verification, and it failed.**

Three symptoms, possibly three causes:

| Symptom | What it implicates |
|---|---|
| no indication the bus is gone | does python-can / the PEAK backend report device removal at all, and does the sidecar forward it as an `InterfaceState` transition? |
| one side's utilization → 0, the other steady | is the "steady" side a stale last-value rather than a live reading? Bus load is host-derived — from what, when frames stop arriving? |
| the pack bus trace kept getting updates "like it thought it was sending" | RBS transmits into a dead interface and the loopback / echo path still produces trace rows |

The third is the most serious: **the trace shows traffic that never
reached a wire.** That is wrong data on screen, not a missing
indicator, and it is what makes this a defect rather than a polish
item.

**Investigation-first, and the final confirmation needs the owner's
hardware.** No PEAK dongle exists in an agent's environment. A phase
can reproduce the sidecar half against a virtual bus torn down
mid-stream, and can read what python-can's PEAK backend does on device
removal — but the closing check is owner-run, and can be scheduled at
any point after the phase reports.

### 3 — the status bar's read-out

**Owner ruling 2026-08-22:** *"the connect/disconnect chip and bus
health should carry that info at least transiently. As should system
log. We don't need those labels there."*

So `statusLine.ts` loses **both** its remote-session strings:

- the resting line at `:119`,
  `` `Streaming from ${n} server${…} (${m} interface${…})` ``
- the transient notice at `:121`–`:133` (`N connecting`, `N errors
  (address: message)`)

Verified before the ruling was taken, so this is a removal and not a
removal-plus-plumbing:

| Destination | Already carries it | Evidence |
|---|---|---|
| connect/disconnect chip | yes, **resting** rather than transient — `idle` / `connecting` / `degraded` / `failed` (label "Failed", action "Retry"), a `connected / bound` count, and a per-bus tooltip naming why a bus failed | `connectionStates.ts` `summarizeConnection` |
| system log | yes — `session.rs` logs under source `connection` at error level: `failed to connect to {address}: {msg}`, plus subscribe failures | `session.rs:417`, `:501`, `:507` |
| bus health | shipped by task 101; whether it transitions on device removal is **item 2's open question** | — |

Two consequences, both accepted under the ruling:

- **The interface count disappears entirely.** The chip counts buses
  (`connected / bound`), not interfaces, and nothing else reports "2
  interfaces".
- **A server-level failure has no chip detail.** A connect that fails
  before any bus gets state (TCP refused, trust rejected) leaves the
  chip reading `Not connected` with no reason; the reason is in the
  system log only, findable via that chip's unread badge. The log is
  load-bearing for that case rather than a duplicate — which is what
  "as should system log" grants.

**What stays**, per *"I still want that UI when we're loading a
trace"*: the file-progress resting lines — `Loading … `, `Opening … `,
and `Streaming <path>` (`:146`) — and everything the census and import
put in the bar.

**Left justification** is the metrics row's layout in `StatusBar.tsx`;
the metrics themselves are built at `statusLine.ts:201` (`f/s`) and
`:204` (bus load).

### 4, 5, 6 — the project affordances

- **New project already exists** as `handleNewProject`
  (`App.tsx:2023`), but the palette spells it **`project.close`**
  (`App.tsx:2929`), which is why it does not read as "New Project". It
  needs a top-level chip and an honestly-named command. Renaming a
  command id is a user-visible change to the palette — take it, and say
  so.
- **Save As already exists** as `project.saveAs` (`commands.ts:124` →
  `handleSaveProjectAs`). What is missing is the split-button shape:
  pressing Save saves; a disclosure beside it offers Save As. Per the
  owner, *"clicking on the save button should just save"* — the
  disclosure must not swallow the primary press.
- **Recent projects do not exist**, and are **user state** (owner
  ruling 2026-08-22). ADR 0042 § 3's scope table places them exactly:
  user scope (`app_config_dir`) holds *last project* and the palette
  MRU; workspace scope holds recent BLFs. So recent projects are
  **user-scope state**, the sibling of `last_project`
  (`state::user_scope_last_project`) — not `settings.json`, because
  ADR 0034's deciding question is *"a behavioural preference, or a memo
  about specific files and sessions?"* and a project list is a memo
  (`blf_channel_maps` is the ADR's worked example of user-authored
  state that is still state).

  The **bound** is a setting, following the shipped
  `recent_blfs_limit` / `recent_commands_limit` pattern
  (`settings.rs:84`–`85`, `Scope::UserOverridable`).

All three are top-level-bar work in task 108's chip language, so they
land after 108.

### 7 — Space in the RBS panel

**Task 99 is implemented** (owner-review-queue § 4), and it shipped on
a premise this observation falsifies. Its own text:

> The gridview already defines Space as *"the panel's primary action on
> the cursor's row"*… In the RBS panel that primary action is
> enable/disable. The transmit panel has no equivalent.

So 99 added Space to the **transmit** panel (`038623ff`) and took RBS
as already working. It is not. The premise was never tested.

Consistent with that: `RbsPanel.tsx` does sit on the gridview layer
(`makeRbsRowSpace` / `arrayRowSpace`, `:265`–`:277`), but each row's
enable control is a plain `<input type="checkbox">` (`:580`, `:622`,
`:733`) rather than a row action, so Space reaches the scroll
container. The fix lands with a test that would have caught the
premise.

### 8 — the trace panel's ArrowLeft highlight

`gridviewRows.ts:176` handles `ArrowLeft` (collapse / move to parent);
`useGridview.ts:35` lists it among the keys the grid claims. "The
entire box gets highlighted" is a focus or selection artefact — either
focus lands on a container carrying a visible ring, or ArrowLeft moves
to a parent row whose selected styling spans the whole box.

**Investigation-first**, with a DOM-level reproduction before any CSS
change. jsdom does no layout, so the reproduction pins the focused
element and its classes, not its appearance.

### 9 — "Disconnect all" in the project view

It is **one button with two states**, not two
(`ProjectPanel.tsx:525`–`532`): `Connect all` when disconnected,
`Disconnect all` when connected. Task 103 moved connection state to the
status-bar chip, which already offers both actions — hence "redundant".

**Owner ruling 2026-08-22: the whole button goes.** *"let's remove that
from the project? it's redundant with the status bar start/stop now."*
Not just the Disconnect state — both halves. Connection is commanded
from the status-bar chip, and only from there.

The chip is already independent of the project view: pressing it runs
`connection.connect` / `connection.disconnect` as commands
(`App.tsx:3572`), not through `projectContext`. So the removal takes
nothing with it, and three things follow:

- **`p.onConnect` and `p.onDisconnect` become orphans.** `ProjectPanel`
  at `:526` / `:530` is their only consumer; `projectContext.ts:96`–`97`
  declares them and `App.tsx:3326`–`3327` supplies them. Remove the
  whole chain — the handlers themselves (`handleConnect`,
  `handleDisconnect`) stay, because the commands the chip runs still
  need them. `p.remoteConnected` has other consumers and stays.
- **The empty-state copy names a control that will not exist.**
  `ProjectPanel.tsx:518`–`520` reads *"No interfaces selected. Pick one
  on a logical bus above to enable Connect."* It has to point at the
  status bar instead.
- **`Manage servers…` is now alone in `.project-buttons`.** Check that
  the row still reads as intentional with one button in it rather than
  as a leftover.

### 10 — RBS signals should behave like grid rows

**Owner clarification 2026-08-22: this is the signals view inside the
RBS panel** — `RbsSignalsPanel.tsx` — not the trace's expanded signal
list and not `ViewSignalsPanel`.

Phase 5 of task 108 restyled that panel's toolbar and deliberately left
its rows alone (its status filter keeps a bespoke six-colour swatch —
see 108's blockers). The rows themselves have never been on the
gridview layer. "Behave like grid rows" means what the layer already
gives every other panel: a row cursor, keyboard navigation, selection,
and Space as the row's primary action.

Grouped with item 7: same panel family, same layer, and the two would
otherwise fight over what Space means in an RBS context.

## Open questions

None. Grooming closed 2026-08-22.

## Phases

| # | Phase | Model | What lands |
|---|---|---|---|
| 1 | Surfaces that say too much | Sonnet | Items 3 and 9. `statusLine.ts` drops both remote-session strings, keeping every file-progress line; the metrics row left-justifies in `StatusBar.tsx`; the project view loses its Connect-all / Disconnect-all button entirely, along with the `onConnect` / `onDisconnect` chain through `projectContext` it orphans, with the empty-state copy repointed at the status bar. Tests pin that a failed connect is still reachable — chip state `failed` and a `connection`-source system-log entry — so the removal cannot silently lose it. |
| 2 | The unplugged dongle | Opus | Item 2, investigation-first, no fix without the confirming experiment. Reproduce the sidecar half against a virtual bus torn down mid-stream; establish what python-can's PEAK backend reports on device removal; determine whether bus load holds a stale last value and whether RBS transmit into a dead interface produces trace rows. Ships whatever fix the data supports. The closing hardware check is owner-run and may be scheduled any time after this phase reports. **Unblocks task 101's acceptance.** |
| 3 | The RBS panels become grid rows | Opus | Items 7 and 10. `RbsSignalsPanel`'s rows adopt the gridview layer (cursor, keyboard, selection, Space); `RbsPanel`'s message rows get Space bound to enable/disable, with the test task 99 never wrote. One idiom across both panels. **Unblocks task 99's acceptance.** |
| 4 | The project affordances | Opus | Items 4, 5 and 6, all in task 108's chip language. New Project as a chip and an honestly-named command; Save as a split chip whose primary press saves; recent projects as user-scope state beside `last_project`, bounded by a new `recent_projects_limit` setting, surfaced in both the bar and the palette. |
| 5 | The keyboard-nav highlight | Opus | Item 8, investigation-first. A DOM-level reproduction pinning the focused element and its classes on ArrowLeft, then the narrowest fix the data supports. |
| 6 | The view-signals panel reads empty | Opus | Item 1. Pattern-matched signals join the list, per the owner ruling: the pure builders take each view's resolved matches as well as its persisted picks and push them identity-only, and `viewSignalsPush.ts`'s module doc is rewritten to record the decision it now carries the opposite of. No host change expected — confirm that. Then verify the reported symptom is gone; if the panel is still empty, the mount-order hypothesis is live and the phase follows it to a verdict. |

Phases 2 and 5 — and phase 6 if its symptom survives the ruled
change — follow the scientific method into the status log:
observation → hypothesis → experiment → data → conclusion, and no root
cause or fix without citing the experiment whose data confirmed it.

## Exit criteria

1. Each of the ten observations has either a landed fix with a test, or
   a recorded verdict explaining why no change was made.
2. Items 2 and 7 have verdicts good enough to unblock tasks 101 and 99
   in owner-review-queue § 4.
3. The investigations (items 2 and 8, and item 1 if the panel is still
   empty after the ruled change) each carry a full observation →
   conclusion chain in the status log, with the confirming experiment
   named.
4. No regression in the ADR 0031 harness beyond the owner's thresholds,
   and a reading taken for any phase touching a render or data path.
5. Docs move with the code: ADR 0042 / 0034 gain nothing new unless the
   recent-projects work diverges from their scope table, in which case
   the divergence is an ADR amendment, not a silent choice.

## Status log

**2026-08-22 — Phase 1 (Surfaces that say too much), items 3 and 9.**
Branch `task-109-phase-1-quieter-surfaces` off
`task-107-phase-5-highlight-extent`.

- Item 3: `statusLine.ts`'s `splitStatus` no longer builds the
  `Streaming from N server(s) (M interfaces)` resting line or the
  `N connecting` / `N error(s) (address: message)` transient. A
  remote session still keeps the idle prompt from showing while one is
  running (blank resting instead), and a session with nothing running
  still falls back to the idle prompt exactly as before — but there is
  no longer any text about what the session is or why it failed. That
  now lives solely on the connect/disconnect chip
  (`connectionStates.ts`'s `summarizeConnection`) and the system log
  (`session.rs`'s existing `sys_error!("connection", …)` calls at
  connect/subscribe failure) — neither touched by this phase.
  Reachability of both was pinned before this change and stays green
  after it: `connectionSummary.test.ts`'s "every attempt failed reads
  Failed" (chip state `failed`) and `systemLog.test.ts`'s
  `"connection"`/`"error"` fixture, exercised through the level filter,
  source filter and unread-badge computation. No AppHandle-level mock
  exists in this crate to drive `session.rs::connect` end-to-end (the
  established convention here, per `project.rs`'s own test-module
  comment, is to test the pure logic beneath an `AppHandle`-taking
  function rather than to add a Tauri mock harness), so the log side is
  pinned at the level the codebase already pins it at rather than by
  adding new test infrastructure mid-removal.
  `StatusBar.tsx`'s metrics row was pushed rightward because
  `.status-bar .status` (the notice span) shared `flex-grow` with
  `.status-bar-spacer`, ballooning even when its own text was short or
  empty. Changed to `flex: 0 1 auto` (shrink-only) so the metrics start
  immediately after the notice's actual content; the spacer alone now
  absorbs the freed space, still pushing the pinned chips to the right
  edge.
- Item 9: removed the Connect all / Disconnect all button
  (`ProjectPanel.tsx`) and the `onConnect` / `onDisconnect` chain
  through `projectContext.ts` (`ProjectContextValue`) and `App.tsx`'s
  context-value memo. `handleConnect` / `handleDisconnect` stay — the
  status-bar chip still runs them as commands — and `p.remoteConnected`
  stays for its other consumers. The empty-state copy at
  `ProjectPanel.tsx` now points at the status bar instead of naming the
  removed button. `Manage servers…` is now alone in that
  `.project-buttons` row; that shape already exists twice elsewhere in
  the same file (the bare "Add bus" / "Add virtual bus" rows), so it
  reads as this panel's normal idiom rather than a leftover — no
  redesign made.
- Test fallout: rewrote the two `statusLine.test.ts` cases that
  asserted the removed strings; updated one `ProjectPanel.manageServers
  .dom.test.tsx` case that asserted "Connect all" existed (now asserts
  neither button exists); dropped the now-nonexistent `onConnect` /
  `onDisconnect` fields from nine other test files that build a typed
  `ProjectContextValue` object literal (excess-property checking would
  otherwise fail `tsc -b`).
- All six CI jobs green locally (`cargo test --workspace`, `cargo
  clippy --workspace --all-targets -- -D warnings`, `pnpm --dir
  apps/gui test` + `build`, the Python sidecar's ruff/mypy/pytest via
  `uv`, the MDF export oracle, and the sidecar freeze). NSIS installer
  built (`pnpm --dir apps/gui tauri build`).

**2026-08-22 - Phase 2 (The unplugged dongle), item 2.** Branch
`task-109-phase-2-dead-interface` off
`task-109-phase-1-quieter-surfaces`. Investigation-first; three
symptoms treated as three chains. No PEAK hardware exists in an agent's
environment, so every experiment below runs against a **virtual channel
torn down mid-stream** or against the installed python-can package, and
the closing confirmation is owner-run (see *Blockers / side effects*).

### Chain A - "no indication that there was an issue with the bus"

**Observation.** The adapter was unplugged; the app showed nothing.

**H-A1.** *python-can's PCAN backend never reads controller state from
the device, so `InterfaceState` cannot move.*

*Experiment.* Read `PcanBus.state`'s getter out of the installed
package (`.venv/.../can/interfaces/pcan/pcan.py`) and enumerate every
assignment to `self._state` in that module.

*Data.* The getter is `return self._state`, whole. `self._state` is
written in exactly one place - the `state` **setter**, which `__init__`
calls with the configured `BusState`. No `PCANBasic` call appears in
the getter. A live device read does exist and is unused:
`PcanBus.status()` -> `CAN_GetStatus`.

*Conclusion.* **Confirmed, and wider than this symptom.** The
controller-state readout is structurally inert on PEAK hardware:
`Bus.state` echoes what the bus was set up with, so bus-off and
error-passive could never surface either. Fixed by reading `status()`
for a PCAN bus.

**H-A2.** *Our own `PythonCanChannel.state()` masks a failed controller
read as healthy.*

*Experiment.* Construct the channel over a bus whose `.state` property
raises `OSError("PCAN_ERROR_ILLHW")` and read `state()`.

*Data.* `state='active' tec=0 rec=0`, mapping to wire enum
`CONTROLLER_STATE_ACTIVE`. The code was `except Exception: return
ControllerState()`, and that dataclass defaults to active.

*Conclusion.* **Confirmed.** A failed read was reported as a healthy
controller.

**H-A3.** *The rx pump learns of the removal but tells no subscriber.*

*Experiment.* Subscribe to a virtual interface, stream a frame, then
make `recv` and `state` both raise the way a removed PCAN handle makes
python-can raise. Drain the subscriber outbox for 3 s.

*Data.* Before teardown the subscriber saw `interface_state` and
`frame_batch`. For 3 s after it saw **nothing at all**, across 29
`recv` retries. The state poll's own failure was logged at *debug* and
`continue`d; the rx pump's failure produced a `warning` **per retry** -
13 identical lines in 1.3 s, i.e. 10 a second into the operator's
System Messages panel and its rate-limit budget.

*Conclusion.* **Confirmed.** Both detectors existed; neither published.

**What landed.** A fourth wire value,
`CONTROLLER_STATE_UNAVAILABLE = 4` - deliberately *not* a reuse of
bus-off, which is a present controller that recovers on its own.
`PythonCanChannel` now carries an unreachable mark, set by any driver
**read** that fails and cleared by the next that succeeds; `state()`
reports it rather than the healthy default, and for a PCAN bus reads
`status()`. Statuses are matched exactly, never by mask: the vendor
header's mask constants share bits with unrelated codes, so a masked
test reads a busy transmit queue as a missing adapter. Both bus-error
warning levels and a full transmit queue map to *active*, as the
controls in `tests/test_controller_state.py` pin. `_state_pump`
publishes through a new `_publish_state` seam, so a failed poll
transitions the interface instead of being swallowed; the rx pump logs
one line per failure episode and re-arms on recovery. Host, client and
frontend render it as "Adapter unavailable", counted as a launcher
fault rather than a warning.

**Transmit failures are deliberately not a detector.** A saturated
transmit queue on a bus with no other node raises exactly as a missing
adapter does; parking a single-node bench bus is worse than being half
a second slow to notice a real removal.

### Chain B - "one side's utilization dropped to 0, the other remained pretty steady"

**H-B1.** *The steady reading is a stale last value.*

*Experiment.* Append two frames 100 ms apart on one bus, read
`bits_per_second_by_bus`, wait 1.3 s (past `RATE_WINDOW`), read again.

*Data.* `[("A", 470.0, 0.0)]` while appending, `[("A", 0.0, 0.0)]`
1.3 s later.

*Conclusion.* **Refuted.** Bus load decays correctly - samples are
pruned on wall clock and `rate_from_samples` returns 0 with fewer than
two in-window samples. New hypothesis written before anything changed:

**H-B2.** *The steady bus is the one RBS transmits on, and its load is
fed entirely by locally-echoed tx-confirm rows.*

*Experiment.* Append five `Direction::Tx` rows on bus `pack` and read
the status snapshot.

*Data.* `bits/s [("pack", 470.0, 0.0)]`, `frames/s [("pack", 10.0)]`,
rx/tx `(0.0, 10.0)`. Rx contributed nothing.

*Conclusion.* **Confirmed, and it is the same cause as chain C.** The
reading was live, not stale - it was measuring the host's own echo. The
side that dropped to 0 was the receive-only one.

### Chain C - "the pack bus trace continued getting updates like it thought it was sending"

**H-C1.** *A tx-confirm row is evidence only that a frame was handed to
a driver, and the route gate tests the session binding rather than the
device.*

*Experiment.* Read the transmit primitive and the route resolver;
transmit into a session whose interface is gone, on the torn-down
virtual channel.

*Data.* `build_and_confirm` appends the row **before** any wire attempt
and unconditionally; the scheduler discards `transmit_batch`'s result
entirely. `resolve_bus_route` matches on `channel_to_bus` /
`channel_to_interface`, both of which survive an adapter being
unplugged untouched. The sidecar's own rejection *does* reach the host
- one `Error{code: TX_REJECTED}` envelope per frame, measured - where
`cannet-client` turns it into a `tracing::warn!` and continues. That
line goes to dev stderr only; the System Messages panel is fed
separately by `emit_system_log`.

*Conclusion.* **Confirmed.** Nothing anywhere in the app observed that
the frames were being refused.

**What landed.** An interface reporting `unavailable` is no longer a
live route (`session::resolve_bus_route`). ADR 0039's park then does
the rest with no new machinery: periodics on the bus park with their
counters frozen and stop producing tx-confirm rows, bus load falls to
zero within the existing 1 s window, and the ~1 s parked probe resumes
them when the adapter returns. The ADR is amended in the same commit -
its consequences claimed routes only change at session
register/unregister, which is no longer true. A manual single-shot
still appends its row (ADR 0039 keeps that: an analyzer shows its own
transmits) but its wire status now names the unreachable interface
instead of the false "not bound on any active server".

**Bus-off keeps its route**, tested as the control: parking it would
freeze every periodic's counter across a fault the hardware clears by
itself.

### Tests

- `servers/cannet-python-can/tests/test_controller_state.py` (new, 19
  cases): the masked-read regression, the mid-stream teardown and its
  recovery, and the whole PCAN status table with its two controls.
- `test_shared_interface.py` +3: an interface whose device disappears
  is reported unavailable, one that comes back is reported active
  again, and a persistent read failure is logged once per episode
  rather than at the retry rate.
- `cannet-gui` +4: no route for an unavailable interface, a route for
  every other controller state (the bus-off control), the honest
  transmit-failure wording, and the route coming back.
- `cannet-client` +1, the `cannet-wire` round-trip extended to the new
  value, `busHealth` +2.

**2026-08-22 — Phase 3 (The RBS panels become grid rows), items 7 and
10.** Branch `task-109-phase-3-rbs-grid-rows` off
`task-109-phase-2-dead-interface`. Frontend only; no host change.

**Item 7's premise is confirmed false, and now has the test task 99
never wrote.** `RbsPanel` instantiated the gridview without passing
`onPrimaryAction`, so `useGridview`'s Space branch returned at
`if (!onPrimaryAction …)` and the press reached the scroll container.
Space now toggles the cursor row's own enable at whichever level the row
is — bus, ECU or message — through the same `rbs_set_enabled` call the
row's checkbox makes. The resolution is a pure function
(`findRbsEnableToggle`, `rbsRowIdentity.ts`): a message row id carries
its bus and message key but *not* the ECU the command needs, so the
walk reads it off the visible tree rather than parsing the id. It is
walked on the press rather than indexed per render — the tree is rebuilt
on every 500 ms value poll and a keystroke is rare.

Two controls, both green before and after: a row whose checkbox is
disabled for the mouse (an unresolved bus, a message no database
defines) does nothing on Space, and a **focused** enable checkbox keeps
the press. The second needed no layer change — `isEditableTarget`
already answers true for every `HTMLInputElement`, checkboxes included,
and the hook's editable exemption runs before its Space branch, so the
grid was never going to double-fire a checkbox the user is standing on.

**Item 10: what was actually missing was the cursor, not the layer.**
`RbsSignalsPanel` already instantiated `useGridview` with
`arrayRowSpace` and already carried the selection — but it rendered
nothing of the cursor, so keyboard navigation moved an invisible thing;
and its row click never handed focus to the container, so a
mouse-then-keyboard session left focus on `<body>` with the arrows dead.
That is the "kinda awkward". Three changes, no fork of the layer:

- `makeRowGridPropsCache` **moved from `rbsRowIdentity.ts` into
  `useGridview.ts`** and both RBS panels now use it. It was already the
  one implementation of ADR 0044's "a click hands the container the
  keyboard, unless it was aimed at a control that wants focus itself";
  it was simply filed under the RBS tree. Its three tests moved with it,
  to `useGridview.dom.test.tsx`.
- The rows carry `data-active` for the cursor, and `.rbs-signals-row
  [data-active]` gets the same inset outline the RBS tree's rows and
  the transmit list's already use.
- Space is bound, per the idiom below.

**One idiom, and the judgment call in it.** Space activates or
deactivates *a message* in both panels. In the signals grid the row is a
field of one, so the press toggles the message that carries it — the
state the row already reports, since Muted means precisely "this message
will not play". The value sent is derived from that displayed status
rather than from the message's own enable flag, deliberately: where the
mute comes from the bus or the ECU, deriving makes the press inert,
while reading the message flag would flip it under a mute with nothing
on screen to show the change. Inert-and-honest beats invisible-and-
effective. Filed for a ruling as owner-review-queue 1.26 — grooming
named the key, not its subject.

**Tests.** `RbsPanel.gridview.dom.test.tsx` +4 (the three-level toggle,
re-enabling a disabled message, the inert row, the focused checkbox);
new `RbsSignalsPanel.gridview.dom.test.tsx`, 5 cases (the visible
cursor and `aria-activedescendant`, click-hands-the-keyboard, Space
down and Space up, and the value editor keeping its own Space);
`rbsRowIdentity.test.ts` +4 for `findRbsEnableToggle`. Falsified before
being trusted: with the two `onPrimaryAction` bindings and the
`data-active` attribute removed, 6 of the 9 new panel cases fail; the
other 3 are the no-op controls, which pass either way by design.

**Perf skipped by owner instruction** (mid-phase, 2026-08-22). No
ADR-0031 capture was filed for this phase and nothing was written to
`docs/performance-measurements/frontend/`.

**An observation for phase 5, not chased.** Every gridview container is
`tabIndex: 0` (`useGridview`'s `containerProps`) and `index.css`
suppresses no focus ring on any of them — `.trace-rows`,
`.rbs-signals-rows` and the RBS tree all inherit the UA ring, and the
only `:focus-visible` rules in the stylesheet are on `.trace-row`,
`.chip-button` and two plot menus. So a keyboard press that leaves the
cursor where it is would show nothing *but* a ring around the whole
container box — and `cursorAction` returns `none` for ArrowLeft on a
depth-0 row while `useGridview` still calls `preventDefault` on it.
That is a candidate for "the entire box gets highlighted on leftarrow",
offered as a place to point the reproduction; it is not a conclusion,
and no experiment here tested it.

## Blockers / side effects

**Phase 2 - the closing confirmation is owner-run.** Everything in
phase 2's log was established against a virtual channel and against the
installed python-can package; no PEAK adapter exists in an agent's
environment. Two things can only be settled on the owner's rig:

1. **Which detector fires on a real removal.** Both are wired: a `recv`
   that raises, and PCAN-Basic's channel status naming an invalid
   handle. Whether the PEAK driver raises on `Read` after an unplug,
   returns "queue empty" forever, or answers `GetStatus` with
   `PCAN_ERROR_ILLHW` is not knowable from here - which is why both are
   implemented rather than one.
2. **That the `status()` mapping does not false-positive.** It is
   exact-match against the vendor header's codes and the two warning
   levels are explicit controls, but it has never met hardware.

**What to do, and what to expect.** Connect both PEAK dongles with a
project that runs RBS on the pack bus, let it stream, then unplug one:

| Where | Expected within ~1 s |
|---|---|
| Bus health launcher | tints as a fault, count 1, tooltip naming the bus |
| Bus health panel | that bus reads **Adapter unavailable**, load `0 %` |
| Pack bus trace | **stops** gaining rows - the phantom rows are the defect this closes |
| Status bar bus load | falls to 0 for that bus |
| RBS panel | its periodics park |

Then plug it back in: within about a second the row returns to
error-active and the periodics resume on their own. If instead the
panel stays error-active and the trace keeps growing, neither detector
fired; the next step is the sidecar log, where `rx for <id> failed: ...`
says the read detector saw it and its absence says the removal is
silent at the driver, in which case the state poll's `status()` read is
where to instrument.

**A finding this phase did not fix.** A wire-level transmit rejection
is discarded: `cannet-client::is_per_frame_error_code` classifies
`TX_REJECTED` as non-fatal and logs it with `tracing::warn!`, which
reaches dev stderr and nothing else - not the System Messages panel,
not bus health, not the connection chip. That is why the trace can show
a "sent" row for a frame the far end refused, and it is *general*: a
listen-only bus and an FD frame on a classic bus produce the same
silent lie. The unavailable-interface route gate closes the case the
owner hit; it does not close this one. Surfacing it is a behavioural
choice - where it appears, and at what cadence, since a rejection at
RBS rate is a flood and needs the coalescing the error-frame summaries
already use - so it is filed for a ruling rather than chosen here.
