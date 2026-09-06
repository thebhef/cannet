# 0137 — Log Export

> **Opened 2026-09-05** from owner usage feedback (split out of task
> 134). **Needs grooming before implementation.**

Log export with date/time in the file name. The file export dialog
needs some prototyping — it should support some format string
behaviour (date/time + suffix/format string).

## Grooming notes

**2026-09-05 (owner rulings, prototyped via artifact page):**

1. **Shape: an in-app export dialog** in front of `capture.save`,
   holding the editable name template with a live-resolved preview.
   **Format is picked the typical way — in the file picker**: Export…
   opens the native Save As seeded with the resolved name, in the
   last-used folder, with the last-used format's filter pre-selected.
   Hand-rolled like today's modals; task 130 converges it later.
2. **Sticky location and format.** The export folder and the
   last-used format are remembered and pre-fill the next export.
3. **Tokens: `{project}`, `{start}`, `{now}`.** `{project}` is the
   slugified project name; `{start}`/`{now}` take strftime-style
   formats (`{start:%Y%m%d-%H%M%S}`). A bare time token resolves as
   **ISO 8601 with timezone offset, in *basic* format**
   (`20260905T091502-0600`; ruled 2026-09-06) — extended ISO's
   colons can't appear in a Windows file name. `{start}` is the
   capture's wall-clock start (`sessionStartSeconds`); on an
   unanchored capture it resolves as `{now}` and the preview says
   so. **Default template: `{project}-{start}`** — slugified project
   name, not "capture".
4. **Export runs in the background; the GUI stays live.** A progress
   chip in the status bar shows the running export (name + percent)
   with a cancel affordance, then a brief "Exported `name`" state.
   Today's `save_capture` is a one-shot command — it needs progress
   reporting and cancellation (the import pump is the precedent).
5. **New feature in scope: project loggers.** A logger is a project
   element (one panel per logger) packaging the same controls —
   ideally the same view, packaged differently: name template +
   preview, folder, format. When enabled it writes the capture to
   file live (.blf). Folder and format persist with the logger, in
   the project.

**2026-09-06 (owner rulings, second prototype round):**

6. **Export range.** The export dialog carries start and end times,
   both defaulting to empty = the whole capture up to the moment of
   export — approximately: frames arriving while the file is written
   may be included up to the live edge when writing finishes.
7. **Logging follows the connection.** A logger writes exactly while
   `enabled && connected`: start on connect, stop on disconnect;
   enabling while connected starts at once, disabling stops. Folder
   and format (and the size cap) are locked while logging.
8. **Size-capped splitting.** A logger has a max file size in MB
   (default 500); hitting it closes the file and opens the next.
9. **Folder file list.** The logger panel lists the folder's
   existing .blf files with reload via a per-row button and a
   context menu — built on the gridview control, nothing reinvented.
10. **The preview renders as a label**, not a text box.
11. **`{logger}` token.** The logger's (slugified) name is a template
    token; outside a logger it is an error.
12. **The folder is templated too.** Tokens resolve in the folder
    text, and a relative folder is rooted at the project directory
    when the project is open in project-directory mode (an error
    otherwise). The resolved path shows under the field.
13. **No separate logging status line.** The gridview's live
    "writing…" row (● name + growing size) *is* the logging status —
    a parallel "Logging — path · MB" line is redundant and dropped.
14. **Range selection is a picker, not bare text.** A dual-handle
    timeline over the capture extent (drag to the outer edge =
    default bound), presets (whole capture, last 1/5/30 min, plot
    window), and **combobox** bound fields: type `HH:MM[:SS]` or
    seconds-from-start, or open the dropdown listing the default
    ("start" / "last message captured") with the capture's events
    (timeline notes/markers) selectable beneath. Events also render
    as ticks on the timeline (click sets the nearer bound); a bound
    on an event displays as the event.
15. **The file list's reload affordance is the import icon** (the
    `Icon.tsx` registry's `import` shape) with an "Import" tooltip,
    not a text button.
16. **Logger file field.** The logger's template field is labelled
    **File** and may carry a path relative to the folder — separators
    are allowed (e.g. folder `logs\{logger}`, file `{start}\{now}`
    makes a per-start subdirectory). Defaults: folder
    `logs\{logger}`, file `{start}`. Panel row order: folder, file,
    preview, format.
