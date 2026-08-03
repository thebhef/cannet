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

### High priority

Near-term work — fold these into a phase before picking up the
lower-priority follow-ups below. The original "Minimum Usability
Tasks" list shipped across **Task 11** (transmit signals),
**Task 12** (DBC view + drag/drop), **Task 15** (plot
refinements), and **Task 16** (hotkey framework).

- takes a long time to exit gracefully

#### Other near-term work

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

### CI / checks

Static and automated checks we'd like running on the repo to catch a
class of bug before it ships, rather than relying on the next user to
trip over it.

- `[ci]` **Verify the release workflow produces installable bundles.**
  Task 26 stood up `release.yml` (manual `workflow_dispatch` → draft
  pre-release with macOS arm64 `.dmg` + Windows x64 `.msi`/NSIS), but
  it has never been dispatched — its "produces installers" and
  "version shows in the title bar" exit criteria are unverified. Run
  it once and confirm the artifacts install and launch before relying
  on it for the alpha.

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
  coloured / lit by current value, with DBC-derived signal overlays
  showing which bits belong to which signal and named flag labels for
  single-bit booleans. Most natural as a row-expansion mode in the
  trace view (toggle between the decoded-signal lines and a bit grid),
  or as a small standalone panel for watching one ID's status flags.
  Useful for messages that pack many flags into a byte where the bare
  decoded-signal list is harder to read at a glance.
- `[ui]` trace view (`TraceView.tsx`): under a fast (unlimited-rate)
  stream, scrolling up doesn't reliably leave auto-scroll and a parked
  panel can be yanked back to the live tail — the auto-scroll re-pin
  effect races the async `onAutoScrollDisabled`. Fix: a synchronous
  "user took control" ref that gates the re-pin / pin-to-tail effects
  until the parent's `autoScroll` flips. (Surfaced during Windows
  stress testing; macOS at moderate rates is fine.)
- `[ui]` trace panel (`TracePanel.tsx` / `TraceView.tsx`): the
  scaled-scrollbar virtualizer's interaction model needs a rework — the
  per-pixel resolution gets coarse on huge traces, the wheel-notch
  handling is fiddly, and the auto-scroll re-pin race (separate entry
  above) is a symptom. Decide between a real windowed virtualizer with a
  synthetic-height spacer vs. the current scaled approach, and settle the
  scroll/auto-scroll ownership story, before piling more on it. (Flagged
  while planning Phase 4; doesn't block plotting.)

### Plot panel

- `[perf]` `cannet-gui` `PlotPanel.tsx` / `scrollJank.ts`: **the
  follow-live window advances with ~2–3 ms of timing error per step.**
  Measured, not diagnosed — Task 44 Tier 0's job was the measurement.
  Two release captures (`2026-08-03-e0b83f9-release-resting` and
  `-release-follow`): the window's rate of advance deviates by ~6.5–7 %
  of the scroll rate at *both* a 24.2 s and a 0.7 s window, i.e. the
  error is fixed in time (~1.8 ms/step at 28 ms cadence, ~3.4 ms/step at
  49 ms). Invisible when zoomed out (0.12 px) and ~7 px mean / 30 px
  worst when zoomed in, because pixels-per-second scales with the zoom.
  Candidates, none tested: `advanceLiveEdge`'s EMA pull toward the data
  edge injects a correction that varies with arrival jitter; the slide
  is armed by a resample rather than by a frame, so its cadence
  inherits the fetch loop's jitter. Worth an experiment before any
  change — the numbers to move are `scroll_jank_px` at a *fixed* zoom.
- `[perf]` **Nothing pins the plot's x-window width for a measurement
  run.** `winw` read 170.4 s, 24.2 s and 0.7 s across ADR-0031 captures
  of the same project, because the saved panel config carries whatever
  the window was last left at. That is why the scroll-smoothness gauges
  cannot be gated (Task 44 Tier 0 § 3): two runs are two different
  experiments. A capture flag or a scenario-fixed window would make
  them gateable.
- `[ui]` `cannet-gui` `PlotPanel.tsx`: **a hidden enum keeps its lane
  band within a still-visible enum-lanes axis.** The fully-hidden-axis
  case is done — a derived axis whose signals are *all* hidden now
  collapses (`.plot-area.collapsed`: canvas dropped, excluded from the
  fit-to-panel distribution, rows kept in the side panel), covering both
  numeric and enum-lanes axes. Residual: when only *some* enums on a
  lanes axis are hidden, the visible lanes don't reclaim the hidden
  ones' bands. `visibleLaneBands`-style layout (bands over the visible
  count) fixes the geometry, but the tile draw hook captures
  construction-time `signals` and toggling `hidden` doesn't rebuild the
  uPlot instance (`signalSetKey` excludes hidden), so a live per-lane
  re-flow needs a `signalsRef` threaded into the draw hook. (Task 32 QA.)
