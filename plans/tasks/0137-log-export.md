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
    are allowed (e.g. folder `logs/{logger}`, file `{start}/{now}`
    makes a per-start subdirectory), written with either separator and
    resolved to the one the running OS uses. Defaults: folder
    `logs/{logger}`, file `{start}`. Panel row order: folder, file,
    preview, max size (ruling 21 amended 2026-09-09: no format row).
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
    **Amended 2026-09-09:** the panel therefore shows **no format
    control** — a two-option select with MDF disabled asks a question
    that has one answer. The element, the project file and the
    preview's extension keep the `format` field, so the control can
    return when live MDF logging exists.
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

### 2026-09-06 — phase 2 of 4, "export dialog + background export" (branch `task137-export-dialog`)

Criteria **1** and **2** met. Phase 1's sticky state and template
machinery now have the dialog that reads and writes them; `save_capture`
runs on its own thread with progress, cancellation and partial-file
removal. No logger concepts and no file gridview — phases 3 and 4.

**Landed, host** (`apps/gui/src-tauri/src/`):

- `capture.rs` — `ExportRange` (inclusive `[start_ns, end_ns]`, either
  side `None` for unbounded), `ExportRun` (the range predicate + the
  paced progress sink + the cooperative cancel flag), `ExportOutcome`
  (`Written` | `Cancelled`), `discard_partial_export`,
  `cancel_export` / `cancel_export_now`, `capture_extent` /
  `capture_extent_now`, and `run_export` — `save_capture`'s body, now on
  a `cannet-export` thread. The command returns as soon as the write
  starts and refuses a second concurrent export (one slot, one chip).
  Both writers take `&mut ExportRun` and apply the range to *every*
  content kind — frames, notes, and MDF's file-backed signal samples —
  so an exported slice is one consistent capture and its file starts
  where the slice does.
- `ipc.rs` — `ExportProgress { written, total }` and `ExportFinished`
  (`ok` / `cancelled` / `error`), on `export-progress` /
  `export-finished`.
- `app_state.rs` — `export_cancel`, its own slot rather than a share of
  `import_cancel`: exporting the capture you are still importing into is
  legal, so one Cancel must not stop the other.
- Fixed a stale doc line on `save_capture` claiming both writers are
  "atomic (temp file + rename)". Neither is — both stream straight into
  the destination (`BlfCaptureWriter::create` / `MdfCaptureWriter::create`
  document this), which is exactly why a cancelled export has a partial
  file to remove.

**Landed, frontend** (`apps/gui/src/`):

- `ExportDialog.tsx` — the modal: name template + host-resolved preview
  (a label, ruling 10), informational full date-time labels for the
  capture's start and last message (ruling 24), and the range picker —
  dual-handle timeline over the extent with event ticks (click sets the
  nearer bound), presets, and two bound fields. 18 tests.
- `exportRange.ts` — all the range arithmetic, pure: `parseRangeBound`
  (empty = the default, `HH:MM[:SS]` wall clock, bare seconds;
  wall clock refused on an unanchored capture per ruling 22),
  `formatRangeBound`, `boundText` (a bound on an event reads as the
  event), `applyRangePreset`, `rangeSpanSeconds`, `exportRangeNs`.
  21 tests.
- `ExportProgressChip.tsx` — the status-bar chip: name + percent +
  Cancel, then the brief "Exported `<name>`". 4 tests.
- `plotWindow.ts` — the one read of a plot panel's x window from outside
  the panel, for the "Plot window" preset. A module value, not context:
  the window moves every animation frame while following the live edge.
  `PlotPanel`'s `applyXAll` publishes it. 4 tests.
- `saveFormat.ts` — `saveCaptureFilters(preferred)` (the sticky format
  reaches the OS picker as filter *order*, the only handle there is on
  which one it opens with), `saveCaptureExtension`, `joinExportPath`,
  `exportFolderOf`. `DEFAULT_SAVE_CAPTURE_NAME` / `SAVE_CAPTURE_FILTERS`
  stay for the tests that pin the offer order.
- `App.tsx` — `capture.save` now opens the dialog (reading
  `get_export_state` + `capture_extent` at open time), then the picker,
  then `set_export_state` and the background `save_capture`; listeners
  for the two new events drive the chip. `App.saveCapture.dom.test.tsx`
  rewritten around the new flow, 8 tests.
- `windowTitle.ts` — `projectName` exported (it is what `{project}`
  resolves against).

**Design choices not spelled out by a ruling:**

- **The bound fields are not the shared `Combobox`.** That control is a
  filtered *select*: its text box is an fzf filter and Enter takes the
  best-matching option over what was typed. Measured, not assumed —
  typing `09:20` selected the event labelled "fault injected" because
  its rendered time fuzzy-matched. Here the typed text is the primary
  input and the options are shortcuts, so `BoundField` is an editable
  field with a dropdown beneath it: same anatomy as ruling 14's
  "combobox", opposite precedence, and what the prototype implements.
