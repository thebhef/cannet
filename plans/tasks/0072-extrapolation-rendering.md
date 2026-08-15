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

**Styling ruling (2026-08-14, owner picks off the prototype bench —
supersedes "groomed here"):**

- **Lines and hlines**: extrapolated stretches render dashed,
  pattern **[6, 4]** (px on/off), same color and width as the solid
  data-backed stroke. Applies to interior >10×-gap stretches, the
  past-the-end tail, and both wings of a one-sample hline.
- **Lane tiles**: the extrapolated stretch keeps its normal fill
  (colormap tint or default) with diagonal stripes in the **app
  background color** over it, at a **20 px horizontal period, exact
  50 % duty**. Geometry note from the prototype: a 45° stroke's
  horizontal footprint is lineWidth·√2, so even bands need
  `lineWidth = period / (2·√2)` — a naive `period/2` makes the
  stroked color eat ~71 % of each period.
- **Labels**: an enum label overlapping a striped stretch gets a
  background-color shadow (stacked passes toward opacity); the
  light theme needs roughly double the dark theme's strength
  (owner call after side-by-side).
- A tile only partially extrapolated stripes only the stale
  sub-stretch; the label sits wherever the tile's normal label rule
  puts it.
- Ratified on canvas mockups drawn with the real `theme.ts`
  palettes — the final composite (dash [6,4], 20 px stripes,
  theme-tuned shadow) was confirmed by the owner **on both themes
  as rendered**; the implementation phase still delivers true
  renderer screenshots for final sign-off.

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

## Owner ruling on the catch-up fix shapes (2026-08-15)

Shapes 1 and 3 are both adopted ("1 and 3 seem worth doing"):

- **Shape 1 — batch the chunk scan across a serve's groups** — lands
  as this task's phase 5: one shared scan pass feeds every group's
  cursor per serve, so per-group throughput no longer divides by the
  area's group count. Contained; ADR 0049's budget semantics keep
  their meaning.
- **Shape 3 — move catch-up off the serve path** — is
  architecture-scale and opens as **Task 77** (background decode
  progression independent of view fetches), slotted after task 76;
  it must not gate this task's closure.
- Shape 2 (scale the budget with group count) is rejected — it
  preserves the redundant scanning and grows serve latency with
  signal count.

## Status log

