# Task 16 — Command / Hotkey Framework

A generalised command + keybinding primitive that future tasks and
panels register on. Lifted forward from the original command-palette
work; what's left of that (specialised commands like
`goto.traceRow`, `goto.timeInTrace`, `set-visible-time-range`) stays
in **Task 19**. Reuses the fuzzy-search library Task 12 picked for
the DBC panel.

What lands:

- **Command registry.** Each command:
  `{id, label, category?, context?, run()}`. `context` is a
  predicate over a small typed context object
  (`focusedPanelKind`, `hasProjectOpen`, …); a missing `context`
  means always-available. Two commands bound to the same key in
  overlapping contexts is a build-time assertion.
- **Binding map.** `keyChord → commandId`. Single keys (`f`),
  modifiers (`Cmd+Shift+P`), simple chord sequences (`g r`).
  Bindings declared in code only; user customisation is out of
  scope here.
- **Dispatcher.** Key event → resolve binding → check context
  predicate → run, or silently no-op. Frontend-only React
  context; commands wrap existing Tauri commands where they
  need host work, no new IPC.
- **Palette.** `Cmd/Ctrl+Shift+P` opens a modal; types-to-filter
  through Task 12's fuzzy matcher; arrow keys + enter; Esc closes.
- **Go-to-view.** `Cmd/Ctrl+P` opens a sibling palette listing
  every open dockview panel by its display name; selecting one
  focuses that panel. Same fuzzy matcher.
- **Element display names (prerequisite for go-to-view).**
  Every `ProjectElement` kind carries a model-owned `name:
  string`. Default on creation is `${Kind} ${nextIndex}`
  (matching today's dockview tab behaviour, but model-owned and
  stable across reloads). A shared resolver `elementLabel(el):
  string` is used by every view: dockview title bar, project
  graph node, project panel inventory list, and the
  `Cmd/Ctrl+P` palette. Inline-rename in the project panel
  (already in place for buses) extends to every element kind.
  `name` is additive inside the host-opaque `elements` records,
  so `PROJECT_SCHEMA_VERSION` does **not** bump (ADR 0011 rejects
  rather than migrates; a bump would retire every existing file);
  elements loaded without a `name` get the default on open.
- **Lifted commands** — every existing toolbar action also
  becomes a palette command (same behaviour, second access
  path):
  - `project.open`, `project.save`, `project.saveAs`,
    `project.close`
  - `blf.open`, `dbc.add`
  - `connection.connect`, `connection.disconnect`
  - `panel.add.trace`, `panel.add.plot`, `panel.add.transmit`,
    `panel.show.systemMessages`, `panel.show.projectGraph`,
    `panel.show.dbc`
  - `panel.rename`
  - `palette.show` (bound `Cmd/Ctrl+Shift+P`),
    `goto.view` (bound `Cmd/Ctrl+P`)
- **Plot hotkeys** — `f` registered as `plot.fitXAxis`
  (context-required `panel.kind === "plot"`, calls the existing
  `fitData` handler); `l` registered as `plot.followLive.enable`
  (same context, sets `followLive=true` — enable-only; the user
  drops out by panning the x axis).

ADRs:

- [`docs/adr/0018-command-keybinding-framework.md`](../../docs/adr/0018-command-keybinding-framework.md)
  — frontend-only React-context registry, code-declared bindings
  (no user persistence), typed-context predicates, build-time
  conflict assertion, two palettes sharing one matcher.
- [`docs/adr/0019-project-element-display-names.md`](../../docs/adr/0019-project-element-display-names.md)
  — every `ProjectElement` carries a model-owned `name`; views
  resolve through one shared `elementLabel(el)` resolver; the
  project panel is the canonical edit surface.

Exit criteria:

- The palette opens on `Cmd/Ctrl+Shift+P`, lists all registered
  commands, filters live as the user types, and runs the
  selected command on enter.
- `Cmd/Ctrl+P` opens go-to-view; selecting a panel focuses it.
- Every element kind carries a model-owned `name`; the dockview
  tab, project graph, project panel, and go-to-view show the
  same label; inline-rename works from the project panel.
- With a plot panel focused, `f` re-runs fit-data and `l` enters
  follow-live; both no-op when a non-plot panel is focused.
  Backlog items removed: the `f` / `l` bullets under "Minimum
  Usability Tasks".
- Both ADRs are checked in.
- **ADR cleanup:** scrub task-number references out of
  [ADR 0018](../../docs/adr/0018-command-keybinding-framework.md) and
  [ADR 0019](../../docs/adr/0019-project-element-display-names.md) —
  ADRs describe what *is*; task tracking lives here, not in the ADR.
- Backlog item removed: "hotkey framework + new hotkeys".