17. **The file list recurses.** Because the File template can carry
    subpaths, the folder listing walks subdirectories and shows them
    as branch nodes in the gridview (the layer's existing branch
    semantics — no control rework). The context menu's import entry
    is the import icon + "Import" (directories offer only reveal);
    Show in Explorer/Finder stays.
18. **The prototype lives in the repo**, at
    `plans/prototypes/export-dialog.html` (see
    `plans/prototypes/README.md`); its file list runs the real
    gridview layer bundled from `apps/gui/src`. The claude.ai
    artifact page used for the first rounds is superseded.

**2026-09-06: prototype accepted by the owner.** Everything the
prototype demonstrates is the behavioural spec; with it, these
previously-open items are ruled: split naming (`-002`, `-003` on the
last path segment), range input (`HH:MM[:SS]` wall clock or
seconds-from-start, comboboxes with events), reload = the usual
import flow (the unsaved-capture guard applies), export cancel
removes the partial file, and the strftime subset
(`%Y %y %m %d %H %M %S %z %Z %%`).

**2026-09-06 (owner rulings closing the residue):**

19. **Logger start collision**: take the next split suffix
    (`-002`…). The `{n}` token is dropped as redundant. Export needs
    nothing — the OS Save As dialog already confirms overwrite.
20. **Enabled flag is project-persisted**: a logger left enabled
    resumes logging on project open + connect. (Deliberately unlike
    the RBS Run flag, which is *session* state per ADR 0028 —
    CONTEXT.md's claim that Run was project-persisted was stale and
    is fixed in this change. Logging writes locally; it transmits
    nothing, so the opening-a-project-never-transmits rule is
    untouched.)
21. **BLF-only live logging for now**; export keeps both formats.
22. **Unanchored capture: no wall-clock bounds.** The range picker
    displays and parses seconds-from-start when the capture has no
    anchor (relative time is likely the most useful form anyway).
23. **Templates resolve host-side, full strftime**: no subset — the
    format string passes straight through to `chrono`, and the host
    returns helpfully polished error messages to the frontend
    (`chrono` becomes a direct `cannet-gui` dependency;
    technology-inventory updated in this change).
24. **Export dialog shows informational wall-time labels** for the
    capture's ends (start / last message), full date-time.
25. **The file gridview's columns** (amended 2026-09-06): name, size,
    trace start and end as **ISO timestamps**, **duration**,
    **message count**, and the retained filesystem **modified** time.
    **Trace start/end (and count) are cached per file** — never a
    header scan per listing; invalidated by the file's modified time.
26. **Import from the gridview launches the typical import dialog**,
    whose range controls let the user select the slice of the file
    to import.

## Exit criteria

The prototype (`plans/prototypes/export-dialog.html`) is the
behavioural reference; every behaviour lands with a test written
first.

1. The export dialog replaces the bare Save Capture flow: name
   template with live preview, range picker (timeline + comboboxes +
   events + presets, wall-time labels, relative-only when
   unanchored), then the OS picker seeded with the resolved name,
   last-used folder, and last-used format. Sticky folder / format /
   template persist as machine state.
2. Export runs without blocking the GUI: a status-bar progress chip
   (name + percent + cancel; cancel removes the partial file), the
   capture model still serving views throughout.
3. Template machinery host-side: `{project}` / `{logger}` /
   `{start}` / `{now}` tokens, bare tokens = ISO 8601 basic with
   offset, explicit formats passed through to chrono, invalid
   templates rejected with polished messages surfaced in the
   preview.
4. Project loggers: a project element with one panel each (folder →
   file → preview → format order), folder and file templates
   (relative folders under the project directory, subpaths in the
   file), logging exactly while enabled ∧ connected, controls locked
   while writing, BLF live write with the size-cap split
   (default 500 MB, `-00N` suffix, collision takes the next suffix),
   enabled flag project-persisted.
5. The logger panel's recursive file gridview: directories as
   branches; columns name, size, trace start/end (ISO), duration,
   message count, modified time — start/end/count served from a
   per-file cache, not a per-listing header scan; the writing row as
   live status; import via button / context menu / Space opening the
   import dialog with range selection for the slice to import.
6. Docs: README covers export naming and loggers; rustdoc on new
   public API; the CONTEXT.md glossary gains the logger term.

## Status log

### 2026-09-06 — phase 1 of 4, "template machinery + sticky state" (branch `task137-templates`)

