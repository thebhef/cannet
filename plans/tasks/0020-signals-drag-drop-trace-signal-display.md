# Task 20 — Signals, Drag/Drop & Trace Signal Display

The DBC panel + signal drag/drop across the GUI ship in **Task 12**;
the per-series colour picker ships in **Task 15**. What's left for
this task is the **signal view** panel (a user-chosen set of signals
with their latest values — distinct from the DBC panel, which is a
database navigator) and the **trace view's expanded-row decoded
signals as inline lines under the message row** (replacing today's
expand-to-show grid — the trace-side counterpart to "signals are
first-class").

Additionally, address:
- poor DBC panel performance with a large DBC (500+ messages - we should generate a more complex EV example including BMS, inverter, and a few other nominal ECUs)
- FZF search in the DBC view doesn't hide items that don't match the filter string. With large DBCs it's difficult to actually find the highlighted filter-matching items.

**ADR cleanup:** scrub task-number references out of
[ADR 0020](../../docs/adr/0020-filter-defined-plot-areas.md) (its
signal-view mention) — ADRs describe what *is*; task tracking lives
here, not in the ADR.
