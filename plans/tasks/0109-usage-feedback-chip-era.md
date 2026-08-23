# Task 109 — Usage Feedback From the Chip-Era Build

Opened by owner instruction 2026-08-22, from test-driving the branch
chain that carries tasks 101 / 106 / 19 / 108. Ten observations: three
defects, two surfaces that say too much, three project-management
affordances that do not exist as buttons, and two panels that do not
behave like the grid rows they sit on.

## Status

Groomed with the owner 2026-08-22. Six phases. Not started.

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

Three hypotheses, ranked by what the code says:

- **Not the filter.** `viewSignalsFilter.ts` is explicit that "nothing
  selected is no filter", so an empty status selection cannot produce
  an empty grid. The attention count is a badge, not a filter.
- **Patterns are never pushed** — the leading hypothesis, in the
  module's own words: *"A **pattern** … is re-evaluated against the
  live catalog on every render — it has no recorded configuration for
  the database to have drifted from, and it cannot go stale the way a
  manual pick can, so it is never pushed."* A project whose views
  select signals by pattern therefore has an empty panel **by design**,
  which is exactly the reported symptom.
- **The owner's parenthetical** — a push that only happens for views
  mounted after the panel exists. The hook's `useEffect` runs on mount
  regardless of whether the panel exists, so this is unlikely, but it
  is cheap to falsify and must be falsified rather than argued away.

**Investigation-first.** The verdict decides whether this is a defect,
a missing empty-state, or a model change. Note that making
pattern-selected signals pushable is a real model change — a pattern
has no stable identity to key a row on, and the module's doc comment
explains why it was excluded. Do not assume that is the answer.

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
| 6 | The view-signals panel reads empty | Opus | Item 1, investigation-first. Falsify all three hypotheses in order; the verdict decides between a defect fix, an empty-state that says why, and a model change. A model change is escalated, not taken. |

Phases 2, 5 and 6 follow the scientific method into the status log:
observation → hypothesis → experiment → data → conclusion, and no root
cause or fix without citing the experiment whose data confirmed it.

## Exit criteria

1. Each of the ten observations has either a landed fix with a test, or
   a recorded verdict explaining why no change was made.
2. Items 2 and 7 have verdicts good enough to unblock tasks 101 and 99
   in owner-review-queue § 4.
3. The three investigations (items 1, 2, 8) each carry a full
   observation → conclusion chain in the status log, with the
   confirming experiment named.
4. No regression in the ADR 0031 harness beyond the owner's thresholds,
   and a reading taken for any phase touching a render or data path.
5. Docs move with the code: ADR 0042 / 0034 gain nothing new unless the
   recent-projects work diverges from their scope table, in which case
   the divergence is an ADR amendment, not a silent choice.

## Status log

_Nothing implemented yet._

## Blockers / side effects

_None recorded yet._
