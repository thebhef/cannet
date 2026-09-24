# Task 158 — Bus-Error Markers Page

Opened 2026-09-23 from an owner observation while using the stack.
**Executes now, on the current stack.** Groomed the same day; three
phases.

## Why

From the owner, 2026-09-23: "I am noticing now that maybe we're
maxing out at 256 events? or 256 bus error markers?" On the finding
below: "paging it is probably right." On what a rebuild costs: "it's
rebuildable, but expensive, similar to signal caches." On the shape:
"might be able to squeeze them into our existing pyramid machinery..."
On the Events panel: "yes, paged section."

## Findings (2026-09-23 survey)

- **The cap is real and it is bus-error episodes.** Ingest folds
  error frames into runs — one per bus per episode, a new episode
  after a 1 s gap in frame time (`COALESCE_GAP_NS`) — and holds at
  most `MAX_RUNS = 256` of them (`bus_health.rs`), evicting the
  oldest. A test pins the eviction. The per-bus totals keep counting
  so the bus-health panel's number does not fall, but the evicted
  episode's marker is gone from the plot, the trace and the Events
  panel.
- **The runs reach the views as derived notes, whole, once a second.**
  `spawn_bus_health_emitter` renders the runs with `runs_as_events`,
  puts them in the notes store through `replace_derived`, and emits
  `notes-changed` with the **entire** note list; `PlotPanel` builds its
  timeline events from that list, `EventsPanel` lists it, the trace's
  event rows read it. ADR 0035 §"held in RAM per session … views fetch
  the whole event set" is the rule the cap serves.
- **Nothing persists.** The runs live only in the coalescer; a restore
  from cache starts with none, and the frames that would rebuild them
  are in the capture.
- **No other event kind is capped this way.** Authored notes and
  message-bound comments are bounded by the user; the only other run
  cap is undelivered-transmit runs at 4096.
- **The signal cache already has everything a paged, rebuildable,
  bounded-serve series needs**: per-key pyramids of `(t, value)`
  samples folded 8→1 by min/max (`fold`), a serve that picks the
  coarsest level whose count in the window still exceeds the point
  budget (`window`), catch-up from the capture off the UI thread under
  a deadline (ADR 0048, 0049), hardening on the flush tick and at exit,
  restore keyed on the capture identity, the retention cap and the
  sweep (ADR 0002, 0047). Its record is 16 bytes and its fold keeps a
  bucket's min and max.

## Rulings

- **Page the bus-error markers** (owner, 2026-09-23).
- **On the existing pyramid machinery** (owner, 2026-09-23). Overseer's
  reading, settled from the code: each bus's error stream is a
  **derived series whose value is the cumulative error count on that
  bus** — one level-0 sample per error frame, `(t, running total)`.
  The series is monotone, so the min/max fold keeps each bucket's
  first and last sample, the exact totals at the bucket's edges, at
  every level; the serve is `slice_many` with the view's point budget;
  any two consecutive served points are an exact episode — count is
  the value difference, span the time difference, rate follows — at
  whatever level the window chose. No new record, no new fold, no
  level index on the wire.
- **The Events panel keeps bus errors as a paged section** (owner,
  2026-09-23), read from the same series through the windowed
  primitive.

Settled by the overseer, open to reversal:

- **The key.** A new `SignalOrigin` variant for the error series, keyed
  on the bus like a DBC signal, with a fixed signal name; not listed in
  the signal catalog or the Signals panel in this task (plotting it as
  a stepped "errors on bus X" line is a natural follow-up — backlog).
- **The 1 s gap goes.** Level selection is what thins a busy window;
  a marker per served point, labelled from the deltas. No display-time
  merge rule.
- **Markers, not rows, in the trace.** The derived bus-error events
  leave the trace's event rows: error frames are already trace rows,
  and the trace's collapse-error-frames option is its episode view.
- **Bus-health totals are unchanged**: ingest keeps its counters. The
  coalescer, `MAX_RUNS`, `runs_as_events` and the once-a-second
  `notes-changed` broadcast of derived events go; the notes store holds
  authored events only.
- **ADRs.** ADR 0035 amended: detector-derived events are a windowed
  series family served by the signal cache; authored events stay whole.
  ADR 0002 names the error series among the derived families.

## Open questions

(none — ruled 2026-09-23.)

## Phases

1. **Host: the error series.** The `SignalOrigin` variant and its
   decoder on the catch-up path (an error frame is one sample carrying
   the bus's running total); catch-up, persistence, restore and sweep
   verified by tests over a generated capture (50,000 error frames on
   two buses: bounded serve at every budget, exact deltas across
   levels, restore rebuilds off the UI thread with the pending state,
   a clear drops it); the coalescer, `MAX_RUNS`, `runs_as_events` and
   the derived-notes broadcast removed, bus-health totals kept and
   tested; a windowed command (or `slice_many` through the existing
   plot serve) the frontend can call per bus set and window. ADR 0002
   and ADR 0035 amended here, since the host is where the rule changes.
2. **Plot markers.** `PlotPanel`'s bus-error markers come from a
   windowed query over the series per visible range, one marker per
   served point labelled with count, span and rate from the deltas;
   the Events chip's kind checklist still lists bus errors; DOM tests
   (a window over 50,000 errors renders a bounded marker set; zooming
   in resolves it; labels carry the deltas).
3. **Events panel and trace.** The Events panel's bus-error section as
   a paged gridview over the series (windowed primitive, ADR 0044);
   derived events leave the trace's event rows; README's events,
   bus-health and trace passages; `docs/CONTEXT.md` if a term is
   coined.

## Exit criteria

1. A capture with more than 256 bus-error episodes shows every episode
   on the plot at the zoom where it resolves; nothing is evicted.
2. The series is a signal-cache pyramid: persisted with the others,
   restored with the capture identity, rebuilt from the capture off
   the UI thread when absent, swept and capped like them — host tests.
3. Any window is served within the point budget at every level, and
   consecutive served points give exact count and span — host tests
   across three levels.
4. `MAX_RUNS`, the coalescer and the whole-list derived-note broadcast
   are gone; authored notes still broadcast as before; bus-health totals
   unchanged — tests.
5. Plot markers, the Events panel's paged bus-error section and the
   trace behave per § Rulings — DOM tests.
6. ADR 0035 and ADR 0002 describe the series family; README matches.
7. Tests cover 1–5.

## Blockers / side effects

(none yet)

## Status log

- 2026-09-23 — opened from the owner's observation; the 256 cap found
  (`MAX_RUNS`); owner ruled paging, the existing pyramid machinery and
  a paged Events section; the cumulative-count series settled by the
  overseer.
