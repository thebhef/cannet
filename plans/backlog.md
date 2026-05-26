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

## Items

### High priority

Near-term work — fold these into a phase before picking up the
lower-priority follow-ups below.

#### Minimum Usability Tasks

TODO: /grill-with-docs on these items

1. The transmit view is awkward, DBC rework is needed as described below, but I can't set values on any signals currently. I think a table view might be better for the signals, and for the raw bytes.
2. show points in plot
3. Drag+drop signals from DBC or trace into graph, and between graphs
4. DBC view with good filter behavior 
  - View live filtered based on on textbox search against DBC content; names, ids, notes, enum values, attribs, etc.
  - The style of search VSCode implements: you could do "MyCanMessage" by searching for "mcmess", for example. The search
  - string search implementation should be common across modules. 3rd party library may be preferred here.
  - define plot windows by filter: dict of `plot area`:`filter string`
    - Filter string should be regex
5. ui-architecture-backlog.md
6. hotkey framework + new hotkeys
  - f: fit plot x axis
  - l: enable 'follow live' on plot

#### Other near-term work

- `[feat]` **Settings panel — first entry: `clear scratch cache on exit`.**
  Per [ADR 0002 DS-7](../docs/adr/0002-disk-spill-store.md), the
  disk-spill scratch (raw store + indexes + pyramids + session-authored
  markers/events) lives in `$XDG_CACHE_HOME/cannet/current/` and is
  wiped only when the session buffer is — on Clear, or on Start of a
  new capture — never on exit or crash. That makes the launch-loads-
  prior-as-stopped behavior mechanically free, but means a user who
  quits without Clearing/Starting leaves the prior session on disk
  indefinitely. A settings panel needs to exist; its first setting is
  an opt-in `clear scratch cache on exit` toggle (default off) that
  wipes `current/` on clean shutdown. Other settings will land here
  as they come up; spec the panel itself when picking this up.
- `[test-fixtures]` **Vendor python-can BLF fixtures under
  `crates/cannet-blf/tests/fixtures/python-can/`.** Phase 9.5
  Step 1 listed this as the first of four test sources but
  deferred actual vendoring; today the step's coverage is
  synthetic-bytes per-module tests + the vector_blf oracle
  cross-check (gated behind `vector-blf-oracle`). Adding the
  python-can-written files would give us a third-party-writer
  cross-check that runs without C++ toolchain. ~30 KB binary
  per file, expect ~5 files covering classic / FD / error / mixed
  channels / big payloads.
