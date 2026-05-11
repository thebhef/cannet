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
- `[ui]` trace view: alternate "by ID" mode that collapses to one row
  per arbitration-id with the latest payload, instead of chronological.
- `[ui]` trace view: list decoded signals on their own lines under the
  message row instead of expand-to-show.
- `[ui]` trace view (`TraceView.tsx`): under a fast (unlimited-rate)
  stream, scrolling up doesn't reliably leave auto-scroll and a parked
  panel can be yanked back to the live tail — the auto-scroll re-pin
  effect races the async `onAutoScrollDisabled`. Fix: a synchronous
  "user took control" ref that gates the re-pin / pin-to-tail effects
  until the parent's `autoScroll` flips. (Surfaced during Windows
  stress testing; macOS at moderate rates is fine.)
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
  trait-ify when there's a second implementation.
- `[perf]` `cannet-gui::TraceStore::append`: at very high replay rates
  the `Vec<RawTraceFrame>` doubling does a multi-MB copy *while holding
  the store lock*, briefly stalling `fetch_trace_range` and the
  `trace-grew` emitter. Pre-reserve a generous capacity, or move to a
  chunked buffer, so growth doesn't pause the lock. Folds into the
  disk-spill rework above.
- `[bug]` `cannet-gui`: the frontend's connection `LogState` can drift
  from the host's actual `remote_session` (e.g. it shows "Connect"
  while the host still has a session) — connection state is maintained
  client-side and only resynced via the `log-finished` event. Harden:
  derive it from the host (a `connection-state` event or a query
  command) and surface "connection lost" distinctly from a deliberate
  disconnect. (Surfaced during Windows stress testing.)
- `[feat]` `cannet-gui`: explicit "Save Capture…" toolbar action that
  exports the current `TraceStore` contents to a `.blf` file via
  `blf_asc::BlfWriter`. The features-doc entry "trace capture:
  persistable to .blf" lives here.
- `[feat]` `cannet-gui`: VS Code-style command palette (Cmd/Ctrl+
  Shift+P) for keyboard-driven access to toolbar actions
  (Open BLF…, Attach DBC…, Connect / Disconnect, Clear, Go to row,
  Save Capture…). Useful once the toolbar grows past a single line
  in Phase 3.
- `[feat]` `cannet-gui`: "Go to row…" navigation
  (Cmd/Ctrl+G) — type an absolute index, the trace view scrolls
  there. Especially valuable past ~730k rows where the scaled
  scrollbar's per-pixel resolution gets coarse.
