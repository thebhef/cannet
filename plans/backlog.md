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
- `[perf]` `cannet-gui` plot panel: time-to-frame mapping for the
  visible-range fetch. The zoom-aware refetch converts the shared x
  range (relative seconds) to frame indices via a uniform-fps estimate
  carried in the cache. That's accurate for uniform streams but
  imprecise for bursty traffic — the fetched range can land slightly
  off the visible one. A precise mapping wants either a small
  per-second timestamp→index index in `TraceStore` (and a `time_range`
  variant of `slice_matching_many`), or a binary-search lookup
  exposed as a Tauri command. Until then, the fps approximation is
  close enough to draw correctly.
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
