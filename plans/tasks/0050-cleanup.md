# Task 50 — Cleanup and Usage Fixes

Loose ends carried out of task 48, plus a further round of defects and
small features found by using the app.

They share no design and gate nothing. Land them independently, one
commit each, and strike each as it goes.

## 1. Show progress while a cold signal cache builds

Carried from task 48 item 2. **Decided: show progress.** Not warming the
pyramids on reload, and not persisting a manifest.

After a disk-cache reload the decimation pyramids are cold, so the first
`sample_signals` for a given signal set builds them on demand — seconds
on a real capture. This is by design: a pyramid is derived state that
carries no reopen manifest, and `SignalCacheStore::new` wipes its root on
every launch (`apps/gui/src-tauri/src/signal_cache.rs`), so it is rebuilt
by re-decoding the reopened raw frames. **That design is not changing** —
persisting a manifest would have amended ADR 0002 and put a correctness
burden on reopen, and warming only helps signals a restored panel names.

So the wait stays; what changes is that the user can see it. A plot area
waiting on its first sample must say so rather than showing a blank
canvas that is indistinguishable from "no data" or "hung".

**Decided: an indeterminate indicator, gated behind a short delay.**
Frontend only — no host-side progress reporting, no new IPC. A
determinate percentage was rejected because the host discovers the work
while decoding rather than knowing it up front, so it would have to grow
a progress channel to answer "how much longer"; that cost is not worth it
for a wait the user is not blocked by.

The delay gate is the load-bearing half, not a refinement: because this
fires on **every** signal add against a large buffer (see below), an
indicator with no threshold would flash on sub-100 ms adds and read as
jitter rather than information. Only an area whose first sample has not
landed within roughly 300 ms should say anything.

Two facts from task 48 item 12's profiling that bear on the design:

- **Host latency is not on the UI thread.** In a CPU profile of the
  shipping app under a heavy plot, `fetch` — every host round-trip the
  panel makes — was 0.6 % of the main thread. So the window stays
  responsive throughout; the progress indication is about informing, not
  about unblocking.
- **The first fetch after *any* signal-set change is a whole-window
  one.** Changing an area's signal list re-anchors `useDecimatedRange`'s
  cache, which clears `base` — and with no `base` the request carries
  `fromSeconds`/`toSeconds` of `null`, i.e. the whole window at full
  point budget. So adding one signal to an N-signal area pays a cold
  whole-window sample of all N + 1. That means this indication fires on
  every signal add against a large buffer, not only after a reload.

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

**This reverses a shipped default.** Task 48 item 3 made raw integer bit
fields render as hex everywhere — trace rows, the signal view, the DBC
panel's value column. The new rule: **base-10 by default**, with hex
available per signal for the fields where it actually helps (ids,
serials, bitmasks).

The classification work all survives — `value_is_raw_integer` and
`is_raw_field` still identify which signals are eligible. What changes is
what happens to an eligible signal by default, and that there is now a
per-signal choice on top.

The unconditional half of item 3 is **not** affected: an exact integer
still never renders in scientific notation. That was the original
complaint (a `uint64` reading as `1.235e+18`) and base-10 answers it just
as well as hex did.

### Where the per-signal flag lives

A DBC extension is the right instinct and **not** a last resort — it is
what ADR 0010 asks for, and cannet already defines its own `BA_`
attributes (ADRs 0027 and 0028). Per-signal `BA_ "<name>" SG_ <id>
<signal> <value>` attributes are **already parsed** and bucketed
per-signal by `cannet-dbc`. Reading one costs almost nothing.

**The obstacle is writing, not reading.** `can-dbc` has no serialiser —
the DBC stack is parse-only. ADR 0029 hit this exact wall for colour maps
and put them in the project file instead. So:

- **Honouring a `BA_` attribute the DBC already carries** works today. A
  hand-edited DBC, or one emitted by whatever generates it, can mark a
  signal hex and cannet will respect it. This is the cheap, correct,
  ADR-0010-aligned half.
