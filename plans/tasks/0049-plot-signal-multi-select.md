# Task 49 — Multi-Select Signals in the Plot Panel

Act on several of a plot area's signals at once — hide/show, remove,
recolor, and add — instead of one row at a time. Split out of task 48
item 14, which was conditional on staying small.

**It is not small, and this is why.** Task 48's own test for the item
was "does a selection model have to be threaded through the signal
list, the plot areas, and the persisted per-area config?" All three:

- **The row's click is already spoken for.** A signal row's plain click
  promotes that signal to the area's primary (the one driving the
  y-axis labels/units), and the color swatch's left-click toggles
  hidden while its right-click opens the color picker
  (`SignalSwatch`, `PlotArea.tsx`). Adding selection means re-deciding
  what a row's primary gesture *is* — a UX decision, not a mechanical
  one.
- **Rows are rendered per derived axis, not per area.** In `per-unit` /
  `individual` mode one logical area's signals are split across several
  `PlotArea` instances (`deriveAxesForArea`, ADR 0026). A shift-range
  selection over "the area's signals" therefore has to span sibling
  components that each hold only a slice, in an order only the panel
  knows.
- **Bulk edits are not N single edits.** `toggleSignalHidden` and
  `setSignalColor` *materialize* a pattern-derived row into a manual
  pick so the choice survives the next pattern re-evaluation (ADR 0020
  / ADR 0038). Doing that for a whole selection rewrites an area's
  stored `signals` list wholesale, and what that should mean alongside
  the area's `patterns` needs deciding before it is written.
