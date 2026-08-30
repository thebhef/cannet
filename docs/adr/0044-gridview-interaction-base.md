# ADR 0044 — Gridview: one shared tree/grid interaction base

Status: accepted (2026-08-05)

## Context

Every grid-like panel — the trace in both modes, the signal view, the
DBC tree, the RBS tree, the transmit list — hand-rolled its own row
interaction, and the copies drifted: keyboard navigation existed in
exactly one panel (the DBC tree), multiselect in the same one,
expansion state was stored five different ways (by index, by stable
key, per-component booleans; ephemeral, element-persisted,
params-persisted), fuzzy filtering was implemented twice, and
disclosure affordances ranged from a real `aria-expanded` button to
an inert glyph span with a hit target too small to click. The scroll
arithmetic had already been consolidated once
(`traceViewport.ts` / `useTraceViewport`) after the same defect was
fixed three times in three copies; this ADR is that consolidation one
layer up.

## Decision

**One headless interaction base — the gridview — that every
grid-like view instantiates.** It is a hook plus an adapter contract,
not a rendering component: interaction state binds to an **ordered
row space of stable string ids** supplied by the panel's adapter
(`rowIdAt`, `indexOf`, `scrollToRow`, per-row kind/expandability).
Rendering and scrolling stay per-panel — both virtualizers
(`traceViewport`'s anchor model for beyond-height-cap counts,
`dbcPanelViewport`'s pixel-offset model for bounded counts) and
non-virtualized panels sit unchanged beneath it.

**Node model.** A row is `{id, kind: branch | leaf, expandable,
depth}`. A branch's children appear in and disappear from the row space
as it opens and shuts. **A leaf's content is rows.** A trace row's
decoded signals, an RBS message's signals, a transmit tile's DBC
signals table — each line gets its own id, a place in the order, and a
share of the cursor and the selection. Controls the row carries, the
disclosed ones included, are reached by Tab, exactly as a control on
the row's own line is. Either shape keeps one rule: **the toggle is the
row's own line, never the footprint of what it disclosed.** A click
inside disclosed content acts on that content and never on the row that
disclosed it. `kind` says what the rows *are* (a branch structures rows
below it; a leaf's content belongs to it), not whether expanding
produces any. There is no branch-with-content variant; `kind` and
content-expandability are orthogonal fields, so adding one later is
additive.

*(Amended 2026-08-21. Content was originally a block that grew the row
and added no rows, in every case. That made a list of content a blob
inside one row: the row owned the click, so clicking a decoded signal
collapsed the message the user was reading, and nothing in the content
could be selected or reached by the cursor. Content-as-rows deletes
that special case instead of guarding it.)*

*(Amended 2026-08-27. The **editor-face carve-out is deleted** — the
clause excusing content that was "an editor face rather than a list"
from being rows, which named a transmit tile's frame-shape and byte
editors and an RBS message's value cells. It named two panels and both
have now adopted content rows, so it has no occupants left. The
distinction did not survive contact with the panels it was drawn for:
an RBS message's "value cells" are a signals table, which is a list
whichever way it is read, and once its lines are rows the value cell is
just a control that row carries — reached by Tab like any other. What
sits outside the row space is not a category of content but the
ordinary case of a row with several controls on it, which the Tab rule
already covered.)*

**Cursor and selection are separate, and the cursor is
row-granular.** One active row per gridview, keyed by id; the
container holds DOM focus and names the active row via
`aria-activedescendant` (row DOM nodes are recycled or absent in
paged viewports, so focus cannot live on them). The selection is a
separate id set with a click anchor. Both are ephemeral — never
persisted. Clicking a row hands the container that focus, unless the
click was aimed at a control that takes focus itself; without it a
mouse-then-keyboard session leaves focus on the document body and the
grid's keys point at nothing. There is no active cell: interactive
content inside a row is reached by Tab, not by the grid cursor.

*(Amended 2026-08-27. The container and its rows carry **real ARIA
roles** — `tree` on the container, `treeitem` on every row of the space
including a row's disclosed content rows, `presentation` on the
scroll/spacer elements between them. `aria-activedescendant` names an
element; without a role on either end it names nothing an assistive
technology can report, so the attribute was inert wherever the markup
was plain `div`s. It follows that **no row is a tab stop**: a row with
`tabindex` is a second focus model beside the container's, it puts
grid rows in the page's tab order, and its own key handlers duplicate
keys the layer already owns.)*

*(Amended 2026-08-27. **Row background belongs to the layer.** Cursor
and selection are what paint a row; a panel says per-row state in a
**cell** — a chip, an icon, text — never in the row's background, and
never ships a toggle for doing so. Two signal-mapping grids had painted
a translucent status wash across the row, competing with the layer's
own selection indication on the same DOM node, and carried a "Row
Highlights" chip plus a persisted `washesOn` param to switch between
that wash and a status word in the cell. The wash is a panel
re-implementing what the layer owns, and the toggle is workspace state
for a behaviour that is not the panel's; both are gone, and the status
word is unconditional.)*

*(Amended 2026-08-23. The container being what holds focus means the
UA's focus ring goes round the whole scroll viewport, which reads as
the entire panel lighting up — loudest on a press that moves nothing,
where it is the only thing on screen that changed. **While the
container names an active row, the row's own cursor styling is the
focus indication and the box ring is suppressed; while it names none,
the ring stays**, because focus arriving by Tab before the cursor has
moved has nothing else to point at. The rule is keyed on the
container's gridview attribute and the presence of
`aria-activedescendant`, so it holds for every panel on the layer, and
each panel owes its cursor a visible row indicator that does not depend
on the row being selectable.)*

**One key table for every gridview:**

| Key | Branch | Leaf with content | Plain leaf |
| --- | --- | --- | --- |
| Up/Down | move cursor (selection collapses to it) | ″ | ″ |
| Right | closed → expand; open → first child | closed → expand content; open → its first content row, where the content is rows | no-op |
| Left | open → collapse; closed → parent | open → collapse content; closed → parent | parent |
| Space | panel-defined primary action (default none) | ″ | ″ |
| F2 | panel-defined rename/edit of the cursor row (default none) | ″ | ″ |
| Enter | unbound (user-customizable) | ″ | ″ |
| Home/End | first/last row | ″ | ″ |
| PageUp/Down | move cursor one viewport | ″ | ″ |
| Shift+Up/Down | extend the selection to the row moved onto | ″ | ″ |
| Ctrl/Cmd+A | select all selectable rows | ″ | ″ |
| Tab / Shift+Tab | into the cursor row's controls, first / last | ″ | ″ |
| Escape (in a row's content) | back to the container, cursor intact | ″ | ″ |

Space, not Enter, is the action key, and the action is the panel's
to define (transmit: send the focused frame once, or start / stop it
when the row is periodic); expansion is already covered by Left/Right,
so no default action is bound.

**The action-key vocabulary is Space and F2, and it grows only in the
layer.** Each is an optional callback the panel may leave unbound, so a
view that has no such action is unchanged by the key existing; each is
also in the dispatcher's suppression set, so a global binding on it
cannot go silent inside a grid without the shortcuts view saying so.
The rule for adding a third: a key earns a place here when the action
it names belongs to *rows* rather than to one panel — the test being
whether the same rows appear in more than one view, because that is
when a view-local copy starts to drift. An action only one panel's rows
have stays that panel's, reached through Space or through the row's own
controls by Tab.

*(Amended 2026-08-22. F2 joined Space. Event rows carry an inline label
and appear in two views — the events view and the chronological trace's
interleaved rows — so binding rename in either view would have written
it twice. Editability is the panel's to judge: the layer offers the key
and the panel declines it on a row the mouse cannot edit either.)*

**The layer owns the way into a row's content, and the way back
out.** Tab pressed on the container moves focus to the cursor row's
first control in tab order, Shift+Tab to its last — the mirror, so the
row is reachable from either direction without first leaving the grid.
Controls that opt out of the tab order (`tabindex="-1"` carets, clear-
override buttons) are skipped, and a cursor naming a row that is not
on screen — routine in a paged viewport — leaves the press to the
browser. Once focus is inside a row, Tab is the browser's again: it
walks that row's own controls and then out of the row. **Escape is the
way back**: focus returns to the container with the cursor untouched,
so the arrows navigate again — without it, Tab into a row is one-way
and the keyboard is only recovered with the mouse.

*(Amended 2026-08-27.)* **Escape's precedence, innermost first:
content beats the grid, the grid beats a global binding, and a press
that reaches the container is the global binding's.** A control that
consumed Escape (a combobox closing its dropdown, an editor reverting
a draft) either stops it reaching the container or marks it handled,
and the grid takes only what is left. A *global* binding is not
content and does not get to claim it from the capture phase: while
focus is inside a row the dispatcher stands down on plain Escape, so
the two layers arrive in order — one press out of the row, the next
out of whatever the binding governs. Escape used to count a
capture-phase global `preventDefault` as content having claimed it,
which made `view.exitFullscreen` — gated on a maximized view, so live
exactly when a fullscreened panel's row has the keyboard — win the
press: fullscreen exited and focus stayed stranded on the control.

The container also takes focus back whenever a row's editor ends an
edit by blurring itself (commit on Enter, revert on Escape) with
nowhere to go, since a blur to the document body leaves the grid's keys
dead and the next Tab restarting from the top of the page.

**Multiselect is mouse-built, and ranges extend from the keyboard.**
Plain click replaces the selection; Ctrl/Cmd+click toggles a row;
Shift+click *replaces* the selection with the range from the click
anchor; Ctrl+Shift+click *adds* that same range (noncontiguous
selections accumulate); Ctrl/Cmd+A selects all. The anchor is the last
plain or Ctrl/Cmd+click, shared by both range chords and kept across
them, so successive range clicks re-range from one point rather than
walking. **Shift+Up/Down** is the keyboard's range gesture, VS Code's:
the cursor moves exactly where the plain arrow moves it and the
selection becomes the anchor→cursor range, so the destination row joins
the selection, the anchor stays the range's fixed end, and reversing
direction shrinks the range back through it. Where the destination is a
row the adapter won't allow to be selected the cursor still moves and
the range simply doesn't grow — the next press ranges across it. No
other keyboard multiselect and no checkbox rows. Which rows are
selectable is the adapter's
declaration, and select-all honours it — over the rows the view holds,
which in a host-paged view is the loaded page and not the whole space
(the frontend must not hold a capture's worth of rows to answer a
select-all).

**Columns live in the layer.** The panel declares an ordered column
set; the layer owns widths/resize, drag-reorder, the sort affordance
(sort execution stays with the panel/host), and the row template that
aligns cells to headers by construction — panels supply cell content
only, and that content is arbitrarily stylable. The header is
optional and a single column is legal, so tree-shaped views are
headerless one-column instances.

**Disclosures are real controls at the start of the row.** The
disclosure is a genuine `aria-expanded` button whose hit area is the
full row height and comfortably wide — the glyph is decoration inside
it, never the control itself. If the row is the toggle, there is no
separate expander control.

**Gridview keys are invisible to the global command dispatcher.**
The dispatcher's capture-phase listener fires before any panel
handler, so the layer marks its container and the dispatcher treats
focus-inside-a-gridview like its existing focus-inside-an-editable
suppression for the keys the grid consumes (unmodified navigation
keys, Space, F2, Tab, plus Ctrl/Cmd+A, Shift+Tab and Shift+Up/Down).
Escape is a narrower case: the dispatcher stands down on it only while
focus is inside a *row*, which is where the grid's way out means
something, and it fires normally on the container — so a context-gated
global Escape binding is reached by the second press rather than losing
the key. The grid makes that same editable-target exemption of its own:
a text field inside a row (a section's name, an event row's label)
keeps its keys, or the caret cannot be moved inside it, and a **focused button keeps Space** — that
is how a button is activated, so a grid claiming the press would fire
both the button and the panel's primary action. All other chords pass
through. The
keybindings view states each binding's context — global, in-gridview,
or per-panel action — so the suppression is legible to the user.

**Expansion persistence is the adapter's declaration**, normalized to
one idiom: sparse deviation-from-default, stable ids, junk-tolerant
parse, and the established element-config vs dockview-params split
(what the view means vs workspace state). Capture-scoped rows (the
chronological trace) keep ephemeral expansion.

**A shared filter slot, fuzzy only where the rows are client-held.**
The layer offers an opt-in filter: query → matching rows plus their
ancestors, ancestors auto-expanded. The fzf implementation applies
only to views that hold their full row space client-side (DBC, RBS,
transmit); paged views hold one page of a host-owned row space, so
they keep host-side narrowing — fuzzy-filtering them in JS would
require the whole dataset in frontend state, which the paged-model
rule forbids.

**Migrations change the base, not the layout.** Landing a panel on
the gridview preserves its columns, styling, and information layout;
what changes is the interaction (cursor, selection, keys, drag) and
the affordance corrections above.

## Why

- **Patched-five-times is the disease this cures.** Every
  capability added per-panel drifted; the scroll-math consolidation
  proved the shape of the cure and this generalizes it.
- **Headless, because the rendering layer is deliberately plural.**
  The two virtualizers exist for measured reasons; a base *component*
  would force one scroll model and re-fight that settled trade-off.
- **Stable ids, because indexes lie.** Row indexes recycle under
  scroll, sort, and refresh; every index-keyed interaction state was
  either already broken or one sort away from it.
- **Row-granular, because the consumers are trees and lists, not
  spreadsheets.** ARIA-grid cell navigation would collide with
  Left/Right's tree meaning and buys nothing the Tab rule doesn't.
- **Mouse-built multiselect, because there is no intuitive keyboard
  precedent** short of checkbox rows, which are unwanted chrome.
- **Columns centralized, because alignment by construction kills a
  shipped defect class** — a hand-built grid item once clipped its
  own row's control into unusability.

## Rejected alternatives

- **Per-panel patching** (add keys here, selection there). Explicitly
  rejected by the user; it is how the drift accumulated.
- **A rendering component ("the grid widget")** instead of a headless
  layer. Forces one scroll model onto views whose virtualizers
  differ for cause, and violates layout parity for the panels that
  are not tables at all.
- **ARIA-grid cell navigation.** See Why; also doubles the cursor
  state space for no consumer need.
- **Ctrl+arrows / Ctrl+Space multiselect.** A cursor that moves
  without the selection following it doubles the state the user has to
  track, for gestures with no mainstream-intuitive precedent without
  checkboxes; out by user ruling. Shift+Up/Down was ruled out with
  them and later ruled back in (2026-08-08) on the strength of the VS
  Code precedent — it needs no second cursor, since the selection
  follows the one that is already there.
- **Panel-owned columns.** Divergence and misalignment risk; the
  layer owning the row template is what makes alignment structural.
- **A universal search box.** The filter slot is opt-in; paged views
  cannot legally fzf client-side and pretending otherwise would hold
  capture-scale data in the frontend.

## Consequences

- The DBC panel's bespoke keyboard/selection code is the extraction
  seed and is deleted once that panel migrates; `traceTable.tsx` /
  `TraceHeader` seed the column half the same way.
- Decorative ARIA (tree roles with no behaviour) is replaced by the
  real thing as each panel migrates.
- Cross-panel drag payloads and drop semantics are a separate
  contract: [ADR 0045](0045-cross-panel-drag-payloads.md).
- The plot panel's signal side-list and the project-panel element
  list are not migrated yet; the single-column headerless shape is
  what they would land on if that is revisited.
