# Owner Review Queue

Everything from the current overseen chain that is waiting on the owner,
in one place. Opened 2026-08-21 at the owner's instruction ("make sure
we don't lose track of any of these items — I don't have time to review
right now").

**This file is an index, not the record.** Every item's real detail
lives in its task file, under that task's `## Blockers / side effects`
or its status log. The point of this file is that those are scattered
across a dozen task files and a long conversation; this is the single
list to walk when there is time.

**Keep it current.** Items get struck out with the ruling and its date
when the owner decides, and the file shrinks as tasks are accepted. If
it is growing faster than it drains, that is the signal to stop taking
new work and hold a review.

**§ 1 drained on 2026-08-24** and is the one section where the prose was
*removed* rather than struck out, at the owner's instruction. The acceptances
survive as § 2.9 and the rework rulings as § 2.10; § 1 keeps a one-row index
per item so the sixteen task files citing `owner-review-queue 1.N` still
resolve, and each row names the task that now owns it. Do the same for §§ 3–5 only on the same instruction — striking
out is still the default.

---

## 1. Behaviour changes, walked by the owner 2026-08-24

**Nothing in this section is waiting on them any more.** All 33 items got
a response:

- **18 accepted.** The prose is gone at the owner's instruction; every
  ruling is one row of [§ 2.9](#29-the-2026-08-24-queue-walk--eighteen-accepted),
  so a task file citing `owner-review-queue 1.5` still resolves to its
  verdict.
- **15 sent back for rework** — **3 now closed** (1.2 ratified; 1.16 and
  1.18 dropped as intractable), 2 answered with work or acceptance owed,
  2 scoped, 6 open, one (1.33) split. **11 of the 15 still carry work.** The owner began walking them one at a time
  on 2026-08-24 and 2026-08-25; every ruling is in
  [§ 2.10](#210-the-rework-rulings). They were first grouped into seven
  decisions rather than fifteen items, then **dispersed into eight tasks**
  as each was settled:

  | Task | Items |
  |---|---|
  | [112 — the signal reference registry](tasks/0112-signal-reference-registry.md) | 1.3's residual, 1.19, 1.30 |
  | [113 — is RBS a grid?](tasks/0113-rbs-as-a-grid.md) | 1.6, 1.26, 1.13c |
  | [114 — one name per thing](tasks/0114-one-name-per-thing.md) | 1.37, 1.33b, 1.17 |
  | [115 — trace row menus](tasks/0115-trace-row-menu-scope.md) | 1.23 |
  | [116 — RBS problems across configurations](tasks/0116-rbs-problems-across-configurations.md) | 1.13ab |
  | [117 — refuse to connect](tasks/0117-refuse-to-connect-without-a-bound-bus.md) | 1.34 |
  | [118 — `comment-references` leaves CI](tasks/0118-comment-references-out-of-ci.md) | 1.35 |
  | [119 — duplicate-id example DBCs](tasks/0119-duplicate-id-example-dbcs.md) | 1.33a |

  1.16 and 1.18 were dropped as intractable ([task
  101](tasks/0101-bus-health.md)); 1.2 was ratified with no work left. **Four of the fifteen correct a premise something
  rested on** — 1.17, 1.26, 1.35 and 1.13's third part — so those are
  re-established before anything is changed.

The index below is what keeps the numbers resolvable. Strike a row out as
the task named in its last column closes its item.

**Status** is where the item stands after the 2026-08-24 codebase
investigation; each row carries what it found. Nothing has
been implemented — an *answered* item still has to have its answer accepted,
and a *scoped* one still has to be built.

| Status | Means |
|---|---|
| **Answered** | the question has an answer, evidenced; only acceptance is left |
| **Scoped** | still work, but its shape, cost and the code it touches are known |
| **Open** | not investigated — the response was transcribed and nothing more |
| **Owner** | waiting on the owner, not on us |

**Two rows carry a correction rather than a verdict.** 1.17's finding
described the wrong half of a two-part cell — the owner's reading was
right — and 1.13's third part credits the prototype with removing row
highlighting, which its own comments say it kept. Neither changes what was
asked for; both change what has to be justified. **1.13c has since been
ruled on other grounds entirely** (2026-08-25): row background belongs to
the gridview layer, so a panel painting its own is the defect whatever the
prototype did.

| # | Status | Subject | Where it went |
|---|---|---|---|
| ~~1.2~~ | **Closed** | An unpicked collision's row reports a signal only a later database defines | **Ratified 2026-08-24**, no work left — [§ 2.10](#210-the-rework-rulings). |
| 1.3 | Answered · work owed | Did the one resolution rule and its overrides actually land? | **Answered yes 2026-08-24**, with the tests run — but **not closed**: the ruling that settled it (a transmit row carries its own DBC) is unbuilt. [§ 2.10](#210-the-rework-rulings). The residual moved to [**task 112**](tasks/0112-signal-reference-registry.md) on 2026-08-25 — a transmit row is `bus + message id + which database`, the same shape the registry is built on, and it takes finding 3.1 with it |
| 1.6 | Scoped | Editor-face content stays a block rather than becoming rows | [**task 113**](tasks/0113-rbs-as-a-grid.md) § 1 — **the dev asked for was not done**. `gridviewContentRows.ts` is adopted by the two trace views and by neither RBS nor transmit, so this is adoption, not new machinery |
| 1.13 | Open · premise corrected · **split** | The RBS chip navigates to an individual RBS file | **a and b:** [**task 116**](tasks/0116-rbs-problems-across-configurations.md) — build the all-configurations view and its per-file filter. **The steps-to-reproduce leg is dropped**, ruled 2026-08-25: *"I'm not looking at it, I don't even remember what was claimed."* **c:** [**task 113**](tasks/0113-rbs-as-a-grid.md) § 3 — **ruled 2026-08-25**: *"row highlighting is a gridview behavior."* The wash comes out on both signal-mapping surfaces, and the Row Highlights chip and its persisted `washesOn` param with it. The prototype was never the argument — it kept row highlighting and only omitted drawing it |
| ~~1.16~~ | **Dropped** | Bus load is a documented floor, not an exact figure | **Dropped 2026-08-24 — not tractable.** PCAN and Vector expose no bus load through python-can; only Kvaser does, and Kvaser is the deferred vendor. Recorded at [task 101](tasks/0101-bus-health.md). |
| 1.17 | Answered | The virtual-bus adapter cell is blank where the mock drew text | [**task 114**](tasks/0114-one-name-per-thing.md) § 3 — **the cell is not blank**; it shows `LOCAL_VBUS_INTERFACE`, a wire id falling through the display-name lookup. **Ruled 2026-08-25**: the generic `virtual bus`, not the vbus's name — *"this is the hardware column. We already have the user's bus name on the same row"* |
| ~~1.18~~ | **Dropped** | Error coalescing keys on the bus, not on the error class | **Dropped 2026-08-24 — nothing to carry.** Every dongle reports a bare boolean, and the one byte BLF holds is marked invalid on every file cannet writes. Recorded at [task 101](tasks/0101-bus-health.md). |
| 1.19 | Answered · **look owed, not work** | A DBC-backed plot series naming no bus resolves nothing | The re-point was built for this case: one pick, no apply step, every view rewritten at once. **No task carries this** — its one remaining leg is that the attention badge actually leads a user there from an empty plot, which is a *look* at a running build, owed when the signal-mapping panel is accepted. [Task 112](tasks/0112-signal-reference-registry.md) eases the repair's internals and leaves this leg untouched |
| 1.23 | **Ruled** | A right-click on a trace frame row leads with an event action | [**task 115**](tasks/0115-trace-row-menu-scope.md) — the event item is accepted; the sources picker comes off row menus. **Ruled 2026-08-25**, settling where it lives instead: *"the button bar portion of the view is the only place I ever wanted those items to appear in the trace view."* |
| 1.26 | Open | Space in the RBS signals grid toggles the whole message | [**task 113**](tasks/0113-rbs-as-a-grid.md) § 2 — Space on a signal row does nothing |
| 1.30 | Open · reshaped | A signal-generator rule's matches are still not pushed | **Moved to [task 112](tasks/0112-signal-reference-registry.md) 2026-08-25.** The ask stands; the mechanism was the question. This is a **push model's failure mode**, so fixing it as scoped means writing another pusher the registry deletes |
| 1.33 | Answered (b) · Owner (a) · **split** | A duplicate-id collision marks only the losing database | **a:** [**task 119**](tasks/0119-duplicate-id-example-dbcs.md) — the warning awaits the owner's review, and reviewing needs material: *"I need example DBCs to test with."* **b:** [**task 114**](tasks/0114-one-name-per-thing.md) § 2 — the toolbar chip is `dbc.add`, and the DBC → Database rename was already made everywhere else, migration included |
| 1.34 | **Ruled** | A project with no buses captures nothing, and says nothing | [**task 117**](tasks/0117-refuse-to-connect-without-a-bound-bus.md) — the empty-project case is **already refused**, by a guard naming the wrong thing. The real gap is per-bus: any unbound bus in a multi-bus project is silently dead. **Ruled 2026-08-25:** *"loud fail. capture new task."* |
| 1.35 | **Ruled** | The `comment-references` CI gate | [**task 118**](tasks/0118-comment-references-out-of-ci.md) — keep the check, drop the CI job. **Ruled 2026-08-25:** *"Put it in the subagent and overseer. this is a dumb check to put in CI IMO."* Every phase's CI table becomes five jobs |
| 1.37 | Answered | ADR 0055's "do not convert a command into a chip" was amended | [**task 114**](tasks/0114-one-name-per-thing.md) § 1 — **the code is what the owner described**: a 50-command registry every chip dispatches from. The divergence is a second label per command, declared in `Toolbar.tsx` |

Items **1.7** and **1.10** were resolved earlier; **1.11** and **1.12**
were filed under § 2 when they were recorded. All four sit there rather
than here.

---

## 2. Ruled, and recorded here so the ruling is not lost

### 2.1 Shape D — the per-frame decode fall-through stays open
Ruled by the owner 2026-08-21 · [task 92](tasks/0092-one-resolution-rule.md)

*"User can cure anything that doesn't match using the signal view. A
special case on mux arm is pretty esoteric and I'm ok with it being
wrong given you can just fix it."*

Two sites keep the fall-through, both pinned by tests as accepted
trades. **With one correction the owner should know about**: the cure
was real only at `sample_shared`. The mux extractor, the value tables
and the three calculated-field sites all ignored the pick map. Phase 3
routed them through the resolver that honours picks, so the premise the
ruling rests on is now true everywhere rather than at one site in four.

### ~~1.7 The perf baseline no longer describes the project it is measured against~~
[Task 96](tasks/0096-long-names-render.md) · **RESOLVED 2026-08-22 — re-baselined on the owner's ruling** (`04e3ab76`; ADR 0031 amended with the ruling and its caveats). The stored `baseline.json` is now measured against the grown `ev-zonal` with `--rbs-run-on-start`, so the ambiguity below is gone and no `b6fca9c8~1` control is needed at close-out. Kept for the record.

Task 96 added a long-name message to both example projects, as ruled:
`zonal.dbc` 151 → **152 messages**, 536 → **541 signals**; `bms.dbc`
gains `0x303` at 200 ms, about **+5 f/s** on ev-demo's ~515.

`ev-zonal` is the render-tier harness's project, so **the gate's
`baseline.json` was measured against a project that no longer exists.**
The owner accepted the gate consequences when ruling that both examples
get the long names — this records what they actually are.

The consequence is for the *end-of-chain* gate specifically: a reading
against the grown project is not comparable to the stored baseline
line-for-line, so a difference there is ambiguous between "the chain
regressed something" and "the project got bigger". Resolvable, but it
has to be done deliberately:

- A pre-change reading is recoverable by building `b6fca9c8~1` — the
  commit before the DBC grew — and gating that. That is the honest
  control, and it is a same-day build rather than a stale baseline.
- Task 96's grooming had asked the *implementing* phase to take that
  control before changing the DBCs. It did not, because the standing
  contract forbids phase agents from running the harness and the
  contract won. Neither side was wrong; the interaction was not
  foreseen.

**Needed at close-out: gate `b6fca9c8~1` as the control alongside the
final tree, or re-baseline deliberately with the owner's sign-off.**
Not a licence to promote a baseline to make a run pass — limits still
ratchet down only.

### ~~1.10 The perf harness's bus load was a project field, and is now a flag~~
[Task 99](tasks/0099-transmit-controls.md) · **RESOLVED 2026-08-22.** `--rbs-run-on-start` is now part of ADR 0031's documented invocation and of the re-baselined reading, and the pre-flag control is no longer needed (see 1.7). The standing rule survives: **sanity-check `ids_measured` and the rx/tx rates on every report** — a gate that passes without load is meaningless, not reassuring.

ADR 0031's render-tier run got its bus traffic from the example
projects' `"run": true` — which is precisely the open-a-file-and-start
transmitting that the owner's ruling forbids. Removing persisted run
state therefore **disarmed the harness silently**: a gate run would have
connected, measured an idle bus, and passed.

Fixed in `a4009bbb` with an explicit `--rbs-run-on-start`, and the dead
field removed from `ev-zonal` and `ev-demo`.

**Consequences for the close-out gate, which now has three moving
parts:**

1. Every run against the current tree **must pass
   `--rbs-run-on-start`**, or it measures nothing. A gate that passes
   without it is meaningless, not reassuring.
2. The control build named in 1.7 (`b6fca9c8~1`, before the DBCs grew)
   predates the flag and still carries `"run": true`, so it arms itself
   and must be run *without* the flag. The two invocations differ by
   design; the load they produce should not.
3. So a bare "run the gate" at close-out is now wrong in two distinct
   ways. It needs designing, not repeating.

### 1.11 Unassigning now clears a running RBS element's Run
[Task 99](tasks/0099-transmit-controls.md) · **changes a landed task 88 phase 4 behaviour**

Phase 4 deliberately left Run set when an unassign stopped an element,
because Run was mirrored from the project file. That reason is gone with
persistence, so the asymmetry went with it. Deliberate, recorded, and a
reversal of something already reviewed and accepted.

### 1.12 `start` on a transmit row is no longer disabled by a disconnected bus
[Task 99](tasks/0099-transmit-controls.md)

Not named in the exit criteria. Taken because leaving it would have had
the button refuse what Space now accepts — the owner's no-guard ruling
applied consistently. `send` stays locked.

### 2.2 The perf gate is deferred to the end of the chain
Ruled by the owner 2026-08-21

*"Don't even bother with the gates now. We can check at the end and
bisect later if there's a regression."* Unit tests and clippy still run
per commit — they are what keeps commits green enough to bisect
*through*. The render-tier gate runs once at the end.

Last full gate: task 92's tree (88 + 92 + 91 + 93), four runs, 31
metrics, all passing, with a same-day control proving the apparent
append/scan drift was machine state and not the change.

---

### 2.3 The gate does not run until development is done and the owner has looked
Ruled by the owner 2026-08-22

*"Don't run perf test until the dev is done and I have a chance to look
at everything."* This is tighter than 2.2, which deferred the gate to
the end of the chain: the run now waits on the **owner's review**, not
merely on the last phase landing. Nothing in §5's gate item — including
the harness tally fix it depends on — starts before that.

---

### 2.4 Pattern-matched signals belong in the view-signals list

**Owner ruling 2026-08-22**, on task 109 item 1: *"I think the
exception is wrong. Those fields do dynamically update but I still want
them in the list."* The owner grants the premise — a pattern's matches
re-evaluate live — and rejects the conclusion `viewSignalsPush.ts`
drew from it. A pattern row pushes identity-only and needs no host
change; it can read Decoded / Not Decoded / Ambiguous and never Scale
or Stale, which is correct rather than a gap. Detail and consequences
in [task 109](tasks/0109-usage-feedback-chip-era.md) § 1.

### 2.5 The perf capture is skipped for the rest of task 109

**Owner instruction 2026-08-22**, given mid-phase-3: no ADR-0031
capture for the remaining phases, nothing written to
`docs/performance-measurements/frontend/`. The installer stays the
per-phase deliverable. Phases record the skip in their status log so
the omission reads as a decision. Phase 3's three runs had already
completed when the instruction arrived and read in band (renderer
263–302 MB, tree 668–704 MB, rx ~1506 f/s, tx ~1749 f/s); their reports
were deleted.

### 2.6 "Unplugged the PEAK" means the CAN link, not the USB device

**Owner clarification 2026-08-22.** Task 109 item 2, and therefore task
101's failed hardware verification, is a **bus-health** fault under ISO
11898-1 fault confinement — not device removal. Phase 2 built
device-removal detection for a fault nobody has tested; the reported
one is different and remains open. The bench measurement, the
per-vendor counter sources, and the resulting phases 2c–2e are in
[task 109](tasks/0109-usage-feedback-chip-era.md) § 2 (addendum).

### 2.7 Bus-health state ships for PCAN and Vector; Kvaser is deferred

**Owner ruling 2026-08-23.** Task 109 phases 2c and 2d implement
counter-derived controller state for PCAN and Vector. Kvaser is left
out of this pass: it is the only vendor whose `canReadStatus` and
`canReadErrorCounters` python-can does not bind (nobody upstream has
ever attempted it — the closest is PR #477, which added the `err_frame`
tally that cannot yield a state), and CANlib's own header warns that
*"not all CAN controllers provide access to the error counters; in this
case, an educated guess is returned."* So a Kvaser TEC may be an
estimate where PEAK's is an exact register — the estimate-vs-measurement
question that would otherwise need a wire decision is deferred with it.
The owner re-tests on hardware after 2c and 2d land and the fix is
revisited if needed. Detail in
[task 109](tasks/0109-usage-feedback-chip-era.md) § 2 (addendum).

### 2.8 The Windows MSI bundle target is dropped
Ruled by the owner 2026-08-22 · [task 110](tasks/0110-chain-ci-repair.md)

`tauri.conf.json`'s bundle targets no longer include `msi`; a Windows
release produces the NSIS `.exe` installer only. Measured at roughly 50 s
of a ~222 s Windows bundle build, and the WiX MSI is per-machine only —
so it needed admin, where NSIS covers per-user and silent install.

Recorded here because task 110 reached neither the roadmap nor § 4 until
2026-08-23, and this is its one user-facing consequence: anyone scripting
against the `.msi` has to switch.

### 2.10 The rework rulings

The owner walked the fifteen sent-back items one at a time, from
2026-08-24. Each ruling landed here as it was given, so § 1's index can
strike the row and the reasoning survives the conversation. The item's
detail lives in whichever task now owns it — see § 1's index.

#### 1.2 — a signal only one database defines is always shown · **ratified**

**Owner ruling 2026-08-24:** *"agree. If we have a def, there's no problem,
we just apply it."*

Ratifies the phase-3 fix (`866df603`) and the behaviour change it carried
for a user who has picked nothing. Where two databases on one bus define
the same message and only the *losing* one defines some signal, that signal
now appears in the row unconditionally. It used to appear only if the
message carried a pick — so pinning one signal made a *different* one
materialise, and unpinning it made it vanish.

The owner's reasoning is the general rule and reaches further than this
item: **a single definition is not a conflict, so it is applied.** Load
order and picks decide between competing definitions; they have no business
deciding whether an uncontested one is shown at all.

One caveat was raised and not treated as blocking: the extra signal is
decoded through the losing database's bit layout, so a file that places it
over bytes the winner reads differently would show two numbers describing
the same bytes, each right by its own file. No test covers that overlap.

#### 1.3 — the resolution rule landed; a transmit row gains its own DBC · **answered, with two rulings**

Walked with the owner 2026-08-24. **The answer is yes**: one rule in
`DecodeModel`, thirteen hand-rolled copies down to four `dbc_applies`
sites of which only one is resolution, and overrides that now reach the
value, the `VAL_` labels, the counter/CRC designation, the encode and the
mux selector. Confirmed by running the pinning tests on the current tree
(2 passed, 0 failed), not by reading.

**Ruling 1 — queue 3.1 was mis-titled.** The owner: *"it's encoding a
message and handling signals so it needs both. It doesn't seem like
divergence to me — am I overlooking any duplicated code?"* No duplicated
code exists, and a test asserts describe and encode cannot drift. Encode
must choose one message entry; decode resolves one value at a time. 3.1 is
struck and reframed.

**Ruling 2 — a transmit row carries its own DBC.** *"the tx message pick
should include the dbc. Make the default decision about which one and let
the user change it."* Default is the current answer; the user can change
it. A transmit row is an encode target rather than a decoded series, so
ADR 0054 part 1 does not govern it.

**This supersedes the reasoning behind accepted item 1.32**, which was
accepted precisely because *"the alternative is stamping a DBC path on
every transmit row, which is a persisted-model change for a case nobody
has reported."* The stamp is now wanted, so 1.32's heuristic — "an
assigned database on this bus defines this message" — stops being needed.
The acceptance stands; its justification does not.

**And the generalisation became [task 112](tasks/0112-signal-reference-registry.md).** The owner: *"I wonder
if storing the live message mapping in every view is a good idea after
all. A centralized place would feel like a better place to apply this. The
per-signal vs per-reference seems like a decision we shouldn't have to be
making."* That task carries the model, the precedent already in
`AppState`, and the questions the walk settled.

### 2.9 The 2026-08-24 queue walk — eighteen accepted

**Owner ruling 2026-08-24**, walking § 1 end to end. These eighteen shipped
behaviour changes are accepted as they stand; their prose was removed from
§ 1 on the owner's instruction. Each ruling is quoted so the record does not
depend on the conversation, and the numbers are kept because sixteen task
files cite them.

| # | The change | Ruled |
|---|---|---|
| 1.1 | `unified` y-axis mode no longer scales each unit group to fill (reverses ADR 0026) | *"accepted. rm this item"* |
| 1.4 | Reload all from disk swaps each database in place, so bus assignment and priority survive | *"not a question."* |
| 1.5 | A disclosed row's clickable width is the 32 rem line | *"feels fine"* |
| 1.8 | `--no-tls` is now one flag from an unprotected routable listener | *"it's fine. `cannet-server --no-tls` is a pretty clear signal from the user about what they're trying to do."* |
| 1.9 | A bare launch draws a second firewall prompt | *"ok"* |
| 1.15 | Pressing the connection chip while connecting cancels the connect | *"approved."* |
| 1.20 | An event row in the Events view is selectable | *"working fine."* |
| 1.21 | The Link Events chip also unlinks | *"fine"* |
| 1.22 | Shift+click on a plot authors an event instead of placing a cursor | *"this is the behavior I specified."* |
| 1.24 | Acting on an event dims the plot around it | *"iterated on this already, accepted in current state."* |
| 1.25 | Hovering an event overrides a selection instead of adding to it | *"accepted"* |
| 1.27 | The bus-health launcher tints for the ISO warning limit, not only for passive and worse | *"accepted."* |
| 1.28 | `project.close` is now `project.new`, ungated, and relabelled in the palette | *"accepted"* |
| 1.29 | Every grid panel drops the browser focus ring once its cursor exists | *"accepted"* |
| 1.31 | Notes outside a selected import range are dropped | *"accepted. I'm pretty sure you already asked abotu this one."* |
| 1.32 | A hand-typed transmit row matching a DBC id stops when that database leaves the bus | *"accepted. We already otherwise assume they meant that message from the DBC. We show the signals and format from the DBC when the message ID matches."* |
| 1.36 | Every coloured event now writes the colour as the BLF marker's fill rather than its foreground | *"expected and implicit in the ask to handle bg color and fg color. accepted."* |
| 1.38 | Three of task 108's grooming owner-calls shipped on the recommended reading, unruled — the icon sprite, the bounded icon sweep, and Title Case reaching every toolbar label | *"I'm ok with this for today,"* |

Two of these carry more than a yes:

- **1.32** states a general rule, not just a verdict on the transmit panel:
  where a hand-entered CAN id matches a DBC message, the tool already
  assumes the user meant that message and shows the database's signals and
  format. The behaviour flagged is that rule applied consistently.
- **1.38** is accepted *"for today"*. Item 3 of it — every toolbar label
  re-cased, with the old sentence-case phrase surviving only as a tooltip —
  is what a user sees on every launch, so this is the one acceptance in the
  table that may not be permanent.

The other fifteen items were sent back; they are indexed in § 1, and each
row names the task that now carries it.

---
## 3. Open findings nobody has dispositioned

Recorded by the phases that found them, not yet decided. **64 findings, 52 open**
(group I walked 2026-08-25; 3.63 and 3.64 added 2026-08-26).

### The nine groups

Grouped 2026-08-25 by the decision that settles them, not by the task
that filed them. The rows below are unchanged and stay in number order —
this index is how the section is walked. **Strike a row as its group is
ruled on.**

| # | Group | Findings | The decision |
|---|---|---|---|
| A | **Can the record be trusted?** | 3.4, 3.17, 3.26, 3.27, 3.34, 3.44, 3.45, 3.62 | What acceptance requires before this chain merges. § 4 says every task was walked criterion by criterion; **3.45 says five were not walked at all** and three more are not clean, and **3.44 says nothing in the chain has been seen running**. Two findings are worse than "unverified": 3.34 and 3.62 are cases where a *broken check passed*. |
| B | **The perf gate is not believable yet** | 3.35, 3.36, 3.46 | Fix the harness before the close-out run, then rule on two metrics that can fail with no code change. 3.35 makes memory unreadable while your own cannet runs; 3.36 is a phase that could not measure because of it. Related: § 5's gesture-tally item. |
| C | **What you saw on the bench** | 3.37, 3.39, 3.42, 3.43, 3.53 | How many become tasks now. **These are the only findings in this section that came from real use** — your 2026-08-23 session. 3.37 and 3.43 are one root: a tx-confirm row is a local echo, never a wire confirmation. 3.39 is 5,200 error frames/s reaching the trace unfiltered. |
| D | **What we cannot see from here** | 3.14, 3.38, 3.40, 3.49, 3.52, 3.54 | Accept as unverified, or schedule. Each needs a device or an OS an agent does not have — your dongles (3.14, 3.38), Vector hardware (3.40), a Vector tool (3.49), a Mac (3.54). 3.52 is different: the protocol itself cannot carry what the panel promised, so it is accept-the-reduced-cell or open protocol work. |
| E | **Frontend shared-layer drift** | 3.13, 3.18, 3.19, 3.23, 3.24, 3.25, 3.51 | One cleanup task, or leave. All are copies, bypasses or two-models-for-one-thing — the shape `CLAUDE.md` § GUI architecture tells us to watch for. 3.18 and 3.51 are keyboard and ARIA, so they overlap [113](tasks/0113-rbs-as-a-grid.md)'s gridview work. |
| F | **What a file loses** | 3.9, 3.10, 3.15, 3.28, 3.29, 3.30, 3.56, 3.58, 3.59 | Which losses are accepted and recorded in ADR 0057's table, and which are fixed. **3.28 is the sharpest: every MDF cannet has written names its events the wrong `ev_type`**, and nothing rewrites the existing files. 3.58 is a task the grooming already promised once its precondition was met — which it now is. |
| G | **Calculated fields cannot say "none"** | 3.2, 3.7, 3.8, 3.50 | Whether ADR 0027's model changes. There is no value meaning *"the DBC says counter, this project says none"*, and task 100 made that gap newly reachable from the UI. 3.50 writes an override from a keystroke that changed nothing. |
| H | **Where the app and the approved prototype disagree** | 3.20, 3.21, 3.22, 3.32, 3.60 | A yes or no per deviation. Each is a deliberate departure from what you approved, taken for a stated reason. 3.60 is two places where the prototype's own numbers do not match what shipped. |
| ~~I~~ | **Process, and things needing no decision** | 3.3, 3.5, 3.6, 3.11, 3.12, 3.16, 3.33, 3.48, 3.55, 3.57, 3.61 | **Walked 2026-08-25 — all eleven ruled.** **Seven closed with no work; the other four are shipped** (2026-08-26). 3.48 was **declined** — the hand-run gates are already blessed in the subagent skill. 3.55 strikes a clause from ADR 0035. |

**3.63 and 3.64 are ungrouped** — both were found while closing group I, and neither belongs to a group drawn before they existed.

**Four findings already have a home:** 3.1 (struck), 3.31, 3.41 and 3.47
all point at [task 112](tasks/0112-signal-reference-registry.md).

**Groups A and B gate the close-out**, and nothing else in this section
does — the rest can be dispositioned in any order.

| # | Finding | Where |
|---|---|---|
| ~~3.1~~ | **Reframed 2026-08-24 — the title was wrong and the owner said so.** There is no duplicated code and describe/encode cannot drift (`the_transmit_panels_message_queries_follow_the_pick`); encode resolves per message because it must choose one message entry, decode per value. What remains is one panel where the readback decodes per signal, biting only an *unpicked signal on a picked message* — closed by the owner's ruling that a transmit row carries its own DBC. See [task 112](tasks/0112-signal-reference-registry.md), which carries that ruling as of 2026-08-25. | [task 92](tasks/0092-one-resolution-rule.md) |
| 3.2 | Calculated-field resolution stays **per message**, decided explicitly rather than inherited — so a pick on any signal of a message moves the whole designation. | [task 92](tasks/0092-one-resolution-rule.md) |
| ~~3.3~~ | **Shipped 2026-08-26.** All six labels deleted — five in `index.css`, one in `cannet-blf/Cargo.toml`; the surrounding comments keep their meaning. **Ruled 2026-08-25 — delete them: *"can't we just remove the stale labels?"*** Bare "Phase N" labels survive in `index.css` (5 sites) and `crates/cannet-blf/Cargo.toml` (1). They name no task and point at no `plans/` path, so both the rule and the new CI lint pass. An older numbering scheme; left rather than invent a meaning. | shipped |
| 3.4 | Nothing in the 2421-test suite caught task 98's defect, and the two tests nearest it asserted the very rule that produced it. Worth asking what else is pinned that way. | [task 98](tasks/0098-common-scale-wrong.md) |
| ~~3.5~~ | **Shipped 2026-08-26.** Eleven genuinely broken links repaired. The other 41 were `private_intra_doc_links` and are **allowed at the crate root with the reason in the code** — `cannet-gui` is an application crate, so a `pub` item pointing at a private sibling is the useful link and widening visibility to quieten a lint would make the code worse. Gated at `-D warnings` in the commit hook, in CI (a seventh job), and in both agent skills. **Ruled 2026-08-25 — fix them and gate them: *"fix it, add to pre-commit."*** `cargo doc -p cannet-gui` emits **47 warnings** — unresolved links, public docs pointing at private items. All pre-existing, none from this chain. No task opened. | shipped |
| ~~3.11~~ | **Shipped 2026-08-26.** One flag read after `Mdf4File::open`, before the walk. Worse than recorded: the first checkpoint arrives `CHECKPOINT_RECORDS` in, so a file smaller than one stride never read the flag at all and completed despite the cancel — pinned by `a_cancel_raised_before_the_walk_starts_is_honoured`, watched failing first. Progress *during* the open stays accepted. **Ruled 2026-08-25** — **the cancel is cached already**, it is just never read before the walk: one check after the open makes the press land. Progress during the open stays accepted. **The MDF census's first ~10 % is uninterruptible and unreported.** `Mdf4File::open` reads the whole file before the walk begins, so Cancel does not land and the progress bar does not move during it. Interrupting it means restructuring how every MDF is read — recorded rather than fixed. | shipped |
| ~~3.12~~ | **Ruled 2026-08-25** — **closed.** Internal shapes, no out-of-tree consumers. Three IPC wire shapes changed: `scan_*_channels` may now return `null` (a cancelled census), `open_log` / `import_mdf` gained `totalFrames`, and `signal_pyramids_rebuilding` returns a record. Internal, but they are the kind of thing an out-of-tree consumer would trip over. | [task 104](tasks/0104-load-progress-and-cancel.md) |
| 3.9 | **A recovered BLF is dated from 1970.** A stub header carries the unset SYSTEMTIME, so `start_unix_nanos == 0`. Unrecoverable by construction — per-event timestamps are offsets *from* that anchor — so task 105 names it in the recovery log line rather than repairing it. A recovered capture therefore opens with a plausible-looking but wrong absolute time. | [task 105](tasks/0105-unfinalized-blf-recovery.md) |
| 3.10 | **An abandoned MDF `.part` opens as a silently empty capture.** `MdfCanFrameSource::open` accepts a 572 kB part file, walks to **zero** frames, and `is_unfinalized()` returns `false`. The writer emits the group description at `finish()`, so the records on disk have nothing describing their shape, and the ID block still reads `MDF` rather than `UnFinMF`. Fixing it is a writer change, and it is only reachable through the UI once `.part` discovery exists — out of task 105's scope. | [task 105](tasks/0105-unfinalized-blf-recovery.md) |
| 3.7 | **A DBC-declared calculated field cannot be suppressed by a project.** `merge_calc_override` is `o.counter.or(default)` — there is no value meaning "the DBC says counter, this project says none", so unchecking a section showing a DBC `Default` writes nothing and the field returns on reopen. That is ADR 0027's model as written, but task 100's seeding is what turns that checkbox into a live control over a DBC-declared field for the first time, so the gap is newly reachable. Expressing suppression is an ADR-level change to `CalcFieldsSpec` and the `.cannet_rbs` format. | [task 100](tasks/0100-calc-fields-dbc-config.md) |
| 3.8 | The RBS feed collapses the DBC and override layers, so on an overridden field the `Override` chip is right but the "DBC default: …" hint is empty — where the transmit panel fills it in. | [task 100](tasks/0100-calc-fields-dbc-config.md) |
| 3.13 | **`useBusHealth` hand-rolls the host-mirror instead of using `useHostMirror`.** It fetches a snapshot, then registers the listener, with no post-listener refetch — precisely the launch race the shared hook exists to close (six other call sites use it). It copied `useConnectionStates`, which predates the hook. The 1 Hz emitter closes the stale window fast, so the user impact is small; the duplication is the real problem. **Assigned to task 108 phase 2**, the shared-layer phase. | [task 101](tasks/0101-bus-health.md) |
| 3.14 | **Controller state and TEC/REC are unverified on hardware.** The sidecar's state-poll thread was already producing `InterfaceState`; task 101 built the consumer and tested it at unit tier, but no dongle was available to the phase. The owner holds the hardware. | [task 101](tasks/0101-bus-health.md) |
| 3.15 | **`cannet-mdf::FileSignal::timestamps_ns` is documented "ascending" with nothing enforcing it** — no sort in `signal_groups`. Argued structurally sound (one source, no CAN-style interleave), but it is a data-source crate *below* the signal cache and outside the phase's boundary, so it was recorded rather than swept. | [task 106](tasks/0106-any-bus-series-and-sample-order.md) |
| ~~3.16~~ | **Ruled 2026-08-25** — **closed.** Fixed in `3b8fd808`, and the surface it feeds was hidden throughout, so the wrong numbers were never on screen. **`plotCursors::statsOver` undercounted a span with tied sample times** — fixed in `3b8fd808` with a real lower bound. FYI rather than a decision: worth knowing because the measurement strip it feeds is the surface [task 108](tasks/0108-gui-chip-redesign.md) rules stays hidden pending rework, so the wrong numbers were not on screen. | [task 106](tasks/0106-any-bus-series-and-sample-order.md) |
| 3.17 | ~~A phase reported a gate clean that was not.~~ **CORRECTED 2026-08-22 — the gate was at fault, not the phase.** `git grep` cannot see an untracked file, so a phase that creates a new file, runs the documented command and reports it clean is being told the truth about tracked files only. Confirmed directly with a canary: the old spelling misses a new file carrying a task reference, `git grep --untracked` finds it. CI carried the same spelling — safe there, since a checkout has everything tracked, but it is the string every phase copies. Fixed in `5e142f53`; the job was run verbatim on the tree and passes, and the canary proves the flag is not cosmetic. | [task 19](tasks/0019-command-palette-goto.md), [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.18 | **Two focus models coexist in the trace gridviews.** Event rows are `tabIndex={0}` by an explicit earlier decision with a test behind it, so a click focuses the row rather than the container — beside the container-plus-`aria-activedescendant` model everything else uses. Also: no ARIA `role` on any trace gridview container or row, which leaves `aria-activedescendant` inert to assistive tech there. Both are whole-container concerns, outside task 19's event-rows-only ARIA scope. | [task 19](tasks/0019-command-palette-goto.md) |
| 3.19 | **`useConnectionStates` still hand-rolls the host mirror, and its launch race stays open.** It is the pattern `useBusHealth` copied; `useBusHealth` was migrated in `02f9b877` but this one cannot move as-is — `useHostMirror` treats the event as a nudge to re-read, while `useConnectionStates` *consumes the payload*, pinned by name in `ProjectPanel.connectionState.dom.test.tsx` ("follows the host's change event without a refetch"). Overseer read: the two concerns are separable moments — consuming the payload per event and doing one refetch when the listener attaches are not the same thing — so a `fromPayload` option on the shared hook would close the race and keep that expectation intact, rather than accepting a per-event refetch and re-pinning the test. Small, but it touches a shipped connection path. **Recommended for the post-107 cleanup task.** | [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.20 | **The Import chip no longer relabels to "Loading trace…".** It keeps its label and reports busy on the pulsing hairline, the disabled state and the tooltip — the prototype's own treatment, and consistent with the nothing-resizes rule. A deliberate change to a shipped user-visible string. | [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.21 | **The top toolbar wraps rather than overflowing.** The prototype gives the header `flex-wrap: wrap` and reserves the `…` overflow for the plot bar, and the Add-menu collapse leaves only twelve chips — so the shared `useToolbarFit` hook shipped with `StatusBar` as its only consumer. If the header should overflow instead, the prototype does not currently say so. | [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.22 | **The measurement strip is suppressed by a switch, and one test went with it.** "Stays hidden" now means hidden for saved configs too — `MEASUREMENT_STRIP_DRAWS = false` gates the render while the stored `measEnabled` is deliberately left intact, so the rework inherits real preferences. Two consequences the rework must pick up: `MeasurementMenu` is a deliberate orphan (deleting the thing to be reworked is not a saving), and the panel-tier test that read the strip's rendered cells to guard a **derived-axis id mismatch** was removed rather than kept asserting nothing. Overseer check: the derivation itself is still covered at unit tier by `plotAxisDerivation.test.ts`, so the exposure while hidden is nil — but the strip-to-derivation seam is unguarded and the rework must write that test again, failing first. | [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.23 | **Plot perf-readout visibility is view-local while its menu sibling `showDiag` persists.** One line of `plotPanelConfig` either way; flagged because the two sit next to each other on one menu and behave differently. | [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.24 | **Two bars hand-write the chip element instead of using `ChipButton`.** RBS Signals and View Signals need the tall status *swatch* they share with each row's status cell, not the component's round dot, so they render `<button className="status-chip chip-button">` directly. The styling is genuinely shared — they carry the same classes and the phase deleted the bespoke CSS they used to have — so this is not a visual fork, but two call sites now bypass the component and will not inherit changes to it. Cheap fix: give `ChipButton` an indicator form (swatch alongside dot) and move both onto it. Flagged by the phase rather than decided silently. | [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.25 | **Servers' "Add Server" uses `pressed` for a disclosure** that is neither a toggle nor a menu, so it announces a pressed state for something that is not one. One-line accessibility nit; needs the right ARIA (`aria-expanded`) rather than the toggle prop. | [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.26 | **Ten bars were swept; two were mutation-proved.** The phase pinned handlers per bar and proved the pinning discriminates on the trace panel (Pause→Stop) and system messages (Clear→copyAll), reasoning in its log that the rest did not need it. That is within what was asked, and the net test delta (+5 across ten bars, with large edits to existing per-bar tests) is consistent with a restyle rather than a rewrite — but **control-preservation across the other eight bars rests on the pre-existing tests being behavioural rather than markup-shaped.** Worth a look during the chrome review, since a quietly mis-wired control is the failure mode of a breadth phase. | [task 108](tasks/0108-gui-chip-redesign.md) |
| ~~3.6~~ | **Ruled 2026-08-25** — **closed.** The lanes axis has no y-gutter to compare, so there was nothing to show; the owner did not mean the lane tiles. Task 97's grooming asked that the owner see both axes before the **lanes** axis changed. No comparison was produced, because the lanes axis has no y-gutter labelling to compare — it already draws nothing there, and its labels are the tiles. If the owner meant the lane *tiles*, that is a different request, and it cuts against the stated reason for removing the axis labels. | [task 97](tasks/0097-enum-labels-on-axis.md) |
| 3.27 | **A CI guard test's own coverage check dropped a helper rather than a scenario.** `81d5343e` (task 108 phase 3) collapsed the toolbar to commands-only, which broke three `window.__shot.toolbar(...)` scenario steps in `cannet-perf-measurement`'s screenshot harness — fixed by switching them to the equivalent `command(...)` calls. With none left, the guard test's own `assert!(!labels.is_empty())` for the `toolbar` helper became unsatisfiable, so that coverage-loop entry was removed rather than the scenario weakened. Follows directly from the chip-toolbar's own "commands only" design, but it is a test-scope call, not a pure bugfix — flagged for a sanity check. | [task 110](tasks/0110-chain-ci-repair.md) |
| 3.28 | **Every MDF file cannet has written names its events the wrong `ev_type`.** `mdf4-rs` numbers `Marker` 2; ASAM MDF 4.x puts `EV_T_MARKER` at 6 and reads 2 as `EV_T_ACQUISITION_INTERRUPT` (confirmed against asammdf). Fixed at the write boundary; existing files stay mislabelled to conformant readers and nothing rewrites them. The crate's `from_u8` also rejects types 3–6, so a foreign file using them parses as a marker — worth an upstream issue. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.29 | **`ev_scope` is not written, because a cannet MDF has nothing for a subject to point at.** The grooming expected subjects to scope to a `##CN`/`##CG`; the writer emits three bus-logging groups by frame *structure* and no DBC-decoded signal channels, so a message subject has no referent and scoping one to `CAN_DataFrame` would be false. Becomes writable if per-message channel groups are ever written. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.30 | **A later schema version's unknown block keys survive a parse but not a model round-trip.** The groomed rule says they are preserved on rewrite; the parser does preserve them, but `Note` has no field to hold one, so opening and saving a file written by a future build drops what this build does not understand. Closing it means a passthrough field on the durable schema. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.31 | **[Same root as task 112](tasks/0112-signal-reference-registry.md) — a typed reference that carries the data source as well as the definition covers both provenances.** **A file-backed series cannot be an event's subject.** Its `messageId` is a signal channel group index rather than an arbitration id, so `EventSubject`'s structural form (ADR 0056) has nothing true to say about it — Shift+click over a selection of nothing but file-backed rows names nothing and falls through. Closing it means a fourth referent kind, which is a model change. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.32 | **The plot's Shift+click gesture is undiscoverable.** Nothing on the plot says it exists; the README does. The prototype showed a hint line in the plot bar that the shipped chip toolbar has no room for, and the chip language has no hint-text element. Recorded rather than invented. | [task 107](tasks/0107-events-point-at-signals.md) |
| ~~3.33~~ | **Shipped 2026-08-26.** Wrapper deleted; its ten test call sites moved to the free `linked_event_ids`, so the coverage is unchanged. **Ruled 2026-08-25 — delete the wrapper: *"agree, delete."*** **`NotesStore::linked_events` has now gone two phases without a caller.** Phase 3 nominated phase 4; authoring writes rather than reads, and phase 5's highlight work reads links in the frontend through the TS twin, so it will not be the caller either. Probably resolved by deleting the wrapper — the free `linked_event_ids` it delegates to has a production caller and states the same contract. | shipped |
| 3.34 | **The perf-capture recipe in `README.md` had been wrong since the render tier shipped**, omitting `--rbs-run-on-start` and claiming the RBS Run flag was "already in the saved project". Two phases followed it and measured an idle bus that *passed* every gate. Fixed in task 107 phase 4 and verified against three live captures. Worth knowing that any frontend perf number taken before this fix may have been measured on no load. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.35 | **The ADR-0031 memory metrics are not isolated from other processes, and fail silently in both directions.** `descendant_pids` (`crash.rs`) walks recorded parent-pid links, and Windows never clears a process's `ParentProcessId` when its parent exits — so an unrelated orphan joins our tree the moment one of our processes reuses its dead parent's pid. Observed: a run's sidecar took pid 64880, which the operator's separately-running cannet still names as its parent, and its whole 4 GB application was measured as ours (`tree_mb_peak` 5132.6 vs a 1547.4 limit). Worse, when another cannet owns the shared WebView2 browser process **our own renderer is not our descendant**, so `webview_mb` / `renderer_mb_peak` read exactly 0.0 and `tree_mb_peak` reads ~122 MB — and *passes*. Confirmed by a ground-truth `Win32_Process` walk alongside a capture. Same class as the idle-bus silent disarm, in a metric family nobody checks for plausibility. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.36 | **Task 107 phase 5's memory behaviour is unmeasured, and the phase could not fix that.** Every capture this session was taken with the operator's own cannet running, which is what 3.35 makes unreadable; killing it was not an option under the shared-hardware rule. The timing metrics are sound (verified load, every gated metric under baseline). A clean memory reading needs one capture set taken with the machine to itself. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.37 | **A wire-level transmit rejection reaches the app and is thrown away.** `cannet-client::is_per_frame_error_code` classifies `TX_REJECTED` as non-fatal and logs it with `tracing::warn!`, which goes to dev stderr only — not the System Messages panel, not bus health, not the connection chip. So a tx-confirm trace row is a **local echo, never a wire confirmation**, and the trace can show a frame as sent that the far end refused: a listen-only bus, an FD frame on a classic bus, a saturated queue. Task 109 phase 2's route gate closes the unplugged-adapter case; this general one is a behavioural choice (where a rejection surfaces, and at what cadence — at RBS rate it is a flood and needs coalescing) so it was recorded rather than chosen. | [task 109](tasks/0109-usage-feedback-chip-era.md) |
| 3.39 | **Error frames are trace rows, one each, and that is most likely the owner's third symptom.** During the bench fault the adapter emitted 115,136 error frames in 22 s (~5,200/s), and nothing filters them out of the ingest path: `session.rs`'s only error branch *adds* the health-coalescer fold and the `trace_store.append` below it is unconditional, `trace_store/flush.rs` persists the kind like any other, and `trace_query.rs` spells it for the paged view. So the pack bus trace kept growing at ~5,200 rows/s during the fault. Phase 2 attributed "the trace continued getting updates" to tx-confirm rows and closed that case; this is a second, larger contributor it did not see. **Not fixed:** `bus_health.rs` records the opposite decision in its module doc ("The frames themselves are stored like any other frame ... so a saved capture is not a lossy restatement of what was received"), so suppressing or coalescing them changes what a save contains. Drop them, coalesce them into one row, or keep them and filter at the view - a behavioural choice, and a separate phase. | [task 109](tasks/0109-usage-feedback-chip-era.md) |
| 3.38 | **The bus-health readout was structurally inert on the only hardware there is.** python-can's `PcanBus.state` getter returns `self._state`, written only by the setter `__init__` calls — a stored echo of the configured value, never a device read — so bus-off and error-passive could not surface on PEAK no matter what the controller did. Task 109 phase 2 switches a PCAN bus onto the live `status()` read (`CAN_GetStatus`), matched against exact vendor status codes. That makes task 101's controller state work for the first time on this rig, and it is a behaviour change on a live data path that **has never met hardware** — worth knowing before the confirmation run. **Superseded in part by phase 2c:** the bench run showed `CAN_GetStatus` itself under-reports (it stops at `BUSWARNING` on a transmitter driving an open circuit), so the state is now derived from the error frames' TEC/REC and the status word only floors it. The exact match survives for the no-hardware code family alone. **Owner hardware verification 2026-08-23: the PCAN fix is confirmed working.** Unplugging the CAN link now surfaces the fault. Two follow-ups came out of that session and are filed as 3.42 and 3.43. | [task 109](tasks/0109-usage-feedback-chip-era.md) |
| 3.40 | **The Vector controller-state path has never met Vector hardware, and cannot here.** Task 109 phase 2d subclasses `VectorBus` to read the chip-state events its XL driver reports (`busStatus`, `txErrorCounter`, `rxErrorCounter`) and feeds them to the same derivation PEAK uses, polling with `xlCanRequestChipState` on the existing 500 ms cadence. The vxlapi64 DLL is absent in an agent's environment, so the backend cannot even load - the tests exercise the seam against faked chip-state events built from python-can 4.6.1's own struct definitions. Implemented and untested, not working. The re-test script is in the task file's blockers section, and it asks for a classic **and** an FD run, since the two event queues are different structs read through different hooks. It also asks whether Vector floods the trace with error frames the way PEAK does (3.39). | [task 109](tasks/0109-usage-feedback-chip-era.md) |
| 3.41 | **[Task 112](tasks/0112-signal-reference-registry.md) names paging this panel as an exit criterion — it is unpaged because it is fed by pushes rather than backed by a model.** **The view-signals panel is unvirtualized, and pattern rows move its bound.** Its row list renders one DOM subtree per row, on the recorded grounds that "the row count is bounded (the signals the open views reference)". Task 109 phase 6 keeps that literally true but widens it: a view selecting by pattern now contributes every signal its pattern matches. On the shipped `examples/ev-zonal` databases (2,203 signals) a signals view with the pattern `Cell` would put **1,074** rows in the panel. Measured in jsdom, mount-to-first-row scales roughly linearly - 100 rows 224 ms, 500 rows 482 ms, 2,000 rows 1,679 ms - which is a shape, not a browser figure; no real-browser number was taken (perf capture skipped by ruling 2.5). Recorded rather than fixed: virtualizing this panel is its own piece of work. | [task 109](tasks/0109-usage-feedback-chip-era.md) |
| 3.42 | **"Error-active" does not read as healthy.** Owner feedback 2026-08-23, after verifying the bus-health fix on hardware. `Error-active` is the correct ISO 11898-1 name for a node in normal operation — errors are *active* meaning the node still asserts dominant error flags — but to a reader it looks like a fault is in progress, which is the opposite of what it means. The other three states (`Error-warning`, `Error-passive`, `Bus-off`) read correctly as degrees of trouble, so the healthy state is the only one whose label misleads. Wants a label the panel can show without teaching the standard first; whether the ISO name survives as a tooltip is part of the decision. | owner feedback |
| 3.43 | **Transmit frames still present as though they reached a wire.** Owner feedback 2026-08-23, on the same session. A tx-confirm row is appended by `build_and_confirm` before any wire attempt and unconditionally, so a frame the bus never carried is indistinguishable in the trace from one it did. Task 109 phase 2 fixed the special case where the *interface* is unreachable, by parking the route; this is the general case, where the interface is fine and the frame still went nowhere — an open CAN link, a listen-only bus, FD on a classic bus. Overlaps 3.37 (the wire-level `TX_REJECTED` is received and discarded) and 3.39 (error frames arrive as trace rows at ~5,200/s during a fault); the three are most likely one piece of work. | owner feedback |
| 3.44 | **Nothing in this chain has been seen running.** Across every task from 86 onward, not one claim rests on looking at the app: the standing rule against UI automation on the owner's machine means no phase launched the GUI, and jsdom does no layout, so no frontend test proves that anything fits, lines up, or is legible. The phases that say so explicitly are 86 (three phases, "the owner-visible confirmation is opening `examples/time-origins/` by hand"), 27 (two disk-change notices asserted only through the DOM), 108 (ten restyled toolbars, `### What is not verified` twice: "jsdom does no layout"), 107 phase 5 (the extent wash and the series fade — `EXTENT_WASH_ALPHA` 0.16, `UNLIT_ALPHA` 0.28 — asserted as values, never as an appearance), 109 phase 5 (the focus ring was never photographed) and 109 phase 6 (the view-signals panel was never opened with a real project). The ADR-0031 capture cannot substitute: its script never hovers an event row and `ev-zonal` carries no events. **The installer is the first look anyone gets at most of this chain**, and several items above (1.29, 1.24, 1.25) are asking the owner to confirm exactly what only a look can answer. | the chain |
| 3.45 | **Not every task's exit criteria were walked, though § 4 says they were.** § 4's preamble and the roadmap both state that each implemented task "met its documented exit criteria, walked criterion by criterion against a named test or artefact". Five do not match that: **89** (six phases, no per-criterion verdict anywhere in the file), **90** (three of four criteria unverdicted, the fourth struck as retired into task 91), **93** (no verdict, only the sweep's counts), **105** (three phases landed, the criteria addressed in prose but never mapped) and **110** (no exit criteria at all — its verification is a table of CI jobs run by hand). Three more are walked but not clean: **27** criterion 4 is *partially met* (the functions stitching both watches together are covered by inspection, because Tauri's mock runtime will not load on Windows), **102** has one criterion *partly met* and one *not met*, and **106**'s criteria are met *on a ruling the owner has not confirmed* (1.19). 107's two unmet criteria are already declared in its own status. Not a defect in any task — a claim in the index that is wider than the evidence. | the chain |
| 3.46 | **Two perf metrics can fail the close-out gate with no code change, and a ruling is owed before it is run.** `lag_ms_max` spanned 2.8–37.6 ms against a 41 ms limit across eight captures of one *unchanged* binary, with `lag_ms` mean ~0 in every one — it is a single-sample scheduler tail. `rx_gap_short_frac_worst` behaves the same way: task 88 phase 2's pre-inversion control read 0.194 against a 0.166 limit on a GUI byte-identical to phase 1's, and task 89 phase 4 took twelve captures of which run 3 breached both it (0.2362) and `rx_gap_p95_ratio_worst` (3.307 vs 2.898). That phase explicitly declined to rule: *"It is **not** discarded and it is **not** ruled harmless by me."* ADR 0031's limits ratchet down only, so widening one needs an owner ruling recorded there — and § 5's close-out gate run will hit this. **Make the ruling on the evidence rather than mid-gate.** | [task 88](tasks/0088-bus-assignment-governs-decode.md), [task 89](tasks/0089-signal-mapping-panel.md) |
| 3.47 | **[Task 112](tasks/0112-signal-reference-registry.md) asks this question from the other end; (a) in particular is answered by a registry the host can count.** **Three surfaces compute in the frontend what `CLAUDE.md` says the model owns, each for a stated reason.** (a) `useViewSignalsAttentionCount` calls `list_view_signals` and keeps only its `attentionCount`, discarding every row, on mount and on each change event — judged cheap when the row count was bounded by open views, which 3.41 has since widened to over a thousand rows for one pattern-selecting view. (b) The RBS chip's badge (`rbsAttention.ts`) re-runs the frontend's own `rbsSignalsFilter` over the host's rows, because *Out of Range* is a frontend decision, so a host-side count would legitimately be a different number from the panel's. (c) The RBS signals grid sorts client-side (`rbsSignalsColumns.ts::sortRbsSignalRows`) although task 89's own grooming resolved that a paged view passes `sortKey`/`sortDir` to the host — same cause as (b). Each trade is defensible in isolation; together they are one question. **Ratify the exception, or move the display-status rule host-side so one answer serves all three.** | [task 89](tasks/0089-signal-mapping-panel.md), [task 103](tasks/0103-toolbar-status-chips.md) |
| ~~3.48~~ | **Ruled 2026-08-25** — **declined; the hand-run gates are already blessed in the subagent skill.** The hook is left as it is, and `--no-verify` with the gates run by hand is the workflow, not a workaround. **`pre-commit` overwrites any file edited while a commit is running, and `--no-verify` has become the de facto workflow.** Every hooked commit stashes the unstaged working tree to `~/.cache/pre-commit/patch<n>`, runs the workspace clippy and test gates (a couple of minutes), then restores the pre-edit copy — so an edit made *during* the run is silently reverted. That is the diagnosed mechanism behind planning-doc edits disappearing while an implementation agent commits alongside a live grooming session; no agent ran `git checkout`, `restore` or `stash`. The workaround every phase from task 88 onward adopted is `--no-verify` with the gates run by hand, which means the hooks have been effectively disabled across most of this chain. Stashed copies survive in `~/.cache/pre-commit/patch*` if anything needs recovering. **Fix the hook, or bless the hand-run gates as the workflow.** | [task 88](tasks/0088-bus-assignment-governs-decode.md) |
| 3.49 | **No Vector tool has been watched reading a cannet BLF that carries a descending object timestamp, and this chain makes them more likely.** Task 87 established that BLF permits non-monotonic object timestamps *by silence* — there is no published spec, and Technica's `vector_blf`, Wireshark and python-can all read descents without complaint, python-can's writer emitting them. But CANoe/CANalyzer were unavailable, and Vector's `BLSeekTime` API ("seek forward to the first object with a certain time stamp") implicitly assumes ascent. Task 87's fix means a dip *below* the first appended frame is now preserved rather than flattened, so a cannet-written BLF is measurably more likely to carry a descent than any previous release's. The stated residual is "a time-seeking Vector consumer landing somewhere surprising, not an unreadable file". **Accept the exposure, or fund a `vector-blf-oracle` / a CANoe check before these files leave the tool.** | [task 87](tasks/0087-blf-writer-timestamp-fidelity.md) |
| 3.50 | **A calculated-fields section counts as edited from the first keystroke, not from a changed value.** The editor decides whether to write an override on Apply by asking whether the section has been touched since the modal opened. Type into a section showing a DBC `Default`, type the original value straight back, and it is now an `Override` — the project's `.cannet_rbs` gains an override that is a byte-for-byte restatement of what the DBC already says, and that field will no longer follow the DBC if the designation later changes. The phase declined the fix because a structural comparison needs a second definition of "these two specs are the same" (the numeric fields live as strings in the controls and as numbers or `0x…` strings on the wire). Newly reachable because task 100 is what turns those checkboxes into live controls over DBC-declared fields. **Accept, or ask for the value comparison.** | [task 100](tasks/0100-calc-fields-dbc-config.md) |
| 3.51 | **Editing an event's tag or description leaves the keyboard dead until the user clicks.** Task 19 step 2 fixed exactly this bug one level up — ending an event *rename* (the F2 field) now hands focus back to the grid. `EventBody`'s tag and description editors keep their own local `editing` state and were not fixed: Enter or Escape unmounts the input while it is still `document.activeElement`, so the gridview layer's recovery — which checks for `body` during the keypress — never fires, and the arrow keys do nothing until the user clicks somewhere. Reachable today by anyone who edits an event's tag or description. Left because nothing in that step opened those editors from the keyboard. **A live defect, not a design question — it wants a fix with the regression test the sibling bug got.** | [task 19](tasks/0019-command-palette-goto.md) |
| 3.52 | **Adapter identity in the bus-health panel is a display name and nothing else, permanently, unless the protocol grows.** The wire's `Interface` message carries exactly three fields — `id`, `display_name`, `fd_capable` — so driver name and version, firmware version, serial and channel count are not obtainable without new protocol fields *and* a server-side producer for them. Worth knowing: the accepted prototype was showing **fabricated** driver and firmware strings until this was checked during implementation, so the panel as approved promised more than the panel as shipped can deliver. **Accept the reduced adapter cell, or open the protocol work.** (1.17 covers only the *virtual* bus's blank cell, which is a different thing.) | [task 101](tasks/0101-bus-health.md) |
| 3.53 | **Nothing counts frames the ingest path dropped, so the user cannot tell whether the trace in front of them is complete.** The status-bar inventory considered "dropped / overrun frames" and deliberately did not adopt it, because no such counter exists anywhere in cannet — adding one is new work on the ingest path, not a new label. It is, though, the one number that answers whether what is on screen is the whole of what the bus sent or a lossy subset, and every other number in the bar (rates, bus load, error rate) is read as if it were complete. Recorded at the time as "worth a decision rather than silent omission"; no decision has been made. **Open the counter, or accept that completeness is unreportable.** | [task 103](tasks/0103-toolbar-status-chips.md) |
| 3.54 | **The macOS event colour-picker fix has never run on a Mac.** The native colour picker for a timeline event opens in the wrong place on macOS while the plot's series picker opens correctly, so the two anchoring paths differ. A candidate fix shipped — `.trace-event-swatch-input` now fills the swatch's real footprint (`inset: 0`) instead of collapsing to a zero-size point, giving the OS picker a concrete anchor rect — but no Mac has ever run it, and the task's own exit criteria record this one as **not met**. **Schedule a Mac session: if it is fixed, close it; if not, revert the CSS and investigate the virtualized-row scroll-offset anchor path instead.** | [task 102](tasks/0102-event-surface.md) |
| ~~3.55~~ | **Ruled 2026-08-25** — **strike the clause.** ADR 0035 decision point 3 describes a view with no time axis; what shipped (the plot and both trace modes) is right. Task 102's exit criterion goes from *partly met* to met. **ADR 0035 decision point 3 says `EVENT_COMMENT` markers render in "the graph view", and there is no such view.** cannet's only graph view is `ProjectGraphPanel`, a topology of gateways, buses and filters with no time axis, so a timeline event has no coordinate to land on there. What shipped instead is message-bound comments rendering in the **plot** and in both trace modes. The clause sits in the ADR and in task 102's exit criteria, which is why one of them reads *partly met*; the phase recorded rather than struck it, because deleting a decision point is the owner's call. **Strike the clause, or restate it against a view that has a time axis.** | [task 102](tasks/0102-event-surface.md) |
| 3.56 | **An MDF round-trip silently drops a message-bound comment's `commented_event_type`.** BLF's `EVENT_COMMENT` (object type 92) records which object type the comment is attached to, so the annotation tracks with its message; MDF's `##EV` block has no analogue. A message-bound event written to MDF and reimported comes back **freestanding** — it has come loose from the message it annotated. Documented at `note_from_event` and declared acceptable on the grounds that BLF is the interchange home for annotations, but it is a lossy write of the kind this repo says it does not accept. **Ratify the exemption, or ask for a carrier** (the `cannet-event/1` text block task 107 added to the same files is the obvious one). | [task 102](tasks/0102-event-surface.md) |
| ~~3.57~~ | **Ruled 2026-08-25** — **closed.** Import-only is sufficient now that task 107's *Create event from &lt;message&gt;* gesture exists. **A message-bound annotation cannot be authored in cannet, only imported.** Task 102's scope named a "Create marker from message" gesture — pick a source message, write comment text, emit an `EVENT_COMMENT` whose object timestamp is the source message's — and deferred it by its own terms ("UI design needed"). It was not built and nothing since has built it, so `messageBound` events arrive only from imported captures. Task 107 phase 4 added *its* own message gesture (right-click a frame row → **Create event from &lt;message&gt;**), which creates a subject-carrying event rather than a BLF-style bound comment, so the two are adjacent but not the same thing. **Scope the authoring UI as its own task, or rule the import-only shape sufficient now that 107's gesture exists.** | [task 102](tasks/0102-event-surface.md) |
| 3.58 | **`<dest>.part` discovery is owed a task, and the precondition its grooming set has been met.** Grooming ruled the feature out of scope with a trigger attached: it "becomes its own task once this one establishes such a file is readable at all". Phase 1 established exactly that — a hard-killed `BlfCaptureWriter` leaves a `<dest>.part` with a stub header and 107,770 bytes of complete containers — and phase 2 made cannet able to read it (16,387 recoverable frames in the measured fixture). So a user whose session was killed has a recoverable capture sitting on disk and nothing in the UI offers it back; the crash-recovery surface that would has never been scoped. **Open the task, or rule the leftovers permanently invisible.** | [task 105](tasks/0105-unfinalized-blf-recovery.md) |
| 3.59 | **An event coloured pure black loses its colour through BLF.** A `GLOBAL_MARKER` packs a colour as a 24-bit integer, so the value `0` means both "black" and "no colour set" — an event the user deliberately coloured `#000000` reads back from a BLF as uncoloured. Pre-existing rather than introduced; task 107 phase 2 pinned it with a test and recorded it in ADR 0057's loss table instead of fixing it, since fixing needs a sentinel or an extra field. Now cheap to close, because 107 added a `cannet-event/1` text block to the same marker that could carry the colour explicitly. **Accept black-as-uncoloured as a permanent BLF limitation, or carry the colour in the text block.** | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.60 | **Two things task 108's approved prototype says that the app does not.** (a) **The icon count.** The task description and its grooming both state the registry is 42 icons; the prototype's own "icon set — full inventory" section — the explicitly designated source of truth — names 36, and the sprite defines 37 `<symbol>`s (the 36 plus `i-reload`, whose only command phase 4 retires). Phase 1 built the 36 and flagged the discrepancy rather than reconciling it; adding more later is additive. (b) **A control that has never existed.** The prototype's signals-view mock drew a chipfield that adds signals by typing a live pattern, in the plot solo box's dialect. The app has never had it; what exists is a toggle chip opening an in-panel editor with manual picks and patterns, and phase 5 restyled that and *corrected the mock to match the app*. **Confirm 36 is the intended set, and confirm the mock correction — or say the live-add field was genuinely wanted, in which case it is unscoped new functionality.** | [task 108](tasks/0108-gui-chip-redesign.md) |
| ~~3.61~~ | **Ruled 2026-08-25** — **closed: only the merged tip matters.** Requiring each sub-`chain-ci-repair` branch to be green would mean rebasing the stack to move one fix below them. If each becomes a PR, each shows red — accepted. **~~CI has never run on any of this chain, and nothing arranges for it to.~~ Superseded 2026-08-23 by observation: it runs, and the results are legible.** Pushing the stack triggered CI per branch. Everything **below** `chain-ci-repair` fails — task 91 through 99, and `task-92-phase-3-shared-resolver` — which is exactly the two lints that branch was created to repair (a clippy `redundant closure` from task 92's `16ffadf6`, and the screenshot guard test from task 108 phase 3's `81d5343e`); the fix sits above them in the stack, so a branch-tip run cannot see it. `chain-ci-repair` itself is **green**, as are task 107 phase 5 (on the amended commit — the pre-amend run failed, which is the `tsc -b` breakage that amend fixed) and task 109 phases 1–3. Phases 2c, 2d, 4, 5, 6 and `chain-docs-closeout` are unpushed and have no runs. **What is actually owed:** a decision on whether the sub-`chain-ci-repair` branches need to be green individually, or whether only the merged tip matters. If each is a PR, each shows red. | overseer 2026-08-23 |
| 3.62 | **`window.__shot.importIdle()` was silently returning true mid-import, so past extrapolation screenshots may show partial captures.** The screenshot harness proved an import had finished by polling for a `.toolbar button` whose text read `"Loading trace…"`; since `81d5343e` (task 108 phase 3) the Import chip keeps its label for its whole lifetime and reports busy through `aria-busy` instead (3.20), so the poll succeeded immediately, `waitFor('the import to finish', …)` resolved at once, and the shutter could fall on a half-loaded capture. Fixed in task 110 (`!document.querySelector('.toolbar button[aria-busy="true"]')`) — but **no guard test covers it**: the helper is JavaScript embedded in a Rust string, exercised only by a real capture run, so the next markup change breaks it just as silently. Same family as the idle-bus disarm (1.10) and the pid-reuse memory defect (3.35). **Decide whether the `__shot` helpers need a guard test that runs without a full capture.** | [task 110](tasks/0110-chain-ci-repair.md) |
| 3.63 | **A frontend test fails intermittently, and the suite is not green.** `PlotPanel.dom.test.tsx` → *"re-renders no plot area when only panel-local state changes"* fails with `expected 1 to be +0` — one extra `PlotArea` render arriving between the baseline read and the click. **Reproduced in two of three full runs on 2026-08-26**, so it is real rather than noise; a fourth run of the file alone did not complete in time to add data. Not caused by the change that found it (that commit touches only CSS comments and Rust). **One hypothesis raised and refuted:** the test's comment says *"a stopped panel, so no self-paced resample can land between the baseline read and the click"*, which looked like it disagreed with its `isPaused: false` — but line 2449 shows "stopped" in this file means a finite `end`, which the test has. No cause established, and none is claimed. **Worth knowing:** `implement-phase` requires a green `frontend` job per phase, so either phases have been reporting a flake as green or it is recent. | overseer 2026-08-26 |
| 3.64 | **The rustdoc gate covers one crate of seven.** Closing 3.5 gated `cargo doc -p cannet-gui --no-deps` at `-D warnings`. The library crates carry **34 warnings of their own** — 24 `private_intra_doc_links`, 8 genuinely unresolved links (including `BlfCaptureWriter::append`), 2 module/macro ambiguities — all pre-existing. The crate-root allow that made cannet-gui clean is an *application-crate* argument (its `pub` items are public only to its own binary) and does not transfer to a library, where a doc link is part of a contract. The 8 unresolved ones are real bugs: a broken link renders as literal text. **Fix the libraries and widen the gate to `--workspace`, or accept one-crate coverage.** | overseer 2026-08-26 |

---

## 4. Finished and awaiting acceptance

All landed on one linear branch chain, none merged. Each met its
documented exit criteria, walked criterion by criterion against a named
test or artefact — **with the exceptions 3.45 lists**: five of these
tasks have no criterion-by-criterion walk at all, and three more are
walked but not clean.

Tasks 102 and 110 were added to this table 2026-08-23; they landed on
the chain like the rest but had reached neither the roadmap nor this
list, so their findings had never been queued.

| Task | What it was |
|---|---|
| 86 | Import time origins, enum overlays, events-panel width |
| 27 | Live disk-watch for project and RBS files |
| 87 | BLF writer timestamp fidelity |
| 89 | Signal mapping panel |
| 90 | Follow-ups from the 86 / 27 / 87 cycle |
| 88 | Bus assignment governs decode — 8 phases, 15 criteria, gate passed |
| 92 | One resolution rule, not eleven copies — 3 phases, 13 `dbc_applies` sites down to 4 |
| 91 | `frame_index_at_ns` binary-searching an unsorted store |
| 93 | Source comments naming task numbers, plus the CI lint |
| 98 | Signals rendering wrong on a common scale |
| 95 | Gridview content click collapsing the message |
| 97 | Enum value labels on the plot's y axis |
| 96 | Long signal and `VAL_` names rendering |
| 94 | Server bind defaults, mDNS honesty, servers panel from the project view |
| 99 | Transmit controls: kill switch out, run state unpersisted, Space unguarded |
| 100 | Counter/CRC declared in a DBC now populates the editor |
| 105 | Reading a BLF whose writer never finalized, read-only |
| 104 | Determinate load progress, and a discoverable cancel |
| 103 | The toolbar's status bar, status chips, and ADR 0055 |
| 101 | Bus health — error frames labelled and coalesced, controller state, bus load |
| 106 | The any-bus series ruled on, and the signal cache's sample-order sweep |
| 19 | Typed-argument palette prompts, `Mod+T`/`Mod+E`, and event-row keyboard actions |
| 102 | The event surface — kinds, per-view visibility, tag and description, the events view grown up |
| 110 | Chain CI repair, and the Windows MSI bundle target dropped |

**Two of these are blocked, by findings recorded in task 109**
(2026-08-22, from the owner's test drive of the chain):

- **101 — bus health.** Its hardware verification (item 3.14 above) was
  run and **failed**. Unplugging the PEAK dongles produced no indication
  of a bus fault; one side's utilization dropped to 0 while the other
  held steady; and the pack bus trace kept producing rows as though it
  were still transmitting. The last of those is the serious one — the
  trace showed traffic that never reached a wire. Task 109 item 2 and
  its phase 2 own the investigation.

  **Phase 2 has reported (2026-08-22).** All three symptoms have a
  confirmed cause and a landed fix; the "steady utilization" hypothesis
  (a stale reading) was *refuted* and replaced — the reading was live
  and was measuring the host's own tx echo, the same cause as the
  phantom trace rows. What acceptance still needs is the hardware run
  itself, which no agent can do: the expected observations, and what to
  look at if they do not appear, are written out under **Blockers /
  side effects** in [task 109](tasks/0109-usage-feedback-chip-era.md).
  Two findings from the investigation are queued above as 3.37 and
  3.38; 3.38 in particular is a behaviour change to a live data path
  that the confirmation run is the first hardware to see.
- **99 — transmit controls.** It shipped on the premise that Space
  already acted on RBS message rows and only needed adding to the
  transmit panel. The premise is false and was never tested: the RBS
  rows' enable control is a plain checkbox, so Space reaches the scroll
  container. Task 109 item 7 and its phase 3 own the fix, with the test
  that would have caught it.

Neither task is reopened; 109 carries both so one task holds all ten of
the owner's observations.

## 5. Housekeeping owed at close-out

- Retire the accepted tasks from [the roadmap](tasks/roadmap.md).
  Completed tasks are removed; the detail stays in git history.
- ~~Delete the untracked `scratch-perf/` and `scratch-perf-p6/`
  directories~~ — done by the owner 2026-08-22.
- Run the render-tier gate once on the final tree (§2.2). §1.7 and
  §1.10 are resolved, so it is four 60 s captures against the
  2026-08-22 baseline with `--rbs-run-on-start`, read as a band —
  **but the interaction script must be re-verified as actually driving
  the app before the numbers mean anything.** Task 108 phase 4 moved
  follow-live onto a chip, and `perfInteract.ts` now finds it by
  `button[aria-label="Follow Live"]` and reads `aria-pressed`. At a
  window narrow enough for that chip to spill into the `…` overflow the
  script cannot reach it at all — it does not open menus. This is the
  second failure mode in the overseer's own gate rules (a harness
  silently disarmed still passes), so the close-out run checks that the
  scrub actually happened, not just that the report is clean. The
  script's two other targets — uPlot's `.u-over` and `.trace-rows` —
  were confirmed untouched by the chrome sweep.

  **Overseer inspection 2026-08-22 — the harness cannot currently tell
  you this, and that is the real defect.** Every gesture function
  returns a label naming what it did, and `startPerfInteraction`
  **discards the return value**: `perfInteractTick(doc, tick, script)`
  is called for its side effect and nothing counts the labels. A
  gesture whose target is missing returns `null` and is skipped
  silently — deliberate, so that a layout with no plot is still a
  legitimate capture — but nothing anywhere records *how often* that
  happened. A run where the script found none of its targets produces a
  report structurally identical to a good one, only quieter.

  So the close-out gate needs a fix before it needs a run: **the
  interaction script should tally the gestures it performed and the
  report should carry that tally**, so a disarmed harness is visible in
  the data instead of having to be remembered. Small, but it is the
  precondition for every number the gate produces. Scoped to the
  post-107 cleanup, ahead of the gate run itself.
- Replace the repo's pre-existing ignored mDNS round-trip test, which
  advertises a real `_cannet._tcp` instance on the LAN. It is the
  pattern agents copy, and real advertisements collide on the shared
  hostname and breed near-duplicate servers in the owner's list. No task
  opened.

- Normalise the two files that have shown as modified with no content
  change for the whole chain: `examples/ev-zonal/dbc/pack.dbc` (the DBC
  generator writes LF, the checkout is CRLF) and
  `apps/gui/src-tauri/Cargo.toml`. Every phase from task 88 onward
  recorded them and left them alone, correctly — but they are standing
  noise in `git status` that makes "is this tree clean?" unanswerable at
  a glance, which is how an unrelated edit gets committed by accident.
  A `.gitattributes` entry or one normalising commit closes it.