- **2026-08-15, phase 1 (`task72-p1-hover-points`, branched off
  `task71-p1-perf-isolation`):** §3, the hover-points regression.

  **Verdict: the introducing change is `61379f88` (PR #282,
  "feat(gui): serve categorical signals by runs, not by extremes") —
  the 63–68 batch, _not_ the task-70 chain.** Neither prime suspect is
  implicated: the auto point-marker floor and the lane over-paint are
  what the surviving markers ride on, not what removed the missing
  ones.

  - _Observation (raw)._ Owner: the underlying signal plot's
    per-sample points on hover are gone; what still renders is points
    at the transition points only, across every enum lane.

  - _Hypothesis._ Nothing in the frontend renders points as a function
    of hover except uPlot's own per-series cursor point, which is
    placed at the merged x column nearest the pointer
    (`uPlot.esm.js`: `closestIdx(valAtPosX, data[0], i0, i1)`), for
    every series at once. "Per-sample points, on hover, on all lanes"
    and "transition points only, on all lanes" are therefore the same
    mechanism seen before and after a change to **what the lane's x
    columns are** — i.e. the serve stopped carrying a point per
    sample. Falsifiable: if the enum-lane serve still carried one
    point per sample, no change to the columns would exist to see.

  - _Experiment (bisect by pickaxe, not by build)._ `git diff
    68252eb1..HEAD` (pre-task-70 batch tip → task-70 chain tip) over
    the marker/hover seams — `PlotArea.tsx`, `plotPoints.ts`,
    `plotData.ts`, `index.css` — carries exactly two marker-relevant
    changes, both additive (`applyAutoPointFloor`; the one-sample
    hline in `mergeSeries`) and neither able to remove a column. The
    same walk over the 63–68 batch surfaced `61379f88`, which routes
    an enum-lane fetch to `SignalCache::window_categorical` →
    `signal_sampler::reduce_transitions`. Reading the two reducers
    side by side: `decimate_min_max` returns its input **unchanged**
    when `n <= max_buckets`, while `window_categorical` ran
    `reduce_transitions` unconditionally — so the same window that a
    numeric axis gets whole, a lane axis gets as run boundaries.

  - _Data._ Serve-seam test, written first, three held runs of 100
    samples at a 600-point budget (`signal_cache.rs`,
    `a_categorical_window_within_the_budget_keeps_every_sample`):
    **`left: 4, right: 300`** — four points (three transitions plus
    the series' last) where 300 samples were served before `61379f88`.
    Renderer-seam falsification, same shape from the other side: with
    the panel suite's fake host modelling the unconditional reduction,
    the lane's drawn x columns are **`[0, 4, 8, 11]`** against the
    twelve sample times.

  - _Fix (`188ef0bc`)._ `window_categorical` returns the raw window
    when it already fits `max_points` — the reduction is how an
    over-budget window is made to fit, and applied to one that already
    fits it buys no points while costing the only record of where the
    samples are. Counting the window before slicing keeps the
    not-fitting case `O(log n)` rather than materializing a whole
    capture. `61379f88`'s reason to exist is untouched: above the
    budget the reduction still runs, and its three tests
    (`..._keeps_every_code_and_transition_above_the_budget`,
    `..._coarsens_a_huge_window_without_losing_held_codes`,
    `..._coarsens_when_transitions_exceed_the_budget`) are unchanged
    and green. Task 70 phase 5's auto point floor and phase 6's
    attribution are untouched — nothing here reverts them, and the
    markers they govern are the ones the owner still sees.
    Rustdoc corrected in the same commit where it claimed the run
    boundaries are "the whole of what such a renderer draws"
    (`signal_sampler.rs` module doc, `Reduction::Runs`,
    `window_categorical`).

  - _Guard (`cb36f25c`)._ The panel suite's fake host now models the
    real reduction (whole window below the budget, run boundaries
    above it) — test-fixture honesty in the phase-5 sense, without
    which a lane served as four boundaries is invisible in what the
    plot draws — plus a DOM test that a within-budget lane window
    draws a column per sample.

  - Host: `cargo test -p cannet-gui` 657 passed / 6 ignored; clippy
    `--all-targets` clean; `cargo fmt --check` clean. Frontend: 161
    test files / 2117 tests passed; `tsc --noEmit` and `pnpm build`
    clean.

- **2026-08-15, phase 2 (`task72-p2-scroll-disconnect`, branched off
  `task71-p2-median-gating`):** §4, the scroll-after-disconnect
  regression.

  **Verdict: the original guard was never deleted — it was widened.**
  `24803ea8` (PR #120) froze the follow-live clock when the data edge
  stopped ("the clock holds when the data stops rather than
  extrapolating past a dead stream"), and its regression test was named
  for this exact case. `c6b7ab3b` (PR #123) replaced the freeze with a
  `maxLagSeconds` prediction ceiling — for a real reason — and relaxed
  that test in the same commit to permit the coast the ceiling allows.
  The test has passed ever since while the live surface disagreed with
  what the owner remembers being fixed. Fixed at the ceiling
  (`17b24533`).

  - _Observation (raw)._ Owner: "the plot panel continues scrolling
    after disconnect. I _know_ we bugfixed that one at some point and
    I'm guessing something got deleted." Reproduced on the ~18:40 build
    carrying the full task-70 chain.

  - _History (pickaxe, per the task's lead)._ `git log --follow` over
    `followWindow.ts` gives five commits. `git log -S "followLive &&
    running"` / `-S "runningRef"` surface `81178fbf` (PR #63) — "only
    slide the trailing x-window while running" — which is a _stopped
    trace_ guard, still intact, and not this. The disconnect guard is in
    `24803ea8`, whose `advanceLiveEdge` carried, verbatim:

    > Advancing here is what made a disconnected trace keep sliding —
    > the clock gained elapsed time each update while the pull only
    > clawed back a fraction, so the window crept to equilibrium
    > instead of stopping.

    with `if (ext === edge.lastExt) return { ...edge, wallMs: nowMs };`
    — a hard freeze — and the test `"stops dead when the data edge
    stops"` ("Disconnect with the trace still running… the window must
    not move at all"). `git diff 24803ea8 c6b7ab3b` over the test file
    shows the whole trade: the freeze re-anchored `wallMs`, discarding
    the elapsed time since the previous call, which _rewound_ the edge
    once per extra plot area per tick — so `c6b7ab3b` replaced it with
    a `maxLagSeconds` ceiling and rewrote the test to
    `"stops dead once the data edge has stopped"`, asserting only that
    the coast is `<= maxLagSeconds` and then exact. Nothing was
    deleted; the assertion was widened past the symptom.

  - _Hypothesis._ Nothing else in the panel moves the window on a dead
    stream: `runningRef`/`followXWindow`'s `running` guard is intact,
    the host's live edge is a running max (`RawStore::max_ts`,
    `c6b7ab3b`) that cannot advance without frames, and the "unchanged"
    fetch path still reports to `onAreaResampled`. So the continued
    scroll is `advanceLiveEdge`'s forward prediction spending its
    `maxLagSeconds` budget, and the window should come to rest
    `maxLagSeconds - targetLagSeconds` past the last frame.
    Falsifiable: if the panel's applied right edge stopped inside a
    tick or two of the last frame, the mechanism would be elsewhere.

  - _Data (panel-level DOM measurement, test written first and watched
    fail)._ One area, follow-live, capture growing with real time, then
    the frames stopped. Last frame at **60.385 s**. The right edges the
    panel pushed into uPlot from +500 ms to +1000 ms after the stop:
    **60.585 → 60.653 → 60.723 → 60.788 → 60.858 → 60.925 → 60.993 →
    61.061** — 0.068 s per 67 ms tick, i.e. **0.95–1.0 s per second, at
    full scrolling rate, already 0.2 s past the newest frame at the
    start of the sample and still climbing.** Ceiling arithmetic for
    the shipping tuning: `ext - targetLag(0.3) + maxLag(2)` = **1.7 s
    past the last frame**, reached after ~2 s of continued scroll.
    Hypothesis confirmed, magnitude attributed.

  - _Fix (`17b24533`)._ The forward prediction stops at the newest
    frame there is (`predicted <= ext`), not at `maxLagSeconds` past
    the data. `maxLagSeconds` goes back to its one job — the tolerance
    for a clock that has fallen _behind_, where a generous value is
    right because the alternative is a visible resync jump — and the
    lead the smoothing filter may hold _while data is arriving_ is
    untouched (that is the other clamp, on the data-carrying path; it
    keeps `maxLagSeconds`, and the "smooths jittery arrival" /
    "never strands the window ahead of the data" tests pin it). The
    window now comes to rest with the last frame on its right edge —
    the resting place, not a budget. Task 75 phase 1's `catchingUp`
    latch is untouched: it gates the _resample loop_, this gates where
    the _window_ may slide to, and a catch-up serve still fills the
    window while it holds.

  - _Guard._ `"comes to rest on the last frame instead of sliding on
    past it"` (`PlotPanel.dom.test.tsx`) — panel-level, because "the
    plot keeps scrolling" is a claim about the window the panel pushes
    into uPlot, not about the clock's arithmetic. It watches the
    applied right edges over half a second after the frames stop and
    requires every one of them to be the same value _and_ to sit no
    further out than the last frame. Verified red against the
    pre-fix `followWindow.ts` (0.067 s of drift inside the sample) and
    green after. It is harder to widen than the unit test that was
    widened before it: the unit test's assertion was a tolerance
    (`<= maxLagSeconds`), which relaxes by editing a number, while this
    one is "these values are all equal, and none is past the data" —
    there is no tolerance in it to grow. The unit test
    `"stops dead once the data edge has stopped"` is tightened back in
    the same commit, from a `maxLagSeconds` budget to the resting place
    (`toBeCloseTo(10, 9)` on the newest frame), with a realistic
    non-zero target lag.

  - _Side effect found and fixed in the same commit (fixture
    honesty)._ Two fetch-cadence tests grew the window's last timestamp
    (`mockSampleBounds.last`) without growing the session frame count.
    Only the count reaches the fetch key as "there are frames you have
    not seen" (`useDecimatedRange`'s `windowKey`), so with the window
    at rest those fixtures left every tick on the memo's unchanged fast
    path: `"backs the fetch loop off…"` measured **0 real fetches and 0
    accumulated render cost** in its measurement second, and
    `"grows to the default width…"` never saw its step from 0.4 s to
    60 s at all. Both now grow the count too, as a frame append does.
    Worth recording as a property of the fix: the window's forward
    motion is now driven entirely by frames arriving, and in the app
    the frame count and the live edge move together, so a fetch that
    would reveal nothing new is one the memo is right to skip.

  - Frontend: 161 test files / 2118 tests passed; `tsc --noEmit` and
    `pnpm build` clean. No host code touched.

- **2026-08-15, phase 3 (`task72-p3-enum-lag`, branched off
  `task72-p2-scroll-disconnect`):** §1, the enum leading-edge lag.

  **Verdict: REPRODUCED at the serve seam, and attributed. The drawn
  leading edge of an enum-lanes axis falls behind by ~50–56 % of the
  window and its absolute lag grows monotonically, while the numeric
  axes of the same panel sit exactly on the live edge. The cause is
  not the categorical reduction and not any frontend consumer — it is
  that `CATCH_UP_SERVE_BUDGET` is spent per _serve_, a serve is one
  plot **area**, and per-unit mode puts every enum on the panel onto
  one shared lanes axis.** No fix landed: the fix is a budget /
  scheduling change against ADR 0049's bounded-serve contract, which
  sprawls past an investigation phase. Proposed shape recorded below.

  - _Observation (raw)._ Owner: on a full-trace view growing live, the
    enum lanes' leading edge falls behind by roughly a constant
    fraction of the window — ~2/3 observed — reaching hours on a long
    capture; observable "on a live bus if you collect for long enough
    with enough signals". Task 70 phase 6's rig at 5400 s / ~20 signals
    measured drawn-vs-served 0.000 and did not reproduce it.

  - _Hypothesis 1 (the owner's lead, refuted by reading)._ A consumer
    maps a relative index rather than a timestamp, so a sparse series
    covers only its fraction of the axis's merged columns. Falsifiable
    by finding such a consumer. **Refuted:** the only count-vs-index
    crossover in the whole plot path is `enumSegments`'
    `Math.min(ts.length, vs.length)`, and its two callers pass arrays
    built in the same statement as `u.data` (`laneRawRef.current` is
    assigned from `mergeSeries`' rows immediately before `u.setData`),
    so `vs` is never short. Everything downstream is timestamps:
    `enumSegments` ends its final segment at `ts[n - 1]`, `mergeSeries`
    sample-and-holds with no trailing `null`, and `drawEnumTiles` maps
    through `valToPos`. **A lane is therefore drawn to its axis's last
    merged column — the freshest series on the axis — and cannot fall
    short of what was served.** (That is task 70 phase 6's extent
    overdraw, read from the other side.) The host half is timestamps
    too: `sample_signals_inner` slices on `from_seconds`/`to_seconds`,
    and `window_categorical` reaches the newest sample through
    `level_points` (phase 6, 20/20 exact).

  - _Hypothesis 2._ If the render cannot lose the edge and the serve
    reaches the newest **decoded** sample, then the lag is the decode
    cursor: ADR 0049's bounded catch-up, in the regime phase 6's
    experiment B did not cover — a capture still _growing_, at the
    owner's "enough signals". Falsifiable: if a growing capture's
    served edge converged on the tip however many signals were asked
    for, the mechanism would be elsewhere.

  - _Experiment A (growing capture, chunk-at-a-time floor)._ 32 message
    groups (8 enum + 24 numeric), a 200 000-frame store grown by a
    fixed number of frames before each serve, served through the real
    `slice_many` with `new_chunk_at_a_time` — the deterministic worst
    case of exactly one `CATCH_UP_CHUNK_FRAMES` chunk per group per
    serve. Lag is `capture tip − newest served point`, worst series.

    | growth / serve | round 0 | round 5 | round 11 | trend |
    | --- | --- | --- | --- | --- |
    | 2 000 | 91.9 % | 53.6 % | 12.2 % | converging |
    | 8 000 | 92.1 % | 60.4 % | 33.6 % | converging |
    | 16 000 (≈ chunk) | 92.4 % | 66.8 % | 49.9 % | absolute lag flat |
    | 24 000 | 92.7 % | 71.4 % | 59.7 % | **absolute lag grows** |
    | 48 000 | 93.4 % | 79.9 % | **74.7 %** | **absolute lag grows** |

    **The signature is real: above one chunk of growth per serve the
    shortfall stops converging and settles at a constant fraction of
    the window** — 74.7 % and still falling toward its 65.9 %
    asymptote (`1 − 16384/48000`) at growth 48 000, with the absolute
    lag climbing every round. The reported "~2/3" is in this family.
    **But the enum and numeric lags were bit-identical in every one of
    these rows**, because at the chunk floor group count buys nothing —
    so this alone is not the owner's enum-selective report.

  - _Experiment B (the group-count asymmetry, with the shipping
    budget)._ The panel shape per-unit mode actually produces: **one**
    lanes axis carrying every enum, beside several small per-unit
    numeric axes, each area serving on its own
    `CATCH_UP_SERVE_BUDGET`. A 1 500 000-frame store grown by 100 000
    frames before each round; the big axis served `Runs`, the four
    4-group axes `MinMax`. Drawn-edge lag is the _freshest_ series on
    the axis — what `mergeSeries`' union makes the last column, i.e.
    what the lane tiles are actually drawn to.

    | round | capture | big axis (16 groups) drawn edge | as % of window | small axes (4 groups) drawn edge |
    | --- | --- | --- | --- | --- |
    | 0 | 1600.0 s | 780.8 s | 48.8 % | 780.8 s |
    | 1 | 1700.0 s | 798.9 s | 47.0 % | **0.0 s** |
    | 2 | 1800.0 s | 882.5 s | 49.0 % | 0.0 s |
    | 3 | 1900.0 s | 966.1 s | 50.8 % | 83.6 s |
    | 4 | 2000.0 s | 1049.8 s | 52.5 % | 0.0 s |
    | 5 | 2100.0 s | 1133.4 s | 54.0 % | 0.0 s |
    | 6 | 2200.0 s | 1217.0 s | 55.3 % | 0.0 s |
    | 7 | 2300.0 s | 1284.2 s | **55.8 %** | 0.0 s |

    **The owner's report, in numbers: the lanes axis's drawn leading
    edge sits half the window behind and its absolute lag grows by
    83.6 s every serve, while the numeric axes of the same panel are
    exactly on the live edge.** 83.6 s is `growth (100.0 s) − one chunk
    (16 384 frames = 16.4 s)` — the starved groups advance exactly one
    chunk per serve and lose the rest.

  - _Falsification (the reduction is not the cause)._ Same run with the
    reductions **swapped** — the 16-group axis served `MinMax`, the
    four 4-group axes served `Runs`. The 16-group axis still lags
    (993.8 s → 1267.8 s, 62.1 % → 55.1 %); the 4-group axes still
    converge to 0.0 s. **Control**, every area at 4 groups: the big
    axis behaves like the others (67.2 % → 9.9 % → 19.5 %) and both
    kinds converge together. **The lag follows the area's message-group
    count, not the render mode.** Enum lanes are hit because
    `deriveAxesForArea` "pull[s] every enum onto one shared enum-lanes
    axis" while numerics group by unit — so the lanes axis is
    structurally the area with the most message groups on the panel.

  - _Root cause._ `slice_many` catches its queried caches up under one
    `CATCH_UP_SERVE_BUDGET` per serve, and a serve is one plot area.
    `catch_up_keys` walks that area's `(message_id, extended)` groups
    and lets each run chunks until the shared deadline, guaranteeing
    every group only **one** `CATCH_UP_CHUNK_FRAMES` chunk — so an
    area's per-group catch-up throughput falls as its group count
    rises, and each group re-scans the same store rows through its own
    `matching_frames_indexed` pass. Once the capture grows by more than
    a chunk between two serves of that area, its groups lose
    `growth − chunk` frames each serve, forever. The decoded prefix —
    and with it the served window, the merged x-column union and the
    drawn tile extent — settles at a constant fraction of the capture
    while the absolute lag grows without bound. "With enough signals"
    is _enough enums on the one lanes axis_; "collect for long enough"
    is the absolute lag growing with the capture. Two penalties
    compound on the same axis: the lanes axis has the most groups, and
    being the panel's most expensive area `plotPacing` gives it the
    longest idle time between serves — which is exactly the `growth`
    term.

    The owner's lead was right in kind and wrong in place: the index
    that produces a proportional time shortfall is the catch-up's
    **frame-index cursor**, which advances a fixed number of frames per
    serve however much wall clock those frames span — not an extent
    taken from a consumer's point count.

  - _Proposed fix shape (not landed — sprawls)._ Per-group catch-up
    throughput must not degrade with an area's group count. Three
    candidates, in ascending order of reach: (a) scan **one** chunk of
    store rows for the whole batch and dispatch the decoded frames to
    every group that wants them, instead of one `matching_frames_
    indexed` pass per group over the same rows — makes throughput
    independent of group count, but rewrites the plan/scan/apply
    interleave ADR 0048 pins; (b) scale the serve's budget with the
    batch's group count — three lines, but it multiplies a 16-lane
    axis's serve latency by four and so re-opens ADR 0049's
    "a serve is bounded in time"; (c) move catch-up off the serve path
    entirely into a background pass, which is the architecturally right
    answer and the largest. All three are owner/ADR decisions, not
    investigation-phase edits. The `catch_up_keys` rustdoc is corrected
    here in the same commit, where it claimed a signal after an
    expensive one "is never starved of progress" — the data says the
    guarantee is one chunk per serve, which _is_ starvation once the
    capture outruns it.

  - Host: `cargo test -p cannet-gui` 657 passed / 6 ignored; clippy
    `--all-targets` clean; `cargo fmt --check` clean. No behavioural
    change in this commit — rustdoc only.

## Blockers / side effects

- **The enum leading-edge lag is attributed but NOT fixed** — phase 3
  stopped at the attribution because the fix is a budget/scheduling
  decision against ADR 0049's bounded-serve contract, not an
  investigation-phase edit. The mechanism, the confirming data and
  three candidate fix shapes (batch the chunk scan across a serve's
  groups; scale the budget with the group count; move catch-up off the
  serve path) are in phase 3's status entry. It needs a phase of its
  own and an owner call on which shape. Until then a per-unit panel
  with many enum lanes on a fast, long capture draws those lanes a
  growing fraction of the window stale.
- **Marker _visibility_ on a lane axis is still governed by uPlot's
  density rule.** Phase 1 restored the per-sample columns; whether a
  marker is painted on them is a separate gate — uPlot's `auto` rule
  reads the axis's merged column count, `applyAutoPointFloor` only
  rescues a series of at most 32 samples, and `drawEnumTiles` paints
  0.65–0.75-alpha tiles over whatever markers do land in the band.
  A lane dense enough to lose the density test therefore still shows
  no sample positions. That is the separate exit criterion "enum lanes
  show their sample positions (markers or equivalent)" and belongs to
  the §2 phase; it is recorded here so the two are not confused.
- **`max_points == 0` still run-reduces a categorical window**, where
  the numeric serve of the same request returns the raw slice. Left
  as-is: no plot fetch reaches it (`MIN_DECIMATION_POINTS = 200` is
  the floor `PlotArea` asks with), and changing it is outside §3.

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