- `[bug]` `cannet-gui` `PlotPanel.tsx`: **cursor A/B marker chips and
  the x-axis intermittently don't render.** Reachable state where the
  cursor marker titles/text disappear, and possibly where the x-axis
  itself stops drawing. Not yet reproduced deterministically; likely a
  draw-hook / rebuild timing window (relates to the uPlot-staleness bug
  below). Capture the repro before fixing. (Task 32 QA.)
- `[bug]` `cannet-gui` plot panel: **uncaught uPlot TypeError after
  dev reload while streaming.** Seen during the rename-lockup
  investigation: `Uncaught TypeError: object null is not iterable` at
  `drawAxesGrid` (uPlot `_commit`) right after a dev-server reload
  mid-capture, alongside Tauri "couldn't find callback" warnings.
  Looks like a draw on a destroyed / rebuilt instance. Reproduce and
  guard (likely a `uplotRef.current` staleness window in
  `PlotPanel.tsx`'s create/destroy effect).
  **2026-07-25 update:** the null is `axis._found` destructured in
  `drawAxesGrid` — a shown axis drawn without axis-calc. Deterministic
  trigger found and removed (StrictMode double boot-open storming
  dbc-changed mid-stream; fixed by `bootOpenRanRef`), but the draw
  itself is still unguarded — a dbc-refresh storm or reload mid-stream
  can still reach it, and one throw in an effect unmounts the whole
  React root (blank app). Guard the draw path when picked up.

- `[bug]` `signalCatalogContext.tsx`: the `dbc-changed` listener has the
  same attach-gap race `useHostMirror` was built to close (a change
  landing between the snapshot fetch and the async `listen()` attach is
  lost) — inherited from the pre-consolidation panel code. Migrate the
  provider onto `useHostMirror`, or add the post-listener refetch.
  (2026-07-26 task-30 closeout review.)
- `[cleanup]` `PlotPanel.tsx:1077` contains two **raw NUL bytes**
  (`a.path.join` on a literal 0x00 separator, not the escape), so
  ripgrep classifies the file as binary and content search skips it.
  Replace with `\u0000` escapes. Pre-existing, surfaced 2026-07-26.

### DBC view

- `[ui]` **DBC panel table-tree rework.** The current per-signal detail
  presentation isn't liked — rework the tree into more of a table
  (hierarchy rows + aligned detail columns for factor/offset/range/
  unit/comment, instead of the current detail rendering). Decided
  during Task 20 spec grilling: the signal *value* column ships with
  Task 20 on the existing tree; this item is the presentation rework
  on top.

- `[perf]` `cannet-gui` `DbcPanel.tsx`: **window the flat row list if
  broad filters prove janky.** The task-33 rework bounds a filtered
  render by the match set and the unfiltered tree by the expanded set,
  but a broad query (e.g. "bms" over `examples/ev-zonal` → ~1.3k
  matches) or a deliberate expand-all still renders every matching row.
  `buildRows` already yields a flat `RenderRow[]`, so viewport
  windowing is a render-only change. Measure first — no jank observed
  at ev-zonal scale so far.

### Transmit panel

- `[perf]` `cannet-gui` `run_transmit_scheduler`: per-bus
  `FrameBatch` batching. The scheduler currently fires each due
  message through `transmit_frame_inner` individually (one
  trace-append + one wire `FrameBatch` of one frame each). When many
  messages on the same bus come due in the same tick they could be
  coalesced into one `FrameBatch` (the wire protocol's
  `FrameBatch.frames` is already a `Vec`) and one bulk trace append —
  cutting per-frame gRPC encode/framing overhead at high aggregate
  rates. Deferred: the `bench_tx_*` numbers (≈828k frames/s
  single-threaded) show this isn't needed to hit the current target
  (arbitrarily many 5–10 ms messages across buses). Pick up if a
  future use case pushes aggregate rates toward bus saturation.

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
name/colour/remove on any editable event row. Remaining follow-ups:

- `[ui]` **Colour editing on the plot's own event list** (`EventLogRow` in
  `PlotPanel`). The trace + events panel have it; the plot's note list still
  only renames/removes. Add a colour swatch there for parity (the host
  `recolor_note` command + `recolorNote` context dispatcher already exist).
