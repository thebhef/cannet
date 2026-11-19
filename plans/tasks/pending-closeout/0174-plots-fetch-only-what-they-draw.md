# Task 174 — Plots Fetch Only What They Draw

> **Opened 2026-11-18** from the owner's report that the frontend kept
> dying on the TR03 rig, and the crash dumps and logs behind it.
> Implemented the same day.

## Why

A plot area samples and merges **every** signal on an axis, hidden or
not. Solo masks by setting `hidden`, so a panel holding hundreds of
signals behind a solo pattern still pays for all of them on every
resample, while it draws a handful.

The merge is the expensive half. `mergeSeries` builds uPlot's aligned
table: one x column, the union of every series' timestamps, and one
row per series across all of it. Signals from different messages
rarely share a timestamp, so the union grows with the signal count and
the table with its square. Hundreds of cell voltages on one per-unit
axis, at ~2 points per canvas pixel each, is hundreds of millions of
entries per merge.

## The session

TR03 rig (Kvaser Leaf, SN 20833), project `ct_string.cannet_prj`, plot
views with 576 solo-paged signals. 2026-11-17/18 PST:

| When (PST) | What |
| --- | --- |
| 11-17 16:45 → 17:27 | Fresh live session. Renderer 5 → 9 GB, JS heap 1 → 2.8 GB within minutes. |
| 11-17 17:27:50 | Renderer killed, out of memory (Crashpad `ptype=renderer`, `0xE0000008`). |
| 11-18 all day | JS heap cycles ~1.7 ↔ 2.8 GB on every 20 s sample; timer lag > 1 s about four times a minute, every hour. |
| 11-18 11:46:02 | Renderer killed: `v8-oom-memory-allocator-size=3143 MB` of `4192 MB` capacity — the V8 heap ceiling. |
| 11-18 11:46 / 11:54 / 12:08 | Each reload rejoins the session and is killed the same way within 15–21 s (3.6–3.8 GB of 4192 MB). |

The owner reports the crash reliably reproduces while a fresh launch
reloads the trace buffer: each restore step widens the window, and
each widening is a fetch and a full merge.

## Scope

1. **A hidden signal is not fetched.** The sample request and the
   follow-live extent query (`signal_min_max`) carry only the signals
   that draw. Hidden by the user or masked by solo, the same rule.
2. **A hidden signal costs the merge nothing.** It keeps its uPlot
   series slot (the instance is not rebuilt on a visibility change),
   and every series with no samples shares one empty row instead of
   allocating its own.
3. **Showing a signal fetches it.** A visibility change that reveals a
   signal the cached window does not hold is a real fetch, on a
   stopped capture too. One that only hides repaints from the cache,
   as before.

### Trade-off taken

Solo stepping used to be free: the window already held every signal,
so a step was a re-normalise and redraw (ADR 0026, "a visibility flip
repaints from the window the area already holds"). Now a step that
shows new signals is one host round-trip for them. That round-trip is
proportional to what is drawn; the old cost was proportional to the
square of what was held.

### Not in scope

- The merge's cost in what **is** drawn: many visible signals on one
  axis still build a signals × union table. Captured separately — it
  must not regress the plot's interpolation, appearance or scaling.
- `list_value_tables` is still one call per signal at mount (943 at
  one boot), hidden or not.
- What the host does when the renderer dies (task 175).

## Exit criteria

- [x] A hidden signal and a solo-masked signal are absent from the
      `sample_signals` request and from `signal_min_max`.
      *`PlotPanel.dom.test.tsx`.*
- [x] Un-hiding a signal on a stopped capture draws it without a pan or
      zoom. *`PlotPanel.dom.test.tsx`.*
- [x] A solo change still rebuilds no uPlot instance.
      *`PlotPanel.dom.test.tsx`.*
- [x] Series with no samples share one merged row.
      *`plotData.test.ts`.*
- [x] Docs: ADR 0026's solo paragraph says what is fetched.
- [ ] On the TR03 project, a fresh launch restores the capture with the
      576-signal plots open and the renderer survives. *Owner, live.*
