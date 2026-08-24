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

---

## 1. Behaviour changes that need a yes or no

These shipped. Each is a deliberate change the owner has not seen, and
each reverses or extends something previously decided. Any of them can
be revisited — none is expensive to undo *now*, and all get harder the
longer the chain grows.

### 1.1 `unified` y-axis mode no longer scales each unit group to fill
[Task 98](tasks/0098-common-scale-wrong.md) · **reverses ADR 0026**

Fixing the −200 A-drawn-as-−1.5 defect meant one range per axis, being
the union of every visible series on it. The consequence: overlaying a
0–1 SOC with a ±300 A current in `unified` now draws the SOC flat
instead of scaling it to fill the canvas.

The fix is right — an axis cannot carry a scale it does not label — but
*which mode* pays for it is a judgement. `per-unit` and `individual`
still cover the overlay case. ADR 0026 is amended with both rationales
kept, so reversing is a documented flip, not an archaeology exercise.

**Needed: keep, or restore per-group filling in `unified` some other
way.**

### 1.2 An unpicked collision's row now reports a signal only a later database defines
[Task 92](tasks/0092-one-resolution-rule.md) · **overseer ruling, not an owner one**

Phase 2 left an asymmetry: whether a row reported such a signal depended
on whether some *other* signal in that message carried a pick. The
overseer ruled it closed — a fast path that changes which signals appear
is a second resolution rule, not an optimisation.

This is user-visible **without** a pick, which is the part the owner did
not rule on.

**Needed: ratify or overturn.**

### 1.3 A calculated field could be designated by a database that does not supply the message
[Task 92](tasks/0092-one-resolution-rule.md) phase 3

A sixth Shape A site the original sweep never listed:
`rebuild_configs`'s default loop enumerated only messages that *declare*
calculated fields, so a database behind the winner could designate a
counter on a message it does not supply. Measured, fixed, pinned.

The single place where an answer changes with **no pick involved**.
Almost certainly wanted — flagged because it is a silent correction to
data someone may have been reading.

### 1.4 Reload all from disk now swaps each database in place
[Task 88](tasks/0088-bus-assignment-governs-decode.md) phase 7

Bus assignment and priority position now **survive** a reload where they
used to be re-derived from the path list. Required to make the
stop-on-reload rule reachable at all, and the reading ADR 0053 §1
demands — but the brief only asked for a stop.

### 1.5 A disclosed row's clickable width is the 32 rem line
[Task 95](tasks/0095-grid-content-click-collapses.md)

A click to the right of a disclosed row now does nothing, where it used
to collapse the message. Small, but a real change in feel.

### 1.6 Editor-face content stays a block rather than becoming rows
[Task 95](tasks/0095-grid-content-click-collapses.md)

The ruling was "content becomes real rows". Read narrowly: content that
is a *list* becomes rows; content that is an *editor face* stays a
Tab-reached block, kept safe by the toggle rule instead. ADR 0044
amended to say so. A wider reading is possible and was not taken.

### 1.8 `--no-tls` is now one flag from an unprotected routable listener
[Task 94](tasks/0094-server-defaults-and-discovery.md) · **security posture**

With the default bind moved to `0.0.0.0:50051`, `--no-tls` alone now
serves the hardware in the clear on the LAN. It used to be a no-op by
itself, because the default bind was loopback — putting the hardware on
the wire unprotected took *two* flags and therefore two decisions.

ADR 0041 names `--no-tls` as exactly this escape hatch, so the posture
is unchanged **in kind** — the sentence just got shorter. The phase left
it alone rather than narrow it, because requiring an explicit `--bind`
alongside `--no-tls` would be rewriting the ADR's escape hatch, which is
not a phase agent's call.

**Needed: leave it, or narrow `--no-tls` to require an explicit
`--bind`.** Worth a moment's thought — the flag's blast radius grew
without its documentation changing.

### 1.9 A bare launch now draws a second firewall prompt
[Task 94](tasks/0094-server-defaults-and-discovery.md) · FYI

A routable TCP listener on first bare run means a Windows Defender
Firewall prompt, separate from the mDNS one and on a different port.
Documented in the README; nothing in code can pre-empt it.

### 1.13 The RBS chip does navigate to an individual RBS file, which the ruling said it would not
[Task 103](tasks/0103-toolbar-status-chips.md) · **diverges from an owner ruling**

The ruling: *"The RBS chip is for the RBS signal mapping and any
notes/warnings there, not for RBS status, and it doesn't take us to any
individual RBS file."*

What shipped: the **reporting** half is exactly as ruled — the badge
counts problems across every open `.cannet_rbs`. The **destination** is
not. With exactly one configuration open the chip opens that
configuration's signals grid, which is an individual RBS file. With none
or several it reports, is disabled, and its tooltip says why.

The phase could not do otherwise honestly: the combined problems view
the ruling implies **does not exist**, and it declined to invent one.
That was the right call — but it means a stated ruling is currently
contradicted in the one-config case, which is the common case.

**Needed: either accept the one-config shortcut, or scope the combined
problems view as its own task.** Flagged rather than left to be
discovered.

### ~~1.14 Bus load has no source~~
[Task 103](tasks/0103-toolbar-status-chips.md) · **RESOLVED 2026-08-22 by
[task 101](tasks/0101-bus-health.md)** (`a0fb49fb`, `63c665c2`). Bit times
per bus come from `TraceStore`'s existing windowed sampler
(`rate.rs::by_bus_bits`), the denominator from `ConnectionStates`'
applied `speed_bps`, and the division is host-side in
`bus_health::load_percent`. The bar shows the **worst** bus, not the
mean. See 1.16 for what the figure excludes.

### 1.16 Bus load is a documented floor, not an exact figure
[Task 101](tasks/0101-bus-health.md)

The percentage **excludes bit stuffing**, because stuff bits depend on
the transmitted pattern including the controller-computed CRC, which the
model does not retain. So the number is always a little low — by up to
roughly a fifth on worst-case payloads. The phase chose a documented
floor over an estimate, which is the right instinct, but this is a
number on screen that a reader will take literally.

**Needed: accept the floor, or label it as one in the UI.**

### 1.17 The virtual-bus adapter cell is blank where the mock drew text
[Task 101](tasks/0101-bus-health.md) · flagged by the phase

The bus-health mock drew "driver default (nothing sent)" for a Sim bus.
That string is `describeAppliedConfig`'s answer for a *real* adapter
sitting on its default; a vbus has no controller, so the formatter — which
the ruling said to reuse — answers nothing and the cell is empty.
Faithful to the ruling, different from the mock.

**Needed: accept the blank, or give a vbus its own words.**

