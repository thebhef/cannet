# Backlog

Short, prunable list of things noticed in passing that don't belong in the
current step. Add an entry instead of doing drive-by work, then revisit this
file when planning the next step or phase to decide whether each item should
fold into upcoming work or be dropped.

Keep this file small. A growing backlog is a signal to either schedule the
work or admit it isn't going to happen and delete it.

## Conventions

- One bullet per item. Include enough context (file path, symbol, or short
  description) that the next reader can act on it without spelunking.
- Optionally tag with a category in brackets, e.g. `[cleanup]`, `[perf]`,
  `[docs]`, `[idea]`.
- When an item is picked up, remove it from this file in the same commit
  that addresses it (or that schedules it into a phase).
- Group items by the surface they touch (trace view, plot panel, host
  crates, …) so the next pass on that surface can absorb them as one
  piece. Cross-cutting items go in **GUI chrome and cross-cutting**.

## Items

### CI / checks

Static and automated checks we'd like running on the repo to catch a
class of bug before it ships, rather than relying on the next user to
trip over it.

- `[ci]` **Typed Tauri command bindings via `tauri-specta`.** The
  `invoke<T>(cmd, args)` signature types only the return value; `args`
  is `unknown`, so a snake_case/camelCase wire-name mismatch between a
  JS payload and the Rust struct's `#[serde(rename_all = ...)]` is a
  silent runtime error (recent example: `TransmitPanel.tsx` sent
  `bus_id` against a `camelCase` `TransmitRequest`, surfacing only as
  Tauri's deserialization error string in the panel toolbar). Derive
  `specta::Type` on each command's arg structs, run the build step to
  emit a generated `commands.ts`, and call `commands.transmitFrame({
  request: { busId: ... } })` from the frontend so `tsc` rejects the
  wrong-case key. Evaluate properly (and land in
  [technology-inventory.md](technology-inventory.md)) before adopting.

- `[ci]` **Guard the checked-in Python proto gencode against drift.**
  `servers/cannet-python-can/cannet_python_can/_proto/cannet_pb2.py` is
  committed but nothing in CI regenerates it from the canonical
  `cannet.proto` and diffs — a proto change that skips the manual regen
  ships a silently stale sidecar. Add a CI step (or test) that runs the
  generator and fails on diff. (Surfaced by the 2026-07-02 quality
  audit, task 30.)

- `[test]` **Five App dom-tests fail under Node 26 — `localStorage`
  undefined in jsdom.** `App.midSessionCreate.dom.test.tsx`,
  `App.renameLockup.dom.test.tsx`, and `App.viewActions.dom.test.tsx`
  fail in `beforeEach` at `localStorage.clear()` ("Cannot read
  properties of undefined") on Node 26.5 + jsdom 29, alongside Node's
  "localStorage is not available because --localstorage-file was not
  provided" ExperimentalWarning — Node's own experimental
  `localStorage` global appears to shadow/suppress jsdom's. Verified
  pre-existing on 2026-07-13 (fails identically against HEAD's
  `App.tsx`); other jsdom suites pass. Fix candidates: stub
  `localStorage` in vitest setup, pass `--localstorage-file`, or pin
  the tested Node version in CI.

- `[ci]` **Server-implementation conformance check.** Every server
  that speaks `cannet-wire` (today: `cannet-server`'s BLF replay and
  virtual-bus modes, `cannet-python-can`; tomorrow: other vendor
  sidecars) is expected to honour the same envelope semantics —
  `ConfigureBus` on the bus / interface they own, exhaustive matches
  on the full envelope set, error-frame round-trip, the response
  shapes `ListInterfaces` / `WatchInterfaces` promise, etc. Today
  this is policed by reading code and remembering. Want a single
  conformance suite (Rust integration test using `cannet-client`)
  that drives a generic checklist against any server endpoint —
  spin the suite against each shipping server in CI so a divergence
  shows up as a test failure rather than at runtime in the GUI.

- `[test-fixtures]` **Vendor python-can BLF fixtures under
  `crates/cannet-blf/tests/fixtures/python-can/`.** Phase 10 Step 1
  listed this as the first of four test sources but
  deferred actual vendoring; today the step's coverage is
  synthetic-bytes per-module tests + the vector_blf oracle
  cross-check (gated behind `vector-blf-oracle`). Adding the
  python-can-written files would give us a third-party-writer
  cross-check that runs without C++ toolchain. ~30 KB binary
  per file, expect ~5 files covering classic / FD / error / mixed
  channels / big payloads.

- `[cleanup]` **`apps/gui/src/plotSolo.ts` is committed with CRLF line
  endings** — the only tracked file whose blob is CRLF (`git ls-files
  --eol` → `i/crlf`); everything else is LF. Benign today (git skips
  renormalizing blobs that already contain CRLF), but it's an
  inconsistency and a trap for tooling that assumes LF. Renormalize to
  LF in a commit of its own; consider a `.gitattributes` (`* text=auto`)
  in the same pass. Noticed 2026-08-16 while root-causing the release
  `-dirty` version stamp (which turned out to be unrelated).

### Trace view

- `[feat]` **Timestamp display mode (absolute / delta), and the ADR
  amendment it needs.** Task 45 Stage 5 listed "CAN-ID and timestamp
  formatting" as a default with no way to change it. The CAN-ID half
  shipped (`can_id_format`); the timestamp half is a feature, not a
  promotion, and was deliberately left. Both alternatives comparable
  tools offer cost real machinery:
  - **Absolute (wall clock).**
    [ADR 0024](../docs/adr/0024-trace-like-view-timing.md) decision 2 says
    every renderer displays `frame.timestamp − session_start` and calls a
    disagreement between two panels a bug. A knob that changed only the
    row tables would create exactly that. Doing it right means *every*
    renderer follows, including the plot's x-axis ticks and cursor
    readouts — whose gutter/split geometry is tuned to elapsed-format
    label widths — plus an amendment to the ADR saying the origin stays
    single while its *rendering* becomes a global choice.
  - **Delta (since the previous row).** A per-row difference is a model
    fact over an adjacent row the paged, event-merged view may not have
    loaded, so it belongs host-side next to the other derived columns
    (CLAUDE.md § thin views), not in the renderer.

  Either is a task, not a settings row. Pick up with the plot's own
  formatting work if that ever lands.
- `[ui]` `cannet-gui`: **bitfield message visualizer**. Render a CAN
  message as its raw bits laid out as a grid (8×N cells, one per bit),
  colored / lit by current value, with DBC-derived signal overlays
  showing which bits belong to which signal and named flag labels for
  single-bit booleans. Most natural as a row-expansion mode in the
  trace view (toggle between the decoded-signal lines and a bit grid),
  or as a small standalone panel for watching one ID's status flags.
  Useful for messages that pack many flags into a byte where the bare
  decoded-signal list is harder to read at a glance.
- `[ui]` trace view (`TraceView.tsx`): under a fast (unlimited-rate)
  stream, scrolling up doesn't reliably leave auto-scroll and a parked
  panel can be yanked back to the live tail — the auto-scroll re-pin
  effect races the async `onAutoScrollDisabled`. (Surfaced during
  Windows stress testing; macOS at moderate rates is fine.) The
  originally-proposed fix — a synchronous "user took control" ref — is
  *not* what the file carries: `TraceView.tsx` instead holds the stored
  anchor inert while `autoScroll` is still true (`const anchor =
  autoScroll ? null : anchoredRow`) plus a `programmaticScrollRef`, so
  the first step when picking this up is re-running the fast-stream
  stress case to see whether the symptom survives that mitigation.
- `[ui]` trace panel (`TracePanel.tsx` / `TraceView.tsx`): the
  scaled-scrollbar virtualizer's interaction model needs a rework — the
  per-pixel resolution gets coarse on huge traces, the wheel-notch
  handling is fiddly, and the auto-scroll re-pin race (separate entry
  above) is a symptom. Decide between a real windowed virtualizer with a
  synthetic-height spacer vs. the current scaled approach, and settle the
  scroll/auto-scroll ownership story, before piling more on it. (Flagged
  while planning Phase 4; doesn't block plotting.)

### Plot panel

- `[bug]` `cannet-gui` `PlotPanel.tsx`: **cursor A/B marker chips and
  the x-axis intermittently don't render.** Reachable state where the
  cursor marker titles/text disappear, and possibly where the x-axis
  itself stops drawing. Not yet reproduced deterministically; likely a
  draw-hook / rebuild timing window in `PlotArea.tsx`'s uPlot
  create/destroy path. Capture the repro before fixing. (Task 32 QA.)
- `[bug]` `signalCatalogContext.tsx`: the `dbc-changed` listener has the
  same attach-gap race `useHostMirror` was built to close (a change
  landing between the snapshot fetch and the async `listen()` attach is
  lost) — inherited from the pre-consolidation panel code. Migrate the
  provider onto `useHostMirror`, or add the post-listener refetch.
  (2026-07-26 task-30 closeout review.)
- `[feat]` **A standing sort for signal lists — the plot signal panel,
  and a generator-keyed sort column in the signal view.** Sorting the
  plot's side list would be nice; maybe difficult with inconsistent
  signal names (owner test drive 2026-08-07). A one-shot "Sort area"
  action ships, keyed by the regex generators, so what is left is a
  sort that *stays* applied — and, in the signal view, a sort column
  on the same derived keys, which needs the generator key in the
  host's sort path. No driving ask yet.
- `[ui]` **Individual y-axis mode can blow up the plot window** — 16
  signals means 16 axes and the panel is basically taken over.
  (Owner test drive 2026-08-07; the collapsible plot areas that have
  since shipped may mitigate.)
### DBC view

- `[ui]` **DBC panel table-tree rework.** The current per-signal detail
  presentation isn't liked — rework the tree into more of a table
  (hierarchy rows + aligned detail columns for factor/offset/range/
  unit/comment, instead of the current detail rendering). Decided
  during Task 20 spec grilling: the signal *value* column ships with
  Task 20 on the existing tree; this item is the presentation rework
  on top.

- `[ui]` **Mux arm membership is invisible outside the Database panel.**
  Task 63 groups a multiplexed message's signals under their arm in the
  Database tree, but the plot panel's signal picker (`list_signals`) and
  the signals view still list them flat — for the BMS service-event
  message that's 46 entries with no clue which of the 9 events each
  rides. Consider carrying the arm label into the picker's entry text.


### Cursors and markers

These are the general event surface governed by the timeline-event model
([ADR 0035](../docs/adr/0035-timeline-event-model.md)) — markers across
every timeseries view, persisted, exported, navigable, eventually a
singleton panel. The disk-spill truncation marker (task 0018) wires the
first non-note kind; the items below are the rest.

Task 0018 landed more of this than just the truncation marker: notes grew a
`kind` + `color`; events **interleave into the chronological trace** by
timestamp (`eventMerge` splices host-anchored events — `frame_indices_at_ns`
— into the windowed frame stream, the truncation marker as the floor row); a
**singleton `EventsPanel`** (command palette → "Show events") is the trace
view rendering only events; and an `EventContextMenu` edits
name/color/remove on any editable event row. Remaining follow-ups:

- `[bug]` **macOS: the event color picker opens in the wrong location.**
  The native color picker for events appears in odd positions on macOS
  (the plot series color picker seems to open correctly, so compare the
  two anchoring paths). Likely a popover/anchor-positioning difference in
  the event color control vs. the plot swatch. (Task 32 QA.)
  **Candidate fix landed (unverified on macOS):** `.trace-event-swatch-input`
  now fills the swatch's real footprint (`inset:0`, no `width/height:0`)
  instead of collapsing to a zero-size point, so the native picker has a
  concrete anchor rect at the swatch. If a Mac confirms this resolves the
  mis-positioning, close the item; if not, revert the CSS and investigate
  the virtualized-row scroll-offset anchor path instead.
- `[ui/feat]` cursor + marker rework.
  - Each cursor-created marker carries an editable description; the
    list UI gets an expand-to-show body on the row, collapsed by
    default, plus a per-marker color picker.
  - Cursors / markers grow into their own top-level view (they are
    global, not per-panel; their lifecycle is similar to project
    view, graph view, system messages). The view shows both BLF
    record types — `GLOBAL_MARKER` and `EVENT_COMMENT` — with
    filtering by record type and by the user-defined event tag (below).
  - Add a "create marker from message" flow: emit an `EVENT_COMMENT`
    whose `commentedEventType` matches the source message
    (`can` / `can-fd`) and whose object timestamp equals the source
    message's, so it tracks with the message per the BLF spec. The
    text field is prefixed `cannet:event:<user-string>\n` to enable
    filtering; the UI strips the prefix and renders just `<user-string>`.
    `<user-string>` is configurable in the UI. Use cases: fault
    detections, contactor open/close, specific commands sent. UI
    design needed for picking the source message and authoring the
    rendered text.
  - `EVENT_COMMENT` markers should be rendered in the graph view,
    when enabled in the filter
  - `GLOBAL_MARKER` and `EVENT_COMMENT` items should appear in 
    historical-mode trace views

### GUI chrome and cross-cutting

- `[feat]` **"Save current layout as my default" is a default
  *project*, not a default layout.** Task 45 Stage 5 listed a seed
  layout among the defaults with no way to change them.
  `seedDefaultLayout` (`App.tsx`) is the hard-coded one — one trace
  element, its panel, and the project panel — and it is genuinely not
  adjustable. Storing a dockview blob does not fix it: every
  content-bearing panel binds to an element by
  `params.elementId`, and the elements are project content (a plot's
  series, an RBS element's file, a filtered trace's predicate). Restore
  a saved layout into an empty registry and `useElementPanel`'s
  `ensure(elementId, kind)` creates each one *empty*, so the layout you
  saved is not the layout you get — the failure is silent and looks
  like data loss. Two shapes, and the second is the one worth having:
  - **Layout-only, with elements synthesised per panel.** Cheapest to
    build and the one described above: panels return, their contents do
    not. Would need the seed to strip or re-key element-bound panels
    and a rule per panel kind for what an empty one means.
  - **A default project template.** A `.cannet_prj` nominated as what
    **New project** starts from — one path-valued setting plus a "Save
    as template" action. The real work is the file-reference story:
    ADR 0030 makes a project's DBC / `.cannet_rbs` references relative
    to *its* directory, so a template instantiated into a different
    project directory has to decide what happens to each reference, and
    ADR 0042 §2 forbids writing into a directory the user did not name.
    Also needs a scope decision (user, surely) and an answer for buses
    and bindings a template names.

  Either is a task with an ADR question in it, not a settings row.
- `[feat]` **A color-blind-safe palette needs a palette set, not a
  setting.** Task 45 Stage 5's palettes item says it outright: *there
  is no global remedy for a color-blind user — per-signal overrides
  only*. Promoting a chooser is blocked on the thing being chosen from:
  - **There is one palette to pick, and it is two palettes, per
    theme.** The wheels moved into the theme layer: each theme in
    `theme.ts` carries a 16-entry `signalWheel` (read through
    `palette.ts`'s `signalWheel()`) and an 8-entry `busWheel` (read
    through `busColor.ts`). A user with a CVD needs both replaced, they
    are sized and used differently, and today the only thing that
    selects a wheel pair is the `theme` setting.
  - **Sixteen distinguishable CVD-safe colors is a design problem, not
    a table.** The canonical safe set (Okabe–Ito) is eight, and
    `palette.test.ts` additionally requires every entry to hold WCAG-AA
    ≥ 4.5:1 against the app background. Whoever picks the set owes both
    properties, verified.
  - **Switching wheels recolors existing work.** `stableSignalColor`
    hashes a signal key onto a wheel slot, and its test pins two known
    keys precisely because *"changing the hash silently recolors every
    non-overridden signal"*. A palette switch is the same event by
    another route, and the per-signal overrides in `signal_colors`
    (project-scoped) do *not* follow it — so a user who has overridden
    anything ends up with a mixture of the two palettes. That
    interaction rule is the design question, and it has to be answered
    before a field is added.
- `[feat]` **UI density / type scale.** Task 45 Stage 5 listed "theme
  and density (dark-only, fixed type scale)" as one item; the theme
  half shipped (the dark / light / lighthk theme menu, 2026-08).
  Density stays here — it fails for its own reason:
  - **A type scale would break the virtualised views.** The rem side
    looks cheap — ~595 rem lengths against ~307 px, most of them 1–4 px
    borders and radii — but the scroll geometry is px in JavaScript:
    `traceViewport.ROW_HEIGHT` (22) drives the trace and signal
    viewports, `SystemMessagesPanel` and `dbcPanelViewport` carry their
    own, and every one of them converts scroll offsets to row indices.
    Grow the rendered rows without those constants and rows overlap,
    scroll extents lie, and the index maths goes wrong. Column widths
    are px integers too — persisted in projects *and* in the
    `trace_columns` / `signal_columns` settings — so text would grow
    inside fixed columns, and `PlotArea.tsx` hard-codes its canvas
    font. Threading a scale through all of that is a design-system
    change.
- `[cleanup]` **The project schema version is declared twice.**
  `PROJECT_SCHEMA_VERSION` is `7` in
  [`project.rs`](../apps/gui/src-tauri/src/project.rs) and `7` in
  [`types.ts`](../apps/gui/src/types.ts); `gatherProject` stamps the TS
  copy into the struct it hands to `save_project`. The host is the side
  that owns the version — `parse_versioned` is its check — so it could
  stamp the field on write and the frontend could drop the constant.
  Task 45's duplicates list carried this as item 6 and closed without
  collapsing it: it is on the project-file write path, not in the
  settings store, so folding it into a settings task would have been
  scope creep. The change is small; the churn is in `Project`'s TS
  shape (`schema_version` becomes optional on the way in) and the
  fixtures that name it.
- `[feat]` **Detect-and-focus when a project is already open.** Task 47
  leaves re-opening an already-open project directory as undefined
  behaviour, because doing it properly needs single-instance /
  inter-window messaging the app does not have. `tauri-plugin-single-
  instance` is the obvious candidate (the app already depends on
  `tauri-plugin-dialog` and `tauri-plugin-window-state`, so it is not a
  new *kind* of dependency), but it answers the per-*process* case — a
  second app launch — and not the per-*project* case where one process
  is asked to open a directory it already holds. Needs an
  `evaluate-dependency` pass and a `technology-inventory.md` entry
  before adoption. Picking this up removes an undefined behaviour, so
  it is worth doing before the project-directory concept is load-bearing
  for many users.

- `[feat]` **Persist the ephemeral view state that still isn't
  persisted.** A reopened session restores the capture and its origin
  (ADR 0002 DS-7 + ADR 0024) but not *where each view was looking*.
  Part of this has since closed by another route: a plot panel's
  `followLive`, cursor mode and cursor placements, and a trace panel's
  `autoScroll` all ride the element's `PanelViewConfig` and come back
  with the project. What is still lost on reopen is the **plot
  x-window** (`winStart` / `winEnd` are not in the panel's `persist`
  call) and every view's **scroll offset** (no `scrollTop` anywhere in
  the project types), so a reopened session lands at the live tail
  rather than where you left it. Decide what to snapshot and where it
  rides (scratch alongside `session_start_ns`, or the project file).
  Surfaced during the plot window-start-origin fix (ADR 0024).

- `[test]` **View-chord interception on macOS / Linux webviews.** The
  view keyboard actions are verified on Windows (WebView2 honours
  `preventDefault` for its browser accelerators). Unverified elsewhere:
  on macOS, Tauri's default app menu may claim `Cmd+W` before the
  webview ever sees the keydown (fix would be removing/rebinding that
  menu item), and `Ctrl+Tab` / `Mod+W` interception is untested in
  WKWebView and WebKitGTK. If a mac/Linux user reports a dead chord,
  this is the diagnosis; verify when hardware is in reach.

- `[bug]` **A keyboard edit right after a drag can amend the drag's
  coalesced undo step.** The stale-gesture close is the next pointer
  press, so the one path still open is a drag whose `pointerup` went
  missing (released off-window) followed by an element edit made
  without touching the pointer at all — pressing `l` over a plot
  (`plot.followLive.enable`, which persists) is the reachable example.
  That edit amends the drag's step instead of making its own. Closing
  it needs a second rule keyed on the keyboard, which has to know not
  to close the rename gesture the user is typing into.

- `[feat]` **Multi-step sequence capture in the shortcuts panel.** The
  keybinding framework parses and dispatches sequence chords (e.g.
  `g r`), and `DEFAULT_BINDINGS` may declare them, but the shortcuts
  panel's chord capture (ADR 0018 / `ShortcutsPanel.tsx`) records only a
  single step — a user can't bind a sequence from the UI. Extend capture
  to buffer multiple steps (with a visible in-progress hint and a commit
  key). Deferred from the shortcuts-editor work.

- `[feat]` `cannet-gui` Save Capture: **time-range export.** Phase 9's
  Save Capture writes the entire session buffer to a `.blf`. Add the
  ability to pick a start and end time (or start/end frame index) on
  the Save Capture dialog so the user can export just a slice rather
  than the whole capture. Cursor pairs in plot or trace panels are a
  natural source for the range — "Save range as BLF…" alongside the
  existing "Save Capture…" action. Frames outside the chosen range
  are skipped; `GLOBAL_MARKER` and `EVENT_COMMENT` records whose
  timestamps fall inside the range come along; the written
  `FileStatistics.measurement_start_time` is the chosen start, not
  the session start.
- `[ui]` **Dock / undock a panel as a separate OS window** (former
  Task 24). Dockview's popout-group support is the natural mechanism;
  needs a Tauri multi-window story (the popout opens a browser window
  today).
- `[bug]` **Plot vs trace divider drag fix** (former Task 24) — the
  divider between the plot area and its trace/event list doesn't drag
  reliably.
- `[ui]` GUI-wide visual restyle: adopt the dark "scope" visual
  language from `plans/plot-panel-reference.html` (the prototype's color
  variables, monospace type scale, panel chrome, control styling) across
  the toolbar, trace panels, project panel, etc. — currently each panel
  has its own ad-hoc styling in `apps/gui/src/index.css`. Approved in
  principle; do it as one deliberate pass once the plot panel's own
  styling has settled, not piecemeal.
- `[ui]` `cannet-gui` project panel: **DBC-to-bus association should
  read as an include list.** Today an empty `DbcRef.buses` means "all
  buses" — the row shows "all buses" with no checkboxes ticked, which
  reads as "this DBC is assigned to nothing." Surface it as an
  explicit include list (all checkboxes ticked = all buses; tick a
  subset to scope down; untick all = decode for no bus). Note: this
  is specific to DBC scoping; it does **not** imply changing the
  other surfaces that default to "every bus" via a wildcard
  (sink/source selectors, transmit fan-out, etc.).

### Graph view (and bus topology)

Items surfaced during the Phase-6.5 default-receive-all / graph-view follow-up
work that haven't been closed out yet. Group them together so the
next pass on this surface can address them as one piece.

- `[ui]` **Bus-like graph topology layout.** Same-lane stacking
  (plot/trace sharing a row counter) is fixed, but the lane scheme
  isn't the bus-rail layout the user wants — gateway at one end of
  each bus, the bus running long horizontally, consumers branching
  off alongside. Reach for a real auto-layout (dagre / elkjs) or a
  hand-rolled "rail per bus" pass; today's `LANE_X`/`LANE_Y_OFFSET`
  in [graphNodeLayout.ts](apps/gui/src/graphNodeLayout.ts)
  is a workable pipeline layout but doesn't read as a bus topology.
- `[ui]` **Drag-to-wire from anywhere on a node body.** Drag-from-
  handle works (xyflow `onConnect` is wired to `addEdgeToRegistry`),
  but the user has to land on the small handle dots. Long-term,
  dragging from a producer node anywhere onto a consumer (no need
  to land on a handle) would be more discoverable.

### Host crates, wire, and sidecar

- `[perf]` **Quitting within ~1 min of a large cold rebuild costs
  ~11 s of synchronous pyramid flush** (drains to ~2.5 s once the
  cadence has idled). Levers identified: raise the idle
  cadence-flush budget, or harden pages as the rebuild writes them.
  Current behavior stands per the owner's shutdown-flush ruling —
  revisit if it bites. (The general exit hang this grew out of was
  fixed — the rebuild no longer holds the model lock, ADR 0048.)
- `[cleanup]` **Sweep task-step-number comments (`6d`, `Step 3`, …) out
  of source.** ~14 sites remain across `cannet-spill` (`filter_index`,
  `byid`, `disk`, `sample_seq`) and host files (`signal_cache`,
  `emitters`, `trace_store`'s flush module), plus a few in
  `cannet-perf-measurement` and two `cannet-blf` `Cargo.toml` headers,
  citing plan-step numbers in comments — the no-plan-refs rule
  (CLAUDE.md § Documentation: source cites ADRs, never `plans/`).
  Most survivors now hang off a stable ADR clause (`ADR 0002 DS-8 /
  6d`), so the sweep is mostly dropping the trailing step number rather
  than reconstructing rationale. One commit, so it doesn't drag.
  A 2026-08-14 re-sweep (task 70, all pre-existing) named more
  phase-number / `plans/` references to fold into the same pass:
  `crates/cannet-blf/Cargo.toml:12,21`,
  `crates/cannet-dbc/src/calc.rs:25`, `crates/cannet-mdf/Cargo.toml:13`,
  `crates/cannet-server/src/auth.rs:42`,
  `apps/gui/src/index.css:1136,3992`,
  `apps/gui/src/DatabasePanel.tsx:263`,
  `apps/gui/src-tauri/src/tests.rs:1907`, and several under
  `servers/cannet-python-can/`.
- `[idea]` `cannet-gui` disk-spill eviction (task 0018 Step 6): **pin
  note-bearing regions against eviction.** The windowed-ring cap drops the
  oldest frames purely by age; a section the user annotated with a note is
  evicted like any other. Preserve a window around each user note — don't
  drop segments within `±N` seconds of a note's timestamp — so the frames a
  marker refers to survive even as older unannotated history is trimmed.
  Needs the eviction mark computation to consult the (timestamp-keyed) note
  set and skip / fragment the trimmed range around pinned spans; the mark
  stops being a single monotonic floor (it becomes a set of live ranges),
  so weigh that complexity against the benefit. Deferred from Step 6 — the
  base cap evicts by age only; notes are kept but may dangle below the floor.
- `[bug]` `cannet-gui` disk-spill scratch: **two app instances open the
  same project's cache and stomp it.** Nothing arbitrates exclusive
  ownership of a cache directory. [ADR 0002
  DS-7](../docs/adr/0002-disk-spill-store.md)'s `project_id` identity
  gate decides what a launch *reloads*, but it does not stop a second
  concurrent instance from opening the same dir and appending/clearing
  into the same segment files as the first — mutual corruption (and a
  second instance's capture silently destroys the first's reloadable
  session). ADR 0042 §4 narrowed the blast radius: the scratch is no
  longer one fixed `current/` dir but a per-project cache dir under the
  app cache root, keyed by a uuid-v5 hash of the project directory, so
  the collision is now specifically *two instances on the same project*.
  Options: an OS advisory lock / lockfile in the cache dir taken at boot
  (second instance falls back to a per-pid dir, or refuses, or runs
  RAM-only), or a per-instance subdir keyed by pid with the identity
  gate scanning siblings. Decide the contract (single-instance-wins vs.
  multi-instance-isolated) when picking up.
- `[bug]` `cannet-gui` BLF ingest: **root panic behind the 2026-07-10
  poisoned-mutex crash is still unidentified.** A third-party
  (TSMaster-written) BLF panicked the ingest path mid-append (file not
  available for repro). The mitigation shipped (former Task 34):
  `trace_store.rs` recovers poisoned mutexes, and the BLF pump wraps
  `run_pump` in `catch_unwind` so the next hostile BLF surfaces "load
  failed: \<panic message\>" in the UI and lands the message + backtrace
  in `cannet.log`. When that log appears, file the repro/fix follow-up
  against the named panic site.

- `[bug]` `cannet-python-can` / upstream: **PEAK macOS PCBUSB hands
  python-can garbage classic-CAN timestamps** — observed 2026-07-13: a
  hardware frame carried `msg.timestamp ≈ 239723374713.5 s`
  (~year 9570), deterministically on every connect (python-can 4.6.1,
  PCAN-USB on macOS). The sidecar now sanitizes at the driver boundary
  (`_TS_PLAUSIBLE_SLACK_S` in driver_python_can.py) so this no longer
  kills the frame stream, but the upstream cause is uncharacterized —
  likely python-can's `TPCANTimestamp` struct math vs what PCBUSB
  actually returns (the magnitude suggests garbage in
  `millis_overflow`). With hardware attached, dump raw
  `millis`/`millis_overflow`/`micros` per frame, identify the
  mechanism, and file against python-can and/or mac-can PCBUSB.

- `[ui]` `cannet-python-can` sidecar: **two sources of scary-but-benign
  log noise.** (1) Closing a Vector channel while `_rx_pump` is blocked
  in `ch.recv` logs a WARN `xlReceive failed (XL_ERROR)` System Message
  on every disconnect — teardown, not a fault; detect the closing state
  (or close the channel only after the pump exits). (2) Startup
  enumeration imports every python-can hardware backend, and each
  missing vendor lib logs a WARNING that trips the panel's default Warn
  filter (`vxlapi64 not found`, `Kvaser canlib is unavailable`) — add a
  `logging.Filter` on the root handler demoting `can.interfaces.vector`
  / `.kvaser` import noise to INFO so the breadcrumb survives below the
  panel's default filter. Test with synthesized `LogRecord`s.
- `[perf]` `cannet-gui` `save_capture` **materializes the entire capture in
  RAM** (`capture.rs`: `state.trace_store.slice(0, len())` into one
  `Vec`, handed whole to `write_capture`), under a comment saying "which
  we'll revisit when disk-spill lands" — disk-spill has landed (ADR
  0002; windowed-ring eviction shipped), so saving a large spilled
  capture now defeats the spill. Stream the write in chunks off the
  store's paged read path instead. (2026-07-02 audit.)
- `[perf]` `cannet-python-can` server: **TX hot path re-resolves the
  interface through the registry per frame** (`server/service.py`'s
  per-frame `self._registry.transmit(...)` → a locked dict lookup in
  `server/shared_interface.py`, then the interface lock again inside
  `_SharedInterface.transmit`) even though the session already knows
  which interfaces it holds — two lock acquisitions plus a dict lookup
  per frame on the highest-rate path. Cache the handle on the session.
  (The pump around it has since changed — TX enqueues to a bounded
  per-interface queue drained by a `_tx_pump` thread — but the
  per-frame resolution is unchanged.) (2026-07-02 audit.)
- `[feat]` `cannet-server` (Phase 2+): multi-client support. Phase 2 is
  single-client per server; a second connection is rejected with
  `Error::BUSY`. Lift this when there's a real use case (e.g. a second
  GUI session or a CI watcher tailing alongside a developer): server
  fans out received frames to all connected clients, and arbitrates /
  interleaves transmits on the same interface from multiple clients.
- `[wire]` `cannet-wire` `Subscribe`: per-interface bus speed / FD
  config (`bitrate_bps`, `data_bitrate_bps`, `fd`, `listen_only`)
  travelling with the subscription. Phase 8 ships the sidecar adapter
  with a typed `open(bitrate, fd)` slot but the wire `Subscribe`
  envelope still carries only `interface_id` — the host applies a
  per-interface configuration locally before subscribing. Promote
  these to the wire so a transmit on a listen-only interface can
  surface `TX_REJECTED` from the sidecar without a round-trip
  config call, and so the BLF replay server can advertise the
  bitrate the BLF was captured at. Additive proto change.
- `[feat]` `cannet-gui` host: bridge wire-level `LogMessage` envelopes
  from an active sidecar Session stream into the System Messages bus.
  Only the process-level bridge is live (stdout / stderr / exit-code →
  System Messages tagged `sidecar:python-can`); in-band `LogMessage`
  envelopes never arrive, so a vendor SDK warning surfaced mid-session
  reaches the user only if the sidecar also `print`s it. Both ends of
  the wiring exist and neither is connected: the sidecar emits them,
  and the host has `system_log.rs`'s `bridge_wire_log` — which has no
  production caller, because `cannet-client`'s rx loop drops
  `Body::Log(_)` on the floor "for the GUI host to bridge". Picking
  this up is surfacing the log body out of the client and calling the
  function that is already written and tested.
- `[security]` **The loopback sidecar link is unauthenticated for any
  local user.** The GUI's (and production server's) supervised sidecar
  listens on loopback plaintext with no token, so any local user on
  the machine can drive the CAN hardware through it. Pre-existing,
  explicitly outside ADR 0041's scope (its boundary is the server's
  public endpoint), but it is the same actuation risk that ADR's
  threat model names — flagged by the Task 42 plan review (N22).
  Options when picked up: pass a one-shot token via the sidecar's
  stdin/env at spawn, or a Unix-socket/named-pipe transport.
