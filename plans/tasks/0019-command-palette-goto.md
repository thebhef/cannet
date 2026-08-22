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
