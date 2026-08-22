# Task 103 — Toolbar Buttons Become Status Chips

Opened by owner instruction 2026-08-20, while grooming bus health:

> health panel + status chip. We're gonna start transforming toolbar
> buttons into something a bit more polished. We probably ought to
> prototype this.

Separated from [task 101](0101-bus-health.md) deliberately. The bus
health chip is the **first instance** of this direction, not the whole
of it — and a visual language invented inside one feature, for one
readout, is how a codebase ends up with five chips that each look
almost the same. This task owns the language; task 101 consumes it.

## The problem being solved

The app's toolbars are buttons: a thing you press. But several of the
things sitting in them are not commands — they are **states that
occasionally want pressing**. The RBS kill switch button reported a
state (and is being removed by [task 99](0099-transmit-controls.md)
for exactly that confusion); the RBS panel's connection dot and its
per-message "scheduled" dot are states with no affordance at all; the
bus health chip is a state that opens a panel.

A chip is the shape that fits: it **shows a state, and pressing it goes
to where that state is managed.**

## Scope

- **Prototype first.** This repo's practice is an HTML prototype under
  `plans/prototypes/`, reviewed with the owner, and deleted by the
  phase that implements it — task 89 did precisely this for the signal
  mapping panel and its phase 6 removed both prototypes on landing.

  **First prototype written 2026-08-20 by owner instruction
  ("let's prototype the connect/disconnect toggle button"):**
  `plans/prototypes/connect-disconnect-chip.html`. It carries two
  variants, the five proposed states, the bus-health chip beside it as
  a sibling check, and today's button for comparison.

  **Owner ruling 2026-08-20 — the chip's shape is settled:**

  - **Variant A**: one chip, the whole thing toggles. The split
    (state-opens-detail / action-toggles) variant is rejected and has
    been removed from the prototype.
  - **Uniform width across every state**, so the chip does not resize
    as a connection progresses and a toolbar never reflows under the
    pointer. The count is tabular-numeric and right-aligned for the
    same reason. Uniform width is *within* one chip's state set, not
    across different chips.
  - **Rounded rectangles matching the shared colour chip.** Owner:
    *"I want rounded rectangles; they should look like our other color
    chips throughout the UI."* So the status chip takes `.color-chip`'s
    2px radius and 1px `--border-wash` edge verbatim, and its indicator
    is a rounded square rather than a circle.
  - **The outline carries the state.** Owner: *"I do like the outline
    appearance of the first draft. I just want the shape matching the
    other chips."* An idle chip is the plain hairline, identical to a
    colour chip's; every other state tints that same 1px edge — no
    weight change, no movement.

  **Prototype accepted 2026-08-20** ("otherwise looks right", after
  the width guides — a prototype-only annotation, never part of the
  chip — were removed). The implementing phase builds from it and
  deletes it, per this repo's practice.


  Why connect/disconnect is the right first instance: the model
  already knows more than the control shows. `BusConnState` is
  per-logical-bus and three-valued (`Connecting` / `Connected` /
  `Error { reason }`), while `ProjectPanel.tsx` renders a single
  boolean as "Connect all" / "Disconnect all". **Degraded — some buses
  connected, some errored — is unrepresentable today**, and it is the
  ordinary consequence of one adapter among three being unplugged.
- **Define the vocabulary**, not just the pixels: what states a chip
  can be in (neutral / attention / fault, at minimum, since bus health
  needs error-passive distinguishable from bus-off), how a count is
  carried (the signal mapping panel's launcher badge already carries a
  needs-attention count, by owner ruling), what pressing one does, and
  what it looks like disabled or unknown.
- **One implementation.** A shared component, not a per-panel copy —
  the same rule that governs the gridview primitives and the shared
  colour chip. The colour chip is the nearest precedent: it was
  adopted by the colour-map rule editor, the project bus picker and the
  signal name picker in three successive commits, and that is the shape
  to repeat.
- **Identify the candidates before converting any.** Sweep the
  toolbars for controls that are really states. Known so far: the RBS
  bus connection dot, the RBS scheduled dot (task 99 replaces it with a
  status column, so confirm whether a chip is right instead), the
  signal mapping panel's attention badge, the bus health chip, and the
  connection state the transmit panel already tracks.

