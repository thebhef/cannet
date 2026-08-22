# Task 19 — Argument-Taking Palette Commands

The framework itself (registry, bindings, palette,
`Cmd/Ctrl+Shift+P`, `Cmd/Ctrl+P` go-to-view, fuzzy matcher) shipped
in **Task 16**. Save-with-picker (`capture.save`), the close
commands, and the list-select go-to-event palette shipped with
**Task 37**. Pulled forward from position 32 and groomed by owner
instruction 2026-08-21; design questions resolved by owner rulings
the same day.

Two steps: the typed-argument prompt infrastructure with the
commands that need it, then keyboard interaction for the events
rows.

## Step 1 — typed-argument prompts and the goto commands

Commands that prompt for a value, validate it, and drive a view to
a target:

- `goto.timeInTrace` — prompt for a time in **seconds since
  session start, non-negative** (owner ruling 2026-08-21; a
  negative value is a validation error, not a pre-session seek).
  Broadcast the target on the existing `GOTO_EVENT` bus
  (ADR 0035), so the trace scrolls and every plot re-centres, same
  as go-to-event. Bound to **`Mod+T`**.
- `plot.setVisibleRange` — set the focused plot's visible
  x-window. **Both input forms** (owner ruling 2026-08-21): two
  numbers (space / comma / `..` separated) = min and max in the
  units the x-axis shows; a single number = new window *width*
  keeping the current centre. Per-panel; must go through the
  programmatic x-window path (`applyXAll` → follow-live off →
  x-epoch bump) or the jump lands on an empty slice.
- `goto.event` (already shipped) gains the **`Mod+E`** binding.
  Neither `Mod+T` nor `Mod+E` collides with the default binding
  set.
- `goto.traceRow` was **dropped to the backlog** (owner ruling
  2026-08-21): a raw row number over the event-merged view is a
  shaky target and no use case named it.

### Infrastructure

- `PalettePrompt` (the palette's existing second stage, used by
  `panel.rename`) grows an optional validator with an inline error
  line: invalid input shows the error and keeps the prompt open —
  today a bad value is silently discarded.
- `panelCommands.invoke` / `PanelCommandHandlers` gain an optional
  argument, so a prompt-collected value can reach the focused
  panel's handler (`PlotPanel` adds `plot.setVisibleRange` beside
  its existing three).
- Argument parsing is pure functions with unit tests (the
  `gotoEventItems` test style).

## Step 2 — keyboard interaction for event rows

The events view is `TraceView` rendering only event rows, and it
**is on the common gridview control** (ADR 0044) — confirmed
2026-08-21: it sits on the gridview *interaction* base (cursor,
row DOM ids, `aria-activedescendant`, click policy) and off its
*row template*, which `EventsPanel`'s header comment documents as
deliberate. So arrow / Home / End / Page navigation comes from the
layer already; what's missing is the actions — and they apply to
event rows **in both surfaces** (owner ruling 2026-08-21): the
events view and the trace panel's interleaved event rows carry the
same row content and the same interactions.

