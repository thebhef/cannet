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

- `[feat]` `cannet-gui`: associate a DBC with a particular *logical
  bus* rather than the global decode set. Multiple DBCs already load
  (`AppState::databases`, `Project.dbc_paths`), but every one applies
  to the one interface; once there's more than one logical bus, a DBC
  should be scoped to the bus(es) it describes (decode a frame only
  against its bus's DBCs). Depends on the "logical buses" notion below.
- `[feat]` `cannet-gui` / `cannet-server`: a notion of *logical buses*
  and a mapping from physical CAN interfaces (driver + channel) onto
  them — so one server can expose several interfaces, the GUI groups
  traffic by logical bus, and per-bus config (DBCs, filters, transmit
  defaults) hangs off the bus rather than a single global "interface".
  Pairs with the deferred "interface selection" work (see
  `plans/phased-implementation.md` Phase 3 notes) and the physical
  drivers (Phase 6).
- `[feat]` `cannet-dbc`: surface DBC value-tables (`VAL_`) in
  `DecodedSignal` so the trace view can show enum labels.
- `[perf]` `cannet-core`: revisit `CanFramePayload::Classic`/`Fd` to share
  a fixed-size inline buffer instead of `Vec<u8>` once the trace store /
  benchmark in Phase 7 shows allocator pressure.
- `[docs]` `cannet-blf`: f64 BLF timestamps lose sub-µs precision at
  modern absolute times; document this in the user-facing GUI when
  surfaced timestamps look quantised.
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
- `[feat]` `cannet-gui`: a "recent BLF files" list — the few
  most-recently-opened BLF paths, persisted (localStorage), offered in
  the Open BLF flow / the project panel. BLF replay is usually from a
  captured trace and the streaming-client path is a stopgap, so a
  recent-items list fits better than persisting "the project's BLF" in
  the project file.
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
- `[feat]` `cannet-gui` plot panel: per-*trace* y controls — offset /
  gain (so unrelated signals can share a plot area without one swamping
  the others) and log scaling. Per-*area* manual y-range shipped in
  Phase 4; this is the refinement.
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
- `[ui]` `cannet-gui`: dragging the divider to resize a plot panel vs.
  an adjacent trace panel — confirm dockview's split-resize works for
  the plot panel (it's a normal dockview panel, so it should once they
  sit in separate groups rather than tabbed together); if a plot-panel
  CSS rule (`min-height` chains, the flex-filled areas) is fighting it,
  fix that. (Reported as not working; not yet reproduced here.)
- `[feat]` `cannet-gui`: BLF annotation round-trip — open a BLF, place
  notes (the plot panel's "+ note" cursor mode), and save the BLF back
  out with the annotations embedded. Needs a place to persist notes
  against a capture (BLF has no native annotation record — likely a
  sidecar or a custom object kind), plus the "Save Capture…" path
  (separate backlog entry) to write it. Today notes live only in the
  plot panel's params (per project), not against the BLF.
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
- `[ui]` `cannet-gui` trace panels: enum values — for a signal whose DBC
  entry carries value descriptions (`VAL_` / value tables), show the
  named value (e.g. `2 "Reverse"`) instead of the bare number in the
  decoded-signal grid (and the by-ID expansion). Needs the DBC layer to
  surface value tables (`cannet-dbc` currently exposes name/unit/scaling
  only); also feeds the plot panel's enum/state-signal rendering.
- `[ui]` GUI-wide visual restyle: adopt the dark "scope" visual
  language from `plans/plot-panel-reference.html` (the prototype's colour
  variables, monospace type scale, panel chrome, control styling) across
  the toolbar, trace panels, project panel, etc. — currently each panel
  has its own ad-hoc styling in `apps/gui/src/index.css`. Approved in
  principle; do it as one deliberate pass once the plot panel's own
  styling has settled, not piecemeal.
- `[feat]` real in-process writable CAN source — a local virtual bus
  (Linux `vcan` via socketcan) and/or an in-memory loopback-bus type in
  `cannet-core` (a `CanFrameSink` paired with a `CanFrameSource`). Phase
  5's transmit path ships a host-side tx-confirm row plus a
  `cannet-server --loopback` mode instead, which covers demo and test;
  this is the honest version for actually exercising a writable bus
  without hardware. Reconsider when hardware work (Phase 6) is staged or
  if local TX testing needs more than the loopback server.
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
- `[feat]` `cannet-gui`: explicit "Save Capture…" toolbar action that
  exports the current `TraceStore` contents to a `.blf` file via
  `blf_asc::BlfWriter`. The features-doc entry "trace capture:
  persistable to .blf" lives here.
- `[feat]` `cannet-gui`: VS Code-style command palette (Cmd/Ctrl+
  Shift+P) for keyboard-driven access to toolbar actions
  (Open BLF…, Add DBC…, Connect / Disconnect, Clear, Go to row,
  Save Capture…). Useful once the toolbar grows past a single line
  in Phase 3.
- `[feat]` `cannet-gui`: "Go to row…" navigation
  (Cmd/Ctrl+G) — type an absolute index, the trace view scrolls
  there. Especially valuable past ~730k rows where the scaled
  scrollbar's per-pixel resolution gets coarse.
