# Task 48 — Miscellaneous Fixes

A collection of independent defects found by using the app. They share
no design and gate nothing; they are grouped so they get scheduled at
all rather than living in the backlog until they rot.

**Each item is independently shippable.** Land them in whatever order
suits, one commit each, and strike them from this list as they go. Fix
bugs by writing the failing test first — several of these are timing or
layout bugs whose reproduction is the hard half.

## 1. A plot's cached window is discarded 250 ms after mount — **done**

Fixed in `PlotArea`: the uPlot construction effect now drops the cached
window only when the signal set actually changed; every other rebuild
repaints the fresh instance from `useDecimatedRange`'s `current()`
snapshot instead of forcing a full-window refetch. Guarded by
"the post-mount rebuild repaints the fresh uPlot from the cached window"
in `PlotPanel.dom.test.tsx`.

## 2. The first sample of a signal set is slow on a cold cache

Separate from item 1 and host-side. After a disk-cache reload the
decimation pyramids are cold, so the first `sample_signals` for a given
signal set builds them on demand — seconds on a real capture. Item 1
makes every panel pay that twice; fixing item 1 does not make the first
payment cheap.

Observed as load times that vary between plot panels (different signal
sets, different work) and that do not reliably improve on a second
visit.

Worth deciding: warm the pyramids for restored areas' signals during
reload, make the first sample cheap, or show progress rather than a
blank canvas. Measure before choosing — the cost has not been attributed
to a specific stage.

Two facts item 12's investigation turned up that bear on this:

- **The first fetch after *any* signal-set change is a whole-window
  one.** Changing an area's signal list re-anchors `useDecimatedRange`'s
  cache, which clears `base` — and with no `base` the request carries
  `fromSeconds`/`toSeconds` of `null`, i.e. the whole window at full
  point budget. So adding one signal to an N-signal area pays a cold
  whole-window sample of all N + 1, not of the one that was added.
- **Host latency is not on the UI thread.** In a CPU profile of the
  shipping app under a heavy plot, `fetch` — every host round-trip the
  panel makes — was 0.6 % of the main thread. A slow `sample_signals`
  shows up as a blank canvas, never as an unresponsive window; the plot
  loop's back-off (item 12) measures only its own synchronous section,
  so a slow cold sample does not throttle it either.

## 3. Integer signals render in scientific notation — **done**

Two changes, both landed:

