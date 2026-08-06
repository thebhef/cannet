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
depth}`. Branch expansion edits the row space (children appear and
disappear). A leaf with content expands in place — the content block
(a trace row's decoded signals, an RBS message's value table) grows
the row and adds no rows. There is no branch-with-content variant;
`kind` and content-expandability are orthogonal fields, so adding one
later is additive.

**Cursor and selection are separate, and the cursor is
row-granular.** One active row per gridview, keyed by id; the
container holds DOM focus and names the active row via
`aria-activedescendant` (row DOM nodes are recycled or absent in
paged viewports, so focus cannot live on them). The selection is a
separate id set with a click anchor. Both are ephemeral — never
persisted. There is no active cell: interactive content inside a row
is reached by Tab, not by the grid cursor.

**One key table for every gridview:**

| Key | Branch | Leaf with content | Plain leaf |
| --- | --- | --- | --- |
| Up/Down | move cursor (selection collapses to it) | ″ | ″ |
| Right | closed → expand; open → first child | closed → expand content; open → no-op | no-op |
| Left | open → collapse; closed → parent | open → collapse content; closed → parent | parent |
| Space | panel-defined primary action (default none) | ″ | ″ |
| Enter | unbound (user-customizable) | ″ | ″ |
| Home/End | first/last row | ″ | ″ |
| PageUp/Down | move cursor one viewport | ″ | ″ |
| Ctrl/Cmd+A | select all selectable rows | ″ | ″ |
| Tab | into the row's interactive content | ″ | ″ |

Space, not Enter, is the action key, and the action is the panel's
to define (transmit: send the focused message once); expansion is
already covered by Left/Right, so no default action is bound.

**Multiselect is mouse-built.** Plain click replaces the selection;
Ctrl/Cmd+click toggles a row; Ctrl+Shift+click *adds* the range from
the click anchor (noncontiguous selections accumulate); Ctrl/Cmd+A
selects all. No keyboard multiselect, no checkbox rows, and plain
Shift+click is unassigned. Which rows are selectable is the adapter's
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
keys, Space, Tab, Ctrl/Cmd+A). The grid makes that same
editable-target exemption of its own: a text field inside a row (a
section's name, an event row's label) keeps its keys, or the caret
cannot be moved inside it. All other chords pass through. The
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
- **Keyboard multiselect (Shift/Ctrl+arrows, Ctrl+Space).** No
  mainstream-intuitive precedent without checkboxes; out by user
  ruling.
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
