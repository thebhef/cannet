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

- 2026-10-20 — **Phase 1 landed** (175c90e6 on `fix-plot-y-scale`).
  H1 confirmed: a bound typed and then left by clicking outside the
  menu was lost (the outside `mousedown` unmounts the box before blur).
  Fixed: `useDismissableMenu` tells its caller why it closed; the
  y-axis menu commits changed drafts on an outside close and still
  abandons them on Escape. The 12-signal SNA fixture pins the axis to
  exactly `[min, max]` (not a cause). H2 is not a cause of the pinning
  failure but is real: a `VAL_` table with two sentinel entries
  (`254 Error`, `255 SNA`) makes the signal an enum, so in per-unit mode
  it leaves its unit axis for the enum lanes, where min/max is inert —
  owner decision (queue § 1). Frontend lanes green (3953 tests); no
  Rust or Python in the diff.
- 2026-10-20 — **Phases 2+3 landed** (b36eaf78). The paused auto range
  and Fit Y scan only samples inside the visible x-window
  (`plotData.ts::windowExtent`); a series with none on screen falls back
  to its served slice, a single sample is widened as before. Follow-live
  and the fetch margin unchanged. The y-axis menu lists max above min.
  ADR 0026 and README amended. Frontend lanes green (3960 tests).
  Left as is: a log axis's smallest-positive scan still covers the whole
  slice.
- 2026-10-20 — **Squashed** to one commit 4a946585 on
  `fix-plot-y-scale` (pre-squash tips 175c90e6, b36eaf78);
  `doc-closeout-2` restacked on it. Every exit criterion met; awaiting
  acceptance (queue § 4).