- **Hex for raw fields only.** `cannet-dbc` owns one predicate:
  `value_is_raw_integer` (integer-typed, `factor == 1`, `offset == 0`)
  is computed from the `SG_` line and rides on both `DecodedSignal` and
  `SignalDescriptor`, and `is_raw_field` combines it with "no unit" and
  "not an enum". The host copies that verdict onto
  `SignalRecord::raw_field` (trace rows' decoded lines) and
  `SignalSnapshotRecord::raw_field` (signal view + DBC panel value
  column), and `formatSignalValue`'s `hex` argument renders those as
  `0xDEADBEEF` — so a signal reads the same on every surface. A literal
  "every integer-typed signal" reading would have made 1000 rpm read
  `0x3E8`, so anything scaled, offset, or carrying a unit stays decimal.
- **An exact integer never renders in scientific notation**,
  unconditionally — `formatSignalValue` takes `toFixed(0)` for any
  integer-valued input. `toExponential` above 1e6 is what made the
  `uint64` unreadable, and it is lossy for a digit-exact value.

The open sub-question resolved as suggested: **enum signals are
excluded** — the raw number under a `VAL_` table is a table key the DBC
itself writes in decimal, so `3 "Drive"` stays decimal. The exclusion
uses the repo's `is_enum` predicate (two or more members), so a
single-member SNA sentinel on an otherwise raw field still renders hex
(`0xFFFF "SNA"`).

Covered by `formatSignalValue` cases in `apps/gui/src/format.test.ts`,
`decoded_signal_flags_a_value_that_is_exactly_the_raw_integer` /
`decoded_signal_carries_enum_ness` /
`signals_descriptor_carries_value_is_raw_integer` /
`raw_field_verdict_is_the_same_from_a_descriptor_and_a_decoded_signal`
in `cannet-dbc`, `wire_signals_flag_only_raw_bit_fields` /
`signal_snapshot_rows_flag_raw_bit_fields` in `cannet-gui`, and
"renders a host-flagged raw bit field in hex" in
`SignalsPanel.dom.test.tsx`.

## 4. The unit reads as part of the value in the signal panel — **done**

The value, the unit and the `VAL_` label are now three elements rather
than one concatenated string. `SignalValueText`
(`apps/gui/src/SignalValueText.tsx`) renders them, and both value
renderers go through it: `SignalValueCell` (signal view + DBC panel live
value column) and `DecodedSignalCell` (expanded trace rows).
`formatSignalValue` shrank to the magnitude alone — it no longer takes a
unit, and `formatSignalValueWithLabel` is gone with the concatenation it
existed for. The unit recedes to the secondary text colour and carries
the inter-part spacing (`.signal-value-unit` in `index.css`), so a
caller with the unit in its own column (the signal view, passing `""`)
renders the value and nothing else.

Covered by `SignalValueCell.dom.test.tsx` — the value and the unit are
separately addressable in the DOM on both surfaces, and `unit=""`
renders no unit element and no stray spacing.

## 5. Dock panels do not scroll — **done**

Two instances, two different mechanisms.

**Project panel.** dockview mounts a panel's React root as
`.dv-react-part` (`height: 100%`) inside `.dv-content-container` inside
`.dv-groupview` (`overflow: hidden`). `.project-panel` declared
`overflow: auto` but no height, so it grew to its content and had
nothing to scroll — the sections past the fold ran under the group,
which clipped them. Measured in Chromium (the engine behind the Tauri
WebView2 host) with the real stylesheets in a 1024 px group:
`clientHeight === scrollHeight === 1333`, `scrollTop` stuck at 0, the
DBC section 319 px below the group's bottom edge. Pinning
`height: 100%` gives `989 / 1333`, `scrollTop` reaching 344, and the
DBC section in reach. Guarded by `dockPanelScrolling.test.ts`, which
asserts the declaration — jsdom does no layout, so no rendering test
can catch this.

**By-ID panel.** The virtualizer sized everything as plain rows:
`scaledHeight` counted `count * ROW_HEIGHT`, so an expanded row's
signal lines were past the end of the scroll range, and `maxAnchorRow`
subtracted `visibleRowCount`, whose two-row pad puts the anchor bound
two rows *past* the end — the tail stacked below the fold with no
scroll position that reached it (true even with nothing expanded). The
sticky viewport is `overflow: hidden` at exactly the panel height, so
the overflow was clipped rather than merely off-screen. Three pieces,
all validated against Chromium before they were written:
`scaledHeight`/`maxScrollTop` take the expanded rows' extra height
(`expandedExtraHeight`); `tailAnchorRow` replaces the padded anchor
bound with the row that puts the last row fully in view; and the sticky
viewport takes `max(panel height, rendered stack)` so a row taller than
the panel slides into view instead of being cut off. All three are
scroll-independent, so the geometry can't oscillate as the window
moves. Covered by `traceViewport.test.ts`,
`useTraceViewport.dom.test.tsx` and `ByIdTable.dom.test.tsx`.

The chronological trace shares the padded anchor bound and is left
alone here: it is a live-tail view whose anchor interacts with
auto-scroll and `scrollForRow`, which this fix does not touch.

## 6. The window hangs or stops rendering after sitting live

Observed while scrolling up in the by-ID trace panel after the app had
been live for a while. **RDP may be involved** — it was present when
observed, and a remote-desktop compositor is a plausible participant in
a WebView repaint stall, so establish whether it reproduces locally
before hunting in app code.

## 7. Transmit panel: the sequence editor disappears mid-edit — **done**

The calculated-fields modal (`CalcFieldEditor`, where "Sequence
counter" is configured) is opened from `CalcFieldsStrip` inside a
`TransmitFrameRow`, whose whole box is click-to-expand: any click that
isn't on an `input`/`button`/`label`/… toggles the row. Collapsing the
row unmounts `.tx-expanded`, and with it the strip that holds the
modal's `open` state.

Two ways in, both confirmed by disabling only the row's `onClick` and
watching the reproduction tests go green:

- **The combobox pick.** The dropdown renders through a portal to
  `document.body`, and React bubbles a portal's events up the
  *component* tree, not the DOM tree — so clicking an option arrived at
  the row's handler, whose `closest(…)` guard saw an `<li>` with no
  interactive ancestor and read it as a background click. (Same for the
  identity line's bus picker and the frame-shape strip's kind picker,
  which were silently collapsing the row on every pick.)
- **The modal's own chrome.** The modal was rendered inline in the
  row's DOM, so clicking its title or backdrop was literally a click on
  the row.

"No change is applied" is the same cause, not a second defect: the pick
does reach `counterSignal`, but the strip unmounts in the same batch, so
the user never reaches Apply. The commit path is fine — the fixed test
picks a signal and Apply carries it through `set_transmit_frame`.

Fixed with both halves, each shown necessary: the row's click handler
now ignores anything not DOM-contained in the row (killing the portal
route), and `CalcFieldEditor` renders through a portal to `document.body`
like the floating layer it is (killing the inline-chrome route). Guarded
by "picking a counter signal in the calc editor keeps the editor open and
applies the pick" and "clicking the calc editor's own chrome does not
collapse the row under it" in `TransmitPanel.dom.test.tsx`.

## 8. Per-unit y-axis scaling is wrong — **done**

Two symptoms, **two separate bugs**, both in the per-signal `ranges`
map `PlotArea`'s resample feeds to `groupScaleRanges`. Each was
reproduced on its own before either was fixed.

- **Hidden signals still affect the y limits.** The map was built over
  every signal on the axis, hidden included, so a hidden extent still
  went into the unit group's union. Measured: with a hidden 3000 A
  nominal limit and a visible 0–500 A effective one, the effective
  signal's 250 A sample stayed at `0.0833` (250/3000) after hiding
  instead of moving to `0.5`. Fixed by skipping hidden signals when
  the map is built.
- **Same-unit signals do not share a scale.** Not a consequence of the
  first — reproduced with nothing hidden. A signal that never moves has
  a degenerate all-time extent (`hi === lo`), and both the follow-live
  and visible-fit branches required `hi > lo`, so a constant dropped
  out of its unit group entirely and fell back to the canvas midline.
  Measured: a constant 3000 A limit drew at `0.5` while a 400–500 A
  signal in the same unit group filled the canvas on a scale of its
  own. Fixed by letting a degenerate extent into the group union (the
  midline fallback now applies only when the *group's* union has no
  span, which is also what keeps the normalise divide-free). Manual
  Fit Y had the same exclusion and was fixed with it.

Guarded by "numeric: a hidden signal no longer sets its unit group's
scale", "numeric: same-unit signals share one scale even when one is
constant" and "numeric: a unit group with no span at all draws at the
midline, not NaN" in `PlotPanel.dom.test.tsx`. ADR 0026's
implementation status records both rules, including why the visible-set
selection is made in the frontend rather than by telling the host what
is hidden.

## 9. The rest of the panels still do not scroll — **done**

Three sub-parts, two defects. All three measured in Chromium and in the
WebView2 host itself (jsdom does no layout), driven over CDP.

**Transmit panel — not a defect.** It scrolls, in every state that
could be built: real panel markup in a 80/120/200/400/900 px dock group,
collapsed and expanded; and the live WebView2 host with 40 frames, all
expanded, `scrollHeight` 11260 against a `clientHeight` of 1943, a
trusted wheel event reaching the bottom, and the last frame fully inside
the group. (The RBS panel, the other transmit-side surface, scrolls too:
`.rbs-tree` 7368/1897.) It works because `.tx-panel` is pinned to the
group and `.tx-panel-list`'s non-visible overflow zeroes its automatic
minimum size, so it shrinks to the panel instead of growing past it —
the two declarations the new guard in `dockPanelScrolling.test.ts`
holds. Whatever was seen, it was not this; if it recurs, it needs a
fresh observation rather than this hypothesis.

**Colour-map panel — the project panel's defect exactly.**
`overflow: auto` on a panel root with no height. Measured with the real
markup in a 300 px group and 24 range rules:
`clientHeight === scrollHeight === 794`, `scrollTop` stuck at 0, the
"+ range" button 485 px below the group's bottom edge. `height: 100%`
gives 300 / 794 and `scrollTop` reaching 494; in the live host the panel
now measures exactly its dock group (1975 px) where it measured its
content (95 px).

**Trace panel horizontal — its own mechanism, not item 5's.** The rows
are `position: absolute; left: 0; right: 0` inside a sticky viewport
that is `overflow: hidden`, so each row's box was exactly the viewport
width and the grid's fixed tracks overflowed *the row*, which the
viewport clipped. `.trace-rows` therefore had no scrollable overflow at
all. Measured in the live host on a 972 px trace panel with the default
columns (1208 px of tracks): `scrollWidth === clientWidth === 957`,
`scrollLeft` stuck at 0, the row's own `scrollWidth` 1218, and the `dir`
column 246 px past the panel's right edge. Nothing was squeezing the
columns and no ancestor above `.trace-rows` was involved.

The fix widens the scrolled content to the columns' own total:
`contentWidth` (`traceColumns.ts`) sums the visible tracks, each view
publishes it on the spacer as `--trace-content-width`, and
`.trace-scroll-content` adds the rows' own padding. The header can't
live inside that scroll container (it must not scroll away vertically),
so `useHeaderScrollSync` mirrors `scrollLeft` onto it as a negative
margin — a transform would become the containing block of the
`position: fixed` column menu it hosts — and `.trace-header` takes an
explicit width so a stretched flex item doesn't absorb the margin
instead of moving (measured: it grew 700 → 1242 px and its columns came
14.8 px out of line). Live host after: `scrollWidth` 1227 against a
`clientWidth` of 957, `scrollLeft` reaching 270, header margin
`-270px`, header and rows aligned to the pixel, the `dir` column in
view. Applied to all three tables that share this chrome — the
chronological view, the by-id view and the signal view.

Guarded by `dockPanelScrolling.test.ts` (the stylesheet halves),
`contentWidth` cases in `traceColumns.test.ts`, "mirrors the container's
horizontal scroll onto the header" in `useTraceViewport.dom.test.tsx`,
and "publishes the columns' total width to the rows' scrolled content"
in `TraceView.anchor.dom.test.tsx` / `ByIdTable.dom.test.tsx`. That the
two halves combine into an actual scrollbar is only visible in Chromium.

## 10. Hidden enum lanes still occupy vertical space — **done**

Same *shape* as item 8 (a hidden signal participating in a layout it
should be excluded from) but its own bug, in its own code: the lane
geometry took `laneBands(signals.length)` and indexed it by the
signal's position in the full list, so a hidden lane kept its slot.
Measured: with three enums and the middle one hidden, the survivors
stayed on three-lane geometry (code 0 at `0.7389` rather than the
two-lane `0.6083`).

Fixed with `laneBandsForVisible` (`plotEnumLanes`), which lays the
bands out over the visible signals and returns `null` for a hidden one.
Both consumers use it: the resample that normalises each enum into its
band, and the tile draw hook — which now reads the signal list through
a live ref, since toggling `hidden` deliberately doesn't rebuild the
uPlot instance and a construction-time capture would have drawn the old
lane layout over re-flowed data.

Guarded by the `laneBandsForVisible` cases in `plotEnumLanes.test.ts`
(including all-hidden, which computes no bands at all) and "enum lanes:
hiding a lane hands its vertical space to the rest" in
`PlotPanel.dom.test.tsx`.

## 11. Filters cannot be edited once added — **done**

Surveyed every surface that adds a filter first:

- **Defective, both of them:** the plot area's `patterns…` popover and
  the signal view's `selection` editor. They render the *same*
  component (`SignalPatternEditor`, ADR 0020/0038), whose rows were a
  read-only `/pattern/` plus a × — so the only way to change a pattern
  was to remove it and retype it. One fix serves both.
- **Not defective:** a graph filter element's predicate
  (`FilterPredicateEditor`) already edits in place on its node, and
  the sources checklist (`SourcesPicker`) is a set of checkboxes. The
  trace views' filtering is a graph filter element, so it inherits the
  graph editor. The DBC/RBS "filter" boxes are search inputs.

A pattern row is now a `ValidatedInput` (ADR 0027): draft while
typing, apply on blur or Enter, abandon on Escape — the convention the
transmit and RBS cells already use, and the one the settings panel
follows. Per-keystroke commit was rejected: each keystroke re-resolves
the area's series (and, on the signal view, re-queries
`fetch_signal_page`) against a half-typed regex that matches a wildly
different signal set. A blank or duplicate edit reverts; an invalid
regex commits, because the row's own "bad regex" readout is the
feedback the user is writing against. Evaluation stays where it was —
host-side for the signal view, catalog-resolution for the plot's
series list.

Guarded by "edits an existing pattern in place and re-queries the host
with it" / "abandons a pattern edit on Escape"
(`SignalsPanel.dom.test.tsx`) and "edits an area's pattern in place and
re-resolves its series" (`PlotPanel.dom.test.tsx`).

## 12. Adding many signals to a plot hangs the frontend — **done**

**It is a UI-thread block in the frontend, not host saturation** — so it
does not fall out of item 2. Established with a Chromium CPU profile of
the shipping release binary over CDP, driven by the self-driving perf
harness (ADR 0031) against the ev-zonal RBS simulation with one plot
area holding N signals. At N = 512 the main thread was **2.6 % idle**;
the work on it was uPlot path building (35 %), the resample's per-row
normalise (17 %), GC (14 %) and `mergeSeries` (13 %). `fetch` — every
host round-trip the panel makes — was **0.6 %**. The host is not the
bottleneck; the frontend's own per-tick shaping and redraw are.

The mechanism is that a resample's tail (merge onto the shared time
axis, normalise, `setData`, redraw) is synchronous work proportional to
`series × merged rows`, and the loop then waited a *fixed* interval
after it. Past some series count the interval is shorter than the tail,
so the thread never gets an idle slot — a plot that is merely slow to
fill becomes a window that has stopped responding. Two changes:

- **The loop paces itself against what the last tick cost**
  (`plotPacing.ts`): it idles at least `RESAMPLE_IDLE_RATIO` times the
  tick's own synchronous span, so an area can never occupy more than a
  bounded share of the thread however many signals it holds, and
  whatever the buffer's density. The host round-trip is deliberately
  outside the measured span — a slow cold sample (item 2) must not
  throttle the plot. At the ordinary handful of series the tick is far
  cheaper than the interval and the pacing is a no-op.
- **The auto-normalise writes in place** instead of `map`-ing a second
  array per series — one full `series × rows` allocation per tick,
  churned every tick, which the profile put at 17 % of the thread plus
  most of the GC it fed.

Measured interleaved A/B, two reps each, release binaries, 40 s captures
(`longtask_ms_per_s.mean` — UI-thread block time per second):

| N | before | after |
| --- | --- | --- |
| 128 | 228 / 208 ms | 74 / 74 ms |
| 512 | 643 / 632 ms | 315 / 313 ms |

Main-thread idle at N = 512 goes 2.6 % → 34 %, event-loop lag max 310 ms
→ 156 ms, JS heap peak 484 MB → 389 MB. Guarded by `plotPacing.test.ts`
(the duty-cycle invariant, the interval floor, the back-off cap) and
"backs the fetch loop off when a tick's own render work is expensive" in
`PlotPanel.dom.test.tsx`, which counts resamples over a second with a
synthetic 250 ms render cost — 16 without the fix, ≤ 3 with it.