- `[ui]` **Element display names need one model-owned source of truth
  and a shared resolver, used by every view.** Today each view derives
  an element's label independently and they disagree — basically every
  view has this problem, so fix it structurally rather than per-view.
  `trace` / `plot` / `transmit` `ProjectElement`s
  ([types.ts:146-148](apps/gui/src/types.ts#L146-L148)) carry no `name`
  field at all — only `filter` does
  ([types.ts:152](apps/gui/src/types.ts#L152)) — so the dockview title
  bar fabricates one from a monotonic counter held in a React ref
  (`Trace ${panelCounterRef.current}` —
  [App.tsx:1067](apps/gui/src/App.tsx#L1067),
  [App.tsx:1080](apps/gui/src/App.tsx#L1080)) that is not persisted on
  the element or visible to any other view, while the graph view
  labels the same node `${capitalise(el.kind)} ${shortId(el.id)}`
  ([projectGraph.ts:134](apps/gui/src/projectGraph.ts#L134)) and the
  project panel uses a static per-kind string `PANEL_TITLE[el.kind]`
  ([ProjectPanel.tsx:24](apps/gui/src/ProjectPanel.tsx#L24)). One
  element reads "Trace 1" in the title bar, "Trace a3f2b1" in the
  graph, and a bare "Trace" in the project panel, and none of them is
  editable. Fix once, structurally: every element kind carries a
  model-owned `name` (filter / bus already do — make it uniform),
  defaulted on creation and editable in one place (the project panel
  already inline-renames buses —
  [ProjectPanel.tsx:203](apps/gui/src/ProjectPanel.tsx#L203)); add a
  single shared resolver (e.g. `elementLabel(el)`) that every view —
  title bar, project panel, graph, and any view added later — calls
  instead of rolling its own. A new view then gets correct,
  consistent, renameable labels for free.

### Graph-and-bus integration fixes

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
- `[ui]` **Plot panel signal catalog scoped by `sources`.** The
  per-bus signal model and the message picker work end-to-end, but
  the catalog dropdown still shows every signal from every loaded
  DBC across every bus — even ones the plot's `sources` exclude.
  Filter `catalogOptions` in PlotPanel.tsx by the consumer's
  effective `sources` so the picker only offers signals it can
  actually sample.
- `[ui]` **Drag-to-wire from anywhere on a node body.** Drag-from-
  handle works (xyflow `onConnect` is wired to `addEdgeToRegistry`),
  but the user has to land on the small handle dots. Long-term,
  dragging from a producer node anywhere onto a consumer (no need
  to land on a handle) would be more discoverable.

### Other follow-ups

- `[perf]` `cannet-core`: revisit `CanFramePayload::Classic`/`Fd` to share
  a fixed-size inline buffer instead of `Vec<u8>` once the trace store /
  benchmark in Phase 14 shows allocator pressure.
- `[ui]` trace view: dock / undock as a separate window. (Resizable and
  hideable columns folded into Phase 3; tear-out into a separate OS window
  stays here — Phase 3 docking is within the single main window.)
- `[ui]` trace view: list decoded signals on their own lines under the
  message row instead of expand-to-show.
- `[ui]` `cannet-gui` (`ByIdPanel`): tighten the by-ID snapshot for a
  paused/stopped trace. Today it reads the host's *global*
  latest-frame-per-id index (`fetch_latest_by_id(since)`), so for a
  trace whose `end` is below the buffer's tip a row can show an id's
  occurrence *after* the trace stopped, and the freeze snapshot can
  include a frame or two received between the pause/stop click and the
  final refresh. Fix: pass the window's `end` too and have the host
  return the latest of each id within `[since, end)` — walking
  `frames[since..end]` backwards rather than reading the latest index.
  (Surfaced reviewing the trace-controls / by-ID work; harmless for the
  common "running" case.)
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
- `[ui]` `cannet-gui`: a global UI frame-rate / responsiveness readout
  (rAF-based FPS, maybe long-task / dropped-frame counts) — the plot
  panel shows its own re-sample rate now; generalise that to a small
  always-available indicator so other panels' costs are visible too.
  Useful while tuning the trace virtualizer and any future heavy view.
- `[feat]` `cannet-gui` plot panel: **manual** per-*trace* y controls —
  offset / gain (so the user can override the per-trace auto-normalise
  that ships today) and log scaling. The auto-norm is implemented as a
  per-trace gain/offset applied just before draw, so the UI plumbing is
  "expose those numbers"; uPlot also supports multiple stacked y-axes
  if that turns out to be the better UX for "I want to read absolute
  values off the axis" instead of normalised positions.
- `[feat]` `cannet-gui` plot panel: triggers — edge / level /
  value-match on a chosen signal that freeze the view and emit an event
  marker (into the plot's event list, and later the trace). The
  event-line rendering already exists; the trigger engine doesn't.
- `[feat]` `cannet-gui` plot panel: CSV / image export of the visible
  window or the cursor span.
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
- `[feat]` `cannet-gui`: drag a decoded signal *into* a plot from
  elsewhere — a trace panel's expanded-row signal grid, the by-ID
  table. Make those rows `draggable` carrying the same
  `application/x-cannet-plot-signal` payload (a `SignalRef`) the plot
  panel's signal rows use; a plot area is already a drop target. (Today
  you add signals only via the plot's "add signal…" dropdown or by
  dragging between plot panels.)
- `[feat]` `cannet-gui` plot panel: drag a *plot area* (not just a
  signal) between plot panels — re-order areas within a panel and move /
  copy a whole area (its signals + y-range) to another plot panel.
  Today only individual signal rows are draggable; the area's
  drag-handle would carry the area config the same way.
- `[ui]` `cannet-gui`: dragging the divider to resize a plot panel vs.
  an adjacent trace panel — confirm dockview's split-resize works for
  the plot panel (it's a normal dockview panel, so it should once they
  sit in separate groups rather than tabbed together); if a plot-panel
  CSS rule (`min-height` chains, the flex-filled areas) is fighting it,
  fix that. (Reported as not working; not yet reproduced here.)
- `[feat]` `cannet-gui` math channels — derived signals computed from
  other signals (sum, diff, scale, filter, …). Useful to the plot panel,
  the transmit panel, and a future scripting surface, so it may outgrow
  plotting; scope it on its own when picked up.
- `[ui]` `cannet-gui` plot panel: pick a trace's plot colour from a
  colour dialog on right-click of its swatch (today the swatch toggles
  hidden on left-click and colours are assigned round-robin from a fixed
  palette on add). Right-click → a small swatch-grid / `<input
  type="color">` popover; the chosen colour is sticky like the
  auto-assigned one.
- `[ui]` GUI-wide visual restyle: adopt the dark "scope" visual
  language from `plans/plot-panel-reference.html` (the prototype's colour
  variables, monospace type scale, panel chrome, control styling) across
  the toolbar, trace panels, project panel, etc. — currently each panel
  has its own ad-hoc styling in `apps/gui/src/index.css`. Approved in
  principle; do it as one deliberate pass once the plot panel's own
  styling has settled, not piecemeal.
- `[feat]` Linux `vcan` via socketcan as a writable CAN source. Phase 5
  ships an in-memory loopback bus in `cannet-core` and a
  `cannet-server --loopback` mode that covers demo and test; an actual
  local virtual-bus device on Linux is the honest follow-up. Reconsider
  alongside or after Phase 8 hardware work — PEAK's Linux kernel driver
  path could go via socketcan too.
- `[feat]` `cannet-server` (Phase 2+): multi-client support. Phase 2 is
  single-client per server; a second connection is rejected with
  `Error::BUSY`. Lift this when there's a real use case (e.g. a second
  GUI session or a CI watcher tailing alongside a developer): server
  fans out received frames to all connected clients, and arbitrates /
  interleaves transmits on the same interface from multiple clients.
- `[feat]` `cannet-gui`: VS Code-style command palette (Cmd/Ctrl+
  Shift+P) for keyboard-driven access to toolbar actions
  (Open BLF…, Add DBC…, Connect / Disconnect, Clear, Go to row,
  Save Capture…). Useful once the toolbar grows past a single line
  in Phase 3.
- `[feat]` `cannet-gui`: "Go to row…" navigation
  (Cmd/Ctrl+G) — type an absolute index, the trace view scrolls
  there. Especially valuable past ~730k rows where the scaled
  scrollbar's per-pixel resolution gets coarse.
- `[feat]` `cannet-gui` transmit panel: proper signal-to-bytes
  encoding. Phase 5 surfaces enum dropdowns and lets the user copy a
  picked raw value into the payload as a single byte, but per-signal
  bit-pack encoding (factor / offset / endianness, multi-byte signals,
  multiplexed messages) lives in `cannet-dbc` and isn't exposed
  yet. Cleanly the inverse of `cannet_dbc::Database::decode` and
  belongs there; the GUI host gains an `encode_frame` command that
  the panel calls instead of building hex by hand.
- `[feat]` `cannet-gui` plot panel: enum rendering for multi-signal /
  mixed areas. Phase 5 only switches to stepped + symbolic when an
  area shows exactly one signal with a `VAL_` table — that's the
  realistic single-state-channel case. Multiple enum signals on one
  area (each on its own symbolic strip), or one enum + numeric on
  the same axis, both want a different layout (multiple y-axes /
  per-signal step overlays). Pick this up alongside the per-trace
  y offset / gain work, which already needs the same plumbing.
- `[ui]` `cannet-gui`: **bitfield message visualizer**. Render a CAN
  message as its raw bits laid out as a grid (8×N cells, one per bit),
  coloured / lit by current value, with DBC-derived signal overlays
  showing which bits belong to which signal and named flag labels for
  single-bit booleans. Most natural as a row-expansion mode in the
  trace view (toggle between the decoded-signal grid and a bit grid),
  or as a small standalone panel for watching one ID's status flags.
  Useful for messages that pack many flags into a byte where the bare
  decoded-signal list is harder to read at a glance.
- `[feat]` `cannet-gui` host: bridge wire-level `LogMessage` envelopes
  from an active sidecar Session stream into the System Messages bus.
  Phase 8 delivers the process-level sidecar lifecycle bridge (stdout
  / stderr / exit-code → System Messages tagged `sidecar:python-can`);
  once the GUI opens a Session against the sidecar it should also
  forward in-band `LogMessage` envelopes through the same tag so a
  vendor SDK warning surfaced mid-session reaches the user without
  the sidecar having to also `print` it.
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
- `[packaging]` end-user `uv` fetch mechanism: pick between an
  installer post-step and a first-run host downloader, and
  implement. Per [ADR 0015](../docs/adr/0015-fetched-runtime-binaries.md),
  the binary is fetched, not committed or bundled; the runtime
  lookup chain (`tools/uv/uv` → `PATH` `uv` → `python3` fallback)
  stays unchanged, only how `tools/uv/uv` gets populated on an
  end-user machine. Today `scripts/fetch-uv.sh` is the dev-side
  fetch; the end-user-side fetch is the open work. See Phase 18
  "Third-party runtime tool fetching strategy" for the two
  candidate mechanisms.
- `[naming]` `sidecar.rs` internal identifiers `LaunchPath::BundledUv`
  and `bundled_uv_path()` predate the "fetched, not bundled" decision
  and should be renamed (e.g. `LocalUv` / `local_uv_path`) for
  consistency. User-facing strings and module docs are already
  updated; this is a code-only follow-up.