## Prototypes

| file | covers | state |
|---|---|---|
| ~~`plans/prototypes/connect-disconnect-chip.html`~~ | the chip's shape and its five states | accepted 2026-08-20, **implemented and deleted** 2026-08-21 |
| ~~`plans/prototypes/toolbar-status-bar.html`~~ | the full toolbar plus a status bar replacing the prose status line | accepted 2026-08-21, **implemented and deleted** 2026-08-21 |
| `plans/prototypes/bus-health.html` | the bus health panel ([task 101](0101-bus-health.md)) | panel accepted; adapter column still open |

The toolbar prototype was written 2026-08-20 by owner instruction:
*"the cohesive connect + status chip + status label and the formatted
nature might actually be a nice replacement for our existing status
label row in the toolbar. Let's prototype that too. The full toolbar +
a status bar below it."*

**What the inventory turned up.** The header today is 22 toolbar items
that wrap, above a `.status` line that is a *sentence*:
`Streaming from 2 servers (5 interfaces, 1 234 567 frames · 18.4k f/s ·
41:07 elapsed · 4.2 GB RAM · 12.1 GB cache). 3 DBCs.` The numbers
cannot align, because the prose in front of them changes length with
the session. `splitStatus` (`statusLine.ts`) also produces five further
shapes the bar must carry, not one: an idle prompt, a census-in-flight
line, a cache-rebuild line **with its own Discard button**, a
changed-on-disk notice **with Reload and Dismiss**, and transient error
text.

**The proposal beyond what was asked, flagged as such:** *Signal
mapping* and *System messages* move to the right of the bar, because
they are the two toolbar items that report a condition rather than
perform an action — the signal-mapping launcher already carries a
needs-attention count by owner ruling, and a badge belongs beside
status, not in a row of verbs. That leaves the toolbar as commands
only, which is the coherent version of "toolbar buttons become
something more polished".

**Not proposed, deliberately:** collapsing the seven `Add …` buttons
into one menu. It is the largest single reduction available and it was
not asked for; it is noted in the prototype as a separate question.

### Status-bar rulings (owner, 2026-08-20)

- **Signal mapping and System messages are always present**, in every
  state. A surface that reports a condition is useless if it vanishes
  when there is a condition to report — and the signal-mapping badge
  already carries a needs-attention count.
- **The DBC count leaves the bar.** It is a fact about configuration,
  not about what is happening; the Database panel owns it.
- **Load progress becomes determinate**, and cancel gets a real
  affordance — split out as [task 104](0104-load-progress-and-cancel.md)
  because grooming found progress and census-cancel to be the same
  missing mechanism.
- **While connected the bar gains one live-only metric: bus load.**
  Answering the owner's question — "are there any messages that we
  might want to replace our 'census' metrics while connected?" Frames,
  elapsed, RAM and cache describe the buffer and are equally true of a
  loaded file; bus load is meaningless for a file, because a capture
  has no wire. It arrives with [task 101](0101-bus-health.md). Error
  rate stays in the health chip rather than becoming another number.
- **Clock offset stays out of the bar.** Owner ruling 2026-08-20:
  *"clock offset doesn't deserve to displace our time stats."* It was
  proposed because it is already measured and effectively invisible —
  `SessionClock` probes it over the session stream, `clock_status.rs`
  polls and publishes it to the server-list row with a warn threshold
  (`CLOCK_WARN_THRESHOLD_NS`) — but the bar has finite width and the
  standing time metrics earn their place. It keeps its existing home in
  the server-list row and its two log lines.
- **The connection control moves into the status bar.** Owner ruling
  2026-08-20, revising the earlier intent that it stay in the toolbar.
  The chip shows the state and pressing it connects or disconnects; the
  toolbar keeps no Connect button, so nothing reports connection from
  two places and the toolbar is left as commands only.
- **Notices stay in the bar, with their buttons.** Changed-on-disk
  keeps Reload and Dismiss; the cache rebuild keeps Discard. The bar is
  a readout that also carries the response to what it reports.