- `[feat]` Linux `vcan` via socketcan as a writable CAN source. An
  actual local virtual-bus device on Linux is the honest follow-up to
  the in-process virtual bus. Reconsider alongside future hardware
  work — PEAK's Linux kernel driver path could go via socketcan too.

- `[test]` **Phase 13 live / hardware sign-off (deferred from the Phase 13
  exit criteria).** The virtual-bus + bridge surface is code-complete and
  covered by unit / integration tests, but three exit criteria need a live
  run and were deferred here for an ad-hoc verify-and-bugfix pass rather
  than blocking the phase:
  - **Bridge configs end-to-end** via
    [`servers/cannet-python-can/SMOKE.md`](../servers/cannet-python-can/SMOKE.md):
    passive monitor (physical Rx on allocated participants, allocated TX
    not forwarded), full bidirectional bridge against real hardware, and
    the cross-server / CAN-over-IP gateway (Server A bridges Server B's
    `virtual:bus0` factory).
  - **Two GUIs, one virtual-bus server**: each subscribes, receives a
    distinct allocated id, and sees the other's transmissions as Rx.
  - **Frame timing**: a 500 kbps bus measurably staggers sustained
    fan-out by the computed frame duration (back-to-back frames don't
    collapse to one timestamp).
  Fold into the CI server-conformance suite above, or run as a focused
  pass, once a rig is available.
  - **Task 14 RBS test matrix, live legs.** The RBS exit criteria's
    send matrix (Tx rows with fields filled in over `local-virtual-bus`,
    hardware (sidecar) interfaces, and FD frames) is covered at the
    model layer by `rbs.rs` / `transmit_frames.rs` unit tests; the
    hardware-interface leg and an end-to-end FD-on-wire run need the
    same rig as the rest of this sign-off pass.

