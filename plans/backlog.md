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

Usability issues flagged for near-term work — fold these into a phase
before picking up the lower-priority follow-ups below.

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
- `[ui-arch]` **Triage and address the UI architecture backlog.** The
  items in [ui-architecture-backlog.md](ui-architecture-backlog.md) —
  PlotPanel `resample` holding capture-lifetime model state, the dead
  `decimatePoints`, and the unpaged by-ID snapshot — are flagged but
  unscheduled. Decide each `[review]` either way, do the `[cleanup]`,
  and fold the rest into a phase; the coordinated, sliced plan is
  already written up in
  [windowed-model-convergence.md](windowed-model-convergence.md)
  (Slice 0, the frame-rate fix, has already shipped).

### Graph-and-bus integration fixes

Items surfaced during the Phase-6.5 bus fan-out / graph-view follow-up
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
- `[perf]` **Index the filtered trace scan.** `fetch_filtered_trace`
  scans the trace window by reference (`TraceStore::scan_window_filtered`
  — only the page's frames are cloned, never the whole window) and the
  refresh is throttled, so the UI no longer stalls. Two host costs
  remain: (1) every call still walks the whole `[scan_start, scan_end)`
  window O(window) — off the UI thread, but real host CPU, and it
  holds the trace-store lock for the scan; a per-`filter` index of
  matching raw indices, extended on append and dropped on filter
  change, would make it O(page); (2) a `name_regex` / `signal_equals`
  filter decodes every scanned frame under that lock — the index would
  let it decode only the page. The `from_end` tail still walks the
  whole window; a backward scan would cut it. (`fetch_trace_range`
  also carries an unused `filter` arg now — remove in the same pass.)
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

- `[refactor]` `cannet-blf` + `cannet-gui` (`save_capture`, `open_log`):
  remove the notes sidecar (`<blf>.notes.json`) and store notes as
  marker frames inside the BLF itself. The BLF format already supports
  marker entries, and CLAUDE.md § File formats forbids new sidecars —
  this one is legacy. Migration: existing `.notes.json` files are
  read once on `open_log` (best effort), promoted to BLF markers on
  the next `save_capture`, then deleted. After this lands, the
  sidecar load path can be removed entirely.
- `[perf]` `cannet-core`: revisit `CanFramePayload::Classic`/`Fd` to share
  a fixed-size inline buffer instead of `Vec<u8>` once the trace store /
  benchmark in Phase 10 shows allocator pressure.
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
- `[perf]` `cannet-gui`: bound the host-side decoded-sample cache.
  `signal_cache::SignalCacheStore` is append-only — `O(matches per
  signal)` memory, fine for typical real-world rates but unbounded for
  a 60 kHz-stream-of-one-signal-style torture test (gigabytes). The
  right shape is a two-tier per-signal buffer: raw recent (last N
  samples) plus a min/max-decimated tier behind it that's extended in
  chunks as the raw tier overflows. The cache layout (samples +
  parallel frame indices) is already what a tier would need; just
  add the demotion step and an "older-tier slice" path in
  `SignalCacheStore::slice`.
- `[feat]` `cannet-gui` plot panel: triggers — edge / level /
  value-match on a chosen signal that freeze the view and emit an event
  marker (into the plot's event list, and later the trace). The
  event-line rendering already exists; the trigger engine doesn't.
- `[feat]` `cannet-gui` plot panel: CSV / image export of the visible
  window or the cursor span.
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
- `[feat]` upstream `blf_asc`: contribute `GLOBAL_MARKER` object
  write and read (Vector's native annotation type, object type 96).
  Phase 9 needed this for in-BLF note round-trip readable by third-
  party tools, but the upstream crate has no marker types and no
  public hook on `BlfWriter` for arbitrary object emission. Phase 9
  routed notes through a sidecar `<file>.blf.notes.json` instead;
  once upstream gains marker support (the crate is small, 1.6 kloc
  MIT / Apache, contribution-friendly), `cannet-blf`'s
  `BlfCaptureWriter` can fold markers into the BLF and the sidecar
  file path retires. Until then third-party tools see frames but
  not notes.
- `[feat]` `cannet-gui::TraceStore`: disk-spill for long-running
  sessions. Phase 2 keeps the trace in `Vec<RawTraceFrame>`; that's
  fine for hours but not for days. Future implementation keeps a
  hot-tail window in memory and spills older frames to an append-only
  on-disk file (compact binary frame records — explicit `.blf`
  captures are a separate "Save Capture" feature, not the cache
  format). The `TraceStore::append` / `len` / `slice` surface stays;
  trait-ify when there's a second implementation. (A chunked / windowed
  store also retires the realloc-stall a growing `Vec` causes at very
  high replay rates — no whole-buffer copy while holding the lock.)
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
  installer post-step and a first-run host downloader, and implement.
  We have decided **not** to commit per-OS `uv` binaries into the
  repo or pack them into the Tauri bundle artefact (see Phase 16
  "third-party runtime tool fetching strategy"); the runtime lookup
  chain (`tools/uv/uv` → `PATH` `uv` → `python3` fallback) stays
  unchanged, only how `tools/uv/uv` gets populated on an end-user
  machine. Today `scripts/fetch-uv.sh` is the dev-side fetch; the
  end-user-side fetch is the open work.
- `[naming]` `sidecar.rs` internal identifiers `LaunchPath::BundledUv`
  and `bundled_uv_path()` predate the "fetched, not bundled" decision
  and should be renamed (e.g. `LocalUv` / `local_uv_path`) for
  consistency. User-facing strings and module docs are already
  updated; this is a code-only follow-up.