**What is left, honestly.** At 512 series in one area the individual
blocks that remain are one `mergeSeries` (~40 ms) and one uPlot draw
(~66 ms); neither can be subdivided, so the run still reports
`jank_fraction` 1.0 there (any second with > 50 ms of long-task time
counts). The pacing bounds the *share* of the thread, not the size of a
single indivisible block — the app responds, it refreshes less often.
Making a single block smaller means drawing less: capping the merged x
grid at the canvas's own resolution would cut both the merge and the
draw, and is the next lever if one is ever wanted. The allocation half
of this fix is only observable in Chromium (a CPU profile); jsdom
neither lays out nor paints, so no test here can see it.

## 13. The plot's x-axis label should show the free cursor's time — **done**

The bottom-most stacked area's `time (s)` label now carries the free
(mouse-crosshair) cursor's own time while the pointer is over the panel,
as elapsed time on the session timeline at the same precision as the
ticks beside it (ADR 0024).

Choices made:

- **The free cursor only.** Cursors A and B already label their own
  vertical lines with their times, plus a Δt chip — that half of the
  problem was already solved and is not duplicated here.
- **Panel-level, not per-area.** The crosshair is one shared x for the
  whole stack, and only the bottom area carries a labelled x axis, so
  the readout lives on that single label.