- **The plot stack is memo-sensitive.** `PlotArea` is memoised and the
  panel has a standing regression test that panel-local state changes
  re-render no plot area ("re-renders no plot area when only panel-local
  state changes", `PlotPanel.dom.test.tsx`). A selection value that
  changes on every click has to be sliced per area or it re-renders the
  whole stack on each click — at the series counts task 48 item 12
  measured, that is the difference the pacing work bought.

Half of "add" already works and is deliberately *not* re-litigated
here: the DBC panel has its own selection set with shift/ctrl anchors
(`DbcPanel.tsx`), its drag payload carries every selected signal, and
the plot area's drop handler already fans a multi-signal payload out
(`for (const r of refs) onDropSignal(...)`, `PlotArea.tsx`). What is
missing on the add side is a multi-pick in the plot toolbar's own
`add signal…` control, which is a single-select `Combobox`.

## Scope

- A selection model for the plot panel's signal rows: an ordered
  selection set plus a range anchor, rendered as a row highlight,
  reaching every row of a logical area whatever its y-axis mode.
- Bulk **hide/show**, **remove**, and **recolor** over the selection,
  with the pattern-materialization semantics settled (below).
- Bulk **add** from the panel's own toolbar, or an explicit decision
  that the DBC-panel drag is the supported bulk-add path and the
  toolbar stays single-pick.
- Selection is transient view state — panel-local, not persisted in the
  panel `params` (the same call `DbcPanel` makes for its own).
- No host round-trip per selection change, and none per selected signal
  on a bulk edit: selection is a frontend view concern over data the
  panel already holds.

## Grooming (2026-08-07)

Pulled into the task-54/55/56 implementation slice; the selection
model and bolding of selected series land with task 55's item 5,
this task carries the bulk actions. Rulings so far:

- **#1 Extent: per logical area only** (owner ruling). The range
  anchor and select-all are area-scoped; a selection never spans
  areas.
- **Not a grid derivative** (owner ruling): the plot side panel does
  not adopt the gridview machinery (`useGridview` container/cursor).
  The pure `gridviewSelection` reducer may be reused only if it
  drops in cleanly over an area's ordered key list; otherwise a
  small area-local reducer is fine. Follows that **#6 keyboard**:
  selection is mouse-only in this task.
- **#4 Materialization**: bulk edits materialize only the touched
  rows and leave the patterns live — same semantics as today's
  single-row toggle, batched (one persist, one resample). Task 55's
  solo covers non-destructive mass-hide.
- **#2 Plain click** (owner agreed): plain click selects that row
  (selection of one) *and* promotes it to primary — today's gesture
  plus a highlight. Ctrl+click toggles membership, Shift+click
  range-selects from the anchor; neither touches primary. Bolding
  (task 55 item 5) applies to the selection; primary keeps meaning
  "the signal whose units label the axis."
- **#3 Bulk actions** (owner ruling): **no bulk recolor.** The bulk
  actions are **visibility (hide/show) from a context menu** on the
  selection, and **drag-and-drop of the selection** (the drag
  payload carries every selected row, DbcPanel precedent). Bulk
  remove only as far as drag-out implies it; no dedicated bulk
  remove affordance.
- **Add side** (owner ruling): **remove the toolbar's single-pick
  `add signal…` Combobox entirely.** Adding signals to an area is
  done by drag (DBC panel multi-select, other panels, cross-area
  selection drag) and by the patterns editor.
- **#5 Shared primitive / #7 re-render**: see above; selection
  reaches each `PlotArea` as an area-scoped slice so the standing
  "re-renders no plot area on panel-local state" guard stays green.

## Design questions

1. **Extent.** Is selection per logical area, or panel-wide across
   areas? Panel-wide makes "hide these six, wherever they live"
   natural; per-area makes the range anchor and the "select all" case
   well-defined. Recolor and remove work either way.
2. **What a plain click does.** Either selection takes the plain click
   and promoting to primary moves to a modifier / context item, or
   selection is modifier-only (ctrl-toggle, shift-range) and the plain
   click keeps promoting. Pick one and say why.
3. **Where the bulk actions live.** Reuse the per-row affordances (the
   swatch and × act on the whole selection when the clicked row is in
   it — the precedent `DbcPanel`'s drag already sets), or a small
   actions strip / context menu that appears while a selection exists.
4. **Pattern materialization in bulk.** A bulk hide or recolor over
   pattern-derived rows pins each as a manual pick. Does that
   effectively convert the area to manual (making the patterns dead
   weight), and if so should it say so — or should it materialize only
   the touched rows and leave the patterns live?
5. **Shared primitive or not.** `DbcPanel`'s anchor + shift-range +
   ctrl-toggle logic is inline and coupled to its flattened row list.
   Extract it over an ordered key list and use it in both, or leave it
   duplicated? The reviewability rule in `CLAUDE.md` favours one tested
   primitive over two hand-rolled selections.
6. **Keyboard.** Does the plot's signal list become focusable and
   arrow-navigable like the DBC tree, or is selection mouse-only in this
   task?
7. **Re-render shape.** How the selection reaches a memoised `PlotArea`
   without invalidating every area per click — a per-area slice
   computed in the panel, or a ref + imperative row class, given rows
   are plain DOM.

## Not in scope

- Dragging a whole plot area **between panels** — that is task 23.
- Reordering a panel's plot areas, which shipped with task 48 item 15.
- Multi-select anywhere other than the plot panel's signal rows and its
  own add control.

## Exit criteria

- Several signals can be selected within a plot area (ctrl-toggle,
  shift-range) and hidden/shown from the selection's context menu or
  dragged as one payload, in every y-axis mode. No bulk recolor. The
  toolbar's single-pick `add signal…` Combobox is removed.
- Each design question above is answered in this file (or in an ADR
  where it is a durable rule) before the code that assumes the answer
  lands.
- Tests: the selection reducer (anchor, ctrl-toggle, shift-range,
  clearing) covered as pure logic; the bulk edits covered in
  `PlotPanel.dom.test.tsx` including a selection spanning a `per-unit`
  area's derived axes and one over pattern-derived rows.
- The existing "re-renders no plot area when only panel-local state
  changes" guard still passes, and a selection click does not re-render
  areas that hold no selected row.
- README's plot-panel section documents the interaction, including what
  a plain click now does.

## Status log

- **2026-08-08 (the selection model + bold selected series):** Landed on
  `task49a-area-selection` in three commits. This phase is the
  *selection model* and task 55 item 5's bolding; the bulk actions
  (context-menu visibility, selection drag, removing the toolbar's
  `add signal…` Combobox) are the next phase and were deliberately not
  touched.
  - `d37e28a` — **the reducer, pure.** Design question 5 answered
    **reuse**: `gridviewSelection.selectOnClick` is already written
    against an *ordered list of ids* rather than a row space, so it
    drops in with no change and no gridview machinery comes along (no
    `useGridview`, no cursor, no keyboard multiselect — question 6 stays
    mouse-only). `plotAreaSelection.ts` is the thin wrapper that adds
    the one rule the plot side panel needs: the selection carries the
    logical area it belongs to, and a click in a different area starts
    from empty. `gridviewSelection.ts`'s module doc now says it has a
    second caller. 9 pure tests (`plotAreaSelection.test.ts`) cover
    plain click, ctrl-toggle both ways, shift-range in both directions
    with a sticky anchor, no-anchor fallback, clear-on-other-area, and
    identity preservation for a key the area does not hold.
  - **Design decision — one active selection per panel** (the reading
    taken of question 1's "per logical area only"). The state is a
    single `{areaId, ids, anchor}`, not a map of per-area selections:
    "a selection never spans areas" is enforced by *there being one*,
    which also makes "what does clicking in another area do" have an
    obvious answer (that area's selection starts, the previous clears)
    rather than leaving invisible selections parked in areas the user
    has moved on from. A map would make bulk actions ambiguous about
    which area they act on; a single selection cannot be.
  - `71ccdcc` — **the gestures.** Question 2 as groomed: plain click
    selects that row *and* promotes it to primary; ctrl/shift only
    select. The row's existing `defaultPrevented` guard already keeps
    the swatch's hide-toggle and colour picker out of it, so those
    keep working and change no selection (covered by a test). Rows get
    the app's shared `--surface-row-selected` wash, listed after
    `.primary` so a row that is both shows the selection and keeps the
    primary's inset marker.
  - **How the slice reaches `PlotArea`** (questions 1 + 7). The panel
    computes `selectedKeysByAxis`: for every *derived* axis, the
    intersection of that axis's signals with the selection, and the
    shared `EMPTY_KEY_SET` constant whenever that intersection is
    empty. So an axis holding no selected row is handed an
    identity-unchanged prop and its memo holds. The range order is the
    *logical area's* `effectiveAreas` signal list
    (`selectionOrderByArea`), which is what lets a shift-range span the
    axes `per-unit` / `individual` splits an area into. The click
    callback is routed to the parent area in `AxisHandlers` and is
    stable across selection changes, so `areaHandlers` does not churn.
  - `555eb41` — **bold selected series** (task 55 item 5). 2px against
    1px, applied by writing `series[i].width` on the live uPlot
    instance plus a redraw, with the construction path seeding widths
    from the standing selection through a ref so the rebuild a
    signal-set change forces doesn't drop the bolding. See
    Blockers for why this is a write and not the literal "live width
    function".
  - Tests: 9 pure + 9 new DOM tests in `PlotPanel.dom.test.tsx`
    ("PlotPanel signal-row selection") — plain click selects and
    promotes, ctrl-toggle and shift-range each leave the primary alone,
    a range across a three-axis `per-unit` area sweeps the middle axis's
    row in and stops at the range end, a click in a second area clears
    the first, the swatch's hide toggle leaves the selection alone,
    bold-on-select without a rebuild, bolding survives a rebuild, and
    the memo guard: with three seeded areas, extending the selection
    inside area 1 costs exactly 1 `PlotArea` render and moving it to
    area 2 costs exactly 2 (area 3 untouched). The standing
    "re-renders no plot area when only panel-local state changes" guard
    is unchanged and green. `apps/gui` test suite: 1518 → 1536 passing
    (130 → 131 files); `pnpm --dir apps/gui build` green at every
    commit.
  - README's plot section gains a "Selecting signal rows" bullet (the
    three gestures, what a plain click now does, the one-area rule, the
    cross-axis range, bold lines, view-state-not-persisted), and the
    y-axis-mode bullet's "click a series row to promote it" now says it
    selects too. **No ADR written**: nothing here is a durable
    cross-panel rule — the reused reducer is already ADR 0044's, and
    the per-area scoping is one panel's UX choice, recorded above. If
    the bulk-action phase finds itself defining how selections behave
    across panels, that is the point to reconsider.

## Blockers / side effects

- **uPlot resolves `width` as a number, not a function**, so the
  groomed "live width function following the exact pattern of the live
  stroke-color function" is not literally implementable: uPlot calls
  `stroke` (`fnOrSelf`) but reads `series[i].width` as a plain number on
  every draw and multiplies it by `pxRatio`, so a function there yields
  `NaN`. Implemented the closest faithful reading — the same
  read-live-per-draw seam, driven by an effect that *writes* the width
  onto the live instance and redraws. The property the ruling was
  protecting (no uPlot rebuild on a selection change) holds and is
  pinned by a test asserting the instance identity is unchanged across
  a selection click. A getter on the series object would have been the
  literal function shape, but uPlot assigns `s.width = s.width` during
  init, which throws on a getter-only property in strict mode.
- **The per-area render-count test needs an explicit settle loop.**
  Measured while writing it: the first `act` after a panel mounts can
  absorb a one-off *panel-wide* fan-out (all areas re-render) from
  mount-time async — the value-table fetch landing, the first-sample
  wait settling, or a previous test's `void hydrateSettings()`
  resolving — and its timing moves with test-file load, so a fixed
  400 ms wait made the assertion flaky (passing alone, failing in
  suite). The test now flushes until a flush costs no renders before
  taking its baseline. Not a property of the selection slice: with the
  fan-out settled, repeated selection clicks cost only the clicked
  area's render, which is what the assertions pin.
- **Stack-wide fan-out on any `areas` edit is unchanged and still
  pre-existing** (recorded during task 55 item 4): a *plain* click also
  moves the primary, which rewrites `areas` and re-renders every
  `PlotArea` because `derivedAreaConfigs` mints fresh derived configs
  for the whole stack. The selection-slice guard is therefore asserted
  with ctrl-clicks, which change nothing but the selection. Fixing the
  underlying derivation is still out of scope here.

- **2026-08-08 (the bulk actions):** Landed on `task49b-bulk-actions`
  (from `task49a-area-selection`) in three commits, closing out the
  task.
  - `9bade33` — **test prep.** ~40 call sites across
    `PlotPanel.dom.test.tsx` used the toolbar's `add signal…` combobox
    purely as setup ("there is a signal on the plot"). Before touching
    production code, they were moved onto a new `addFocusedSignal` /
    `addToFocused`, built on the existing `dropSignal` drag simulant
    rather than the picker being removed next. Two tests that pinned
    picker-specific behaviour were retired: the option-grouping test
    (no picker, nothing to group) and the same-area repeat-pick dedup
    test, restated against the drop handler's own per-area dedup
    (`dropSignal` twice onto one area). The stale empty-area
    placeholder text ("pick a signal above…", which named the control
    about to go) was fixed in the same commit to name what actually
    adds a signal now.
  - `ee36e93` — **the feature.** Context menu, selection drag, and the
    combobox removal, together — the three scope items share the same
    edit sites (`AxisHandlers`, the row's click/drag handlers,
    `areaHandlers`), so splitting them into separate commits would
    have meant re-deriving interleaved hunks for no reviewability
    gain.
    - **Hide/Show context menu**: `PlotArea.tsx` gets a
      `SignalSelectionMenu` (same floating shell as `YAxisScaleMenu`
      and the sources picker's context menu), opened from a row's new
      `onContextMenu`. `PlotPanel.tsx` gets `setSelectionHidden` — the
      batched sibling of the existing `toggleSignalHidden` sitting
      right after it — which resolves the parent area's current
      selection to its *effective* `SignalRef`s (`selectedRefsFor`,
      spanning every derived axis a `per-unit`/`individual` mode
      splits the area into) and applies `hidden` to all of them in one
      `setAreas` call. That one call is what makes it one persist (the
      panel's `persist` effect fires once per `areas` reference
      change) and one resample per touched derived axis (each axis's
      own `signalSetKey` changes once, the same trigger the single-row
      toggle already relies on) — never N.
    - **Selection drag**: a `dragstart` on a row already in the
      selection calls a new `onDragSelection` (bound to `dragSelection`
      in `PlotPanel.tsx`, built the same way as `setSelectionHidden`)
      instead of the row's own single-ref payload. The existing drop
      path needed no change — `signalDrop` already fans an array
      payload out per-ref (`for (const r of refs) onDropSignal(...)`,
      predating this task), so a multi-signal payload lands with
      exactly the same move/copy/materialize semantics a single-ref
      drag always had, just N times.
    - **Combobox removed**: `addSignalToFocused`, `catalogOptions`,
      the `<Combobox>` JSX, and the `SignalDescriptorRecord` /
      `signalKey` imports it alone used. `focusedAreaId` / the
      `focused` prop stay — they still drive the area-highlight
      outline, a `PlotArea` render input unrelated to the removed
      control.
    - CSS: `.plot-selection-menu` / `.plot-selection-menu-action`,
      styled off the same shell `.plot-axis-menu` and
      `.sources-context-menu-action` already establish.
    - Tests added (10, all in `PlotPanel signal-row selection`):
      combobox-absence; bulk hide in one persist; bulk show; a
      selection spanning a `per-unit` area's three derived axes,
      still one persist; a selection over two pattern-derived rows,
      materializing both while the pattern itself stays live (still
      one pattern, still one persist); the not-in-selection
      right-click; the swatch's own context menu still wins (no
      selection-menu leak, selection untouched); the selection-drag
      payload for both the selected-row and unselected-row case; and a
      resample-count bound (≤ 2 for a two-row hide sharing one axis)
      pinning the batching at the seam that actually costs something.
      **Verified genuinely red-then-green**: stashed the three
      production files, re-ran the suite — the combobox-absence test
      and all seven feature-dependent new tests failed as expected,
      the two pure-regression-guard tests (swatch precedence,
      unselected-row drag) passed anyway (they pin behaviour that
      doesn't depend on the new code), then restored and confirmed all
      110 green again.
    - `apps/gui` test suite: 1536 → 1545 passing (131 files
      throughout); `pnpm --dir apps/gui build` green at every commit.
  - `2b654f1` — **docs.** README's plot-panel section: the "Plot
    areas" bullet drops the combobox and names drag + patterns as the
    add paths; "Selecting signal rows" gains the context menu and the
    selection-drag paragraph.
  - **Design readings** (recorded here per the phase brief):
    - **Not-in-selection right-click**: right-click replaces the
      selection with just the clicked row before opening the menu —
      the Explorer/Finder/VS Code convention. No in-repo right-click
      precedent existed to follow (`DbcPanel` has none); this is new
      but standard, and it differs from the drag case on purpose — a
      context menu inherently asks "what does this apply to" and needs
      an unambiguous, on-screen answer, where a drag payload can be
      computed invisibly without disturbing what's on screen.
    - **Unselected-row drag**: leaves the selection exactly as it is
      and drags only the grabbed row — `DbcPanel`'s own doc comment on
      `handleDragStart` states this explicitly ("the panel's visible
      selection is unchanged so the user can keep it"), so this phase
      matches it rather than inventing a third behaviour.
  - **Exit criteria**: all four are met. Selection can be hidden/shown
    from the context menu or dragged as one payload in every y-axis
    mode; no bulk recolor; the toolbar combobox is gone; every design
    question in this file was already answered in 49.A's entry or
    settled by the readings above (no new ADR — the per-panel UX
    choices here follow directly from the already-recorded rulings,
    nothing durable/cross-panel emerged); the reducer + bulk-edit tests
    exist per the exit criteria's own list; the render-count guard is
    unchanged and still green; README documents the interaction. This
    closes task 49.

## Exit criteria walk (2026-08-08)

- **Ctrl-toggle/shift-range selection per area, context-menu
  hide/show, one-payload drag, every y-axis mode; no bulk recolor;
  combobox removed** — MET (49.A `d37e28a`/`71ccdcc`/`555eb41`,
  49.B `9bade33`/`ee36e93`).
- **Design questions answered in-file before dependent code** — MET
  (Grooming section + status-log design readings).
- **Reducer covered pure; bulk edits covered in
  `PlotPanel.dom.test.tsx` incl. per-unit spanning and
  pattern-derived rows** — MET (`plotAreaSelection.test.ts`; batched
  single-persist asserted).
- **Standing memo guard green; selection click re-renders no
  unaffected area** — MET, with the recorded caveat that a *plain*
  click legitimately fans out (it moves the primary — pre-existing
  `areas`-edit behavior); the slice guard is asserted with
  ctrl-clicks.
- **README documents the interaction incl. the plain click** — MET.

Task complete; all criteria verified.
