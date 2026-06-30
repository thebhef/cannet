# ADR 0024 — Trace timing: one origin, elapsed time, how time renders

Status: accepted (2026-06-01); amended (2026-06-30) — replaced the
per-trace re-zero display model with a single application-level origin
rendered as elapsed time. The history below describes the current
decision; the superseded per-trace-offset rendering is recorded under
"Rejected alternatives."

## Decision

cannet has one **session buffer** and any number of **traces**
rendered over it. A trace is a window into the session buffer. The
trace view (the row-table panel) and the plot panel are two renderers
of a trace; they share one timing model, and that model has a single
origin for the whole application.

1. **The session buffer has a start time** — the one origin. It is
   set when the session buffer starts and when it is cleared, stored
   as wall-clock seconds (Unix epoch). A buffer that has never been
   started has no start time.

2. **Every renderer displays elapsed time since that origin.** A row,
   a plot x-axis tick, an event marker — each shows
   `frame.timestamp − session_start`. This is the only formula, and
   there is exactly one `session_start` for the application. No trace,
   panel, or renderer has its own zero.

3. **Elapsed time renders as `[d:][hh:][mm:]ss.ffff`** — only the
   segments needed to span the magnitude, with four fractional digits
   (0.1 ms). The leading segment is unpadded (`5.8710`, `1:05.0000`);
   lower segments are two-digit zero-padded once a higher one is
   present (`2:00:03.5000`, `1:01:01:01.5000`).

Because the origin is shared, the same instant reads identically in
every panel: the trace table, the plot, and any event marker all show
the same elapsed value for a given frame.

## Why

A user looking at the same event in three places — a row in the trace
table, a vertical marker on the plot, a line in the events view — must
see one number. The cost of getting this wrong is concrete: a panel
showing `5.8710` for the frame the next panel labels `0.0000` destroys
the shared reference and is read as a bug.

The earlier model allowed each renderer to pick its own zero: a trace
could re-zero its time column on Clear / Stop+Start (a per-trace
offset), and the plot anchored its x-axis at the first frame in its
own window. The same event then showed up to three different times.
The single shared origin removes that whole class of confusion; the
absolute timestamp is still what filtering and the host work in, so
nothing of value is lost by not re-zeroing the display.

## Mechanics

Host-side (`cannet-gui::trace_store`):

- `TraceStore` holds `session_start_ns: u64` and exposes
  `start_session(session_start_ns)` and a `session_start_ns()`
  reader. `start_session` is called by `clear_trace_store` (Connect /
  Open / toolbar Clear all go through it) and by the replay pump on
  its first frame.
- `TraceStore::append` drops any frame stamped strictly before
  `session_start_ns` — the buffer-side guard, so frames in-flight at
  the moment of Clear can't land in the new session with a pre-Clear
  timestamp.
- The `trace-grew` event carries `session_start_seconds`; the
  frontend treats it as the canonical, only origin.

Frontend (`apps/gui/src`):

- `format.ts::formatElapsed(seconds)` renders the elapsed-time string;
  `formatTimestamp(ts, base)` is `formatElapsed(ts − base)`.
- `useTrace` derives `baseTimestampSeconds = sessionStartSeconds` and
  every renderer subtracts it. The row table, the by-id table, and the
  events view pass it straight to `formatTimestamp`.
- The plot renders against the same origin: it passes
  `sessionStartSeconds` as `DecimatedRequest.origin`, so its x-axis
  `t = 0` is the session start (not the first frame in its window).
- `TraceState.traceStartOffsetSeconds` is **retained but dormant**. It
  is still set by per-trace Clear / Start-after-Stop, but it is no
  longer added to the rendered origin. Keeping the field (rather than
  deleting the machinery) leaves a per-view re-zero one wiring change
  away if it is ever wanted again, without resurrecting the
  multi-origin confusion in the meantime.

## Invariants

- **Rendered time is `frame.timestamp − session_start`, everywhere.**
  If two panels disagree about a frame's time, one of them is not
  using the session origin — a bug.
- **Rendered time is never negative.** Frames stamped before
  `session_start` are dropped by the buffer guard; if a negative time
  appears, the guard let a stale frame through.
- **A new session start re-zeroes every panel in the same render.**
  There is one number to change and no per-view state to reconcile.

## Consequences

- The trace view and the plot share the session origin, not just a
  hook. A new trace renderer (e.g. a statistics overlay) subtracts the
  same `session_start` and inherits the shared timescale for free.
- The frontend never holds an absolute "row 0 timestamp" of its own,
  and no renderer anchors on its window's first frame. Whatever zero a
  panel shows is `session_start`, derived every render.
- Per-trace re-zero is not a user-visible feature today. The dormant
  offset field documents that this was a deliberate removal, not an
  oversight.

## Rejected alternatives

- **Per-trace re-zero applied to the display** (the original decision
  here). A trace's *Clear* or *Stop→Start* captured "now in
  session-relative seconds" and rooted that trace's time column there.
  Looked like a useful escape hatch; in practice it meant two trace
  panels over the same buffer showed different times for the same
  frame. Superseded by the single origin; the offset field survives
  but is no longer a display input.
- **The plot anchoring its x-axis at its window's first frame**
  (`ts(winStart)`). This was a third origin — different again from
  both the session start and any per-trace offset — so the plot's
  marker for an event sat at a different time than the trace row for
  the same event. Replaced by feeding the session start as the plot's
  x-axis origin.
- **Per-trace "row 0 timestamp" captured as wall-clock.** An even
  earlier form, briefly used by the trace view: a third source of
  truth that drifted from the session start, re-broke on every panel
  mount, and silently survived session restarts — a frequent source of
  negative-time bugs.
- **Re-zero on Pause/Resume.** Conflates "stop streaming in" with
  "re-zero my view." Pause means freeze what I'm looking at; the time
  column should not jump.

## See also

- [ADR 0005](0005-dockview-panel-layout.md) — the panel host these
  renderers run inside.
- [ADR 0007](0007-uplot-plot-renderer.md) — the plot renderer; this
  ADR governs its time column and x-axis origin too.
- [ADR 0035](0035-timeline-event-model.md) — timeline events render
  through the same origin, so an event marker reads the same time in
  the trace, the plot, and the events view.
