# Task 150 — The Project Caches List Names Its Projects

Opened by owner instruction 2026-09-21 from three owner observations
in the settings view's **Storage › Project caches** list. **Executes
now, on the current stack.** Grooming in progress.

## Why

From the owner, 2026-09-21:

1. The list shows only the project *directory* path, which for an
   auto-located project is a cache-space hash directory and says
   nothing about which project it is.
2. The row's `Delete` button reads badly in the dark theme; every
   other removal in the app is a trash icon, and this one should be
   styled the same.
3. A project opened from its own folder showed the `active` badge on
   a row whose path looked auto-located.
4. A Save As over that same folder (which wrote the `.cannet/` there)
   produced no change in the settings view, giving no clear feedback
   about the state of the project.
5. Reopening the settings view refreshed it once; after switching to
   other plots and rebuilding some caches it was stale again. The
   settings view is not updating when its source data changes or when
   it is refocused.
6. The settings view does not retain its scroll position when the
   user switches away and back.

## Findings (2026-09-21 survey)

- **Observation 3 is ADR 0042 §2 working as written.** The folder
  the project was opened from holds the `.cannet_prj` and its DBCs
  but **no `.cannet/`**, and a `.cannet_prj` without a `.cannet/`
  beside it is a loose project file: it gets an auto-located
  directory under cannet's cache space, keyed by the project file's
  path. The registry (`projects.json`) records exactly that: root
  under `…/dev.cannet.app/projects/<hash>`, `project_file` pointing
  at the user's folder, `auto_located: true`. A sibling folder that
  does carry a `.cannet/` is recorded as a user-made project
  directory. So the badge is right; what is wrong is that the row
  gives the user no way to see which project the hash directory
  belongs to — which is observation 1.
- **The registry already carries what the row needs.**
  `ProjectEntry.project_file` (the `.cannet_prj` path) is served to
  the frontend in `ProjectCacheRow.project_file` and never rendered.
  The project file has no `name` field (its keys are
  `schema_version`, `project_id`, `layout`, `elements`, `buses`, …);
  the app's notion of a project's name is the file stem, computed by
  `projectName` in `windowTitle.ts` and used for the window title
  and export templates' `{project}`.
- **Rows.** `ProjectCachesList.tsx` renders badge · root path ·
  size · [`Save as…`] · `Clear data cache` · `Delete`. `Delete` is a
  text button with `className="danger"`, styled by
  `.project-caches button.danger` (danger border and muted danger
  text over the default button surface). `Clear all data caches` in
  the header wears the same class.
- **The app's removal idiom.** Two controls: `TwoStageRemoveButton`
  (trash icon, first click arms red, second acts, self-disarms after
  3 s — "use it wherever a removal has no way back") and `IconButton`
  with `icon-btn-trash` (single click, for registry-undoable
  removes). Deleting a cache directory is not undoable, so the
  two-stage control is the matching one.
- **Observation 4: the host re-rooted, the list did not reload.** After
  the Save As the folder holds a `.cannet/` (gitignore, settings and
  state files, the cache link) and the registry carries a new entry
  for it, `auto_located: false`, beside the old auto-located entry
  that Save As deliberately leaves behind (its derived caches may
  still be mapped; the list is how those bytes are reclaimed). The
  list reloads only when `projectPath` changes
  (`ProjectCachesList.tsx`, the effect on `[refresh, projectPath]`),
  and a Save As onto the same file path leaves that string unchanged,
  so nothing refreshed: the row still read `active` on the hash
  directory while the host was already rooted in the user's folder.
  The row's own `Save as…` button does not await the save either. The
  host's `reroot_session` emits `notes-changed` and nothing about the
  root itself.
