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

## Status log

- 2026-08-09 — Phase 59.A landed (`task59a-theme-menu`, off
  `task58f-incremental-paint`). Four commits:
  - `9fb512e` `docs(plans): pin the task-59 phase plan` — carries the
    Phases section this branch's task file already held uncommitted.
  - `10579b2` `feat(gui): fold the theme setting into three values,
    drop normal_mode` — Rust side: `THEMES` is now
    `["dark", "light", "lighthk"]`; `normal_mode` removed from the
    `Settings` struct, `SCOPES`, `Default`, and
    `settings_descriptor.rs`'s `DESCRIPTORS` table (and its
    now-pointless test). A stale `normal_mode` key in an existing
    `settings.json` already round-trips as a no-op under the struct's
    existing `#[serde(default)]` — no new code needed to drop it.
    `cargo test -p cannet-gui`: 529 passed, 0 failed, 4 ignored.
    `cargo clippy -p cannet-gui --all-targets`: clean.
  - `a5121a4` `feat(gui): collapse ThemeSetting into ThemeName, retire
    resolveTheme` — frontend side: `theme.ts`'s `ThemeName` is now
    `"dark" | "light" | "lighthk"` with `ThemeSetting` gone;
    `resolveTheme` retired since the setting *is* the theme name now;
    the `NORMAL` theme object (colors untouched) renamed to
    `LIGHTHK`/`"lighthk"`; `index.css`'s
    `:root[data-theme="normal"]` block renamed to `"lighthk"` (all 134
    tokens kept, only the marker comment and selector changed), and
    its header comment rewritten to state the true selection rule
    (theme setting is `lighthk`) instead of the old inverted claim
    ("selected when normal mode is enabled" — it was the reverse).
    `hostSettings.ts`, `themeSync.ts`, `theme.test.ts`,
    `palette.test.ts`, `themeSync.dom.test.ts`, and
    `PlotPanel.dom.test.tsx` updated to match — stored `theme: "light"`
    now renders genuinely light, not the pink default.
    `pnpm --dir apps/gui test`: 139 files, 1679 tests passed.
    `pnpm --dir apps/gui build`: clean.
  - `663f40b` `docs(readme): describe the three-value theme setting,
    drop normal mode` — README's Settings section now lists
    dark/light/lighthk under **Theme** and drops the **Normal mode**
    bullet entirely.
  - Re-verified after the doc commit: `cargo test -p cannet-gui` 529
    passed; `cargo clippy -p cannet-gui --all-targets` clean.
