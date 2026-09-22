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

## Open questions

1. **Does the row need more than the name?** The behaviour behind
   observation 3 is the ADR's; the row could also state the reason
   in the badge tooltip and leave the existing `Save as…` as the
   promotion path (*recommend*), or grow an "adopt this folder"
   action that writes a `.cannet/` beside the project file — which
   ADR 0042 §2 forbids as a side effect and §6 already provides as
   Save As into that folder.
2. **`Clear all data caches`** also wears `danger`. It is a clear,
   not a removal, so *recommend* it keeps its text and loses nothing;
   only `Delete` changes.

## Phases

One phase, one branch, frontend-only: the row layout (name, secondary
path line, badge tooltip), `Delete` as `TwoStageRemoveButton`, the
list's dom test extended, ADR 0042 §5 amended if the row's contents
are described there, `docs/CONTEXT.md` if a term is added.

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
5. Dom tests cover 1–4; the existing list tests pass.

## Blockers / side effects

(none yet)

## Status log

- 2026-09-21 — opened; survey and rulings above.
