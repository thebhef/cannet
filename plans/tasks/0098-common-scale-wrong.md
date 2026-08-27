# Task 98 — Signals Render Wrong on a Common Scale

> **Status 2026-08-23 — code-complete, awaiting acceptance.** Landed
> 2026-08-21 on the chain (nothing has merged), investigation-first as
> instructed: one hypothesis confirmed, three refuted. The four exit
> criteria are walked in the status log, all met. Queue item 1.1 — the
> fix reverses an ADR 0026 decision — was accepted 2026-08-24
> (*"accepted. rm this item"*). 3.4 (the suite pinned the rule that
> produced this defect) was routed 2026-08-26 into
> [task 126](0126-test-and-example-cleanup.md) § 3 — the wrong-rule-pin
> audit, plus a manual-y-limits row for this task's verification
> matrix. Nothing is owed here.

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

## Status log

### 2026-08-21 — (branch `task-98-common-scale`)

Branched from `task-93-source-comment-refs` (`46ae0ffd`). Two commits:
`d0caa998` (the investigation's fix + tests + ADR amendment) and this
status log.

#### Observation (raw data)

Owner, from 0.9.0 use: a signal whose data spans **-200..0 A** renders
as **-1.5..0**. Ratio ≈ 133:1, not a round power of two or ten.

#### Experiment 1 — reproduce deterministically, and instrument the boundary in the same run

A throw-away printing test (deleted before commit) mounted a real
`PlotPanel` over the existing `PlotPanel.dom.test.tsx` harness — mocked
uPlot, mocked `sample_signals` / `signal_min_max` — with two synthetic
signals on one area:

- `BigAmps`: samples `[-200, -100, 0]`, host extent `-200..0`
- `SmallSig`: samples `[-1.5, -0.75, 0]`, host extent `-1.5..0`

For every live uPlot instance it printed the **two ranges the task file
asked to be compared**: the row's normalised extent (what the series was
normalised against) and what that extent **reads as** when mapped back
through that axis's own tick labels at splits 0 and 1 (what the series
is drawn against). A series whose two ranges agree reads back as its own
data; one whose ranges disagree does not.

The matrix was 3 y-axis modes × 5 unit/order shapes, plus a
**control** — the -200..0 signal plotted alone — in every mode.

Data (`reads as`, per drawn row):

| Shape | unified | per-unit | individual |
| --- | --- | --- | --- |
| both `A` (same unit) | -200..0 / -1.5..0 ✅ | ✅ | ✅ |
| `A` then `V` | -200..0 / **-200..0** ❌ | ✅ | ✅ |
| `V` then `A` (small first) | **-1.5..0** / -1.5..0 ❌ | ✅ | ✅ |
| both unitless | -200..0 / **-200..0** ❌ | **❌** | ✅ |
| both unitless, small first | **-1.5..0** / -1.5..0 ❌ | **❌** | ✅ |
| CONTROL: big alone | -200..0 ✅ | ✅ | ✅ |

The `V`-then-`A` unified row is the owner's observation verbatim: the
-200..0 A series reads as **-1.5..0**, both endpoints and the sign.

#### Hypotheses, and what the data did to them

1. *"The series is normalised against one range and drawn against
   another"* (the task file's named candidate) — **confirmed**, with the
   qualification that the two ranges are never crossed for the *same*
   signal: `effective.get(key)` feeds both the normalise and the label
   lookup. They diverge **across** signals, because the normalise was
   per **scale group** while the labels come from **one** group's range.
   The same-unit control discriminates: one group, one range, correct on
   every mode.
2. *"The resample path's min/max for the visible window is not the range
   used"* — **refuted**: the control (the same signal, same fetch path,
   same follow-live host extent, alone on the axis) reads back exactly
   -200..0. Nothing about the sampling changes between the passing
   control and the failing case; only what else is on the axis does.
3. *"A unit or factor/offset error"* — **refuted** by the ratio moving
   with the fixture. `-200 / -1.5 = 133`, and it is 133 only because the
   companion signal happens to span -1.5. Give the companion a different
   amplitude and the ratio follows it. It is not a scale constant; it is
   the accidental ratio of two co-plotted signals, which is exactly why
   it is not round.
4. *"`unified` is the only mode that breaks"* — **refuted** by row 4 of
   the matrix: two **unitless** signals reproduce it on a `per-unit`
   axis too. `deriveAxesForArea` groups them onto one axis by their
   (empty) unit, while `scaleGroupKey` gave each unitless signal a
   private scale — so the axis derivation and the scale grouping
   disagreed about what a group is. This is the shape most likely to hit
   real data: a DBC that declares no unit is the common case.

#### Root cause