- **Observations 5 and 6: the panel neither re-reads nor keeps its
  place across a switch.** `SettingsPanel.tsx` loads the schema, the
  overrides and the settings file once on mount and subscribes to
  settings changes only; `ProjectCachesList` reloads only on
  `projectPath`. Neither listens to the dockview panel api
  (`onDidVisibilityChange` / `onDidActiveChange`, which the database
  and system-messages panels already use), so a return to the tab
  finds whatever was there. Cache sizes are asked for, never polled
  (ADR 0002 DS-8: the directory walk is expensive), so "when the
  source data changes" has to mean a trigger: the panel becoming
  visible again, and the host announcing a re-root. Scroll: the panel
  is a singleton opened through `showSingletonPanel` with dockview's
  default renderer, which (per dockview's documentation) detaches a
  hidden panel's element from the DOM; the `.settings-list` container
  (`overflow-y: auto`) comes back at the top. The phase verifies that
  reading before choosing between `renderer: "always"` for the
  singleton and restoring the container's `scrollTop` on visibility.
- **Delete is refused for the active row** (`canDelete`), with the
  refusal in the tooltip; the two-stage control takes `disabled` the
  same way any button does.

## Rulings

- **Show the project's name** (owner, 2026-09-21). Overseer's reading
  into mechanism: the row leads with the project name (the file stem,
  via the existing `projectName`) where the entry has a project file,
  and the project directory path moves to a secondary line; the
  auto-located badge's tooltip says why the directory is in cache
  space ("the project file has no `.cannet/` beside it"). An entry
  with no project file (the unsaved session) reads "unsaved".
- **Delete becomes the trash icon** (owner, 2026-09-21): the shared
  `TwoStageRemoveButton`, since the removal is not undoable.

- **Just the project name** (owner, 2026-09-21): no further affordance
  on an auto-located row. The badge tooltip states the reason and
  `Save as…` stays the promotion path.
- **The list follows the session's root** (overseer, from observation
  4): the host announces a re-root (a `project-dir-changed` event
  from `reroot_session`, beside the `notes-changed` it already emits)
  and the list reloads on it, so a Save As, an open, or a Save As onto
  the same path all show the new row, the new `active` badge, and the
  left-behind auto-located row with its reclaimable bytes.