- **The timeline handles answer the keyboard** (arrows nudge by 1% of
  the capture, Home/End restore the bound's default). The prototype
  gives them `tabindex` and no key handling; a focusable control that
  does nothing on a key press is a defect, and this was cheaper to add
  than to leave.
- **A trailing preset leaves the end bound at its default** rather than
  freezing it at the live edge of the moment it was picked, so "last 5
  min" of a running capture still reaches the edge when the write
  finishes (ruling 6).
- **Cancel is announced by the host, not assumed by the chip.** The chip
  stays up until `export-finished` arrives, because that is the moment
  the partial file is actually gone.
- Range bounds cross the wire as absolute nanoseconds computed in JS
  (`sessionStartSeconds + bound) * 1e9`), which at wall-clock magnitudes
  is f64-exact only to ~256 ns. Immaterial for a range boundary, and the
  same arithmetic the import dialog's range already uses.

**Investigation — the lib test binary would not load** (recorded because
the failure mode is non-obvious and the trap is easy to walk back into):

- *Observation.* After the first host-side edit, `cargo test -p
  cannet-gui --lib` exited `0xc0000139` (`STATUS_ENTRYPOINT_NOT_FOUND`)
  before running a single test. `cargo test -p cannet-blf` was fine, and
  the previous build's test exe still ran.
- *Hypothesis 1: stale artifact.* Falsified — deleting the exe and
  relinking, and a full `CARGO_INCREMENTAL=0` rebuild, both reproduced.
- *Hypothesis 2: pre-existing.* Falsified — reverting the five touched
  files to `HEAD` produced a binary that ran all 1009 tests.
- *Experiment.* Diffed the PE import tables of the working and broken
  exes. The broken one newly imports `user32`, `gdi32`, `ole32`,
  `dwmapi` and `comctl32` — the whole windowing stack — and resolving
  each imported name against `System32` showed exactly one missing:
  `comctl32!TaskDialogIndirect`, which lives only in the side-by-side
  ComCtl32 v6 assembly a test binary has no manifest for.
- *Conclusion.* `ExportRun` held an `Option<AppHandle>`, and the writers'
  tests construct an `ExportRun`. A field is part of a struct's drop
  glue, so naming `AppHandle` in a type the tests instantiate linked
  Tauri's app/window graph — and the dialog plugin's `rfd` calls — into
  the test binary for the first time. Confirmed by replacing the field
  with a `Box<dyn Fn(u64, u64) + Send>` sink built by the command that
  owns the handle: 1019 tests ran. The field carries a comment saying
  so.
- Bisecting also caught a real bug the same change masked: `advance()`
  only consulted the cancel flag on the 16384-frame progress checkpoint,
  so a cancel never landed on a small capture. It now reads the flag
  every frame — one relaxed load — and checkpoints only the clock read,
  which is the split `ImportProgress` already makes.

**Verification**, from the repo root unless noted:

| Job | Command | Result |
| --- | --- | --- |
| rust (test) | `cargo test --workspace` | pass |
| rust (clippy) | `cargo clippy --workspace --all-targets -- -D warnings` | pass |
| rustdoc | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | pass |
| mdf-export-oracle | `cargo run -p cannet-mdf --example export_sample -- <tmp>/sample.mf4` then `uv run --with asammdf --with numpy python crates/cannet-mdf/tests/fixtures/validate_export.py <tmp>/sample.mf4` | pass |
| frontend | `pnpm --dir apps/gui test` (3215) then `pnpm --dir apps/gui build` | pass |
| python (sidecar) | `uv sync --extra dev --frozen`, `ruff check`, `ruff format --check`, `mypy`, `pytest` in `servers/cannet-python-can` | pass (225) |
| python (client) | `cargo build -p cannet-server`, then the same five in `servers/cannet-python-client` | pass (86, 1 skipped) |
| proto gencode | `uv run --extra dev bash scripts/regen_proto.sh` + `git diff` | pass — the diff it leaves on Windows is CRLF-only (`git diff --ignore-cr-at-eol` is empty) |
| sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | pass |
| comment-references | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | clean |

`cargo fmt --all --check` is clean over the whole tree.

**Perf reading (ADR 0031 render tier), reported not judged.** One
self-driving run, `ev-zonal`, `--perf-interact scrub`, 60 s, release
host built with `pnpm --dir apps/gui tauri build --no-bundle`. Report at
`docs/performance-measurements/frontend/<date>-<hash>-task137p2.json`
(left untracked).

| metric | value |
| --- | --- |
| `longtask_ms_per_s` mean / p95 | 0.0 / 0.0 |
| `lag_ms` mean / max | −0.003 / 1.3 |
| `jank_fraction` | 0.0 |
| `rx_fps` / `tx_fps` overall | **0.0 / 0.0** |
| `rx_gap` | `null` |
| `jsheap_mb` peak / drift | 43.4 / −7.6 MB/min |
| `mem.webview_renderer_mb` peak / drift | 201.7 / −22.0 MB/min |
| `mem.tree_mb` peak / drift | 609.2 / −15.8 MB/min |
| `mem.host_mb` peak / drift | 52.2 / +1.2 MB/min |
| `interact` | scrub, 266 performed, 0 missing |

**The run measured no load**, so every timing row above describes a
resting app and none of them is comparable with a loaded baseline. The
interaction script did run (266 gestures, none missing) and the plot
resampled ~67/s, so the render tier was exercised — but no frames
arrived: `frame source ended cleanly (0 frames)`.

Not the usual "the dongles are held elsewhere" cause: both PEAK adapters
enumerated and opened (`discovered 2 interface(s)`, `PCAN_USBBUS1` /
`PCAN_USBBUS2`, `connected to 127.0.0.1:62100 (2 interface(s))`), and no
cannet was running before the launch. `tx_fps` is zero too, so nothing
was transmitted either — the rest-of-bus simulation produced no traffic
despite `--rbs-run-on-start`. The start of `cannet.log` carries no error;
its only warnings are the routine absent Vector/Kvaser libraries.
Reported for the overseer to coordinate rather than retried in a loop.

**What phases 3 and 4 inherit:**

- `ExportRun` / `ExportRange` / `ExportOutcome` are the writers' contract
  now. A logger writing live gets its splitting and its cancel from the
  same shape — but **never put an `AppHandle` in a struct the tests
  construct** (see the investigation above); pass a sink.
- `AppState::export_cancel` holds one flag and `save_capture` refuses a
  second concurrent export. A logger writing in parallel with an export
  needs its own slot, not this one.
- `capture_extent` is the host-side extent reader; `plotWindow.ts` is the
  published plot window. Both are small and reusable.
- The status bar has one export chip. A logger's "writing…" status is
  the file gridview's live row (ruling 13), not a second chip.

### 2026-09-06 — phase 3 of 4, "project loggers" (branch `task137-loggers`)

Criterion **4** met, and criterion **6**'s glossary line. A **logger** is
now a project element with its own panel: templated folder and file, a
host-resolved preview, BLF, a size cap, and a live write that runs
exactly while the logger is enabled and something is connected. The
folder's file gridview is phase 4 — this phase carries the controls and
the writing, nothing that lists files.

**Landed, host** (`apps/gui/src-tauri/src/`):

- `logger.rs` — the whole subsystem. `LoggerConfig` (id, name, enabled,
  folder, file, `maxFileSizeMb`) is pushed wholesale by the frontend
  through `set_loggers`; `reconcile` recomputes "should this logger be
  writing" for every logger and starts or stops the difference. Its
  decision is `plan`, a pure function over (configs, running ids,
  connected) so the rule is tested without an app, a filesystem, or a
  connection. `LogWriter` is the split-aware BLF sink: `split_path`
  puts `-002`, `-003`… on the last path segment before its extension,
  and `first_free_part` is applied both at the start of a run (ruling
  19's collision) and at every roll, so the rule is stated once.
  `StopSignal` is a condvar-backed stop flag — the thread is woken
  rather than polled out, which is what makes stopping cheap enough to
  wait for. 22 tests.
- `connection_state.rs` — `emit` (the one write path both `set_and_emit`
  and `remove_and_emit` funnel through) now reconciles the loggers. That
  is the whole of "start on connect, stop on disconnect": there is no
  second place where connection state changes.
- `project.rs` — `open_project` / `close_project` stop every running
  logger, beside the RBS stop that is already there. `lib.rs` stops them
  on exit, after `disconnect_on_exit`.
- `capture.rs` — `raw_to_core_frame` became `pub(crate)`; the logger
  writes frames with the same bus→channel mapping an export does.
- `crates/cannet-blf` — `BlfFileWriter::bytes_on_disk` /
  `BlfCaptureWriter::bytes_on_disk`: the header plus every flushed
  `LOG_CONTAINER`, counted rather than seeked, so a size-capped writer
  can ask per frame. `FinishedCapture::byte_size` is only correct after
  `finish` consumes the writer, which is no use to a file that has to
  decide whether to keep going.

**Landed, frontend** (`apps/gui/src/`):

- `logger.ts` — the element's defaults (`logs/{logger}`, `{start}`, 500
  MB), the load-time coercion (`normalizeLoggerFields` — only an
  explicit `true` enables), the preview's extension, and
  `loggerConfigs`, the host push payload. 11 tests.
- `LoggerPanel.tsx` — folder (+ Browse… + the host's resolved path under
  the field), file, preview-as-a-label, max size, in ruling 16's
  order, plus one message line for a template error, a host start
  failure, or "waiting for connection". 13 tests.
- The element-kind registration points: `types.ts`, `projectElements.ts`
  (`isProjectElement` — the silent dropper — and `normalizeElement`),
  `elementLabel.ts`, `dockLayout.ts`, `ProjectPanel.tsx`'s `KIND_ORDER`,
  `elementHistory.ts`, `commands.ts`, `Toolbar.tsx`, `App.tsx`, and the
  ambient-kind exclusions in `projectGraph.ts`, `ProjectGraphPanel.tsx`,
  `sinkPredicate.ts`, `insertFilterUpstream.ts`, `useElementPanel.ts`,
  `SignalsPanel.tsx`.

**Design choices not spelled out by a ruling:**

- **The logger does not sit on the ingest path.** `run_pump` is the one
  production append site and the obvious hook, but tapping it would put a
  probe and a frame clone on the hot path of every session, logger or
  not. Instead a writer thread follows the capture model's own index:
  remember how far you have written, ask the trace store for whatever
  has been appended since, write that. Zero cost when nothing is
  logging, every frame source covered without naming one, and the
  perf runs below show no change in rx/tx or lag with a logger writing.
  The one thing it gives up is a guarantee against eviction outrunning
  the writer; `settle_cursor` detects exactly that and says so on the
  system log rather than leaving a silent gap.
- **A logger is ambient**, like a colormap or a generator: no `sources`,
  no graph node. It writes the capture, not a selection from it, so
  there is no edge to draw. (It therefore writes *both* directions —
  216k frames over a 60 s ev-zonal run, which is rx plus the RBS's tx,
  exactly what the trace holds.)
- **The host's `LoggerConfig` has no format field.** Live logging is BLF
  (ruling 21), so there is no branch to make on one. The element still
  carries `format: "blf"` — the project should record what was written,
  and the preview's extension reads it — even though the panel no
  longer offers a control for it.
- **The panel has no name field.** The prototype has one because it is a
  standalone page; here the element name is the dockview tab title and
  is renamed through `panel.rename` (ADR 0019), as every other
  element-backed panel does.
- **`enabled` is outside undo** (`elementHistory.ts` — ADR 0050's
  allowlist). Folder, file and the size cap are document edits and are
  undoable; a chord that starts or stops a file being written on disk is
  not what undo is for. Same reasoning that puts RBS's whole payload
  outside it, applied to the one field with an external effect.
- **The status is polled, not pushed.** `loggers-changed` fires on a
  start, a stop, or a failure; a running file's growing size is read
  through `get_logger_statuses`. A file that grows for an hour should
  not be an hour of events.

**Investigation — the first live run left an unfinalized file:**

- *Observation.* After the first 60 s run with a logger enabled, the BLF
  it wrote read `file_size = 0` and `object_count = 0` in its
  `FileStatistics` header, and `cannet.log` carried the
  "logging to …" line but no "finished …" line.
- *Hypothesis.* The writer thread never reached `finish()`, because
  `stop_one` set a flag and returned without waiting, and the harness
  exited while the thread was still asleep between 250 ms polls.
- *Experiment.* Made stopping wait for the thread (`StopSignal` wakes it
  out of the sleep; `stop_one` joins), added a `logger::stop_all` on the
  exit path beside `disconnect_on_exit`, and re-ran the same 60 s
  capture.
- *Data.* `Perf log: finished …\logs\perf-log-20260906T073325-0700.blf
  (216209 frame(s))`, and the header now reads `file_size = 1515020`
  against an actual 1515020 bytes, `object_count = 216209`.
- *Conclusion.* Confirmed. Regression-guarded by
  `a_finished_run_leaves_a_finalized_file_and_an_abandoned_one_does_not`
  (which pins both halves — finished vs. abandoned) and by the two
  `StopSignal` tests.

**Verification**, from the repo root unless noted:

| Job | Command | Result |
| --- | --- | --- |
| rust (test) | `cargo test --workspace` | pass (52 suites, 0 failures) |
| rust (clippy) | `cargo clippy --workspace --all-targets -- -D warnings` | pass |
| rustdoc | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | pass |
| mdf-export-oracle | `cargo run -p cannet-mdf --example export_sample -- <tmp>/sample.mf4` then `uv run --with asammdf --with numpy python crates/cannet-mdf/tests/fixtures/validate_export.py <tmp>/sample.mf4` | pass |
| frontend | `pnpm --dir apps/gui test` (3239) then `pnpm --dir apps/gui build` | pass |
| python (sidecar) | `uv sync --extra dev --frozen`, `ruff check`, `ruff format --check`, `mypy`, `pytest` in `servers/cannet-python-can` | pass (225) |
| python (client) | `cargo build -p cannet-server`, then the same five in `servers/cannet-python-client` | pass (86, 1 skipped) |
| proto gencode | `uv run --extra dev bash scripts/regen_proto.sh` + `git diff` | pass — CRLF-only on Windows (`git diff --ignore-cr-at-eol` empty) |
| sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | pass |
| comment-references | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | clean |

`cargo fmt --all --check` is clean over the whole tree.

**Perf reading (ADR 0031 render tier), reported not judged.** Four runs,
`ev-zonal`, `--perf-interact scrub`, 60 s, release host from `pnpm --dir
apps/gui tauri build --no-bundle`. Reports at
`docs/performance-measurements/frontend/2026-09-06-bdd49487-task137p3*.json`
(left untracked). Every run measured real load — rx ≈ 1608, 174 ids in
`rx_gap`, 266 gestures performed and 0 missing.

| run | rx / tx | lag mean / max | longtask p95 | jank | jsheap max | renderer max | host max | tree max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| run 1 | 1607.8 / 1614.7 | −0.017 / 20.2 ms | 0.0 | 0.0 | 93.5 MB | 313.5 MB | 59.6 MB | 718.7 MB |
| run 2 | 1607.3 / 1612.5 | −0.018 / 2.7 ms | 0.0 | 0.0 | 92.2 MB | 322.0 MB | 59.9 MB | 729.3 MB |
| run 3 | 1607.1 / 1612.0 | −0.017 / 1.6 ms | 0.0 | 0.0 | 91.3 MB | 313.8 MB | 59.3 MB | 720.9 MB |
| **logging** | 1605.7 / 1611.7 | +0.100 / 27.0 ms | 0.0 | 0.0 | 106.7 MB | 317.7 MB | 60.8 MB | 725.7 MB |

Runs 1–2 are the pre-fix binary and run 3 the shipped one; the fix
touches only logger shutdown, and the control project has no logger.
The **logging** run had a logger enabled and writing the whole time
(216 209 frames, 1.5 MB of BLF — the format compresses to about 7 bytes
a frame). Frame rates and mean lag are unchanged with the write running;
`lag_ms.max` is a single-sample tail that moved between 1.6 and 27 ms
across the four runs with no relation to what was running.

**What phase 4 inherits:**

- `get_logger_statuses` is the read side the file gridview needs:
  `{ id, writing, path, bytes, frameCount, error }` per logger, with
  `path`/`bytes` following the file *currently* being written. Poll it
  for the growing row; `loggers-changed` announces only start / stop /
  failure.
- The panel renders folder → file → preview → max size and then stops.
  The file list goes under that, and the writing row is where the
  logging status belongs (ruling 13) — the panel has no status line and
  should not gain one.
- `LogWriter::parts()` (test-only today) is the list of files one run
  opened, if the gridview wants to mark them as this run's.
- The `logger-panel` CSS block in `index.css` holds the row/label
  geometry the list should sit beneath.
- A run writes **both directions** — the capture holds rx and tx alike —
  so a file's frame count is roughly twice the rx rate on a project with
  an RBS running. Worth saying in the column header's tooltip if the
  number looks surprising.

### 2026-09-09 — bench fix, day-scale range bounds (branch `task137-export-dialog`)

Owner, testing a four-day trace: "it won't accept anything beyond
h:m:s."

**Observation.** `parseRangeBound`'s clock pattern was
`/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/` with `h > 23` refused, and the
offset came from `at.setHours(h, m, sec, 0)` on the capture's start
*date* — so every clock resolved inside `[0, 86400)`. `formatRangeBound`
rendered `HH:MM:SS` with nothing above hours.

**Experiment** (red-first, `apps/gui/src/exportRange.test.ts` against a
capture starting 2026-09-05T09:15:02 and running four days):

| input | expected | measured before the fix |
| --- | --- | --- |
| `parseRangeBound("3d 12:30")` | 270898 | `undefined` |
| `formatRangeBound(270898)` | `3d 12:30:00` | `12:30:00` |
| `parseRangeBound(formatRangeBound(270898))` | 270898 | 11698 |

**Conclusion.** Two defects, one cause: the clock form carries no day.
Entry past the first midnight is impossible, and — worse, because it is
silent — a bound that *is* past it renders as a first-day clock, so
reading the field back and committing it moves the bound three days.

**Fix.** The clock takes an optional capture-day prefix, `[Nd ]HH:MM[:SS]`
(`3d 12:30:00`, `3d12:30`), counted in local calendar days from the day
the capture started, and `formatRangeBound` emits the prefix whenever
the bound is not on the capture's own day. Calendar days rather than
86400-second blocks, so a DST transition inside a long capture does not
shift every later day's index. A bare clock is unchanged: still the
capture's own day, still rolling to the next when it is earlier than the
start. An explicit day never rolls — it says which day it is — so a
day-prefixed clock landing before the start is refused rather than
quietly pushed forward. Seconds-from-start was never magnitude-limited
and stays the escape hatch.

Tests: 7 added in `exportRange.test.ts` (parse with and without the
prefix, the out-of-range and before-the-start refusals, seconds at day
scale, prefixed and unprefixed display, round trip) and 1 in
`ExportDialog.dom.test.tsx` (typing `3d 12:30` into the start field on a
four-day capture exports that bound and the field reads back
`3d 12:30:00`). The field tooltip and the parse-failure message name the
prefix; README's export-range paragraph documents it.

### 2026-09-09 — bench fix, no format control on the logger panel (branch `task137-loggers`)

Owner ruling on the panel's Format row: hide it. A two-option select
whose second option is permanently disabled is a control that asks a
question with one answer, and it reads as a feature that is broken
rather than one that does not exist yet.

Landed: the `<select>` and its label are gone from `LoggerPanel.tsx`;
**Max size** moves up to be that row's own label (its own `id`, so the
control is still found by its label). `format` stays on the element and
in the project file — the host's `LoggerConfig` never had it, but the
preview's extension reads it and the project should record what was
written, so the control can return when live MDF logging exists. The
`.logger-lbl-inline` rule and the `select:disabled` selector in the
panel's CSS block went with it — nothing else in the panel used either.

