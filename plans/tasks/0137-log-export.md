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
