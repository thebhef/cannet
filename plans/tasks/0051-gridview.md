# Task 51 — Shared gridview interaction layer

**Status: planned (2026-08-05). First in the implementation order.**
Supersedes task 50 items 17 (keyboard
nav) and 18 (selection / multiselect / drag-and-drop), which grew
into one architectural effort: a shared tree/grid interaction layer
that every grid-like panel consumes instead of five per-panel
patches. Precedent: the shared scroll scaffold (`traceViewport.ts` +
`useTraceViewport`) from task 50 item 7, one layer up.

The design's ADRs are captured (user ruling 2026-08-05: "all ADRs
should get captured now", not at implementation start):
**ADR 0044** (gridview interaction base) and **ADR 0045**
(cross-panel drag payloads).

## Shape (strawman, being grilled)

The layer is **headless** — a hook plus a row-adapter contract, not a
rendering component. Two virtualizers exist deliberately
(`traceViewport` for beyond-height-cap counts; `dbcPanelViewport`'s
pixel-offset model where counts are bounded), and several consumers
don't virtualize at all, so interaction state (focus, selection,
expansion, keys, drag) binds to an **ordered row space of stable
string ids**; rendering and scrolling stay per-panel behind a small
adapter (`rowIdAt`, `indexOf`, `scrollToRow`, row kind/expandability).

Node model: a row is `{id, kind: branch | leaf, expandable, depth}`.
Branch expansion edits the row space (children appear/disappear).
Leaf-with-content expansion grows the row in place (the content
block) — it adds no rows. Both trace modes are leaf-with-content; the
DBC tree, RBS groupings and signal-view section headers are branches.

## Decisions

### D0. Visual parity — migrations change the base, not the layout (2026-08-05)

**No major layout changes to any migrated view.** The point of the
task is landing every grid-like panel on one sane base type; what a
panel looks like stays as it is. Each migration adds the layer's
*behavior* (cursor, selection, keys, drag) and may make the small
affordance corrections already ruled elsewhere (disclosure at the
start of the row, no redundant expander), but the columns, styling
and information layout of each view are out of scope. This is why
cell content must be arbitrarily stylable per panel (D1).

One affordance rule the layer owns everywhere: **disclosure carets
get a real hit target.** Historically the caret glyphs present a
tiny active area and are hard to click (user, 2026-08-05) — task 50
item 16's defect was exactly a glyph-sized button, clipped, inside a
drag source. The layer's disclosure control sits at the start of the
row and its hit area is the full row height and comfortably wide
(the glyph is decoration inside it), never a bare glyph span.

### D1. Consumer surfaces (2026-08-05)

**v1 migrates:** trace panel in both modes (chronological + by-ID),
signal view, event rows, DBC panel, RBS panel, transmit panel.

**Deferred, revisit after the gridview lands:** the plot panel's
signal side-list and the project-panel element list — both fine as
they are today. The design must not preclude them: cell content of
each leaf/branch must be arbitrarily stylable per panel, so the plot
side-list can later become a single-column, header-less instance of
the layer while keeping its existing look.

**Out:** the colormap table — it is a form (rows of inputs you Tab
through), not a gridview (rows you arrow around and select).

### D2. Focus and selection are separate (2026-08-05)

**Roving active row (stable id) + separate selection set + shift
anchor** — the model DbcPanel already proves in-repo, extracted
rather than invented. The container holds DOM focus and
`aria-activedescendant` names the active row (row DOM nodes are
recycled/absent in the paged viewports, so focus cannot live on
them). Plain Up/Down moves the cursor and collapses selection to it
(mainstream single-select-follows-focus). Rationale: multiselect
(item 18) is incoherent without a selection set distinct from the
cursor; the user wants intuitive, mainstream behavior. Keyboard
*multi*select is deliberately absent — see D4.

### D3. One key binding table (2026-08-05)

| Key | Branch | Leaf-with-content | Plain leaf |
| --- | --- | --- | --- |
| Up/Down | move cursor (selection follows per D2) | ″ | ″ |
| Right | closed → expand; open → step to first child | closed → expand content; open → no-op | no-op |
| Left | open → collapse; closed → go to parent | open → collapse content; closed → go to parent | go to parent |
| Space | **panel-defined primary action**; default none | ″ | ″ |
| Enter | **unbound** | ″ | ″ |
| Home/End | first/last row | ″ | ″ |
| PageUp/Down | move cursor by one viewport | ″ | ″ |
| Ctrl/Cmd+A | select all (D4) | ″ | ″ |
| Tab | **into the row/panel content area** (interactive descendants — inputs, buttons) | ″ | ″ |

- **Space, not Enter, is the action key**, and the action is the
  panel's to define — e.g. transmit: send the focused message once.
  Most panels will define none; expansion is already covered by
  Right/Left, so a default toggle action would be redundant.