- 2026-08-09 — Phase 59.B landed (`task59b-scratch-layout`, off
  `task59a-theme-menu`). One commit:
  - `ad9442c` `fix(gui): a scratch session neither keeps nor restores
    its layout` — both halves of item 2 plus the docs they invalidate.
    Write side: `App.tsx`'s `onDidLayoutChange` calls `persistLayout`
    only when `projectPathRef.current !== null` (a new ref beside the
    `projectPath` state, because the dockview callbacks are registered
    once in `handleDockReady` and can't close over it). Restore side:
    the boot's `validateLayout(hostState().layout)` is gated on
    `reopenComing`, so a launch with nothing to reopen falls through to
    `seedDefaultLayout()`. `tauri_plugin_window_state` untouched — size
    and position resume as before. `carry_workspace_scope` untouched.
    Docs in the same commit: README's project paragraph (the sentence
    "With no project, the layout is restored from that directory's own
    view state" was exactly the removed behavior), `state.rs`'s module
    doc + `UiState::layout` rustdoc, and `hostState.ts`'s header — all
    three called it the *no-project* layout snapshot, which it now is
    the opposite of.
    `pnpm --dir apps/gui test`: 139 files, 1683 tests passed (1679
    before; four new). `pnpm --dir apps/gui build` clean.
    `cargo test -p cannet-gui`: 529 passed, 0 failed, 4 ignored.
    `cargo clippy -p cannet-gui --all-targets`: clean.
  - **The ordering choice: accept a briefly-seeded default, don't
    hoist.** The reopen decision has two parts. The pointer half —
    `hostSettings().reopen_last_project && hostState().last_project` —
    is already hydrated before first render (`main.tsx`), so it is
    readable synchronously at the restore point. The automation half,
    `diag_autostart`'s `--project`, is an IPC round trip. The gate reads
    only the synchronous half, so an automation run with no
    `last_project` pointer seeds the default layout and `applyProject`
    replaces it a moment later. Hoisting the whole decision would mean
    awaiting `diag_autostart` before the first `fromJSON`, which pays a
    flash of empty dock on **every** launch — including every ordinary
    one — to spare one extra layout swap in a self-driving run nobody is
    watching. The trade is asymmetric enough that it isn't close: the
    cost lands on the common path, the benefit on the rare unobserved
    one. Recorded in the code comment above the gate as well.
  - TDD order: the four dom tests went into `App.bootReopen.dom.test.tsx`
    (it already owns the boot-decision harness) and were watched fail
    first — the two scratch-direction ones failed ("expected
    [ 'Scratch Layout' ] to not include 'Scratch Layout'"; "expected
    { Object (grid, panels, …) } to be null"), the two
    project-direction ones passed pre-fix, which is what makes them the
    "still works" guard. Two fixture facts cost a debugging round each
    and are now comments in the file: `fromJSON` silently declines a
    grid whose sizes don't add up (the fixture is shaped like what
    dockview itself serializes under jsdom's 100×100 container), and an
    element-backed panel's tab title is re-synced from the model name
    (ADR 0019), so the marker panel has to be a singleton kind.
  - Named pins re-read and re-run, none weakened: `App.bootReopen`
    (extended in place — the `get_state` layout and `open_project`
    layout are knobs now, and its header says the reopen decision
    governs the layout too), `App.bootOpenOnce` (unaffected: it boots
    with `last_project` null and a null project layout, so it seeded the
    default before this change and still does), `App.sessionReset`
    (unaffected: seeds by the same path), `dockLayout.test.ts` /
    `dockLayout.dom.test.ts` (`validateLayout` / `stripMaximizedNode` /
    `isTabMiddlePress` semantics all untouched). 28 tests across the
    five files, green.
- 2026-08-09 — Phase 59.C landed (`task59c-ctrl-f`, off
  `task59b-scratch-layout`). Four commits:
  - `2a5cbfc` `feat(gui): register panel.find on Mod+F in the command
    registry` — `commands.ts` gains `FINDABLE_PANEL_KINDS` (`plot`,
    `rbs`, `dbc`) and the `panel.find` command gated on it; `Mod+F`
    joins `DEFAULT_BINDINGS` with no `skipEditable`, so it reaches a
    panel's find/filter box even while some other text field in the
    panel already has focus. The existing boot-time conflict
    assertion (import-time `findBindingConflicts`) stays green with no
    changes needed — confirms no prior `Mod+F` binding collided.
    `pnpm --dir apps/gui test -- src/commands.test.ts`: 28 passed (2
    new).
  - `bd443af` `feat(gui): Mod+F focuses the plot panel's solo box` —
    `usePanelCommands` in `PlotPanel.tsx` implements `panel.find` by
    focusing and selecting the solo pattern input's text (a `ref`
    added to that `<input>`). `useCommands.tsx`'s
    `runFocusedPanelCommand` now falls back to the focused dockview
    panel's fixed id when it has no `elementId` (was: no-op) — added
    ahead of the DBC commit below, harmless for element-backed panels
    since `elementId` is always set whenever a command's context
    targets one of their kinds. `pnpm --dir apps/gui test -- src/PlotPanel.dom.test.tsx`:
    153 passed (1 new).
  - `3522aeb` `feat(gui): Mod+F focuses the RBS panel's filter box` —
    `GridviewFilterBox` (`gridviewFilter.tsx`) takes an optional
    `inputRef: RefObject<HTMLInputElement>`, forwarded to the
    underlying `<input>`; `RbsPanel.tsx` wires it up the same way the
    plot panel does. `pnpm --dir apps/gui test`: 215 passed across the
    six touched files (1 new).
  - `594a96a` `feat(gui): Mod+F focuses the DBC panel's search box` —
    the cost-vs-defer call from the task file, decided in-phase: the
    routing fallback the previous commit added (fixed panel id when
    `elementId` is absent) makes DBC cheap, so it ships rather than
    being deferred. `DbcPanel.tsx` registers `panel.find` under the
    already-exported `DBC_PANEL_ID` (no per-instance element id to key
    on — DBC is a singleton). `pnpm --dir apps/gui test`: 139 files,
    1688 tests passed (1683 before; 5 new total across all four
    commits). `pnpm --dir apps/gui build`: clean. No Rust files
    touched, so `cargo test -p cannet-gui` / clippy were not re-run.
  - **The DBC/Settings decision, by cost:** DBC shipped, Settings
    deferred. DBC's cost was low once the routing fallback existed —
    one `usePanelCommands(DBC_PANEL_ID, …)` call and one `inputRef`
    prop, no circular import (`dockLayout.ts`, home of `DBC_PANEL_ID`,
    does not import `DbcPanel.tsx`). Settings is a different case
    entirely: `SettingsPanel.tsx` has no find/filter box in it at
    all — no `GridviewFilterBox`, no search input, nothing for
    `panel.find` to focus — so extending routing there would bind a
    key to nothing. `FINDABLE_PANEL_KINDS` leaves `settings` out for
    that reason, and `panel.find` is simply not listed in the palette
    while a Settings panel is focused (the "inert, not-listed" branch
    of the exit criteria).
  - TDD order: each panel's dom test (`PlotPanel.dom.test.tsx`,
    `RbsPanel.dom.test.tsx`, `DbcPanel.dom.test.tsx`) was written and
    watched fail against the unmodified panel before its
    `usePanelCommands`/`inputRef` wiring landed; `commands.test.ts`'s
    two new cases were watched fail against the unmodified registry
    first. One type-level detour: `GridviewFilterBox`'s first cut of
    `inputRef` was typed `RefObject<HTMLInputElement | null>`, which
    `tsc` rejected (`LegacyRef` wants `RefObject<HTMLInputElement>`,
    whose `.current` is already nullable) — fixed before the RBS
    commit, caught by `pnpm --dir apps/gui build` before it landed.
