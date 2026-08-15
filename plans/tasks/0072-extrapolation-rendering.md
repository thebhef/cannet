# Task 72 — Extrapolation-Aware Plot Rendering + Enum Leading-Edge Lag

Opened by owner rulings 2026-08-14 out of Task 70's closeout review
(see 0070's "Owner rulings on the decision list" for the full
dialogue). Two halves, investigation first.

## 1. Investigation — enum lanes fall behind on a growing full-trace view

Owner observation (Task 70 item 3 obs. 1, clarified 2026-08-14): on a
**full-trace view growing live**, the enum lanes' leading edge falls
behind by roughly a constant fraction of the window — ~2/3 observed —
reaching **hours** on a long capture. "It can be observed on a live
bus if you collect for long enough with enough signals."

Constraints and leads, recorded from Task 70's phase 6:

- The serve is measured exact at 5400 s: categorical windows reach
  the newest sample (0.000 s in 20/20 measurements), and the numeric
  tail-splice defect found there is fixed (`cc8c1f7`). The rig's
  assembled-system run at 5400 s / ~20 signals on the fixed build did
  **not** reproduce this (drawn-vs-served 0.000, ms-scale edge lag) —
  so the repro needs longer collection, more signals, the owner's
  real composition, or a consumer the rig's gauges don't measure.
- **Owner-suggested lead**: a proportional shortfall (constant
  fraction of the window, growing with it) smells like something
  consuming **relative index rather than timestamp** — e.g. an
  extent mapped from point counts, where a sparse series covers only
  its fraction of the axis's merged columns.
- Reproduction tooling: the vbus rig + currency gauges (Task 63
  phase 1, runs re-exercised in Task 70 phase 6 — see both status
  logs in git history).

Scientific method in the status log; no fix without the attributing
experiment's data.

## 2. Ruling — extrapolated stretches render visibly as extrapolation

Owner ruling (2026-08-14, explicit, refined same day): **anywhere
the plot extrapolates** — not just the hline and enum lanes — the
stretch renders **differentiated**: dashed for lines, a
muted/hatched treatment for lane tiles. Data-backed stretches keep
the solid rendering. Nothing is cut; the information stays, honestly
labeled. Styling specifics (dash pattern, tile treatment) are groomed
here, in this task.

**The owner's two tests define an extrapolated section:**

1. A section **not bounded by a sample on each side** is
   extrapolation (covers past-the-last-sample, before-the-first,
   and both sides of a one-sample series).
2. A gap longer than **10× the series' typical sample interval** is
   extrapolation even between two samples — a stale interior
   stretch is extrapolation too.

Design constraint on test 2 (recorded at grooming): the typical
interval must come from the **raw** series cadence, which the
host-side cache/pyramid knows — never from the spacing of a
decimated serve, whose points sit a bucket span apart at coarse
levels and would classify every zoomed-out window as extrapolation.
Classification is therefore host-side (the model computes domain
facts; the renderer styles segments). Expected cost is O(window
points) beside a serve that is already O(window points) — no major
adverse perf impact expected; the exit-criteria gate verifies.

In-scope companions from the same attributions (Task 70 phase 6):

- The measured extent overdraw (a lane drawn to its axis's last
  merged column, 90 units past its own data in the controlled pair;
  3.36 s mean / 6.67 s max live) is what the differentiated rendering
  makes honest.
- Lane marker visibility: uPlot's density rule suppresses markers on
  lane axes, and `drawEnumTiles` (post-series `draw` hook) paints
  0.65–0.75-alpha tiles over interior codes' markers. Enum lanes
  must be able to show where their samples are.

## 3. REGRESSION — hover over an enum lane no longer shows the underlying plot's points

Owner observation (2026-08-14, reported after Task 70's closeout
review): "I don't see the points on the underlying signal plot when
mousing over enum lanes anymore." Previously, mousing over an enum
lane surfaced the point markers on the underlying signal plot; on the
owner's current build it does not. Owner refinement (2026-08-14,
second look, corrected): what still renders is points **at the
transition points only**, and **for all enum lanes** — i.e. the
markers that survive are the ones sitting on code changes, across
every lane, while the underlying signal plot's per-sample points on
hover are gone. Explicitly NOT "a transition flips some state that
makes it just work." Build confirmed (owner, 2026-08-14): a
~18:40 build carrying every code change to the top of the task-70
chain — so the defect is live on the newest code. Whether the
63–68 batch or the task-70 chain introduced it is still the
bisect's first question (the pre-task-70 batch tip is the other
leg to check).
Prime suspects to rule in or out with experiments, not assumption:
the auto point-marker floor (`applyAutoPointFloor`, task-70 phase 5)
and the lane marker suppression/over-paint mechanics recorded in
task-70 phase 6's attribution. Regression discipline: failing test
reproducing the loss first, then the fix.

## 4. REGRESSION — the plot keeps scrolling after disconnect

Owner observation (2026-08-14, same session as §3): "the plot panel
continues scrolling after disconnect. I _know_ we bugfixed that one
at some point and I'm guessing something got deleted." Reproduced on
the ~18:40 build carrying the full task-70 chain.

Investigation lead: find the original fix in git history first — a
first-pass `git log --grep` over disconnect/follow/scroll/freeze
wording did NOT surface it (2026-08-14), so pickaxe the code seam
instead (`git log -S`/`-G` over the plot's follow/tick machinery
and the disconnect path) — it
establishes the intended behavior, names the mechanism, and answers
whether its regression test was deleted with it or passes while the
live surface disagrees; either answer directs the fix. Regression
discipline: failing test reproducing the continued scroll first,
then the fix, and the walk records what happened to the original
guard.

## Exit criteria (draft — firm at grooming)

- The proportional leading-edge lag reproduced (or its
  non-reproduction bounded with data at owner-ratified length and
  composition); root cause attributed with the confirming
  experiment; fixed test-first if it is a defect.
- Extrapolated stretches visually distinct from data-backed ones in
  line, hline, and lane rendering, regression-tested at the renderer
  seam — with the owner's two classification tests (unbounded
  section; gap > 10× typical raw interval) each pinned by a test,
  including a coarse-zoom case proving decimated spacing does not
  false-positive.
- Enum lanes show their sample positions (markers or equivalent),
  tested.
- The hover-over-a-lane regression fixed: mousing over an enum lane
  shows the underlying signal plot's points again, with the
  reproducing test kept as the regression guard and the introducing
  change named in the status log.
- The scroll-after-disconnect regression fixed: disconnect stops the
  plot's follow scrolling; the original fix's fate (deleted guard vs
  guard passing while the surface disagreed) recorded; the new
  reproducing test stays as the guard.
- ADR 0026 (sparse-series render rules) amended to record the
  extrapolation-rendering rule; the "no series is drawn past its
  data" phrasing reconciled.
- ADR-0031 perf gate run on the final build (this touches the render
  hot path); all metrics, no baseline promotion.