Tests: 3 in `LoggerPanel.dom.test.tsx` changed red-first — the row-order
case now expects folder → file → preview → **max size**, the
writing-lock case no longer asserts a disabled Format, and the
"offers BLF and refuses MDF" case is replaced by one asserting no
Format control renders, neither format name appears, and the panel
issues no element update on mount. README's logger table loses its
Format row and says in prose that a logger writes BLF; `docs/CONTEXT.md`'s
Logger entry and rulings 16 and 21 follow.

## Blockers / side effects

- **`cargo fmt --all --check` is still red** on
  `apps/gui/src-tauri/src/interfaces.rs` (pre-existing since `7d18a421`
  #460, already flagged in task 136's own status log). Not fixed here:
  the file is untouched by this phase and belongs to work another
  branch owns in this shared tree.

- **`cargo fmt --all --check` was red** on
  `apps/gui/src-tauri/src/interfaces.rs` (pre-existing since `7d18a421`
  #460; flagged by task 136 and by this task's phase 1). **Fixed here** —
  `rustfmt` reaches it through `lib.rs`'s module tree, so formatting this
  phase's files formatted it too. Whitespace only (12 insertions, 3
  deletions), and the pre-commit hook would have made the same change on
  any commit that ran it.
- One run of the full frontend suite showed
  `PlotPanel.dom.test.tsx > re-renders no plot area that holds none of
  the affected rows` failing (expected 2 renders, saw 8). It did not
  recur: the file passes alone (265 tests) and the full suite passed
  twice afterwards. Recorded rather than dismissed — if it reappears it
  is a real ordering dependency, not this phase's change (nothing here
  renders during a plot slide; `publishPlotWindow` is a module-value
  write).