- **The settings view re-reads on return** (owner, 2026-09-21: "the
  settings view is not updating when its source data changes/when
  it's refocused"). Overseer's reading: on the panel becoming visible
  the settings view re-hydrates the settings file, the overrides and
  the project caches list (sizes re-measured then, not on a timer).
- **The settings view keeps its scroll position** across a switch
  away and back (owner, 2026-09-21).
- **Owner review, 2026-09-22.** The name and button changes are good.
  Follow-ups ruled: (a) the auto-located tooltip goes on **every**
  auto-located row, the active one included ("fine"); (b) the row
  also wears a chip for the project directory, "to give more positive
  feedback that it's picked it up" — overseer's reading: a location
  chip beside the state badge, `project dir` for a user-made
  directory and `auto-located` for cache space, so after a Save As the
  active row reads `active · project dir`; (c) `Clear all data caches`
  still has the red-on-gray `danger` styling the owner dislikes — it
  loses that class and reads as a normal button, text kept.

## Open questions

(none — the `Clear all data caches` question is ruled above,
2026-09-22: text kept, `danger` dropped)

## Phases

Two phases, two branches. **Phase 1, the settings view's staleness:**
the host's re-root event; the settings view re-reading on visibility
(settings file, overrides, cache list); scroll position kept across a
switch — each with a failing test first (Save As onto the same path,
list unchanged; panel hidden and shown, list not re-asked; scroll
lost). **Phase 2, the rows:** the row layout (name, secondary path
line, badge tooltip), `Delete` as `TwoStageRemoveButton`, the list's
dom test extended, ADR 0042 §5 amended if the row's contents
are described there, `docs/CONTEXT.md` if a term is added.
**Phase 3, owner review follow-ups (2026-09-22):** the tooltip on
every auto-located row, the location chip, `Clear all data caches`
without `danger`; dom tests first.

## Exit criteria

1. A row whose entry has a project file leads with the project name;
   the directory path is present as a secondary line and in the
   tooltip.
2. An auto-located row's badge tooltip states that the project file
   has no `.cannet/` beside it and that `Save as…` moves the project.
3. The unsaved-session row reads "unsaved".
4. `Delete` is the shared two-stage trash control: armed on first
   click, acts on second, disabled on the active row with the
   existing refusal text.
5. After a Save As — including onto the same file path — the list
   shows the new project directory as `active` and the left-behind
   auto-located row as reclaimable, without reopening the settings
   view. A host test covers the event; a dom test covers the reload.
6. The settings view, hidden and shown again, re-reads the settings
   file, the overrides and the project caches list (a cache that grew
   while another panel was active shows its new size on return).
7. The settings view's scroll position survives switching to another
   panel and back.
8. Tests cover 1–7 (dom for the view, host for the event); the
   existing settings and list tests pass.
9. Every auto-located row, the active one included, carries the
   auto-located tooltip; every row carries a location chip
   (`project dir` / `auto-located`) beside its state badge.
10. `Clear all data caches` no longer wears `danger`; dom tests cover
    9 and 10.

## Blockers / side effects

(none yet)

## Status log

- 2026-09-21 — opened; survey and rulings above.
- 2026-09-21 — **phase 1 (the settings view's staleness) landed** on
  `task150-settings-refresh` (`603a29df`, one commit, no squash). The
  host announces every re-root (`project-dir-changed` from
  `reroot_session`, payload = the new project directory +
  `auto_located`); the guard is now `is_reroot`, which is what the host
  tests exercise — this host has no Tauri mock-app pattern, and
  `interfaces.rs` likewise tests the emit *decision* rather than the
  `app.emit` line. The project caches list follows that event and
  re-measures when the view is shown again; the settings view
  re-hydrates the settings file and the overrides on
  `onDidVisibilityChange` (chosen over `onDidActiveChange`: `isVisible`
  is exactly "on screen", and a panel can be visible in another group
  without being active). Scroll: **verified in dockview-core 6.0.7's
  source** that `ContentContainer.renderPanel`'s `onlyWhenVisible`
  branch removes the hidden panel's element from the document, and that
  `renderer: "always"` merely swaps that for `display: none` in the
  overlay container — also no layout box, so not a guaranteed fix, and
  it would keep the hidden view rendering. **Chose save/restore of
  `scrollTop`**, which holds under either mechanism; `doSetActivePanel`
  re-attaches before it fires the change, so a layout effect on the
  visibility bump is early enough. The count of times the view has been
  shown is published through the new `SettingsShownContext`, because the
  caches list is reached only through the custom-setting renderer table.
  Six tests, each red first. ADR 0042 §5 amended. Scoped per-phase
  checks green (1328 host, 3604 frontend); release host built, no perf
  capture (no render or data path touched). Exit criteria 5, 6, 7 met;
  8's test half met. Side effect: `ProjectCachesList.tsx`, its dom test
  and ADR 0042 sat in the worktree with CRLF endings against an LF
  index; normalised back to LF in the commit. Hands-on check owed to the
  owner: scroll holds and a grown cache re-measures on return; a Save As
  onto a loose project's file flips `active` without reopening the view.
- 2026-09-21 — **phase 2 (the rows) landed** on `task150-cache-rows`
  (`b81141d5`, one commit, no squash). A row whose entry has a project
  file leads with the project name (`projectName` from
  `windowTitle.ts` — no second stem function); the directory path moved
  to a secondary line and stays in the row's tooltip. The unsaved
  session's row reads "unsaved". The `auto-located` badge's tooltip says
  the project file has no `.cannet/` beside it and that Save as… moves
  the project; the phase scoped it to the row whose badge reads
  `auto-located`, not to an active row that is itself auto-located
  (that row's Save as… tooltip was judged enough) — queued for the
  owner as a yes/no, since observation 3 was exactly an active,
  auto-located row. Delete is the shared `TwoStageRemoveButton`, which
  gained a `disabled` prop matching `IconButton`'s shape. `Clear all
  data caches` keeps its `danger` styling and text (ruled), so the CSS
  rule stays. ADR 0042 §5 not amended (it describes actions and
  re-rooting, not the row's contents). Four new dom tests, red first;
  two Delete tests updated for arm-then-act. Task-final full local CI:
  frontend test + build (3608), `cargo test --workspace`, workspace
  clippy, `cargo fmt --check`, comment-references grep — green; other
  lanes unreachable by a frontend-only diff. Release host built, no
  perf capture.

## Exit criteria verdicts (2026-09-21)

| # | Verdict |
| --- | --- |
| 1 | met — name leads, path secondary and in the tooltip (phase 2) |
| 2 | met — on the `auto-located` badge; the active-and-auto-located row's scope is a queued yes/no |
| 3 | met — "unsaved" (phase 2) |
| 4 | met — `TwoStageRemoveButton`, disabled on the active row with the existing refusal (phase 2) |
| 5 | met — `project-dir-changed` from `reroot_session`; host + dom tests (phase 1) |
| 6 | met — re-hydrates on `onDidVisibilityChange`; a grown cache re-measures (phase 1) |
| 7 | met — `scrollTop` saved and restored on the visibility bump (phase 1) |
| 8 | met — six + four dom/host tests; existing settings and list tests pass |

Owner hands-on check still owed (no UI automation from agents): scroll
holds and a grown cache re-measures on return; a Save As onto a loose
project's file flips `active` without reopening the view.
- 2026-09-22 — owner review: accepted with follow-ups (rulings above); phase 3 opened.
