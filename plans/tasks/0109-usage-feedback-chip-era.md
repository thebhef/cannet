# Task 109 — Usage Feedback From the Chip-Era Build

Opened by owner instruction 2026-08-22, from test-driving the branch
chain that carries tasks 101 / 106 / 19 / 108. Ten observations: three
defects, two surfaces that say too much, three project-management
affordances that do not exist as buttons, and two panels that do not
behave like the grid rows they sit on.

## Status

Groomed with the owner 2026-08-22, with phases 2b / 2c / 2d added after
the 2026-08-22 bench session found the reported fault was the CAN link,
not the USB device. Phases 1, 2, 2b, 3, 2c, 2d, 4 and 5 landed; 6
outstanding. Kvaser deferred by owner ruling 2026-08-23. See the status
log.

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

### 2 (addendum) — what the hardware actually reports, measured

**Owner clarification 2026-08-22: "unplugged" means the CAN link, not
the USB device.** This is a bus-health fault under ISO 11898-1 fault
confinement, not device removal. Phase 2 built device-removal detection
(`CONTROLLER_STATE_UNAVAILABLE`) for a fault nobody has tested; the
reported one is a different fault, and phase 2 did not fix it.

Measured with the owner at the bench, 2026-08-22. Two PEAK PCAN-USB FD
adapters at 500 kbit/s, `PCAN_USBBUS1` transmitting 100 f/s,
`PCAN_USBBUS2` present as an ACKing node, `PCAN_BUSOFF_AUTORESET`
confirmed **0**, `LISTEN_ONLY` 0. The owner disconnected one end of the
CAN cable at 10.9 s and reconnected at 33.4 s. Ground truth for the
open wire is the receiving channel: `rx2` ran 90–100 f/s, fell to
**0** for the whole window, and resumed on reconnect.

Four candidate state sources, sampled together:

| Source | During the fault | Verdict |
|---|---|---|
| `bus.state` (python-can) | `ACTIVE` | the stored echo phase 2 documented — never moves |
| `CAN_GetStatus` | `BUSWARNING` (0x8) and no further | **under-reports** — never reaches passive |
| `PCAN_MESSAGE_STATUS` frames | 3 frames, all `BUSWARNING` | same under-report |
| **error frames** | **TEC 8 → 128, held, then decrements to 0** | **authoritative** |

The error-frame payload is the finding. Byte 3 rose in steps of exactly
8 per failed transmission (`08 10 18 … 80`), pinned at **`0x80` = 128**
for 114,917 consecutive frames, briefly overshot (`88 90 b7 bb`), and
on reconnect counted **down** to zero as transmissions succeeded. That
is TEC, by its own arithmetic. Byte 2 is REC, zero throughout because
we were the transmitter. Byte 1 is an error-type code (`0x19` while
faulting, `0x00` while recovering).

