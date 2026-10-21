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

4. **Paused y holds until asked** (owner 2026-10-20, after trying the
   repro: "I don't like the implicit autoscale when stopped — if we're
   not in follow-live, we should only autoscale on demand"). With
   follow-live off the axis keeps **the range it was showing when
   follow-live went off** across pan and zoom. It changes only on
   demand: Fit Y (on-screen extent, phase 2's scan), Fit Data (full
   refit of x and y), or a manual bound. A plot that starts paused (a
   project saved that way, a fresh import) seeds the hold once from
   the first served data so it is not blank. Follow-live on is
   unchanged. ADR 0026's automatic-range paragraph amended.
   → verify: pause, then zoom/pan — the axis does not move; Fit Y fits
   the window; Fit Data refits; turning follow-live off causes no jump.
   **Fit Y skips pinned axes** (owner 2026-10-20): an axis with a
   manual min or max is left exactly as set; only unpinned axes refit.
   After a Fit Y, a notice shown for **5 seconds** names the pinned
   axes it left alone; nothing is shown when none is pinned. Owner
   observation on the repro: today Fit Y unpins an axis only on the
   **second** click — the first clears the stored bounds, but the fit on
   that tick still reads the old bounds through `yScaleRef`, which
   updates on the next render, and a paused plot has no next tick. The
   skip rule removes that path; a test covers single-click Fit Y on an
   unpinned axis.

5. **Drop the notice; add an "ignore manual axes" toolbar chip**
   (owner 2026-10-20). A toggle chip with a simple icon (a pin with a
   slash), pressed while on. While on, every manual min/max is
   **ignored, not cleared**: each axis draws and fits as automatic (the
   paused hold, Fit Y, follow-live behave as on an unpinned axis);
   turning it off restores the pinned bounds untouched. Persisted with
   the panel config like the other toolbar chips. The 5-second Fit Y
   notice from phase 4 is removed; Fit Y still skips a pinned axis
   while the chip is off.
   → verify: pin an axis, toggle on — it fits with the rest and Fit Y
   refits it; toggle off — the pinned bounds apply again, unchanged.

## Exit criteria

- Paused: the y range holds what follow-live last showed (or the
  first served data when the plot starts paused) until Fit Y, Fit Data
  or a manual bound; Fit Y is the min/max of the samples on screen.
- Follow-live: unchanged (all-time extent).
- Manual min and max pin the axis exactly, in per-unit mode with more
  than ten signals, with the SNA spike present; a bound survives
  dismissing the menu by clicking elsewhere.
- The y-axis menu lists max above min.
- The "ignore manual axes" chip, while on, makes every axis automatic
  without clearing a bound; off restores them. No Fit Y notice.
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
  out of scope by the owner's opening ruling (SNA handling is not this
  task); the queue entry filed for it was withdrawn 2026-10-20. No code
  touches the classification. Frontend lanes green (3953 tests); no
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
- 2026-10-20 — **Owner rulings after the repro:** manual limits are
  good; the implicit per-tick autoscale when paused is not wanted —
  paused autoscale is on demand only; hold = the range showing at the
  moment follow-live went off. Fit Y skips pinned axes and names them in
  a 5-second notice. Observation: unpinning via Fit Y takes two clicks
  today. Phase 4 groomed above; launched 2026-10-20.
- 2026-10-20 — **Phase 4 landed** (8889b5ec). Paused y holds what the
  last follow-live tick drew (`heldRangesRef`, decoded unit); a missing
  entry seeds once from the on-screen samples, a partial serve seeds
  nothing; Fit Data clears the hold. Fit Y leaves an axis with a manual
  min or max untouched and the toolbar names the skipped axes for 5 s.
  Two-click cause confirmed by test: a paused plot's memoised request
  answered "unchanged", so the fit never redrew — Fit Y now redraws from
  the cached window. ADR 0026 and README amended. Frontend lanes green
  (3965 tests). FYI: the per-area fit y button on a pinned axis does
  nothing and shows no notice (only the toolbar's does).
- 2026-10-20 — **Re-squashed** to one commit 3a65abe5 on `fix-plot-y-scale`
  (pre-squash tips 4a946585, 8889b5ec); `doc-closeout-2` restacked.
  Every exit criterion met; awaiting acceptance (queue § 4).
- 2026-10-20 — **Owner ruling:** drop the 5-second notice; add an
  "ignore manual axes" toggle chip (simple icon) whose on state ignores
  manual bounds without clearing them. Phase 5 groomed above; launched.
- 2026-10-20 — **Phase 5 landed** (248dd05c). The Fit Y notice is gone.
  An "ignore manual y bounds" chip (`pin-off` icon, pressed while on)
  makes every axis automatic for draw, paused hold and Fit Y without
  writing `axisScales`; off restores the stored bounds unchanged. The
  y-axis menu still edits the stored bounds and says they are ignored.
  Saved sparsely as `ignoreManualY` like `showPoints` (no schema bump).
  ADR 0026, README and the prototype icon inventory amended. Frontend
  lanes green (3968 tests).
- 2026-10-20 — **Re-squashed** to one commit 6b4bf445 on `fix-plot-y-scale`
  (pre-squash tips 3a65abe5, 248dd05c); `doc-closeout-2` restacked.
  Every exit criterion met; awaiting acceptance (queue § 4).