- **A logger's file was left unfinalized when the process exited** —
  found by inspecting the first live run's output, fixed in this phase
  (see the investigation in the phase-3 status log). Stopping a logger
  now waits for its writer thread, and the exit path stops every logger
  after `disconnect_on_exit`. Worth knowing because the failure was
  silent: the capture is still readable, just through the BLF reader's
  recovery path rather than as a clean file.
- **The live split is covered by unit tests, not by a live run.** BLF
  compresses a frame to about 7 bytes, so a 60 s ev-zonal run produces
  1.5 MB and the smallest cap the control offers is 1 MB — a live split
  needs roughly half an hour of traffic. `LogWriter`'s tests drive the
  same code path with a 4 KB cap, which is the behaviour; only the
  MB → bytes multiply is untested end to end.

### 2026-09-06 — phase 4 of 4, "the logger folder's file gridview + ranged import" (branch `task137-file-grid`)

Criterion **5** met in full, plus the README half of criterion **6** (the
logger section now covers the file list; rustdoc covers the new host
modules — the CONTEXT.md glossary line was already phase 3's). This
closes out the panel phase 3 built: it now lists what its folder holds,
recursively, with the writing file as the list's own live row and no
separate status line.

**Landed, host** (`apps/gui/src-tauri/src/`):

- `log_files.rs` — `LogFileCache` (a `Mutex<HashMap<PathBuf, …>>`,
  in-memory, host-state scoped) keyed by absolute path and invalidated by
  `(size, modified time)`; `list_logger_files` walks a folder recursively,
  sorted by name, building a `LogFileNode` tree (`Dir { children }` /
  `File { … }`, internally tagged for a TS discriminated union). A
  finished file's start/end/message-count is [`cannet_blf::scan_blf`] —
  the same header-only walk `scan_blf_channels` already pays for on
  import — cached so a listing that finds nothing changed about a file
  pays nothing for it. The file any logger is writing right now is never
  scanned: its path is read off `LoggerRuntime::statuses()` (now
  `pub(crate)`) and its row instead carries that status's live bytes and
  frame count — the same numbers `get_logger_statuses` already tracks,
  so a growing file costs one status read, not a header walk of an
  unfinalized file. 12 tests over `LogFileCache::get_or_scan` (reuse vs.
  rescan on a moved size or modified time), `writing_files` (the pure
  status → path-map projection), and `list_files` (the walk, over real
  files `LogWriter` wrote) — none needs an `AppHandle` in a test-built
  struct.
- `reveal.rs` — `reveal_in_file_manager`: `explorer /select,` /
  `open -R` / `xdg-open <dir>` per platform, the command line factored
  into a pure `reveal_command` so the platform rule is tested without
  actually popping a file-manager window (nothing spawns a process in a
  test).
- `lib.rs` — the two modules registered, `LogFileCache` managed state,
  `list_logger_files` / `reveal_in_file_manager` added to the invoke
  handler.

**Landed, frontend** (`apps/gui/src/`):

- `logFileGrid.ts` — pure logic over the host's tree: `flattenLogTree`
  (branch children spliced in only while expanded, ADR 0044),
  `findLogNode`, `isSelectableLogNode` (a leaf that isn't the writing
  row), and the column formatters — `formatLogTimestamp` renders a UTC
  ISO 8601 string (the column is "trace start/end **as ISO
  timestamps**"; the export dialog's own informational start/end labels
  render local time instead, for a different reason — see below).
  17 tests.
- `LoggerFileGrid.tsx` — the gridview itself, built on `useGridview` /
  `arrayRowSpace` / `gridviewSelection`: the same non-virtualized
  scroll-into-view adapter `BlfChannelMapModal`'s markers list uses (a
  log folder is small enough to render every row). Renders the host's
  tree with a caret-toggled branch per directory; the writing row carries
  a ● and no import button; the per-row button is the `Icon.tsx`
  registry's `import` shape with an "Import" tooltip; a right-click opens
  a small context menu (Import + Show in Explorer for a file, Show in
  Explorer alone for a directory); Space on the cursor row imports it
  through the same `onPrimaryAction` path Space already means everywhere
  else in the app. Polls `list_logger_files` while the logger is writing
  (`loggers-changed` fires only on start/stop/failure, not on a split
  roll, so a newly-finished part would otherwise sit unlisted until the
  run stops) and refetches on the event otherwise. 9 tests.