- **The bar is one row and never wraps.** Owner 2026-08-20: *"this
  status bar should not wrap, it overflows into the expansion menu."*
  A header that grows a second line reflows every panel beneath it, so
  running out of room is handled by removing things rather than taking
  more space. `flex-wrap: nowrap` enforces it; the drop behaviour below
  is what keeps that from simply clipping.

  **Do not add `overflow: hidden` to the bar.** It looks like the
  belt-and-braces companion to `nowrap` and it breaks the overflow
  menu: the menu is an absolutely-positioned child of the bar, so a
  clipping bar swallows its own dropdown. Fit is guaranteed by dropping
  items, not by clipping them. (Found by doing exactly this in the
  prototype.) If a future layout genuinely needs the bar to clip, the
  menu has to be portaled out of it first.
- **Metric order, left to right: `f/s`, `bus load`, `frames`,
  `elapsed`, `RAM`, `cache`.** When the bar cannot fit them all they
  **drop from the right**, in that order.
- **The full readout is a tooltip on the metric labels** (owner
  2026-08-20, "tooltip over the labels") — hovering any label shows
  every metric including the dropped ones, so a narrow window costs a
  hover rather than the number. This also **replaces the single blob
  `title` currently on the whole `.status` div**
  ("buffered frames · frame rate · elapsed capture · resident
  memory (app + WebView) · disk-spill cache on disk"), which is the
  present-day version of the same idea attached to the wrong element.
- **Bus health is a launcher, not a status chip.** Owner 2026-08-20:
  *"'bus health' is a weird choice for 'bus is healthy'. It also
  overlaps a lot with the connected chip status. And actually, if we
  have multiple buses it doesn't tell us which bus/buses are off, so
  it's a bit ambiguous. Maybe we just need a small button to show the
  bus health panel we prototyped. I think an icon would keep it
  tight."*

  Three separate faults, and the third is the disqualifying one: a
  single summary **cannot name which bus is off**, which is the only
  thing worth knowing when one is. So it becomes a compact icon button
  that opens [task 101](0101-bus-health.md)'s panel, where "which bus"
  is answered. **Accepted 2026-08-21 as presented:** it stays neutral while
  every bus is error-active and **tints plus grows a count when one is
  not**, with the tooltip naming the bus — so a bus going off is still
  noticed without needing a word for the healthy case.

- **Chips are sized to their longest state, not padded.** Owner
  2026-08-20: the chips "seem wider than they need to be". Uniform
  width across a chip's states still stands; it just must be the width
  uniformity actually requires — the connection chip's longest state is
  `Connecting…` plus `1 / 3`.

- **The pinned chips never drop; they collapse.** Owner 2026-08-20:
  the overflow control "should instead expand to hold the signal and
  system message chips, and grow a counter summing both". So when the
  bar runs out of room they fold into one control **badged with the sum
  of their counts**, which opens **a menu** containing them (owner: "a
  menu with the chips; not a toggle") — the same dropdown shape the
  toolbar's recent-captures control already uses, so
  `useDismissableMenu` and `ul.recent-captures-menu` are the existing
  precedents to follow rather than a new popup.

  **Three chips are pinned, in this left-to-right order: System
  messages, Signal mapping, RBS** (owner 2026-08-20). They are **pushed
  progressively into the menu from the right** — RBS first, then Signal
  mapping, then System messages — so the last one standing is the one
  that reports faults. The badge sums only what is actually inside the
  menu, so it reads `2` when RBS alone has been pushed in and `8` when
  all three have.

  **The RBS chip is new here, and it is a mapping chip.** Owner
  correction 2026-08-20: *"The RBS chip is for the RBS signal mapping
  and any notes/warnings there, not for RBS status, and it doesn't take
  us to any individual RBS file."* So it is the RBS counterpart of the
  Signal mapping chip — notes and warnings across the project's RBS
  configurations (a field the resolved DBC does not define, an override
  naming a signal that no longer exists, a value that will not encode)
  — badged with that count, unbadged when nothing needs attention. It
  reports nothing about run state.

  **Open question, load-bearing for [task 89](0089-signal-mapping-panel.md)'s
  design: what does clicking it open?** It cannot open one
  `.cannet_rbs` file — a project may have several, and choosing one is
  the same ambiguity that turned bus health into a launcher. But task
  89 phase 6's RBS signals grid is deliberately scoped to a **single**
  element, on the stated grounds that two RBS configs are meant to
  carry different values and must never be combined.

  **Resolution accepted 2026-08-21** with the prototype ("I'm signing
  off on the prototype — looks good as presented here"), which states
  it: **combining is fine for reporting and forbidden
  for editing.** The chip opens a view listing every config's problems
  together, naming which config each belongs to; acting on one enters
  that config's own grid, where values are still edited one file at a
  time. This preserves phase 6's rule rather than overturning it — the
  reason configs are not combined is that their *values* are
  independent, not that their *faults* are. Needs the owner's
  confirmation before either task builds it.

  Note this makes the overflow control a **chip** overflow, not a
  metric one. Metrics overflow into the label tooltip; chips overflow
  into this control. Two different mechanisms, deliberately, because
  the two have different stakes: a hidden number is an inconvenience, a
  hidden alert is a defect.
- **Noted, not adopted: dropped / overrun frames.** Nothing counts
  frames the ingest path could not keep up with, so this would be new
  work — but it is the one number that says whether what the user is
  looking at is *complete*. Worth a decision rather than silent
  omission.

## Open questions — grooming

- **How far does "transforming toolbar buttons" go?** The owner's
  phrasing is a direction, not a list. Converting genuine *commands*
  into chips would be wrong — a chip that is only ever pressed is just
  a button with extra styling. Recommendation: convert only controls
  that carry state, and treat the rest of the toolbar polish as
  styling that this task may define but need not apply everywhere.
- ~~Does the chip belong in a global strip, per panel, or both?~~
  **Resolved 2026-08-20 (owner): the status bar beneath the toolbar.**
  *"We're not doing a footer status bar. We have the top status bar
  prototype we're going to implement."* The global chips — connection
  and bus health — live in that bar; panel-local indicators (the RBS
  connection dot) stay in their panels and are the same component in a
  second placement, not a second thing.
- **Does this need an ADR?** A shared visual component with defined
  states is a durable decision that later features must not re-derive —
  which is the exact failure ADR 0054 was written to stop in the decode
  path. Recommendation: yes, once the prototype settles.

## Exit criteria (draft — firm at grooming)

- A prototype exists, is reviewed with the owner, and is deleted by the
  phase that implements it.
- One shared chip component with a defined state vocabulary; no
  per-panel copy.
- Every converted control is a state, not a command.
- Task 101's bus health chip is built from it rather than beside it.

## Status log

### 2026-08-21 — (branch `task-103-toolbar-status-bar`)

Implemented, on the two accepted prototypes, and both are deleted.
Frontend suite 2525 → 2580 passing (190 → 196 files); no Rust touched.

What landed, in order:

1. **`StatusChip.tsx` + `.status-chip*`** — one shared chip, the colour
   chip's shape (2px radius over a `--border-wash` hairline, rounded
   square indicator), with the five-state vocabulary carried on the
   outline alone. A test asserts no `[data-state]` rule changes a
   border weight, a padding or a width, which is what "uniform width"
   actually needs.
2. **`summarizeConnection`** (in `connectionStates.ts`) — the host's
   per-bus map folded over the buses that carry a binding, with the
   per-bus tooltip built from `describeAppliedConfig`.
3. **`statusBarFit.ts`** — the drop/collapse policy as pure arithmetic.
4. **`statusMetrics` / `statusMetricsTooltip`** (in `statusLine.ts`) —
   the numbers come out of `splitStatus` as an ordered list; the resting
   line now says only what is *happening*, and the DBC count is gone.
5. **`BusHealthLauncher.tsx`** — the icon launcher.
6. **`StatusBar.tsx`** — the bar, its measurement, and the overflow menu.
7. **`rbsAttention.ts`** — the RBS mapping chip's project-wide count.
8. **App wiring** — the toolbar loses Connect, System messages and View
   signals; the bar replaces the `.status` div; README + ADR 0055.

**Rulings implemented as written**: connection control in the bar,
uniform chip width sized to the longest state, outline carries state,
metric order and right-to-left drop, tooltip on the metric labels
replacing the one blob title, three pinned chips pushed into a menu
from the right badged with the sum of what is inside it, notices keep
their buttons, DBC count gone, clock offset stays out, no
`overflow: hidden` on the bar, no footer.

**How the narrow-bar behaviour was tested.** `statusBarFit.test.ts`
drives the width down and back up over a fixed set of item widths and
reads off what disappeared; `StatusBar.dom.test.tsx` stubs each
element's measured width in jsdom and resizes the bar through a
controllable `ResizeObserver`, asserting the surviving metrics by id
and the pinned-vs-collapsed split, then widening again. Both were run
against a deliberately broken control (a non-alternating removal order;
a bar that ignores the fit) and 5 and 4 tests respectively failed, so
the assertions discriminate.

**The removal order is the one the prototype's own three widths
imply**: rightmost metric, rightmost chip, next metric, alternating.
That sequence reproduces the prototype's *tighter* bar (cache and RAM
dropped, RBS collapsed) and its *narrow* bar (only `f/s` and bus load,
all three chips collapsed) exactly; "all metrics first, then chips"
reproduces neither.

## Blockers / side effects

- **Bus load has no source.** The metric's slot and its place in the
  drop order are implemented and unit-tested; `statusMetrics` takes
  `busLoadPercent` and the app passes `null`, because nothing reports
  it. Task 101 fills it in with one argument.
- **The bus-health launcher is built but not mounted.** `StatusBar`
  takes a `busHealth` prop and renders the launcher when given one; the
  app passes nothing, because there is neither a host-side bus-health
  model to feed it nor a panel for it to open. A permanently neutral,
  permanently unpressable icon in the bar would be decoration rather
  than a readout, so task 101 mounts it — one prop.
- **The RBS chip's destination is only unambiguous with one config.**
  The accepted resolution ("combining is fine for reporting and
  forbidden for editing") is implemented for the *reporting* half: the
  badge counts problems across every `.cannet_rbs` the project has
  open. The *view* it should open — every config's problems listed
  together, naming which config each belongs to — does not exist. With
  exactly one config the chip opens that config's signals grid, which
  is unambiguous; with none or several it reports and its tooltip says
  why it cannot navigate. Building that combined view is task 89's
  shape to define, not this task's to invent.
- **Pressing the chip while connecting disconnects.** The prototype's
  state table left this "undecided". A connect that never lands has no
  other way out, so the chip stays pressable and cancels. Recorded
  rather than assumed settled.
- **The RBS count is summed in the frontend, not the host.** The grid's
  display status is deliberately a frontend decision (Out of Range is
  decided by `rbsSignalsFilter`, by grooming resolution), so a
  host-side count would be a *different* number from the one the panel
  shows. Reusing the frontend rule over the host's rows keeps the badge
  and the panel in agreement, which is the stronger constraint; the
  refresh is event-gated, never polled.
- **Not done, not asked for.** The seven `Add …` buttons are untouched,
  as the prototype says.

## Exit criteria — verdicts (2026-08-21)

| criterion | verdict | earned by |
|---|---|---|
| A prototype exists, is reviewed with the owner, and is deleted by the phase that implements it | **met** | both accepted prototypes deleted in the landing commit; `bus-health.html` left for task 101 |
| One shared chip component with a defined state vocabulary; no per-panel copy | **met** | `StatusChip.dom.test.tsx` — "carries its state on the element, for every state in the vocabulary", "carries every non-idle state on the outline alone" |
| Every converted control is a state, not a command | **met** | only Connect, System messages and View signals moved; `StatusBar.dom.test.tsx` — "presses the connection chip through to its action", "does not offer a press when the project binds no interface" |
| Task 101's bus health chip is built from it rather than beside it | **met in the part this task owns** | `BusHealthLauncher.dom.test.tsx` — the control exists, is the launcher shape the owner accepted, and `StatusBar` takes it as a prop; task 101 supplies the model and the panel |
| (grooming recommendation) an ADR once the prototype settles | **met** | [ADR 0055](../../docs/adr/0055-status-chips-and-the-status-bar.md) |
