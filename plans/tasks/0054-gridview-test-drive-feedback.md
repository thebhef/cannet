# Task 54 — Gridview Test-Drive Feedback

Two defects from the owner's first drive of the task-51 gridview
(2026-08-06), the day it landed. Both are regressions or gaps in the
migrated surfaces; both should start from a failing test that
reproduces what the owner saw.

## Items

### 1. Signal-row drag area is too small

Dragging a signal row works only on the signal *name* text; the whole
row should be the drag source. Owner's note: "I suspect there's some
negative-value special case code here" — check the signal view's
drag-source wiring for a special case (value cells or some value
range bypassing the drag handler) and widen the source to the row.
Verify against the other migrated surfaces while there — the D9 rule
(the row drags the message / the signal) implies row-sized drag
targets everywhere.

**Grooming (2026-08-07):** The small drag surface is not a stray
special case — it is deliberate, per ADR 0045's grip rule ("rows that
hold inputs or buttons are not themselves draggable";
`SignalsPanel.tsx` cites it at the name-cell grip). The
negative-value hypothesis is refuted: the signal-row render path has
no value-dependent DOM branch. **Owner ruling: the rule changes.**
Rows are draggable to the fullest extent possible without interfering
with interaction on input fields, and no special affordance is made
for inner controls until one proves necessary. Item 1 therefore
includes amending ADR 0045's grip rule to match (whole-row drag is
the norm; an inner drag source like `DecodedSignalCell` suppresses
the row drag via stopPropagation) and restating the
`SignalsPanel.sections.dom.test.tsx` assertion that currently pins
"the section button is not inside a draggable" to its real intent.

### 2. Keyboard-only entry into RBS row content regressed

With keyboard only, the RBS content area (the per-message signal
table with its inputs) can no longer be entered and edited. The
gridview key table says Tab enters row content, and the C2 migration
carried tests for it — but real usage says it's broken. Find the
actual failure (dispatcher suppression eating Tab, focus order,
content not reachable from the container focus) with a DOM test that
reproduces the keyboard-only path end to end, then fix.

**Grooming (2026-08-07):** Root cause found by code read: the
ADR-0044 Tab contract ("Tab moves into the row's interactive
content") was never implemented in any panel — `useGridview.ts` lets
Tab fall through to native document focus order, so Tab lands on the
container's first tab stop, not the cursor row. Compounding gaps:
RbsPanel / DbcPanel / TransmitPanel never focus the grid container on
row click (focus stays on `<body>`; arrows dead), and
`ValidatedInput` blurs to `<body>` on Enter/Escape so the next Tab
restarts from the document top. **Owner ruling: this is a missing
part of the common control — implement it in the shared gridview
layer**, not as RBS patchwork: Tab (container focused) → cursor
row's first focusable element, Shift+Tab symmetric, commit/Escape
returns focus to the container, and the three panels missing
focus-on-click get it.

## Exit criteria

- A signal row drags from anywhere on the row (not just the name),
  with a test pinning the wider target; ADR 0045's grip rule is
  amended to the whole-row-drag norm in the same change.
- A keyboard-only user can Tab from the RBS grid into the cursor
  row's content, edit a value, and leave; DOM test reproduces the
  broken path first. The Tab contract lands in the shared gridview
  layer (all panels), RbsPanel/DbcPanel/TransmitPanel gain
  focus-on-click, and commit/Escape returns focus to the container
  — matching what ADR 0044 already documents.

## Status log

- **2026-08-07 (item 1, whole-row drag):** Landed on
  `task54a-whole-row-drag`. `60ec4a8` grooms the roadmap/task docs
  (this slice's prerequisite commit). `766e9d7` moves the signal row's
  drag source from `.signals-name` to the row itself in
  `SignalsPanel.tsx` (`SignalRowProps.onGripDragStart`/`onGripDragEnd`
  renamed to `onDragStart`/`onDragEnd`, passed straight to
  `GridviewRow`), adds a DOM test in `SignalsPanel.dnd.dom.test.tsx`
  pinning a drag from the value cell, restates the assertion in
  `SignalsPanel.sections.dom.test.tsx` that pinned the section-picker
  button outside `[draggable="true"]` to its real intent (outside the
  clipped `.signals-name`, with the row now legitimately draggable),
  and amends `docs/adr/0045-cross-panel-drag-payloads.md`'s grip rule
  to whole-row-by-default. `apps/gui` test suite: 1484/1485 → 1485/1485
  passing (130 files), `pnpm --dir apps/gui build` green both before
  and after. `SectionHeaderRow` (the section header's own drag grip)
  is untouched — out of scope for item 1, which is signal rows only.

- **2026-08-07 (item 2, the Tab contract in the shared layer):** Landed
  on `task54b-gridview-tab-contract`. The keyboard-only path now works
  end to end from `useGridview.ts`: Tab pressed on the container moves
  focus to the cursor row's first tabbable control (`document.getElementById(rowDomId(cursor))`,
  `tabindex="-1"` and disabled controls skipped), Shift+Tab to its last,
  and both leave the press to the browser when the cursor names a row
  that is not on screen or the row has no controls. Focus inside a row
  keeps native Tab. Enter/Escape on an editable inside the container
  reclaims focus for the container **only when the press left focus on
  `<body>`** — the editors blur themselves, and this rescues what they
  drop without fighting one that moves focus deliberately.
  `docs/adr/0044-gridview-interaction-base.md` gains the paragraph
  describing all of that and its key-table row now reads
  "Tab / Shift+Tab"; `ShortcutsPanel.tsx`'s user-facing table matches.
  Tests: 3 failing RBS DOM tests written first
  (`RbsPanel.gridview.dom.test.tsx`), then 6 shared-layer tests in
  `useGridview.dom.test.tsx` replacing the one that pinned "the grid
  must not consume Tab". `apps/gui` suite 1485/1485 → 1492/1492 (130
  files), `pnpm --dir apps/gui build` green.

- **2026-08-07 (item 2, focus-on-click for the last three panels):**
  `RbsPanel`, `DbcPanel` and `TransmitPanel` now hand the grid container
  the keyboard when a row is clicked, matching `SignalsPanel` /
  `ByIdTable` / `TraceView`'s existing `closest("button, input") == null`
  guard. RBS's row click is the cached one in
  `rbsRowIdentity.ts`, so `makeRowGridPropsCache` takes the container ref
  as a second argument; DBC's `handleRowClick` gained the click target as
  a third argument (the row component already built the modifiers, not
  the event). ADR 0044's cursor/selection paragraph states the rule.
  Tests: one DOM test per panel written failing first, plus a unit test
  over the cache's focus branch. Suite 1492/1492 → 1496/1496 (130
  files), build green.

