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

### 2026-08-14 — phase 3 (final): picker removal + staleness fix

**Landed** (branch `task66c-picker-removal`, off `task66b-database-panel`
tip `edcb191`), two commits:

- `ef0aa6f` **refactor(gui)** — removed `SignalsPanel`'s "add signal"
  catalog `Combobox` (option-building `catalogOptions`, `handlePick`),
  the now-orphaned `FILE_BACKED_LABEL` import, and the `.signals-add`
  CSS rule. **`SignalCatalogProvider` verdict: stays** — `PlotPanel`,
  `TransmitPanel`, `ColorMapPanel`, and `SignalsPanel`'s own
  regex-pattern matching (`SignalPatternEditor`/`SectionPatternPopover`,
  which still read `scopedCatalog`) all consume it; the top-of-file
  comment's consumer list was corrected (dropped the removed picker,
  named the pattern matching that remains). Two new dnd tests
  (`SignalsPanel.dnd.dom.test.tsx`) prove the add-paths survive the
  picker's removal: a DBC signal and a file-backed signal, each dropped
  on the panel with nothing but `parseSignalDragData` → `addKeys` in the
  loop, land in the manual selection and reach `fetch_signal_page`'s
  wire query with the right identity (`fileBacked` threaded correctly).
  The two picker DOM tests in `SignalsPanel.dom.test.tsx` were removed
  with the picker; the now-unused `SIGNALS` catalog fixture and
  `comboboxTestKit` import went with them.
- `17c1bbb` **fix(gui)** — the staleness fix phase 2 flagged:
  `SignalCatalogProvider` now also refetches on `file-signals-changed`
  (added in phase 2 for the Database panel), so the file-backed half of
  the catalog no longer goes stale after a Clear or a scratch-capture
  restore — neither fires `dbc-changed` or `log-finished`. Red-first:
  the new `signalCatalogContext.dom.test.tsx` case failed against the
  two prior triggers alone, then passed once the third `listen()` call
  was added.

**Verification**: `pnpm --dir apps/gui test` — 153 files, 1994 tests,
all green (1993 before: −2 picker tests, +2 add-path proof tests, +1
staleness test). `pnpm --dir apps/gui build` clean. No Rust touched, so
no `cargo test`/`clippy` run.

**Docs**: swept README and `docs/CONTEXT.md` for the removed picker —
neither ever named `SignalsPanel`'s "add signal" combobox specifically
(README's plot-panel paragraph already carries the "no separate
add-signal picker" note from that panel's own earlier removal; the
signal-catalog file-backed paragraph's "the signal catalog and picker"
phrase covers `ColorMapPanel`'s still-live target picker, not this
one), so no doc text needed correcting beyond the `signalCatalogContext`
code comment above.

**Exit criteria**: all four bullets above are met. This closes task 66;
ready for the exit-criteria walk.

### 2026-08-14 — phase 2: the Database panel (rename + file-backed branches)

**Landed** (branch `task66b-database-panel`, off `task66a-import-trace`
tip `a635547`), three commits:

- `43466c6` **feat(gui)** — the rename. The panel is "Database"
  everywhere a user sees it: dockview tab title and go-to-view label
  (`useCommands.tsx`), toolbar button (`App.tsx`), palette command
  (`Show Database panel`), and the search box's accessible label
  ("search database content"). The palette command carries
  `keywords: "DBC panel"` — phase 1's mechanism — so the old name still
  finds it and shows the new label. Format-specific operations are
  untouched ("Add DBC…", the DBC watcher messages). Code identifiers
  moved only where cheap: `DbcPanel.tsx` → `DatabasePanel.tsx` (+ its
  two test files) and the exported component; internal identifiers
  (`DbcRow`, `dbcKey`, `dbcPanelViewport`), the `dbc-*` CSS class names
  and `DBC_PANEL_ID` stay. Comments naming the component or the panel
  were swept with it. Docs: CONTEXT.md gained the **Database view**
  term; README names the new button.
- `dd54989` **feat(gui-host)** — the catalog surface. `FileSignalInfo`
  records the `source_path` it was imported from (`#[serde(default)]`,
  so a pre-existing pyramid manifest restores as series with no named
  source; not part of the series' identity, so a re-import still
  replaces). New command `list_file_backed_content` →
  `Vec<FileBackedContentRecord>` (file → group → `{name, unit}`),
  arranged by `signal_snapshot::file_backed_content`: files by path,
  groups by index, signals by name, unnamed groups labelled by
  `group_label()`. No sample counts.
- `be9a6cc` **feat(gui)** — the panel. One top-level branch per source
  file beside the DBC branches, using the tree's existing machinery
  (same flat row space, virtualizer, gridview cursor/selection, fzf
  filter slot): file and group rows are unselectable branches, signal
  rows draggable leaves. A drag carries the provenance-keyed reference
  (`busId: null`, group index in the message slot, `fileBacked: true`),
  proven in the DOM test through the *drop* side —
  `parseDroppedSignals` + `signalRefKey` equalling
  `signalKey(null, group, false, name, true)`. README documents the
  branches and their lifecycle.

**Verification**: `pnpm --dir apps/gui test` — 153 files, 1993 tests,
all green (1987 before). `pnpm --dir apps/gui build` clean.
`cargo test -p cannet-gui` — 612 passed, 0 failed, 6 ignored (609
before). `cargo clippy -p cannet-gui --all-targets -- -D warnings`
clean. New coverage: 5 DOM cases in `DatabasePanel.dom.test.tsx`
(branch render + filename labelling, name+unit rows without sample
counts, branches vanishing when the set empties, search participation,
drag payload), 1 `dragSignals.test.ts` case, 1 `commands.test.ts` case
(the rename + alias), 2 `signal_snapshot` shaping cases and 1
end-to-end host case over the `sorted_finalized_mixed` MDF fixture.

**Deviations / decisions**:

- The brief expected an existing change signal from the file-backed
  cache. There is none — the cache emits nothing, and `clear_trace_store`
  was silent. Added `file-signals-changed` (payload-less, the
  `dbc-changed` pattern), emitted from the three places the set moves:
  after the MDF import fill, in `clear_trace_store`, and at the end of
  `restore_scratch_capture`. The panel listens to it plus `log-finished`
  (which covers an import of a format carrying no definitions).
- `FileSignalInfo` had no source-file field, so the per-file branch
  ruling required adding one. It rides in the persisted manifest.
- The panel's auto-expand seeding moved behind one gated helper. The
  two catalogs answer independently and the old "nothing is expanded
  yet" gate let whichever landed first leave the other's branches shut;
  the gate is now "the expand state is the user's" (a restored layout,
  or their own toggle).
- `dedupeSignalRefs` keyed on `(bus, messageId, extended, name)`, which
  aliases a file-backed signal with a message whose id equals its group
  index — one of the two vanished from a mixed drag. It now keys on
  provenance too, matching `signalKey`.
- The panel's live-value column still covers DBC-backed rows only; a
  file-backed row renders no value cell. Out of this phase's scope
  (`fetch_signal_page` already serves such keys, so it is a small
  follow-up if wanted).
- The empty state now reads "Nothing to browse yet…" and mentions both
  ways content arrives; it shows only when neither catalog has content.
- Not touched, as instructed: `SignalsPanel` and its picker (next
  phase). Note for it: `SignalCatalogProvider` refetches on
  `dbc-changed` / `log-finished` only, so its file-backed half goes
  stale after a Clear — `file-signals-changed` is now available to fix
  that when that code is next in scope.

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
