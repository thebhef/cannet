# Task 169 — Plot y Scale: On-Screen Fit and Manual Limits

Owner feedback 2026-10-20, from real use on a per-unit area with more
than ten same-unit signals, one of them carrying a J1939-style SNA raw
value (0.5 °C/LSB, raw 255) that spikes to a huge physical value:

- the auto y scale does not scale only what is on screen; it spills
  over;
- manually set y limits feel out of order (max belongs on top, min on
  the bottom) and do not scale correctly when the SNA is present.

SNA handling itself is out of scope. The plot behaviour is the task.

## What the code does today

| State | Auto y source | Where |
| --- | --- | --- |
| follow-live on | the host's all-time per-signal extent (`signal_min_max`) | `PlotArea.tsx` resample; ADR 0025 |
| follow-live off | min/max of the **served slice** = visible window ± 20 % (`FETCH_MARGIN_FRACTION`) | `PlotArea.tsx` resample |
| Fit Y | min/max of the same served slice | `PlotArea.tsx::fitY` |

The y-axis menu (`YAxisScaleMenu`) lists min above max, commits a bound
on Enter or blur, and is dismissed on `mousedown` outside
(`useDismissableMenu.ts`).

## Grooming notes

- 2026-10-20 — **Owner ruling: follow-live y behaviour stays as is**
  (the all-time extent, ADR 0025). Only the paused / zoomed fit and
  Fit Y change.
- Hypotheses for the manual-limit failure, to be falsified in phase 1
  (neither reproduced from reading alone):
  - **H1** a value typed in a bound field and committed by clicking
    elsewhere is lost: the menu closes on `mousedown`, which can
    unmount the input before `blur` fires. The existing test presses
    Enter only.
  - **H2** a signal whose `VAL_` table has two or more entries (for
    example `254 Error`, `255 SNA`) is classified enum
    (`isEnumValueTable`, ≥ 2 members) and in per-unit mode is pulled
    onto the enum-lanes axis, where min/max is inert and the unit axis
    never sees it.

## Phases

One branch, `fix-plot-y-scale`, beneath `doc-closeout-2`; phases land
as commits on it and are squashed to one before submit.

1. **Manual limits** (investigation then fix). A synthetic per-unit
   fixture — twelve same-unit signals, one with raw-255 spikes at
   0.5 °C/LSB — in the dom tests; falsify H1 and H2 and any further
   cause found; fix what reproduces, test first.
   → verify: with both bounds set the axis draws exactly `[min, max]`
   whatever the data holds; a bound committed by clicking away
   persists.
2. **Paused fit and Fit Y use the visible window only**: the min/max
   scan covers samples inside `[xMin, xMax]`, not the ± 20 % margin.
   ADR 0026 (and 0025 where it describes the paused fit) amended.
   → verify: a spike just past either edge of the visible window does
   not set the scale; follow-live unchanged.
3. **Menu order**: max above min.

## Exit criteria

- Paused / zoomed: the auto y range and Fit Y are the min/max of the
  samples on screen; a spike off screen does not set the scale.
- Follow-live: unchanged (all-time extent).
- Manual min and max pin the axis exactly, in per-unit mode with more
  than ten signals, with the SNA spike present; a bound survives
  dismissing the menu by clicking elsewhere.
- The y-axis menu lists max above min.
- Tests cover each of the above; ADR 0026 / 0025 and the README match.

## Status log

(empty)