- **2026-08-07 (item 2, the dispatcher's view of Shift+Tab):** Claiming
  Shift+Tab in the grid left `keybindings.ts` inconsistent with it —
  `isGridviewKey` / `chordSuppressedInGridview` rejected *every* shifted
  stroke, so a globally-bound Shift+Tab would have fired alongside the
  grid's focus move, and the shortcuts view would have said the binding
  was live in a gridview when it is not. Both predicates now take
  Shift+Tab (and only Shift+Tab among shifted strokes); ADR 0044's
  suppression paragraph lists it. The keybindings tests prove the two
  against each other, so display and dispatch cannot drift. Suite stays
  1496/1496.

## Blockers / side effects

- Verified the other gridview-migrated surfaces already drag whole-row
  per the amended ADR 0045 norm: `ByIdTable.tsx` (~line 494),
  `TraceView.tsx` (~line 723), `DbcPanel.tsx` (~line 1165), and
  `PlotArea.tsx`'s `.plot-signal-row` (~line 2828) all set
  `draggable`/`onDragStart` on the row element itself. No fix needed.
- **Item 2's Shift+Tab reading.** ADR 0044's key table said only "Tab —
  into the row's interactive content", so Shift+Tab was undefined. Read
  as the mirror: from the container it focuses the cursor row's **last**
  tabbable control, so the row is reachable from either direction
  without first leaving the grid, and the two presses are inverses of
  each other. The alternative reading — Shift+Tab exits the grid
  backwards, native — was rejected because it makes the row's controls
  unreachable from below and gives the container two different tab
  meanings depending on direction. Recorded in the ADR as what is.
- **Item 2's `ValidatedInput` decision: it is untouched.** The
  focus-return is handled entirely by the gridview layer, which reclaims
  focus on an Enter/Escape from an editable inside its container *only
  when the press left `document.activeElement` on `<body>`*. That covers
  `ValidatedInput`'s self-blur without a new prop, without a call-site
  change, and without breaking its non-gridview call sites (nothing
  outside a gridview container sees the handler at all). It also covers
  any other self-blurring control a row grows later — `Combobox`
  included — and by construction never fights a control that moves focus
  somewhere of its own choosing.
- **Not done in item 2: the RBS content block is not part of "the
  row".** `.rbs-message-row` (the element carrying the row's DOM id) and
  the disclosed `.rbs-signals` table are DOM siblings, so Tab from the
  container lands on the row's own controls (enable checkbox, then the
  period cell) and the browser's native Tab carries on into the signal
  inputs, which follow in document order. The keyboard-only path works
  end to end, but the layer's "first control of the row" is scoped to
  the row element, not to the row plus its content block. If a panel
  ever renders its content block *before* its row element, or outside
  it, that would need revisiting.
- Two pre-existing exceptions remain grip-only, not whole-row:
  `TransmitFrameRow.tsx`'s `.tx-drag-handle` (~line 191) and
  `PlotArea.tsx`'s `.plot-area-grip` reorder handle on the area head
  (~line 2678). Both rows are dense with editable controls (byte
  cells, cyclic-send controls, a bus combobox, buttons) — the "proven
  necessary" grip case the amended ADR 0045 still allows — so left
  alone as out of scope for item 1, which only ruled on signal rows.