- `[bug]` **macOS: the event colour picker opens in the wrong location.**
  The native colour picker for events appears in odd positions on macOS
  (the plot series colour picker seems to open correctly, so compare the
  two anchoring paths). Likely a popover/anchor-positioning difference in
  the event colour control vs. the plot swatch. (Task 32 QA.)
  **Candidate fix landed (unverified on macOS):** `.trace-event-swatch-input`
  now fills the swatch's real footprint (`inset:0`, no `width/height:0`)
  instead of collapsing to a zero-size point, so the native picker has a
  concrete anchor rect at the swatch. If a Mac confirms this resolves the
  mis-positioning, close the item; if not, revert the CSS and investigate
  the virtualized-row scroll-offset anchor path instead.
- `[feat]` **Interleave events into the *filtered* chronological trace.** The
  unfiltered view interleaves; a filtered view pages its own (filtered) index
  space, which the raw-frame anchors don't map to — events would need
  filtered-position anchors.
- `[ui/feat]` cursor + marker rework.
  - Each cursor-created marker carries an editable description; the
    list UI gets an expand-to-show body on the row, collapsed by
    default, plus a per-marker colour picker.
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
- `[feat]` **A colour-blind-safe palette needs a palette set, not a
  setting.** Task 45 Stage 5's palettes item says it outright: *there
  is no global remedy for a colour-blind user — per-signal overrides
  only*. Promoting a chooser is blocked on the thing being chosen from:
  - **There is one palette to pick, and it is two palettes.**
    `palette.ts`'s `SIGNAL_WHEEL` is 16 colours; `busColor.ts`'s
    `BUS_COLORS` is 8. A user with a CVD needs both replaced, and they
    are sized and used differently.
  - **Sixteen distinguishable CVD-safe colours is a design problem, not
    a table.** The canonical safe set (Okabe–Ito) is eight, and
    `palette.test.ts` additionally requires every entry to hold WCAG-AA
    ≥ 4.5:1 against the app background. Whoever picks the set owes both
    properties, verified.
  - **Switching wheels recolours existing work.** `stableSignalColor`
    hashes a signal key onto a wheel slot, and its test pins two known
    keys precisely because *"changing the hash silently recolours every
    non-overridden signal"*. A palette switch is the same event by
    another route, and the per-signal overrides in `signal_colors`
    (project-scoped) do *not* follow it — so a user who has overridden
    anything ends up with a mixture of the two palettes. That
    interaction rule is the design question, and it has to be answered
    before a field is added.
- `[feat]` **Light mode, and UI density, triaged separately.** Task 45
  Stage 5 listed "theme and density (dark-only, fixed type scale)" as
  one item. Neither is a promotion, and they fail for different
  reasons:
  - **Light mode is a second stylesheet that does not exist.**
    `index.css` carries ~530 literal hex colours and **zero** CSS
    custom properties; `:root` declares `color-scheme: dark` and paints
    `#0e1116`. Beyond the stylesheet, colour is also decided in JS —
    `palette.ts` (AA-tested against that one background), `busColor.ts`,
    and `PlotArea.tsx`'s uPlot canvas styling. The real task is
    "introduce a theme token layer", after which a `theme` setting is
    one row. Doing it in the other order produces an app that is half
    light.
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
- `[cleanup]` **`SystemMessagesPanelParams` in `systemLog.ts` has no
  consumer.** `SystemMessagesPanel.tsx` declares its own local
  `PanelParams` with the same one field and uses that; the exported
  interface is a second declaration of one fact. Pre-existing; Stage 2
  trimmed both to `filterSource` rather than deleting one, to keep the
  change surgical.
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