Criterion **3** met in full, plus the sticky-state persistence half of
criterion **1** (folder / format / template persist at machine scope;
the dialog that reads and writes them is phase 2). No GUI landed —
phases 2-4 build the export dialog, project loggers, and the file
gridview on top of this.

**Landed**, `apps/gui/src-tauri/src/`:

- `export_template.rs` — `resolve` / `resolve_folder`: `{project}`,
  `{logger}`, `{start}`, `{now}` tokens; a bare token is ISO 8601
  basic with a timezone offset (chrono's own `%z`, so no separate
  implementation); `{token:<fmt>}` passes `<fmt>` straight through to
  chrono's `format_with_items` (validated first via `StrftimeItems`
  against `Item::Error`, so a bad specifier can't hit chrono's
  `to_string` panic) — full strftime, no subset, per the 2026-09-06
  ruling. `{start}` on an unanchored capture (`start_seconds: None`)
  resolves as `{now}` and `Resolved::start_resolved_as_now` carries
  that fact for a future preview to announce. `resolve_folder` roots a
  relative result at `TemplateContext::project_dir`, which the
  `preview_export_template` command sets from
  `ActiveProjectDir::is_auto_located()` — `None` (and therefore an
  error on a relative folder) exactly when the project has no
  directory the user chose. The four required error shapes (unknown
  token, bad strftime, `{logger}` outside a logger, relative folder
  with no project directory) each carry a polished message; 33 tests.
- `export_state.rs` — `ExportState { folder, format, name_template }`
  at user (machine) scope, `export.json` under `app_config_dir`,
  following the `servers.json` / `persisted_json` precedent
  (`parse_or_default` + atomic write); default template
  `{project}-{start}`, default format BLF. `get_export_state` /
  `set_export_state` Tauri commands for phase 2 to read and write. 6
  tests.
- `preview_export_template` Tauri command: `(template, project,
  logger, start_seconds, is_folder) -> TemplatePreview { resolved,
  error, start_resolved_as_now }` — the live-preview surface phase 2's
  dialog and phase 3's logger panel both call.
- `chrono` added as a direct `cannet-gui` dependency (`std`, `clock`
  features — `clock` for `Local::now()`, which `cannet-log`'s existing
  use of chrono deliberately omits); `plans/technology-inventory.md`
  already carried this extension from the owner ruling, so it needed
  no further edit here.

**Design choices not spelled out by a ruling:**

- `resolve` takes `now: DateTime<Local>` as a parameter rather than
  reading the system clock itself, so a future logger can inject "the
  moment logging started" instead of "the moment the panel repaints"
  for its own `{now}` — the token table's "for a logger, the time
  logging started" line. The Tauri command supplies `Local::now()`.
- "Project-directory mode" (rulings 12, 16) is read as `!is_auto_located()`
  on the active project directory — the project has a directory the
  user pointed cannet at, not one cannet chose for lack of one (ADR
  0042). A relative folder under an auto-located directory would land
  inside cannet's own cache space, which is what the "otherwise an
  error" half of the ruling is for.
- `project` is a required string the caller supplies (not derived
  here): the frontend already computes a project display name for the
  window title, and this module has no independent notion of what a
  project is called.

**Verification**, run from the repo root unless noted:

| Job | Command | Result |
| --- | --- | --- |
| rust (test) | `cargo test --workspace` | pass |
| rust (clippy) | `cargo clippy --workspace --all-targets -- -D warnings` | pass |
| rustdoc | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | pass |
| mdf-export-oracle | `cargo run -p cannet-mdf --example export_sample -- <tmp>/sample.mf4` then `uv run --with asammdf --with numpy python crates/cannet-mdf/tests/fixtures/validate_export.py <tmp>/sample.mf4` | pass |
| frontend | `pnpm --dir apps/gui test` then `pnpm --dir apps/gui build` | pass (untouched by this phase) |
| python | `uv sync --extra dev --frozen && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest` (in `servers/cannet-python-can`) | pass (untouched) |
| sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | pass |
| comment-references | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | clean |

`cargo fmt --all --check` is clean over every file this phase touched.

## Blockers / side effects

- **`cargo fmt --all --check` is still red** on
  `apps/gui/src-tauri/src/interfaces.rs` (pre-existing since `7d18a421`
  #460, already flagged in task 136's own status log). Not fixed here:
  the file is untouched by this phase and belongs to work another
  branch owns in this shared tree.