- 2026-08-09 — Phase 59.D landed (`task59d-solo-bugs`, off
  `task59c-ctrl-f`). Three commits. **One of the three reported solo
  bugs reproduced and is fixed; the other two do not reproduce at any
  seam this phase could reach, and the diagnosis each was groomed with
  is falsified by an experiment.** Each experiment stayed as a test.
  - `a2b03e1` `test(gui): pin solo against pattern-derived series and a
    cleared pattern` — the two characterisation experiments, both green
    against the *unmodified* panel.
    - **Item 4.1 — pattern-derived series never match the solo filter.**
      Groomed diagnosis: "matching runs over stored picks, not the
      effective materialized list — verify at the `soloMatchList`
      derivation". *Refuted at the derivation itself*:
      `soloMatchList` is `soloMatches(effectiveAreas, solo.pattern)`
      (`PlotPanel.tsx`), and `git log -S` says it has read the effective
      list since the commit that introduced solo — there has never been
      a stored-picks version. Experiment: a two-area panel whose second
      area carries `patterns: ["/EngineData/Limit"]` and no manual
      picks, so both of its rows are materialized by
      `applyAreaSelection`. Data: soloing one of them masks the other
      two rows; the position read-out counts both pattern rows; the
      match menu lists both (`Area 2 · LimitNominal`,
      `Area 2 · LimitEffective`); the step control walks them. A
      pattern-derived row is indistinguishable from a manual pick to
      every part of solo.
    - **Item 4.2 — clearing the pattern leaves the series stale until a
      zoom.** Experiment drives the observable a mask actually moves —
      a unit group's normalisation, which changes only on a resample: a
      3000 A constant and a 0–500 A signal on one per-unit axis union to
      0..3000, and soloing the second rescales it to 0..500. Data: with
      the box emptied the axis is back on the union scale without any
      further gesture. The deactivation path already resamples (the
      shared `hiddenKey` effect in `PlotArea` — solo reaches the
      renderer *as* `hidden`, so activation and deactivation are the
      same code).
  - `5e7bb8e` `fix(gui): step solo matches from anywhere in the plot
    panel` — **item 4.3, the one that reproduced.** Observation
    (owner): PgDn / PgUp step matches only with focus in part of the
    plot view. Cause, confirmed: `onPanelKeyDown` is a React `onKeyDown`
    on `.plot-panel`, so it fires only for strokes whose target is
    inside that subtree — and almost nothing in the plot view takes
    focus of its own (no `tabIndex` anywhere in `PlotPanel.tsx` or
    `PlotArea.tsx`; the canvas, the signal rows and the area chrome are
    plain divs). Experiment: mousedown on `.plot-area-canvas`, then
    dispatch PageDown at `document.activeElement`. Data pre-fix:
    `activeElement` is `document.body`, outside React's container, so
    the handler never runs and the visible set doesn't move — "expected
    body to be div.plot-panel". Only the toolbar's own controls (the
    solo box, the step buttons) kept focus inside, which is exactly the
    reported "part of the plot view". Fix: the panel root is
    `tabIndex={-1}` and claims focus on a mousedown that isn't already
    headed for an `input`/`button`/`select`/`textarea`/`a[href]`, so the
    handler's scope is the whole panel; `.plot-panel:focus` draws no
    outline (the focus is programmatic, never a tab stop). Kept as a
    panel-scoped DOM handler rather than a global binding, for the
    ADR 0018 reason already recorded above it.
  - `d48015e` `test(gui): pin the solo repaint against an in-flight
    fetch` — the third and last hypothesis for item 4.2, since a plain
    clear demonstrably repaints. Hypothesis: `resample` turns away a
    call made while a sample is already out (`resampleBusyRef`), and a
    stopped trace has no self-paced tick to retry with, so a repaint
    dropped there is dropped for good — the shape of "until a zoom
    forces a repaint". Experiment: park the fetch an "All data" click
    asks for (`mockSampleStall`), clear the pattern while it is out,
    then let it land. Data: the axis returns to its two-signal scale.
    Refuted; the test stays as the guard for that race.
  - Verification: `pnpm --dir apps/gui test` 139 files, 1692 tests
    passed (1688 before; four new). `pnpm --dir apps/gui build` clean.
    No Rust touched, so `cargo test` / clippy were not re-run.
    ADR-0031 perf gate deliberately not run here — the orchestrator
    runs it after this phase.
- 2026-08-09 — Phase 59.E landed (`task59e-autosave-exit`, off
  `task59d-solo-bugs`). Three commits:
  - `15db05c` `feat(gui): expose whether the active project directory is
    auto-located` — `active_project_is_auto_located` (`project_dir.rs`)
    wraps `ActiveProjectDir::is_auto_located`, queried fresh from the
    frontend at close time rather than mirrored into React state (the
    active directory can change mid-session on open/Save As, and the
    close flow only ever needs the answer once, at the moment it
    decides). This is the "model's own notion, not a path heuristic in
    JS" the task file called for. Landed as its own commit because it
    hit a build wrinkle worth isolating — see the blocker below.
  - `a367682` `feat(gui): add the autosave_on_exit user-overridable
    setting` — `settings.rs` (`SCOPES`, the field, `Default`, the test
    `sample()`), `settings_descriptor.rs` (one `Spec` row, `Surface::General`,
    `Kind::Behaviour`, `Control::Bool` — no hardcoded key list blocked
    it), and `hostSettings.ts`'s TS mirror. Off by default. Not yet
    wired to the close flow. `cargo test -p cannet-gui`: 529 passed, 0
    failed, 4 ignored. `cargo clippy -p cannet-gui --all-targets`: clean.
  - `1a8290a` `feat(gui): autosave-on-exit saves a dirty explicit-dir
    project silently` — the close-flow wiring in `App.tsx`'s
    `onCloseRequested`: with the setting on and
    `active_project_is_auto_located` false, it calls the same
    `handleSaveAll` a manual "Save & close" already uses and destroys
    the window itself, skipping the prompt. An auto-located directory,
    a failed save, or an unreachable host all fall through to the
    ordinary prompt unchanged — never lose the close request silently.
    Three dom tests in `App.closeConfirm.dom.test.tsx`
    (dirty+enabled+explicit-dir → silent save; dirty+enabled+auto-located
    → prompts as today; dirty+disabled → prompts as today), watched red
    against the unmodified handler first — only the silent-save case
    could fail there, which it did (`expected element).not.toBeInTheDocument()`
    finding the prompt anyway), and the fix made it green without
    disturbing the other two. README's project paragraph and Settings
    list updated in the same commit. `pnpm --dir apps/gui test`: 139
    files, 1695 tests passed (1692 before; 3 new). `pnpm --dir apps/gui
    build`: clean.
  - Re-verified after all three: `cargo test -p cannet-gui` 529 passed;
    `cargo clippy -p cannet-gui --all-targets` clean; `pnpm --dir
    apps/gui test` 1695 passed; `pnpm --dir apps/gui build` clean.

