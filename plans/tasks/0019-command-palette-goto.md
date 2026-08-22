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
  (derived events stay read-only). No F2 handling exists anywhere
  in the frontend today; decide whether it lands in the gridview
  layer (an action key beside Space) or stays view-local.
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

## Blockers / side effects

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
