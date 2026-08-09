# Task 60 — Undo/Redo for View Changes

Groomed 2026-08-08. Extend the existing view history (`Mod+Z`/`Mod+Y`
already undo panel add/close/move via the dockview-layout stack,
`viewHistory.ts`, ADR 0018 bindings) to cover the rest of what a user
does to their views: "anything the user might want to go back on"
(owner) — signals added/removed/reordered in any view, plot areas
dragged within and between panels, filters added/removed, predicate
and sources edits, solo, visibility, collapse, colors, columns,
sections, renames.

An exploration map (2026-08-08) produced the mutation inventory
(mutation → state home → write chokepoint), the feasibility verdict,
and the hazards; its findings are baked into the design below.

## Boundary — the ADR

**Undo/redo applies to view state only; it never applies to values on
the bus.** Write this as an ADR (it is hard to reverse once muscle
memory forms, surprising without context, and a real trade-off).

| In (undoable) | Out (never) |
|---|---|
| Plot areas/signals/solo/visibility/collapse/y-axis mode/primary/ sort/patterns; colors, colormap + generator rules; trace & signals columns, sections; element renames; panel open/close/move; **filter add/remove, predicate edits, sources rewiring** | `rbs.run`/`rbs.path`; all transmit config; connection; capture control; DBC set; project open/save; settings; notes/markers |

Owner rationale (2026-08-08), for the ADR: redo makes undo cheap to
reverse; the wiring family (filters/predicates/sources) scopes what
views fetch and display but never writes the bus — worst case it
perturbs RBS fetch rate, and cannet's RBS is explicitly not
safety-rated; operators are responsible for themselves during
development. Also record: zoom/pan/scroll are outside undo (they're
already unpersisted, transient view state); undo does not try to
restore them.

## Mechanism — filtered snapshot history (owner-approved 2026-08-08)

Extend the layout-history pattern rather than per-op registration:

1. **Second stack over the element registry.** Snapshot
   `entries.map(e => e.element)` at the single registry write
   chokepoint (`App.tsx` `setRegistry`; only the `update`/`remove`
   callers are user edits — `updateTrace` and session/restore churn
   are excluded). Mask the behavior fields per the allowlist above —
   the allowlist is the one place the ADR boundary is enforced. The
   existing deep no-op machinery (`applyElementPatch` /
   `patchIsNoOp`, `projectElements.ts`) is the "did anything change"
   test, mirroring `structuralKey` on the layout side.
2. **Unified steps.** One user gesture = one undo step, spanning both
   stacks: panel add (dockview + registry), element remove (registry +
   panel close + host side effects — the host effects are excluded,
   the view halves undo together), cross-panel area drag
   (`plotAreaTransfer` touches two panels), filter insert
   (`insertFilterUpstream` makes 3 writes). A transaction wrapper
   above both stacks; `Mod+Z` replays the pair.
3. **The enabler: panel rehydration.** Panels read `savedConfig` once
   at mount (`useElementPanel.ts:62-65`) and are write-only mirrors
   after — a restored snapshot would be clobbered by the panel's own
   persist effect (`PlotPanel.tsx:864` etc.). Each element-backed
   panel gains a rehydrate-from-element path (a config epoch/version
   panels resync on) — one shared mechanism, the largest single piece
   of this task, and prerequisite to everything else.
4. **Coalescing.** Drag-continuous persisted knobs (axis sash
   weights, side-panel width, cursors) coalesce to one step per
   gesture. Filter-box text and other params-only state (DBC panel
   expand, find boxes) stay **out** of undo v1 — dockview `params`
   remain scrubbed, as today.

## Non-goals / future

- No per-operation command registration now. Owner direction
  (2026-08-08): eventually everything the user can do in the frontend
  may become a command with a test-fixture driving surface — "but not
  today". Design the snapshot step record so that migration doesn't
  require discarding the history shape.
- No undo of host/behavior state, ever (the ADR).
- No persistence of the undo stack across sessions.

## Exit criteria

- Every allowlist mutation is undoable/redoable via the existing
  chords, one step per user gesture (transaction-grouped cases
  tested: panel add, element remove, cross-panel area drag, filter
  insert).
- Undo of a view change repaints mounted panels correctly (the
  rehydration path, dom-tested per element-backed panel kind).
- No excluded field is ever replayed by undo — pinned by a test that
  snapshots-with-mask an element carrying behavior fields (rbs/
  transmit) and asserts restore leaves them untouched and fires no
  host reconciliation.
- Drag gestures produce single steps; filter-box typing produces
  none.
- The boundary ADR exists; ADR 0018's bindings/docs updated; the
  existing `viewHistory` tests stay green and the new stack has
  equivalent pure-function coverage.
