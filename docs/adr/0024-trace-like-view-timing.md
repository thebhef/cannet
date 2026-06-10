# ADR 0024 — Trace timing: session start, trace start, and how time renders

Status: accepted (2026-06-01)

## Decision

cannet has one **session buffer** and any number of **traces**
rendered over it. A trace is a series of messages — a window into
the session buffer. The trace view (the row-table panel) and the
plot panel are two renderers of a trace; they share one timing
model.

The model has two clocks and a derivation rule:

1. **The session buffer has a start time.** It is set when the
   session buffer starts and when it is cleared, and stored as
   wall-clock seconds (Unix epoch). A buffer that has never been
   started has no start time.

2. **Each trace has its own start time.** It may be `null`,
   which means "use the session buffer's start time" — and the
   trace tracks the session start as it changes. When non-`null`,
   it overrides; the trace's time column is rooted there
   instead.

3. **Time renders relative to the trace's effective start.** A
   row in a renderer displays `frame.timestamp − trace_start`,
   where `trace_start` is the trace's own start time if it has
   one, else the session buffer's start time. This is the only
   formula.

When the trace's start time is set:

- It is `null` by default (a freshly created trace).
- It is reset to `null` whenever the session buffer starts (and
  therefore on Clear, since Clear *is* a session-buffer start).
- It is captured to "now in session-relative seconds" on the
  trace's own *Clear*, and on *Start* after a *Stop*. Those are
  the actions whose semantics is "this is my new zero." Pause /
  Resume preserve it — they don't change the zero.

These rules apply uniformly to every trace. The trace view and
the plot do not have their own private notion of time.

## Why

A user looking at a 2 GB capture across four panels needs every
panel's time column to mean the same thing without explanation.
The session buffer owns the canonical timeline; traces render
windows over it. Letting traces diverge by mistake — a panel
showing 0.500 s when the next panel shows 47:13.500 for the same
frame — destroys that shared reference.

But there is a legitimate per-trace escape hatch: when the user
clicks *Clear* on a panel, or *Stop* then *Start*, the intent is
"re-zero the time column right here." The trace's own start time
is what carries that intent. Pause / Resume don't carry it —
those are about whether the buffer keeps streaming in, not
where zero is.

The two clocks combine to one number for rendering, every render,
from the current session start plus the trace's offset (if any).
That keeps the null-tracks-session behavior trivially correct: a
new session start instantly re-zeroes every trace that didn't
explicitly opt out.

## Mechanics

Host-side (`cannet-gui::trace_store`):

- `TraceStore` holds `session_start_ns: u64` and exposes
  `start_session(session_start_ns)` and a `session_start_ns()`
  reader. `start_session` is called by `clear_trace_store`
  (Connect / Open / toolbar Clear all go through it) and by the
  BLF replay pump on its first frame.
- `TraceStore::append` drops any frame stamped strictly before
  `session_start_ns`. This is the buffer-side guard: frames
  in-flight through the recv pipeline at the moment of Clear can
  arrive late with pre-Clear timestamps; they must not land in
  the new session.
- The `trace-grew` event carries `session_start_seconds`. The
  frontend treats it as the canonical session start.

Frontend (`apps/gui/src`):

- `TraceState.traceStartOffsetSeconds: number | null` is the
  trace's own start time, expressed as a delta from the current
  session start. `null` means "use the session start directly."
- `useTrace` derives `baseTimestampSeconds = sessionStart +
  (offset ?? 0)` every render. Every trace flows through this
  hook, so the rules apply uniformly across the trace view and
  the plot.
- `freshTrace(n)` / `clearedTrace(n)` default the offset to
  `null`. Per-trace *Clear* and *Start*-after-*Stop* capture
  `currentSessionOffsetSeconds(data)` (latest tip's
  session-relative time) into the offset. Pause / Resume /
  Stop preserve it.

## Invariants

These follow from the decision and must hold:

- **A trace's rendered time is never negative.** If it ever is,
  either the buffer-side guard let a stale frame in or a
  trace's offset survived past a session-buffer start. Both are
  bugs.
- **A `null` trace start tracks the session start live.** Setting
  the session start updates every `null`-offset trace in the
  same render.
- **A new session start always implies every trace's offset is
  reset to `null`** — the user has had no chance to express a
  per-trace re-zero against the new session yet.

## Consequences

- The trace view and the plot share `useTrace` and `TraceState`.
  Each is a renderer of a trace; the timing model belongs to the
  trace, not to the renderer. A new kind of trace renderer (e.g.,
  a future statistics overlay) plugs into the same hook rather
  than inventing its own clock.
- The frontend never holds an absolute "row 0 timestamp" of its
  own; whatever zero a trace shows is derived from the two
  numbers above on every render. There is no third source of
  truth to keep in sync.
- A trace's offset is *seconds from the current session start*,
  not a wall-clock timestamp. It does not need rewriting when
  the session start changes — the derivation re-evaluates
  against the new session start naturally. It does need
  resetting on session-buffer start, because the moment that
  produced the offset is gone.

## Rejected alternatives

- **Per-trace "row 0 timestamp" captured as wall-clock.** Was
  briefly used by the trace view (`baseTimestampSeconds`
  captured from the first row of the session buffer). Created a
  third source of truth that drifted from the session start,
  re-broke on every panel mount, and silently survived session
  restarts — a frequent source of negative-time bugs.
- **The trace view and the plot each owning their own clock.**
  Looks flexible; in practice produces panels that disagree
  about what time it is. The single shared abstraction is
  cheaper to reason about and cheaper to keep correct.
- **Re-zero on every Pause/Resume.** Conflates "stop streaming
  in" with "re-zero my view." Pause means "freeze what I'm
  looking at"; the time column should not jump under the user
  when they hit Pause and then Resume.

## See also

- [ADR 0005](0005-dockview-panel-layout.md) — the panel host
  these renderers run inside.
- [ADR 0007](0007-uplot-plot-renderer.md) — the plot renderer;
  this ADR governs *its* time column too.