- **Enter ships unbound.** Users can bind it themselves through the
  existing key-customization path; the layer reserves no meaning.
- **Tab enters content.** Interactive content inside rows (transmit
  value cells, RBS inputs, event-row buttons) is reached by Tab from
  the grid, not by the grid cursor. Exact Tab order is an
  implementation detail of each panel's adapter.
- Type-ahead search: out of v1 as speculative.

### D4. Multiselect is mouse-built (2026-08-05)

The complete v1 multiselect surface, per the user ("that's all the
behavior I want at the moment"):

- **Ctrl/Cmd+click** — toggle the clicked row in/out of the selection.
- **Ctrl+Shift+click** — *add* the target row and every row between
  it and the previously-clicked row (the anchor). Additive, so
  noncontiguous selections can be built and extended.
- **Ctrl/Cmd+A** — select all.
- Plain click replaces the selection with the clicked row.

No keyboard multiselect (no Shift/Ctrl+arrows, no Ctrl+Space, no
checkboxes) — the user knows no intuitive precedent for it and does
not want checkbox rows. Plain Shift+click is deliberately unassigned
in v1.

### D5. No branch-with-content in v1 (2026-08-05)

Dropped as speculative — no v1 surface needs a branch that also owns
a disclosed content block. The DBC message node's "details" mode is
taller cell content; the RBS message row maps to leaf-with-content
(its signal table is Tab-reached content per D3), terminal under
pure branches (bus/ECU); a signal-view section header's pattern
editor is a popover, not content. The row model keeps `kind` and
content-expandability orthogonal, so the variant is additive later;
only the UI affordance (the indented content disclosure) is skipped.

### D6. Migration order (2026-08-05)

**Signal view → by-ID → chrono trace → DBC → RBS/transmit.** The
signal view goes first: it is the surface item 18 exists for
(sections are unworkable by menu alone), it already holds both row
kinds in one paged host-arranged row space with stable canonical
ids, and its fixed-height unexpandable rows make it the smallest
surface exercising branch nav, selection and intra-panel drag. By-ID
adds leaf-with-content; chrono adds the live tail (and follows the
item 7 reopen settling); DBC deletes its bespoke keyboard/selection
code, which until then serves as the extraction spec.

### D7. Drag payloads and the drop matrix (2026-08-05)

**A drag payload carries signals and/or patterns together:**
`{signals: DraggableSignalRef[], patterns: string[], sourcePanelId?}`
— extending the existing `SIGNAL_DND_MIME` shape (`dragSignals.ts`).
The payload *kind* stays in the mime so targets can show valid-drop
feedback during dragover (data is unreadable until drop).

Drag sources compose:

- A **pattern chip** (in a section's pattern UI) drags that pattern,
  live.
- A **signal row** drags that concrete signal — even if it is only
  in the view as a pattern match (it lands at the target as a manual
  pick, per ADR 0020 materialize-on-touch).
- A **mixed selection** (Ctrl+click a pattern chip and some signal
  rows) drags both; each lands as what it is. Pattern chips are
  therefore selectable items in the same selection set as rows.
- A **section header** drags the whole unit: the section's assigned
  signals *and* its patterns.
- Dragged row ∈ selection ⇒ the whole selection drags (DbcPanel's
  existing convention). **Multi-item drag is in v1.**

**Patterns stay live across a drop** (Q6): dropping a pattern group
on a plot appends the patterns to the target area's ADR 0020
`patterns` list (onto empty plot space: a new area holding them). A
later DBC load feeds the plot exactly as it feeds the section.
Flatten happens only through the explicit materialize path, never by
drop.

The matrix:

| Payload ↓ Target → | Plot area | Transmit panel | Signal view | Signal-view section |
| --- | --- | --- | --- | --- |
| Signal(s) | add series *(exists)* | TX frame per distinct message *(exists)* | add to manual picks *(exists)* | add + assign to that section |
| Message (a by-ID/chrono row) | add all its signals as series | one TX frame | add its signals to picks | add + assign |
| Pattern(s) | append to area patterns, live | rejected (no concrete message set) | new section carrying the patterns | merge patterns into target section |

### D8. Drag within the signal view (2026-08-05)

- **Signal(s) dropped on a section (header or row span) → assign to
  that section.** Explicit assignment, so it wins over other
  sections' patterns (item 16's rule). This is the gesture that
  makes sections workable at scale.
- **Section-header drag dropped between sections → reorder (v1).**
  Edits the `names` array order; the pattern-claim tie-break follows
  the new visual order, preserving item 16's "priority is readable
  off the panel" property — and making it drag-editable.
- Disambiguation by payload + drop position: a header drag inside
  the panel reorders; the same header dragged out of the panel
  exports the whole unit — everything in the section, assigned
  signals and patterns alike (D7).

### D9. Row drag identity in the trace views (2026-08-05)

A line inside a row's expanded decoded block drags **that signal**
(already true today via `DecodedSignalCell`); the row itself —
expanded or not — drags **the message**. Same rule in both trace
modes (chronological and by-ID).

### D10. The layer's keys are invisible to the global dispatcher (2026-08-05)

The command dispatcher is a capture-phase `document` keydown
(`useCommands`), which fires before any panel handler — a global
chord on an arrow key would kill grid navigation silently. Rule,
owned by the layer: a gridview container marks itself, and the
dispatcher treats focus-inside-a-gridview like its existing
focus-inside-an-editable suppression (`keybindings.ts`) for the keys
the grid consumes — unmodified navigation keys (arrows, Home/End,
PageUp/Down, Space, Tab) and Ctrl/Cmd+A. All other chords pass
through unchanged.

### D11. Message-drop effects, and drops never duplicate (2026-08-05)

A message payload dropped on: a **plot area** — all the message's
signals added as series; **transmit** — one TX frame for that
message (what a whole-message signal drop already produces); the
**signal view / a section** — all its signals into manual picks,
assigned if dropped on a section. No confirmation dialog for wide
messages — the gesture says what it says, and remove is cheap.

**A single drop adds no duplicates.** A drag whose payload overlaps
itself (a message plus some of its own signals in one selection) or
overlaps the target's existing content lands each signal at most
once — `dedupeSignalRefs` at the payload edge plus the target's own
descriptor-key dedup (ADR 0020 manual-wins already gives the plot
this shape).

### D12. Keybindings UI must show each binding's context (2026-08-05)

With D3 (panel-defined Space actions) and D10 (grid-consumed keys
suppressed globally), a binding is no longer one global fact. The
keybindings/settings view must state each binding's context clearly
— global vs. in-a-gridview vs. per-panel action — so a user reading
the list can tell where a key applies and why a global chord does
not fire inside a grid.

### D13. State ownership and persistence (2026-08-05)

1. The layer owns cursor, selection and expansion, **all keyed by
   stable row id** — no index-keyed interaction state survives the
   migrations (indexes recycle under scroll/sort; ids don't).
2. **Cursor and selection are ephemeral** — never persisted
   (DbcPanel's deliberate choice, generalized).
3. **Expansion persistence is each panel's declaration**, normalized
   to the established idiom: sparse deviation-from-default, stable
   ids, junk-tolerant parse; element-config vs dockview-params per
   item 16's split (what the view *means* → element; workspace state
   → params). Chrono expansion stays ephemeral — its rows are
   capture-scoped.
4. **Selectable/expandable row kinds are the adapter's declaration**
   — Ctrl/Cmd+A selects only selectable kinds (DBC containers stay
   unselectable, as today).

### D14. A shared filter slot; fzf only where the rows are client-held (2026-08-05)

The layer grows an optional **filter slot**: a shared search-box
affordance plus one fzf-over-client-rows implementation — query →
matching rows + their ancestors, ancestors auto-expanded (DbcPanel's
existing pattern). DBC's and RBS's two hand-rolled fzf copies
collapse into it; transmit may opt in. Surfaced only where a panel
opts in — common framework, not a universal search box.

**Boundary:** the paged views (signal view, both trace modes) hold
one page of a host-owned row space; fuzzy-filtering them in JS would
need the whole dataset in frontend state, which the paged-model rule
forbids. They keep their host-side narrowing (filter predicates,
selection/patterns); the shared UI slot can host that later, but v1
wires no fzf there. A host-side fuzzy search would be its own task.

### D15. Row-granular cursor (2026-08-05)

One active row, never an active cell — Left/Right keep their D3 tree
meanings, and interactive content inside a row is reached by Tab.
Mainstream tree nav, not ARIA-grid cell nav.

### D16. Columns live in the layer (2026-08-05)

The base owns the column model: an ordered column set the panel
declares — widths/resize, drag-reorder, sort affordance (sort
execution stays host/panel-side) — and the row template that aligns
cells to headers **by construction**; panels supply cell content
only. Rationale: panel-owned columns are a divergence and
misalignment risk (user), and the misalignment class has already
shipped a defect (item 16's clipped move button in a hand-built grid
item). `traceTable.tsx` / `TraceHeader` — already shared by all
three paged views — is the extraction seed. **Header is optional and
one column is legal**: DBC, RBS and transmit migrate as headerless
single-column instances with arbitrary cell content (D0 look
preserved), the same degenerate shape the plot side-list would use
later.

## Slicing (agreed 2026-08-05)

Each slice lands test-first with the repo green; no consumer changes
visually until its own migration slice (D0).

### A. The base (no panel behavior changes)

1. Row-space contract + cursor math — pure module, unit tests
   (move/expand/collapse over branch+leaf spaces, id-keyed).
2. Selection model — pure: click-replace, Ctrl+click,
   Ctrl+Shift+click additive range, Ctrl/Cmd+A over selectable
   kinds, dedup. Unit tests.
3. `useGridview` container — the D3 key table,
   `aria-activedescendant`, D10 dispatcher suppression. DOM tests,
   including "a globally-bound arrow chord does not fire inside a
   grid".
4. Column framework — extract the `traceTable` row template into the
   layer; existing trace-view tests are the regression net (zero
   visual change).

### B. Reference migration — signal view

1. Cursor/keys/selection on the base (no drag). DOM tests.
2. Drag: selection payload (signals+patterns mixed), drop-on-section
   assign, header reorder (host `names` edit + tie-break test),
   pattern chips selectable/draggable, disclosure hit-target rule.
   DOM + Rust tests.
3. Receiving ends: plot area accepts pattern/message payloads (live,
   deduped); transmit accepts message. DOM tests.

### C. Remaining migrations (in order)

1. By-ID (leaf-with-content).
2. Chrono (live tail) — **gated on the item 7 reopen settling**.
3. DBC (bespoke keyboard/selection/fzf deleted into the layer +
   filter slot).
4. RBS (headerless single-column, fzf slot, Tab-into-content).
5. Transmit (Space = send-once action, grip reorder preserved).

### D. Finish

1. Keybindings-view context display (D12).

## Exit criteria

- One implementation; all six v1 surfaces consume it; the bespoke
  copies are deleted (DbcPanel's keyboard/selection, both fzf
  copies, the five expansion-state shapes).
- D3 nav + D4 multiselect work on every surface that declares them;
  the D7–D11 drop matrix is implemented; every cell has a
  failing-first test.
- Visual parity (D0): existing DOM tests stay green; Chromium
  measurement where jsdom cannot see layout (item 7's method).
- No regression on the ADR 0031 render-tier perf gate (the paged
  views are hot paths).
- Docs: ADRs 0044/0045 landed; the About/shortcuts panel reflects
  the new bindings; `docs/CONTEXT.md` gains the gridview terms; this
  file's deferred list survives into whatever tracks it next.

## Deferred (explicitly, not silently)

- Plot signal side-list and project-panel element list migrations
  (D1 — revisit once the gridview lands).
- Host-side fuzzy search for paged views (D14).
- Type-ahead search (D3).
- Keyboard multiselect and plain Shift+click (D4).
- Branch-with-content affordance (D5).

## Open questions (agenda)

(none — all resolved 2026-08-05.)

## Status log

### 2026-08-05 — A.1 row-space contract + cursor math

`apps/gui/src/gridviewRows.ts` + `gridviewRows.test.ts`. The row model
(`{id, kind, expandable, depth}`), the row-space contract
(`count`/`rowIdAt`/`indexOf`/`rowAt`/`isExpanded`), the full adapter
(`+ scrollToRow`/`setExpanded`/`isSelectable`), an array-backed row
space for the client-held panels, and `cursorAction` — D3's Up/Down,
Right, Left, Home/End, PageUp/Down as a pure key → action function.
17 tests over a tree fixture flattened per expansion set, so "a branch
expansion edits the row space, a leaf's content expansion does not" is
exercised rather than asserted. Suite: 111 files / 1272 tests green;
`pnpm build` green.

### 2026-08-05 — A.2 selection model

`apps/gui/src/gridviewSelection.ts` + `gridviewSelection.test.ts`.
`{ids, anchor}`, `selectableIdsInOrder`, `selectOnClick`
(click-replace / Ctrl+Cmd-click toggle / Ctrl+Shift+click additive
range from the anchor, anchor preserved across ranges), `selectAll`,
`collapseToCursor`. 15 tests. Suite green; `pnpm build` green.

### 2026-08-05 — A.3 `useGridview` container + D10 suppression

`apps/gui/src/useGridview.ts` + `useGridview.dom.test.tsx` (12 DOM
tests), plus `keybindings.ts` gaining `GRIDVIEW_ATTR`, `isGridviewKey`,
`isGridviewTarget` and `dispatchStroke`'s `inGridview` option (4 new
unit tests), wired in `useCommands`'s capture-phase listener.

The container holds focus and `aria-activedescendant` names the active
row — covered by a test that renders **zero** rows and still navigates,
which is the paged-viewport case the rule exists for. The suppression
test was falsified before being trusted: forcing `inGridview: false`
in the harness's dispatcher makes it fail, so it is testing the rule
and not the harness. Suite: 113 files / 1303 tests green; `pnpm build`
green.
