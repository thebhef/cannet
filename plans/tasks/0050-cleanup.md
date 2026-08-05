# Task 50 — Cleanup and Usage Fixes

Loose ends carried out of task 48, plus a further round of defects and
small features found by using the app.

They share no design and gate nothing. Land them independently, one
commit each, and strike each as it goes.

## 1. Show progress while a cold signal cache builds

**Done.** An area waiting on the first sample for its signal set draws an
indeterminate `building…` overlay over its canvas. Frontend only — no
host-side progress reporting, no new IPC, and the cold-pyramid design
(`SignalCacheStore::new` wipes its root every launch) is unchanged.

**Where the pending state lives: a new
`apps/gui/src/useFirstSampleWait.ts`**, a view-local hook holding one
boolean and one timer. It is armed by the *signal set*, not the area:
`PlotArea` passes `signals.length > 0 ? signalSetKey : null`, so a
changed set re-arms and an empty area arms nothing. `PlotArea`'s
`resample` calls the hook's `settled()` immediately after the
`outcome.kind === "pending"` early-return — past that point the area
knows what it holds, and `settled()` disarms until the set changes
again. That one call site covers `empty`, `unchanged` and `sampled`.

**Threshold: 300 ms** (`FIRST_SAMPLE_INDICATOR_MS`). The gate is the
load-bearing half — the first fetch after *any* signal-set change is a
whole-window one (the re-anchor clears `useDecimatedRange`'s `base`, and
with no `base` the request carries `fromSeconds`/`toSeconds` of `null`),
so this path fires on every signal add and an ungated indicator would
flash as jitter.

