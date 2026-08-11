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

## Phases (orchestrator plan 2026-08-09)

Launched under the owner's standing "implement tasks 58-60" directive.
Chained off `task59g-dirty-version`, strictly sequential, one new
branch per phase, main working tree, orchestrator reviews diffs
between phases. 60.A's first commit carries this plan section.

- **60.A** `task60a-panel-rehydrate` (Opus) — mechanism step 3, the
  enabler: a rehydrate-from-element path (config epoch) for every
  element-backed panel kind, one shared mechanism, dom-tested per
  kind. No history changes yet.
- **60.B** `task60b-registry-history` (Opus) — the boundary ADR +
  the allowlist mask + the second stack over the `setRegistry`
  chokepoint (mechanism step 1), wired to `Mod+Z`/`Mod+Y` beside the
  layout stack; includes the no-replay-of-excluded-fields test.
- **60.C** `task60c-transactions` (Opus) — mechanism steps 2 + 4:
  unified one-gesture steps across both stacks (panel add, element
  remove, cross-panel area drag, filter insert), drag-knob
  coalescing, params-only exclusions confirmed.
- **60.D** `task60d-undo-close` (Opus) — polish and docs (ADR 0018
  bindings/docs), any spillover, final ADR-0031 gate +
  exit-criteria walk.

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

## Status log

### 2026-08-09 — phase 60.A, panel rehydration (branch `task60a-panel-rehydrate`)

Mechanism step 3 landed: an element-backed panel now resyncs its view
state from its element when the element's config is rewritten by anyone
else. No history/undo changes — 60.B still owns the stacks.

The seam, for the phases that build on it:

- **Epoch + origin on the registry entry.** `RegistryEntry` gains
  `configEpoch?: number` and `configOrigin?: string`.
  `applyElementPatch(entries, id, patch, writer?)` bumps the epoch —
  and stamps `writer` as the origin — only when a patch *actually
  changes* `config` (the deep `valuesEqual` no-op check already there).
  `config` is the one field panels snapshot at mount; `sources`,
  `name`, `rules` and the behavior fields are read live off the
  element, so they neither need nor get a bump.
- **The external/echo split** is the optional `writer` argument on
  `ElementRegistry.update(id, patch, writer?)` (App's `updateElement`
  passes it straight through). **Omitting it means "external"** — every
  mounted panel on that element resyncs. That is exactly the call 60.B's
  restore path makes; only `useElementPanel`'s `persist` passes a token.
- **Per-panel-instance writer token**, not per element: a panel skips
  the epoch bump it caused itself, so its own persist can't clobber the
  state that produced it — and two panels onto one element would each
  follow the other's edits (not built, not forbidden).
- **`useElementRehydrate(panel, apply)`**, beside `useElementPanel` in
  the same module. It is a second hook rather than a `useElementPanel`
  argument because `apply` closes over the state setters, which are
  declared *after* the hook that produces `savedConfig`; the panel calls
  it after declaring its view state.
- Rehydration applies **view config only** — the same fields the panel
  seeds from `savedConfig`. Nothing here reads or writes `rbs.run` /
  `rbs.path` / transmit config, and the App-level reconciler is
  untouched.

Panel kinds enumerated and covered (every element-backed dockview
component; `filter` elements have no panel — they are edited from the
project panel, which reads the registry live):

| Kind | Panel | Treatment |
|---|---|---|
| trace (chronological + by-id) | `TracePanel` | resync: mode, auto-scroll, events overlay, column layout, open by-id rows |
| plot | `PlotPanel` | resync: areas, follow-live, cursor mode + cursors, measurements, diagnostics, points, side-panel width, axis weights, axis scales, solo |
| signals | `SignalsPanel` | resync: selection, columns, sections (panel migrated onto the shared hooks — it carried a copy of the lifecycle) |
| colormap | `ColorMapPanel` | none needed — reads the element live every render (pinned by test) |
| generator | `GeneratorPanel` | none needed — reads the element live (pinned by test) |
| transmit | `TransmitPanel` | none needed — no view `config`; renders the element's `frameIds` live (pinned by test) |
| rbs | `RbsPanel` | none needed — no view `config`; `path`/`run` read live (pinned by test) |

Commits (oldest first): `38728f1` docs(plans) phase plan · `42089ab`
config epoch on element config writes · `8c54900` panel resync from the
element · `d0510e0` resync split into its own hook · `6b2fa8c` trace
panel · `f7c651a` plot panel · `79975fc` signals panel · `2de1f2f`
config-less panels pinned as live readers.

Verification: `pnpm --dir apps/gui test` 1740 passed / 139 files (from
1724 at branch point — 16 new), `pnpm --dir apps/gui build` clean. Host
untouched, so no cargo run.

## Blockers / side effects

- **60.A** — no blockers. Side effects worth knowing:
  - `SignalsPanel` was migrated onto `useElementPanel` /
    `useElementRehydrate` rather than given its own copy of the epoch
    logic; it had a verbatim copy of the panel lifecycle. Its sources
    block is still its own (unrelated to this phase, left alone).
  - `persist` gained an optional `extraParams` argument for state that
    belongs in the dockview params but not on the element — the signals
    view's fold set is the only user.
  - New shared test helper `apps/gui/src/registryTestKit.tsx`: a
    registry backed by real React state and the real
    `applyElementPatch`, so a test can land an external write on a
    mounted panel. The per-file `makeRegistry` fakes are static and
    can't.
