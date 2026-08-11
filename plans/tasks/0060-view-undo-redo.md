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

### 2026-08-09 — phase 60.B, the boundary + the element stack (branch `task60b-registry-history`)

The ADR and mechanism step 1 landed: element edits are undoable beside
the layout stack, through the same chords, with the allowlist enforced
at both ends.

- **[ADR 0050](../../docs/adr/0050-undo-covers-view-state-only.md) —
  "Undo/redo covers view state only, never the bus."** Carries the
  allowlist table, the owner's rationale (redo makes an undone display
  change free to reverse while frames already sent have no redo; the
  wiring family scopes fetches, never traffic; RBS is explicitly not
  safety-rated), zoom/pan/scroll as out-of-scope transients, and "undo
  never re-runs a host side effect".
- **`apps/gui/src/elementHistory.ts`** — the pure stack, mirroring
  `viewHistory.ts` (cap 50, no React/DOM, undo/redo returning the
  snapshot to apply). `UNDOABLE_FIELDS` is the ADR's allowlist in code:
  `transmit` and `rbs` list nothing, so their fields are neither
  snapshotted nor patched back. `valuesEqual` is now exported from
  `projectElements.ts` and reused, so "did anything change?" means the
  same thing at the history as at the registry.
- **Capture is armed at the chokepoint and taken after the change
  lands.** `updateElement` / `removeElement` set a pending-edit flag
  (`updateElement` on the same identity test that marks dirty); a
  `useEffect([registry])` then snapshots. Everything else — `create`,
  `ensure`, `updateTrace`, project open, session churn — reaches
  `syncElements`, which moves `present` without making a step or
  clearing redo. Taking the snapshot after the fact also means the
  step's base is state that really existed, which a call-site capture
  can't promise (the call site sees a one-render-stale registry).
