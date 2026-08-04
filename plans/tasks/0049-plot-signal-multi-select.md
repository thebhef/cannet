# Task 49 — Multi-Select Signals in the Plot Panel

Act on several of a plot area's signals at once — hide/show, remove,
recolour, and add — instead of one row at a time. Split out of task 48
item 14, which was conditional on staying small.

**It is not small, and this is why.** Task 48's own test for the item
was "does a selection model have to be threaded through the signal
list, the plot areas, and the persisted per-area config?" All three:

- **The row's click is already spoken for.** A signal row's plain click
  promotes that signal to the area's primary (the one driving the
  y-axis labels/units), and the colour swatch's left-click toggles
  hidden while its right-click opens the colour picker
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
- Bulk **hide/show**, **remove**, and **recolour** over the selection,
  with the pattern-materialization semantics settled (below).
- Bulk **add** from the panel's own toolbar, or an explicit decision
  that the DBC-panel drag is the supported bulk-add path and the
  toolbar stays single-pick.
- Selection is transient view state — panel-local, not persisted in the
  panel `params` (the same call `DbcPanel` makes for its own).
- No host round-trip per selection change, and none per selected signal
  on a bulk edit: selection is a frontend view concern over data the
  panel already holds.

## Design questions

1. **Extent.** Is selection per logical area, or panel-wide across
   areas? Panel-wide makes "hide these six, wherever they live"
   natural; per-area makes the range anchor and the "select all" case
   well-defined. Recolour and remove work either way.
2. **What a plain click does.** Either selection takes the plain click
   and promoting to primary moves to a modifier / context item, or
   selection is modifier-only (ctrl-toggle, shift-range) and the plain
   click keeps promoting. Pick one and say why.
3. **Where the bulk actions live.** Reuse the per-row affordances (the
   swatch and × act on the whole selection when the clicked row is in
   it — the precedent `DbcPanel`'s drag already sets), or a small
   actions strip / context menu that appears while a selection exists.
4. **Pattern materialization in bulk.** A bulk hide or recolour over
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

- Several signals can be selected in a plot panel and hidden/shown,
  removed, and recoloured in one gesture, in every y-axis mode.
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