- `[ui]` **Missing scroll controls on scrollable panels.** Panels that
  overflow their viewport have no visible/usable scroll affordance for
  the overflow axis: the trace view can't be scrolled horizontally
  (left/right) to reach off-screen columns, and the project panel can't
  be scrolled vertically (up/down) to reach off-screen rows. Add the
  missing scrollbars / wheel handling so all overflow is reachable.

- `[ui]` `cannet-gui` Settings panel: **remove the read-only section.**
  The custom settings panel
  ([ADR 0034](../docs/adr/0034-settings-vs-state-and-custom-settings-panel.md))
  shows a read-only block (machine-local state / derived info the user
  can't edit). Non-editable rows don't belong in a settings panel —
  drop the section (relocate anything worth surfacing to
  About/diagnostics). Deferred by priority, not an open question.

- `[feat]` **Replay an already-loaded BLF.** Once a BLF is loaded into
  the session buffer, offer to replay it through the pipeline
  (time-accurate, from its own start time) without re-opening the file
  — a playback control over the capture already in the model, so
  consumers (trace / plot / graph) see it stream as if live. Decide the
  interaction (transport controls, speed, loop) and how it coexists
  with a live capture on the same buses. Note: this is *not* the fix for
  a view added after load coming up empty — that's the subscribe-on-
  create fix that shipped in the initial-feedback batch (former Task
  32); replay is a standalone playback feature, kept here on its own
  merits.

- `[bug]` `cannet-gui` `state.json`: **project-scoped plot/panel
  definitions leak into the no-project layout snapshot.** `state.layout`
  is the opaque dockview blob the host round-trips verbatim
  ([state.rs:48–52](apps/gui/src-tauri/src/state.rs#L48)); dockview
  serializes every open panel's full `params`, so a project's plot panels
  (`plot-<element>`, e.g. `plot-battery` / `plot-powertrain`) get their
  complete definitions — areas, `busId`-scoped signal keys like
  `batt|s:768:PackCurrent`, colours — baked into machine-local
  `state.json`, byte-identical to the `.cannet_prj` copy. That's
  project-owned data (thin-views principle) mirrored into UI state, and
  stale-by-construction: the signals reference project-scoped buses that
  don't exist with no project open, so the plot resolves empty in the
  exact "no project" case the snapshot is *for*. Decide whether the
  no-project snapshot should strip project-scoped panels (or skip
  capturing them while a project is open) at the `set_state` layout-write
  path. Relates to the ephemeral-view-state item below — both concern
  what `state.json` legitimately owns. (Surfaced 2026-07-11.)
- `[feat]` **Persist ephemeral view state with the project/scratch.** A
  reopened session restores the capture and its origin (ADR 0002 DS-7 +
  ADR 0024) but not *where each view was looking* — plot x-windows,
  trace/by-id scroll positions & follow-live state, cursor placements,
  filter-view offsets. These aren't project data in the classic sense,
  but they're project-relevant: reopening lands you at a different view
  than you left. Decide what to snapshot (per-element view state) and
  where it rides (scratch alongside `session_start_ns`, or the project
  file) so "exit and reopen" returns you to the same framing. The
  layout-undo snapshot stack (`apps/gui/src/viewHistory.ts`, view
  undo/redo) captures serialized layouts already — a candidate base for
  the snapshot mechanism. Surfaced during the plot window-start-origin
  fix (ADR 0024).

- `[test]` **View-chord interception on macOS / Linux webviews.** The
  view keyboard actions are verified on Windows (WebView2 honours
  `preventDefault` for its browser accelerators). Unverified elsewhere:
  on macOS, Tauri's default app menu may claim `Cmd+W` before the
  webview ever sees the keydown (fix would be removing/rebinding that
  menu item), and `Ctrl+Tab` / `Mod+W` interception is untested in
  WKWebView and WebKitGTK. If a mac/Linux user reports a dead chord,
  this is the diagnosis; verify when hardware is in reach.

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
- `[docs]` **BLF f64-timestamp precision note** (former Task 24) —
  document the precision limit of BLF's f64 seconds timestamps in a
  user-facing surface, if it hasn't already been folded into one.
- `[ui]` `cannet-gui`: a global UI frame-rate / responsiveness readout
  (rAF-based FPS, maybe long-task / dropped-frame counts) — the plot
  panel shows its own re-sample rate now; generalise that to a small
  always-available indicator so other panels' costs are visible too.
  Useful while tuning the trace virtualizer and any future heavy view.
- `[feat]` **Configurable log volume / verbosity.** Logging volume is
  fixed today — the host System Messages bus, the python-can sidecar,
  and the frontend `diag` stream each emit at a hard-coded level with no
  user control. We'll want a way to configure how much is logged: a
  minimum level (and ideally per-source filtering) plus volume guards
  (rate limiting / retention or ring-buffer caps) so a chatty source
  can't drown the panel or grow unbounded. Natural home is the Settings
  panel. Surfaced while building the frontend perf capture, which adds
  yet another log/metric stream.
- `[ui]` GUI-wide visual restyle: adopt the dark "scope" visual
  language from `plans/plot-panel-reference.html` (the prototype's colour
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

- `[cleanup]` **Extract a host-model crate out of `cannet-gui`.**
  `trace_store` / `filter` / `signal_cache` / `signal_sampler` are
  tauri-free and don't need to live in the app crate; `cannet-perf-measurement`
  already depends on `cannet-gui` via documented `pub mod` escapes to
  reach them (a deliberate tradeoff at the time). Now that the lib.rs
  god-file split (task 30) has landed these into their own modules,
  pulling them into a standalone crate is mechanical. Do it if/when
  another consumer besides `cannet-perf-measurement` needs the same
  escape, or the `pub mod` seam starts to hurt.
- `[cleanup]` **Sweep task-step-number comments (`6d`, `Step 3`, …) out
  of source.** ~20+ sites across `cannet-spill` and host files (filter,
  signal_cache, emitters, trace_store's flush module among them) cite
  plan-step numbers in comments, violating the no-plan-refs rule
  (CLAUDE.md § Documentation: source cites ADRs, never `plans/`).
  Surfaced by the 2026-07-02 quality audit (task 30) and reconfirmed
  outstanding as of the task-30 close-out (2026-07-26) — replace each
  with an ADR reference or plain inline rationale, in one commit so the
  sweep doesn't drag.
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
- `[bug]` `cannet-gui` disk-spill scratch: **two app instances share and
  stomp one `current/` dir.** The scratch lives at a single fixed path
  (`<OS cache>/dev.cannet.app/current/`), and nothing arbitrates exclusive
  ownership. [ADR 0002 DS-7](../docs/adr/0002-disk-spill-store.md)'s
  `project_id` identity gate decides what a launch *reloads*, but it does
  not stop a second concurrent instance from opening the same dir and
  appending/clearing into the same segment files as the first — mutual
  corruption (and a second instance's capture silently destroys the
  first's reloadable session). Options: an OS advisory lock / lockfile in
  `current/` taken at boot (second instance falls back to a per-pid
  scratch dir, or refuses, or runs RAM-only), or a per-instance scratch
  subdir keyed by pid with the identity gate scanning siblings. Decide
  the contract (single-instance-wins vs. multi-instance-isolated) when
  picking up. Surfaced while wiring 5.3c reload.
  reductions.** The per-tick O(session length) rescan is fixed — the
  follow-live tail now resumes from an incremental count checkpoint and
  scans only *backward* from the tip for its page (`fetch_filtered_trace`
  fast path + `useFilteredTrace` cursor), so a filtered panel parked at the
  tail costs O(Δ + page span) per tick, not O(buffer). Two residual pieces
  remain, sharing one invalidation story (filter edited / DBC set changed):
  - *Positioned deep-scroll fetch.* A non-tail page (the user scrolled into
    history) still scans from `scan_start` to place itself by match-index —
    O(offset), but on the scroll, not the live tick. A per-filter match
    index (like `by_id`, remembering matched indices) would make it
    O(log + page); only worth it if deep-scrolling a filtered view on a
    huge buffer proves janky.
  - *Cached candidate sets.* `decode_candidate_ids` re-runs the
    name/signal resolution against every loaded DBC on every fetch
    (4 Hz+ per filtered panel), though it's a pure function of
    (predicate, loaded DBCs) and both have change events. Cache keyed
    by predicate + a databases generation counter; the risky part is
    auditing every `state.databases` mutation site (load, remove,
    reload-all, watcher reload, bus-rescope) for the bump — a missed
    invalidation is a wrong-results bug, which is why this wasn't done
    inline with the gate itself.
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

- `[cleanup]` `cannet-python-can` `_proto_to_frame`: direction
  `UNSPECIFIED` is silently coerced to TX (`is_rx = direction ==
  DIRECTION_RX`) where Rust's `convert.rs` rejects it — asymmetric with
  the frame-*kind* seam, which now rejects `UNSPECIFIED` on both sides.
  Unreachable from Rust peers (`frame_to_proto` always sets Rx/Tx);
  align when next touching the seam. (2026-07-26 closeout review.)
- `[ui]` `cannet-python-can` sidecar: **suppress the `xlReceive failed
  (XL_ERROR)` warning emitted on normal close.** Closing a Vector
  channel while `_rx_pump` is blocked in `ch.recv` surfaces as a
  WARN-level `rx for <id> failed: xlReceive failed (XL_ERROR) [Error
  Code 255]` System Message on every disconnect — teardown noise, not
  a fault. Detect the closed/closing state in the pump (or close the
  channel only after the pump exits) so a clean unsubscribe doesn't
  log a scary error.
- `[perf]` `cannet-gui` status residency (task 0018 6g-C, deferred): the
  status line's memory figure is whole-application RSS (host + WebView
  children) labelled `RAM`, not a store-only residency estimate. A true
  mapped-resident metric (`mincore` on Linux / `VirtualQuery` on Windows
  over the mmap'd cache segments) plus a health-log breakdown refinement
  (split `other` into by-id / filter / JSON; surface pyramid *file count*
  rather than depth) would make the split honest. Low value / fragile
  cross-platform — mmap paging already bounds store residency and the
  `RAM` label doesn't claim otherwise. Pick up only if residency needs
  real metering.
- `[perf]` `cannet-gui` `save_capture` **materializes the entire capture in
  RAM** (lib.rs:925–947, 1058–1113): it pulls the whole store into one
  `Vec` before writing the BLF, under a comment saying "which we'll
  revisit when disk-spill lands" — disk-spill has landed (ADR 0002;
  windowed-ring eviction shipped in task 18), so saving a large spilled
  capture now defeats the spill. Stream the write in chunks off the
  store's paged read path instead. (2026-07-02 audit.)
- `[perf]` `cannet-python-can` server: **TX hot path re-resolves the
  interface through the registry per frame** (server.py:788, 848,
  878–908) even though the session already holds the handle
  (635–640) — a per-frame dict/lock round-trip on the highest-rate
  path. Cache the handle on the session. (2026-07-02 audit.)
- `[perf]` `cannet-core`: revisit `CanFramePayload::Classic`/`Fd` to share
  a fixed-size inline buffer instead of `Vec<u8>` once the trace store /
  perf benchmark shows allocator pressure.
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
  Phase 8 delivers the process-level sidecar lifecycle bridge (stdout
  / stderr / exit-code → System Messages tagged `sidecar:python-can`);
  once the GUI opens a Session against the sidecar it should also
  forward in-band `LogMessage` envelopes through the same tag so a
  vendor SDK warning surfaced mid-session reaches the user without
  the sidecar having to also `print` it.
- `[feat]` Linux `vcan` via socketcan as a writable CAN source. An
  actual local virtual-bus device on Linux is the honest follow-up to
  the in-process virtual bus. Reconsider alongside future hardware
  work — PEAK's Linux kernel driver path could go via socketcan too.

- `[ui]` `cannet-python-can` sidecar: **demote python-can backend "driver
  not installed" WARNINGs to INFO.** On startup the sidecar's enumeration
  triggers python-can's hardware backends to import their native vendor
  libs; when the lib isn't present each backend emits a `WARNING` via its
  module logger that the host promotes to a Warn-level System Message
  (e.g. `can.interfaces.vector.canlib Could not import vxlapi: Vector XL
  library not found: vxlapi64`; `can.interfaces.kvaser.canlib Kvaser
  canlib is unavailable.`, confirmed by direct import). Expected on any
  workstation that doesn't have every CAN vendor installed — not
  actionable, but trips the panel's default Warn filter. Add a
  `logging.Filter` in
  [`__main__.py`](../servers/cannet-python-can/cannet_python_can/__main__.py)
  installed on the root handler after `basicConfig` that rewrites
  `levelno=WARNING → INFO` (and `levelname`) for records whose `name`
  starts with `can.interfaces.vector` or `can.interfaces.kvaser`. Other
  loggers untouched. Result: line still surfaces at Info level (via
  `classify_stderr_line` → `LogLevel::Info`), preserving the breadcrumb
  without raising the panel. Test the filter directly with synthesized
  `LogRecord`s in a new sidecar test.

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
  resolves the sidecar launcher (or additional launchers?) by fixed probe order
  (frozen binary next to the GUI exe, then `uv`/`python3` dev paths) in
  [`apps/gui/src-tauri/src/sidecar.rs`](apps/gui/src-tauri/src/sidecar.rs). Add
  an override (env var and/or setting) that points cannet at a user-chosen
  sidecar executable. Reinforces the LGPL §4 replace story (see
  [`servers/cannet-python-can/LICENSING.md`](../servers/cannet-python-can/LICENSING.md)):
  a user who swaps in a modified sidecar / `python-can` can point cannet
  straight at it instead of editing files inside the frozen onedir.

- `[naming]` `sidecar.rs` internal identifiers `LaunchPath::BundledUv`
  and `bundled_uv_path()` predate the "fetched, not bundled" decision
  and should be renamed (e.g. `LocalUv` / `local_uv_path`) for
  consistency. User-facing strings and module docs are already
  updated; this is a code-only follow-up.

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

- `[cannet-gui]` **Project save absolutizes DBC paths.** Opening and
  closing a project rewrites its `.cannet_prj` with each DBC's path
  expanded to an absolute machine-specific one (`dbc/pack.dbc` →
  `C:\Users\...\dbc/pack.dbc`), observed 2026-07-25 when a GUI session
  against `examples/ev-zonal` dirtied the checked-in example and broke
  `parses_the_checked_in_ev_zonal_example_project`. Paths that arrived
  relative should persist relative (portability; examples are
  checked in). Find the save path that resolves before serializing.

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
  edit ([`apps/gui/src/DbcPanel.tsx`](apps/gui/src/DbcPanel.tsx)
  `refreshContent`). Task 41 ruled this explicitly out of scope — the
  layout cliff it was chasing was DOM-side and is fixed — but the
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

- `[cannet-gui]` **Deleting an auto-located project's cache leaves its
  project directory behind, unlisted.** ADR 0042 §5's table says Delete
  leaves the project directory untouched, without qualification, and
  Task 47 branch 3 implemented it literally — so deleting an
  auto-located row forgets the entry but leaves
  `<app_cache_dir>/projects/<key>/` (a `.cannet/` holding two empty JSON
  files, a `.gitignore`, and a dangling cache link) with nothing pointing
  at it. A few hundred bytes, and reopening that project re-registers
  it, so it is a tidiness question rather than a leak that matters. If it
  is ever worth fixing, the honest form is an amendment to the ADR saying
  the
  "untouched" column means *a directory the user owns* — cannet created
  that one in its own cache space unasked, and decision 2's symmetry
  would let it remove one there too.
