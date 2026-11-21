# 0140 — Project State Items

> **Opened 2026-09-06** by owner instruction; groomed and prototyped
> 2026-09-07/08, and **executed on the current stack** (branch
> `task140-controls` on `task139-apply`) per the owner's approved
> plan, 2026-09-08.

The ask, in the owner's words: add start/stop to RBS and logger
items in the project view. (A status-strip section of active items
was considered and dropped, 2026-09-07.)

## Grooming notes

**2026-09-07 (owner asks, prototype round 1):**

- The Elements rows trade text buttons for icons: **Remove becomes
  the app's trash glyph** (`Icon name="clear"`, single-click —
  element removal is undoable via the registry), and **Focus/Open
  becomes the `enter` glyph** (arrow into a doorway — ruled from a
  candidate gallery; a new `Icon` registry entry), one "take me to
  it" affordance covering both.
- **RBS and Logger rows gain a play/stop toggle, with no state
  label** — the button alone conveys state (play/stop shape, green
  running, amber armed; ruled: labels took too much space).
  Prototyped in `plans/prototypes/project-element-controls.html`
  (real project panel chrome, live toggles and bus
  connect/disconnect).
- **The toggle changes no behavior** (owner ruling): it is the same
  state as the enable in each element's own panel — the logger's
  `enabled` bit (logging runs exactly while `enabled && connected`,
  `logger.rs`), the RBS panel's top-level enable — surfaced in a
  convenient second place. The button's green/amber tint just renders
  the existing enabled-and-connected vs enabled-awaiting-connection
  states.

**2026-09-08 (owner rulings, pre-launch):**

- **Every Remove in the project panel takes the trash glyph** — the
  Elements rows, the Logical-buses rows, and the DBC rows alike.
- **The interfaces' "Discover" text button becomes a refresh icon**
  (circular-arrow glyph; a new `Icon` registry entry — `loop` is a
  different shape). Applies wherever the Discover button appears
  (`ConnectionManagement.tsx`).

## Phases

**Phase 1 — icon controls and the run toggle** (frontend, single
phase). The `Icon` registry gains `enter` and `refresh`; every
Remove in the project panel (Elements, Logical-buses, DBC rows)
becomes a single-click trash (`clear`) button in the quiet
icon-button idiom (no two-stage where removal is
registry-undoable), Focus/Open becomes the `enter` glyph, the
interfaces' Discover text button becomes the `refresh` icon; RBS
and Logger rows gain the play/stop toggle bound
to the element's existing panel enable (no new state, no new host
surface) — green while enabled and connected, amber while enabled
awaiting connection, tooltips carrying the words. DOM tests
throughout, including toggle sync with the element's own panel in
both directions.

## Exit criteria

- [x] Element rows show icon buttons: trash removes in one click
      (undoable via the registry), `enter` focuses the element's
      open panel or opens it — no text buttons remain on the rows.
- [x] Bus and DBC rows' Remove and the interfaces' Discover are
      icon buttons too (trash / `refresh`).
- [x] The RBS and Logger rows' play/stop toggle reads and writes the
      same enabled state as the element's own panel; toggling in
      either place updates both, and no behavior beyond the existing
      enable changes.
- [x] The toggle alone conveys state — play/stop shape, green
      running, amber armed — with no state text labels.
- [x] DOM tests cover both toggle-sync directions and the remove and
      focus actions.

## Status log

**2026-09-07 (Phase 1, `task140-controls` on `task139-apply`):** Icons,
remove, and the run toggle landed.

- `Icon.tsx` registry: added `enter` (Focus/Open, copied verbatim from
  the prototype) and `refresh` (Discover, drawn fresh in the
  registry's idiom — distinct from `loop`'s bidirectional cycle).
  Pinned by `Icon.dom.test.tsx`.
- New `IconButton.tsx`: the quiet single-click icon button —
  `TwoStageRemoveButton`'s idiom without the arm step, for the
  registry-undoable remove, the enter/refresh glyphs, and the run
  toggle.
- `ProjectPanel.tsx`'s `ElementRow`: Remove is a single-click trash
  `IconButton` (element removal already rides the registry's undo —
  `App.tsx`'s `removeElement` arms `pendingElementEditRef`
  unconditionally); Focus/Open collapse into one `enter` icon button.
  A logger or RBS row also gets a play/stop `RunToggle`: the logger
  reads/writes `element.enabled` (the same field `LoggerPanel.tsx`'s
  checkbox writes) tinted by "is anything connected" (the same
  definition `LoggerPanel.tsx` itself uses); the RBS row
  (`RbsRunToggle`) reads/writes the host's `run` flag via the
  existing `rbs_view` / `rbs_set_run` commands — the same ones the
  RBS panel's own Run chip uses — and tints from that element's own
  buses' `connected` flag (`RbsView.buses[].connected`), not a
  project-wide one, so a config scoped to an idle bus reads armed
  even while some other bus is live. No new host state, no new host
  commands.
- Bus rows and DBC rows: Remove is `TwoStageRemoveButton` (trash
  glyph, two-stage). Checked first whether either removal already
  rides undo: neither `handleRemoveBus` nor `handleRemoveDbc`
  (`App.tsx`) touches `pendingElementEditRef`, and ADR 0050's
  allowlist explicitly puts the DBC set and connection config outside
  undo — so both stay non-undoable, and per the phase ruling that
  means the two-stage confirm, not the single-click trash.
- `ConnectionManagement.tsx`: both "Discover" text buttons
  (`LocalInterfacesRow`, `ServerSection`) became `refresh` icon
  buttons; `ServerSection`'s kept its existing
  `discover interfaces on <address>` aria-label unchanged, so
  `ServerSections.dom.test.tsx`'s existing assertion needed no edit.
- Test updates: `App.elementUndo.dom.test.tsx`'s `buttonIn` helper now
  matches a button's aria-label as well as its text (Remove/Focus/Open
  carry no visible text anymore). `ProjectPanel.dom.test.tsx` gained
  the single-click-remove and logger-run-toggle cases. New
  `ProjectPanel.runToggle.dom.test.tsx` covers the RBS toggle's both
  directions: an external `rbs-changed` (as the panel's own Run chip
  would cause) reaching the row, and a row click reaching the host
  through the identical `rbs_set_run` command.
- Full local CI: frontend build + vitest (3447/3447; one
  `PlotPanel.dom.test.tsx` render-count assertion flaked once under
  concurrent load and passed both in isolation and on a full re-run —
  unrelated file, not touched by this phase) are green. Rust/Python/
  mdf-export-oracle/rustdoc/sidecar-freeze lanes are unreachable — the
  diff touches only `apps/gui/src/*.ts(x)`.

## Blockers / side effects

(none yet)
