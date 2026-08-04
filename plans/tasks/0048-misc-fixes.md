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

## 7. Transmit panel: the sequence editor disappears mid-edit

Adding a sequence, then changing the signal-selection combobox, makes
the window disappear. No change is applied.

## 8. Per-unit y-axis scaling is wrong

Two symptoms on the per-unit axis mode, possibly one cause:

- **Hidden signals still affect the y limits.** A hidden 3000 A
  "nominal" current limit still sets the scale for a visible 500 A
  "effective" limit.
- **Same-unit signals do not share a scale.** Despite per-unit mode, the
  3 k value does not appear to be on the same scale as the 500 A one,
  which is what per-unit mode exists to guarantee (ADR 0026).

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

## 10. Hidden enum lanes still occupy vertical space

The enum-overlay twin of item 8. Hiding an enum signal leaves its lane
occupying its share of the enum window's height, so hiding a signal
does not give the remaining lanes any more room. Hidden signals should
drop out of the lane layout entirely, the same way item 8 asks for them
to drop out of the y-limit computation.

Likely one fix with item 8 — both are "hidden signals still participate
in a layout computation they should be excluded from" — but the lane
band arithmetic (`plotEnumLanes`) and the y-extent path are separate
code, so confirm before merging the work.

## 11. Filters cannot be edited once added

A filter added to the plot view cannot be edited afterwards — only
removed and re-added. Possibly true of the signal panel's filters too;
check both before deciding the fix's shape.

## 12. Adding many signals to a plot hangs the frontend

Observed when adding signals to a plot area against a reasonably full
trace buffer: the frontend stops responding rather than merely taking a
while. May share a cause with items 1 and 2 (each added signal is a cold
pyramid build, and enough of them in flight starves the UI), but "slow"
and "hung" are different failures — establish which this is before
assuming it falls out of item 2.

Whatever the cause, the exit condition is that adding signals never
blocks the UI thread, however many are added and however full the
buffer.

## 13. The plot's x-axis label should show the free cursor's time

The cursor readout gives each signal's value at the cursor but never the
cursor's own time, so the one thing every signal's reading is relative to
is invisible. The `time (s)` label at the bottom of the plot panel is
otherwise static text and is the natural place to put it.

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
