# Task 59 — Minor UX Round

Eight small items groomed 2026-08-08, sequenced after task 58 (owner:
"perf issues first"). Exploration map with file:line seams produced
the same day; key pointers folded in.

## Items

### 1. Theme menu: light / lighthk / dark

Today `theme` stores `dark|light` but "light" renders the pink
`normal` theme unless the `normal_mode` developer toggle is on
(`theme.ts:263-265`, `settings.rs:514,526`). Owner ruling
(2026-08-08): the settings combobox offers **`dark`, `light`,
`lighthk`** — `light` is the genuinely-light theme (today's
light+normal_mode=true), **`lighthk` is the pink theme** (literal
value in the combobox), `dark` unchanged — and the `normal_mode`
setting is **deleted**, collapsing the `ThemeSetting`/`ThemeName`
split into one three-value setting. Touch-points: `THEMES` in
`settings.rs:514` (descriptor-driven UI follows), `theme.ts` types +
`THEMES` record + `resolveTheme` retirement, rename the
`:root[data-theme="normal"]` token block to `lighthk`
(`index.css:341-489`) — all 134 tokens stay, `theme.test.ts` /
`palette.test.ts` mirrors updated. Fix the inverted CSS comment at
`index.css:325-326` while rewriting that block. Settings-migration
note: existing `normal_mode` keys in settings files are dropped;
stored `theme: "light"` now renders actually-light (the pink default
era ends — deliberate).

### 2. No-project launch restores window geometry only

Confirmed bug (map, 2026-08-08): `persistLayout` fires on every
layout change with no project-open check (`App.tsx:2256`) and boot
unconditionally restores `state.json`'s layout (`App.tsx:2227-2239`),
so a scratch session's detailed view state reappears next launch.
Window geometry has its own plugin-owned track
(`tauri_plugin_window_state`, `lib.rs:443-452`) which already does the
right thing — untouched. Fix: gate the layout write on a project
being open, and skip the saved-layout restore (seed the default)
when no project reopen is coming. Ordering wrinkle: the reopen
decision resolves async after the restore point — hoist it or accept
a briefly-seeded layout that `applyProject` replaces; record the
choice. `carry_workspace_scope` (`project_dir.rs:232`) keeps or drops
the layout on Save-As deliberately. Pins to update, not weaken:
`App.bootReopen`, `App.bootOpenOnce`, `App.sessionReset`,
`dockLayout` dom tests.

### 3. Ctrl+F focuses the focused panel's find/filter box

No `Mod+F` binding exists; the ADR-0018 command registry +
focused-panel routing already support panel-local commands
(precedent: `plot.fitXAxis`, `useCommands.tsx:421`,
`PlotPanel.tsx:793-796`). Add a `panel.find` command bound to
`Mod+F` (no `skipEditable`), a `FINDABLE_PANEL_KINDS` context list,
and per-panel registrations: plot solo box (ref + focus/select), RBS
filter via a forwarded `inputRef` on `GridviewFilterBox`
(`gridviewFilter.tsx:186`). DBC/Settings are singletons —
`runFocusedPanelCommand` resolves by `elementId` only
(`useCommands.tsx:312-318`); extend routing to fixed panel ids or
defer those two (decide in-phase by cost; plot+RBS ship regardless).

### 4. Solo filter behavior bugs (three, each with a failing test first)

- Pattern-derived signals never match the solo filter (matching runs
  over stored picks, not the effective materialized list — verify at
  the `soloMatchList` derivation).
- Clearing the solo regex leaves series unpainted/stale until a
  zoom forces a repaint — the deactivation path must trigger the same
  redraw the activation path does.
- PageUp/PageDown match-stepping only works with focus in part of the
  plot view (`onPanelKeyDown` target scope, `PlotPanel.tsx:2029`) —
  it should work anywhere in the plot panel.

### 5. Autosave-on-exit project setting

New `UserOverridable` key (user-level default, per-project override in
`.cannet/settings.json` — the existing two-layer cascade,
`settings.rs:854-855`; no third storage layer). Owner rulings
(2026-08-08): when enabled, a dirty close **saves silently instead of
prompting — explicit-dir projects only**; unsaved/auto-located
sessions are inert (dirty prompt unchanged — no auto-minting a
project file). Wire into the `onCloseRequested` flow
(`App.tsx:1783-1810`).

### 6. Escape exits gridview row content back to keyboard nav