- **Setting it from the UI** needs either a DBC writer (a real piece of
  work, and a destructive one — rewriting a user's DBC) or a
  project-side override that does not travel with the DBC.

Note the situation differs from ADR 0029's. There, `BA_` was *structurally*
incapable of carrying the data (it cannot attach to individual `VAL_`
entries), so the project file was the only home. Here the mechanism fits
the data exactly and only the write path is missing — which argues for
reading the attribute now rather than declaring the DBC unusable.

**Decided: read-only, exactly like the existing custom attributes.** No
DBC writer, no project-side override, no UI for setting it. A DBC author
writes the attribute; cannet honours it. Absent means base-10.

Name and grammar, following `CannetCounter` / `CannetCrc` (per-signal,
`STRING`, empty means unconfigured):

```text
BA_DEF_ SG_ "CannetDisplay" STRING ;
BA_DEF_DEF_ "CannetDisplay" "";
BA_ "CannetDisplay" SG_ 291 SerialNumber "radix=hex";
BA_ "CannetDisplay" SG_ 512 LeakCurrent "scale=log";
```

**`CannetDisplay` is a display-mode slot, not a radix flag**, and takes
the same `key=value;key=value` grammar as `CannetCounter` and
`CannetCrc` — so further simple modes get a home here rather than each
earning its own attribute.

**`radix=hex` is the only key this task implements.** `scale=log` is
shown above as the shape of a future key, and it is *not* in scope here —
see the interaction below before adding it. An unrecognised key or value
is a parse warning and falls back to the default rendering, matching how
`CannetCounter` handles a bad value, so a DBC written for a later cannet
stays readable by an earlier one.

`radix=hex` on a signal that is not raw-integer eligible (it has a unit,
a scale factor, or a `VAL_` table) should warn rather than silently do
nothing — a DBC author who wrote it meant something by it.

### `scale=log` collides with item 9 — resolve before implementing it

Item 9 makes log scale a property of an **axis**, on the explicit
reasoning that a log scale changes how a range maps to pixels and every
series on that axis shares it. `CannetDisplay scale=log` would make it a
property of a **signal**. Both cannot be the authority.

The case that breaks: two signals share a unit, so `per-unit` mode puts
them on one axis; one declares `scale=log` and the other does not. The
axis has to be one or the other.

`radix=hex` has no such problem — a radix is per-value, so signals on a
shared axis can render differently without contradiction. That asymmetry
is why only `radix` ships here.

A plausible resolution, not decided: the DBC value is a **default** that
seeds an axis when nothing contradicts it — unambiguous in `individual`
mode where an axis is one signal, and in `per-unit` when every signal on
the axis agrees — with the project's own per-axis setting (item 9) always
overriding, and a mixed axis warning and staying linear. Settle it when
`scale` is actually added.

### This needs an ADR — write it with this item

**New ADR 0043 (next free number): cannet's DBC custom attributes, and
where display authority lives.** Three things it has to settle, none of
which is written down today:

1. **The `Cannet*` attribute namespace, and that it is read-only.**
   `CannetCounter` and `CannetCrc` exist, but only inside ADR 0027 as
   part of calculated fields — nothing states that cannet has a namespace,
   what the convention is, or that cannet never writes a DBC (it can't:
   `can-dbc` has no serialiser, and rewriting a user's DBC is destructive
   besides). Every future attribute needs that stated once.

2. **The DBC-versus-project test.** The rule already exists, but only
   scattered through three rejected-alternatives sections: ADR 0028 —
   "right home for the calculated-field *designation*, wrong one for
   per-simulation values and cadence: those vary per rig and would churn a
   shared DBC"; ADR 0029 — colour maps to the project, partly because
   `BA_` structurally cannot attach to a `VAL_` entry; ADR 0027 — the
   designation itself belongs in the DBC. Stated positively: **a fact
   about the signal itself goes in the DBC; a fact that varies per rig,
   per session, or per user goes in the project.** `radix=hex` passes —
   a signal being an opaque bit pattern is intrinsic to it.

3. **Precedence, and the per-value / per-axis asymmetry.** When both the
   DBC and the project speak, the project wins. And a display fact that
   is *per value* (radix) can safely be a signal property, while one that
   is *per axis* (log scale) cannot, because signals sharing an axis
   share it. That asymmetry is the thing a future contributor will
   otherwise rediscover by shipping `scale=log` and finding it
   contradictory.

**Amend ADR 0026** in the same change: it governs per-unit axes and must
record that log scale is an axis property and that a DBC hint never
overrides an explicit per-axis setting.

ADR 0027 keeps its attributes; it gains a pointer to 0043 as the general
rule it was the first instance of.

**Document it with the others.** cannet's custom attributes are
currently spelled out in ADR 0027 and in `README.md` (the calculated
fields section carries a worked `BA_DEF_` / `BA_` example). Both get the
new attribute in the same commit. The full set is small enough that the
README block is the natural place for it to stay complete — if it grows
much past this, it wants its own reference page.

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
