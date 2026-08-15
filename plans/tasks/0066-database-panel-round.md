# Task 66 — Database Panel Round: Import Trace, File-Backed Signals, Picker Cleanup

Owner feedback from first live use of the Task 38 surfaces
(2026-08-12).

## Owner feedback (verbatim intent)

- **One "Import trace" action** instead of separate BLF / MDF
  buttons: a single file-open whose filter list offers both (and
  "all supported"); format routing stays explicit host-side as
  already built.
- **File-backed signals were undiscoverable.** They should be listed
  in the DBC panel — which gets **renamed "Database"**, since it is
  no longer strictly DBC content. The Database view is **the primary
  mechanism for choosing signals to add** to other views; copying
  signals out of other views stays as already supported.
- **Remove the signal picker in the signal view** — same cleanup as
  the picker already removed from the plot panel. Any remaining
  picker of that first-draft style is a cleanup target ("first-draft
  GUI we never developed and isn't great").

## Grooming needed before implementation

- Sweep for every remaining first-draft signal-picker instance
  (signal view confirmed; find any others) and confirm each removal
  leaves an add-signal path via the Database view / copy-drag.
- ~~How file-backed signals render in the Database tree~~ —
  resolved 2026-08-13 (owner): **one top-level branch per source
  MDF file, labeled with the filename** — the MDF fills the same
  structural role a DBC does, so it's tracked the same way in the
  tree (file branch → group → signal rows, name + unit). Drag-out
  carries the provenance-keyed signal reference (the `f`-flagged
  `signalKey`) so existing drop targets work unchanged. **Not a
  project member**: same lifecycle as capture contents (lives and
  dies with the capture; never persisted into the project file),
  unlike DBC references. No sample counts on rows.
- ~~Rename blast radius / naming boundaries~~ — resolved
  2026-08-13 (owner), elevated to **ADR 0052** (format-plural
  Database view): the panel is "Database" everywhere a user sees
  it; every signal-defining format is first-class in it, each
  organized per its own canonical structure (DBC: ECU→message→
  signal; MDF: file→group→signal; a future ARXML per ARXML's
  canon); format-specific operations keep naming their format
  ("Add DBC…", watcher messages). CONTEXT.md term, README, palette
  entries update; code identifiers rename only where cheap.
- Added 2026-08-13 (owner): the command palette keeps a **"DBC
  panel" alias** resolving to the Database panel — muscle memory
  and old docs keep working; the alias surfaces the new name in
  its result label (check how the palette supports aliases/keyword
  matching; follow its pattern).
- ~~Recents unification~~ — resolved 2026-08-13 (owner): unified
  list named **"Recent captures"**, BLF + MDF entries; settings key
  `recent_blfs_limit` kept (no migration) with label/help updated
  to the new name; format routing at open time by extension.
- "Import trace" placement: toolbar + palette naming.

## Exit criteria (groomed 2026-08-13)

- One "Import trace" entry point offering BLF + MDF; both formats
  land through their existing scan/mapping flows; the recents list
  is "Recent captures" and covers both formats (settings key kept).
- The Database panel (renamed everywhere a user sees it) lists
  file-backed signals per ADR 0052: one branch per source MDF file
  (file → group → signal, name + unit), capture lifecycle, beside
  the DBC branches; drag-out to plot/grid works with the
  provenance-keyed reference; format-specific operations keep
  naming their format.
- The SignalsPanel catalog picker is gone (sweep verdict: it was
  the only remaining first-draft picker; the plot's SourcesPicker
  is a different mechanism and stays); add-paths proven by test
  via the Database view and copy/drag.
- ADR 0052 committed; CONTEXT.md and README reflect the rename,
  the format-plural principle, and the file-backed surfacing.

## Status log

### 2026-08-14 — owner ruling: Recent captures are per-project

Recent captures are per-project — owner, 2026-08-14; storage already
per-project, preserved. The `recent_blfs` state field has been
`Scope::Workspace` (the open project's own `.cannet/state.json`, ADR
0042) all along (`apps/gui/src-tauri/src/state.rs`); unifying BLF and
MDF into one list did not move it, and MDF entries join the same
per-project list. Only the `recent_blfs_limit` cap stays user-scope,
unchanged.

### 2026-08-13 — phase 1: Import trace + Recent captures

**Landed** (branch `task66a-import-trace`, off `task65f-docs-sweep`
tip `13213cb`), two commits:

- `e7961c7` **docs(task65)** — carried forward the orchestrator's
  pending exit-criteria walk and close-out gate for task 65, verbatim.
- `b7d5365` **feat(gui)** — one "Import trace…" toolbar button and
  palette command replaces "Open BLF…" / "Open MDF…"; the file dialog
  offers "All supported traces" (`*.blf;*.mf4`), "Vector BLF", and
  "ASAM MDF". The picked (or recalled) path routes to the format's
  existing scan/mapping flow by extension alone
  (`apps/gui/src/importFormat.ts`) — the host still never sniffs the
  file, it just receives an explicit command choice made frontend-side,
  same as the save-side `saveFormat.ts` this mirrors. `scan_mdf_channels`
  only ever accepted `.mf4` (confirmed against `cannet-mdf`'s docs and
  the prior single-format filter), so that's the only MDF extension
  offered.
  - The recents list (`recentBlfs.ts` renamed to `recentCaptures.ts`)
    now records a successful MDF import the same way it always recorded
    BLF (previously a deliberate scope trim); the toolbar/palette label
    it "Recent captures". Storage is unchanged: the per-project
    `recent_blfs` state field and the user-scope `recent_blfs_limit`
    setting are both kept as-is (no migration) — only display names
    changed (`settings_descriptor.rs`'s label, the toolbar dropdown's
    aria-label/title/class names). A recents entry from before the
    merge (a bare `.blf` path) opens with no special-casing, since the
    storage shape never distinguished format.
  - The palette gained keyword matching (`CommandSpec.keywords` /
    `PaletteItem.keywords`, folded into the `fzf` search text but never
    displayed) so typing "Open BLF" or "Open MDF" still finds the
    merged "Import trace…" action. This is the mechanism the
    Database-panel "DBC panel" alias (phase 2) is expected to reuse.
  - Command palette entry: `trace.import`, category "File" (same
    grouping "Open BLF…"/"Open MDF…" held). No `blf.open`/`mdf.open`
    ids remain; neither was bound to a default keychord, so no binding
    cleanup was needed.
- Docs: README (the quick-start paragraph, the Save-Capture/notes
  section, the remote-connect paragraph, the Phase-9 section header)
  and ADR 0037 (an example mentioning the old dropdown name) updated
  to "Import trace…" / "Recent captures". CONTEXT.md does not name the
  import action, so it needed no change.
- Tests: frontend `pnpm --dir apps/gui test` — 153 files, 1986 tests,
  all green. New/changed coverage: `importFormat.test.ts` (6, new —
  extension routing + the filter list shape),
  `App.importTrace.dom.test.tsx` (6, new — dialog-filter routing by
  extension, MDF recents recording, mixed-list rendering + per-entry
  open routing, pre-merge-entry compatibility), one added
  keyword-matching case in `PaletteModal.dom.test.tsx`,
  `recentBlfs.test.ts` renamed to `recentCaptures.test.ts` (+1 case for
  a mixed BLF/MDF list), 3 existing dom tests (`App.blfScanNotice`,
  `App.mdfScanNotice`, `App.sessionReset`) updated for the renamed
  button. `pnpm --dir apps/gui build` clean (`tsc -b && vite build`).
  `cargo test -p cannet-gui` — 609 passed, 0 failed, 6 ignored. `cargo
  clippy -p cannet-gui --all-targets -- -D warnings` clean.

Remaining Task 66 scope (the Database panel rename, file-backed
signals in the tree, the SignalsPanel picker sweep) is unstarted —
this phase covers only the Import-trace/Recent-captures item. ADR
0052 itself already landed ahead of this phase (commit `04a0f5b`);
what remains is the code and doc surfacing it describes.