**TEC ≥ 128 is error-passive.** That is why PCAN-View reads "error
passive" and "warning" simultaneously — it derives state from the
counters, and PEAK's own `ANYBUSERR = 0x4001C` (`BUSLIGHT | BUSWARNING
| BUSOFF | BUSPASSIVE`) shows these are flags meant to be masked, not
matched.

Raw runs and probe scripts are in the session scratchpad
(`pcan/B-tx.txt`, `pcan/D-status.txt`, `pcan/watch_*.py`); they are the
only reproduction of this that exists without hardware.

#### Three independent places the state is lost

1. **PCAN** — `_pcan_state()` reads `CAN_GetStatus`, which never gets
   past `BUSWARNING`, and then maps warning to `STATE_ACTIVE` anyway.
   Its exact-match test also cannot fire on a composite: a genuine
   `BUSPASSIVE | BUSWARNING` (`0x40008`) fails `status == 0x40000` and
   falls through to active.
2. **Vector and Kvaser** — neither backend overrides `state`, and
   `BusABC.state`'s getter **returns `BusState.ACTIVE` unconditionally**
   (a hardcoded default, not `NotImplementedError`). The readout has
   therefore never worked on any backend, for two different reasons.
3. **The counters are already arriving and nothing reads them.**
   `_msg_to_frame` copies `msg.data` verbatim and tags
   `FrameKind.ERROR`, so TEC and REC cross the wire in bytes 2–3 of
   every error frame. `tec` / `rec` ship as constant 0.

#### Where each vendor surfaces the counters

| Vendor | State | TEC / REC | Reachable how |
|---|---|---|---|
| PCAN | error-frame counters (`GetStatus` under-reports) | **bytes 2–3 of the error frame** | already in `_msg_to_frame`; nothing decodes them |
| Vector | `XL_CHIP_STATE` / `XL_CAN_EV_TAG_CHIP_STATE` events carry `busStatus` | **`txErrorCounter`, `rxErrorCounter`** on `s_xl_chip_state` | `VectorBus.handle_can_event` / `handle_canfd_event` are **empty hooks python-can calls for exactly these events and documents for subclassing**; `xlCanRequestChipState` is already bound in `xldriver.py` |
| Kvaser | `canReadStatus` (`canSTAT_ERROR_WARNING` / `ERROR_PASSIVE` / `BUS_OFF`) | `canReadErrorCounters` | **neither is bound by python-can.** Its bound set covers only `canRequestBusStatistics` / `canGetBusStatistics`, whose `BusStatistics` carries frame counts, err-frame count, bus load and overruns — no state, no counters. We must bind them ourselves in python-can's own `__get_canlib_function` idiom |

Kvaser is the only one needing a new binding, and it is the only one
whose error frames do not carry counters, so the explicit call is not
optional there.

**`BusStatistics.err_frame` is not a substitute, despite the name.** It
is *"Number of error frames"* — a cumulative tally of error frames
observed, monotonic and unbounded. TEC and REC are the controller's own
0–255 registers, and fault confinement is defined on their values:
they rise 8 per failed transmit, **fall 1 per success**, and separate
transmit from receive. A tally does none of that. On the bench run
above the equivalent tally would have read 115,136 — a number that
cannot say which state the controller is in, cannot distinguish
transmitting into a dead bus from receiving on a noisy one, and never
falls when the cable goes back in, while TEC did all three. Deriving
state from it would be the heuristic the owner ruled out. It belongs
with bus load as a health metric, not as a state source.

**The upstream gap is known and deliberate.** python-can issue #736,
*"Meaning of `can.BusABC.state`"* (December 2019, still open against
4.6.1 — the version in `uv.lock`), asks exactly this question: does
`state` mean driver-to-interface connectivity or ISO 11898-1 controller
state? It notes `KvaserBus` and `VectorBus` do not implement it. The
semantics were never settled, which is why `BusABC.state` returns a
hardcoded `ACTIVE` rather than raising. A fossil of the intent survives
in python-can's own Kvaser constants: `canIOCTL_CLEAR_ERROR_COUNTERS`
is bound, and nothing reads them.

So this is not a library that already solved the problem behind an API
we failed to find — it is six years of deferred semantics. That argues
for keeping the derivation in **our** seam and reading each vendor
directly, rather than implementing or monkey-patching `Bus.state` and
inheriting an unsettled contract.

Two caveats from CANlib's own header, which the Kvaser work must
surface rather than hide:

- `canReadErrorCounters(hnd, *txErr, *rxErr, *ovErr)` — *"Not all CAN
  controllers provide access to the error counters; in this case, an
  educated guess is returned."* On some Kvaser hardware TEC/REC are an
  **estimate**. PEAK's are exact registers. Displaying both as "TEC"
  without distinction would launder an estimate into a measurement,
  which is the thing the owner ruled out.
- `canReadStatus(hnd, *flags)` — *"returns the latest known status... If
  a status change happens precisely when `canReadStatus()` is called, it
  may not be reflected in the returned result."* A documented staleness
  window, so a single sample is not authoritative.

**The upstream idiom, where it has landed, is a live read with masked
bits.** Five backends implement `state` today — `etas`, `ixxat` (two
drivers), `pcan`, `systec` — and none of them is Kvaser, Vector or
socketcan. The ixxat implementation is the closest analogue to what we
need:

```python
status = structures.CANLINESTATUS()
_canlib.canControlGetStatus(self._control_handle, ctypes.byref(status))
error_byte_1 = status.dwStatus & 0x0F
if error_byte_1 & constants.CAN_STATUS_BUSOFF:   # masked, not ==
    return BusState.ERROR
