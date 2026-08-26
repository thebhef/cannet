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

**Keep it current.** When the owner decides an item, the ruling is
recorded **at the item's source** — the task file or ADR that created it
— and the item is deleted from here (owner instruction 2026-08-26: *"the
queue is only for things I still have to look at"*). If the file is
growing faster than it drains, that is the signal to stop taking new
work and hold a review.

**Two sections have been reshaped at the owner's instruction**, and
neither reshaping loses a finding — every number still resolves, so the
task files citing `owner-review-queue 1.N` and `3.N` still land.

- **§ 1 drained on 2026-08-24.** The prose was *removed* rather than
  struck out; the acceptances survive as § 2.9 and the rework rulings as
  § 2.10, and § 1 keeps a one-row index per item naming the task that now
  owns it.
- **§ 3 regrouped on 2026-08-26** *"so that I can just work through them
  and make batches of assessments without having to reload context on
  different portions of the codebase/model/concept space multiple
  times."* Findings are grouped by the **surface** they touch rather than
  by the kind of decision they need, and each is one wrapped entry rather
  than a table cell — a markdown table cannot hold a line break, which is
  what made the section unreadable.

Since 2026-08-26, decided items are pushed to their source and
deleted here rather than struck through in place.

---

## 1. Behaviour changes, walked by the owner 2026-08-24

**Nothing in this section is waiting on them any more.** All 33 items got
a response:

- **18 accepted.** The prose is gone at the owner's instruction; every
  ruling is one row of [§ 2.9](#29-the-2026-08-24-queue-walk--eighteen-accepted),
  so a task file citing `owner-review-queue 1.5` still resolves to its
  verdict.
- **15 sent back for rework** — 3 closed and now deleted from the index
  below (1.2 ratified — § 2.10; 1.16 and 1.18 dropped as intractable,
  recorded at [task 101](tasks/0101-bus-health.md)), 2 answered with work
  or acceptance owed, 2 scoped, 6 open, one (1.33) split. **11 of the 15
  still carry work.** The owner began walking them one at a time
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
| 1.3 | Answered · work owed | Did the one resolution rule and its overrides actually land? | **Answered yes 2026-08-24**, with the tests run — but **not closed**: the ruling that settled it (a transmit row carries its own DBC) is unbuilt. [§ 2.10](#210-the-rework-rulings). The residual moved to [**task 112**](tasks/0112-signal-reference-registry.md) on 2026-08-25 — a transmit row is `bus + message id + which database`, the same shape the registry is built on, and it takes finding 3.1 with it |
| 1.6 | Scoped | Editor-face content stays a block rather than becoming rows | [**task 113**](tasks/0113-rbs-as-a-grid.md) § 1 — **the dev asked for was not done**. `gridviewContentRows.ts` is adopted by the two trace views and by neither RBS nor transmit, so this is adoption, not new machinery |
| 1.13 | Open · premise corrected · **split** | The RBS chip navigates to an individual RBS file | **a and b:** [**task 116**](tasks/0116-rbs-problems-across-configurations.md) — build the all-configurations view and its per-file filter. **The steps-to-reproduce leg is dropped**, ruled 2026-08-25: *"I'm not looking at it, I don't even remember what was claimed."* **c:** [**task 113**](tasks/0113-rbs-as-a-grid.md) § 3 — **ruled 2026-08-25**: *"row highlighting is a gridview behavior."* The wash comes out on both signal-mapping surfaces, and the Row Highlights chip and its persisted `washesOn` param with it. The prototype was never the argument — it kept row highlighting and only omitted drawing it |
| 1.17 | Answered | The virtual-bus adapter cell is blank where the mock drew text | [**task 114**](tasks/0114-one-name-per-thing.md) § 3 — **the cell is not blank**; it shows `LOCAL_VBUS_INTERFACE`, a wire id falling through the display-name lookup. **Ruled 2026-08-25**: the generic `virtual bus`, not the vbus's name — *"this is the hardware column. We already have the user's bus name on the same row"* |
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

**45 findings open** (of 64 raised; the decided are recorded at their
source and deleted here). Grouped by the surface you have to be holding
in your head, so each subsection is one sitting. Detail stays in the
task file each line names; this is the index.

Two tags mark what is at stake — everything untagged is a judgment call
where nothing is lost either way:

- **`[wrong]`** — a user gets a silently wrong answer today.
- **`[unverified]`** — it shipped, and nobody can say whether it works.

**Eight findings are already routed** to [task
112](tasks/0112-signal-reference-registry.md) or [task
121](tasks/0121-the-trace-tells-the-truth-about-the-wire.md) and need
nothing from you; they are marked *routed* and left in place so their
numbers still resolve.

| Section | Open | The batch decision |
|---|---|---|
| [3A File formats and round-trip](#3a-file-formats-and-round-trip) | 4 | **walked 2026-08-26** — 4 ruled into [task 122](tasks/0122-a-file-keeps-what-you-wrote.md); 4 recommendations await round two |
| [3B Bus health and the CAN link](#3b-bus-health-and-the-can-link) | 9 | what needs your dongles |
| [3C GUI chrome against the prototype](#3c-gui-chrome-against-the-prototype) | 9 | yes or no, per deviation |
| [3D Signal resolution and calculated fields](#3d-signal-resolution-and-calculated-fields) | 7 | whether ADR 0027's model changes |
| [3E The record](#3e-the-record-tests-gates-and-what-was-walked) | 7 | what acceptance requires before this chain merges |
| [3F The perf harness](#3f-the-perf-harness) | 5 | fix it, then rule on two unstable metrics |
| [3G Frontend shared layer](#3g-frontend-shared-layer) | 4 | one cleanup task, or leave it |

**3E and 3F gate the close-out.** The rest can be taken in any order.

---

### 3A. File formats and round-trip

**Walked 2026-08-26; second round rulings taken the same day.** Six are
closed and recorded at their sources — 3.28, 3.56 (task 107's and task
102's blockers) and the four fixes now scoped as
[task 122](tasks/0122-a-file-keeps-what-you-wrote.md) (3.9, 3.15, 3.30,
3.59, plus the every-carrier `commented_event_type` ruling).

**Still open below — four answers awaiting your round two:** 3.10, 3.29,
3.49, 3.58. Each carries a recommendation.

#### The four words, before the findings that use them

Four adjacent things get called nearly the same thing. 3.56 and 3.59 are
both about which of them carries what, so:

| Word | What it is | Fields that matter here |
|---|---|---|
| **Note** | **cannet's model type** (`notes::Note`) — the only one that is ours. Every format below is a way of writing one down. | `id`, `label`, `kind`, `color`, `description`, `tag`, `commented_event_type`, `subjects` |
| **`GLOBAL_MARKER`** | BLF object type **96**. What a *freestanding* note is written as. | `marker_name`, `description`, **`foreground_color`**, **`background_color`**, `commented_event_type` |
| **`EVENT_COMMENT`** | BLF object type **92**. What a *message-bound* note is written as — a comment attached to another record. | one text field, `commented_event_type`. **No name, no colour.** |
| **`##EV`** | MDF's event block. What either kind of note is written as in MDF. | `ev_tx_name`, an `##MD` comment holding `<TX>` free text and `common_properties`. **No colour, no attached-record field.** |

`Note.kind` decides which BLF record gets written: `Note` → `GLOBAL_MARKER`,
`MessageBound` → `EVENT_COMMENT`. MDF has one block for both.

**`commented_event_type`** is the BLF object type of the record a comment
is attached to — `86` is `CAN_MESSAGE2`, a classic CAN frame. `0` means
freestanding. It is a native field on **both** BLF records and has no
native analogue in MDF, which is what 3.56 was about.

**`cannet-event/1`** is the text block (ADR 0057) that carries what no
format has a field for. It rides `GLOBAL_MARKER.description`,
`EVENT_COMMENT`'s text field, and `##EV`'s `<TX>` — one grammar, three
carriers.

#### Answered — your questions

- **3.10** `[wrong]` You asked: *"what do you want from me?"* — a yes or no
  on whether this is worth a writer change, and it is worth it only if you
  can reach it.

  **Today you can reach it only by hand.** The MDF writer emits its group
  description at `finish()`, so a killed run leaves a `.part` whose records
  have nothing describing their shape; the ID block still reads `MDF`
  rather than `UnFinMF`, so `is_unfinalized()` says false and the file
  opens to zero frames with no error. Nothing in the UI offers `.part`
  files (that is 3.58), so you would have to type the name into the open
  dialog.

  **Recommendation: strike it, conditional on 3.58 staying closed.** A
  silent empty capture is a bad failure, but it sits behind a door nothing
  opens. If you ever ask for `.part` discovery, this becomes a blocker for
  that work rather than a finding of its own — and the two want fixing
  together, since discovery without the `UnFinMF` marker would offer the
  user a file that opens empty.
  · [105](tasks/0105-unfinalized-blf-recovery.md)

- **3.49** `[unverified]` You asked: *"what's the risk? is this not a
  supported usage of blf format? if we're doing something really dumb with
  predictable adverse outcomes we should fix it."*

  **We are not doing anything dumb, and it is supported by silence rather
  than by permission.** `docs/blf-feature-support.md` § *Object timestamps
  and ordering* has the full analysis; the short of it:

  - There is **no published BLF specification.** Vector's one public API
    document, the *BINLOG DLL Manual* v1.5, states no ordering requirement
    and does not even document the timestamp field.
  - The format's **only** timestamp constraint is that no event precede
    `measurement_start_time`, because the per-event offset is unsigned.
    cannet's writer satisfies that by construction — it takes a first pass
    for the minimum and declares it up front (`capture.rs:983`).
  - **Every reader examined** — Technica's `vector_blf` (which never reads
    the timestamp at all), python-can 4.6.1, Wireshark — walks objects in
    file order with no sort, no check, no warning. python-can's own
    `BLFWriter` *emits* descents.
  - The descents are **honest**: a multi-bus capture's arrival order is not
    its timestamp order (ADR 0024) — a real 23-hour two-bus PCAN capture
    dips ~1.1 s below its running maximum several times a minute. Writing
    them ascending would mean sorting the whole capture in memory before
    the first byte.

  **The residual is one API**: Vector's `BLSeekTime` — *"seek forward to
  the first object with a certain time stamp"* — implicitly assumes ascent.
  Worst case is a time-seeking CANoe user landing somewhere surprising, not
  an unreadable file. **Recommend accepting it**; the alternative is buying
  a CANoe check for an outcome three independent readers say is fine.
  · [87](tasks/0087-blf-writer-timestamp-fidelity.md)

- **3.29** You said: *"will need this clarified."*

  `ev_scope` is MDF's **native** link from an event to the channel or
  channel-group it is about — the format's own way of saying "this marker
  concerns *that* signal". It is not how cannet stores subjects: those ride
  the `cannet-event/1` block and round-trip exactly. `ev_scope` would be a
  second, native copy, for a foreign tool reading our file without knowing
  our block.

  **We cannot write one, and the reason is about our own file.** A scope
  link must point at a `##CN`/`##CG` *in this file*, and a cannet MDF has
  neither thing a subject would name: its groups are one per frame
  **structure** (`CAN_DataFrame` / `CAN_ErrorFrame` / `CAN_RemoteFrame`),
  not one per message, and it deliberately writes no decoded signal
  channels. Pointing a message subject at `CAN_DataFrame` would assert
  *"this event is about every data frame"*, which is false.

  **So nothing is lost today** — a cannet→cannet round-trip is exact, and
  the only cost is that CANoe or asammdf opening our file sees the subject
  as text rather than as a native link. It becomes writable if per-message
  channel groups are ever written. **Recommend striking it as a documented
  consequence** (it is already in ADR 0057's field table) rather than
  carrying it as an open finding.
  · [107](tasks/0107-events-point-at-signals.md)

- **3.58** You said: *"I don't remember if I provided an example or said I
  had one. I'm OK to leave this untested beyond where it's at."*

  **Reading it as: do not open the task.** BLF `.part` recovery is built
  and tested — phase 2 read 16,387 frames out of a hard-killed writer's
  leftovers — and what is *not* built is the UI that would notice such a
  file on startup and offer it back. Leaving it there means a user whose
  session died has a recoverable capture on disk and no way to reach it
  except by renaming the file by hand.

  **Confirm and I will strike it** (and 3.10 with it, which sits behind the
  same door). If you meant only the fixture question, say so — no example
  was needed; the tests generate their own by killing a writer.
  · [105](tasks/0105-unfinalized-blf-recovery.md)
---

### 3B. Bus health and the CAN link

**Decide:** what needs your dongles. Four of the nine are already routed to
[task 121](tasks/0121-the-trace-tells-the-truth-about-the-wire.md) — the
open questions here are the two rulings that task still waits on, and what
gets scheduled on hardware.

- **3.42** *routed, ruling owed* — **"Error-active" does not read as
  healthy.** It is the correct ISO 11898-1 name, but to a reader it looks
  like a fault is in progress. The other three states read correctly as
  degrees of trouble, so the healthy state is the only misleading label.
  **Owed: the replacement label**, and whether the ISO name survives as a
  tooltip.
  · your feedback 2026-08-23 → [121](tasks/0121-the-trace-tells-the-truth-about-the-wire.md)

- **3.53** *routed, ruling owed* — **Nothing counts frames the ingest path
  dropped**, so the user cannot tell whether the trace in front of them is
  complete, while every other number in the bar is read as if it were.
  **Owed: open the counter, or accept that completeness is unreportable.**
  · [103](tasks/0103-toolbar-status-chips.md) → [121](tasks/0121-the-trace-tells-the-truth-about-the-wire.md)

- **3.43** *routed* — Transmit frames present as though they reached a
  wire: `build_and_confirm` appends the tx-confirm row before any wire
  attempt and unconditionally.
  · your feedback 2026-08-23 → [121](tasks/0121-the-trace-tells-the-truth-about-the-wire.md)

- **3.37** *routed* — Same root: a wire-level `TX_REJECTED` reaches the app
  and is thrown away to dev stderr, so the tx-confirm row is a local echo
  and never a wire confirmation.
  · [109](tasks/0109-usage-feedback-chip-era.md) → [121](tasks/0121-the-trace-tells-the-truth-about-the-wire.md)

- **3.14** `[unverified]` Controller state and TEC/REC were built and
  unit-tested with no dongle available to the phase. **You hold the
  hardware.**
  · [101](tasks/0101-bus-health.md)

- **3.38** `[unverified]` The bus-health readout was structurally inert on
  PEAK — python-can's `PcanBus.state` returns a stored echo of the
  configured value, never a device read. Phase 2 switched to the live
  `CAN_GetStatus`, then 2c derived state from TEC/REC because the status
  word under-reports. **Your 2026-08-23 session confirms the PCAN fix
  works**; 3.42 and 3.43 came out of it.
  · [109](tasks/0109-usage-feedback-chip-era.md)

- **3.40** `[unverified]` The Vector path has **never met Vector hardware
  and cannot here** — vxlapi64 is absent, so the backend will not even load
  and the tests run against faked chip-state events. Implemented and
  untested. The re-test script wants a classic **and** an FD run.
  · [109](tasks/0109-usage-feedback-chip-era.md)

- **3.52** Adapter identity is a display name and nothing else,
  permanently, unless the protocol grows — `Interface` carries `id`,
  `display_name`, `fd_capable` and no more. **The approved prototype was
  showing fabricated driver and firmware strings.** Accept the reduced
  cell, or open the protocol work.
  · [101](tasks/0101-bus-health.md)

- **3.39** *routed, ruled 2026-08-26* — error frames stay in the saved
  capture and coalesce in the frontend. Nothing is dropped at ingest, so
  `bus_health.rs`'s promise holds. (The bench fault produced 115,136 error
  frames in 22 s, all of them trace rows.)
  · [109](tasks/0109-usage-feedback-chip-era.md) → [121](tasks/0121-the-trace-tells-the-truth-about-the-wire.md)

---

### 3C. GUI chrome against the prototype

**Decide:** yes or no, per deviation. Each is a deliberate departure from
what you approved, taken for a stated reason. Nothing here is lost either
way.

- **3.60** Two things the approved prototype says that the app does not.
  **(a)** the task says 42 icons, the prototype's own designated inventory
  names 36, the sprite defines 37. Phase 1 built the 36. **(b)** the mock
  drew a live-pattern chipfield for adding signals that the app has never
  had; phase 5 corrected the mock to match the app. **Confirm 36, and
  confirm the mock correction** — or the live-add field is unscoped new
  functionality.
  · [108](tasks/0108-gui-chip-redesign.md)

- **3.20** The Import chip no longer relabels to "Loading trace…" — it
  keeps its label and reports busy through the hairline, the disabled state
  and the tooltip. The prototype's own treatment, but a deliberate change
  to a shipped user-visible string.
  · [108](tasks/0108-gui-chip-redesign.md)

- **3.21** The top toolbar wraps rather than overflowing, per the
  prototype's `flex-wrap: wrap`. Consequence: the shared `useToolbarFit`
  hook shipped with `StatusBar` as its only consumer.
  · [108](tasks/0108-gui-chip-redesign.md)

- **3.22** The measurement strip is suppressed by a switch, with stored
  `measEnabled` deliberately left intact so the rework inherits real
  preferences. **Two things the rework must pick up:** `MeasurementMenu` is
  a deliberate orphan, and the panel-tier test guarding a derived-axis id
  mismatch was removed — the derivation is still covered at unit tier, but
  that seam is unguarded and wants its test written again.
  · [108](tasks/0108-gui-chip-redesign.md)

- **3.26** Ten bars were swept; **two were mutation-proved.** Control
  preservation across the other eight rests on the pre-existing tests being
  behavioural rather than markup-shaped. Worth a look during the chrome
  review — a quietly mis-wired control is the failure mode of a breadth
  phase.
  · [108](tasks/0108-gui-chip-redesign.md)

- **3.32** The plot's Shift+click gesture is undiscoverable — nothing on
  the plot says it exists, the README does. The prototype's hint line has
  no home in the chip toolbar, and the chip language has no hint-text
  element.
  · [107](tasks/0107-events-point-at-signals.md)

- **3.24** Two bars hand-write the chip element instead of using
  `ChipButton`, because they need the tall status swatch rather than its
  round dot. Not a visual fork — same classes — but two call sites will not
  inherit changes to the component. Cheap fix: give `ChipButton` an
  indicator form.
  · [108](tasks/0108-gui-chip-redesign.md)

- **3.23** Plot perf-readout visibility is view-local while its menu
  sibling `showDiag` persists. One line of `plotPanelConfig` either way;
  flagged because the two sit next to each other and behave differently.
  · [108](tasks/0108-gui-chip-redesign.md)

- **3.25** Servers' "Add Server" uses `pressed` for a disclosure that is
  neither a toggle nor a menu. One-line accessibility nit; wants
  `aria-expanded`.
  · [108](tasks/0108-gui-chip-redesign.md)

---

### 3D. Signal resolution and calculated fields

**Decide:** whether ADR 0027's model changes. Three of the seven are
already routed to [task 112](tasks/0112-signal-reference-registry.md).

- **3.7** `[wrong]` **A DBC-declared calculated field cannot be
  suppressed.** `merge_calc_override` is `o.counter.or(default)` — there is
  no value meaning *"the DBC says counter, this project says none"*, so
  unchecking a section writes nothing and the field returns on reopen. The
  user's edit is discarded silently. Closing it is an ADR-level change to
  `CalcFieldsSpec` and the `.cannet_rbs` format.
  · [100](tasks/0100-calc-fields-dbc-config.md)

- **3.50** `[wrong]` The inverse: a section counts as edited **from the
  first keystroke, not from a changed value.** Type the original value
  straight back and the project gains an override that restates the DBC —
  and that field stops following the DBC if the designation later changes.
  Accept, or ask for the value comparison.
  · [100](tasks/0100-calc-fields-dbc-config.md)

- **3.8** The RBS feed collapses the DBC and override layers, so on an
  overridden field the `Override` chip is right but the "DBC default: …"
  hint is empty — where the transmit panel fills it in.
  · [100](tasks/0100-calc-fields-dbc-config.md)

- **3.2** Calculated-field resolution stays **per message**, decided
  explicitly rather than inherited — a pick on any signal of a message
  moves the whole designation.
  · [92](tasks/0092-one-resolution-rule.md)

- **3.47** *routed* — Three surfaces compute in the frontend what
  `CLAUDE.md` says the model owns: the view-signals attention count, the
  RBS chip badge, and client-side sorting of the RBS grid. Each trade is
  defensible alone; together they are one question. **Ratify the exception,
  or move the display-status rule host-side.**
  · [89](tasks/0089-signal-mapping-panel.md) → [112](tasks/0112-signal-reference-registry.md)

- **3.41** *routed* — The view-signals panel is unvirtualized and pattern
  rows moved its bound: one `Cell` pattern over `ev-zonal` would put
  **1,074** rows in it. Task 112 names paging it as an exit criterion.
  · [109](tasks/0109-usage-feedback-chip-era.md) → [112](tasks/0112-signal-reference-registry.md)

- **3.31** *routed* — A file-backed series cannot be an event's subject:
  its `messageId` is a channel-group index, so `EventSubject`'s structural
  form has nothing true to say about it. Needs a fourth referent kind.
  · [107](tasks/0107-events-point-at-signals.md) → [112](tasks/0112-signal-reference-registry.md)

---

### 3E. The record: tests, gates, and what was walked

**Decide:** what acceptance requires before this chain merges. **This
section gates the close-out.** Two of the seven are cases where a broken
check *passed*.

- **3.44** `[unverified]` **Nothing in this chain has been seen running.**
  From task 86 onward not one claim rests on looking at the app — the rule
  against UI automation means no phase launched the GUI, and jsdom does no
  layout, so nothing proves anything fits, lines up or is legible. Named
  explicitly by tasks 86, 27, 108 (twice), 107 phase 5, 109 phases 5 and 6.
  **The installer is the first look anyone gets at most of this chain.**
  · the chain

- **3.45** `[unverified]` **§ 4 says every task was walked criterion by
  criterion. Five were not walked at all** — 89, 90, 93, 105, 110 — and
  three more are not clean: 27 (criterion 4 partial), 102 (one partly met,
  one not met), 106 (met on a ruling you have not confirmed). Not a defect
  in any task; a claim in the index wider than the evidence.
  · the chain

- **3.4** `[unverified]` Nothing in the 2,421-test suite caught task 98's
  defect, and **the two tests nearest it asserted the very rule that
  produced it.** Worth asking what else is pinned that way.
  · [98](tasks/0098-common-scale-wrong.md)

- **3.63** `[unverified]` **The frontend suite is not green.**
  `PlotPanel.dom.test.tsx` → *"re-renders no plot area when only
  panel-local state changes"* fails intermittently with `expected 1 to be
  +0`; reproduced in two of three full runs. One hypothesis raised and
  refuted, no cause established. Either phases have been reporting a flake
  as green, or it is recent.
  · overseer 2026-08-26

- **3.54** `[unverified]` The macOS event colour-picker fix **has never run
  on a Mac** — `.trace-event-swatch-input` now fills the swatch's footprint
  to give the OS picker an anchor rect. Task 102 records this criterion as
  *not met*. Schedule a Mac session: if fixed, close it; if not, revert the
  CSS and investigate the virtualized-row scroll-offset path.
  · [102](tasks/0102-event-surface.md)

- **3.17** *corrected 2026-08-22, fixed* — the gate was at fault, not the
  phase: `git grep` cannot see an untracked file, so a phase creating a new
  file and running the documented command was told the truth about tracked
  files only. Fixed in `5e142f53`, canary-proven. Left open because it is
  the string every phase copies.
  · [19](tasks/0019-command-palette-goto.md), [108](tasks/0108-gui-chip-redesign.md)

- **3.27** A CI guard test's own coverage check dropped a helper rather
  than a scenario — with the toolbar collapsed to commands-only, the
  `toolbar` helper's `assert!(!labels.is_empty())` became unsatisfiable.
  Follows from the chip toolbar's design, but it is a test-scope call.
  Flagged for a sanity check.
  · [110](tasks/0110-chain-ci-repair.md)

---

### 3F. The perf harness

**Decide:** fix the harness before the close-out gate runs, then rule on
two metrics that can fail with no code change. **This section gates the
close-out.** The theme is silent disarm — three of the five are checks that
passed while measuring nothing.

- **3.35** `[unverified]` **The ADR-0031 memory metrics are not isolated
  and fail silently in both directions.** Windows never clears a dead
  parent's `ParentProcessId`, so an orphan joins our tree on pid reuse — one
  run measured a 4 GB unrelated application as ours (`tree_mb_peak` 5132.6
  against a 1547.4 limit). Worse: when another cannet owns the shared
  WebView2 process, our own renderer is **not** our descendant, so
  `webview_mb` reads exactly 0.0 and the gate **passes**.
  · [107](tasks/0107-events-point-at-signals.md)

- **3.34** `[unverified]` **The perf-capture recipe in `README.md` had been
  wrong since the render tier shipped** — it omitted `--rbs-run-on-start`
  and claimed the RBS Run flag was already saved. Two phases followed it
  and measured an **idle bus that passed every gate.** Fixed and verified
  against three live captures; any frontend number taken before the fix may
  have been measured on no load.
  · [107](tasks/0107-events-point-at-signals.md)

- **3.62** `[unverified]` `window.__shot.importIdle()` was silently
  returning true mid-import — it polled for a button reading "Loading
  trace…", which 3.20 removed — so the shutter could fall on a half-loaded
  capture and **past extrapolation screenshots may show partial captures.**
  Fixed, but **no guard test covers it**: the helper is JS embedded in a
  Rust string. Decide whether the `__shot` helpers need a test that runs
  without a full capture.
  · [110](tasks/0110-chain-ci-repair.md)

- **3.46** **Two metrics can fail the close-out gate with no code change,
  and the ruling is owed before it runs.** `lag_ms_max` spanned 2.8–37.6 ms
  against a 41 ms limit across eight captures of one unchanged binary.
  `rx_gap_short_frac_worst` read 0.194 against a 0.166 limit on a
  byte-identical GUI. ADR 0031's limits ratchet down only, so widening one
  is your ruling. **Make it on the evidence rather than mid-gate.**
  · [88](tasks/0088-bus-assignment-governs-decode.md), [89](tasks/0089-signal-mapping-panel.md)

- **3.36** `[unverified]` Task 107 phase 5's memory behaviour is unmeasured
  and the phase could not fix that — every capture was taken with your own
  cannet running, which is what 3.35 makes unreadable, and killing it was
  not an option. Timing metrics are sound. **Needs one capture set with the
  machine to itself.**
  · [107](tasks/0107-events-point-at-signals.md)

---

### 3G. Frontend shared layer

**Decide:** one cleanup task, or leave them. All four are copies, bypasses
or two-models-for-one-thing — the shape `CLAUDE.md` § GUI architecture says
to watch for. **3.51 is the exception: a live defect, not a design
question.**

- **3.51** **Editing an event's tag or description leaves the keyboard dead
  until the user clicks.** Enter or Escape unmounts the input while it is
  still `document.activeElement`, so the gridview's recovery never fires.
  Task 19 fixed exactly this one level up for the F2 rename field;
  `EventBody`'s editors keep their own local state and were not fixed.
  **Reachable today by anyone who edits a tag.** Wants a fix with the
  regression test its sibling got.
  · [19](tasks/0019-command-palette-goto.md)

- **3.19** `useConnectionStates` still hand-rolls the host mirror and **its
  launch race stays open** on a shipped connection path. It cannot move
  as-is: `useHostMirror` treats the event as a nudge to re-read, while this
  one consumes the payload, pinned by name in a test. A `fromPayload`
  option would close the race and keep that expectation.
  · [108](tasks/0108-gui-chip-redesign.md)

- **3.18** Two focus models coexist in the trace gridviews — event rows are
  `tabIndex={0}` by an earlier decision with a test behind it, beside the
  container-plus-`aria-activedescendant` model everything else uses. Also
  no ARIA `role` on any trace gridview container or row, which leaves
  `aria-activedescendant` inert to assistive tech.
  · [19](tasks/0019-command-palette-goto.md)

- **3.13** `useBusHealth` hand-rolls the host mirror instead of using
  `useHostMirror` — it copied `useConnectionStates`, which predates the
  hook. The 1 Hz emitter closes the stale window fast, so the duplication
  is the real problem rather than the race. Assigned to task 108 phase 2.
  · [101](tasks/0101-bus-health.md)

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
- Run the render-tier gate once on the final tree (§2.2): four 60 s
  captures against the 2026-08-22 baseline (re-measured per ADR 0031's
  amendment, recorded at [task 96](tasks/0096-long-names-render.md))
  with `--rbs-run-on-start`, read as a band —
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