- **Restore** writes back through `updateElement` with **no writer
  token**, so every mounted panel on a changed element rehydrates
  (60.A's seam), under an applying guard so the restore's own writes
  aren't recaptured.
- **Interleaving** is a shared order log (`UndoOrder`) recording which
  stack each step landed on; `popUndo`/`popRedo` pick the most recent
  (resp. oldest-undone) entry whose stack still has a step, so one
  chord reverses the most recent change either way. `applyViewHistory`
  in `useCommands` replaces the layout-only handler.

Two rules keep a gesture from costing two undos, both pinned by tests:

- A write confined to excluded fields is not a step (so arming an RBS
  can't even be reached by the chord).
- A panel seeding its element's **first** `config` at mount is not a
  step — otherwise "add a plot panel" would be a layout step plus the
  panel's own config write.

Commits (oldest first): `5df8e8f` ADR 0050 · `47d8469` the masked
element stack (pure + tests) · `3831dd9` chokepoint capture, restore,
and the interleaved chords · `ea9718e` the no-replay test.

Verification: `pnpm --dir apps/gui test` 1770 passed / 141 files (from
1740 at branch point — 30 new: 26 pure, 4 dom), `pnpm --dir apps/gui
build` clean. Host untouched. The no-replay test was falsified before
being trusted: unmasking `rbs.path`/`run` makes the first `Ctrl+Z`
disarm the simulation and the test fail.

Deferred to 60.C (recorded here rather than re-scoped):

- **Transaction pairing.** Writes batched into one React commit already
  coalesce into one step (an unplanned down-payment on step 2 — a
  filter insert's three writes are one step), but a gesture spanning
  both stacks is still two entries in the order log. Panel add is one
  step only because the config seed is suppressed; element remove,
  cross-panel area drag and the panel-close half of a removal still
  need the transaction wrapper.
- **Re-creating a removed element.** A removal is captured, but a
  restore only patches elements that still exist: bringing one back
  needs its panel and runtime state back with it (and, per the ADR, not
  its host state). Until then the chord consumes that step and falls
  through to the layout step, which reopens the panel — and the panel's
  `ensure` heals a fresh element.
- **Coalescing** of drag-continuous knobs across renders (step 4), and
  ADR 0018's binding docs (60.D).

### 2026-08-09 — phase 60.C, transactions + coalescing (branch `task60c-transactions`)

Mechanism steps 2 and 4 landed, and with them 60.B's deferrals: one user
gesture is one undo step, however many writes it takes and whichever
stacks they land on.

**The wrapper.** A *gesture* is an id, opened and closed above both
stacks, that changes two things while it is open:

- **The order log groups.** `UndoEntry` is now `{ stacks, gesture? }` —
  the stacks one gesture stepped, in the order it stepped them. A step
  tagged with the gesture that is already at the top of the log joins
  that entry; `popUndo` / `popRedo` hand the driver the whole entry, and
  it applies the element half first (both halves are dispatched from one
  event, so React commits them together and a panel the layout half
  remounts reads an element the element half has already put back).
- **The element stack amends.** After a gesture's first step, its later
  writes call `amendElements` — present keeps up, the step's base stays
  where the gesture started. That is the whole of coalescing.

Panels reach it through `undoGesture.ts`: a context with `transact(fn)`
for a gesture that lands in one call and `begin()` / `end()` for one
that spans events (a drag). Its default is a no-op, so a panel rendered
outside `App` — every panel test — writes exactly as before, and no
registry fake needed changing. `App` publishes the real one.

Closing is the one subtle part: `end()` with a write still armed but not
yet landed marks the gesture *closing*, and the registry effect that
lands the write closes it. A drag's last persist arrives a render after
the mouse comes up, and this is what keeps it inside the step.

**Element creation joins a step only inside a gesture** (60.B's
blocker). `create` arms the capture and records the id only while a
gesture is open, so inserting a filter is one step that includes the
filter, while adding a panel stays a single layout step. That made the
element *set* part of a restore: `restoreElements` returns creates and
removes beside the patches, a re-created element being a fresh element
of its kind with the snapshot's allowlisted fields laid over it (ADR
0050: a restored RBS is stopped and pathless, a restored transmit
carries no messages, no host call is re-run).

For that diff to be safe, an element created *outside* any step is now
grafted into every stored snapshot (`syncElements`, and `recordElements`
for one arriving in the same batch as an edit): no step created it, so
no step may delete it. The graft also fixed a latent mis-capture — a
panel seeding its config in the same commit as its element's creation
was being recorded as an element step.

Per case:

| Case | Verdict |
|---|---|
| Panel add | Already one step (the config seed is suppressed); left alone, still pinned by 60.B's test. The graft above removed a way it could have become two. |
| Element remove | Now one entry over both stacks. Undo restores the element (name, sources, config, predicate, rules — the allowlist) at its old position *and* reopens its panel, which repaints from the re-created element; redo takes both away again. |
| Cross-panel area drag | Already one step — the drop writes the target and claims from the source in one React commit. No mechanism needed; pinned by a test that would fail if either half were separate. |
| Filter insert | Was three coalesced writes plus an orphan filter; now one step that takes the filter with it. The graph toolbar's "+ filter" (an element with no panel, so nothing on the layout stack) became undoable at the same time. |

**Coalescing** covers the three drag-continuous persisted knobs: the
plot's side-panel width, its axis splitter, and a gridview column edge
(the trace/signals column widths — same family, same fix). Cursors are
*not* drag-continuous: `PlotArea` places one on mouse-up only when the
pointer didn't move, so a placement is already one gesture and one step.
Params-only state stays out, pinned: typing in a find box makes no step
and survives the chord.

Commits (oldest first): `a76001a` gesture entries in the order log ·
`a86c5d2` element removal + re-creation as one step · `b23c041` filter
insert as one step · `589585d` the cross-panel drag pinned · `d022d90`
drag-knob coalescing · `dce7f82` params-only pinned.

Verification: `pnpm --dir apps/gui test` 1787 passed / 141 files (from
1780 at branch point — 7 new: 6 dom + 1 pure amend/graft/restore group,
plus 5 pure order-log cases in the existing files), `pnpm --dir apps/gui
build` clean. Host untouched. Two claims were falsified before being
trusted: a `flushSync` around the element half of a paired restore was
written, then *removed* when the test passed without it (the panel
remounts in the same commit as the re-created element); and the two
filter cases were re-run with the gesture wrapper taken back out, where
they fail.

### 2026-08-09 — phase 60.D, the last two gestures and the close (branch `task60d-undo-close`)

The two edges 60.C recorded, and the docs. No new mechanism: both fixes
are the existing gesture wrapper reaching state it hadn't reached yet.

**A rename is a gesture from focus to blur.** The project panel's
inline rename writes the element on every `change`, so renaming cost one
undo per character. Text editing isn't a pointer gesture, but it has the
same shape — a beginning and an end the DOM already reports — so
`ElementRow`'s input opens the gesture on focus and closes it on blur,
and the keystrokes in between amend the one step. Chosen over an idle
window because there is no window to guess at: the step closes exactly
when the user leaves the field, and a `Mod+Z` while the field still has
focus is the browser's own text undo (`skipEditable`), not this one.

**The next press closes a gesture whose own end never arrived.** A
pointer released outside the window delivers no `mouseup`, so a drag's
gesture stayed open until the next `begin()` and an edit in between
joined its step. It is now also closed by the next `pointerdown`
anywhere: whatever interaction that press starts, it is not the one
before it. Capture phase on the document, so it runs *ahead* of the
handler that opens the next gesture; and a listener installed during a
press's own dispatch has already missed that press's capture phase, so a
gesture can never close itself. `clearGesture` is now the single place
the open gesture is dropped, because the listener has to be detached
with it.

**Docs.** [ADR 0018](../../docs/adr/0018-command-keybinding-framework.md)
(amended 2026-08-09) now says what the chords reverse: two stacks
interleaved into one timeline, one user gesture per step however many
writes and stacks it takes, `skipEditable` so a focused field keeps its
native text undo, ADR 0050 for *what* they may touch, and the
consequence that unbinding them loses view undo. `undoGesture.ts` gains
the two rules above. `README.md` and `docs/CONTEXT.md` were checked and
carry no undo/history text to update — the README already points at the
shortcuts panel as the living reference for what is bound.

The roadmap still lists task 60: the ADR-0031 gate is the orchestrator's
to run, so the close isn't this branch's to make.

Commits (oldest first): `8b58d31` rename coalescing · `3004207` the
stale-gesture close · `974e9d1` ADR 0018 + the module doc.

Verification: `pnpm --dir apps/gui test` 1789 passed / 141 files (from
1787 at branch point — 2 new dom cases), `pnpm --dir apps/gui build`
clean. Host untouched, so no cargo run. Both new tests were watched
failing first: the rename case left the name at `Fue` (the last
keystroke) after one chord, and the missing-`mouseup` case had the first
chord take back the drag *and* the edit that followed it.

## Exit criteria walk (2026-08-09)

Every criterion from § Exit criteria, in order. The ADR-0031 perf gate
is the orchestrator's to run, not the implementing phases' — its
verdict is the closing entry below the five criteria.

**1. "Every allowlist mutation is undoable/redoable via the existing
chords, one step per user gesture (transaction-grouped cases tested:
panel add, element remove, cross-panel area drag, filter insert)."** —
**MET.**

- Coverage is by construction, and the construction is checkable: every
  allowlisted field (`name`, `sources`, `config`, `predicate`, `rules`,
  and the colormap's `busId` / `messageId` / `extended` / `signalName`)
  reaches an element only through `ElementRegistry.update` / `remove` /
  `create`, which is where the capture is armed (60.B, `3831dd9`;
  creation joined in 60.C, `a86c5d2`). App's other `setRegistry` callers
  — `updateTrace`, `startAllElements`, the shrink re-anchor effect —
  write the entry's runtime `trace` only, which the mask does not carry.
  `UNDOABLE_FIELDS` in `elementHistory.ts` is the allowlist in code.
- Panel add: `App.elementUndo.dom.test.tsx` "adding a panel is one step
  — the panel's own config seed is not another" (60.B).
- Element remove: "brings back a removed element and its panel in one
  chord" (60.C, `a86c5d2`).
- Cross-panel area drag: "returns a plot area dragged between two panels
  in one chord" (60.C, `589585d`).
- Filter insert: "inserting a filter upstream is one step — the filter
  goes with it" and "adding a filter from the graph toolbar is undoable
  on its own" (60.C, `b23c041`).
- Renames were the last mutation still costing a step per keystroke
  (60.C's recorded edge); closed in 60.D by "a typed rename is one step,
  not one per keystroke" (`8b58d31`).

**2. "Undo of a view change repaints mounted panels correctly (the
rehydration path, dom-tested per element-backed panel kind)."** —
**MET.** 60.A's per-kind tests are the rehydration half: `TracePanel` /
`PlotPanel` "repaints from an externally rewritten config" and "keeps
the panel's own edit — a persist is not a resync trigger";
`SignalsPanel.sections` "re-queries from an externally rewritten config"
(+ the same self-persist case); `ColorMapPanel` / `GeneratorPanel` /
`TransmitPanel` / `RbsPanel` "repaints from an externally rewritten
element — it reads the registry live" (the config-less kinds, pinned as
live readers); and six cases in `useElementPanel.dom.test.tsx` for the
hook itself. End to end through a real chord: "reverses a view change
made inside a panel, and redoes it" (the trace panel's mode toggle), and
the removal case, where the re-created plot panel repaints two areas
rather than a fresh default.

**3. "No excluded field is ever replayed by undo — pinned by a test that
snapshots-with-mask an element carrying behavior fields (rbs/transmit)
and asserts restore leaves them untouched and fires no host
reconciliation."** — **MET.** "never replays a behavior field, and never
wakes the host reconciler" (60.B, `ea9718e`): the RBS Run flag stays on
across `Mod+Z` / `Mod+Y`, and the list of `rbs_init` / `rbs_load` /
`rbs_unload` / `rbs_set_run` calls is unchanged by either chord. The
boundary is enforced twice (mask at capture, allowlisted patch at
restore), and the test was falsified before being trusted — unmasking
`rbs.path` / `run` makes the first chord disarm the simulation and the
test fail (60.B log).

**4. "Drag gestures produce single steps; filter-box typing produces
none."** — **MET.** Single steps: "a drag of the side-panel splitter is
one step, not one per mouse move", "a drag of an axis splitter is one
step", "a drag of a trace column edge is one step" (60.C, `d022d90`),
and the cross-panel area drag above. 60.D adds the case where the drag's
own end event never arrives: "a drag whose mouse-up goes missing does not
swallow the next edit" (`3004207`). No steps from typing: "typing in a
find box is not a step" (60.C, `dce7f82`) — the chord reaches straight
past the typing to the view change, and the box keeps what was typed.
Cursor placement was checked and needed no coalescing: `PlotArea` places
a cursor on mouse-up only when the pointer didn't move, so it is already
one gesture (60.C log).

**5. "The boundary ADR exists; ADR 0018's bindings/docs updated; the
existing `viewHistory` tests stay green and the new stack has equivalent
pure-function coverage."** — **MET.**
[ADR 0050](../../docs/adr/0050-undo-covers-view-state-only.md) (60.B,
`5df8e8f`) carries the allowlist, the owner's rationale, and the two
further boundaries (zoom/pan/scroll out; undo never re-runs a host side
effect). [ADR 0018](../../docs/adr/0018-command-keybinding-framework.md)
amended 2026-08-09 (60.D, `974e9d1`). `viewHistory.test.ts` is untouched
since the branch point and its 11 cases are green;
`elementHistory.test.ts` carries 35 pure cases over mask / record / sync
/ graft / amend / restore / the order log — the same shape of coverage,
and more of it, than the layout stack has.

**ADR-0031 perf gate — MET.** Run by the orchestrator, not by the
implementing phases (every phase brief said so, and each phase's status
entry records the deferral). Final gate at `33ef361`, **two runs, both
`check passed (31 metrics gated)`** — 31/31 each — with the reports
committed unmodified as
`docs/performance-measurements/frontend/2026-08-09-33ef361-task60-final-run1.json`
and `...-run2.json`. Sanity clean on both: `ids_measured` 173, and in
the committed reports `rx_fps` / `tx_fps` 1610.4 / 1610.3 (run 1) and
1605.2 / 1602.4 (run 2) with retention 0.9995–1.0013 — flat across
halves, so nothing degrades over the minute. Attribution: the
31-metrics-gated result and the `ids_measured` figure are the
orchestrator's reported harness output; the rates and retentions above
are read from the two committed reports.

That the gate is flat is the expected result rather than a lucky one:
task 60 added no work to any render or ingest path. The element history
is a masked snapshot taken in an effect that only runs when the registry
changes — a user edit, not a frame — and the two stacks are capped at 50
snapshots each.

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
- **60.B** — no blockers. Side effects worth knowing:
  - `valuesEqual` is now exported from `projectElements.ts` (it was
    module-private). Nothing else about the registry changed.
  - `applyLayoutHistory` returns a boolean now: the interleaved driver
    has to know whether a step actually applied before deciding to move
    on to the next one.
  - The undo-order log is reset wherever a view baseline is
    (`seedDefaultLayout`, project open, the boot layout restore), so a
    chord can never step from one project into another's snapshots.
  - Element *creation* is not captured — only `update` / `remove` are
    user-edit callers, per this task's mechanism note. Adding a filter
    is therefore undoable only via the layout stack (its panel) until
    60.C's transactions.
- **60.C** — no blockers. Side effects and known edges:
  - `UndoEntry` replaced the bare `UndoStack` in the order log, so
    `popUndo` / `popRedo` return `stacks` rather than `stack`. The
    element stack's `restorePatches` likewise became `restoreElements`,
    returning creates and removes beside the patches. Both are internal
    to the undo modules and their callers in `App` / `useCommands`.
  - A restore no longer patches a field the snapshot has no *value* for
    (`config: undefined` on an element grafted in before it had one).
    An absence of information is not an instruction to wipe.
  - A gesture whose closing pointer event never arrives (pointer
    released off-window, so `mouseup` / `pointerup` is missed) stays
    open until the next gesture begins; an edit in between would join
    its step. Bounded and benign — `begin()` always replaces the open
    gesture — but it is why nothing outside a pointer handler holds a
    gesture open. **Closed in 60.D**: the next `pointerdown` anywhere
    closes it.
  - **Renaming is still one step per keystroke.** The project panel's
    inline rename writes the element on every `change`, and text
    editing is not a pointer gesture, so the drag mechanism doesn't
    reach it. Coalescing it needs a different rule (an idle window, as
    editors use for typing) and was not in this phase's scope. **Closed
    in 60.D**: focus opens the gesture, blur closes it.
  - `ProjectGraphPanel`, `PlotPanel`, `PlotArea` and `gridviewColumns`
    now consume `useUndoGesture()`. Its context default is a no-op, so
    every existing panel test renders unchanged and no registry fake
    needed a new method.
- **60.D** — no blockers. Side effects and one edge left standing:
  - `ProjectPanel`'s `ElementRow` joins the list of `useUndoGesture()`
    consumers, for the same reason and with the same no-op default.
  - `clearGesture` is now the *only* place the open gesture is dropped,
    because the safety-close listener has to be detached with it. The
    four sites that used to null `gestureRef` directly — the registry
    effect's closing branch, the default-layout seed, project open, and
    the boot layout restore — route through it, which is why those
    callbacks gained a dependency.
  - A rename gesture is open for as long as the field has focus. Any
    other surface the user reaches takes focus, which blurs the field
    and closes the gesture first, so nothing else can join the rename's
    step in practice.
  - **Left standing (recorded, not taken): a keyboard-only edit after a
    lost `mouseup`.** The stale-gesture close is the next *press*, so
    the one path still open is a drag whose pointer-up went missing
    followed by an element edit made without touching the pointer at
    all — pressing `l` over a plot (`plot.followLive.enable`, which
    persists) is the reachable example. That edit would amend the drag's
    step instead of making its own. Closing it needs a second rule
    keyed on the keyboard, which would have to know not to close the
    rename gesture the user is typing into; the trade wasn't worth a
    second mechanism for a path that requires zero pointer presses in
    between.