```

A live device read, and **masked** bit tests. Phase 2 chose the
opposite on both counts.

**Owner ruling 2026-08-23: this pass ships PCAN and Vector only.**
Kvaser is deferred — it is the one vendor needing bindings nobody
upstream has written, and the one whose counters CANlib itself calls an
*"educated guess"* on some controllers. Both make it the expensive,
least-trustworthy third. The hardware re-test happens after 2c and 2d
land, and the fix is revisited if that test says so.

Nobody upstream has attempted Kvaser state or error counters — there is
no such PR, open or merged, in the repository's history. The closest is
#477, *"Added support for bus statistics in the kvaser interface"*,
which added `canGetBusStatistics`: the `err_frame` tally ruled out
above. The one Kvaser health feature python-can has is the count that
cannot yield a state.

It also settles whether to implement `Bus.state` ourselves: **no.**
ixxat has to fold bus-off into `BusState.ERROR` and report listen-only
as `PASSIVE`, because python-can's three-value enum cannot hold
warning / passive / bus-off separately. Our wire carries all three plus
`UNAVAILABLE`, so conforming to `Bus.state` would mean flattening our
own model to fit an interface whose meaning has been unsettled since
2019. Read each vendor directly, in our own seam.

#### Volume is a design constraint

**115,136 error frames in 22 seconds — about 5,200/s.** Whatever
consumes these coalesces at the source or floods everything downstream.
This may also be the real explanation of the owner's third symptom
("the pack bus trace continued getting updates"): error frames arriving
at 5,200/s, not phantom transmits. Check before assuming.

#### Consequences for the wire

- **`CONTROLLER_STATE_WARNING` has no value.** TEC or REC in 96–127 is
  a real ISO state all three vendors report, and it is the state an
  open circuit settles in. Today it is unrepresentable, which is
  precisely why the owner's test looked like nothing happened. Adding
  it is additive, the same shape as phase 2's `UNAVAILABLE`.
- **`tec` / `rec` are available on all three vendors**, so they can be
  populated rather than hedged as optional.
- **Warning and passive must not park a route.** ADR 0039's amendment
  already exempts error-passive and bus-off; warning joins them. Only
  `UNAVAILABLE` parks.

Phase 2's `UNAVAILABLE` work stays in place — USB removal is a real
fault, just not the reported one.

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

| 2c | Counter-derived controller state, and the wire it needs | Opus | PCAN's error-frame TEC/REC become the state source, replacing the `CAN_GetStatus` exact-match test; bus-error bits masked, the `ILLHW` / `ILLNET` / `ILLHANDLE` family still matched exactly. `CONTROLLER_STATE_WARNING` added to the wire — the derivation has nowhere to put its result without it — and `tec` / `rec` populated instead of 0, through to the bus-health surface. Coalesced at the source: 5,200 error frames/s is the measured rate. ADR 0039 amended so warning, like passive and bus-off, keeps its route. |
| 2d | Vector | Opus | A `VectorBus` subclass overriding `handle_can_event` / `handle_canfd_event` — the hooks python-can documents for exactly these events — plus `xlCanRequestChipState` to poll. `busStatus`, `txErrorCounter`, `rxErrorCounter` feed the same derivation 2c defines. Cannot be verified without Vector hardware; say so rather than implying it was tested. |

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

**2026-08-23 - Phase 2c (Counter-derived controller state, and the wire
it needs).** Branch `task-109-phase-2c-counter-derived-state` off
`task-109-phase-3-rbs-grid-rows`. Implements the addendum's measured
spec rather than re-deriving it; the bench numbers below are the
owner's, not this phase's.

**Phase 2's `UNAVAILABLE` path is untouched.** The two answer different
faults: `unavailable` is a USB device that is gone and cannot be read,
counter-derived confinement is a present controller on a broken wire.
Neither is a special case of the other, and `unavailable` still
short-circuits ahead of every counter - pinned by
`test_an_unreachable_adapter_still_outranks_every_counter`, which feeds
TEC 128 *and* `PCAN_ERROR_ILLHW` and expects `unavailable`.

### What landed

- **The counters are the state source on PCAN.** `PythonCanChannel.recv`
  decodes bytes 2 (REC) and 3 (TEC) off every `FrameKind.ERROR` payload
  and stores them as one tuple, so the state thread can never read a
  torn pair from the rx thread's write. `state()` runs
  `driver.state_from_counters` over them. The decode is gated on the
  bus being PCAN: byte 2/3 is PEAK's layout, SocketCAN puts the pair at
  6/7, and a virtual bus carries whatever the sender put there - a
  control test feeds the same payload from a non-PCAN bus and expects no
  state change.
- **Thresholds are the standard's**, in one pure function in
  `driver.py` so phase 2d's Vector chip-state events feed the same
  derivation: >95 warning, >127 passive, >255 bus-off, with bus-off on
  the transmit counter only - a receiver never removes itself from the
  wire. They fall on success, so recovery needs no separate signal and
  no decay timer: a controller that stops at TEC 100 on an idle bus
  really is at 100.
- **The status word is masked, and is a floor rather than the answer.**
  `_pcan_status_state` masks `BUSOFF` / `BUSPASSIVE` / `BUSWARNING`,
  because PEAK's own `PCAN_ERROR_ANYBUSERR = 0x4001C` defines those four
  as a union and a real reading combines them - `BUSPASSIVE |
  BUSWARNING = 0x40008` cannot match phase 2's `status == 0x40000`.
  `BUSLIGHT` reads active: it sits below the standard's warning limit.
  The two readings are combined with `worse_state`, so the
  under-reporting status word cannot talk the counters down and the
  status word's bus-off (a transmit counter no single payload byte can
  express) cannot be talked down by them.
- **The `REGTEST` / `NODRIVER` / `ILLHW` / `ILLNET` / `ILLHANDLE` /
  `INITIALIZE` family keeps exact matching**, as phase 2 had it. Those
  are multi-bit values that overlap each other bit for bit - 0x1400,
  0x1800 and 0x1C00 share the 0x0400 and 0x0800 bits - so masking would
  read one as another and a busy transmit queue as a missing adapter.
  Phase 2's comment named 0x1C00 `ILLCLIENT`; the vendor table calls it
  `ILLHANDLE`, corrected here.
- **`CONTROLLER_STATE_WARNING = 5`** on the wire, additive and the same
  shape as phase 2's `UNAVAILABLE = 4`; `driver.STATE_WARNING`,
  `cannet_client::controller::ControllerState::Warning`, `"warning"`
  through `bus_health`, `Error-warning` in the panel with the warning
  palette, and a concern the status-bar launcher tints for.
- **`tec` / `rec` are populated** instead of the constant 0 they have
  shipped as since task 101, end to end.
- **Coalescing is at the source and needed no new machinery.** The
  decode is two array reads on the rx thread; nothing publishes from
  there. The 500 ms state poll reads the latest pair and
  `_publish_state`'s existing publish-on-change gate does the rest, so
  the measured 5,200 error frames/s produce **one** `InterfaceState`
  per actual transition rather than 5,200 -
  `test_a_pinned_controller_publishes_once_however_long_the_fault_lasts`
  holds the counters pinned across three poll intervals and asserts an
  empty outbox.
- **ADR 0039 amended** so warning, error-passive and bus-off all keep
  their routes and only `unavailable` parks. `interface_is_unavailable`
  already tested for exactly `Unavailable`, so the code needed no
  change - the ADR's consequence text did.

### Tests

`tests/test_counter_derived_state.py` (new, 35 cases): the threshold
table, the recorded climb / pin / overshoot / fall, the REC control, the
data-frame control, the short-payload control, the non-PCAN control, the
masked flag table, the exact-match no-hardware table, and both
directions of the counter-versus-status combination. The payloads are
the captured bytes - TEC `08 10 18 ... 80`, the pin at `0x80`, the
overshoot `88 90 b7 bb`, the fall `b7 ... 02 01 00`, byte 1 `0x19` while
faulting and `0x00` while recovering. **Falsified before being
trusted:** with the two-line counter decode removed from `recv`, 7 of
them fail. `test_shared_interface.py` +2 (the warning wire value, the
coalescing bound), `test_controller_state.py`'s status table updated
where masking changes the answer (`BUSWARNING` now reads warning),
`cannet-client` +1, the `cannet-wire` round-trip extended,
`busHealth.test.ts` +2.

### The owner's third symptom: the error frames are the trace rows

**Observation.** "the pack bus trace continued getting updates like it
thought it was sending", at a measured 115,136 error frames in 22 s.

**Hypothesis.** *The rows are the error frames themselves, not phantom
transmits: nothing filters `FrameKind::ERROR` out of the ingest path.*

**Experiment.** Enumerate every branch on the error payload kind
between the wire decode and the trace store, and check whether any of
them is a filter.

**Data.** Five sites, none of them a filter.
`cannet-wire/src/convert.rs:147` decodes `FrameKind::Error` into
`CanFramePayload::Error` (dropping the payload, which is why the
counters had to be decoded in the sidecar).
`session.rs:958` is the only error branch in the ingest loop and it
*adds* the health-coalescer fold; `trace_store.append(raw)` below it is
unconditional. `trace_store/flush.rs:78` persists the kind like any
other. `trace_query.rs:189` spells it `"error"` for the paged trace
view. `bus_health.rs`'s module doc states the decision explicitly:
*"The frames themselves are stored like any other frame - the summary
sits beside them, never instead of them."*

**Conclusion. Confirmed.** During that fault the pack bus trace gained
about 5,200 rows a second, every one a real error frame the adapter
reported. Phase 2 attributed the symptom to tx-confirm rows and closed
that case; this is a second, larger contributor it did not see.

**Not fixed here, and deliberately.** Suppressing or coalescing error
frames in the trace reverses a documented decision about what a saved
capture contains, and the alternatives (drop them, coalesce them into
one row, keep them and filter at the view) are a behavioural choice with
a real cost either way. Filed as owner-review-queue 3.39 for a ruling,
and it is a separate phase, not this one.

### Not done

**Perf skipped by owner instruction** (queue 2.5). No ADR-0031 capture
was taken and nothing was written to
`docs/performance-measurements/frontend/`.

**Kvaser is out of scope** by owner ruling 2026-08-23 (queue 2.7); no
bindings were added. Vector is phase 2d.

**2026-08-23 - Phase 2d (Vector).** Branch
`task-109-phase-2d-vector-chip-state` off
`task-109-phase-2c-counter-derived-state`. Sidecar-only: the wire, the
host and the panel already carry warning and real counters from 2c, so
this phase adds a second source feeding the same derivation and changes
nothing downstream of `OpenChannel.state()`.

**Implemented and untested against hardware.** No Vector adapter exists
in an agent's environment, and neither does the XL library: python-can
answers the import with *"Could not import vxlapi: Vector XL library not
found: vxlapi64"*, so the backend cannot load here at all. Everything
below is written from the installed python-can 4.6.1's own field
definitions and exercised against faked chip-state events. Do not read
it as working; read it as implemented, with the owner's re-test script
in the blockers section below.

### What landed

- **A `VectorBus` subclass, not a patch.**
  `VectorBus.handle_can_event` and `handle_canfd_event` are empty
  methods python-can calls for every non-message event and **documents
  for subclassing** - their own docstrings name `XL_CHIP_STATE` and
  `XL_CAN_EV_TAG_CHIP_STATE` as tags that arrive there. The subclass
  overrides both, tests the tag, and stores
  `(busStatus, txErrorCounter, rxErrorCounter)` as one tuple so the
  state thread cannot read a torn triple from the rx thread's write.
  The classic queue carries it in `tagData.chipState`
  (`s_xl_chip_state`), the FD queue in `tagData.canChipState`
  (`s_xl_can_ev_chip_state`); the two structs declare the same three
  leading fields in the same order, so one reader serves both.
- **The tag test is load-bearing.** python-can routes *every*
  non-message event to those hooks - timers, sync pulses, transceiver
  events, FD rx/tx errors - and the union member would then be whatever
  bytes that other event put there. Six tests pin that a non-chip-state
  tag leaves the last reading alone.
- **Polled, not only awaited.** `xlCanRequestChipState` is already bound
  in `xldriver.py`, so `state()` places a request on every poll - the
  same 500 ms `_state_pump` cadence PCAN's status read runs on, so
  `_publish_state`'s publish-on-change gate coalesces Vector's readings
  exactly as 2c verified for PEAK's. The XL driver answers
  asynchronously, as an event on the queue the messages come out of, so
  the request is placed first and the *previous* answer read: a reading
  is always one poll (half a second) old. A request that raises - which
  python-can's `errcheck` does on any non-zero XL status - reports
  `unavailable`, never the healthy default.
- **One derivation, two vendors.** `_vector_state` runs
  `driver.state_from_counters(tec, rec)` and combines it with the masked
  `busStatus` through `driver.worse_state`, which is what `_pcan_state`
  does with its status word. **The derivation was not forked and did not
  need to change**: Vector's counters are the same two ISO 11898-1
  registers PEAK's error frames carry, and `XL_BusStatus` is a bit field
  (BUSOFF 1, ERROR_PASSIVE 2, ERROR_WARNING 4, ERROR_ACTIVE 8) that
  masks the same way PEAK's `ANYBUSERR` union does. Vector is the easier
  of the two - the counters arrive beside the status instead of inside a
  payload - but the counters still outrank the status bits, because that
  is the rule 2c established and nothing about Vector argues against it.
- **`Bus.state` is still not implemented**, per the addendum's ruling.
  python-can's three-value `BusState` cannot hold warning, passive and
  bus-off apart (ixxat folds bus-off into `BusState.ERROR`), its
  semantics have been open upstream since 2019 (issue #736, still open
  against 4.6.1), and `BusABC`'s getter returns `ACTIVE` unconditionally
  for any backend that skips it - which `VectorBus` does. The derivation
  stays in our seam.
- **The open path constructs the subclass directly.**
  `can.interface.Bus` resolves the class from python-can's own
  `BACKENDS` table, which can only ever name `VectorBus`; handing it a
  subclass would mean editing that table, i.e. the monkey-patch the
  documented hooks exist to avoid. `_open_vector_bus` runs the same
  `can.util.load_config` merge `Bus` performs first, so a Vector open
  still sees whatever `can.rc` or a `can.conf` would have contributed -
  only the class being constructed changes.
- **Nothing else routes through the new path.** `_is_vector` is
  `hasattr(bus, "request_chip_state")`, our own subclass's marker, so a
  Kvaser or virtual bus is untouched and still falls back to
  `Bus.state`. A test pins that a Vector error frame's payload does
  *not* move the counters: bytes 2/3 as REC/TEC is PEAK's layout, gated
  on `_is_pcan`, and Vector reports through chip-state events instead.

### Tests

`tests/test_vector_chip_state.py` (new, 31 cases): the constants
re-checked against python-can's own `xldefine` enums (they are spelled
out in the driver so the module loads with no XL library, which means
they can drift), the masked `busStatus` table, both event shapes
recorded through the real subclass's hooks, six non-chip-state tags
ignored, the shared threshold table asserted equal to
`state_from_counters`, both directions of the counter-versus-status
combination, the not-yet-answered case, the poll count, a failing
request reporting `unavailable`, and the PEAK-payload control.
`test_enumeration.py`'s `test_open_non_pcan_does_not_touch_pcan_basic`
rewritten for the new open path - its fake Vector module now offers a
`VectorBus` base class, and the test additionally pins that the opened
channel really is the chip-state subclass, since a silently-unsubclassed
open would install no hooks at all. Its teardown clears the driver's
cached subclass, which would otherwise outlive the fake module it was
derived from and be handed to the next test (that leak was caught by a
real cross-file failure, not reasoned about).

**Falsified before being trusted.** With the `_is_vector` branch removed
from `state()`, 11 of the 31 fail. With the two hooks' tag tests
replaced by `if True`, 6 fail.

### The one thing that *is* verified here

The XL library's absence is the environment's actual state, so "Vector
unavailable must not break the sidecar" is testable end to end and was
tested end to end: `uv run cannet-python-can --bind 127.0.0.1:0` boots,
logs `Could not import vxlapi: Vector XL library not found: vxlapi64` as
a warning, enumerates the two PEAK channels, and reports `sidecar
listening 127.0.0.1:<port>`. Two unit tests hold the same line -
enumeration answers with the library missing, and the subclass is built
lazily so its import cannot be dragged into module load.

### Error-frame volume

**Not made worse by this phase, and possibly better on Vector.** Queue
3.39's 5,200 error frames/s is a PEAK measurement, and this phase adds
no new frame source: chip-state answers are XL *events*, which
python-can consumes inside `_recv_internal` and never turns into a
`Message`, so they cannot reach the trace. Whether a Vector adapter
emits error *frames* at PEAK's rate during the same fault is unknown and
untestable here - the owner's re-test script below asks for it, because
if Vector is quiet where PEAK floods, that is a data point for 3.39's
ruling.

### Not done

**Perf skipped by owner instruction** (queue 2.5). No ADR-0031 capture
was taken and nothing was written to
`docs/performance-measurements/frontend/`. The phase touches no render
or data path - it adds a second producer behind an existing 2 Hz poll.

**Kvaser is out of scope** by owner ruling 2026-08-23 (queue 2.7). No
bindings were added, and nothing here makes adding them harder: a third
vendor implements one `_<vendor>_state` method against the same
`state_from_counters` / `worse_state` pair.

**2026-08-23 — Phase 4 (The project affordances), items 4, 5 and 6.**
Branch `task-109-phase-4-project-affordances` off
`task-109-phase-2d-vector-chip-state`. Three top-level-bar affordances
in task 108's chip language; no new icon and no new chip component.

### What landed

**Item 4 — New Project.** `project.close` is now `project.new`, labelled
**New project**, with `Close project` kept as a hidden palette keyword
so muscle memory still finds it. The handler is unchanged
(`handleNewProject`); the command was always a *new*-project action and
only its name said otherwise. Two riders, both in owner-review-queue
1.28: the palette wording is user-visible, and the command lost its
`hasProjectOpen` gate — it used to vanish whenever no project *file* was
open, which is exactly the session a user most wants to start over from
(a session always holds a project, ADR 0042 §1; only sometimes a file).
A chip `New` (the `plus` glyph, the one the bar already spends on
"create") sits at the head of the bar. `CommandContext.hasProjectOpen`
is now gated on by no command; it is left in place because it is the
context *shape* ADR 0018 declares and names as an example, computed by
`useCommands` and enumerated by the boot-time conflict check — removing
it would be an ADR edit, not a dead-variable cleanup.

**Item 5 — Recent projects.** `UiState.recent_projects` joins
`last_project` at **user scope** (`state.rs`'s `SCOPES`), per ADR 0042
§3 and the owner's 2026-08-22 ruling: a list of projects is a memo about
particular files, so ADR 0034 makes it state and not a setting, and it
must not be workspace-scoped because its whole job is to name the
project you are *not* in. No ADR diverged from, so no amendment; ADR
0042 §3's table cell and ADR 0034's `project.close` mention were updated
to match the code. The bound is the setting, `recent_projects_limit`
(default 8, `Scope::UserOverridable`, `Kind::Behaviour`), exactly the
`recent_blfs_limit` / `recent_commands_limit` idiom. Frontend: a
`recentProjects.ts` pair of pure helpers over the shared `pushRecent`, a
`Projects` chip menu on the bar, and one
`Open recent project: <name>` palette entry each — the same two surfaces
recent captures already occupy, built from the same list so they cannot
drift. The host owns the list; React holds a seeded window on it, the
way `recentCaptures` does.

*List hygiene, decided here.* **Dedupe on path and reorder on open** —
`pushRecent` moves an entry to the front, so the list is ordered by when
you last worked in a project, the only ordering that stays useful as it
fills. **Recording happens in `rememberProject`**, the one place the
session records which file it is working in, so the last-project pointer
and the MRU cannot disagree; `null` (a New project, which has no file
yet) adds nothing. **A missing file is forgotten only when opening it
fails** — the failed `openProjectAt` and the failed boot reopen both
drop it. Nothing stats the list to prune it in advance: an entry on a
disconnected share or an unmounted drive is still the project the user
wants, and statting every entry to draw a menu would stall the bar on
exactly those paths.

**Item 6 — Save as a split chip.** Save and a `▾` disclosure are two
`ChipButton`s inside one `ChipSegment` — 108's existing "several chips,
one hairline" shape, not a new component. Pressing **Save** dispatches
`project.save` and opens nothing; only the caret opens the menu, whose
single entry runs `project.saveAs`. The owner's rule ("clicking on the
save button should just save") is pinned by a test that asserts the Save
chip carries no `aria-haspopup`, dispatches exactly `["project.save"]`,
and leaves `.save-split-menu` absent.

### A bug found on the way, and fixed

`pushRecent`'s cap ignored a limit of zero: `recent_blfs_limit: 0`,
documented as "remembers none", still kept the one entry just pushed
(the guard was `out.length >= limit` *after* seeding `out` with the new
value). Falsified before fixing — the new
`recentMru.test.ts` case failed with `[ 'c' ]` against `[]` — then a
`limit <= 0` early return made it pass. It fixes all three lists at
once, which is why it was fixed rather than worked around in the new
one.

### Tests

- `recentProjects.test.ts` (5): MRU push / dedupe-and-reorder / cap /
  zero bound / forget.
- `recentMru.test.ts` (+1): the zero-limit regression guard.
- `Toolbar.dom.test.tsx` (+5, and the bar table grew three rows): the
  Projects menu and its absence when empty, the Save press not opening
  the menu, Save As reachable only from the caret, and the two chips
  sharing one segment.
- `App.recentProjects.dom.test.tsx` (4, new): against the real `App`
  with a mock that splits user-scope from workspace-scope state — the
  list records each open most-recent-first and survives a project
  switch, an entry leaves only when an open actually fails, the palette
  offers the same list, and the renamed command is findable by both
  names.
- `state.rs` (3 existing tests extended): `recent_projects` lands in the
  user file, is absent from the project file, and is visible from a
  second project.
- `commands.test.ts`: `project.new` is available with no project file
  open.

Test-kit fallout: `toolbarTestKit.ts`'s `toolbarChip` matched
`.toolbar > .chip-button, .toolbar > * > button`, which cannot see a
chip nested inside a segment inside a menu wrapper. It now takes every
button on the bar that is not inside an open menu list.

### Not done

**Perf skipped by owner instruction** (queue 2.5). No ADR-0031 capture
was taken and nothing was written to
`docs/performance-measurements/frontend/`.

**Stale README copy from phase 1 fixed in passing.** Two paragraphs
still described the project panel's *Connect all* / *Disconnect all*
button, which phase 1 removed. Both now point at the status-bar chip —
a doc-vs-code mismatch in a paragraph this phase was editing anyway.

**2026-08-23 — Phase 5 (The keyboard-nav highlight), item 8.**
Branch `task-109-phase-5-nav-highlight` off
`task-109-phase-4-project-affordances`. Investigation-first; the
scientific-method chain is below and the fix cites the experiment that
confirmed it.

### Observation

The owner's, verbatim: *"seeing weird highlighting during keyboard nav
in the trace panel; the entire box gets highlighted on leftarrow"*.

### Hypotheses

1. **Focus lands on a container carrying a visible ring.** Every
   gridview container is `tabIndex: 0` and no stylesheet rule suppresses
   its outline, so a press that changes nothing would leave the UA ring
   round the whole scroll viewport as the only visible change. (Offered
   by phase 3 as a place to point the reproduction, explicitly not a
   verdict, and untested there.)
2. **ArrowLeft moves the cursor to a parent row whose selected styling
   spans the whole box.** `gridviewRows.ts`'s `ArrowLeft` case walks out
   to the nearest shallower row when there is nothing to collapse.

### Experiment

A jsdom reproduction against the real `TraceView`
(`apps/gui/src/zzExperiment.dom.test.tsx`, scratch, deleted after the
run), logging `document.activeElement`, the container's
`aria-activedescendant` and every row's class list after each press.
jsdom does no layout, so this pins **which element holds focus and what
classes apply**, never appearance — which is exactly what separates the
two hypotheses: hypothesis 2 predicts a class change on some element,
hypothesis 1 predicts none. Two entry paths were run, mouse-then-
keyboard and keyboard-only, because they differ in when the container
takes focus.

### Data

Keyboard-only entry, ten collapsed frame rows:

| Step | `document.activeElement` | `aria-activedescendant` | rows changed |
|---|---|---|---|
| after render | `BODY` | absent | — |
| container focused (as Tab would) | `DIV.trace-rows` | absent | none |
| ArrowDown | `DIV.trace-rows` | `trace:r0:-f%3A0` | row 0 gains `selected` |
| **ArrowLeft** (depth-0, collapsed) | `DIV.trace-rows` | `trace:r0:-f%3A0` | **none** |

`ArrowLeft` reported `defaultPrevented=true` and
`document.documentElement.outerHTML` **byte-identical** before and
after. Mouse-then-keyboard entry behaved the same on focus: the click
handler focuses the container (`makeRowGridPropsCache`), never a row.
Where ArrowLeft *does* move — from a disclosed depth-1 signal row — the
only class it applies is `selected` on one 22 px `.trace-row`.

### Conclusion

**Hypothesis 2 is falsified.** In the reported case ArrowLeft changes
nothing in the app's own markup at all, and in the case where it does
move, the class it applies covers one row, not the box.

**Hypothesis 1 is confirmed for the part the instrument can reach.**
The element holding focus after ArrowLeft is `DIV.trace-rows` — the
whole scroll viewport — and a stylesheet walk finds no rule touching
`outline` on it or on any other gridview container. A `tabindex="0"`
element with focus and no author outline gets the UA focus ring; that
last link is a browser fact, not something jsdom can show, and is
recorded here as an inference rather than a measurement.

**Why ArrowLeft and not ArrowDown.** ArrowLeft on a collapsed top-level
row is the one nav key that moves nothing: the arrows and Home/End move
the cursor and its row highlight with it, ArrowRight expands. Selectors
4's own UA note — *"if the user interacts with the page via the
keyboard, the currently focused element should match
`:focus-visible`"* — puts the ring up on the first keypress and leaves
it up, so on every other press it is chrome behind a moving row
highlight, and on this one it is the only thing that changed. The fix
is therefore not ArrowLeft-specific either.

### The fix

One rule in `index.css`, keyed on the attribute `useGridview` stamps on
every container:

```css
[data-gridview][aria-activedescendant]:focus { outline: none; }
```

**Not `outline: none` on the containers.** A keyboard user needs to
know where focus is, and the container is where it is. The
`[aria-activedescendant]` guard is the whole design: React omits that
attribute while `cursor` is `null`, so a container Tabbed into before
the cursor has moved anywhere **keeps its ring** — there is no row
indicator yet for it to defer to — and loses it the moment a row starts
carrying the cursor. `:focus` rather than `:focus-visible` because
`:focus` is the superset, and the guard, not the pseudo-class, is what
protects the accessible case.

**Shared, not per-panel.** All nine gridview containers
(`.trace-rows` ×3, `.dbc-panel-tree`, `.rbs-tree`, `.rbs-signals-rows`,
`.tx-panel-list`, `.view-signals-rows`, `.blf-map-markers-list`) carry
the same artefact and are fixed by the one rule; so is any panel that
adopts the layer later. Filed as owner-review-queue 1.29, since it is a
visible change to focus indication in every grid panel.

**The panels were surveyed for what the rule leans on.** Six declare
`isSelectable: () => true`, so the cursor collapsing the selection onto
itself is what marks the row; `DatabasePanel` and `RbsPanel` have
unselectable rows and mark the cursor directly (`.dbc-row-active`,
`data-active`); the trace's timeline event rows, also unselectable,
carry `.trace-event-focused`. No gridview leaves a cursor unmarked, so
none is stranded by the rule.

### Tests

- `gridviewFocusRing.test.ts` (3, new) — reads `index.css?raw` the way
  `dockPanelScrolling.test.ts` does, since jsdom neither lays out nor
  loads the stylesheet. The suppression exists and is focus-scoped; no
  suppression exists that is *not* attribute-guarded (the a11y half —
  this is what an "`outline: none` everywhere" fix would trip); and
  every panel's row-level cursor indicator is still drawn.
- `TraceView.gridview.dom.test.tsx` (+1) — the DOM contract the rule
  keys on: container focused with no cursor names no row and marks
  none, ArrowDown names one and marks it, and ArrowLeft on a collapsed
  top-level row leaves focus and `document.body.innerHTML` untouched.

Falsified before being trusted: rewriting the rule as
`[data-gridview]:focus` fails two of the three CSS cases, and renaming
`.dbc-row-active` fails the third with the panel named in the message.
The first CSS case failed before the rule was added.

**Docs.** ADR 0044's cursor-and-focus paragraph carries a 2026-08-23
amendment stating the rule and the obligation it puts on panels — each
owes its cursor a visible row indicator that does not depend on the row
being selectable.

### Not done

**Perf skipped by owner instruction** (queue 2.5). No ADR-0031 capture
was taken and nothing was written to
`docs/performance-measurements/frontend/`.

**No browser-rendered confirmation.** Per the no-UI-automation rule the
ring itself was never photographed; the chain above stops at "the
container holds focus and no author rule suppresses its outline". The
closing look is the owner's, on the installer.

## Blockers / side effects

**Phase 4 - a stored keybinding on `project.close` stops working.**
Renaming the command id makes any user customisation naming
`project.close` an unknown-command binding. It is not silent: the
sanitiser refuses it and `reportRejectedBindings` writes
`ignoring keybinding "<chord>" -> project.close: unknown command` to the
system log on load. There is no default binding for it, so this only
reaches a user who bound it by hand. No migration was written, per
ADR 0011's no-migration posture for best-effort machine-local files.

**Phase 2d - the owner's Vector re-test script, and the phase is
unverified until it is run.** Everything in phase 2d was written from
python-can 4.6.1's own field definitions and tested against faked
chip-state events. No Vector adapter exists in an agent's environment
and neither does the XL library, so the backend cannot even load there -
python-can logs *"Could not import vxlapi: Vector XL library not found:
vxlapi64"*. **This path has never met Vector hardware.** Treat a Vector
bus-health reading as unconfirmed until this script has been run.

**What to do.** A Vector device on a 500 kbit/s bus with a second node
that ACKs (a second channel on the same card is enough - bind both as
separate logical buses), a project that runs RBS on the bus the Vector
channel is bound to, connected and streaming. Then **pull one end of the
CAN cable** - the wire, not the USB plug. This is the same fault phase
2c's PEAK script exercises, on the other vendor.

| Where | Expected within ~1 s |
|---|---|
| Bus health panel, transmitting bus | **Error-passive**, TEC climbing to 128 and pinning there, REC 0 |
| Bus health panel, receiving bus | load falls to `0 %`; its own state may stay error-active, which is correct - it is not the node failing to transmit |
| Bus health launcher | tints (warning tint on the way up, fault tint only if it reaches bus-off), count 1, tooltip naming the bus |
| RBS panel | periodics keep running. Warning and error-passive deliberately keep their routes |
| Trace | **record whether it gains rows, and roughly how fast.** PEAK floods it at about 5,200 error frames/s during this fault; whether Vector does the same is unknown and is a data point for queue 3.39 |

Plug the cable back in: within about a second TEC counts back down to 0
and the panel returns to **Error-active** on its own. Nothing needs to
be restarted.

**Also worth one deliberate check the PEAK script does not need**: run
the same fault on an **FD-configured** Vector bus as well as a classic
one. The two event queues are different structs read through different
hooks (`handle_can_event` / `tagData.chipState` for classic,
`handle_canfd_event` / `tagData.canChipState` for FD) and only one of
them is exercised by a given open. A classic run says nothing about the
FD path.

**If the panel stays error-active with TEC 0**, the chip-state events are
not arriving. The request is placed on every 500 ms poll through
`xlCanRequestChipState`; if it were failing the panel would read
**Adapter unavailable** instead, so error-active with zero counters means
the request succeeded and the answer either never came or came with a tag
the hook did not match. The sidecar's debug log (`--log-file`) is the
place to instrument next - the hooks are silent by design, since they sit
on the receive path.

**If the panel reads `Adapter unavailable`** on a card that is plainly
present, `xlCanRequestChipState` is raising. python-can's `errcheck`
raises on any non-zero XL status, including ones that are not "the card
is gone"; the raised `VectorOperationError` names the status, and it will
be in the sidecar's stderr / log file. That would mean the request needs
a narrower failure test than "any exception", which is a real possibility
this phase could not distinguish from here.

**If Vector's counters read plausibly but the state does not move**, the
derivation is shared with PEAK and PEAK's is bench-confirmed, so suspect
the `busStatus` mapping rather than the thresholds: `XL_BusStatus` is
read as a bit field, and a card that reports it as an enumerated value
instead would land on the wrong branch.

**Phase 2c - the owner's re-test script.** Everything in phase 2c was
established against the recorded bench payloads and against the
installed python-can package; no PEAK adapter exists in an agent's
environment, so the closing confirmation is owner-run. It covers the
CAN-link fault, and does not replace phase 2's script below - those are
different tests of different paths.

**What to do.** Two PEAK adapters on one 500 kbit/s bus, a project that
runs RBS on the pack bus, both connected and streaming. Then **pull one
end of the CAN cable** - the wire, not the USB plug.

| Where | Expected within ~1 s |
|---|---|
| Bus health panel, transmitting bus | **Error-passive**, TEC climbing to 128 and pinning there, REC 0 |
| Bus health panel, receiving bus | load falls to `0 %`; its own state may stay error-active, which is correct - it is not the node failing to transmit |
| Bus health launcher | tints (warning tint on the way up, fault tint only if it reaches bus-off), count 1, tooltip naming the bus |
| Pack bus trace | **keeps gaining rows** - those are the error frames, at roughly 5,200/s. Not a regression; see queue 3.39 |
| RBS panel | periodics keep running. Warning and error-passive deliberately keep their routes |

Plug the cable back in: within about a second TEC counts back down to 0
and the panel returns to **Error-active** on its own. Nothing needs to
be restarted.

**If the panel stays error-active**, the derivation is not seeing the
counters. First check whether the trace is gaining rows during the
fault: if it is **not**, the adapter is not emitting error frames and
the fault is upstream of everything this phase touched - grep the
sidecar log for `rx stats` on that interface to confirm frames are
arriving at all. If the trace **is** gaining rows but the panel is not
moving, the payload layout differs from the bench capture: the decode
reads bytes 2 and 3 of the error frame's payload, and those bytes are
visible in the trace row itself.

**If the panel reads `Adapter unavailable`** instead, phase 2's path
fired rather than this one - that means a device read failed, which a
CAN-link fault should not cause. Worth reporting; the two paths are
meant to be distinguishable.

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
