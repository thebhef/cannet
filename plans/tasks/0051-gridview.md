# Task 51 — Shared gridview interaction layer

**Status: implementation complete, pending human review (2026-08-05).**
Slices A–D are landed and the exit criteria are walked at the foot of
the status log. **One criterion is not met** — the ADR 0031 render-tier
perf gate reports a reproducible JS-heap regression against a same-day
pre-gridview control (see "D.4 perf gate"). Whether that blocks the
task or becomes its own slice is a review decision.
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

1. Keybindings-view context display (D12), which is also the
   "shortcuts panel reflects the new bindings" exit criterion.
2. Scrub any plans/task reference out of the ADRs and the sources
   this task added.
3. The ADR 0031 render-tier perf gate.
4. The exit-criteria sweep, recorded verdict by verdict.

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

### 2026-08-05 — branch setup

`task51-gridview-base`, cut from `gridview-commonization-plan`. The
planning-doc edits (task-51 drafts applied, tasks 51–53 put first,
task 53's theme decisions groomed) were **already committed** on the
parent branch as `e112033`, with a clean working tree — so no separate
`plan:` commit was made rather than duplicating that content.

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

### 2026-08-05 — A.4 column framework

`apps/gui/src/gridviewColumns.tsx` + `gridviewColumns.dom.test.tsx`.
`TraceHeader` and `contentWidthStyle` moved out of `traceTable.tsx`
into the layer as `GridviewHeader` (panel-declared `defs`, now
required) and gained `GridviewRow`, the row template: the grid
container, exactly one cell per visible column in the header's order,
and the tracks — which survive whatever `style` the panel passes.
`traceTable.tsx` keeps only trace cell content (`cellContent`,
`TraceTimeCell`). All three paged views migrated; the by-id header's
`byId` boolean became a general `label` override.

The old `traceTable.dom.test.tsx` (header drag-to-reorder) moved into
the layer's test file with the component. Suite: 113 files / 1307
tests green; `pnpm build` green; every pre-existing trace/by-id/signal
DOM test unchanged and green, which is the zero-visual-change (D0)
net.

#### Blockers / side effects

- **D16 "panels supply cell content only" — implemented as "panels
  supply the cell *element*, the layer supplies the slot, the order and
  the class".** `renderCell(key, className)` returns the element, and
  the layer wraps nothing. The reason is `TraceTimeCell`: that cell
  holds its own hover state to build the wall-clock `title` lazily, and
  the state has to live on the element carrying the handlers. Lifting
  it into a layer-owned wrapper would repaint the whole row on every
  pointer move over a virtualized table — a regression on the ADR 0031
  hot path — and nesting a second span inside a layer wrapper would
  change the rendered DOM, which D0 forbids. The alignment invariant
  D16 is actually after (one slot per visible column, in header order,
  in the header's tracks) is still structural and is what the new tests
  assert.
- **D13.4 "selectable *kinds* are the adapter's declaration" —
  implemented as a per-row predicate** (`GridviewAdapter.isSelectable`).
  Kind cannot express what the DBC tree already does: its message nodes
  are selectable *branches* while its bus / file / ECU nodes are
  unselectable branches. The predicate is the closest faithful reading;
  the row model itself stays exactly `{id, kind, expandable, depth}` as
  ADR 0044 specifies.
- **Selection follows *every* cursor move, not only Up/Down.** D2/D3
  spell the rule out for Up/Down and say nothing about Home/End,
  PageUp/Down or Right-into-first-child, which are cursor moves too.
  Applying it uniformly is the mainstream
  single-select-follows-focus behaviour; the alternative (a selection
  that survives Home but not ArrowUp) has no rationale in the
  decisions.
- **`traceColumns.ts` was left where it is.** The column *state*
  arithmetic there is already generic over the key set and already
  shared by the signal view, so D16's "columns live in the layer" needed
  only the header and the row template re-homed. Renaming the module
  would have touched 17 importers for no behavioural change; if the
  layer's file names are to be coherent, that rename is a standalone
  step.
- **A bug this slice introduced and the suite caught**: renaming
  `SignalRow`'s cell parameter to `key` shadowed the row's own
  `signalKey`, so the section menu was passed the column key instead of
  the signal. `SignalsPanel.sections.dom.test.tsx` failed immediately;
  the parameter is now `column`. Noted because it is evidence the
  regression net is doing its job, not a leftover defect.
- **The D10 DOM test drives a hand-wired dispatcher**, not
  `useCommands` itself, because no panel is on the layer yet and
  `useCommands` only exists inside `App`. The harness composes the same
  three real functions the provider composes (`dispatchStroke`,
  `isEditableTarget`, `isGridviewTarget`) and the one-line wiring in
  `useCommands` is what remains untested; the first panel migration
  (phase B) makes an end-to-end test possible and should take it.
  *(Taken in B.1 — see below.)*

### 2026-08-05 — B.1 signal view: cursor, keys, selection

Branch `task51-signal-view`, cut from `task51-gridview-base`.
`SignalsPanel` is the first gridview consumer: the host-arranged page
row space *is* the row space, with section headers as branch rows
(`sec:<name>`) and signal rows as plain leaves (`sig:<signalKey>`) one
level under them. The rows viewport carries `containerProps` — it holds
focus and names the active row — and every row carries its
`rowDomId`, `aria-selected` and a click that feeds `onRowClick`.
`.trace-row.selected` is the only new style.

`SignalsPanel.gridview.dom.test.tsx`, 8 DOM tests: the cursor over a
sectioned space, Left/Right walking out to a header and back in,
fold/unfold from the cursor, a flat (section-less) space where Left has
no phantom parent, click-replace / Ctrl+click toggle /
Ctrl+Shift+click range / Ctrl+A, and **the D10 end-to-end test the base
slice deferred**: a user-bound `ArrowDown` chord dispatched by the real
`useCommands` capture listener fires outside the panel and does not
fire inside its grid, while the grid's own cursor moves. Suite: 114
files / 1315 tests green; `pnpm build` green; every pre-existing
`SignalsPanel` DOM test unchanged and green (D0).

### 2026-08-05 — B.2 signal view: drag sources and intra-panel drops

Two commits. `6a4e780` lands the carrier and the pure pieces:
`dragSignals.ts` grows `patterns` on the payload plus the two kind
marker mimes a `dragover` reads (`DRAG_SIGNALS_MIME`,
`DRAG_PATTERNS_MIME`), with `setSignalDragPayload` deduping signals and
patterns at the edge (D11); `reorderSectionNames` in
`signalSelection.ts` is the `names` permutation a header drop makes; a
Rust test in `signal_snapshot.rs` proves the drag's permutation moves
the headers *and* the pattern-claim priority together; and `useGridview`
grows `extraSelectableIds`, the non-row selectable items D7's pattern
chips need.

The panel wiring: a signal row drags its concrete signal from the name
cell, a section header drags the whole unit (its assigned signals and
its live patterns) from its label, a pattern chip drags its pattern from
a grip in `SignalPatternEditor` — and any of them, when the grabbed item
is in the selection, drags the whole selection. Drops: signals onto a
section (header **or** any row in its span) are assigned there,
patterns merge into it, patterns onto the panel itself make a section
carrying them, and a header dropped on another header reorders. The
`.trace-disclosure` control took the D0 hit-target treatment (full row
height, ~1.3rem wide, glyph as decoration).

`SignalsPanel.dnd.dom.test.tsx`, 10 DOM tests over a real
`DataTransfer` round trip; 6 new unit tests in `dragSignals.test.ts`, 3
in `signalSelection.test.ts`, 1 in `useGridview.dom.test.tsx`, 1 in
`signal_snapshot.rs`. Suite: 115 files / 1333 tests green; `pnpm build`
green; `cargo test -p cannet-gui` green.

### 2026-08-05 — B.3 receiving ends

The plot area accepts pattern payloads: `parseDroppedSignals` carries
`patterns` through, `signalDrop` (the area surface *and* each signal
row) hands them to the area's `onSetPatterns`, deduped against what it
already has, and the rule stays live — the dropped pattern's matches
render as pattern-derived rows, not as materialized picks. The transmit
panel now gates on `dragHasSignals`, so a pattern-only payload is
refused during `dragover` (the only feedback the gesture can give) and
lands nothing.

Message payloads are handled *generically over the payload shape*, as
briefed: a message drag is a payload whose `signals` are the message's
signals, so the plot's per-area descriptor dedup and transmit's
group-by-`(id, extended)` already answer for it. The later phases that
add trace-row message drags add sources only, no receiving-end code.

3 new DOM tests in `PlotPanel.dom.test.tsx` (pattern append + no
flatten; merge without duplicating; a message payload's signals landing
once however the drop overlaps) and 2 in `TransmitPanel.dom.test.tsx`
(one frame per distinct message; the pattern payload refused). Suite:
115 files / 1338 tests green; `pnpm build` green; `cargo test -p
cannet-gui` 462 passed; `cargo clippy -p cannet-gui --all-targets`
clean.

#### Blockers / side effects

- **"Dropping patterns on empty plot space creates a new area" (D7,
  ADR 0045) is unreachable and was not built.** There is no empty plot
  space: ADR 0026's fit-to-panel rule means the derived axes always
  fill `.plot-panel-areas` (a flex column, `overflow: hidden`, no
  scroll list), so every point in the plot region belongs to some area.
  A container-level drop handler would also have to fight the area
  handlers, which deliberately do not stop propagation. Implemented the
  reachable half faithfully — patterns dropped anywhere in the plot
  land in the area under the pointer, live. If the "new area" gesture
  is wanted it needs a *surface* first (a drop strip under the stack,
  say), which is a layout change and therefore out of D0's scope.
- **A drag payload resolves only the selected rows that are on
  screen.** The row space is host-paged: the panel holds one page, so a
  selected signal row scrolled out of the page is an id with no
  `DraggableSignalRef` behind it. The payload builder resolves ids
  through the manual picks (which carry the full ref) and the rendered
  page, and silently omits anything it cannot resolve. In practice a
  multi-item drag is built by clicking rows you can see; the case that
  loses is Ctrl+A followed by a scroll and then a drag. Fixing it
  properly means a host command that resolves identities to refs — a
  slice of its own, not a quiet addition here.
- **Ctrl+A in the signal view selects the loaded page, not the whole
  row space** — the same paging fact from the other side:
  `selectableIdsInOrder` walks the row space through `rowIdAt`, which
  is `null` for rows whose page has not landed. Consistent with the
  paged-model rule (the frontend must not hold the whole dataset); the
  honest fix is again host-side.
- **`useGridview` grew `extraSelectableIds`.** D7 requires pattern
  chips to be "selectable items in the same selection set as rows", and
  chips are not rows of any scrolled row space — they live in a popover
  over a header. The adapter cannot express them, so the option
  appends non-row ids to the selection order; they take part in
  clicks, ranges and Ctrl+A, and not in the cursor. This is the
  smallest change that implements D7 rather than dropping it.
- **A section header drag carries its *explicit* members plus its
  patterns, not its pattern-claimed rows.** "The section's assigned
  signals *and* its patterns" (D7) reads naturally as exactly that: the
  assignments the panel holds, and the rules that collect the rest —
  which travel live, so the target re-collects them itself. Flattening
  the claims into the payload would be the flatten-on-drop ADR 0045
  forbids.
- **A multi-header selection reorders by one header.** Dragging with
  several section headers selected exports all their units (the payload
  is the union), but the intra-panel reorder moves the header the
  pointer grabbed, since `names` order is a single insertion point. The
  decisions say nothing about multi-section reorder; this is the
  closest reading that is not an invention.
- **Pattern chips are draggable in the view-level selection editor
  too**, not only in a section's popover. D7 names "a pattern chip (in
  a section's pattern UI)", but the two editors are one component
  (`SignalPatternEditor`) and a view-level pattern is the same kind of
  live rule; wiring one and not the other would have been an arbitrary
  asymmetry in the same widget.

### 2026-08-05 — C.1 gate: task 50 item 7 is settled

Verified before starting the chronological migration, as D6 requires.
Item 7 was reopened on 2026-08-05 (`ef8af87`) and closed by two fixes,
both on `main` under this branch: `4ae4211` (#175, the anchor bound over
plain rows) and `27d51e3` (#179, the second pass — `TraceView` never
passed `variable` to the shared scaffold, so the anchor bound, the
scroll spacer and the sticky viewport's height were all computed as if
every row were `ROW_HEIGHT`). The task-50 file records the diagnosis, a
falsification of each of the three consequences separately, and a
Chromium table with expanded rows at the tail (chrono before: last
reachable row 997 of 1000, 108 px past the fold, `scrollHeight`
unchanged by expanding; after: row 999 with 7 px of slack and
`scrollHeight` +108). Read against the code today: `TraceView` derives
`rowHeightAt` / `extraHeight` and hands them to `useTraceViewport`, maps
scroll↔anchor through the one `anchorFromScroll` / `scrollForAnchor`
pair, and sizes the sticky viewport from the stack. The regression net
is `TraceView.anchor.dom.test.tsx`'s "expanded tail reachability" (three
cases) plus `traceViewport.test.ts`'s tail-bound invariants. Settled —
the migration proceeded, and those tests stayed green throughout.

### 2026-08-05 — C.1a by-ID on the gridview

`2c8b307`. `ByIdTable` is the first leaf-with-content consumer: the
host-sorted snapshot *is* the row space, every row a leaf that is
expandable exactly when it has a decode, keyed by the same stable
`byIdRowKey` the fold set already used — so the cursor, the selection
and the expansion name one thing. Right discloses the decoded block and
Left retracts it, adding no rows. The layer wants `setExpanded(id,
want)` where the panel offers a toggle, so the adapter asks for the
toggle only when the two differ.

Drag identity (D9): the row is the source for its whole message, a line
inside the expanded block still drags that one signal, and a grab on a
row that is in the selection carries every selected row's message —
resolved in the `dragstart` handler, so the scroll path pays nothing.
`ByIdTable.gridview.dom.test.tsx`, 10 DOM tests. Suite: 116 files / 1348
tests green; `pnpm build` green; every pre-existing `ByIdTable` /
`TracePanel.byIdCollapse` test unchanged and green (D0).

### 2026-08-05 — C.1b chronological on the gridview

Four commits.

`f2ba825` — the adapter grows an optional `selectionOrder()`. The
layer's default is `selectableIdsInOrder`, which walks `count` on every
click and every Ctrl+A; a chronological trace's `count` is the whole
capture. A panel that can answer is taken at its word.

`27d0e96` — the chronological expansion set stops being a set of
*display indices*. A display index names a different frame the moment
the window slides or an event interleaves, so the open row was whatever
later landed in the slot; it is now `Map<rowId, signals>` keyed by the
frame's absolute index in the capture (`f:<index>`) or the event's own
id (`e:<id>`). The signal count travels with the id because the scroll
geometry needs the height of *every* open row and a row scrolled out of
the loaded page can no longer be asked — so `expandedExtraHeightOf`
sums the open rows' signal counts instead of walking indices through a
`rowHeightAt`. Falsified: keying the toggle and the position derivation
by `absoluteIndex` fails two of the three new identity tests.

`0a39c4a` — a bug the migration surfaced, fixed in the layer: the grid
binds the navigation keys on the container, so a text field inside a
row (a section's name in the signal view, an event row's label here)
lost the caret to the cursor. The layer now makes the same
editable-target exemption the global dispatcher does.

`53d3f99` — the migration itself. Frames and events alike are leaves in
one row space; an event row takes part in the cursor but not the
selection (it is not a message). `indexOf` scans the render window and
`selectionOrder` answers with the page the view holds, since the space
is millions of host-paged rows. That exposed one gap in the layer:
`moveCursor` re-derived the target's index through `indexOf` before
scrolling, and the row it scrolls *to* is by definition one the panel
does not hold — so `cursorAction` now carries the index it already
computed, and Home / End / PageUp / PageDown move the window instead of
stranding the cursor off-page. The live pin is released only when a
cursor move actually has to move the window (arrowing inside the tail on
screen leaves it following), the same rule the wheel follows.
`messageDragRefs` moved into `dragSignals.ts`, since both trace modes
now build the same message payload.

`TraceView.gridview.dom.test.tsx`, 12 DOM tests; 1 new in
`useGridview.dom.test.tsx` for the paged selection order, 1 for the
editable exemption; `gridviewRows.test.ts`'s move assertions now read
the index through a `move(space, id)` helper rather than hand-computed
numbers. Suite: 117 files / 1362 tests green; `pnpm build` green. No
host code was touched, so no Rust run was needed.

**Receiving ends: no gap found.** B.3 built them generically over the
payload shape, and a message drag is a payload whose `signals` are the
message's signals — so the plot's per-area descriptor dedup, transmit's
group-by-`(id, extended)`, the signal view's `addKeys(dedupeSignalRefs)`
and a section's `dropOnSection` all already answer for it, deduped at
the payload edge (D11). These slices added drag *sources* only.

#### Blockers / side effects

- **The by-ID row keeps its own tab stop and its Enter / Space toggle**,
  which ADR 0044 would put on the container with Enter unbound. That
  affordance shipped in `2c1949a` (the row *is* the disclosure, no
  caret) and its tests are part of D0's "existing DOM tests stay green".
  The two coexist: the row does not stop propagation, so the grid's keys
  still reach the container by bubbling, and a click on a row that is
  *not* a focus target (nothing to disclose) hands the keyboard to the
  grid instead. Where the two rules disagree, D0 won.
- **Clicking a trace row both selects it and toggles its disclosure.**
  In both modes the row is the disclosure control, so a plain click now
  does two things. Keeping the disclosure off the click would have meant
  a separate control, which D0 and `2c1949a` both rule out.
- **The chronological row space's ids exist only where the page has
  landed**, so `indexOf` scans the render window. A cursor that has
  scrolled out of that window is out of the space, and the next
  navigation key restarts it at the first row of the capture — the
  layer's documented restart rule, which at the live tail also releases
  the pin. Clicking a row places it again. Making this better needs the
  host to answer "the id at index N", which is a slice of its own; the
  alternative considered and rejected was remembering the cursor's last
  index, which silently names a different row once the window's head
  advances.
- **Ctrl+A in either trace mode takes the loaded page, not the whole
  space** — the same paged-model fact recorded for the signal view in
  B.2, now stated by the adapter (`selectionOrder`) instead of
  discovered by a walk. A multi-row drag likewise resolves only the
  selected rows the view still holds.
- **A stale open row over-sizes the scroll spacer.** The old
  index-keyed `expandedExtraHeightOf` dropped indices past the end; the
  id-keyed form has no index to test, so a frame that was open when the
  ring buffer truncated it away keeps contributing its signal lines to
  the spacer until the trace is cleared (which resets the whole set).
  Bounded by what the user expanded, and pruning it honestly would need
  the id→index map the previous point says the frontend cannot have.
- **Row-memo stability is maintained but not directly tested.** The hook
  returns fresh callbacks every render (its adapter moves with the
  window), so both trace views read the live gridview through a ref and
  hand the memoised rows stable handlers — otherwise every visible row
  would repaint on every live tick, on the hottest ADR 0031 path. There
  is no per-row render counter to assert against, and adding one would
  put a `diagCount` call on the very path it protects; the existing
  "renders once per live tick" test covers the component, not the rows.
- **`cursorAction`'s move action changed shape** (it carries `index`).
  Twenty assertions in `gridviewRows.test.ts` now build the expectation
  through a `move(space, id)` helper, so the indices come from the
  independently-tested `indexOf` rather than from hand-counting.

### 2026-08-05 — C2.0 the filter slot (D14)

Branch `task51-dbc-rbs-transmit`, cut from `task51-trace-views`.
`143f241`. `apps/gui/src/gridviewFilter.tsx` + `gridviewFilter.test.ts` +
`gridviewFilter.dom.test.tsx`: `GridviewFilterEntry`
(`{id, ancestors, haystack}`), `lazyGridviewMatcher`, `gridviewMatches`,
the `useGridviewFilter` hook (debounce, `effectiveExpanded`) and the
`GridviewFilterBox` affordance. The DBC panel's copy is the spec, so the
two properties a naive `fzf.find` lacks came across with it: the index is
built lazily — nothing is paid until the user types, and then once — and
results are cut at `MIN_RELATIVE_SCORE` of the top score, because fzf
accepts any subsequence and a tree shows every match with equal
prominence.

Client-held rows only, per D14's boundary. 5 unit tests + 3 DOM tests.
Suite: 119 files / 1370 tests green; `pnpm build` green.

The score-floor test **failed first for a real reason**: the initial junk
fixture was a good enough match to clear the floor, so the assertion was
proved to bite before the fixture was replaced with the user-reported
shape (a module summary carrying p-r-e-s-s-u-r-e scattered across
words).

### 2026-08-05 — C2.1 DBC on the gridview

`8adec42`. The panel that *was* the extraction spec now consumes the
layer: **+186 / −326 in `DbcPanel.tsx`, a net −140 lines** (1555 → 1415).
Deleted — the `activeId` cursor and its scroll effect, the `selection`
set with `selectionAnchorRef`, `onTreeKeyDown`'s whole key table, the
local `selectableIdsInOrder`, and `SearchEntry` / `MIN_RELATIVE_SCORE` /
`FILTER_DEBOUNCE_MS` / `lazyMatcher` / `searchMatches` / the debounce
effect / `domRowId`.

The flattened tree is the row space (`arrayRowSpace` over
`gridviewRowsOf(rows)`); `isSelectable` is the per-row predicate the A.4
deviation exists for, because a message node is a *selectable branch*
while bus / DBC / ECU nodes are unselectable ones. "Details" stays taller
cell content, so no row is a leaf-with-content (D5). `idPrefix:
"dbcnode"` keeps the row DOM ids byte-identical to what
`aria-activedescendant` named before.

The 41 pre-existing DBC DOM tests were the net; 39 passed unchanged and
the two that did not are the two behaviours ADR 0044 deliberately
changes (below). 4 new tests: Ctrl/Cmd+A over selectable rows only,
Home/End, the gridview marker, and the disclosure being a real control.
Suite: 119 files / 1374 tests green; `pnpm build` green.

#### Blockers / side effects

- **Two DBC behaviours changed, and their tests with them.** Plain
  Shift+click no longer range-extends — D4 assigns the additive range to
  Ctrl/Cmd+Shift+click and leaves plain Shift+click deliberately
  unassigned — and Enter is unbound, with the selection following the
  cursor instead. D0 protects each panel's *layout*, not the interaction
  the task exists to replace, so these were re-specified rather than
  preserved: the old tests became "Ctrl+Shift-click adds the range" (with
  a plain-Shift-replaces assertion) and "ArrowDown / ArrowUp move the
  active row, and the selection follows it".
- **`buildRows` stopped taking the selection.** Selection now follows
  every cursor move, so folding it into the row objects would allocate a
  fresh `RenderRow` for every row on every arrow press and defeat
  `DbcRow`'s memo — the exact thing task 41's "re-renders only the rows
  whose props changed" test guards. The highlight is a per-row prop, and
  `handleDragStart` resolves the selection and the row list through refs
  at drag time (the ByIdTable pattern) so it, too, keeps a stable
  identity. That memo test passes unchanged.
- **The diagnostic counter was renamed** `dbcpanel.searchIndexBuild` →
  `gridview.filterIndexBuild`, since the index build is the layer's now.
  Nothing outside `DbcPanel.dom.test.tsx` referenced it.
- **The caret is now a `<button>`, and childless rows keep an empty span
  in the same slot.** ADR 0044's hit-target rule; `min-width` went from
  0.8rem to 1.1rem, the one deliberate pixel change in this slice. It
  carries `tabIndex={-1}`: a disclosure is not row content, so Tab must
  not stop on every caret in a large tree.

### 2026-08-05 — C2.2 RBS on the gridview

`f0eeb6f`. Buses and ECUs are branches; a message row is a **leaf with
content** — its signal table discloses in place and adds no rows, which
is D5's reading of this surface. Selection stops at message rows. The
second fzf copy is deleted into the filter slot, so RBS gains the
debounce, the score floor, and ancestors-of-matches read as expanded — a
hit inside a bus the user had closed is now on screen instead of behind
a fold.

`RbsPanel.gridview.dom.test.tsx`, 7 DOM tests (tree walk + selection
stopping at messages, Left/Right over a branch, Right disclosing content
without adding rows, the editable-target exemption inside a value cell,
the filter pruning to matches + their path, a match's ancestors reading
as expanded, the gridview marker). The 15 pre-existing `RbsPanel` tests
are unchanged and green. Suite: 120 files / 1381 tests green; `pnpm
build` green.

#### Blockers / side effects

- **"Headerless single-column instance" (D16) is implemented as *no
  header and no column tracks*, not as a one-column `GridviewRow`.** The
  column framework exists to align cells to headers by construction; with
  one column there is nothing to align, and wrapping each RBS row's
  content in a layer-owned grid container would change the rendered DOM,
  which D0 forbids. The same reading was taken for the DBC panel and for
  transmit. The degenerate shape is real — one implicit column, the row
  *is* the cell — it simply needs no component.
- **The DOM stays nested.** `.rbs-bus` / `.rbs-ecu` / `.rbs-message`
  wrappers carry the tree's indentation in CSS, so flattening the render
  to match the flat row space would have been a layout change. The
  gridview is headless, so the two coexist: one `buildVisibleTree` pass
  feeds both the nested renderers and `flattenRbsRows`, which is what
  keeps them from disagreeing about what is on screen.
- **Filtering now prunes buses, not just ECUs.** The old copy kept every
  bus row visible whatever the query matched; the slot's
  ancestors-of-matches rule removes a bus with no match in it, as the DBC
  tree already did. There was no test on the old behaviour — the RBS
  panel had no filter test at all — so this is a deliberate convergence,
  not a silent regression.
- **`PAGE_ROWS` is a constant (12).** The panel is not virtualized and
  has no measured row geometry, so PageUp/PageDown move a fixed count
  rather than a true viewport's worth. Measuring would mean adding a
  `ResizeObserver` for one key binding.
- **`scrollToRow` is hand-rolled, not `scrollIntoView`.** The layer's
  contract is "bring this row into view", and `scrollIntoView` cannot be
  told to leave an already-visible row alone — arrowing inside the
  viewport would jerk the list on every press. The rect arithmetic is
  also a no-op under jsdom (all-zero rects) rather than a `TypeError`,
  which is how the first draft failed.

### 2026-08-05 — C2.3 transmit on the gridview

`b626860`. The first panel to define D3's primary action: **Space sends
the cursor's frame once**, gated exactly like the row's own send button
(an unconnected bus has nothing to send to). Each frame is a leaf whose
expanded face is disclosed content. The grip drag-to-reorder is
untouched, and the byte / value / bus-picker controls stay Tab-reached.

Expansion moved out of `TransmitFrameRow`'s `useState` up to the panel,
keyed by frame id (D13.1). The old boolean belonged to the tile
*position*, so a reorder carried an open face onto whatever frame moved
into the slot. Persistence is unchanged: there was none, and there still
is none.

6 new DOM tests appended to `TransmitPanel.dom.test.tsx` (cursor +
selection over the tiles, Space sending the cursor's frame, Space
refused on an unconnected bus, Right disclosing without adding rows,
click-on-background-toggles vs click-on-control-only-moves-the-cursor,
the gridview marker) plus 1 in `useGridview.dom.test.tsx`. The 25
pre-existing transmit tests are unchanged and green. Suite: 120 files /
1388 tests green; `pnpm build` green. No host code was touched, so no
Rust run was needed.

#### Blockers / side effects

- **The layer changed: a focused button keeps Space.** `isEditableTarget`
  covers inputs, textareas, selects and contenteditable — not buttons —
  and a button is activated by Space. With a panel-defined Space action
  and a send button *inside* the grid, the press would have fired both.
  Added `isActivatableTarget` in `keybindings.ts`, applied in
  `useGridview`'s Space branch only (arrows over a focused button should
  still navigate), and **ADR 0044's suppression paragraph now states the
  rule** — it is a durable decision, not an implementation detail.
