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

`PlotPanel.dom.test.tsx` — "slides the shared x window once per frame,
not once per area". Timing-sensitive around rAF coalescing.

Seen failing on an unchanged re-run during the settings review pass
(2026-08-03), and again at roughly **2 in 5 full-suite runs** during the
task 48 work — so it is not a once-off, and it flakes often enough to
train people to ignore a red suite, which is the real cost.

**Nobody has established whether the test or the coalescing is at
fault**, and that is the first question: a test asserting a
once-per-frame invariant against a real rAF is a plausible bad test, and
a coalescer that occasionally slides twice is a plausible real bug. Find
out which before changing either.

## 4. Constant signals still get a degenerate plot scale

Task 48 item 8 let a constant signal's degenerate extent (`hi == lo`)
into its unit group's union, which fixed the case where a constant was
dropped from a group that had other signals in it. **A signal that is
constant for the whole plot duration is still wrong**: it draws on a
0.0–1.0 axis with the trace sitting in the middle, which says nothing
about the value.

A constant signal has no span, so any scale is a choice rather than a
measurement. **Give it a minimum range — at least ±10 % around the
value** — so the axis labels read as the value it actually holds.

Decide what ±10 % means for a value of exactly zero, where a proportional
band collapses; that case needs an absolute fallback.

This is ADR 0026 territory (per-unit axes); if the rule it records needs
to say something about constant signals, it changes in the same commit.

## 5. Collapsible sections in the project view

`ProjectPanel` already renders six `<section class="project-section">`
blocks with `<h3>` headers — Project, Elements, Logical buses, Virtual
buses, Connection, DBC. They just do not collapse. Make them collapsible.

Alongside that: **group the Elements section's contents by type** —
trace, plot, signals, and so on. This is sub-structure *within* one
existing section, not a reorganisation of the panel; the type groups get
their own headers and collapse the same way the outer sections do.

Assumptions taken rather than asked, correct them if wrong: collapse
state persists in the workspace scope alongside the rest of the layout
(ADR 0042 §3), because a panel that forgets what you folded away is
worse than one that never folded; and the type grouping replaces the
flat list rather than being a toggle, since a toggle implies two layouts
to maintain for a panel this small.

Task 48 item 5 fixed this panel's scrolling because it was unusable at
1024 px vertical. Collapsing is the other half of that fix.

## 6. Rename should rename in place

The `panel.rename` command ("Rename panel…") sends the user to the
project view to do the rename. It should rename in place — the panel's
own dock tab title becomes editable where the user already is — and
leave them where they were.

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

The About panel is the only place the version appears, and it is buried.

**Decided format** — project first, then the capture source, then the
app and version:

```text
ev-zonal — drive-cycle.blf — cannet 0.9.3     project + capture
• ev-zonal — drive-cycle.blf — cannet 0.9.3   unsaved changes
ev-zonal — cannet 0.9.3                       project, nothing loaded
ev-zonal — PCAN-USB — cannet 0.9.3            live connection
cannet 0.9.3                                  no project
```

The project name leads because it is what distinguishes one window from
another — it is what survives truncation in a taskbar hover or alt-tab
preview, where a title starting with the app name is identical for every
window. The **capture source segment is omitted entirely when nothing is
loaded**, so the title only grows when it has something to say.

The About panel stays: it carries build info and licences, not just the
version.

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
