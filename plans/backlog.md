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
  benchmark in Phase 4 shows allocator pressure.
- `[docs]` `cannet-blf`: f64 BLF timestamps lose sub-µs precision at
  modern absolute times; document this in the user-facing GUI when
  surfaced timestamps look quantised.
- `[ui]` trace view: resizeable column widths.
- `[ui]` trace view: configurable visible columns (show/hide each).
- `[ui]` trace view: dock / undock as a separate window.
- `[ui]` trace view: alternate "by ID" mode that collapses to one row
  per arbitration-id with the latest payload, instead of chronological.
- `[ui]` trace view: list decoded signals on their own lines under the
  message row instead of expand-to-show.