- **"Expansion follows the frame, not the slot" is asserted only
  indirectly.** The intended test — expand a tile, drag it past its
  neighbour, watch the open face travel — cannot run against the existing
  harness: its mock element registry records `update` patches into a
  local variable and never re-renders, so a reorder is invisible in the
  DOM. Replaced with the click-target test, which is genuinely new
  behaviour; the id-keying itself is structural (the state is a
  `Set<frameId>` in the panel) rather than observable here.
- **Transmit did not opt into the filter slot.** D14 says it *may*; the
  slice's scope names the action key and the reorder, and the panel shows
  a handful of tiles where a fuzzy search buys nothing yet. The slot is
  one hook call away if that changes.
- **No perf-harness run.** ADR 0031's render-tier gate is 51.D's, per the
  brief; the three panels in this slice are not on the paged hot path,
  and the DBC panel's two in-suite bounds (the memo criterion and the
  viewport-bounded window) both stayed green.

### 2026-08-05 — D.1 the plans reference in the sources

Branch `task51-finish`, cut from `task51-dbc-rbs-transmit`. `2ffb9f8`.
One line: `SignalsPanel.tsx`'s section-drop comment cited "item 16's
rule", a task-file item number, which the working agreement forbids in
source — plan docs track state and churn, so a code reference to them
rots. The rule it names (an explicit assignment beats every other
section's pattern claim) is stated in ADR 0045, which the comment now
cites.

The sweep behind it: `git diff c2b845c...HEAD` filtered to *added* lines
matching `plans/|task N|task-N|item N` across `apps/gui/src` and
`apps/gui/src-tauri` returned exactly that one line. The other hits in
those files (`signal_snapshot.rs`'s "item 16 defect", `DbcPanel`'s task
20 / 33 / 41 notes, `PlotArea`'s task 15 / 0030) are all pre-existing and
were left alone — cleaning them is not this task's, per the
surgical-changes rule. **ADRs 0044 and 0045 needed no scrub**: the same
grep over both files returns nothing.

### 2026-08-05 — D.2 keybindings-view context display (D12)

`5cdf53a`. `chordSuppressedInGridview` in `keybindings.ts` is the
declaration-side counterpart of `isGridviewKey`: `dispatchStroke` decides
per *stroke*, and the view has to state the fact per *chord*, before any
key is pressed. A sequence counts as suppressed if any step is a key the
grid takes — that step can never arrive there, so the chord can never
complete.

Its test proves it against `dispatchStroke` itself over eleven chords
rather than restating the key set, so the marker cannot drift from the
suppression it explains; each case also asserts the chord *does* fire
outside a grid, so a typo in the stroke fails instead of passing quietly.

In `ShortcutsPanel`: every binding chip now carries its context as a
`title` (global, or global-except-in-grids) and the suppressed case shows
a visible "not in grids" marker. Two read-only sections follow the editor
in the existing fieldset/legend idiom (D0: no redesign) — **In a grid
view**, which is ADR 0044's key table with Enter listed as unbound and
bindable above, and **Panel actions**, which names transmit's Space. 2
unit tests, 3 DOM tests. Suite: 120 files / 1393 tests green; `pnpm
build` green.

#### Blockers / side effects

- **The shortcuts panel is where this landed, not the About panel.** The
  exit criterion says "the About/shortcuts panel reflects the new
  bindings"; `AboutPanel` documents the version and the third-party
  licenses and has never documented a shortcut, while `ShortcutsPanel` is
  the panel a user opens to read and change bindings. Adding a key table
  to About would have put the same content in two places.
- **The panel-actions list is hand-kept.** The primary action is an
  argument each panel passes to its own `useGridview` call, so there is
  no central registry to read it off, and building one for a single
  entry (transmit) would be an abstraction for single-use code. Noted at
  the declaration so the next panel that defines one knows to add it.
- **No default binding is currently suppressed**, so the marker is
  exercised only by a user-added chord — which is exactly the case that
  needs explaining. The DOM test injects `ArrowDown` onto `capture.clear`
  to reach it. `Alt+←`, `Alt+→` and `Ctrl+Tab` are *not* suppressed
  (modified navigation keys are global chords), which the unit test pins.

### 2026-08-05 — D.3 exit-criteria sweep

Verified by inspection of the tree at `5cdf53a`, criterion by criterion;
the verdicts are the table at the foot of this entry group.

- **Six surfaces on one implementation.** `SignalsPanel`, `ByIdTable`,
  `TraceView`, `DbcPanel`, `RbsPanel` and `TransmitPanel` are the six
  files that both call `useGridview` and carry the `data-gridview`
  marker; no seventh, and no surface carries the marker without the hook.
- **Both fzf copies are gone.** `import { Fzf }` survives in exactly two
  files: `gridviewFilter.tsx` (the slot itself) and
  `settingDescriptors.ts` (the settings-search index, never a gridview
  and out of D14's scope). The DBC and RBS hits are prose in comments.
- **DbcPanel's bespoke code is gone.** `onTreeKeyDown`,
  `selectionAnchorRef`, `SearchEntry`, `MIN_RELATIVE_SCORE`,
  `lazyMatcher`, `searchMatches` and `domRowId` return no hits outside
  `settingDescriptors.ts`'s own search index.
- **The five expansion-state shapes are one idiom.** Every surviving
  expansion state is keyed by a stable string: `ReadonlySet<string>`
  (by-ID, DBC, RBS, transmit) or `ReadonlyMap<string, number>` (chrono,
  id → signal count, per C.1b). No index-keyed expansion remains.
- **`docs/CONTEXT.md` carries the gridview terms** — Gridview, branch
  row, leaf (and leaf-with-content), cursor, selection.
- **The deferred list was left untouched**, as briefed: where it goes
  next is a review decision.

### 2026-08-05 — D.4 perf gate: a JS-heap regression, controlled

**Run.** Release build via `pnpm --dir apps/gui tauri build --no-bundle`
(a plain `cargo build --release` is not a substitute — without the
tauri CLI's `custom-protocol` feature the binary still points at the dev
server). Scenario matched to the committed baseline exactly: `ev-zonal`,
`--connect-on-start`, `--perf-capture-secs 60`, `--perf-interact scrub`,
against the two PEAK adapters. Gate:
`cannet-perf-measurement --frontend-report <abs> --expected-rx-fps 1608
--expected-tx-fps 1608 check`. No baseline was promoted — the run is a
comparison against the committed `baseline.json`, and promoting one
would have hidden what it found.

**Result: `check FAILED`, one gated metric.** Every host tier
(`tracebuffer`, `grpc`, `hardware-peak`) ok. The whole frontend CPU tier
is *better* than baseline: `longtask_ms_per_s_mean` 1.30 → 0.00,
`lag_ms_max` 27.1 → 15.0, `jank_fraction` 0.017 → 0.000,
`flush_ms_mean` 3.30 (limit 25), `tx_late_ms_mean` 3.74 (limit 18),
`rx_fps_expected` 1606.6 and `tx_fps_expected` 1608.7 against 1608.
`rx_gap_p95_ratio_worst` 1.199 vs 1.196. The one failure:

| metric | baseline | current | limit | result |
| --- | --- | --- | --- | --- |
| `jsheap_mb_drift_per_min` | 5.693 | 29.171 | 16.386 | **REGRESSED** |

`jsheap_mb_peak` 98.2 (limit 207.2) and the other three memory tiers
passed, but all read high: `renderer_mb_peak` 319.3 → 380.7,
`tree_mb_peak` 743.3 → 816.5.

**The drift metric is a least-squares slope over a sawtooth, so it was
not trusted on one run.** Two experiments:

1. *Variance.* A second capture on the identical binary: slope 28.28,
   mean 58.37, max 103.9. Reproducible, so not run-to-run noise.
2. *Control.* The committed baseline was captured on 2026-08-03 on a
   possibly different machine state, so the pre-gridview merge base
   (`c2b845c`) was checked out, built the same way, and captured twice
   **the same day on the same machine**.

| capture | build | jsheap mean | max | slope/min |
| --- | --- | --- | --- | --- |
| `baseline.json` (2026-08-03) | pre-gridview | 47.70 | 71.6 | 5.69 |
| control run 1 | `c2b845c` pre-gridview | 48.94 | 79.0 | 10.21 |
| control run 2 | `c2b845c` pre-gridview | 48.37 | 79.7 | 9.62 |
| gridview run 1 | `5cdf53a` | 61.19 | 98.2 | 29.17 |
| gridview run 2 | `5cdf53a` | 58.37 | 103.9 | 28.28 |

Tight within each group, cleanly separated between them.
**Conclusion: the gridview raises JS-heap pressure on the paged hot
path — mean +~11 MB, peak +~22 MB, slope ~2.9× the same-day control.**
The control also shows the machine reads ~1.8× the committed baseline on
this metric today, which is why the control and not `baseline.json` is
the comparison the conclusion rests on. All four captures are committed
under `docs/performance-measurements/frontend/` as the evidence.

**It is not extra renders.** The per-second render counters are within a
few percent across control and gridview — `render.ByIdTable` 30.35 vs
31.20, `render.TraceView` 10.67 vs 10.83, `render.SignalsPanel` 14.60 vs
14.83, `render.PlotArea` 113.4 vs 114.4 — and no `DbcPanel` / `RbsPanel`
counter appears at all, so those two panels are not open in this
scenario and are not implicated. The panels render at the same rate and
allocate more per render.

**Leading hypothesis, *not* promoted to a root cause — no experiment has
falsified it yet.** `GridviewRow` wraps every cell in a `<Fragment
key=…>` so the panel's `renderCell` need not carry the key, where the
pre-migration row put the key on the panel's own `<span>` and allocated
no wrapper. That is one extra React element per cell per row per render
on the three paged tables, which is the right order of magnitude for the
observed delta. Second candidate: the per-row identity strings the
parent now computes for every visible row on every render
(`byIdRowKey(...)` for the `selected` prop, `rowDomId(...)`'s
`encodeURIComponent` for the DOM id). Both are cheap to test by
building a variant that skips them and re-capturing.

#### Blockers / side effects

- **The exit criterion "no regression on the ADR 0031 render-tier perf
  gate" is NOT met, and no fix was attempted in this slice.** A perf fix
  is a scope expansion on a finishing slice, and the working agreement
  says to split rather than sprawl: it needs its own before/after
  numbers, touches the layer and three panels, and the cause above is
  still a hypothesis. Recording it here — not in `plans/backlog.md`, per
  the brief — so the review decides whether it blocks the task or
  becomes the next slice.
- **`target/release/cannet-gui.exe` was rebuilt from this branch after
  the control run**, so the checked-out binary matches the branch again.
  The control build was made on a detached `c2b845c` and the branch was
  restored immediately after; no history was modified.
- **No Chromium layout measurement was taken**, so the D0 criterion's
  second half is unmet in the strict reading — see the verdict table.

### 2026-08-05 — exit-criteria verdicts

| Criterion | Verdict |
| --- | --- |
| One implementation; six surfaces consume it; bespoke copies deleted | **Met** — verified by the D.3 sweep above. |
| D3 nav + D4 multiselect where declared; D7–D11 drop matrix; failing-first tests | **Met with deviations recorded** — every slice landed test-first; the deviations are the per-slice blocker lists, chiefly the unreachable "patterns on empty plot space → new area" cell (B.3), Ctrl+A and multi-item drag reaching only the loaded page in the three paged views (B.2, C.1b), and by-ID keeping its own Enter/Space toggle where D0 outvoted ADR 0044 (C.1b). |
| Visual parity (D0): DOM tests green; Chromium where jsdom can't see layout | **Met with deviation** — every pre-existing DOM test stayed green through every slice, and the deliberate pixel changes are enumerated (the DBC caret 0.8→1.1 rem, the `.trace-disclosure` hit target, `.trace-row.selected`). **No Chromium measurement was taken**: D16's alignment invariant is structural — one cell per visible column, in header order, in the header's tracks — and that is what the A.4 tests assert. What stays unmeasured is that CSS grid resolves those tracks identically to the hand-built rows. |
| No regression on the ADR 0031 render-tier perf gate | **Met** (2026-08-06, after 51.E) — the regression was localized to `RbsPanel` by layout ablation and fixed by interning the tree's row identity (`6e611c0`). `cannet-perf-measurement check` passes on both post-fix captures, 31/31 metrics: `jsheap_mb_drift_per_min` 9.91 and 2.29 against the 16.39 limit, where the unfixed build read 20–29. Across six runs per build the fixed build's mean JS heap is 50.3 MB against a same-day control's 47.9 (eight runs), inside the control's own spread; the unfixed build read 60.3. Long-task and jank stayed at zero. See the 51.E entries. |
| Docs: ADRs 0044/0045 landed; shortcuts panel reflects the bindings; CONTEXT.md gains the terms; deferred list survives | **Met** — both ADRs are in `docs/adr/` and carry no plans/task reference; the shortcuts panel gained the key table and the per-binding contexts (D.2); `docs/CONTEXT.md` carries the gridview terms; the deferred list is untouched. |

### 2026-08-06 — 51.E the heap regression: cause found in the RBS panel

An unplanned fix phase for the one exit criterion D.4 left unmet.
Branch `task51-heap-fix`, cut from `task51-finish`.

**Hypothesis history.** D.4 recorded two candidates, both about the
paged trace views. Both are now **refuted**:

- *H1 — `GridviewRow`'s per-cell `<Fragment key>` wrapper.* Ablated it
  (cells returned straight from `renderCell`), rebuilt, captured:
  jsheap mean 59.87 / max 105.8 / slope 29.25 — squarely in the
  unfixed family (mean 56.8–62.5), nowhere near the control
  (46.4–48.5). **Refuted**; the ablation was reverted.
- *H2 — per-row identity strings in the paged parents.* Refuted
  together with H1 by the layout ablation below: removing the trace
  views from the scenario leaves the delta intact (+10.1 MB of the
  +12.9 MB), and removing the signals panel leaves +8.5. Neither is
  where the cost is.

**Two measurement corrections had to come first**, because the
experiments were not otherwise trustworthy:

1. *`jsheap_mb.mean` is the discriminator, not the slope.* The slope is
   a least-squares fit over a sawtooth (a run ends anywhere between
   ~37 and ~104 MB), so it swings run to run. Interleaved 3+3 runs of
   the unfixed build against a same-day control separate cleanly on the
   **mean** — 56.80 / 61.71 / 62.46 vs 47.35 / 46.44 / 48.52 — with no
   overlap, where the slopes overlap at the edges. The gate still gates
   the slope; the experiments were read on the mean.
2. *Compare like builds.* The first control binary was built with
   `minify: false` (for a profiling experiment) and read ~5 MB high on
   mean heap — enough to erase the effect. Every A/B below uses matched
   minified release builds, and both binaries were kept side by side,
   which turns an A/B into two 90-second runs instead of two rebuilds.

**The confirming experiment: ablation by project layout.** The scenario
is the variable, so no rebuild is needed — copies of the ev-zonal
project with panels removed, run on both binaries:

| layout | unfixed mean | control mean | delta |
| --- | --- | --- | --- |
| full (3 + 3 runs) | 60.32 | 47.44 | **+12.9** |
| RBS panel removed | 31.77 | 32.21 | **−0.4** |
| trace views removed | 58.85 | 48.71 | +10.1 |
| signals panel removed | 56.55 | 48.08 | +8.5 |

Removing the RBS panel collapses the delta to nothing. Confirmed a
second way, by reverting **only** `RbsPanel.tsx` to `c2b845c` and
leaving every other gridview change in place: mean 49.62 / 49.64, slope
5.56 / 5.55 — 10.7 MB of the 12.9 recovered by one file.

**Mechanism.** Instrumented the panel (a `render.RbsPanel` counter and
an `rbs.rows` gauge, added for the measurement and then removed): it
renders **4.83 times per second over 321 rows**. That rate is the RBS
view's 500 ms value poll — the payloads and running flags move, the
tree's *shape* does not. The migration nonetheless rebuilt, per row per
refresh, the row id string, the DOM id (`rowDomId`'s
`encodeURIComponent` plus a template), the row's click closure and its
`GridviewRow` object, and walked every message through the filter
predicate even with an empty query. That is on the order of a few
hundred bytes per row per refresh over ~1,550 row-renders a second,
which is the right size for the observed delta.

**The fix** (`6e611c0`, `apps/gui/src/rbsRowIdentity.ts`): intern what
the shape determines — row ids, row props, and the row space, which
hands back the *same array* when nothing structural moved and so keeps
the adapter and the hook's derived callbacks stable too; and skip the
filter walk entirely while nothing is narrowing, which also hands each
ECU its own message array back. The caches are bounded by the loaded
RBS config. No DOM change, no behavioural change; the tests assert
*identity*, which is the only shape this regression has. Landed in two
measured steps — ids and row props first (mean 60.3 → 55.5), then the
row space (→ 50.3).

**Result.** Six runs of the fixed build against eight of the control,
interleaved, standard scenario:

| build | jsheap mean (avg / worst) | max (avg / worst) | slope (avg / worst) |
| --- | --- | --- | --- |
| unfixed (n=3) | 60.32 / 62.46 | 101.9 / 109.7 | 17.9 / 22.9 |
| **fixed (n=6)** | **50.34 / 51.99** | **77.9 / 82.7** | **4.70 / 12.30** |
| control (n=8) | 47.91 / 51.12 | 74.4 / 80.2 | 5.94 / 10.36 |

The fixed build is inside the control's own spread on every column; its
average slope is *lower* than the control's, and its worst run (12.30)
sits beside the control's worst (10.36) and under the 16.39 limit.
`cannet-perf-measurement check` passes on both committed post-fix
captures — **31/31 metrics**, `jsheap_mb_drift_per_min` 9.905 and
2.288 — with no baseline promoted. Nothing was traded for it:
`longtask_ms_per_s_mean` 0.000, `jank_fraction` 0.000, `lag_ms_max`
35.0 and 3.6 (limit 74.2), `tx_late_ms_max` 19.6 and 18.0 (baseline
75.9), rx/tx fps 1612–1614 against 1608. Captures committed as
`2026-08-06-6e611c0-rbs-identity-fix-run{1,2}.json`.

#### Blockers / side effects

- **Slice D's "DBC/RBS are not open in this scenario" was wrong, and it
  is why the search started in the wrong place.** It was inferred from
  the absence of a `render.RbsPanel` counter — but the panel has never
  had one, and dockview keeps an inactive tab *mounted*: `rbs-vehicle`
  sits behind the `project` tab in the ev-zonal layout and renders the
  whole time. A counter would have prevented the wrong inference; one
  was added temporarily here and removed with the rest of the
  instrumentation. Adding it permanently — and for `DbcPanel` and
  `TransmitPanel` — is worth its own change.
- **Panel visibility in the gate scenario, verified from the saved
  layout:** group 1 holds `trace-chrono` *and* `trace-byid-zonal` with
  the by-ID one active, so **the chronological trace is behind a tab**;
  `trace-byid-pack` (group 3), `signals-pack-signals` (group 4) and
  `plot-pack` (group 5) are the visible tabs; `rbs-vehicle`,
  `system-messages` and `events` sit behind `project` in group 2. All
  of them render regardless — that is what the render counters show and
  what the RBS finding rests on. The gate scenario was left exactly as
  the committed baseline captured it, and a **second scenario with
  `trace-chrono` as the active tab** was run beside it: unfixed 67.04
  mean / 110.2 max / 34.56 slope; fixed 49.01 and 52.36 mean / 74.7 and
  82.4 max / 7.97 and 11.18 slope; control 46.76 / 71.6 / 5.47. The fix
  holds in the harder scenario too. Whether the gate scenario should
  put the chronological view in front is a baseline decision, not this
  phase's.
- **The V8 sampling heap profiler was tried and is not usable here.**
  Attached over CDP to the real WebView2 (`--remote-debugging-port`,
  unminified release build) it reported only ~9 MB/min of total
  allocation in *both* builds, against a heap that sawtooths 38 → 104 MB
  in 60 s — it under-reports by roughly an order of magnitude and could
  not resolve a delta this size. It earned its keep once: its stacks are
  what revealed `RbsPanel` rendering at all.
- **Reported by the repo owner while watching these runs: the unfixed
  build looks visibly worse than the control — plot-panel jank up 2–3×
  with larger spikes.** That is consistent with the captures' *variance*
  rather than their means: across the four committed 08-05 captures the
  unfixed run 2 read `lag_ms_max` 45.4, `jank_fraction` 0.05 and
  `tx_late_ms_max` 79.6 where run 1 was the cleanest of all four —
  the signature of GC pauses landing inside or outside the window by
  luck, and individual collections sit under the long-task threshold, so
  a clean `longtask_ms_per_s` does not contradict felt stutter. The
  fixed build shows no run of that kind in six: `longtask_ms_per_s_mean`
  0.000 and `jank_fraction` 0.000 in every one, worst `lag_ms_max` 35.3.
  Recorded as an observation, not a measured second cause; if stutter is
  still felt on the fixed build it is a separate finding and wants its
  own hypothesis.
- **No baseline was promoted**, per the brief. The committed
  `baseline.json` still reads ~1.8× low on `jsheap_mb_drift_per_min`
  relative to this machine (D.4's finding, unchanged) — the gate passes
  anyway, but a same-day control remains the honest comparator for any
  future heap work.