- `LoggerPanel.tsx` — renders `<LoggerFileGrid>` beneath the message
  line, folder resolved to the same string the "→ …" line under the
  Folder field shows, `writing` from the status it already reads for
  locking, `onImport` wired to the project context's new
  `onImportCapture`.
- `projectContext.ts` / `App.tsx` — `ProjectContextValue.onImportCapture`
  is `handleImportTrace` itself: the grid's import affordances call the
  exact function "Import trace…" does, with a preset path instead of
  opening the file picker — the census, the channel-mapping/range dialog
  and the unsaved-capture guard (inside `resetSession`, which
  `handleBlfMapConfirm` already runs before the pump starts) are all the
  one flow, never forked.
- `index.css` — the `.logger-file-*` block, styled off the same tokens
  `.blf-map-marker-row` (cursor/selected) and `.combobox-pop` (the
  context menu) already use — no new tokens invented.
- Six `.dom.test.tsx` files that build a strict `ProjectContextValue`
  literal gained the new required field (`onImportCapture: () =>
  {}`/`noop`); the others already narrow through `as unknown as
  ProjectContextValue` and needed nothing.

**Design choices not spelled out by a ruling:**

- **`LogFileCache` is in-memory, not a persisted document.** The task
  pointed at "the repo's existing per-file-cache precedents", and the
  closest one — the pyramid cache's old whole-DBC-set stamp
  (`signal_cache.rs`'s `PyramidValidity` docs) — is explicitly a
  cautionary tale the codebase *moved away from*: a coarse file-metadata
  stamp discarded good caches on a copy or checkout that touched nothing
  a decode cares about. Persisting this cache to disk would have to
  answer the same "what identifies a session" questions
  `SignalCacheStore::persist`/`restore` do (ADR 0047) for a cache whose
  whole job is cheaper than the read it is caching (an `fs::metadata`
  stat plus a `HashMap` lookup) — not worth inventing a document format
  for. A session that lists a folder it has never listed before pays one
  scan per file, same as today; the ruling's requirement ("never a
  header scan per listing") is about repeat listings within a session,
  which this satisfies without touching disk.
- **The writing file is found by path match, not reconstructed
  client-side.** The prototype (client-side, no real backing store)
  inserts a synthetic node into the tree at the writing file's directory.
  Here the file is already a real file on disk the moment `LogWriter`
  opens it (`create_dir_all` then `File::create`), so the host's own
  recursive walk finds it in its real place; `list_logger_files` only
  has to recognise the path (from `LoggerRuntime::statuses()`) and answer
  with the status's numbers instead of a header scan. No path-splicing
  logic exists on either side.
- **"Show in Explorer" is a hand-rolled process spawn, not a new
  dependency.** `tauri-plugin-opener`'s `reveal_item_in_dir` would do
  this in one call, but bringing in a plugin mid-phase for one context-
  menu action is exactly what CLAUDE.md's "surface that decision first"
  asks not to do quietly. Three platform command lines is a small enough
  surface to hand-write and the part worth getting right — which command
  line — is a pure function the tests cover without spawning anything.
  Left for the owner to weigh against the plugin at task close-out if a
  second reveal site ever wants one.
- **The context menu is hand-rolled**, matching `SignalsPanel`'s own
  `sourcesMenu` (`{x, y}` state, `position: fixed`, dismissed on the next
  document click) — there is no shared `ContextMenu` component in the
  app to reuse.

**Verification**, from the repo root unless noted:

| Job | Command | Result |
| --- | --- | --- |
| rust (test) | `cargo test --workspace` | pass (52 suites, 0 failures) |
| rust (clippy) | `cargo clippy --workspace --all-targets -- -D warnings` | pass |
| rustdoc | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | pass |
| mdf-export-oracle | `cargo run -p cannet-mdf --example export_sample -- <tmp>/sample.mf4` then `uv run --with asammdf --with numpy python crates/cannet-mdf/tests/fixtures/validate_export.py <tmp>/sample.mf4` | pass |
| frontend | `pnpm --dir apps/gui test` (3265) then `pnpm --dir apps/gui build` | pass |
| python (sidecar) | `uv sync --extra dev --frozen`, `ruff check`, `ruff format --check`, `mypy`, `pytest` in `servers/cannet-python-can` | pass (225) |
| python (client) | `cargo build -p cannet-server`, then the same five in `servers/cannet-python-client` | pass (86, 1 skipped) |
| proto gencode | `uv run --extra dev bash scripts/regen_proto.sh` + `git diff` | pass — CRLF-only on Windows (`git diff --ignore-cr-at-eol` empty); reverted before committing |
| sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | pass |
| comment-references | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | clean |

`cargo fmt --all --check` is clean over the whole tree.

**Perf reading (ADR 0031 render tier), reported not judged.** One run,
`ev-zonal`, `--perf-interact scrub`, 60 s, release host from `pnpm --dir
apps/gui tauri build --no-bundle`. Report at
`docs/performance-measurements/frontend/2026-09-06-30876139-task137p4.json`
(left untracked). Real load: `rx_fps.overall` 1603.3, `tx_fps.overall`
1609.9, 174 ids in `rx_gap`, 266 gestures performed and 0 missing.

| metric | value |
| --- | --- |
| `longtask_ms_per_s` mean / p95 | 0.0 / 0.0 |
| `lag_ms` mean / max | 0.057 / 3.5 ms |
| `jank_fraction` | 0.0 |
| `rx_fps` / `tx_fps` overall | 1603.3 / 1609.9 |
| `jsheap_mb` max | 90.2 MB |
| `mem.webview_renderer_mb` max | 328.9 MB |
| `mem.tree_mb` max | 728.6 MB |
| `mem.host_mb` max | 59.5 MB |

Every number sits inside the band phase 3's four runs already showed
(renderer 313.5–322.0 MB, host 59.3–59.9 MB, tree 718.7–729.3 MB, lag
mean within ±0.1 ms) — nothing here moved by the file gridview or the
extra `list_logger_files` polling while a logger writes.

**What task 137's close-out inherits:**

- Every exit criterion with code (1–5) is now met; criterion 6
  (documentation) has README and rustdoc done, and the CONTEXT.md
  glossary line from phase 3 — nothing outstanding there either, though
  closing the task is the overseer's call, not this phase's.
- `reveal_in_file_manager` is one command shared by every file and
  directory row; a future "Show in Explorer" elsewhere in the app can
  reuse it as-is.
- The context menu and the caret button are hand-rolled per this phase's
  design-choices section — worth folding into a shared component if a
  third gridview wants either.

### 2026-09-08 — bench fix: path separators followed Windows on every OS (branch `task137-loggers`)

**Observation.** On macOS the logger panel's file-path preview read
with `\` separators — the folder line and the Preview label both.

**Hypothesis.** The separator is chosen where the code is written, not
where it runs: the frontend rewrites `/` to `\` for display, and the
defaults are spelled with `\`.

**Experiment.** `git blame` on every hardcoded `\` under the logger
surfaces, then a test per site asserting the running OS's separator.
Three sites, all introduced by this branch's commit `e3c13001`:
`logger.ts`'s `loggerPreviewName` (`resolvedFile.replace(/\//g, "\\")`),
`DEFAULT_LOGGER_FOLDER` (`logs\{logger}`), and `logger.rs`'s
`resolve_run_path` (`file.text.replace('/', "\\")`) — the *written*
path, so the preview was at least honest about the file it would make.
The Rust test failed on Windows too (`logs/{logger}` resolved to
`…\logs/front-ecu`, mixing both), which falsifies "this is only a mac
problem": the resolution had no separator policy at all.

**Conclusion.** Template resolution now has one:
`export_template::to_native_separators` renders every resolved template
in `MAIN_SEPARATOR`, whichever separator it was typed with, so a
project written on one OS opens correctly on the other. With that in
the model, the two frontend rewrites disappear — the preview passes the
host's text through — and `resolve_run_path` joins the two halves
plainly. The cost, documented on the helper: a literal `\` cannot
appear *in* a name on Unix, since a template separator is a separator
everywhere.

Ruling **16**'s default folder is now `logs/{logger}` rather than
`logs\{logger}` (the ruling and the landed-work list are updated to
match). It is the same folder on Windows — the host renders it — and a
real subdirectory on macOS instead of a file named `logs\bench-log`.

**Tests.** `export_template.rs`:
`a_template_written_with_either_separator_resolves_in_the_host_os_separator`,
`a_folder_template_roots_in_the_host_os_separator` (27 in the module).
`LoggerPanel.dom.test.tsx`: `shows the paths in the host OS's
separators, not Windows' always` — the stand-in host now has an OS
(`host.sep` / `host.root`), and the test drives it as a mac. Verified
red against the old `loggerPreviewName` before the fix stayed in.

**A second site, one branch up** (`task137-file-grid`): the gridview
marked a directory row with a hardcoded `\`. It has no host call of its
own to read a separator from, but it is handed the resolved folder — an
absolute path in the running OS's own form — so `logPathSeparator`
reads the marker off that (`logFileGrid.ts`, tested both ways, plus a
DOM test rendering a mac folder). The dom test's stand-in folder was
`C:/logs`, a shape the host no longer produces; it is `C:\logs` now.