Tabbing into a row's content works (the task-54 Tab contract in the
shared `useGridview`); Escape should return focus to the parent
row/gridview, ready for arrow-key navigation again. Observed in RBS
(owner, 2026-08-08); establish it as a gridview-common behavior in the
shared hook so every gridview view gets it, with RBS as the reference
case. Mind existing Escape consumers inside content (e.g. inputs that
clear on Escape) — content handlers keep first claim; the gridview
takes Escape only when the content didn't consume it.

### 7. Shift+Up/Down extends gridview selection

VS Code-style semantics (owner, 2026-08-08; unspecified until now,
not a regression): Ctrl+click toggles individual items (exists);
Shift+Up/Down moves the cursor and selects the range from the anchor
to it — the destination item joins the selection, the anchor (current
item) is the range's fixed end, and reversing direction shrinks the
range back through it. Belongs in the shared gridview selection model
(`gridviewSelection.ts` already carries anchors for Shift+click
ranges) so every gridview and the plot signal rows behave alike.

### 8. Builds stamp `-dirty` on the version

Owner (2026-08-08): built binaries carry a `-dirty` version suffix
and shouldn't. Investigate before fixing — first question to settle
(owner, 2026-08-08): **is `-dirty` stamped on every build, or is it
specific to how CI writes the version?** Then find what actually
dirties the tree at version-stamp time during a build from a clean
checkout (known local suspect: `package-lock.json` line-ending churn
on Windows; generated/sidecar build outputs are candidates too), and
fix the cause — untracked-output hygiene, `.gitattributes`, or stamp
ordering. Scope includes CI: builds out of CI must come out with
clean versions, and the owner wants a written report of what the
issue was when done. Do NOT simply drop the dirty marker: a genuinely
dirty tree should still say so; the defect is that a clean checkout's
build reports dirty.

## Phases (orchestrator plan 2026-08-09)

Launched under the owner's standing "implement tasks 58-60" directive.

Chained off `task58f-incremental-paint`, strictly sequential, one new
branch per phase, main working tree, orchestrator reviews diffs
between phases. 59.A's first commit carries this plan section.

- **59.A** `task59a-theme-menu` (Sonnet) — item 1: dark/light/lighthk,
  `normal_mode` deleted, CSS token block renamed, mirrors updated.
- **59.B** `task59b-scratch-layout` (Opus) — item 2: no-project launch
  restores window geometry only; the async-ordering wrinkle is the
  design point, choice recorded.
- **59.C** `task59c-ctrl-f` (Sonnet) — item 3: `panel.find` on `Mod+F`,
  plot solo + RBS; DBC/Settings by cost, deferral recorded if skipped.
- **59.D** `task59d-solo-bugs` (Opus) — item 4: three failing-test-first
  solo-filter fixes. ADR-0031 gate after (plot repaint paths).
- **59.E** `task59e-autosave-exit` (Sonnet) — item 5: autosave-on-exit
  setting, explicit-dir projects only.
- **59.F** `task59f-gridview-keys` (Opus) — items 6+7: Escape back to
  nav + Shift+Up/Down range select, in the shared gridview machinery.
- **59.G** `task59g-dirty-version` (Opus) — item 8: `-dirty`
  investigation-then-fix, CI included, written cause report. Final
  ADR-0031 gate + exit-criteria walk.

## Exit criteria

- Theme combobox offers exactly dark/light/lighthk with the ruled
  semantics; `normal_mode` gone from code, descriptors, and settings
  files; theme mirror + palette contrast tests green across all three
  themes.
- A no-project session restores window size/position only (dom-tested
  both directions: scratch layout not restored; project layout still
  restored via its own channel).
- Ctrl+F focuses the find/filter box in the focused plot (solo) and
  RBS panels, command-palette listed, no binding conflicts (registry
  self-check green); DBC/Settings covered or the deferral recorded.
- The three solo bugs have regression tests that fail pre-fix and
  pass post-fix.
- Autosave-on-exit saves an explicit-dir project silently on dirty
  close, prompts otherwise, overridable per project (tested at the
  close-flow seam).
- Escape in gridview row content returns focus to the row/gridview
  with keyboard nav live, without stealing Escape from content that
  consumes it — dom-tested in the shared hook and in RBS.
- Shift+Up/Down extends the selection directionally from the anchor
  in every gridview and the plot signal rows (tested in the shared
  selection model + one consumer each).
- A build from a clean checkout stamps a version without `-dirty`,
  with the dirtying cause identified and fixed (a genuinely dirty
  tree still stamps `-dirty`); verified on this machine's build and
  in CI, with a written report of the cause for the owner.
- Docs updated where behavior changed (README settings/themes;
  ADR 0018 bindings list if it enumerates defaults).
