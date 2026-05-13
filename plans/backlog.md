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