An axis could carry **more than one scale**, but only **one** set of
tick labels. `PlotArea`'s normalise mapped each series to [0, 1] through
`groupScaleRanges` (per unit group, unitless signals each their own
group), while the y-axis label formatter mapped tick positions back
through `primaryAxisRef` — the primary signal's range, or the axis's
first ranged signal's. Every group but that one was therefore drawn
against a range nothing on screen stated. Confirming data: experiment 1,
rows 2–5 above, where the printed normalised extent (`0.0000..1.0000`)
and the axis label range disagree; and rows 1 and 6, where they agree
and the reading is correct.

#### Fix

`groupScaleRanges` / `scaleGroupKey` are replaced by `axisAutoRange`:
one range per axis, the union of every visible series on it, which is
the range the axis labels. Separating series too different to share a
scale is what the y-axis *mode* is for (`per-unit`, `individual`), not a
second scale hidden under one set of labels.

That reverses ADR 0026's unified row and un-rejects its "one global y
scale in unified mode" alternative, so the ADR is amended in the same
commit — status line, decision text, the alternative's bullet (kept,
annotated with why it was adopted and why it was reversed), the
implementation-status bullet and the consequences. `docs/CONTEXT.md`'s
glossary dialogue and ADR 0043's one aside follow. **This is a
deliberate behaviour change beyond a bug fix and should be read as
one**: overlaying a 0–1 SOC with a ±300 A current in `unified` mode now
flattens the SOC instead of scaling it to fill the canvas. Recorded
under `## Blockers / side effects`.

#### Falsification of the fix itself

The new tests were run against the pre-fix sources (HEAD copies of
`plotData.ts` and `PlotArea.tsx` written over the tree, then restored)
to confirm they fail for the right reason:

- `holds for two units on one area, unified` — **failed**:
  `expected -1.5 to be close to -200`
- `holds for two unitless signals on one area, unified` — **failed**,
  same assertion
- `holds for two unitless signals on one area, per-unit` — **failed**,
  same assertion
- `numeric: one axis draws one scale, whatever units its series carry` —
  **failed**: `expected 1 to be close to 0.0526…` (the degC series
  filling the canvas instead of sitting on the shared 10..200 scale)
- the other six (`same unit` on all three modes, `two units` on
  per-unit and individual, `two unitless` on individual) — **passed**
  pre-fix, and still pass. They are the control: they discriminate a
  fix from a test that merely asserts whatever the code does.

#### Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **2430 passed / 185 files** (baseline 2421; +9 from
  the new panel tests, `plotData`'s count unchanged as its describe was
  rewritten in place).
- `npx vite build` — clean.
- `git grep -Ein "task [0-9]|plans/" -- apps/ crates/` — no matches (the
  `comment-references` CI job).
- No Rust touched, so no cargo gate was needed. The render-tier perf
  harness was not run (the overseer owns it).

#### Exit criteria

| Criterion | Verdict | Earned by |
| --- | --- | --- |
| A deterministic reproduction exists as a test, failing before the fix | **met** | `PlotPanel.dom.test.tsx` → `a drawn series reads as its own data`; three of its nine cases fail pre-fix with `expected -1.5 to be close to -200` |
| Root cause stated with the confirming experiment's data | **met** | Experiment 1's matrix above — the normalised extent and the axis label range printed side by side, agreeing on the control and disagreeing on the failing shapes |
| Rendered amplitude matches the data on every `YAxisMode` | **met** | The same nine cases: 3 modes × (two units / two unitless / same unit), each asserting every drawn row reads back as its own data |
| A shared normalisation boundary gets a test for the *class* | **met** | The assertion is general — *every* series on *every* live axis must read back as its data — not a check of the one pairing; `plotData.test.ts` → `axisAutoRange` pins the boundary itself (one range per axis, whatever the units) |

## Blockers / side effects

- **`unified` mode no longer scales each unit group to fill the axis**
  (2026-08-21). Fixing the defect meant giving an axis exactly one
  scale, which reverses a decision ADR 0026 took deliberately: a 0–1
  SOC overlaid with a ±300 A current in `unified` mode now draws the
  SOC as a flat line at the bottom instead of scaling it to fill the
  canvas. The ADR is amended rather than contradicted, and the
  alternative's bullet keeps both the original reasoning and the
  reversal. This is the trade the exit criteria ask for — "a signal's
  rendered amplitude matches its data on every `YAxisMode`" cannot hold
  while an axis carries a scale it does not label — but it is a
  behaviour change beyond a bug fix and the owner may want the ruling
  confirmed. `per-unit` and `individual` cover the overlay case the old
  behaviour bought.
- **Nothing in the suite caught the defect.** With the old sources, all
  2421 tests passed; the two `plotData` tests that encoded the old rule
  ("different units scale independently", "unitless signals do not
  share a scale with each other") asserted the behaviour that produced
  it. The amplitude a series is *drawn* at and the range its axis
  *labels* were never compared to each other at any tier. The new
  panel-tier assertion is that comparison, and it is the thing worth
  keeping.