### 1.18 Error coalescing keys on the bus, not on the error class
[Task 101](tasks/0101-bus-health.md) · FYI

The model carries no error class **anywhere**: `CanFramePayload::Error`
is a unit variant, `FRAME_KIND_ERROR` has no field, the BLF reader
discards `CAN_ERROR_EXT`'s `ecc`, and python-can does not expose one
uniformly. Adding it is a core-payload field plus BLF / MDF / proto /
sidecar round-trips *and* a live producer — otherwise an import and a
live session would key differently. Closest faithful reading taken and
annotated in place. A summary also cannot name its bus (bus *names* are
the frontend's), so the label reads "1 284 bus errors over 4.1 s" with
the bus riding the event's `tag`.

### 1.15 Pressing the connection chip while connecting disconnects
[Task 103](tasks/0103-toolbar-status-chips.md)

The prototype's state table left this undecided. A connect that never
lands has no other escape, so the phase chose cancel. Reasonable, and
recorded because it was a choice rather than a ruling.

### 1.19 A DBC-backed plot series naming no bus now resolves nothing
[Task 106](tasks/0106-any-bus-series-and-sample-order.md) · **implemented on the overseer's recommendation, not an owner ruling**

Task 88 phase 2 named this fix and declined to take it. The grooming
recommended it, development proceeded on the recommendation rather than
stopping, and it shipped in `e20bb41b` + `2158b9c7` — which are the
whole diff to revert.

What it means in practice: a project saved before per-bus signal binding
keeps its plot series, but they decode nothing until re-pointed. They
report `NotDecoded`, the most severe of the five mapping states, count
toward the signal-mapping attention badge, and the panel's picker now
offers every bus the loaded databases decode on. No migration, no silent
emptying, no auto-binding to "the only bus".

One consequence worth naming separately: **`restore` drops a busless
persisted cache row and its segment files** rather than restoring or
parking it. That is cache, not user data — the view's reference
survives — but it is a deletion. The mutation test showed the
alternative: without the guard the row is *parked*, holding disk for a
series nothing can revive.

**Needed: ratify, or revert the two commits.**

### 1.20 An event row in the Events view is now selectable
[task 107](tasks/0107-events-point-at-signals.md) phase 3

The linking gesture is "multi-select + toolbar button" (owner ruling
2026-08-21), and the selection it needs is the gridview's. ADR 0044
leaves selectability to the adapter's declaration, so the Events view now
declares its event rows selectable — clicking one selects it as well as
putting the cursor on it, Ctrl/Cmd+click adds a second, and the row
carries `aria-selected`. **Only that view.** An event interleaved into
the chronological trace is still cursor-only, as before.

**Needed: confirm that a click in the Events view now selecting is
wanted**, or say the multi-select should be a control of its own.

### 1.21 The Link Events chip also unlinks
[task 107](tasks/0107-events-point-at-signals.md) phase 3

The groomed scope named a "Link Events" control. Built as named, a link
can be made and never unmade — the host's `unlink_events` would have no
caller. The chip therefore has two faces: with two unlinked events
selected it reads **Link Events**, and with two already-linked events
selected it reads **Unlink Events** and drops the link.

**Needed: ratify, or say unlink belongs somewhere else.**

### 1.22 Shift+click on a plot now authors an event instead of placing a cursor
[task 107](tasks/0107-events-point-at-signals.md) phase 4

Shift was read nowhere in the plot canvas's mouse handling, so
Shift+left-click has always been a plain left-click — cursor A in `x`
mode, H1 in `y`, a note in `note`. It now creates an event about the
area's selected signals, **and only when that area holds a selection**;
with nothing selected it falls through to exactly the old behaviour. It
is deliberately mode-independent, so it also fires in `off`, where a
click used to do nothing at all.

**Needed: confirm the modifier is the right home for it**, and that
firing in every cursor mode (rather than only in `note` mode) is wanted.

### 1.23 A right-click on a trace frame row now leads with an event action
[task 107](tasks/0107-events-point-at-signals.md) phase 4

The groomed gesture is "the trace row's context menu". The panel already
opens the sources picker on any right-click, and rows are almost the
whole panel, so a row-owned menu of its own would take that affordance
away over most of the surface. Instead the row's right-click puts up the
**same** menu with **Create event from &lt;message&gt;** above the picker.
Nothing is lost; the menu has one more item on frame rows.

**Needed: ratify the shared menu**, or say the row deserves a menu of
its own with the picker dropped there.

### 1.24 Acting on an event now dims the plot around it
[task 107](tasks/0107-events-point-at-signals.md) phase 5

The ruling says acting on an event highlights its subjects. The shipped
reading also fades what the event says nothing about — the unnamed
series on that axis, and the unnamed marker lines, to alpha 0.28. Faded,
never hidden. It makes the highlight read at a glance, but it changes
how a shipped plot looks during a hover rather than only adding a new
mark, so it is not assumed.

**Needed: keep the fade, or highlight without dimming.** Two
conditionals either way.

### 1.25 Hovering an event overrides a selection instead of adding to it
[task 107](tasks/0107-events-point-at-signals.md) phase 5

Nothing ruled on the interaction between the two ways of acting on an
event. The reading taken is that pointing is the more immediate act, so
a hover replaces the selection for as long as it lasts. The consequence:
select a pair to see its extent band, then move the pointer across a
third event, and the band goes until the pointer leaves.

**Needed: confirm hover-wins, or make the two union.** One line.

### 1.26 Space in the RBS signals grid toggles the whole message
[task 109](tasks/0109-usage-feedback-chip-era.md) phase 3

Grooming asked for Space as the row's primary action in both RBS panels
but did not say what the action is where the row is a *field* rather
than a message. The reading taken is the one that keeps a single idiom:
Space activates / deactivates the message the field belongs to, which is
exactly what the row's Muted status reports. Two consequences: one press
moves every sibling field of that message, and where the mute comes from
the bus or the ECU the press is deliberately inert.

**Needed: confirm the message is the right subject, or name another.**

### 1.27 The bus-health launcher now tints for the warning limit, not only for passive and worse
[task 109](tasks/0109-usage-feedback-chip-era.md) phase 2c

Grooming settled that `CONTROLLER_STATE_WARNING` joins the wire. It did
not say whether a controller merely over the ISO warning limit is a
*concern* the status-bar launcher lights up for. The reading taken is
yes, with the warning tint rather than the fault tint: it is the reading
a real fault produces on its way to error-passive, and a launcher that
stayed neutral until 128 would go on saying nothing through the part of
a fault an operator could still act on. The bus-health row reads
`Error-warning` in the same palette as `Error-passive`; the words tell
them apart.

Consequence: a bus with occasional errors that crosses 96 and settles
back will tint the launcher briefly where it used to stay neutral.

**Needed: confirm the warning limit is worth a tint, or set the
threshold at error-passive.**

### 1.28 `project.close` is now `project.new`, and is no longer gated on a project file
[task 109](tasks/0109-usage-feedback-chip-era.md) phase 4

Grooming ruled the rename ("renaming a command id is a user-visible
change to the palette — take it"). Two things ride with it that grooming
did not name. The palette entry now reads **New project** where it read
*Close project* — `Close project` is kept as a hidden keyword so muscle
memory still lands on it — and the command is **ungated**: it used to
disappear whenever no project *file* was open, which is exactly the
session a user most wants to start over from. A stored keybinding on
`project.close` no longer resolves and is reported as such on load.

**Needed: confirm the ungating, and that "New project" is the wording
wanted in the palette.**

### 1.29 Every grid panel drops the browser focus ring once its cursor exists
[task 109](tasks/0109-usage-feedback-chip-era.md) phase 5

The reported whole-box highlight is the UA focus ring on the gridview
container, which is what holds DOM focus for the whole grid. It is
suppressed while the container names an active row, and kept while it
names none — so the trace, by-id, signals, view-signals, transmit,
database, RBS tree, RBS signals and BLF marker panels all stop drawing
a ring round the viewport once the cursor is somewhere, and the row's
own cursor styling is the only focus indication from then on.

**Needed: confirm the row indicator alone is legible enough, on the
panels where the cursor rides on the selection background rather than
an outline.** The detail and the experiment are in the task's status
log.

### 1.30 A signal-generator rule's matches are still not pushed
[task 109](tasks/0109-usage-feedback-chip-era.md) phase 6

Ruling 2.4 put pattern-matched signals into the view-signals list, and
they are: a plot area's patterns and the signals view's selection and
section patterns now push their matches identity-only. The phase's
brief named a third pattern case — a **signal-generator rule** — and
that one was left out deliberately.

A generator rule (ADR 0026) matches signal *names* across the whole
catalog to assign a color-wheel slot. It puts nothing on screen, and
wherever a matched signal is displayed the view displaying it already
pushes it — so including generator matches would list signals no view
shows. On the shipped example project a single rule like `Cell(\d+)`
would add about a thousand such rows, all reading Decoded except
whatever the databases happen to define twice, which would also enter
the attention count.

**Needed: yes or no.** The reasoning is in the task's status log; if
the answer is yes it is a small builder plus a push from
`GeneratorPanel`.

### 1.31 Notes outside a selected import range are now dropped
[Task 86](tasks/0086-usage-feedback-0.9.0.md)

Applying ADR 0046's import range to a file's annotations as well as its
frames is what stops an out-of-range marker dragging the session origin
below the window the user asked for. The consequence: importing a
sub-range of a BLF or MF4 discards every marker or note outside it,
where before they all came in. Re-importing at full range brings them
back, and BLF and MDF now behave the same way.

The grooming did not rule on it, and task 86's own exit-criteria walk
names it as the one item still needing an owner call.

**Needed: ratify the drop, or require annotations to survive a range
import.**

### 1.32 A hand-typed transmit row that happens to match a DBC id stops when that database leaves the bus
[Task 88](tasks/0088-bus-assignment-governs-decode.md) phase 4

`TransmitFrame` carries no provenance, so "built from a database" is
measured as "an assigned database on this bus defines this message". A
CAN id the user typed by hand that *coincidentally* matches a DBC
message therefore stops when that database is unassigned or removed.

Judged the right side to err on — the transmit panel was showing that
row the database's signal table, so from the user's side it *was* the
DBC's message — and the alternative is stamping a DBC path on every
transmit row, which is a persisted-model change for a case nobody has
reported. Recorded so the reading is a decision.

**Needed: ratify, or ask for real provenance on a transmit row.**

### 1.33 A duplicate-id collision marks only the losing database
[Task 88](tasks/0088-bus-assignment-governs-decode.md) phase 5

Where two assigned databases on one bus define the same id, the Database
panel marks the *loser* (`⚠ duplicate id — a.dbc wins A, B`); the
database whose decode is actually in effect carries nothing, on the
reasoning that correct behaviour needs no warning. The exit criteria
asked only that the warning name a winner, not that every party to a
collision be marked, so the quieter reading was taken.

**Needed: keep the asymmetric warning, or mark both parties.**

### 1.34 A project with no buses now captures nothing, and says nothing
[Task 88](tasks/0088-bus-assignment-governs-decode.md) phase 1

A channel can only be mapped to a bus and a frame on an unmapped channel
is dropped, so a project whose bus list is empty routes no frames and
its trace stays permanently empty. That is the model's intent ("frames
enter the GUI via a bus"), but it bites before the user has loaded a
single DBC, and nothing on screen explains it — discoverability was
deliberately scoped to the Database panel's unassigned row, which talks
about databases, not buses.

**Needed: accept the silent empty trace, or ask for a message naming the
missing bus.**

### 1.35 The `comment-references` CI gate is an overseer decision the task invited the owner to overturn
[Task 93](tasks/0093-source-comments-name-tasks.md) · **overseer ruling, not an owner one**

The task added a CI job failing the build on any `task [0-9]` or
`plans/` string under `apps/` or `crates/`. The evidence for it is that
the rule was reintroduced 54 times while every diff was being reviewed,
so review demonstrably does not enforce it. It went in CI rather than
the pre-commit hook because the hook stashes unstaged changes and
restores them minutes later, which has already destroyed concurrent
edits in this engagement (see 3.48).

The task's own words: *"Flagged for the owner to overturn if the tooling
is unwanted."*

**Needed: keep the gate, or drop it.**

### 1.36 Every coloured event this build writes to a BLF carries different bytes from the last release's
[Task 107](tasks/0107-events-point-at-signals.md) phase 2 · **interop**

A `GLOBAL_MARKER` carries `foreground_color` and `background_color`.
cannet used to write the event's colour as the *foreground* over a white
background — coloured glyphs on a white chip. It now writes the colour
as the **fill**, under white text, which is how python-can's independent
BLF writer packs one and the only reading under which the two fields
mean text-on-a-chip. cannet reads both conventions, so a cannet↔cannet
round-trip is safe and old files still open correctly; another tool will
draw a solid coloured block where it used to draw thin coloured glyphs.

**Nobody has watched CANoe or CANalyzer draw either form.** The whole
justification is python-can's literals as corroboration, not
observation — and python-can's *reader* ignores marker objects
entirely, which bounds what interop with tools built on it can mean.

**Needed: accept the new byte layout, or revert it pending an empirical
check on a machine with Vector tooling.**

### 1.37 ADR 0055's "do not convert a command into a chip" was amended by an implementation phase
[Task 108](tasks/0108-gui-chip-redesign.md) phase 3 · **amends an accepted ADR**

Task 103 shipped that sentence with ADR 0055; task 108's whole design
language contradicts it. Phase 3 amended the ADR rather than stopping —
the owner's chip rulings are the newer decision — keeping and
annotating the superseded rule rather than overwriting it (`45e7b559`,
after overseer review). The reconciliation offered is that the
silhouette is shared and the **dot**, present only on a chip with a
state to report, is what keeps a status chip readable as one.

The phase flagged it precisely because an accepted ADR was changed by an
implementation phase and not by a ruling.

**Needed: ratify the amendment and its dot-as-distinguisher rationale,
or restore the original rule and rethink the command chip.**

### 1.38 Three of task 108's grooming owner-calls shipped on the recommended reading, unruled
[Task 108](tasks/0108-gui-chip-redesign.md)

The grooming carried three `### Owner call` subsections, each naming
"the reading implementation takes if no ruling arrives". No ruling
arrived, and all three were implemented that way:

1. **The registry's mechanism** — an in-repo SVG sprite of 36 icons,
   rather than an icon dependency.
2. **How far icons reach into the panels** — a bounded sweep of event
   rows, the plot area, the signals panel and the RBS panel, not every
   glyph in the app.
3. **Whether Title Case re-casing reaches shipped strings** — it did.
   Every toolbar label changed case, with the old sentence-case phrase
   surviving only as the tooltip.

Item 3 is the one a user sees on every launch.

**Needed: ratify all three, or name which reading was wrong.**

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

---

## 3. Open findings nobody has dispositioned

Recorded by the phases that found them, not yet decided.

| # | Finding | Where |
|---|---|---|
| 3.1 | `decode_frame` (per signal) and `encode_frame` (per message) can disagree in one narrow collision-plus-pick case. Closing it is not cheap. | [task 92](tasks/0092-one-resolution-rule.md) |
| 3.2 | Calculated-field resolution stays **per message**, decided explicitly rather than inherited — so a pick on any signal of a message moves the whole designation. | [task 92](tasks/0092-one-resolution-rule.md) |
| 3.3 | Bare "Phase N" labels survive in `index.css` (5 sites) and `crates/cannet-blf/Cargo.toml` (1). They name no task and point at no `plans/` path, so both the rule and the new CI lint pass. An older numbering scheme; left rather than invent a meaning. | [task 93](tasks/0093-source-comments-name-tasks.md) |
| 3.4 | Nothing in the 2421-test suite caught task 98's defect, and the two tests nearest it asserted the very rule that produced it. Worth asking what else is pinned that way. | [task 98](tasks/0098-common-scale-wrong.md) |
| 3.5 | `cargo doc -p cannet-gui` emits **47 warnings** — unresolved links, public docs pointing at private items. All pre-existing, none from this chain. No task opened. | — |
| 3.11 | **The MDF census's first ~10 % is uninterruptible and unreported.** `Mdf4File::open` reads the whole file before the walk begins, so Cancel does not land and the progress bar does not move during it. Interrupting it means restructuring how every MDF is read — recorded rather than fixed. | [task 104](tasks/0104-load-progress-and-cancel.md) |
| 3.12 | Three IPC wire shapes changed: `scan_*_channels` may now return `null` (a cancelled census), `open_log` / `import_mdf` gained `totalFrames`, and `signal_pyramids_rebuilding` returns a record. Internal, but they are the kind of thing an out-of-tree consumer would trip over. | [task 104](tasks/0104-load-progress-and-cancel.md) |
| 3.9 | **A recovered BLF is dated from 1970.** A stub header carries the unset SYSTEMTIME, so `start_unix_nanos == 0`. Unrecoverable by construction — per-event timestamps are offsets *from* that anchor — so task 105 names it in the recovery log line rather than repairing it. A recovered capture therefore opens with a plausible-looking but wrong absolute time. | [task 105](tasks/0105-unfinalized-blf-recovery.md) |
| 3.10 | **An abandoned MDF `.part` opens as a silently empty capture.** `MdfCanFrameSource::open` accepts a 572 kB part file, walks to **zero** frames, and `is_unfinalized()` returns `false`. The writer emits the group description at `finish()`, so the records on disk have nothing describing their shape, and the ID block still reads `MDF` rather than `UnFinMF`. Fixing it is a writer change, and it is only reachable through the UI once `.part` discovery exists — out of task 105's scope. | [task 105](tasks/0105-unfinalized-blf-recovery.md) |
| 3.7 | **A DBC-declared calculated field cannot be suppressed by a project.** `merge_calc_override` is `o.counter.or(default)` — there is no value meaning "the DBC says counter, this project says none", so unchecking a section showing a DBC `Default` writes nothing and the field returns on reopen. That is ADR 0027's model as written, but task 100's seeding is what turns that checkbox into a live control over a DBC-declared field for the first time, so the gap is newly reachable. Expressing suppression is an ADR-level change to `CalcFieldsSpec` and the `.cannet_rbs` format. | [task 100](tasks/0100-calc-fields-dbc-config.md) |
| 3.8 | The RBS feed collapses the DBC and override layers, so on an overridden field the `Override` chip is right but the "DBC default: …" hint is empty — where the transmit panel fills it in. | [task 100](tasks/0100-calc-fields-dbc-config.md) |
| 3.13 | **`useBusHealth` hand-rolls the host-mirror instead of using `useHostMirror`.** It fetches a snapshot, then registers the listener, with no post-listener refetch — precisely the launch race the shared hook exists to close (six other call sites use it). It copied `useConnectionStates`, which predates the hook. The 1 Hz emitter closes the stale window fast, so the user impact is small; the duplication is the real problem. **Assigned to task 108 phase 2**, the shared-layer phase. | [task 101](tasks/0101-bus-health.md) |
| 3.14 | **Controller state and TEC/REC are unverified on hardware.** The sidecar's state-poll thread was already producing `InterfaceState`; task 101 built the consumer and tested it at unit tier, but no dongle was available to the phase. The owner holds the hardware. | [task 101](tasks/0101-bus-health.md) |
| 3.15 | **`cannet-mdf::FileSignal::timestamps_ns` is documented "ascending" with nothing enforcing it** — no sort in `signal_groups`. Argued structurally sound (one source, no CAN-style interleave), but it is a data-source crate *below* the signal cache and outside the phase's boundary, so it was recorded rather than swept. | [task 106](tasks/0106-any-bus-series-and-sample-order.md) |
| 3.16 | **`plotCursors::statsOver` undercounted a span with tied sample times** — fixed in `3b8fd808` with a real lower bound. FYI rather than a decision: worth knowing because the measurement strip it feeds is the surface [task 108](tasks/0108-gui-chip-redesign.md) rules stays hidden pending rework, so the wrong numbers were not on screen. | [task 106](tasks/0106-any-bus-series-and-sample-order.md) |
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
| 3.6 | Task 97's grooming asked that the owner see both axes before the **lanes** axis changed. No comparison was produced, because the lanes axis has no y-gutter labelling to compare — it already draws nothing there, and its labels are the tiles. If the owner meant the lane *tiles*, that is a different request, and it cuts against the stated reason for removing the axis labels. | [task 97](tasks/0097-enum-labels-on-axis.md) |
| 3.27 | **A CI guard test's own coverage check dropped a helper rather than a scenario.** `81d5343e` (task 108 phase 3) collapsed the toolbar to commands-only, which broke three `window.__shot.toolbar(...)` scenario steps in `cannet-perf-measurement`'s screenshot harness — fixed by switching them to the equivalent `command(...)` calls. With none left, the guard test's own `assert!(!labels.is_empty())` for the `toolbar` helper became unsatisfiable, so that coverage-loop entry was removed rather than the scenario weakened. Follows directly from the chip-toolbar's own "commands only" design, but it is a test-scope call, not a pure bugfix — flagged for a sanity check. | [task 110](tasks/0110-chain-ci-repair.md) |
| 3.28 | **Every MDF file cannet has written names its events the wrong `ev_type`.** `mdf4-rs` numbers `Marker` 2; ASAM MDF 4.x puts `EV_T_MARKER` at 6 and reads 2 as `EV_T_ACQUISITION_INTERRUPT` (confirmed against asammdf). Fixed at the write boundary; existing files stay mislabelled to conformant readers and nothing rewrites them. The crate's `from_u8` also rejects types 3–6, so a foreign file using them parses as a marker — worth an upstream issue. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.29 | **`ev_scope` is not written, because a cannet MDF has nothing for a subject to point at.** The grooming expected subjects to scope to a `##CN`/`##CG`; the writer emits three bus-logging groups by frame *structure* and no DBC-decoded signal channels, so a message subject has no referent and scoping one to `CAN_DataFrame` would be false. Becomes writable if per-message channel groups are ever written. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.30 | **A later schema version's unknown block keys survive a parse but not a model round-trip.** The groomed rule says they are preserved on rewrite; the parser does preserve them, but `Note` has no field to hold one, so opening and saving a file written by a future build drops what this build does not understand. Closing it means a passthrough field on the durable schema. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.31 | **A file-backed series cannot be an event's subject.** Its `messageId` is a signal channel group index rather than an arbitration id, so `EventSubject`'s structural form (ADR 0056) has nothing true to say about it — Shift+click over a selection of nothing but file-backed rows names nothing and falls through. Closing it means a fourth referent kind, which is a model change. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.32 | **The plot's Shift+click gesture is undiscoverable.** Nothing on the plot says it exists; the README does. The prototype showed a hint line in the plot bar that the shipped chip toolbar has no room for, and the chip language has no hint-text element. Recorded rather than invented. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.33 | **`NotesStore::linked_events` has now gone two phases without a caller.** Phase 3 nominated phase 4; authoring writes rather than reads, and phase 5's highlight work reads links in the frontend through the TS twin, so it will not be the caller either. Probably resolved by deleting the wrapper — the free `linked_event_ids` it delegates to has a production caller and states the same contract. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.34 | **The perf-capture recipe in `README.md` had been wrong since the render tier shipped**, omitting `--rbs-run-on-start` and claiming the RBS Run flag was "already in the saved project". Two phases followed it and measured an idle bus that *passed* every gate. Fixed in task 107 phase 4 and verified against three live captures. Worth knowing that any frontend perf number taken before this fix may have been measured on no load. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.35 | **The ADR-0031 memory metrics are not isolated from other processes, and fail silently in both directions.** `descendant_pids` (`crash.rs`) walks recorded parent-pid links, and Windows never clears a process's `ParentProcessId` when its parent exits — so an unrelated orphan joins our tree the moment one of our processes reuses its dead parent's pid. Observed: a run's sidecar took pid 64880, which the operator's separately-running cannet still names as its parent, and its whole 4 GB application was measured as ours (`tree_mb_peak` 5132.6 vs a 1547.4 limit). Worse, when another cannet owns the shared WebView2 browser process **our own renderer is not our descendant**, so `webview_mb` / `renderer_mb_peak` read exactly 0.0 and `tree_mb_peak` reads ~122 MB — and *passes*. Confirmed by a ground-truth `Win32_Process` walk alongside a capture. Same class as the idle-bus silent disarm, in a metric family nobody checks for plausibility. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.36 | **Task 107 phase 5's memory behaviour is unmeasured, and the phase could not fix that.** Every capture this session was taken with the operator's own cannet running, which is what 3.35 makes unreadable; killing it was not an option under the shared-hardware rule. The timing metrics are sound (verified load, every gated metric under baseline). A clean memory reading needs one capture set taken with the machine to itself. | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.37 | **A wire-level transmit rejection reaches the app and is thrown away.** `cannet-client::is_per_frame_error_code` classifies `TX_REJECTED` as non-fatal and logs it with `tracing::warn!`, which goes to dev stderr only — not the System Messages panel, not bus health, not the connection chip. So a tx-confirm trace row is a **local echo, never a wire confirmation**, and the trace can show a frame as sent that the far end refused: a listen-only bus, an FD frame on a classic bus, a saturated queue. Task 109 phase 2's route gate closes the unplugged-adapter case; this general one is a behavioural choice (where a rejection surfaces, and at what cadence — at RBS rate it is a flood and needs coalescing) so it was recorded rather than chosen. | [task 109](tasks/0109-usage-feedback-chip-era.md) |
| 3.39 | **Error frames are trace rows, one each, and that is most likely the owner's third symptom.** During the bench fault the adapter emitted 115,136 error frames in 22 s (~5,200/s), and nothing filters them out of the ingest path: `session.rs`'s only error branch *adds* the health-coalescer fold and the `trace_store.append` below it is unconditional, `trace_store/flush.rs` persists the kind like any other, and `trace_query.rs` spells it for the paged view. So the pack bus trace kept growing at ~5,200 rows/s during the fault. Phase 2 attributed "the trace continued getting updates" to tx-confirm rows and closed that case; this is a second, larger contributor it did not see. **Not fixed:** `bus_health.rs` records the opposite decision in its module doc ("The frames themselves are stored like any other frame ... so a saved capture is not a lossy restatement of what was received"), so suppressing or coalescing them changes what a save contains. Drop them, coalesce them into one row, or keep them and filter at the view - a behavioural choice, and a separate phase. | [task 109](tasks/0109-usage-feedback-chip-era.md) |
| 3.38 | **The bus-health readout was structurally inert on the only hardware there is.** python-can's `PcanBus.state` getter returns `self._state`, written only by the setter `__init__` calls — a stored echo of the configured value, never a device read — so bus-off and error-passive could not surface on PEAK no matter what the controller did. Task 109 phase 2 switches a PCAN bus onto the live `status()` read (`CAN_GetStatus`), matched against exact vendor status codes. That makes task 101's controller state work for the first time on this rig, and it is a behaviour change on a live data path that **has never met hardware** — worth knowing before the confirmation run. **Superseded in part by phase 2c:** the bench run showed `CAN_GetStatus` itself under-reports (it stops at `BUSWARNING` on a transmitter driving an open circuit), so the state is now derived from the error frames' TEC/REC and the status word only floors it. The exact match survives for the no-hardware code family alone. **Owner hardware verification 2026-08-23: the PCAN fix is confirmed working.** Unplugging the CAN link now surfaces the fault. Two follow-ups came out of that session and are filed as 3.42 and 3.43. | [task 109](tasks/0109-usage-feedback-chip-era.md) |
| 3.40 | **The Vector controller-state path has never met Vector hardware, and cannot here.** Task 109 phase 2d subclasses `VectorBus` to read the chip-state events its XL driver reports (`busStatus`, `txErrorCounter`, `rxErrorCounter`) and feeds them to the same derivation PEAK uses, polling with `xlCanRequestChipState` on the existing 500 ms cadence. The vxlapi64 DLL is absent in an agent's environment, so the backend cannot even load - the tests exercise the seam against faked chip-state events built from python-can 4.6.1's own struct definitions. Implemented and untested, not working. The re-test script is in the task file's blockers section, and it asks for a classic **and** an FD run, since the two event queues are different structs read through different hooks. It also asks whether Vector floods the trace with error frames the way PEAK does (3.39). | [task 109](tasks/0109-usage-feedback-chip-era.md) |
| 3.41 | **The view-signals panel is unvirtualized, and pattern rows move its bound.** Its row list renders one DOM subtree per row, on the recorded grounds that "the row count is bounded (the signals the open views reference)". Task 109 phase 6 keeps that literally true but widens it: a view selecting by pattern now contributes every signal its pattern matches. On the shipped `examples/ev-zonal` databases (2,203 signals) a signals view with the pattern `Cell` would put **1,074** rows in the panel. Measured in jsdom, mount-to-first-row scales roughly linearly - 100 rows 224 ms, 500 rows 482 ms, 2,000 rows 1,679 ms - which is a shape, not a browser figure; no real-browser number was taken (perf capture skipped by ruling 2.5). Recorded rather than fixed: virtualizing this panel is its own piece of work. | [task 109](tasks/0109-usage-feedback-chip-era.md) |
| 3.42 | **"Error-active" does not read as healthy.** Owner feedback 2026-08-23, after verifying the bus-health fix on hardware. `Error-active` is the correct ISO 11898-1 name for a node in normal operation — errors are *active* meaning the node still asserts dominant error flags — but to a reader it looks like a fault is in progress, which is the opposite of what it means. The other three states (`Error-warning`, `Error-passive`, `Bus-off`) read correctly as degrees of trouble, so the healthy state is the only one whose label misleads. Wants a label the panel can show without teaching the standard first; whether the ISO name survives as a tooltip is part of the decision. | owner feedback |
| 3.43 | **Transmit frames still present as though they reached a wire.** Owner feedback 2026-08-23, on the same session. A tx-confirm row is appended by `build_and_confirm` before any wire attempt and unconditionally, so a frame the bus never carried is indistinguishable in the trace from one it did. Task 109 phase 2 fixed the special case where the *interface* is unreachable, by parking the route; this is the general case, where the interface is fine and the frame still went nowhere — an open CAN link, a listen-only bus, FD on a classic bus. Overlaps 3.37 (the wire-level `TX_REJECTED` is received and discarded) and 3.39 (error frames arrive as trace rows at ~5,200/s during a fault); the three are most likely one piece of work. | owner feedback |
| 3.44 | **Nothing in this chain has been seen running.** Across every task from 86 onward, not one claim rests on looking at the app: the standing rule against UI automation on the owner's machine means no phase launched the GUI, and jsdom does no layout, so no frontend test proves that anything fits, lines up, or is legible. The phases that say so explicitly are 86 (three phases, "the owner-visible confirmation is opening `examples/time-origins/` by hand"), 27 (two disk-change notices asserted only through the DOM), 108 (ten restyled toolbars, `### What is not verified` twice: "jsdom does no layout"), 107 phase 5 (the extent wash and the series fade — `EXTENT_WASH_ALPHA` 0.16, `UNLIT_ALPHA` 0.28 — asserted as values, never as an appearance), 109 phase 5 (the focus ring was never photographed) and 109 phase 6 (the view-signals panel was never opened with a real project). The ADR-0031 capture cannot substitute: its script never hovers an event row and `ev-zonal` carries no events. **The installer is the first look anyone gets at most of this chain**, and several items above (1.29, 1.24, 1.25) are asking the owner to confirm exactly what only a look can answer. | the chain |
| 3.45 | **Not every task's exit criteria were walked, though § 4 says they were.** § 4's preamble and the roadmap both state that each implemented task "met its documented exit criteria, walked criterion by criterion against a named test or artefact". Five do not match that: **89** (six phases, no per-criterion verdict anywhere in the file), **90** (three of four criteria unverdicted, the fourth struck as retired into task 91), **93** (no verdict, only the sweep's counts), **105** (three phases landed, the criteria addressed in prose but never mapped) and **110** (no exit criteria at all — its verification is a table of CI jobs run by hand). Three more are walked but not clean: **27** criterion 4 is *partially met* (the functions stitching both watches together are covered by inspection, because Tauri's mock runtime will not load on Windows), **102** has one criterion *partly met* and one *not met*, and **106**'s criteria are met *on a ruling the owner has not confirmed* (1.19). 107's two unmet criteria are already declared in its own status. Not a defect in any task — a claim in the index that is wider than the evidence. | the chain |
| 3.46 | **Two perf metrics can fail the close-out gate with no code change, and a ruling is owed before it is run.** `lag_ms_max` spanned 2.8–37.6 ms against a 41 ms limit across eight captures of one *unchanged* binary, with `lag_ms` mean ~0 in every one — it is a single-sample scheduler tail. `rx_gap_short_frac_worst` behaves the same way: task 88 phase 2's pre-inversion control read 0.194 against a 0.166 limit on a GUI byte-identical to phase 1's, and task 89 phase 4 took twelve captures of which run 3 breached both it (0.2362) and `rx_gap_p95_ratio_worst` (3.307 vs 2.898). That phase explicitly declined to rule: *"It is **not** discarded and it is **not** ruled harmless by me."* ADR 0031's limits ratchet down only, so widening one needs an owner ruling recorded there — and § 5's close-out gate run will hit this. **Make the ruling on the evidence rather than mid-gate.** | [task 88](tasks/0088-bus-assignment-governs-decode.md), [task 89](tasks/0089-signal-mapping-panel.md) |
| 3.47 | **Three surfaces compute in the frontend what `CLAUDE.md` says the model owns, each for a stated reason.** (a) `useViewSignalsAttentionCount` calls `list_view_signals` and keeps only its `attentionCount`, discarding every row, on mount and on each change event — judged cheap when the row count was bounded by open views, which 3.41 has since widened to over a thousand rows for one pattern-selecting view. (b) The RBS chip's badge (`rbsAttention.ts`) re-runs the frontend's own `rbsSignalsFilter` over the host's rows, because *Out of Range* is a frontend decision, so a host-side count would legitimately be a different number from the panel's. (c) The RBS signals grid sorts client-side (`rbsSignalsColumns.ts::sortRbsSignalRows`) although task 89's own grooming resolved that a paged view passes `sortKey`/`sortDir` to the host — same cause as (b). Each trade is defensible in isolation; together they are one question. **Ratify the exception, or move the display-status rule host-side so one answer serves all three.** | [task 89](tasks/0089-signal-mapping-panel.md), [task 103](tasks/0103-toolbar-status-chips.md) |
| 3.48 | **`pre-commit` overwrites any file edited while a commit is running, and `--no-verify` has become the de facto workflow.** Every hooked commit stashes the unstaged working tree to `~/.cache/pre-commit/patch<n>`, runs the workspace clippy and test gates (a couple of minutes), then restores the pre-edit copy — so an edit made *during* the run is silently reverted. That is the diagnosed mechanism behind planning-doc edits disappearing while an implementation agent commits alongside a live grooming session; no agent ran `git checkout`, `restore` or `stash`. The workaround every phase from task 88 onward adopted is `--no-verify` with the gates run by hand, which means the hooks have been effectively disabled across most of this chain. Stashed copies survive in `~/.cache/pre-commit/patch*` if anything needs recovering. **Fix the hook, or bless the hand-run gates as the workflow.** | [task 88](tasks/0088-bus-assignment-governs-decode.md) |
| 3.49 | **No Vector tool has been watched reading a cannet BLF that carries a descending object timestamp, and this chain makes them more likely.** Task 87 established that BLF permits non-monotonic object timestamps *by silence* — there is no published spec, and Technica's `vector_blf`, Wireshark and python-can all read descents without complaint, python-can's writer emitting them. But CANoe/CANalyzer were unavailable, and Vector's `BLSeekTime` API ("seek forward to the first object with a certain time stamp") implicitly assumes ascent. Task 87's fix means a dip *below* the first appended frame is now preserved rather than flattened, so a cannet-written BLF is measurably more likely to carry a descent than any previous release's. The stated residual is "a time-seeking Vector consumer landing somewhere surprising, not an unreadable file". **Accept the exposure, or fund a `vector-blf-oracle` / a CANoe check before these files leave the tool.** | [task 87](tasks/0087-blf-writer-timestamp-fidelity.md) |
| 3.50 | **A calculated-fields section counts as edited from the first keystroke, not from a changed value.** The editor decides whether to write an override on Apply by asking whether the section has been touched since the modal opened. Type into a section showing a DBC `Default`, type the original value straight back, and it is now an `Override` — the project's `.cannet_rbs` gains an override that is a byte-for-byte restatement of what the DBC already says, and that field will no longer follow the DBC if the designation later changes. The phase declined the fix because a structural comparison needs a second definition of "these two specs are the same" (the numeric fields live as strings in the controls and as numbers or `0x…` strings on the wire). Newly reachable because task 100 is what turns those checkboxes into live controls over DBC-declared fields. **Accept, or ask for the value comparison.** | [task 100](tasks/0100-calc-fields-dbc-config.md) |
| 3.51 | **Editing an event's tag or description leaves the keyboard dead until the user clicks.** Task 19 step 2 fixed exactly this bug one level up — ending an event *rename* (the F2 field) now hands focus back to the grid. `EventBody`'s tag and description editors keep their own local `editing` state and were not fixed: Enter or Escape unmounts the input while it is still `document.activeElement`, so the gridview layer's recovery — which checks for `body` during the keypress — never fires, and the arrow keys do nothing until the user clicks somewhere. Reachable today by anyone who edits an event's tag or description. Left because nothing in that step opened those editors from the keyboard. **A live defect, not a design question — it wants a fix with the regression test the sibling bug got.** | [task 19](tasks/0019-command-palette-goto.md) |
| 3.52 | **Adapter identity in the bus-health panel is a display name and nothing else, permanently, unless the protocol grows.** The wire's `Interface` message carries exactly three fields — `id`, `display_name`, `fd_capable` — so driver name and version, firmware version, serial and channel count are not obtainable without new protocol fields *and* a server-side producer for them. Worth knowing: the accepted prototype was showing **fabricated** driver and firmware strings until this was checked during implementation, so the panel as approved promised more than the panel as shipped can deliver. **Accept the reduced adapter cell, or open the protocol work.** (1.17 covers only the *virtual* bus's blank cell, which is a different thing.) | [task 101](tasks/0101-bus-health.md) |
| 3.53 | **Nothing counts frames the ingest path dropped, so the user cannot tell whether the trace in front of them is complete.** The status-bar inventory considered "dropped / overrun frames" and deliberately did not adopt it, because no such counter exists anywhere in cannet — adding one is new work on the ingest path, not a new label. It is, though, the one number that answers whether what is on screen is the whole of what the bus sent or a lossy subset, and every other number in the bar (rates, bus load, error rate) is read as if it were complete. Recorded at the time as "worth a decision rather than silent omission"; no decision has been made. **Open the counter, or accept that completeness is unreportable.** | [task 103](tasks/0103-toolbar-status-chips.md) |
| 3.54 | **The macOS event colour-picker fix has never run on a Mac.** The native colour picker for a timeline event opens in the wrong place on macOS while the plot's series picker opens correctly, so the two anchoring paths differ. A candidate fix shipped — `.trace-event-swatch-input` now fills the swatch's real footprint (`inset: 0`) instead of collapsing to a zero-size point, giving the OS picker a concrete anchor rect — but no Mac has ever run it, and the task's own exit criteria record this one as **not met**. **Schedule a Mac session: if it is fixed, close it; if not, revert the CSS and investigate the virtualized-row scroll-offset anchor path instead.** | [task 102](tasks/0102-event-surface.md) |
| 3.55 | **ADR 0035 decision point 3 says `EVENT_COMMENT` markers render in "the graph view", and there is no such view.** cannet's only graph view is `ProjectGraphPanel`, a topology of gateways, buses and filters with no time axis, so a timeline event has no coordinate to land on there. What shipped instead is message-bound comments rendering in the **plot** and in both trace modes. The clause sits in the ADR and in task 102's exit criteria, which is why one of them reads *partly met*; the phase recorded rather than struck it, because deleting a decision point is the owner's call. **Strike the clause, or restate it against a view that has a time axis.** | [task 102](tasks/0102-event-surface.md) |
| 3.56 | **An MDF round-trip silently drops a message-bound comment's `commented_event_type`.** BLF's `EVENT_COMMENT` (object type 92) records which object type the comment is attached to, so the annotation tracks with its message; MDF's `##EV` block has no analogue. A message-bound event written to MDF and reimported comes back **freestanding** — it has come loose from the message it annotated. Documented at `note_from_event` and declared acceptable on the grounds that BLF is the interchange home for annotations, but it is a lossy write of the kind this repo says it does not accept. **Ratify the exemption, or ask for a carrier** (the `cannet-event/1` text block task 107 added to the same files is the obvious one). | [task 102](tasks/0102-event-surface.md) |
| 3.57 | **A message-bound annotation cannot be authored in cannet, only imported.** Task 102's scope named a "Create marker from message" gesture — pick a source message, write comment text, emit an `EVENT_COMMENT` whose object timestamp is the source message's — and deferred it by its own terms ("UI design needed"). It was not built and nothing since has built it, so `messageBound` events arrive only from imported captures. Task 107 phase 4 added *its* own message gesture (right-click a frame row → **Create event from &lt;message&gt;**), which creates a subject-carrying event rather than a BLF-style bound comment, so the two are adjacent but not the same thing. **Scope the authoring UI as its own task, or rule the import-only shape sufficient now that 107's gesture exists.** | [task 102](tasks/0102-event-surface.md) |
| 3.58 | **`<dest>.part` discovery is owed a task, and the precondition its grooming set has been met.** Grooming ruled the feature out of scope with a trigger attached: it "becomes its own task once this one establishes such a file is readable at all". Phase 1 established exactly that — a hard-killed `BlfCaptureWriter` leaves a `<dest>.part` with a stub header and 107,770 bytes of complete containers — and phase 2 made cannet able to read it (16,387 recoverable frames in the measured fixture). So a user whose session was killed has a recoverable capture sitting on disk and nothing in the UI offers it back; the crash-recovery surface that would has never been scoped. **Open the task, or rule the leftovers permanently invisible.** | [task 105](tasks/0105-unfinalized-blf-recovery.md) |
| 3.59 | **An event coloured pure black loses its colour through BLF.** A `GLOBAL_MARKER` packs a colour as a 24-bit integer, so the value `0` means both "black" and "no colour set" — an event the user deliberately coloured `#000000` reads back from a BLF as uncoloured. Pre-existing rather than introduced; task 107 phase 2 pinned it with a test and recorded it in ADR 0057's loss table instead of fixing it, since fixing needs a sentinel or an extra field. Now cheap to close, because 107 added a `cannet-event/1` text block to the same marker that could carry the colour explicitly. **Accept black-as-uncoloured as a permanent BLF limitation, or carry the colour in the text block.** | [task 107](tasks/0107-events-point-at-signals.md) |
| 3.60 | **Two things task 108's approved prototype says that the app does not.** (a) **The icon count.** The task description and its grooming both state the registry is 42 icons; the prototype's own "icon set — full inventory" section — the explicitly designated source of truth — names 36, and the sprite defines 37 `<symbol>`s (the 36 plus `i-reload`, whose only command phase 4 retires). Phase 1 built the 36 and flagged the discrepancy rather than reconciling it; adding more later is additive. (b) **A control that has never existed.** The prototype's signals-view mock drew a chipfield that adds signals by typing a live pattern, in the plot solo box's dialect. The app has never had it; what exists is a toggle chip opening an in-panel editor with manual picks and patterns, and phase 5 restyled that and *corrected the mock to match the app*. **Confirm 36 is the intended set, and confirm the mock correction — or say the live-add field was genuinely wanted, in which case it is unscoped new functionality.** | [task 108](tasks/0108-gui-chip-redesign.md) |
| 3.61 | **~~CI has never run on any of this chain, and nothing arranges for it to.~~ Superseded 2026-08-23 by observation: it runs, and the results are legible.** Pushing the stack triggered CI per branch. Everything **below** `chain-ci-repair` fails — task 91 through 99, and `task-92-phase-3-shared-resolver` — which is exactly the two lints that branch was created to repair (a clippy `redundant closure` from task 92's `16ffadf6`, and the screenshot guard test from task 108 phase 3's `81d5343e`); the fix sits above them in the stack, so a branch-tip run cannot see it. `chain-ci-repair` itself is **green**, as are task 107 phase 5 (on the amended commit — the pre-amend run failed, which is the `tsc -b` breakage that amend fixed) and task 109 phases 1–3. Phases 2c, 2d, 4, 5, 6 and `chain-docs-closeout` are unpushed and have no runs. **What is actually owed:** a decision on whether the sub-`chain-ci-repair` branches need to be green individually, or whether only the merged tip matters. If each is a PR, each shows red. | overseer 2026-08-23 |
| 3.62 | **`window.__shot.importIdle()` was silently returning true mid-import, so past extrapolation screenshots may show partial captures.** The screenshot harness proved an import had finished by polling for a `.toolbar button` whose text read `"Loading trace…"`; since `81d5343e` (task 108 phase 3) the Import chip keeps its label for its whole lifetime and reports busy through `aria-busy` instead (3.20), so the poll succeeded immediately, `waitFor('the import to finish', …)` resolved at once, and the shutter could fall on a half-loaded capture. Fixed in task 110 (`!document.querySelector('.toolbar button[aria-busy="true"]')`) — but **no guard test covers it**: the helper is JavaScript embedded in a Rust string, exercised only by a real capture run, so the next markup change breaks it just as silently. Same family as the idle-bus disarm (1.10) and the pid-reuse memory defect (3.35). **Decide whether the `__shot` helpers need a guard test that runs without a full capture.** | [task 110](tasks/0110-chain-ci-repair.md) |

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