- 2026-08-09 — Phase 59.F landed (`task59f-gridview-keys`, off
  `task59e-autosave-exit`). Three commits, one per shippable behaviour:
  - `82bba5f` `feat(gui): Escape returns from a gridview row's content
    to the grid` — **item 6.** One block at the top of `useGridview`'s
    `onKeyDown`: a bare Escape whose target is not the container itself
    and which nothing has claimed refocuses the container, cursor
    untouched. **Content keeps first claim through two mechanisms, not
    one:** a control that stops propagation never reaches the handler
    (the shared `Combobox` does exactly that on Escape, closing its
    dropdown), and a control that calls `preventDefault` is read off
    `e.defaultPrevented` — which also covers a global Escape command,
    since the dispatcher's capture-phase listener preventDefaults a
    stroke it consumed *before* the synthetic event exists. Escape is
    deliberately **not** added to `isGridviewKey`: the grid taking it
    only when unclaimed is what lets `view.exitFullscreen` keep first
    claim, and adding it to the suppression set would have inverted
    that. Dom-tested both directions in the shared hook (four cases:
    from a button, from a text field, a consumer that preventDefaults,
    and Escape on the container itself passing through) plus one for
    the global-command direction, and in RBS (focus a message row's
    control → Escape → the tree has focus and the arrows move; the
    signal cell's open picker keeps the press). ADR 0044's key table and
    its "way into a row's content" paragraph updated in the same
    commit. `pnpm --dir apps/gui test`: 1703 passed (1695 before).
  - `1517946` `feat(gui): Shift+Up/Down extends a gridview's selection`
    — **item 7, the shared half.** `extendToCursor(current, from, to,
    order)` in `gridviewSelection.ts` is the whole rule: the anchor is
    the fixed end (falling back to the row the press started from, then
    to the destination), the range replaces the selection, reversing
    shrinks back through the anchor. `useGridview` moves the cursor with
    the *same* `cursorAction` the plain arrow uses and feeds the result
    in. `keybindings.ts` gains Shift+Up/Down beside Shift+Tab in both
    the per-stroke (`isGridviewKey`) and per-chord
    (`chordSuppressedInGridview`) suppression, so a user-bound Shift+↓
    can't preempt the range from the capture phase; Shift+Left/Right
    stay global. Seven pure cases in `gridviewSelection.test.ts`, two
    dom cases in the hook. `pnpm --dir apps/gui test`: 1712 passed.
  - `7c53a6b` `feat(gui): Shift+Up/Down extends the plot's signal-row
    selection` — **item 7, the plot consumer.**
    `extendPlotSignalSelection` steps through the area's ordered signal
    keys using the gridview's own `cursorAction` over a flat
    `arrayRowSpace`, then calls the shared `extendToCursor` — one
    movement rule and one selection rule for both consumers, no second
    copy. `PlotSignalSelection` grows a `cursor` beside its `anchor`
    (a range gesture moves only one of the two); every click sets it.
    The press is handled on the panel root next to the solo stepping,
    because the signal rows take no focus of their own. Six pure cases
    plus three dom cases (extend/reverse, inert with nothing selected,
    and the solo box keeping Shift+arrow for text selection).
    `pnpm --dir apps/gui test`: 139 files, 1721 passed (1695 at the
    start of the phase; 26 new). `pnpm --dir apps/gui build` clean. No
    Rust touched, so `cargo test` / clippy were not re-run. ADR-0031
    perf gate deliberately not run — the orchestrator runs it.
  - TDD order, per commit: the hook/RBS Escape tests were watched fail
    against the unmodified hook (the two positive ones failed, "expected
    `input type=checkbox` to be `div class=rbs-tree`"; the
    content-keeps-it ones passed pre-change, which is what makes them
    the guard). The selection-model cases failed on
    `extendToCursor`/`extendPlotSignalSelection` not existing, the two
    hook dom cases on the cursor not moving ("expected 'msg' to be
    'frame'"), the keybindings cases on the suppression tables, and the
    plot dom case on the range not growing. The two consumer edits that
    came out of a real failure (below) were each proved by removing the
    fix again and watching the guard go red.
  - Docs in the same commits: ADR 0044 (key table, both interaction
    paragraphs, the suppression list, and the rejected-alternative entry
    that had ruled keyboard multiselect out wholesale),
    `docs/CONTEXT.md`'s **Selection** entry, and the README's DBC-tree
    and plot-signal-row paragraphs.

- 2026-08-09 — Phase 59.G landed (`task59g-dirty-version`, off
  `task59f-gridview-keys`). Two commits:
  - `54d91d5` `fix(ci): release bundles stamp a clean version, not
    -dirty` — the workflow fix plus the README paragraph it
    invalidates.
  - `bf23696` `docs(readme): document Ctrl/Cmd+F and the plot panel's
    PgUp/PgDn scope` — two doc gaps found during the exit-criteria walk
    (below), both from earlier phases of this task. Docs only.

  ### Item 8 — the written report for the owner

  **The first question, settled: it is specific to how CI writes the
  version, not every build.** The stamp is
  `VERGEN_GIT_DESCRIBE`, emitted by `apps/gui/src-tauri/build.rs` from
  `git describe --tags --dirty` (vergen 8, `gitcl` — it shells out to
  `git`), read back by `build_version()` in `lib.rs`. `--dirty` appends
  the marker when the *tracked* content of the working tree differs from
  `HEAD`; untracked files never count. So an ordinary build stamps
  `-dirty` only when the tree genuinely is dirty — which for a dev
  machine mid-edit is correct and is what the marker is for. What was
  wrong is that a *release* runner starts from a pristine checkout and
  then makes itself dirty before the stamp is taken.

  **Observations.** Fresh `git clone` of this repository into a scratch
  directory (Windows, `core.autocrlf=true`), checked out at the phase
  branch:

  | step | `git status --porcelain` | `git describe --tags --dirty` |
  | --- | --- | --- |
  | pristine clone | *(empty)* | `v0.8.1-142-g2e903fc` |
  | `git tag v9.9.9` (workflow's "Tag the commit") | *(empty)* | `v9.9.9` |
  | the workflow's "Set bundle version" `node -e`, verbatim | `M apps/gui/src-tauri/tauri.conf.json` (unstaged) | **`v9.9.9-dirty`** |
  | `pnpm --dir apps/gui install --frozen-lockfile` | *(unchanged)* | *(unchanged)* |

  **Cause, confirmed by the third row.** `.github/workflows/release.yml`
  injects the release version into `apps/gui/src-tauri/tauri.conf.json`
  — a **tracked** file, committed as `0.0.0` on purpose — and the tag
  was created *before* that edit. By the time `tauri-action` ran cargo,
  and cargo ran `build.rs`, and `build.rs` ran `git describe`, the tree
  carried exactly one uncommitted modification. Every bundle the release
  workflow has ever published therefore reported `vX.Y.Z-dirty`. Nothing
  else in the recipe contributes: `pnpm install --frozen-lockfile`
  leaves the tree untouched (measured, row four), and the sidecar freeze
  writes only gitignored paths — `sidecar-dist/` (including its
  `_build/` PyInstaller workpath) and the generated `licenses.json` —
  which `--dirty` ignores anyway because they are untracked.

  **The local suspect was investigated and refuted.** The root
  `package-lock.json` does not churn on this machine: its blob is 85
  bytes with zero CR, the working copy is 91 bytes with six CR, and
  `core.autocrlf=true` reconciles the two — `git status --porcelain` is
  empty both in the main tree and in the pristine clone. No tracked file
  in the tree shows line-ending churn under the checked-out config, so
  no `.gitattributes` was added; adding one would have been a change
  with no observation behind it.

  **Fix (`54d91d5`).** Commit the version bump to the runner's throwaway
  checkout, *then* tag. `describe` then resolves to exactly `vX.Y.Z`
  over a clean tree. The commit is never pushed — `tauri-action`
  creates the real tag through the GitHub API — so the committed version
  in the repository still stays `0.0.0`, and because the file edit still
  happens the bundle/installer version and asset names are unchanged.
  The commit is path-scoped to `tauri.conf.json` rather than `-a`, so it
  cannot silently sweep up (and thereby hide) some other file a future
  step dirties. A new **Assert the version stamp is clean** step runs
  immediately before the bundle build and fails the release, loudly,
  if `git describe --tags --dirty` is not exactly the release tag. That
  is the last point where the check is possible: the sidecar freeze and
  `pnpm build` run *inside* `tauri-action`, as `beforeBuildCommand`.
  **The marker itself is untouched** — a genuinely modified tree still
  stamps `-dirty`.

  **Verification.**
  - *CI recipe, locally.* The workflow's `run:` bodies were extracted
    from the YAML by a parser (so the thing under test is the file, not
    a paraphrase of it) and executed against the pristine clone with the
    version substituted. Result: `vergen will stamp: v9.9.9`, `git
    status --porcelain` empty, `tauri.conf.json` version `9.9.9`.
    Negative control at the same point — append a newline to
    `README.md` — makes the guard print `v9.9.9-dirty` and exit 1.
  - *This machine's build.* From the committed-clean tree,
    `cargo build -p cannet-gui` emits
    `cargo:rustc-env=VERGEN_GIT_DESCRIBE=v0.8.1-143-g54d91d5` and the
    string in `target/debug/cannet-gui.exe` is `v0.8.1-143-g54d91d5` —
    no marker. Deliberately dirtying `README.md` and rebuilding gives
    `v0.8.1-143-g54d91d5-dirty` in the binary; restoring the file and
    rebuilding gives the clean string back.
  - *Real CI:* **pending the next push.** This phase must not push, so
    the release workflow has not run against the fix. The new assert
    step is what will confirm it on the first release after the chain
    lands — and will fail the run rather than ship a `-dirty` bundle if
    something else has since started dirtying the tree.

  **Not the same mechanism, don't confuse them:** the ADR-0031 perf
  harness also writes `-dirty` into its snapshot filenames
  (`measurement_filename` in `cannet-perf-measurement`), but it derives
  that from `git status --porcelain`, so *untracked* files mark it dirty
  too. It is unrelated to the binary's version string and was left
  alone.

  Verification for the phase as a whole: `cargo test -p cannet-gui` 529
  passed, 0 failed, 4 ignored; `cargo clippy -p cannet-gui --all-targets`
  clean; `pnpm --dir apps/gui test` 139 files, 1721 tests passed;
  `pnpm --dir apps/gui build` clean. ADR-0031 perf gate deliberately not
  run — the orchestrator runs the final gate.

## Blockers / side effects

- **59.G — the CI half of item 8 is verified against the recipe, not
  against a real run.** The phase is under a no-push instruction, so
  `release.yml` has not executed on a GitHub runner since the fix. What
  *was* executed is the workflow's own `run:` bodies, parsed out of the
  YAML and run against a pristine clone — which proves the recipe, not
  the runner. Two things only a real run can settle: whether
  `tauri-action` minds that `HEAD` is a local commit that does not exist
  on the remote (it creates the tag through the API against the pushed
  sha, so it should not), and whether either runner image dirties a
  tracked file in a way this machine does not (Windows line-ending
  handling being the obvious candidate). The new **Assert the version
  stamp is clean** step is exactly the instrument for both: the first
  real release either passes it or names the file that dirtied the tree.
- **59.G — the release runner now makes a commit in its own checkout.**
  It is local to the ephemeral workspace, path-scoped to
  `apps/gui/src-tauri/tauri.conf.json`, authored as `cannet release
  <release@users.noreply.github.com>`, and never pushed — but it does
  mean `HEAD` during a release build is not a commit that exists
  anywhere else, and `git describe` reports the tag rather than a
  commit anyone can fetch. That is the intended reading (the released
  binary should say `v0.1.0`, not `v0.1.0-1-gdeadbee`), and the
  repository's committed version still stays `0.0.0`. Recorded because
  it changes what a release runner's git state means, which is the sort
  of thing a future reader of the workflow will want stated.
- **59.G — the repository carries a root `package-lock.json` with no
  `package.json` beside it.** 85 bytes, `"packages": {}`, tracked, in a
  pnpm workspace whose real lockfile is `apps/gui/pnpm-lock.yaml`. It
  was the named local suspect for item 8 and is **not** the cause — it
  does not churn under the checked-out config (blob LF, worktree CRLF,
  `core.autocrlf=true` reconciling them; `git status --porcelain` empty
  in both the main tree and a fresh clone). Left in place rather than
  deleted: removing a tracked file nothing in this phase's evidence
  implicates would be a drive-by. Flagging it because it is still a
  latent trap — anything that runs `npm` at the repository root would
  rewrite it, and that *would* dirty the tree at stamp time. The assert
  step added in `54d91d5` would catch it in CI; a local build would
  simply stamp `-dirty`, correctly.
- **59.F — the shared Escape needed two row editors to declare that
  they consume it.** Both revert on Escape *and* commit on blur, so the
  grid taking focus back blurred them into committing the very draft
  they were abandoning: `SignalsPanel`'s section-name field (caught by
  its existing "abandons a rename on Escape" test, which went red the
  moment the hook changed) and `TraceView`'s event-label field (no test
  existed; one was added to `EventsPanel.dom.test.tsx` and proved by
  removing the fix again). Each is a one-line `e.preventDefault()`,
  which is exactly the declaration the shared rule reads. **This is the
  standing rule for the layer now**: a control inside a gridview row
  that does anything of its own on Escape has to consume the press, or
  the grid will also take focus off it. `ValidatedInput` needs nothing —
  it blurs itself on Escape, so the container taking focus is the
  completion of what it already did, not a fight with it.
- **59.F — Shift+Up/Down onto an unselectable row moves the cursor
  without growing the range.** The alternative reading of "the
  destination item joins the selection" is to *skip* unselectable rows
  and land on the next selectable one, which is what a flat list would
  do. It was rejected on cost: the skip has to be a walk of the row
  space, and in a host-paged view (`count` is the whole capture) an
  unbounded walk is exactly the thing the paged-model rule forbids. The
  chosen rule is bounded and keeps Shift+arrow landing where the plain
  arrow lands; the range simply grows one press later, because the next
  press ranges from the same anchor straight across the structure row.
  Only trees with unselectable structure rows (DBC buses/ECUs, RBS
  buses/ECUs) can see the difference.
- **59.F — ADR 0044 had ruled keyboard multiselect out entirely, and
  was amended rather than contradicted.** Its rejected-alternatives
  entry ("Keyboard multiselect (Shift/Ctrl+arrows, Ctrl+Space) … out by
  user ruling") is now narrowed to Ctrl+arrows / Ctrl+Space, with the
  2026-08-08 reversal and its reason recorded in place. Flagging it
  because it is a reversal of a written user ruling, not a gap being
  filled.
- **59.F — the plot's Shift+Up/Down acts on the area that holds the
  selection, wherever the pointer is.** The press is handled on the
  plot panel root (the signal rows take no focus of their own, the same
  fact 59.D's PgDn/PgUp fix turned on), so the gesture is panel-scoped:
  with a selection in area 2 and the mouse over area 1, Shift+↓ still
  extends area 2's. That follows the existing rule that a selection
  never spans areas and belongs to whichever area was last clicked in;
  there is no second cursor to be somewhere else. Text fields in the
  panel are exempt — Shift+arrow selects text there.
- **59.E — a bare `#[tauri::command]` fn added directly to `lib.rs` hit
  a reproducible rustc/tauri macro collision.** `cargo check -p
  cannet-gui` refused with `E0255: the name
  __cmd__<fn> is defined multiple times` — both "definitions" pointing
  at the exact same `#[tauri::command]` line, i.e. the macro colliding
  with itself. Bisected before concluding it was structural: renaming
  the function changed nothing; dropping the paired
  `#[allow(clippy::needless_pass_by_value)]` changed nothing; a `cargo
  clean -p cannet-gui` changed nothing; the failure reproduced with
  `--lib` alone (no bin target involved). Moving the identical function
  body into `project_dir.rs` (with `use tauri::Manager;` added) compiled
  clean on the first try. Every other project-directory command already
  lives in its owning module and is registered module-qualified in
  `generate_handler!`
  (`project::open_project`, `rbs::rbs_load`, …); the handful of bare
  names in that list look like a small legacy set nothing has added to
  in a while, which fits a latent bug nobody had triggered. Not
  chased further since the module-qualified home is also the better
  structural fit and the fix cost nothing; if another bare `lib.rs`
  command hits the same `E0255` later, this entry is the pointer to
  what already worked around it once.
- **59.E — autosave's silent save can still open a native file picker
  for a never-saved RBS.** The setting is scoped to the *project* (an
  explicit-dir project always has a path — that is what makes it
  explicit-dir), so the project half of the silent save never prompts.
  But the silent save reuses `handleSaveAll`, which also saves every
  dirty `.cannet_rbs`, and an RBS that has never been saved has no path
  to write to — `handleSaveAll`'s existing branch for that case opens
  a save dialog to ask for one, exactly as a manual "Save & close"
  already does. Autosave inherits that dialog rather than suppressing
  it: skipping the RBS save instead would silently drop the user's
  simulation config, and picking a path for them would be inventing
  data they didn't provide. The one thing that changes under autosave
  is that the unsaved-changes *prompt itself* never shows — a
  never-saved RBS's own save-path dialog is a different, narrower ask
  that was already part of "Save" before this phase. Not a defect
  against the task's wording ("the session has a dirty, explicit-dir
  project open"), which is about the project, but worth recording since
  "saves silently" reads as stronger than what happens in this one
  corner case.
- **59.D — two of the three reported solo bugs do not reproduce, so two
  of the three regression tests pass pre-fix.** The exit criterion asks
  for three tests that fail before the fix and pass after; only item 4.3
  could deliver that. Items 4.1 (pattern-derived series never match) and
  4.2 (a cleared pattern doesn't repaint) were each attacked with the
  groomed diagnosis first, then with every alternative this phase could
  construct, and the panel does the right thing in all of them — see the
  status entry for the experiments and their data. The criterion is
  amended to say so rather than left describing an outcome the evidence
  won't support; the tests are kept because a passing characterisation
  test is still the guard that keeps the behaviour where it is.
- **59.D — what could still be true for items 4.1 and 4.2.** Both
  reports came from a built binary against the owner's own project, and
  three things about that setup this phase cannot stand up are the
  remaining candidates, in order of how well they fit the words:
  1. **The solo subject is the signal's bare name, and the pattern
     editor's subject two controls away is the whole ADR 0038 path**
     (`bus/ecu/message/signal`). A path-shaped pattern — the obvious
     thing to reach for, and to paste, on an area whose series *are*
     defined by one — matches nothing in the solo box. That reads
     exactly as "pattern-derived signals never match the solo filter"
     without a single line of the mask being wrong. If the owner
     confirms it, the fix is a design call (widen solo's subject, or
     say so in the control's title), not a defect fix.
  2. **A real canvas.** The repaint report ends "until a zoom forces a
     repaint", and everything in the pixel path — uPlot's own redraw on
     `setSeries`/`setSize`, the ResizeObserver rebuild probe, the
     zero-size collapse an all-masked area goes through — is stubbed in
     jsdom. A collapsed-by-solo area's canvas is 0-height in the browser
     and 600×400 under the test's size stub, so that path in particular
     is unreachable here.
  3. **Scale.** The fixtures are two to four series; the workflow the
     feature exists for is dozens, where the self-paced resample loop
     and the pacing back-off are actually loaded.
  A reproduction from the owner (project + the exact keystrokes) would
  settle all three cheaply; without one, guessing a fix would mean
  editing the hot repaint path with no failing test to hold it.
- **59.D — the plot panel root now takes focus.** `.plot-panel` is
  `tabIndex={-1}` and a mousedown on a non-focusable part of the panel
  moves focus onto it. That is the same blur an ordinary click on
  non-focusable content already caused (focus would have gone to
  `document.body`), so nothing that had focus keeps it any less — but it
  does mean the panel, not the body, is what `document.activeElement`
  reports after a click on the canvas, and dockview sees a `focusin`
  inside the panel where it previously saw none.
- **59.B — "a project being open" is `projectPath !== null`.** An
  unsaved project (File → New, never saved) is therefore treated as a
  scratch session and its layout is not persisted. That is the faithful
  reading: an unsaved project has no project file to carry a layout, and
  the only state file it could write to is the auto-located directory's
  — which is precisely the scratch storage this phase stops writing. Not
  a regression to hide, but if the owner meant "any project, saved or
  not", it is a one-line change at the gate.
- **59.B — a project's layout snapshot now updates on the first layout
  change after boot, not at boot.** The boot path calls `applyProject`
  (which `fromJSON`s, firing `onDidLayoutChange`) *before*
  `rememberProject` sets `projectPath`, so that first echo no longer
  writes. Nothing is lost — the value it would have written is the one
  just read — and the snapshot is current again as soon as anything
  moves.
- **59.B — stale scratch layouts on disk are left where they are.** An
  auto-located `.cannet/state.json` written by an older build still
  carries a `layout` key; it is simply never read now. No migration and
  no cleanup pass, per the repo's no-legacy-read-paths habit.

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
- The three solo bugs have regression tests. The one that reproduced
  (PgDn / PgUp stepping) fails pre-fix and passes post-fix; the other
  two pass against the unmodified panel, which is the phase's finding
  about them — see the 59.D status entry and blocker.
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

## Exit criteria walk

2026-08-09, at the end of phase 59.G, over the branch chain
`task59a-theme-menu` → … → `task59g-dirty-version` (HEAD `bf23696`).
One line per criterion above, in order. Suite figures cited below are
from re-runs on this branch, not from the phase logs:
`cargo test -p cannet-gui` 529 passed / 0 failed / 4 ignored;
`cargo clippy -p cannet-gui --all-targets` clean;
`pnpm --dir apps/gui test` 139 files / 1721 tests passed;
`pnpm --dir apps/gui build` clean. The ADR-0031 perf gate is the
orchestrator's to run, not the implementing phases' — its verdict is
the closing entry below the nine criteria.

1. **Theme combobox dark/light/lighthk; `normal_mode` gone; theme +
   palette tests green — MET.** 59.A, commits `10579b2` (host) and
   `a5121a4` (frontend). Re-checked in the tree rather than taken from
   the log: `settings.rs:519` is
   `pub const THEMES: &[&str] = &["dark", "light", "lighthk"];`, and a
   repo-wide grep for `normal_mode`, `resolveTheme` and `ThemeSetting`
   across `apps/` and `crates/` returns nothing. `theme.test.ts`,
   `palette.test.ts`, `themeSync.dom.test.ts` green in the 1721.
   README documented in `663f40b`.
2. **No-project session restores window size/position only, dom-tested
   both directions — MET.** 59.B, commit `ad9442c`. Four cases in
   `App.bootReopen.dom.test.tsx`; the two scratch-direction ones were
   watched fail pre-fix, the two project-direction ones are the
   "still works" guard. `tauri_plugin_window_state` untouched, which is
   what leaves geometry restoring. Scope note recorded as a blocker:
   "a project being open" is `projectPath !== null`, so a never-saved
   project counts as scratch.
3. **Ctrl+F focuses the plot and RBS find boxes, palette-listed, no
   binding conflicts; DBC/Settings covered or deferral recorded — MET.**
   59.C, commits `2a5cbfc` / `bd443af` / `3522aeb` / `594a96a`.
   `commands.ts:94` defines `FINDABLE_PANEL_KINDS` and gates `panel.find`
   on it, which is also what governs palette listing; the import-time
   `findBindingConflicts` self-check stayed green, i.e. `Mod+F`
   collided with nothing. DBC **covered** (`594a96a`) rather than
   deferred. Settings **deferred, with the reason recorded** in the 59.C
   entry: `SettingsPanel.tsx` has no find box for the command to focus,
   so binding it there would bind a key to nothing. Documented in the
   README as of `bf23696` (see criterion 9).
4. **The three solo bugs have regression tests; one fails pre-fix,
   the other two pass against the unmodified panel — MET as AMENDED.**
   The criterion in this file was already rewritten during 59.D to
   describe the outcome the evidence supports, and it is honest:
   item 4.3 (PgUp/PgDn scope) reproduced and is fixed (`5e7bb8e`, test
   watched red first: "expected body to be div.plot-panel"); items 4.1
   and 4.2 did **not** reproduce, their groomed diagnoses were each
   falsified by an experiment, and the experiments stayed as
   characterisation tests (`a2b03e1`, `d48015e`). Two blockers record
   what could still be true for 4.1/4.2 and what a reproduction from the
   owner would settle. **This is the one amended criterion in the
   task**; it is not "met" in the sense originally groomed, and the
   underlying reports are not closed.
5. **Autosave-on-exit saves an explicit-dir project silently, prompts
   otherwise, overridable per project — MET.** 59.E, commits `15db05c`
   / `a367682` / `1a8290a`. `settings.rs:73` registers
   `("autosave_on_exit", Scope::UserOverridable)` — the per-project
   override is that scope, not a new storage layer. Three dom cases in
   `App.closeConfirm.dom.test.tsx` at the close-flow seam, the
   silent-save one watched red first. One corner recorded as a blocker:
   a never-saved RBS can still raise its own save-path dialog.
6. **Escape in gridview row content returns focus without stealing
   Escape from content that consumes it — MET.** 59.F, commit
   `82bba5f`. Dom-tested in the shared `useGridview` (four cases plus a
   global-command case) and in RBS. Two row editors had to declare their
   Escape consumption — recorded as a blocker, and now the standing rule
   for the layer. ADR 0044 updated in the same commit.
7. **Shift+Up/Down extends the selection directionally from the anchor
   in every gridview and the plot signal rows — MET.** 59.F, commits
   `1517946` (shared: `extendToCursor` in `gridviewSelection.ts:121`,
   seven pure cases + two hook dom cases) and `7c53a6b` (plot consumer:
   `extendPlotSignalSelection`, six pure + three dom cases). One
   deliberate reading recorded as a blocker: a press onto an
   unselectable structure row moves the cursor without growing the
   range, because the alternative needs an unbounded walk of a
   host-paged row space. ADR 0044's rejected-alternatives entry was
   amended rather than contradicted — flagged as a reversal of a written
   user ruling.
8. **A build from a clean checkout stamps a version without `-dirty`,
   cause identified and fixed, genuine dirt still stamped; verified on
   this machine and in CI, with a written report — MET on this machine;
   the CI half is verified against the recipe but NOT YET against a real
   run.** 59.G, commit `54d91d5`; the written report is the 59.G status
   entry above. Cause: the release workflow edited the tracked
   `tauri.conf.json` after tagging and before the stamp. This machine's
   build: `v0.8.1-143-g54d91d5` clean, `…-dirty` when a tracked file is
   modified, clean again when restored. CI: the workflow's own `run:`
   bodies, extracted from the YAML and executed against a pristine
   clone, stamp `v9.9.9` with an empty `git status`, and the new assert
   step fails as intended when the tree is dirtied. **A real CI run is
   pending the next push** — this phase is under a no-push instruction,
   so nothing has exercised `release.yml` on a runner. The assert step
   exists so that first real run reports the answer itself.
9. **Docs updated where behavior changed — MET, with two gaps closed
   during this walk.** README covered themes (`663f40b`), the scratch
   layout (`ad9442c`), autosave (`1a8290a`), gridview/plot selection
   (`7c53a6b`) and the release/version story (`54d91d5`); ADR 0044 and
   `docs/CONTEXT.md` were updated by 59.F. The parenthetical's second
   clause is **vacuous**: ADR 0018 does not enumerate default bindings
   (it names only the two palette strokes in prose), so there was no
   list to extend for `Mod+F`. Two real gaps surfaced and were fixed in
   `bf23696`: the README never named the `Ctrl/⌘+F` binding in any of
   the three panels that now answer it, and it still said the plot's
   PgUp/PgDn stepping needs focus "right after typing a pattern", which
   59.D's fix made untrue.

**ADR-0031 perf gate — MET.** Run by the orchestrator, not by the
implementing phases (every phase brief said so, and each phase's status
entry records the deferral). Final gate at `95b3ee2`, **two runs, both
`check passed (31 metrics gated)`** — 31/31 each — with the reports
committed unmodified as
`docs/performance-measurements/frontend/2026-08-09-95b3ee2-task59-final-run1.json`
and `...-run2.json`. Sanity clean on both: `ids_measured` 173, and in
the committed reports `fps.rx` / `fps.tx` 1611.5 / 1612.3 (run 1) and
1609.1 / 1608.8 (run 2) with retention 0.9998–1.0003 — flat across
halves, so nothing degrades over the minute. 59.D was also gated
mid-chain (two runs, 31/31), which is the run that matters most in this
task: it is the only phase that touched the plot repaint path.