- **Reverts to plain `time (s)` when the pointer leaves.** A held last
  value would have no crosshair on screen to refer to.
- **No jitter.** The label is drawn in bold monospace and the time is
  padded to the width of the longest string the *visible window* can
  produce, so the string keeps one width — and so one position under
  uPlot's centred label drawing — as the pointer moves. The width
  changes only on a pan/zoom across a magnitude boundary.
- **No new per-mouse-move render work.** uPlot calls `axis.label` on
  every draw, so the label reads the area's `liveRef` and rides the
  redraw the panel-level (rAF-coalesced) hover state already triggers.

## 14. Multi-select signals in the plot panel

**Only if it stays small.** Selecting several signals at once (add,
hide, remove, recolour) rather than one at a time. If it turns out to
need a selection model threaded through the panel, it is its own task —
split it out rather than growing this one.

## 15. Drag-reorder plot areas

**Only if it stays small.** Same caveat as item 14: if it needs more
than the existing area-ordering state, it becomes its own task.

## 16. Process names do not say what they are

Processes the app spawns show up under generic names — nothing should
appear in a task manager as `tauri` alone. Every process this app is
responsible for should carry `cannet` in its name and enough beyond that
to say which part it is (host, sidecar, WebView helper where we control
the name), so a user looking at a process list can tell what is ours and
what each one does.

Covers whatever we actually control: the binary name, the Tauri product
name, and the sidecar's process name.

## Exit criteria

- Every item above is fixed or struck with a recorded reason, and this
  file is deleted when the list empties.
- Each fix lands with a test that fails before it.
- Items 14 and 15 are explicitly conditional: if either grows past a
  small change, it leaves this task rather than expanding it.
- Items 1, 8 and 10 touch plot behaviour that ADR 0026 governs; if a fix
  contradicts that ADR, the ADR changes in the same commit.