**How it is distinguished from "no data":** three states, three
renderings. *No signals* — the side panel's existing "pick a signal
above" empty state, and the gate is never armed (`null` key). *No data* —
the `empty` outcome settles the wait, so a collapsed window draws a bare
canvas exactly as before. *Not yet* — the overlay, and only after the
gate. Indeterminate rather than a percentage because the host discovers
the decode work while doing it; and the round-trip costs the UI thread
nothing (0.6 % of the main thread in task 48 item 12's profile), so this
informs rather than unblocks.

**Presentation:** `.plot-area-building` — a sliding chip on a 6 rem
track plus italic muted `building…`, matching `.plot-area-empty`'s
muted-italic idiom and the panel's `#4ecbff` accent. Absolutely
positioned over the canvas column (`.plot-area` gains `position:
relative`; the side panel's width is excluded by an inline `right`), so
nothing reflows when it clears, and `pointer-events: none` keeps the
canvas's gestures. It is the repo's first `@keyframes`, so it carries a
`prefers-reduced-motion` opt-out.

Tests: `apps/gui/src/useFirstSampleWait.test.tsx` — six fake-timer cases
(nothing under the gate, indication after it, cleared on arrival, no
signals never arms, a changed set re-arms, emptying the area clears).
Wiring is covered by two `PlotPanel.dom.test.tsx` cases over a stalled
`sample_signals`; both failed before the change. The stall fixture now
parks its resolver so a test can let the slow fetch *finish* — a fresh
fetch could not, since the in-flight one holds the area's resample guard,
which is exactly what the real slow sample does.

## 2. Restore the commit gate — surgically

The full test suites were dropped from `.pre-commit-config.yaml` so a run
of small fixes would not pay a whole-workspace test run per commit.
`cargo test --workspace` is gone and the frontend hook runs `pnpm build`
without `pnpm test`. CI still runs both per-PR, so nothing is unguarded —
but the local gate is weaker than it reads.

**Restore it surgically. Do not revert.** A blanket `cargo test
--workspace` on every commit touching a `.rs` file is what made this
worth removing; putting it back reintroduces the problem. The gate should
run the smallest set of tests that could actually be broken by what is
staged.

Directions worth taking, to be measured rather than assumed:

- Scope the Rust run to the crates a commit touches, rather than the
  workspace.
- `cargo nextest`, which parallelises and reports better than `cargo
  test` — a technology-inventory decision, so record it either way.
- `cargo clippy --all-targets` is already in the gate and already builds
  every target, so the marginal cost of running the tests may be only
  linking and execution. Measure that before assuming a test run is
  expensive.
- The same question for the frontend: vitest over changed files versus
  the whole suite.

The comment in `.pre-commit-config.yaml` explaining the trade-off must
match what the hooks actually do when this lands.

## 3. The shared-x-window plot test is flaky

**Fixed — the test was at fault, not the coalescer.** rAF was already
under test control (`captureFrames`); what raced was a *different* real
timer. Each `PlotArea` schedules a one-shot post-mount uPlot rebuild 250
ms after it mounts (`PlotArea.tsx`), and the three areas mount at three
different instants. The test captured uPlot instances and then asserted
against those objects, so a run slow enough to straddle one area's timer
found that area's instance deregistered and silent — which reads exactly
like "the panel slid one area's window and not another's".

Evidence: injecting a delay into the assertion window turned the flake
into a function of elapsed wall clock. At 0–120 ms all three captured
instances were live and each recorded the one coalesced slide (pass); at
140–160 ms Area 1 alone had been rebuilt and its captured instance
recorded nothing, failing at `expect(last[1]).toEqual(last[0])` with
`expected { min: +0, max: 1.7 } to deeply equal undefined` — the
reported failure; at 200 ms all three had been rebuilt, every instance
was silent, and the test **passed vacuously** (`undefined` equals
`undefined`). The uPlot instance count rose 8 → 9 → 11 across those three
delays, and a staleness check on the captured instances read
`[false,false,false]` → `[true,false,false]` → `[true,true,true]`. The
fan-out itself did exactly one slide in every run, at every delay.

Changed: the test now waits the post-mount rebuild out (it fires once per
area) before capturing instances, so the captured ones are final and no
later delay can move them; and each area must record **at least** one
slide as well as at most two, which closes the vacuous-pass direction.
No production code changed.

Verified: with the delay injection still in place the fixed test passes
at 0/60/150/200/400/800 ms — the whole range that previously broke it.
Then, uninstrumented: 20 consecutive green runs of the test, 3 green runs
of the whole file under 48 competing CPU burners, and a green full
frontend suite (102 files, 1086 tests) plus `pnpm build`.

## 4. Constant signals still get a degenerate plot scale

**Fixed.** Task 48 item 8 had let a constant's degenerate extent
(`hi === lo`) into its unit group's union, which fixed a constant
*sharing* a group; a group whose whole union had no span still fell to
the renderer's midline fallback and drew on a bare 0.0–1.0 axis.

**Rule implemented: a group whose whole union has no span is widened to
±10 % of that value, centred on it. At exactly zero the proportional
band collapses, so the fallback is an absolute ±1** — there is no
magnitude to take a fraction of, and ±1 keeps the axis in the signal's
own units rather than inventing one. The trace still sits mid-canvas
(that part was never wrong); what changes is that the tick labels now
read `2700 A / 3000 A / 3300 A` instead of `0 / 0.5 / 1`.

**Where it lives:** `groupScaleRanges` in `apps/gui/src/plotData.ts` —
the pure helper that already owns unit-group scale derivation. Widening
happens on the **group union**, not per signal, so a constant sharing a
group with a moving signal still takes the plain union (a union with a
span is a measurement and is left alone) and task 48 item 8's behaviour
is unchanged. `PlotArea`'s midline fallback now covers only a signal
with no range at all — nothing decoded yet — which is still what keeps
the normalise free of a divide-by-zero.

**ADR 0026 changed**, in the same commit: it recorded "Only when a
group's *whole* union has no span does the midline fallback apply",
which this makes false. It now carries a fourth refinement stating the
±10 % rule, the ±1 zero fallback, and that the widening is on the union
rather than per signal.

Tests: `groupScaleRanges` unit tests for the constant, negative-constant,
zero and shares-a-group-with-a-moving-signal cases
(`apps/gui/src/plotData.test.ts`), plus two `PlotPanel.dom.test.tsx`
tests asserting the axis *labels* — the only place the settled scale is
observable, since the normalised data reads 0.5 either way. Both DOM
tests failed with `["0", "0.5", "1"]` before the fix.

## 5. Collapsible sections in the project view

**Done.** All six sections fold from their headers, and the Elements
section's contents are grouped by element type with each group folding
the same way. Both assumptions held: state persists in the workspace
scope, and the grouping replaces the flat list rather than toggling
against it.

**Persistence: the dockview panel params.** No new IPC, no new
`state.json` key, no host change. `ProjectPanel` writes
`api.updateParameters({ …, collapsed })`, so the set rides the layout
blob — which the workspace scope persists as `layout` in the project's
`.cannet/state.json` (ADR 0042 §3, `SCOPES` in
`apps/gui/src-tauri/src/state.rs`) and which `gatherProject` also
embeds in the project file. That is literally "alongside the rest of
the layout", and it is the panel-local idiom already in use: the DBC
panel's expanded-node set, the system-messages source filter and the
graph's node positions all persist exactly this way. Adding a `UiState`
field would have been a second channel for the same class of fact.

Stored **sparsely** — the ids of what is *folded*, so a panel nobody
folded persists nothing and a fresh panel opens fully expanded. Ids are
stable strings (`project`, `elements`, `buses`, `virtual-buses`,
`connection`, `dbc`, and `elements/<kind>` for the groups), not the
header text, so rewording a header cannot silently unfold everyone's
panel. A junk value in the params is filtered out rather than thrown on
— nothing upstream validates the blob.

**Grouping order: the declaration order of `elementKindLabel`** —
Trace, Plot, Signals, Transmit, Filter, RBS, Color Map. Registry order
is kept *within* a group. The order lives in a `Record<
ProjectElementKind, number>` rather than an array so a new element kind
is a compile error there, matching how `elementKindLabel` itself is
kept exhaustive. Only kinds with elements get a group; the "No
elements." empty state is unchanged.

**Consequence: `ElementRow` no longer prints the kind.** The group
header carries it, and a fixed 4.5rem `TRACE` column repeated under a
`TRACE` heading is exactly the width this panel does not have.
`.project-element-kind` went with it.

**A11y: button-in-heading with `aria-expanded`.** The `<h3>` / `<h4>`
stays, so the panel keeps its heading outline, and the toggle inside it
is the disclosure control. The caret is a `▾` / `▸` glyph swap in an
`aria-hidden` span — the repo has no rotate-chevron anywhere (RBS,
transmit, the graph filter node and the trace rows all swap glyphs),
and `aria-expanded` already carries the state. The body is unmounted
rather than CSS-hidden, matching `RbsPanel`.

**Task 48 item 5's scroll fix is untouched**: `.project-panel` keeps
`height: 100%` + `overflow: auto` as its first rule, so
`dockPanelScrolling.test.ts` still reads it, and folding only removes
children — it can shorten the scrolled content, never un-bound it.

Tests: `apps/gui/src/ProjectPanel.collapse.dom.test.tsx` — twelve cases
over fold/unfold, the params write (including the key coming back out
on unfold), restore-from-params, an unmount/remount round-trip through
the written params, junk tolerance, group order, per-group folding, and
the outer section folding over its groups. Eleven of the twelve failed
before the change. It is also the first test to render the whole
`ProjectPanel`, which needed stubs for `containerApi` and the sidecar
status command — the reason the existing file only ever rendered leaf
components.

## 6. Rename should rename in place

**Fixed.** `panel.rename` no longer maps to `showProjectPanel`; it
records the focused panel's dockview id as the rename target, and that
panel's own tab renders an input in place of its title.

**Where it lives:** a new `RenamableTab` (`apps/gui/src/RenamableTab.tsx`)
replaces `DockviewDefaultTab` as the dock's `defaultTabComponent` — it
renders the untouched default tab unless its panel is the target, so
middle-click-to-close and every other tab behaviour is unchanged. The
target is held in `useCommands` and published through
`RenameTabContext` (same shape as the existing `PanelCommandsContext`
wiring); the tab clears it on commit or cancel.

**No second rename path.** The edit writes `registry.update(id, { name })`
— the same mutation the project panel's inline rename performs — and
`App`'s existing title-lockstep effect carries the new name into the tab
title, the graph and the go-to-view palette. ADR 0019 already allowed
this ("other views may add inline-rename affordances later, but the
project panel is the canonical edit surface"), so no ADR changed.

**Semantics match the one existing inline-edit precedent** (`EventRow`
in `TraceView.tsx`): Enter commits, Escape reverts the draft and exits,
blur commits, an empty box reverts rather than clearing the name.

**Command context.** The command was ungated (offered everywhere, doing
nothing useful anywhere) — the `focusedPanelKind === "project"` predicate
in `commands.test.ts` is a local fixture in a binding-conflict test, not
the shipped spec. It is now gated to the panel kinds whose title is a
model-owned name: trace, plot, signals, transmit, rbs, colormap. That
required adding `colormap` to `FOCUSED_PANEL_KINDS` and
`panelKindForFocus` — an element-backed panel that could hold focus but
reported `null`, so no context-gated command could ever see it. The
keybinding path is unchanged (the command has no default chord; the
palette is the entry point).

Tests: `apps/gui/src/App.renameInPlace.dom.test.tsx` runs the command
through the real palette against the real App and asserts the tab enters
edit mode inside the still-active group (not the project panel's),
that Enter writes the name through to the project panel's own input,
and that Escape leaves it alone; plus a `commands.test.ts` case for the
context gate. Both DOM tests failed before the change with "tab did not
enter rename mode".

## 7. Audit every view for scroll correctness

**Confirmed symptom, and it is a known-unfixed defect.** Reviewing
captured (not live) data in the chronological trace, the last rows cannot
be reached: scrolling to the bottom stops short. That is precisely what
task 48 item 5 fixed in the by-ID panel — `maxAnchorRow` subtracts
`visibleRowCount`, whose two-row pad puts the anchor bound two rows
*past* the end — and explicitly did not fix here, on the grounds that the
chronological view's anchor interacts with auto-scroll and
`scrollForRow`. The same presentation was meant to be fixed alongside it.
So: apply `tailAnchorRow` here too, and deal with the auto-scroll
interaction that was the reason for deferring.

**Then widen it.** Scroll defects have now been found in the project
panel, the by-ID panel, the colormap panel, the trace table's horizontal
axis, the system messages view, and now the chronological trace — six
surfaces, four distinct mechanisms. That rate says the next one is not
far off. **Review every scrollable view**, and answer the question the
count raises: is there a base implementation — a shared scroll container
or viewport primitive — that would satisfy them all, rather than each
panel getting its geometry right independently?

If such a primitive exists, adopting it is the deliverable and the
individual fixes fall out. If it does not, say why in the record, because
the next reader will ask the same question.

Method is settled: jsdom does no layout, so measure in Chromium against
the real stylesheets or the live WebView2 host. Every one of the four
mechanisms found so far turned out not to be what the CSS suggested.

## 8. Put the version and project in the title bar

**Done.** The title reads `<project> — <capture source> — cannet
<version>`, with a `•` prefix while there are unsaved changes and the
capture segment omitted when nothing is loaded — the decided format,
unchanged.

**Mechanism.** The app already had the wiring: `windowTitle`
(`apps/gui/src/windowTitle.ts`) is a pure builder and an `App` effect
pushes its result through `getCurrentWindow().setTitle`. Both were
widened rather than replaced — no new IPC, no `document.title`, no
custom title bar.

Where each fact comes from:

| Segment | Source |
| --- | --- |
| Project name | `projectPath` state, basename minus its last extension (unchanged) |
| Unsaved `•` | `App`'s `dirty` — the flag the project view's `●` marker and the close prompt already read |
| Capture source | new pure `captureLabel(state, remoteSessions)` in the same module |
| `cannet <version>` | `app_version`, the host command the About panel reads; fetched once per session |

`captureLabel` gives a **live session priority over a loaded BLF**, the
same precedence `splitStatus` applies in the status line. A session
reports its one subscribed interface's `display_name`, or `N
interfaces` when it carries several (the status line's existing
phrasing); with none running it falls back to the BLF's basename while
the log is loading, streaming or done. The version is `git describe`
output, so a leading `v` is stripped (`v0.9.3` → `0.9.3`) and the rest
kept verbatim; an empty version drops the segment rather than showing a
placeholder.

**One deviation, recorded rather than fixed:** the close prompt treats
"unsaved" as a dirty project **or** any dirty `.cannet_rbs`, and the
RBS half is only knowable by calling `rbs_dirty` — the host publishes no
event for it and the frontend holds no reactive mirror. The title
therefore tracks the project `dirty` flag, exactly as the project
view's own `●` marker does. Making the title cover RBS too means giving
that fact a reactive home, which is host work and not this item's.

**The About panel is unchanged** apart from a stale comment: it said the
native title bar carries only the project name, which this makes false.

Tests: `apps/gui/src/windowTitle.test.ts` covers all five documented
states plus the version-prefix and empty-version edges, and
`captureLabel` across idle / streaming / done / errored / one interface
/ several / live-beats-BLF. `apps/gui/src/App.windowTitle.dom.test.tsx`
mounts the real App with `setTitle` spied and asserts the settled title
carries the mocked host version — and the `•`, since seeding the default
layout already marks the session dirty. Both failed before the change.

## 9. Manual y-axis control from a right-click menu on the axis

**Specified — no open questions.** Settings key off `DerivedAxis.id`
(the mechanism `axisWeights` already uses), are stored sparsely — an
entry only where the user overrode a default — and retire when their
signals leave the plot. Log scale hides the min box rather than
validating one, and drops non-positive points. Fit Y returns an axis to
automatic. The remaining small defaults (either bound settable alone, a
manual bound beating follow-live, enum lanes offering none of this) are
stated below and can be corrected in review.

Right-clicking a y axis opens a context menu offering **a min, a max,
and a log-scale toggle**. **Min and max default to empty, and empty
means the autoscaling we already do** — including item 4's minimum range
for constant signals. So this adds an override, it does not replace the
existing behaviour, and a user who never opens the menu sees no change.

Log scale arrives here from task 23, where it sat under "manual
per-series y" alongside offset and gain. It belongs on the axis instead:
a log scale changes how a range maps to pixels and every series sharing
the axis shares it, whereas offset and gain transform one series and stay
in task 23. All three of min, max and log scale are also how a user
reaches for the same thing — "control this axis myself" — so they belong
in one menu.

Log scale brings its own rules that min/max do not:

- **Enabling log hides the min box.** A log axis cannot render zero or
  negatives, so rather than accepting a min and then rejecting it, the
  min simply stops being user-settable and is derived — the smallest
  positive value present. Max stays settable. Turning log back off
  restores the min box and whatever value it held.
- **Non-positive points are not displayed on a log axis.** Decided, not
  assumed. They are dropped rather than clamped: clamping invents a
  value, and a clamped point sitting on the axis floor reads as a real
  reading. A series whose values are entirely non-positive therefore
  draws nothing on a log axis — the UI should say so rather than show an
  empty axis. Reopen this only if someone brings a concrete case for
  different behaviour.
- **Auto-derived bounds change meaning** — a log axis wants decade-ish
  bounds, not the linear padding the current auto-norm applies.

Note for whoever implements: `plotPanelConfig.ts` already tolerates a
`yMode` field from v7-and-earlier panels, ignoring it on parse and
dropping it on save — a previous fixed-range attempt. Old projects may
still carry one, so decide whether it is honoured, migrated or still
discarded, and update that comment either way.

**This reverses a documented invariant.** `PlotAreaConfig.yAxisMode`'s
rustdoc (`apps/gui/src/plotPanelConfig.ts`) currently ends "Y scales are
always auto-derived (no fixed-range option)." That sentence becomes false
and changes in the same commit, as does anything ADR 0026 says to the
same effect.

**Task 23 keeps offset and gain**, which transform a series rather than
the axis. Neither task should implement the other's half.

**Settings are stored one per y axis, keyed by `DerivedAxis.id`** — and
that mechanism already exists, so this is not new design.

An area does not have a fixed number of axes: the glossary is explicit
that "a plot area renders as one or more axes" and warns against using
the two words interchangeably. An area holding two current signals and
one voltage signal has **one** axis in `unified`, **two** in `per-unit`
(A and V), and **three** in `individual`. In `unified` — the default —
the single axis's id *is* the area's id, which is why area and axis feel
like the same thing most of the time.

`deriveAxesForArea` already mints a stable id per axis for exactly this
purpose: `areaId` in unified, `${areaId}/u:unit:<unit>` and
`${areaId}/u:enum` in per-unit, `${areaId}/i:<signalKey>` in individual.
Its rustdoc says the id exists so an axis's persisted weight survives
lane-membership churn, and `axisWeights` is already stored against it.
Manual ranges and the log flag ride the same key.

**The dict is sparse: an entry exists only where the user has overridden
the default.** An axis that is autoscaling and linear has no entry at
all, so a project that never touches the menu persists nothing new, and
clearing the fields deletes the entry rather than storing "empty".

**Signals sharing an axis share its scale.** That is what a unit group
*is* — two amps signals on the `per-unit` amps axis are governed by that
axis's one entry, not by two per-signal settings. Only `individual` mode
gives a signal its own axis and therefore its own entry.

**Lifetime: keep an entry while its signals are still in the plot; drop
it from the dict when they are removed.** Not dropped on a mode change —
the ids regenerate identically, so switching to `individual` and back to
`per-unit` restores the amps axis's range rather than losing it. What
retires an entry is the signals going away, which is also what makes the
axis stop existing.

Pruning has one wrinkle worth getting right: in `per-unit` an axis is a
*unit group*, so its entry survives while any signal of that unit
remains and retires when the last one leaves. In `individual` the axis
is one signal, so removal of that signal retires it directly.

Assumptions taken rather than asked; correct them if wrong:

- **Either bound alone is allowed.** Setting only a max leaves the min
  autoscaling. Requiring both would make the common case ("clamp the top,
  I don't care about the bottom") a two-field chore.
- **A manual bound wins over everything automatic** — follow-live
  auto-norm and the visible-fit path both defer to it. Otherwise the
  value silently stops applying the moment the capture grows.
- **Fit Y clears a manual range rather than writing numbers into it.**
  An earlier draft had Fit Y seed the fields with what it fitted, which
  reads well in isolation but contradicts the sparse-dict rule: pressing
  Fit Y once would silently convert an autoscaling axis into a pinned
  one, and every axis the user ever fitted would start persisting an
  entry. Under sparse storage "Fit Y" and "clear the fields" are the same
  intent — go back to automatic — so they should do the same thing.
- **Enum lane axes are excluded.** A lane's geometry is assigned by
  `laneBandsForVisible`, not by a value range, so neither min/max nor a
  log scale means anything there — the menu should omit them rather than
  offer something inert.

## 10. The plot's value formatting ignores what kind of signal it is

The plot signal area shows values to around ten decimal places. The
formatter behind it, `fmtVal` (`apps/gui/src/plotPanelConfig.ts`), is
`v.toPrecision(6)` — six *significant* figures, which on a small value
means many decimals (`0.0000123000`) and on an exact half means padding
(`0.500000`). It knows nothing about the signal it is formatting.

**The rule is three-way, by what the signal actually is:**

| Signal | Rendering |
| --- | --- |
| Fixed-precision (a scaled integer, e.g. `factor 0.25`) | fixed, at the decimals the factor implies — `12.25`, never `12.250000` |
| Float (`SIG_VALTYPE_` float32 / float64) | decimal until it would need more than **5** decimal places, then exponential — `0.0001`, but `1e-6` |
| Raw integer bit field | **base-10**, unless its DBC marks it `CannetDisplay "radix=hex"` — item 11 |

The raw-integer classification is not new work: `cannet-dbc` already
computes `value_is_raw_integer`, `is_raw_field` combines it with "no
unit" and "not an enum", and both the trace rows and the signal view
already consume it. The plot simply never got the flag — but note the
*default rendering* for those signals changes in item 11, so land that
first or land them together. Enum signals already render symbolically
and are unaffected.

**What is missing is the fixed-precision fact.** `SignalDescriptor`
carries `unit`, `is_enum` and `value_is_raw_integer`, but **not
`factor`** — so nothing tells the plot that a signal's values are exact
multiples of 0.25 and want two decimals. That has to come from the model
rather than being derived in JS from the factor (CLAUDE.md: domain
computation belongs in the model), which argues for a computed
"decimals" fact on the descriptor rather than shipping `factor` and doing
the arithmetic in the frontend.

Two edges to settle when computing it: a factor with no finite decimal
expansion (`1/3`) is not fixed-precision and falls to the float rule; and
`factor == 1` with a non-zero offset or a unit is fixed at zero decimals
— an integer, but not a raw bit field, so decimal rather than hex.

**There is a second formatter, with a different threshold.**
`fmtTickValue` (`apps/gui/src/PlotArea.tsx`) formats y-axis tick labels
at 3 significant figures and goes exponential below `1e-3` — too eager,
so `0.0001` becomes `1.0e-4` when the digits would have fit. The same
value can therefore read differently in a tick label, a cursor readout
and the signal area. Fix the threshold once and have both use it.

Scope notes:

- **The large-magnitude end is not part of this ask.** `fmtTickValue`
  goes exponential at `1e6`, and `toPrecision(6)` happens to as well.
  Leave it unless changing it falls out naturally.
- **Tick labels may not be able to follow the rule exactly.** They live
  in a fixed 52 px column, so a fixed-precision signal with many decimals
  or a wide hex value will not fit. Ticks may keep a width-driven
  fallback; if they do, say so rather than letting the two silently
  diverge again.
- **Do not unify with `formatSignalValue` in `format.ts`.** It
  deliberately never renders an exact integer exponentially, because a
  digit-exact `uint64` was unreadable as `1.235e+18`. Right there, wrong
  for a tick label. Shared *rules*, not a shared function, unless the
  constraints turn out to line up.

## 11. Raw integers default to base-10; hex becomes a per-signal opt-in

**Done.** Raw integer bit fields render **base-10** everywhere task 48
item 3 made them hex — expanded trace rows, the signal view, the DBC
panel's value column. Hex is now a per-signal DBC opt-in. The
unconditional half of item 3 is untouched: an exact integer still never
renders in scientific notation (`0xDEADBEEF` reads `3735928559`, not
`3.7e+9`).

**The attribute.** `BA_DEF_ SG_ "CannetDisplay" STRING ;`, default
`""`, value a `key=value;key=value` one-liner — the grammar
`CannetCounter` / `CannetCrc` already use (`key_value_pairs` in
`crates/cannet-dbc/src/calc.rs` is now `pub(crate)` and shared). One
key is implemented: `radix=hex`. `scale=log` is **not** in scope and
ADR 0043 records why. Read-only: no DBC writer, no project-side
override, no UI.

Three warnings, all through the existing `Database::parse_warnings`
channel and all leaving the default rendering in place:

| Input | Warning |
| --- | --- |
| unknown key / unknown radix / malformed pair | `<msg>.<sig>: bad CannetDisplay attribute: …` |
| `radix=hex` on a signal with a unit, a scale factor or a `VAL_` table | `<msg>.<sig>: CannetDisplay radix=hex ignored — not a raw integer field …` |
| empty value | none — "unconfigured", same as `CannetCounter` |

**Where the verdict is settled: at parse, once.** `SignalEntry` gains
`display_hex`, set only when the attribute asks for hex *and*
`is_raw_field` passes, so no consumer combines two flags — a renderer
renders what it is told. It rides out on `DecodedSignal::display_hex`
and `SignalDescriptor::display_hex` (the same twin pattern
`value_is_raw_integer` uses), then over the wire as `display_hex` on
`SignalRecord` and `SignalSnapshotRecord`, omitted when false.

**`raw_field` stays and keeps its meaning** — the signal is an opaque
bit pattern rather than a measurement. It no longer decides the radix;
it says the value is a digit-exact integer.

**For item 10:** consume **`display_hex`** for the radix and
**`raw_field`** for "this is an integer, format it as one". Both are
already on `SignalRecord` / `SignalSnapshotRecord`; `SignalDescriptor`
(the plot's `list_signals` catalog) carries `display_hex` and
`value_is_raw_integer` but *not* the combined `raw_field` — the plot
either combines it host-side through `cannet_dbc::is_raw_field(…)` the
way `trace_query.rs` does, or the descriptor grows the combined flag
alongside the `decimals` fact item 10 needs anyway.

**Docs.** New **ADR 0043** — the `Cannet*` namespace and its
conventions, that cannet never writes a DBC, the DBC-versus-project
test (*a fact about the signal itself → DBC; a fact that varies per
rig / session / user → project*), project-wins precedence, and the
per-value / per-axis asymmetry that is why `radix` ships and `scale`
does not. **ADR 0026** gains the axis half: a log scale is an axis
property and a DBC hint never overrides an explicit per-axis setting
(item 9 implements it; this only records the rule). **ADR 0027** gains
a pointer to 0043 as the general rule it was the first instance of.
**README** grows `CannetDisplay` in the calculated-fields `BA_DEF_` /
`BA_` block plus a paragraph on the attribute set, and
`examples/cannet-demo.dbc` carries a real example (`BmsCommand.Crc8`)
so the block is not describing a signal that doesn't exist.

**The large fixture got one too.** `examples/ev-zonal/dbc/zonal.dbc`
gains `PackStateCommand` (id `0x60A`, CentralCompute): a `CannetCounter`
rollover counter and a `CannetCrc` CRC-8/SAE-J1850, with `radix=hex` on
the CRC only — the counter beside it is just as raw a field and stays
decimal, which is the per-signal point. That file is generated, so
`generate_dbcs.py` grew a per-signal `cannet` attribute map that
declares only the `BA_DEF_`s a file actually uses (`pack.dbc`
regenerates byte-identical).

Tests: `crates/cannet-dbc/src/tests.rs` — the attribute read (catalog
and decode sides agree), each bad-value shape, the ineligible-signal
warning on both a united/scaled signal and an enum, and the demo DBC's
example; `tests/ev_zonal_fixture.rs` pins the `PackStateCommand`
example (the fixture loader already asserts a warning-free parse, which
is what proves `radix=hex` landed somewhere eligible). Host:
`wire_signals_flag_only_raw_bit_fields` and
`signal_snapshot_rows_flag_raw_bit_fields` now separate the two flags
(a raw field with no attribute stays base-10). Frontend:
`SignalValueCell.dom.test.tsx` (base-10 default, hex on the flag),
`TraceView.signals.dom.test.tsx` (expanded row, both renderings), and
`SignalsPanel.dom.test.tsx` (the same row with and without the flag).

Noticed in passing, not acted on: `PlotPanel.dom.test.tsx > re-renders
no plot area when only panel-local state changes` failed once in a
full-suite run (`expected 1 to be +0`) and passed in the file alone and
in a repeat full run — a render-count assertion racing a loaded
machine, the same family as item 3. Not touched by this item's change.

## 12. Plot series don't take a changed color

Reported from usage 2026-08-04. Changing a series' color updates the
signal panel's swatch but **the plotted line keeps its old color**. So
the color state propagates to one consumer and not the other — likely
the uPlot series config is not rebuilt (or not applied) on a color-only
change.

**Investigate first, then plan.** Establish where the color lives, which
path the signal panel reads, and why the uPlot series misses the update
(stale series options vs. a rebuild that never fires vs. a memo that
doesn't key on color). Record the diagnosis here before fixing; fix with
a failing test first.

Additional observation (2026-08-04): **closing and reopening the plot
panel is enough to make the new color take effect.** So the color is
persisted and read correctly on construction — the defect is purely that
a live uPlot instance is never told about a color-only change. That
narrows the search to whatever diffing decides when an existing instance
is rebuilt or restyled.

## 13. Rename: palette second stage, and trace-panel field editing

Two usage findings from 2026-08-04, both about renaming. Note item 6
landed in-place renaming via an editable dock tab (this task, branch
`task50/06-rename-in-place`); the first point below **supersedes that
interaction** — reconcile rather than stack a third mechanism.

- **`panel.rename` should collect the name through a second-stage
  command-palette input** — invoke the command, the palette stays open
  and becomes a text input seeded with the current name, Enter applies.
  It must not navigate to the project view. Check whether the palette
  already has a second-stage/argument input; if not, this item adds one.
  Decide what happens to item 6's editable-tab affordance (keep both or
  replace) and record the decision here.
- **Elements in the trace panel, when clicked, should focus** the
  element, **and carry a button that enables editing the field** —
  today editing is not discoverable/reachable where the element is.
  Investigate the current trace-panel element interaction and record
  the intended click/focus/edit model here before implementing.

## 14. RBS enum values commit late, and enum selection costs an extra click

Reported from usage 2026-08-04. In the RBS panel, an enum signal's new
value **does not take effect until the control loses focus** — possibly
true of all value inputs there, check both. And enum selection in
general seems to take **one more click than expected** to have an
effect — across the app, not just RBS.

**Investigate first, then plan.** Find where RBS inputs commit
(blur-commit vs change-commit), whether the extra click is a real event
ordering issue (e.g. focus-then-open, or a select that swallows the
first click), and whether the same pattern exists in other enum
dropdowns. Record the diagnosis and the intended commit model here, then
fix with failing tests first.

## 15. Collapsible sections in the signals view

Requested from usage 2026-08-04, following item 5's pattern in the
project view: the signals (by-ID) view should get collapsible sections.

**Investigate first.** Item 5's subject had six ready-made `<section>`
blocks; the signals view's structure is different (rows grouped under
message ids), so establish what the natural collapse unit is — most
plausibly a message's signal rows folding under its ID row — and record
the intended structure here before implementing. Reuse item 5's
disclosure pattern (button-in-heading, `aria-expanded`, glyph swap,
sparse persisted fold state riding the layout's panel params) rather
than inventing a second idiom. Mind the paged-viewport architecture:
the by-ID view pages over a windowed query, so folding must compose
with the anchor/viewport math (`traceViewport.ts`) rather than assume
an all-in-memory list.

## Exit criteria

- Every item above is fixed or struck with a recorded reason, and this
  file is deleted when the list empties.
- Each fix lands with a test that fails before it — except item 3, whose
  deliverable is a test that stops failing intermittently.
- Item 4 changes ADR 0026 in the same commit if the per-unit axis rule
  needs to say something about constant signals.
- Item 11 lands **ADR 0043** (cannet's DBC custom-attribute namespace,
  the DBC-versus-project test, and display-authority precedence) and
  **amends ADR 0026** for log scale as an axis property. The attribute
  is not shipped without the ADR: `CannetDisplay` is an extension point,
  and an extension point with no written rule is how the next three get
  added inconsistently.
- Item 2 records any new tool in `plans/technology-inventory.md`,
  adopted or rejected.
- Item 7 answers the base-implementation question explicitly — either a
  shared scroll primitive lands and the individual fixes fall out of it,
  or the record says why one does not fit. "We fixed the six we knew
  about" does not close it.
- Where jsdom cannot verify a layout claim, the record says so and the
  claim is backed by a Chromium measurement instead. No test that passes
  either way.
