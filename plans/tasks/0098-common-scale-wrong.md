# Task 98 — Signals Render Wrong on a Common Scale

Opened by owner instruction 2026-08-20, from 0.9.0 usage feedback:

> 0.9.0 still has signals not showing up on common scale correctly;
> observed a signal valued at -200A to 0 rendered as like, -1.5 to 0.
> this should include experiments to reproduce this behavior

**This is wrong data on screen** — the most serious item in the 0.9.0
feedback set. A reader takes a rendered trace at face value; a signal
drawn two orders of magnitude off its real amplitude is not a cosmetic
defect.

## Status: investigation-first, by owner instruction

"Still" implies a prior attempt did not fix it, so **no fix is
proposed here and none should be written before a reproduction
exists.** The owner asked explicitly for experiments. Follow the
scientific method: observation → hypothesis → experiment → data →
conclusion, recorded in the status log, and no root-cause claim
without the confirming experiment's data.

## The observation, as raw data

- Signal's real range: approximately **-200 to 0** (amperes).
- Rendered range: approximately **-1.5 to 0**.
- Mode: a **common scale** (`YAxisMode`; `plotAxisDerivation.ts`
  distinguishes `unified` / `per-unit` / `individual`) — the exact mode
  in use needs confirming with the owner or from the saved project.
- Version: 0.9.0.

The ratio is roughly 130:1, which is not obviously a unit or
factor/offset error and not an obvious power of two or ten — that
non-roundness is itself a clue and should not be hand-waved.

## Where to look (candidates, not conclusions)

- `resolveAxisRange` / `normalizeOnAxis` (`plotAxisScale.ts`) — data is
  normalised to `[0,1]` and mapped back through the axis range for
  display, so a series normalised against **one** range and drawn
  against **another** would produce exactly this class of error.
- `deriveAxesForArea` (`plotAxisDerivation.ts`) — how signals are
  grouped onto a shared axis, and which range that axis derives.
- The resample path — whether the min/max the host returns for a
  visible window is the range actually used.
- Whether the series in question shares an axis with a signal of very
  different amplitude, which is what "common scale" implies and is the
  obvious way two ranges get crossed.

## Experiments to run before proposing anything

1. **Reproduce deterministically** with a synthetic capture: two
   signals on one bus, one spanning -200..0, one spanning a small
   range, plotted on a common scale. If it reproduces, the bug is in
   the shared-axis path and the fixture becomes the regression test.
2. **Vary one factor at a time** from that fixture: same signal alone;
   both signals in `per-unit`; both in `individual`; same units versus
   different units. The mode that renders correctly bounds the defect.
3. **Instrument the boundary** — log the axis range the series is
   normalised against and the range it is drawn against, and compare.
   Equal ranges falsify the "two ranges" hypothesis outright.
4. Only if the synthetic fixture does not reproduce: get the owner's
   project and DBC, since something about the real data is then load
   bearing.

## Exit criteria (draft — firm at grooming)

- A deterministic reproduction exists as a test, failing before the fix.
- The root cause is stated with the experiment's data that confirms it.
- A signal's rendered amplitude matches its data on every `YAxisMode`;
  tested across modes, not only the one that broke.
- If the cause is a shared normalisation boundary, that boundary has a
  test that would catch the class of defect, not just this instance.