- **Space = goto.** The gridview layer reserves Space for a
  panel's primary action (`onPrimaryAction`); `TraceView` binds
  none today. Space on the cursor's event row emits the same
  `GOTO_EVENT` broadcast the row's goto button does. This means
  the trace panel also supplies `onGoto` (today only `EventsPanel`
  does, and the button is hidden where it's absent).
- **F2 = edit.** Begin inline rename of the cursor's event row —
  the same edit clicking the label starts; editable rows only
  (derived events stay read-only). No F2 handling existed anywhere
  in the frontend. **It lands in the gridview layer**, an action key
  beside Space (overseer ruling 2026-08-22): event rows appear in two
  surfaces, so view-local means writing it twice and letting the two
  drift. ADR 0044 amended with the vocabulary that now stands.
- **Verify the ARIA surface** against the other gridviews
  (`useGridview.dom.test.tsx` patterns) and close gaps found, in
  scope only for the event rows.

### Out of scope

- **Filtering in the events view** — owned by
  [Task 102 — The Event Surface](0102-event-surface.md), which
  makes kinds a real axis and filters by kind / record type / tag
  (owner ruling 2026-08-21: stay away from 102's scope).
- Multi-field prompt forms; no command needs one yet.
- Relative time input (`+N`/`-N` from the current view position) —
  needs a per-panel position readback that doesn't exist; not
  wanted now.
- The palette-vs-local boundary: these commands are palette
  commands (keyboard-driven navigation of a view, ADR 0037);
  purely positional mouse affordances stay local-only.

## Exit criteria

1. `goto.timeInTrace` and `plot.setVisibleRange` registered,
   context-gated, reachable from the palette; `Mod+T` / `Mod+E`
   bound with the registry conflict check green.
2. Invalid prompt input (non-numeric, negative time, empty or
   inverted range) shows an inline error and re-prompts instead of
   silently closing.
3. Argument parsing covered by pure unit tests; prompt behaviour
   and Space / F2 on event rows (both surfaces) by DOM tests;
   registry invariants stay green.
4. Event rows: full gridview keyboard interaction — navigate,
   Space to goto, F2 to rename — verified against the gridview
   test patterns, in the events view and the trace panel alike.
5. ADR 0018 amended (command arguments are recorded there as an
   explicit non-goal); ADR 0044 amended if the action-key
   vocabulary grows. This file, the roadmap, and the backlog
   (`goto.traceRow` entry) reflect what shipped.

## Status log

### 2026-08-22 — Step 1 landed (typed-argument prompts and the goto commands)

Branch `task-19-step-1-typed-arguments`, off `8889309f`. Frontend-only
(no Rust touched). Baseline: `npx vitest run` 2625 passed / 199 files.
After: **2662 passed / 200 files** (+37 tests, +1 file
`plotVisibleRange.test.ts`). `npx tsc --noEmit` and `npx vite build`
both clean throughout. `git grep -Ein "task [0-9]|plans/" -- apps/
crates/` empty.

Commits:

- `PalettePrompt gains an optional validator with an inline error
  line` — `apps/gui/src/PaletteModal.tsx`,
  `apps/gui/src/PaletteModal.dom.test.tsx`, `apps/gui/src/index.css`.
  Invalid input shows the error and keeps the prompt open instead of
  the value being silently discarded (`panel.rename`'s prior
  behaviour). Mutation-tested: removing the early `return` after
  `setError` makes "invalid input shows an inline error and keeps the
  prompt open" fail (`onSubmit` fires anyway); restored, green again.
- `panelCommands.invoke passes an optional argument through to the
  handler` — `apps/gui/src/panelCommands.ts`,
  `apps/gui/src/panelCommands.test.ts`. `PanelCommandHandlers` is now
  `Record<string, (arg?: string) => void>`; existing zero-arg handlers
  stay assignable (TS's fewer-parameters rule), confirmed by
  `tsc --noEmit`.
- `Add pure argument parsing for goto.timeInTrace and
  plot.setVisibleRange` — `apps/gui/src/gotoEvent.ts` (+
  `parseTimeInTrace`, `timeInTraceTargetNs`) and
  `apps/gui/src/gotoEvent.test.ts`; new
  `apps/gui/src/plotVisibleRange.ts` (`parseVisibleRangeInput`,
  `resolveVisibleRange`) and `apps/gui/src/plotVisibleRange.test.ts`.
  25 new unit tests covering non-numeric, empty, negative time,
  inverted/zero-width range, all three separators
  (space/comma/`..`), and single-number-means-width.
- `Register goto.timeInTrace and plot.setVisibleRange, bound to
  Mod+T / Mod+E` — `apps/gui/src/commands.ts`,
  `apps/gui/src/commands.test.ts`. `goto.timeInTrace` is gated on
  `hasProjectOpen` (no existing command spec covers "a command that
  targets the session timeline" more precisely than that);
  `plot.setVisibleRange` is gated on a focused plot
  (`plotFocused`, the same predicate `plot.fitXAxis` uses). The
  boot-time `findBindingConflicts` assertion (runs at import) stays
  green with both new bindings in `DEFAULT_BINDINGS`.
- `Wire goto.timeInTrace's prompt and plot.setVisibleRange's panel
  routing` — `apps/gui/src/useCommands.tsx`. `goto.timeInTrace`
  parses and broadcasts on `GOTO_EVENT` directly (it has no per-panel
  target); `plot.setVisibleRange` hands the raw text to
  `runFocusedPanelCommand`, since only the focused plot knows the
  current window a bare width resolves against.
- `PlotPanel implements plot.setVisibleRange through the programmatic
  x-window path` — `apps/gui/src/PlotPanel.tsx`,
  `apps/gui/src/PlotPanel.dom.test.tsx`. The handler parses the text,
  resolves it against `xSyncRef`'s current window, then applies it
  exactly the way `fitToRange`/`gotoNote` do: `applyXAll` →
  `setFollowLive(false)` → `bumpXEpoch()`. Mutation-tested: on a
  *stopped* trace, deleting the `bumpXEpoch()` call makes the
  "re-samples a stopped panel" assertion fail (`sampleCalls()` stays
  flat) even though the uPlot x-scale still moves; restored, green
  again. The test performs the jump twice so the assertion isn't
  masked by follow-live's own drop-to-false resample effect (see
  Blockers below).
- `Amend ADR 0018 for the typed-argument prompt` —
  `docs/adr/0018-command-keybinding-framework.md`. Replaces the
  "command arguments are an explicit non-goal" consequence with an
  amendment describing the single-field prompt (not a form) and the
  two argument-delivery paths (palette-global vs. per-panel).
- `Record task 19 step 1's status in the task file` — this file.

### Exit-criteria verdicts

Step 1 covers criteria 1, 2, 3, and the ADR-0018 half of 5; criterion
4 and the ADR-0044/roadmap/backlog half of 5 are step 2's and the
overseer's.

1. **Met.** Both commands are in `COMMANDS` (`commands.ts`),
   context-gated (`hasProjectOpen` / `plotFocused`), and therefore
   included in `commandPaletteItems` by construction
   (`commandsAvailableIn`) — the same mechanism every other palette
   command relies on, exercised by `commands.test.ts`'s
   `commandsAvailableIn` assertions. `Mod+T` → `goto.timeInTrace`,
   `Mod+E` → `goto.event` in `DEFAULT_BINDINGS`; the boot-time
   `findBindingConflicts` assertion (which throws at module import on
   a collision) stays green, and `commands.test.ts` asserts both
   chords directly. Not independently re-verified: an end-to-end
   render of the actual command palette listing these two rows —
   no other command in this file has that level of test either
   (`commandsAvailableIn` is the established boundary).
2. **Met** for the general mechanism and both commands' parsers.
   `PalettePrompt`'s validator/inline-error/re-prompt behaviour is
   DOM-tested and mutation-proven (see above). `parseTimeInTrace`
   and `parseVisibleRangeInput` each reject every case named (non-
   numeric, negative time, empty, inverted range) with unit tests.
   The two-line wiring in `useCommands.tsx` (`validate: (value) =>
   parsed.ok ? null : parsed.error`) composes these two
   already-tested pieces but has no dedicated top-to-bottom test of
   its own — see Blockers below.
3. **Met** for step 1's half. Argument parsing: 25 new pure-function
   unit tests. Prompt behaviour: DOM-tested (`PaletteModal.dom.test.
   tsx`), mutation-proven. `plot.setVisibleRange`'s panel-side apply
   step (the `applyXAll` path) is DOM-tested against a *stopped*
   trace and mutation-proven for the x-epoch bump specifically.
   Registry invariants (`commands.test.ts`, `panelCommands.test.ts`)
   stay green. Space / F2 on event rows is step 2's half — not
   attempted here.
4. **Not attempted** — step 2's scope.
5. ADR 0018 amendment: **met** (see commit list). ADR 0044 / roadmap /
   backlog: step 2's and the overseer's — not touched here per
   instruction.

### 2026-08-22 — Step 2 landed (keyboard interaction for event rows)

Branch `task-19-step-2-event-row-keys`, off `d966fb3d`. Frontend-only
(no Rust touched, so the Rust gates were not run). Baseline:
`npx vitest run` 2662 passed / 200 files. After: **2682 passed / 200
files** (+20 tests, no new files). `npx tsc --noEmit` and
`npx vite build` clean throughout. `git grep -Ein "task [0-9]|plans/"
-- apps/ crates/` empty — it was *not* empty at the start of this step
(`plotVisibleRange.ts`'s header, from step 1, named the task), and that
line is fixed in the first commit below.

Commits:

- `2dd618d6` **The gridview layer takes F2 as a second action key
  beside Space** — `apps/gui/src/useGridview.ts` (+ `onRenameAction`),
  `apps/gui/src/useGridview.dom.test.tsx`,
  `apps/gui/src/keybindings.ts` (F2 joins the gridview-consumed key
  set, so `isGridviewKey` / `chordSuppressedInGridview` /
  `ShortcutsPanel` all agree), `apps/gui/src/keybindings.test.ts`,
  `docs/adr/0044-gridview-interaction-base.md`. Overseer ruling
  2026-08-22: F2 lands in the layer, not view-local, because event rows
  appear in two surfaces and a per-view copy is what drifts.
  Mutation-tested: moving the F2 branch above the editable-target
  early return makes "leaves F2 to a field that is already being
  edited" fail; restored, green again.
- `d4248310` **Space goes to an event row's event, and F2 renames it**
  — `apps/gui/src/TraceView.tsx`,
  `apps/gui/src/TraceView.gridview.dom.test.tsx`,
  `apps/gui/src/index.css`. Three changes that had to go together:
  (a) the rename state moves from `EventRow` to `TraceView`
  (`editingEvent`, keyed by event id) so the layer's F2 can reach it —
  keying by id also deletes the reset a recycled row slot needed;
  (b) `onPrimaryAction` resolves the cursor's row to its
  `TimelineEvent` through the render window and calls
  `eventActions.onGoto`, `onRenameAction` does the same and opens the
  editor **only** where `event.editable && eventActions != null`;
  (c) the row's own click-focus state (`focusedEvent`) is deleted and
  `.trace-event-focused` now follows the gridview cursor, so arrowing
  onto an event says which row the two keys will act on — it said
  nothing before. Also: ending the rename hands the keyboard back to
  the grid, which the field unmounting had left on the document body.
  Mutation-tested three ways — dropping `!event.editable` fails the
  derived-event test; dropping `eventActions == null` fails the
  no-actions test; disabling the focus-return fails the
  hands-the-keyboard-back test. Each restored, green again.
- `f8881e77` **The trace panel's event rows carry the goto control the
  events view has** — `apps/gui/src/TracePanel.tsx` (+ `onGoto`),
  `apps/gui/src/TracePanel.dom.test.tsx`,
  `apps/gui/src/EventsPanel.dom.test.tsx`,
  `apps/gui/src/TraceView.tsx` (doc), `apps/gui/src/index.css` (doc).
  Layout check before wiring it: `.trace-event-goto` is
  `flex: 0 0 auto` placed between the time cell and the swatch, so
  unlike the `margin-left: auto` ✎ / × it is left-anchored and the
  trace's 1144 px column layout cannot push it off the row (the narrow-
  panel defect recorded in `EventsPanel.dom.test.tsx`); it costs the
  label ~1 ch of width. Mutation-tested for the both-surfaces claim:
  unbinding `onPrimaryAction` / `onRenameAction` in `TraceView` fails
  three tests in `EventsPanel.dom.test.tsx` **and** three in
  `TracePanel.dom.test.tsx`; restored, green again.
- `6ed6a9bb` **goto.timeInTrace is ungated, like the goto.event beside
  it** — `apps/gui/src/commands.ts`, `apps/gui/src/commands.test.ts`.
  Resolves step 1's recorded inconsistency; reasoning below.
- `e4071d42` **An event row states its disclosure where the cursor can
  read it** — `apps/gui/src/TraceView.tsx`,
  `apps/gui/src/EventsPanel.dom.test.tsx`,
  `apps/gui/src/TracePanel.dom.test.tsx`. The ARIA sweep's findings;
  see below.
- `e3bde833` **Document the event row's shared controls and its
  keyboard** — `README.md`.
- This entry.

#### The `goto.timeInTrace` gate (step 1's open question)

**Resolved by removing the gate**, so both goto commands are ungated.
Evidence, not preference: `hasProjectOpen` is `projectPath !== null` —
a project *file* is open — and the only other command in `COMMANDS`
that uses it is `project.close`, which is the one thing that genuinely
needs a project file. Every capture-scoped command beside it
(`trace.import`, `capture.clear`, `capture.save`,
`connection.connect`) is ungated. A session needs no project: a BLF
imported standalone is exactly the case where jumping to a time is
wanted, and the gate hid the command there. The predicate that would
have been right — "a session/capture is loaded" — is not a
`CommandContext` dimension, and inventing one for a command that is
harmless when it broadcasts into an empty session is not worth the
registry surface. `commands.test.ts` now asserts both gotos available
with and without a project, with `project.open` / `project.close` as
the control that the context object is doing something.

#### The ARIA sweep (event rows only)

Measured against what the other gridviews put on a row —
`DatabasePanel`'s tree row, `RbsPanel`'s bus/ECU rows, `ByIdTable`,
and the `useGridview.dom.test.tsx` harness.

Correct already, left alone: the container carries `data-gridview`,
`tabindex="0"` and `aria-activedescendant` (asserted in
`TraceView.gridview.dom.test.tsx`); the row carries the DOM id
`rowDomId` mints; every control on the row has an `aria-label`
(`go to this event`, `rename event`, `remove event`, `pick event
color`, `show/hide event details`, `event label`); the empty caret slot
is `aria-hidden`; **no** `aria-selected` — an event row is not
selectable and claiming the attribute would say it is (the same
`selectable ? selected : undefined` shape `DatabasePanel` uses).

Two gaps found and closed:

1. **`aria-expanded` was on the caret only, not on the row.** The
   cursor names the *row*, so a reader following
   `aria-activedescendant` never reached the caret's copy and was told
   nothing about the disclosure. Both the database and RBS trees put it
   on the row *and* on the toggle; event rows now do too, absent (not
   `false`) where there is nothing to open.
2. **The caret was in the tab order.** Every other gridview's caret is
   `tabIndex={-1}` — what it does is already Left/Right's — so Tab into
   the row spent its first press on a control the keyboard already had.
   It now lands on the goto button.

Recorded, not fixed (not event-row-scoped) — see Blockers.

### Exit-criteria verdicts — the whole task

Walked at the close of step 2. Where step 1 earned a verdict, its
evidence is cited rather than re-derived.

| # | Verdict | Earned by |
|---|---|---|
| 1 | **Met** (step 1, amended in step 2) | Both commands are in `COMMANDS` and therefore in `commandPaletteItems` by construction (`commandsAvailableIn`, asserted in `commands.test.ts`); `Mod+T` → `goto.timeInTrace` and `Mod+E` → `goto.event` in `DEFAULT_BINDINGS`, with the boot-time `findBindingConflicts` assertion green (`commands.test.ts` "is conflict-free (the boot assertion)"). *Context gating changed in step 2*: `goto.timeInTrace` is now ungated (see the gate note above); `plot.setVisibleRange` keeps `plotFocused`. |
| 2 | **Met** (step 1) | `PaletteModal.dom.test.tsx`'s validator/inline-error/re-prompt test, mutation-proven in step 1 (removing the early `return` after `setError` makes it fail). Every rejected case — non-numeric, negative time, empty, inverted/zero-width range — is a unit test in `gotoEvent.test.ts` / `plotVisibleRange.test.ts`. |
| 3 | **Met** (both steps) | Pure parsing: 25 unit tests (step 1). Prompt behaviour: `PaletteModal.dom.test.tsx` (step 1). Space / F2 on event rows, both surfaces: `TraceView.gridview.dom.test.tsx` (7 tests at the renderer), `EventsPanel.dom.test.tsx` (3), `TracePanel.dom.test.tsx` (3) — and the both-surfaces claim is mutation-proven, not assumed (unbinding the two callbacks in `TraceView` reddens tests in each panel's file). Registry invariants: `commands.test.ts`, `panelCommands.test.ts`, `keybindings.test.ts` all green. |
| 4 | **Met** (step 2) | Navigate: `TraceView.gridview.dom.test.tsx` "leaves a timeline event out of the selection but on the cursor's path" (pre-existing) plus the new "marks the event row the cursor lands on". Space→goto and F2→rename, with the derived-event gate as its own case: the three tests named under criterion 3, in the events view **and** the trace panel. Verified against the gridview patterns: the layer's own F2 tests sit beside its Space tests in `useGridview.dom.test.tsx`, and the ARIA sweep above measured the row against `DatabasePanel` / `RbsPanel` / `ByIdTable`. |
| 5 | **Met** for the ADRs; the roadmap/backlog half is the **overseer's** | ADR 0018 amended in step 1 (`eeabe054`). ADR 0044 amended in step 2 (`2dd618d6`): F2 added to the key table and to the dispatcher-suppression sentence, plus a new paragraph fixing the action-key vocabulary (Space = primary action, F2 = rename/edit) and the rule for growing it. This file records both steps. `plans/tasks/roadmap.md` and `plans/backlog.md` (the `goto.traceRow` entry) were **not touched** — the overseer owns them, per this step's instructions; not claimed and not failed here. |

Not verified, deliberately: no GUI launch and no ADR-0031 perf run (both
the overseer's), and no keyboard behaviour was exercised through a real
window — every key in this step is proven in jsdom only.

## Blockers / side effects

- ~~**`goto.timeInTrace`'s context gate is a judgment call, not a
  groomed decision.**~~ **Resolved in step 2** (`6ed6a9bb`): the gate is
  gone and both gotos are ungated. Reasoning in step 2's status entry.
  Original note follows.
- **`goto.timeInTrace`'s context gate is a judgment call, not a
  groomed decision.** The task names `Mod+T` / `Mod+E` and the
  conflict-free requirement but doesn't specify a predicate for
  `goto.timeInTrace` (unlike `plot.setVisibleRange`, which the "per-
  panel" wording ties to a focused plot). `hasProjectOpen` was chosen
  as the closest existing fit — the same gate `project.close` and a
  few other project-scoped commands use — since there is no
  `CommandContext` dimension for "a session/capture is loaded" and
  adding one is out of this step's scope. `goto.event` (already
  shipped) has no context gate at all, so this is not fully
  consistent with its sibling; recorded rather than silently
  resolved either way.
- **The `useCommands.tsx` wiring for both new commands has no
  dedicated test of its own.** Each command's handler in
  `commandHandlersRef.current` is a few lines that compose
  already-tested pure functions (`parseTimeInTrace` /
  `parseVisibleRangeInput`) with already-tested components
  (`PalettePrompt`, `runFocusedPanelCommand`) — the same level of
  coverage every existing handler in that file has (e.g.
  `panel.rename`'s `setPrompt` call, or `goto.event`'s `emit` on
  pick, neither of which has its own test beyond the pieces they
  compose). A `useCommands`-level harness exists in the codebase
  (`SignalsPanel.gridview.dom.test.tsx`'s `CommandsHarness`, built for
  ADR 0044's D10 case) but building an equivalent one for these two
  commands looked like new test infrastructure for a two-line
  handler, out of proportion with the rest of the file's coverage.
  Flagging rather than silently deciding it doesn't matter.
- **`plot.setVisibleRange`'s width form falls back to `[0,
  follow_window_ms/1000]` when the panel has no window yet** (no area
  has resampled since mount, so `xSyncRef.current.xMin/xMax` are both
  still `null`). Not named by the owner ruling either way; chosen to
  mirror `centerWindowOn`'s existing null-tolerance rather than
  invent a new convention. Untested directly (would need a panel with
  zero resamples yet a mounted uPlot instance, which the existing
  harness doesn't easily produce) — noted as a gap, not a groomed
  decision at risk.

Recorded by step 2:

- **No gridview container or row in the trace views declares an ARIA
  role.** `.trace-rows` carries `aria-activedescendant` with no
  `role="tree"` / `"listbox"` / `"grid"` on it, and neither the frame
  rows (`GridviewRow`) nor the event rows carry `role="treeitem"` —
  where `DatabasePanel` and `RbsPanel` do. `aria-activedescendant` is
  inert to assistive tech without an owning role, so the cursor the
  layer maintains is not actually announced in these two views. Fixing
  it is a whole-container change touching every row type in `TraceView`
  and `ByIdTable`, not an event-row one, so it is recorded rather than
  swept — this step's ARIA licence was event rows only.
- **An event row is `tabIndex={0}`, so every event row on screen is its
  own tab stop.** That predates this step and has an explicit test
  asserting it (`EventsPanel.dom.test.tsx`, "the row is a focus target
  in its own right"), and it means a click leaves DOM focus on the row
  rather than on the container — where `aria-activedescendant` lives.
  The grid's keys still work (they bubble to the container), so nothing
  in this step is blocked by it; but the row-focus and
  container-focus models coexist, and only one of them is ADR 0044's.
  Left as found.
- **The other inline editors in `TraceView` still end an edit with
  focus on the document body.** Step 2 fixed the event *label* editor
  (the one F2 opens) by returning focus to the grid once the field
  unmounts. `EventBody`'s tag and description editors, which keep their
  own local `editing` state, do not: Enter or Escape in one of them
  unmounts the field while it is still `document.activeElement`, so the
  layer's own recovery — which checks for `body` during the keypress —
  never fires, and the arrows are dead until the user clicks. Same
  shape as the bug that was fixed, one level down; out of this step's
  scope (nothing here opens those editors from the keyboard).
- **The event row's caret is not the shared `DisclosureToggle`.** Every
  other gridview's disclosure is that component (24 px hit target, one
  glyph/rotation implementation, ADR 0044's "real control" rule);
  `EventRow` draws its own `▸` / `▾` button. Step 2 gave it the
  component's `tabIndex={-1}` behaviour but did not swap the
  implementation — that is a row-template change, and `EventsPanel`'s
  header comment documents the row template as deliberately bespoke, so
  it wants a decision rather than a drive-by.
- **`plotVisibleRange.ts` named the task in a source comment**, which
  the `comment-references` CI job forbids; step 1's status entry
  reported that grep as empty. Fixed in `2dd618d6` — noted because the
  step-1 verdict was recorded on an unchecked claim.