### Packaging and naming

- `[docs]` **Complete the third-party attribution the license manifest
  under-counts.** `scripts/gen-licenses.py` populates only the
  `python-can sidecar` component and, within it, reads only the five
  Python packages' `dist-info` LICENSEs (ADR 0036). Three gaps, in
  priority order:
  1. **The GUI's own dependencies** — the Rust host crates (via
     `cargo-about`) and the frontend npm packages (via `pnpm licenses
     list --json`), added as their own manifest components.
  2. **Native libraries bundled *inside* the frozen sidecar** that the
     dist-info reader misses. The onedir also ships **OpenSSL**
     (`libcrypto-3`/`libssl-3`, Apache-2.0), **libffi**, and **Expat**
     (`pyexpat`), whose notices are *not* in CPython's bundled
     `LICENSE.txt` (verified) and are *not* on disk in the uv interpreter
     install — so they need small **committed canonical license assets**
     (a deliberate, narrow exception to "don't commit texts," since they
     can't be generated from build inputs). SQLite (`sqlite3.dll`) is
     public-domain — optional. Already covered, no action: **bzip2** and
     **Zstandard** (in CPython's LICENSE) and grpcio's static
     **BoringSSL / abseil / c-ares** (in grpcio's own LICENSE).
  3. Add the **GPL-3.0 supplement** to python-can's LGPL notice (the dep
     ships only the LGPL text, which incorporates the GPL by reference).

  Not an OSS-notice item: the **MS VC++ / UCRT runtime** (`VCRUNTIME140*`,
  `ucrtbase`, `api-ms-win-*`) is redistributed in the sidecar onedir but
  under Microsoft's redistributable terms, which permit app-local
  bundling and carry no attribution obligation — nothing to add to the
  manifest. Why: the About view is the runtime attribution surface, and
  today it under-attributes what cannet actually redistributes.

- `[feat]` **Code signing, notarization, and auto-update.** Deferred
  from the distribution work (former Task 26) so the alpha isn't
  blocked on procurement: macOS needs an Apple Developer Program
  membership ($99/yr) + notarization; Windows an OV/EV cert or Azure
  Trusted Signing — wiring is straightforward once the secrets exist
  (`tauri-action` takes the signing env vars). Auto-update
  (`tauri-plugin-updater`) additionally needs an update keypair and a
  release feed; until then users download manually and click through
  Gatekeeper/SmartScreen warnings.

- `[sidecar]` **Configurable sidecar entrypoint path(s).** The host
  resolves the sidecar *launcher* by fixed probe order (frozen binary
  next to the GUI exe, then `uv`/`python3` dev paths) in
  [`apps/gui/src-tauri/src/sidecar.rs`](apps/gui/src-tauri/src/sidecar.rs).
  The overrides that exist point at the sidecar *package* directory
  (`CANNET_SIDECAR_DIR` / the `sidecar_dir` setting, env winning) and
  at the driver module (`CANNET_DRIVER_MODULE` / `driver_module`) —
  the launcher binary itself is still not overridable. Add an override
  (env var and/or setting) that points cannet at a user-chosen
  sidecar executable. Reinforces the LGPL §4 replace story (see
  [`servers/cannet-python-can/LICENSING.md`](../servers/cannet-python-can/LICENSING.md)):
  a user who swaps in a modified sidecar / `python-can` can point cannet
  straight at it instead of editing files inside the frozen onedir.

- `[dev]` **Dev server port is fixed, blocking concurrent `tauri dev`
  instances.** The Vite dev port lives in two places that must agree:
  [`apps/gui/vite.config.ts`](apps/gui/vite.config.ts) pins
  `port: 5173, strictPort: true` (hard-fails on a busy port rather than
  moving up) and [`apps/gui/src-tauri/tauri.conf.json`](apps/gui/src-tauri/tauri.conf.json)
  `devUrl` is statically `http://localhost:5173`. So a stale Vite
  server wedges dev, and two `tauri dev` sessions can't coexist (the
  symptom that surfaced this: a leaked `node.exe` holding 5173). Make
  the port env-driven across both sides — Vite reads
  `CANNET_DEV_PORT` (default 5173), plus a `dev:alt` script that runs a
  second instance on another port with a matching `tauri dev --config`
  `devUrl` override. Dev-mode only: the built app loads bundled assets
  (no 5173), so production multi-instance is unaffected — the real
  multi-instance blocker there is the shared `current/` scratch dir
  (see the disk-spill scratch item under *Host crates*). Lower
  priority: `cannet-server`'s `--bind` default
  `127.0.0.1:50051` is a fixed *default* (already overridable by flag);
  consider an ephemeral default so two standalone servers don't collide
  out of the box.

- `[cannet-blf]` **A single-`LOG_CONTAINER` BLF inflates its whole
  payload into memory at once.** Some writers emit the entire log as
  one container (observed: a 465 MB file = 1 container of 465,623,864
  bytes, vs. a normal file's ~1400 containers averaging ~24 KB). The
  reader ([`crates/cannet-blf/src/format/reader.rs`](crates/cannet-blf/src/format/reader.rs)
  `pull_one_container`) inflates a container fully into the `tail`
  carry-over buffer before decoding objects, so such a file holds
  hundreds of MB transiently. The per-object quadratic drain that made
  these files effectively un-loadable is fixed (offset-based `tail`
  consumption); this remaining item is the memory spike. If it bites,
  stream-inflate the container body in bounded chunks rather than
  materialising the whole uncompressed payload.

- `[cannet-gui]` **Connect while already connected spins an error
  loop.** Clicking Connect (or `--connect-on-start` racing the
  project's auto-connect) with a live session to the same address
  produces a ~1/s retry cycle - `already connected` ERROR status,
  `session ended`, reconnect - and each attempt pushes a ConfigureBus
  the sidecar fails to apply (`reconfigure ... failed: open pcan ...`,
  channel held by the live session). Traffic survives on the original
  session but the status UI churns red and each successful re-connect
  wipes the capture scratch. Observed repeatedly 2026-07-25 (19:24,
  19:40, 00:47 UTC). Connect-when-connected should be a no-op (or a
  clean reconnect), and the ConfigureBus push should not fire on a
  rejected duplicate session.

- `[cannet-gui]` **`list_dbc_content` ships the whole DBC tree over
  IPC.** The command serialises every loaded DBC's full message/signal
  tree (~5 MB on the reference 5-DBC project), and the DBC panel
  re-pulls all of it on every `dbc-changed` event and every bus/scope
  edit ([`apps/gui/src/DatabasePanel.tsx`](apps/gui/src/DatabasePanel.tsx)
  `refreshContent`). The DBC-panel rework that surfaced this ruled it
  explicitly out of scope — the layout cliff it was chasing was
  DOM-side and is fixed — but the
  payload is still the largest single round-trip in the app and the
  panel still holds the whole tree in frontend state. If it bites,
  page `list_dbc_content` the way the trace and signal views are paged
  (host-side flatten + row window) rather than shipping the tree.

- `[cannet-gui]` **Min/max decimation buckets by slice index, not
  time.** `decimate_min_max` splits the fetched slice into
  `n.div_ceil(max_buckets)` index runs
  ([`apps/gui/src-tauri/src/signal_sampler.rs`](apps/gui/src-tauri/src/signal_sampler.rs)),
  so every fetch re-buckets: `n` changes and slice element 0 moves as the
  window slides, shifting every bucket boundary at once and re-picking
  each bucket's argmin/argmax. The rendered envelope therefore redraws
  differently each fetch even where the underlying data is unchanged.
  Investigated 2026-07-28 as a suspect for leading-edge flicker and
  *ruled out* for that symptom (the flicker scaled with pixels-per-sample
  and survived below the decimation threshold), but the re-bucketing is
  real and would show as interior shimmer. Fix is time-anchored buckets:
  bucket `k` = `[from + k·Δ, from + (k+1)·Δ)` with `from` quantised to a
  multiple of `Δ`, so a sample always lands in the same bucket.

- `[cannet-gui / cannet-spill]` **Frames may be stored out of timestamp
  order, and `frame_index_at_ns` assumes they aren't.** Established
  2026-07-30 from a 23-hour two-bus PCAN capture: the health log's
  `buffer_s` deltas over 39 samples were `+1.1 x21`, `-1.1 x9`,
  `+3.3 x5`, `+3.4 x2`, `+3.2 x2` — a +-1.1 s wobble (occasionally
  2.2 s) on a quantity that can only be monotonic if its endpoints are.
  The buses' deliveries interleave, so the last-appended frame is
  routinely not the newest.

  The *reporting* half is fixed: the store keeps a running max
  (`RawStore::max_ts`), `first_last_ts` and `sample_signals` use it, so
  `buffer_seconds`, the status line and the plot's follow-live edge are
  monotonic again.

  What is left is whether the underlying frame order is really
  interleaved or the dip was only an artefact of reading index
  `len - 1`. It matters because `frame_index_at_ns` binary-searches
  `[first_index, len)` assuming ascending timestamps (ADR 0024's
  time-index mapping): if frames genuinely are out of order, goto-time
  and the truncation marker are subtly wrong too, and so is the
  per-signal cache's `t_seconds` binary search on the legacy
  `bus_id: None` "any bus" path (the bus-scoped path is safe, since one
  bus's frames arrive in order). Settle it by instrumenting the pump for
  a non-monotonic append; if real, the fix is ordering the multi-bus
  merge, not patching the searches.

- `[cannet-gui]` **Turning auto-scroll off spins TracePanel and TraceView
  in a render loop.** Observed 2026-08-02 while adding the live-tail
  demand test (Task 44 Tier 2 #4): in `TracePanel.dom.test.tsx`, clicking
  the auto-scroll checkbox on an unfiltered chronological panel over a
  100-frame window makes `render.TracePanel` and `render.TraceView` climb
  in lockstep at roughly 2500 each per burst until the vitest worker is
  killed. **Predates the change** — reproduced against `HEAD` with the
  demand hook removed, so it is not the hook. Whether it reproduces in a
  real browser is untested: the harness's `ResizeObserver` never fires,
  so `TraceView` measures a zero-height viewport, and the loop may be
  that measurement disagreeing with the virtualiser's `ensureVisible`.
  Either way a toggle should settle. The live-tail withdrawal is
  therefore covered through the mode switch rather than this toggle;
  restore the tighter test once the loop is fixed.

- `[cannet-gui]` **New Project does not re-root the session.** Opening a
  project and Save As both move the session onto the right project
  directory (ADR 0042 §1), but **New Project** — which has no host
  command of its own; the frontend just clears everything — leaves the
  session rooted in the *previous* project's directory. So a capture
  taken in a new, unsaved project lands in the last project's cache, and
  the `resetSession` that New runs clears that project's scratch. Both
  are the pre-existing single-scratch behaviour rather than a
  regression, which is why it was left. The fix is a host command that
  re-roots onto the unsaved auto-located directory
  (`project_dir::resolve(None, cache_root)`) with `Carry::Nothing`,
  which is a small thing once there is a New Project command at all.

- `[cannet-gui]` **The settings view shows a value's scope but cannot
  change it.** Task 46's panel marks a setting the open project
  overrides (`get_settings_overrides`) so the scope of every value is
  visible, but there is no way to *move* a value between the user and
  workspace files — the design prototype's scope tabs and its "Set for
  this project…" action. That needs per-scope read and write commands,
  and it changes the premise `persisted_json::Scope::UserOverridable`
  was built on ("there is no UI for choosing a scope, so leave the value
  where it already is"). Worth doing once projects have settings worth
  moving — i.e. alongside Task 45's promotions — rather than now, when
  three keys are overridable and none is by default.

- **Colormap wishes.** Three related asks, all "would be nice", none
  urgent, and probably one design rather than three: colormaps that
  apply across a *selection* of signals sharing a type instead of being
  bound one signal at a time; single-value colormaps (an SNA sentinel
  being the motivating case); and gradient colormaps rather than
  discrete bands. ADR 0029 governs the colormap model, so a design here
  starts there.

- **The window hangs or stops rendering after sitting live — needs a
  reproduction.** Observed while scrolling up in the by-ID trace panel
  after the app had been live for a while. **RDP was present**, and a
  remote-desktop compositor is a plausible participant in a WebView
  repaint stall, so the first question is whether it reproduces in a
  local session at all — that single observation decides whether this is
  our bug. Parked here rather than scheduled because nobody can act on
  it until someone reproduces it. Carried out of task 48.

### Task 51–53 carry-forwards (2026-08-06)

Follow-ups recorded in the task 51–53 status logs (now in git
history) at implementation review. Grouped here as one block for the
next planning pass.

- `[feat]` **Gridview deferred set** (task 51 D-decisions): plot
  signal side-list and project-panel element-list migrations onto the
  layer; host-side fuzzy search for the paged views; type-ahead
  search; keyboard multiselect beyond Shift+arrows (Shift+Up/Down
  range extension shipped 2026-08-08 — ADR 0044; Ctrl+arrows /
  Ctrl+Space remain out); branch-with-content affordance.
- `[feat]` **Host id↔ref resolution for paged selections.** Ctrl+A
  and multi-row drag in the paged views (chrono/by-ID/signal) cover
  only the loaded page; a cursor scrolled out of a paged window
  restarts at row 0. Both want a host command resolving row ids
  beyond the page.
- `[feat]` **`ConfigureBus` acknowledgement needs a wire-model
  decision (ADR).** "What the driver actually applied" exists
  nowhere: ADR 0022 is fire-and-forget, the client rx loop drops
  inbound control frames. The project-panel echo shows host-truth,
  labelled as such. Related missing capability: editing a bitrate
  while connected applies nothing (now legible as a `pending` chip,
  still inert).
- `[fix]` **Per-channel failure isolation gaps.** Sidecar
  `_handle_subscribe` catches only `KeyError`/`OSError` — a
  replacement driver letting `can.CanInitializationError` escape
  kills the session, not the channel. Host-side,
  `is_per_frame_error_code` treats `UNKNOWN_INTERFACE` as fatal, so
  a server-side channel refusal can down sibling channels.
- `[chore]` **Perf-harness scenario debts.** The startup splash now
  covers the first ≥5 s of every ADR-0031 run; the chrono trace is
  hidden behind the by-ID tab in the stock gate scenario (a
  chrono-visible variant exists from the task-51 heap work).
  Added 2026-08-14 (task-63 phase 6): the `scrub` warm-up's 93×
  zoom-in lands the plot at a ~0.05 s window on self-driving
  captures, so **no committed capture has ever measured the plot at
  a realistic follow window** (the follow-window defect is fixed;
  this is purely the scenario's zoom target). Fixing the warm-up
  changes the workload and therefore requires a deliberate
  re-baseline in the same change.
  Changing the gate scenario is a baseline decision — take it
  deliberately.
  Owner note 2026-08-16 on how to measure the wide-window regime
  without hours of wall clock (the 5400 s live run this grew out of
  measured longtask 95 ms/s / jank 0.44 vs ~0 at a 10 s window —
  superlinear somewhere past 300 s): **generate a BLF spanning hours
  of timestamps and import it** — the window-width cost is a property
  of the data's span, not elapsed time, so import + Fit Data
  reproduces it in minutes. For the live-edge half, seed with the
  generated file and attach the vbus rig for a short live tail; only
  real-time *currency* measurements need real elapsed time.
- `[feat]` **DBC-carried generator rules (`Cannet*` database-level
  `BA_`).** The shipped regex generators store their rules
  project-side; the
  DBC-carried form — so a BMS DBC ships its own `/Cell(\d+)/`
  coloration to anyone who opens it — is deferred, not rejected.
  Confirmed feasible with zero library work: `can-dbc` already
  parses database-scope `BA_ "Name" "value";` into
  `attribute_values_database`, which `parse.rs` never reads. Open
  design point: encoding several rules in one STRING value (one
  value per attribute name at database scope; ADR 0043 rules out
  JSON-in-STRING). (Owner, task-56 grooming 2026-08-07.)
