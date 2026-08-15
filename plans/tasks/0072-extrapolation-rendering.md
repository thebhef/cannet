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

- **2026-08-15, phase 4 (`task72-p4-extrapolation-rendering`, branched
  off `task72-p3-enum-lag`):** §2, the ruling — extrapolation-aware
  rendering, with the two in-scope companions.

  **Delivered: host-side classification by the owner's two tests, dashed
  lines, hatched lane tiles, theme-tuned label halos, lane sample
  markers, and the extent overdraw labelled rather than cut. ADR 0026
  amended and its "never drawn past its data" phrasing reconciled.** The
  screenshot set is **blocked** — see below.

  - _Classification, host-side (`1d46968e`)._
    `SignalCache::extrapolated_spans` implements the two tests: a
    stretch not bounded by a sample on each side (before the first,
    after the last, and both wings of a one-sample series), and a gap
    past `EXTRAPOLATION_GAP_FACTOR` (10) × the series' typical raw
    interval. The typical interval is the reciprocal of the cache's
    existing `rate()` — the whole series' raw cadence, two reads and a
    subtraction. Whole-series rather than in-window deliberately: the
    window this matters most in is the one that is _mostly_ gap, where
    an in-window mean is dragged up by the very gap it is judging.

    **The design constraint is carried by a second step, not by the
    interval.** A candidate gap is confirmed against level 0
    (`window_count`) — every served point's timestamp is a real raw
    sample time at whatever level it was read from, so a count above one
    means decimation dropped points the series has. That is what makes a
    coarse-zoom window come back empty. Falsified, not assumed: with the
    confirmation stubbed out, the coarse-zoom test's 20 000-sample
    uniform 1 kHz series comes back with **160 extrapolated spans**
    covering the whole window — exactly the failure the constraint
    names. Each of the other two rules was falsified the same way (gap
    threshold stubbed → the interior test's stall goes unlabelled;
    leading wing stubbed → the one-sample series reports one span
    instead of two).

    Cost: `O(served points)` plus one `O(log n)` confirmation per
    _candidate_ gap — none at all on a window served at raw resolution,
    which is the live case until the window holds more samples than the
    renderer has pixels. Nothing here scales with capture length, so the
    serve's cost class is unchanged; the gate is what confirms it.

  - _Wire._ `SIGSAMP\x02` → `\x03`, a per-signal `(count, [from, to]…)`
    list after each signal's points. It rides the serve rather than
    travelling as its own query because it is a fact about the very
    window being answered — a second round trip could only disagree with
    it. Three encoders had to move in lockstep (`sampling.rs`, and the
    two test mirrors in `plotData.test.ts` / `useDecimatedRange.test.ts`,
    plus the panel suite's fake host).

  - _Lines, dashed (`1d46968e`)._ `splitExtrapolatedRows` blanks each
    stretch out of the merged row — so uPlot's own stroke stops at the
    data — and returns the column stretches to re-stroke.
    `drawExtrapolatedSegments` strokes them `[6, 4]` in the series' own
    color and width. Two shapes needed care:
    - **An interior stretch gets a midpoint column minted for it**
      (`mergeSeries`). Both its ends are samples this series needs, so
      neither may be blanked; with no other series contributing a column
      in between there is nothing to blank at all, and the stretch would
      stay solid.
    - **A span only draws where something is drawn today.** A
      multi-sample series' pre-first-sample gap stays a gap: a dash
      there would be _new ink_, not honest ink. The one-sample hline is
      where both wings do fire, because `mergeSeries` holds its value
      across every column.

    The cursor/legend readout is unaffected by the blanking: uPlot's
    legend is off and the side panel reads `valueAt` on the raw
    per-signal series, not on `u.data`.

  - _Lane tiles, hatched (`1b8913b6`)._ **A lane cannot take the line's
    treatment.** `enumSegments` ends a run at a `null`, so blanking a
    lane row would _delete_ the stale tile rather than mark it — and a
    lane's held state is information whether or not the signal is still
    arriving. So a tile axis keeps its row whole (`extrapolatedRef` is
    empty there) and `drawEnumTiles` hatches the stale sub-stretch of
    each tile: 45° stripes in `theme().background`, 20 px period, exact
    50 % duty via `lineWidth = period / (2·√2)` — the prototype's
    geometry note, pinned by a test asserting the property
    (`lineWidth·√2 === period/2`) rather than the formula. Stripes are
    anchored to the canvas, not to each tile, so two touching tiles
    continue one another's pattern instead of putting a double band on
    the join. A partially stale tile stripes only the stale part
    (`stripedOverlap`).

  - _Labels._ A label over hatching gets a `theme().background` halo,
    stacked `fillText` passes toward opacity. Strength is a **per-theme
    number** (`Theme.laneLabelShadowPasses`: dark 2, light 4, lighthk 4)
    rather than a branch on the theme name — the file's stated extension
    model is "adding a theme is adding a `Theme` to `THEMES`", and a
    name branch would have silently treated `lighthk` as dark.

  - _Lane sample markers (companion 2, `1b8913b6`)._ The three
    mechanisms reconciled by **removing** one of them: a tile axis sets
    `points: { show: false }` and draws its own markers over the tiles.
    uPlot's layer was never going to serve a lane — its `auto` rule
    reads the _axis's_ merged density, and a shared lanes axis carries
    every enum's samples at once, so one fast lane suppresses every slow
    one; `applyAutoPointFloor`'s ≤32 floor rescues only a handful-sample
    series; and whatever survived both was painted over by 65–75 %-opaque
    tiles. Two competing mechanisms became one. `laneSampleMarkerIndices`
    selects the in-view samples, thinned to the same `MAX_POINT_MARKERS`
    cap a line's `on` mode uses, always keeping the newest.
    `showPoints: "off"` still means off.

  - _Extent honesty (companion 1)._ The overdraw is exactly what the
    trailing-span rule labels: `the_stretch_past_a_series_last_sample_is_extrapolated`
    at the host seam, `"blanks an extrapolated stretch out of the solid
    stroke"` and `"enum lanes: keeps a stale lane's row whole so the tile
    survives to be hatched"` at the panel seam, and the dash/hatch of it
    at the canvas seam.

  - _A renderer test tier that did not exist (`1b8913b6`)._
    `PlotPanel.dom.test.tsx` mocks uPlot to a stub with no canvas, so
    **everything the draw hook paints has always been unpinned**. That is
    tolerable for tiles; it is not tolerable for this feature, where a
    stretch blanked out of the stroke and then not re-drawn has been
    _deleted_ rather than labelled — and no existing test could tell the
    difference. `PlotArea.draw.test.ts` drives the two exported draw
    functions against a recording 2D context that carries the style state
    each ink call was made under (a dash set and reset two calls later
    says nothing unless you know which stroke it was in force for).

  - _ADR 0026 amended (`1b8913b6`)._ The extrapolation rule, the styling,
    and the lane-marker rule are recorded. The "**never drawn past its
    data**" phrasing is reconciled by saying what the code does: the
    sample-and-hold has never obeyed it — a merged row carries its last
    value to the end — and that overdraw is worth keeping, so the ADR now
    says a series _is_ drawn past its data and the stretch where it is
    says so. The _leading_ half of the rule stands unchanged.
    `theme.ts`'s "not painted from here" comment on `background` is
    corrected in the same commit: the hatching paints it.

  - _Screenshot-harness isolation fixed (`a680eb1b`)._ Task 75 phase 3's
    recorded gap: `spawn_gui` launched with `--project` alone, against
    the operator's real user scope. Wrong in both directions — it
    **writes** it (window geometry alone means a capture moves the
    operator's window next time they open the app) and it **reads** it,
    which makes the picture a function of whoever ran it. The reading
    half is what blocked the theme: the theme is a user-scope setting
    resolved at boot and the shipping app has no flag for it (nor should
    it — the harness photographs the shipping app), so a run that does
    not own its profile cannot choose what it photographs. The capture
    now passes `--app-data-dir` at a directory it owns, defaulted beside
    `--out-dir`, and seeds `{"theme": …}` into that profile _before_ the
    launch; seeding after would photograph the previous run's theme. Only
    that key is seeded, so everything else comes up at the shipping
    default. Launch args split into `gui_args` so the isolation is
    testable without running a GUI. README's determinism section grew the
    fifth lever.

  - _Screenshots: **BLOCKED, no shots produced.**_ The harness needs a
    binary with the frontend embedded (`tauri build --no-bundle`), and
    the only release binary in the tree is `target/release/cannet-gui.exe`
    dated **2026-08-14 23:01** — about ten hours _before_ this phase's
    first feature commit (`1d46968e`, 2026-08-15 08:44). Photographing it
    would produce a set showing the pre-feature rendering, which is worse
    than none. Producing the set needs a release rebuild of the current
    tip, which this phase was instructed not to do. The isolation fix
    above is landed and tested, so the set is one `tauri build
    --no-bundle` plus two `screenshot --theme dark|light` runs away
    whenever a build is sanctioned. Correctness does not depend on it:
    the DOM and canvas tests carry it, and the owner's ratification was
    already taken on canvas mockups drawn with the real `theme.ts`
    palettes.

  - Host: `cargo test -p cannet-gui` 661 passed / 6 ignored;
    `cargo test -p cannet-perf-measurement` 45 passed; `cargo clippy
    --workspace --all-targets` clean; `cargo fmt --check` clean.
    Frontend: 162 test files / 2148 tests passed (from 161 / 2117 at
    phase 1); `tsc --noEmit` and `pnpm build` clean.

- **2026-08-15, phase 5 (`task72-p5-batched-catchup`, branched off
  `task72-p4-extrapolation-rendering`):** the owner's **shape 1** — batch
  the chunk scan across a serve's groups.

  **Delivered: a serve's budget is spent in _rounds_ across the batch's
  message groups instead of down the list, so per-group catch-up
  throughput no longer divides by an area's group count. ADR 0049
  amended to say so.** Shape 3 (task 77) is untouched and the seam for
  it is unchanged: the rotation lives entirely inside `catch_up_keys`,
  which is still the one place a serve catches its caches up.

  - _What the redundancy actually was._ Phase 3's attribution called the
    per-group passes a re-scan of "the same store rows". Read at the
    seam, that half is wrong and worth correcting: `fetch` is
    `TraceStore::matching_frames_indexed`, which jumps through the
    always-on by-id index, so a group materializes **only its own
    message's frames** and two groups' fetches over one chunk range are
    disjoint. There was no duplicated fetching to remove. The defect was
    entirely in **allocation**: `catch_up_keys` ran group after group,
    each looping chunks until the shared deadline, so the first group
    (whose own frames are a fraction of the span, hence cheap per chunk)
    could run dozens of chunks while every group after the one that
    exhausted the budget got the guaranteed single chunk — and one chunk
    per serve is what a capture growing faster than a chunk outruns
    forever.

  - _The fix (`880eb5f9`)._ The batch is planned once, under one lock
    hold (`plan_batch`, groups in `(message_id, extended)` order rather
    than hash order), and then advanced in rounds: every group still
    behind the tip scans one `CATCH_UP_CHUNK_FRAMES` chunk
    (`advance_group` — the same plan/scan/apply interleave ADR 0048
    pins, now one chunk per call), and the budget is checked **between
    rounds**. Per-group throughput is then independent of group count,
    because the frames a round materializes are the frames of that chunk
    of capture however many groups they are split between. The
    completeness token is untouched and still truthful: it is computed
    the same way, by comparing each queried cursor with the tip this
    serve read, and a partial catch-up still reports `complete: false`.
    Serve time stays bounded — the overrun is one round rather than one
    chunk, and a round materializes about one chunk's frames.

  - _Straggler policy (pinned by its own test)._ Each group scans from
    **its own** cursor, so the rotation is not a common frontier: a
    signal joining an area whose other signals are current does not drag
    them back, and they do not hold it at the frontier. A group that
    reaches the tip **drops out of the rotation**, so the rest of the
    serve flows to whoever is behind —
    `a_straggler_takes_the_budget_the_caught_up_groups_no_longer_need`
    asserts the newcomer takes three chunks of a three-round budget
    (not one), that the caught-up groups keep their place, and that the
    serve issued fetches for the straggler's message only.

  - _Regression test, written first and watched fail
    (`a_many_group_batch_converges_on_a_capture_growing_faster_than_a_chunk`)._
    Phase 3's experiment B in minimal deterministic form: eight message
    groups on one area (one dense message carrying half the capture,
    seven sparse ones — the shape a lanes axis has), a capture growing
    by 1.5 chunks per serve, and a per-serve budget of two rounds. It is
    deterministic because the budget is expressed in **frames the scan
    materializes** — the quantity the shipping wall clock is spending —
    through a test-only `ServeLimit::Frames`; production still builds
    `ServeLimit::Deadline` off `CATCH_UP_SERVE_BUDGET`, so ADR 0049's
    "time, not work" reason is intact.

    | serve | tip | cursors before the fix | worst lag | cursors after |
    | --- | --- | --- | --- | --- |
    | 1 | 57 344 | 49 152 / 57 344 / 16 384 ×6 | **40 960** | 32 768 (all eight) |
    | 2 | 81 920 | 81 920 ×5 / 32 768 ×3 | **49 152** | 65 536 (all eight) |
    | 3 | 106 496 | 106 496 ×8 | 0 | 98 304 (all eight) |
    | 4 | 131 072 | 131 072 ×8 | 0 | 131 072 (all eight) |

    Before the fix the starved groups advance exactly one chunk (16 384)
    per serve against 24 576 of growth, so the worst group's lag **grows
    8 192 per serve** while the budget drains the front of the list one
    group at a time; the groups sit at four different cursors after the
    first serve. After it, all eight sit on the same cursor after every
    serve and the lag falls by exactly `budget − growth` = 8 192 a
    serve — 24 576 → 16 384 → 8 192 → 0. The test asserts all three:
    equal cursors, strictly decreasing lag, tip reached.

  - _ADR 0049 amended._ "Check the deadline between steps… always take at
    least one step" described the per-group spend whose floor was one
    chunk; it now reads as the round, with the anti-starvation rule
    stated as the property that was actually violated (a batch's
    per-group throughput must not divide by its group count) and the
    consequences for a per-unit panel's lanes axis, for a joining
    signal, and for the per-round overhead. `catch_up_keys`' rustdoc
    carries the same in the code, replacing phase 3's correction; the
    module doc and `slice_many`'s doc say the budget is the serve's, not
    each message's. Two rotted intra-doc links to a
    `catch_up_group_chunked` that has not existed for some time are
    fixed to the function that does the work.

  - _Housekeeping (`feeb998f`)._ `plotEnumLanes.ts` carried a raw NUL as
    the tile-label cache key separator, which made `grep`, `file` and
    git treat the file as binary (and skip eol normalization — hence the
    one-time CRLF→LF churn in that commit; read it with
    `git show --ignore-cr-at-eol`). Same character, written as an
    escape.

  - _Screenshot scenario, stale step (`267c3e08`, orchestrator
    addendum)._ The visual-parity walk aborted at step 02 with `no dock
    tab "DBC"`. The rename to "Database" is only half of it: a
    singleton's title is a constant of the build that the app normalizes
    a restored layout against, so a step that clicks a tab title is a
    function of the rename history **and** of the project — `ev-demo`'s
    saved layout carries the Database and Settings panels, `ev-zonal`'s
    carries neither, so fixing the string alone would have left the walk
    aborting on the other example. Steps 02 and 03 now use the app's
    show-or-focus commands (activate when open, add when not), which is
    the same picture on a project that has them, and the now-unused
    `tab` helper goes with them. Guarded by
    `the_scenario_drives_labels_the_frontend_still_defines`: every label
    the scenario clicks must exist in the frontend source that defines it
    (`commands.ts` for palette labels, `App.tsx` for toolbar ones) —
    verified red against the old label. The rest of the scenario's labels
    were checked against the frontend and are current. Nothing else in
    the build tied the two sides together, which is how this rotted.

  - _Extrapolation screenshots: **NOT added — recorded as a blocker
    instead**, per the addendum's bound._ The scenario photographs an
    **idle** app (no `--connect-on-start`, no frames), and a plot can
    only show a dashed tail, an interior >10× stall, a one-sample hline
    or a striped lane if the session holds a capture with those shapes.
    Getting one in front of the lens needs, in order: a fixture capture
    carrying a stopped series, a stalled series, a one-sample series and
    a sparse enum; a DBC defining them; an example project whose
    per-unit plot area curates them; a way for the harness to import it
    without a native file dialog; and a deterministic x window. Each
    step is buildable — the most promising import route is that
    `handleImportTrace(presetPath)` already takes a path (that is how
    the toolbar's **Recent** menu opens one) and the recents list is a
    user-scope setting (`recent_blfs`), i.e. seedable into the profile
    the capture already owns and seeds `theme` into, after which the
    step is "click Recent, click the path" the way a user does. What
    stops it here is verification, not feasibility: none of that chain
    can be exercised without a `tauri build --no-bundle` of the current
    tip, which this phase was instructed not to run, and an unverified
    interactive step **aborts the whole capture run** — which is exactly
    the failure that was just fixed. Recommended slice for whoever
    sanctions the build: fixture + example project first (its own
    reviewable commit, since it also changes what `01-saved-layout`
    photographs if it lands in an existing project — prefer a project of
    its own), then the seeded-recents step, verified against a fresh
    build before it joins the shared scenario.

  - Host: `cargo test -p cannet-gui` 663 passed / 6 ignored (from 661 at
    phase 4 — the two new tests); `cargo test -p cannet-perf-measurement`
    40 lib tests passed (from 39 — the new scenario guard); clippy
    `--all-targets` clean on both; `cargo fmt --check` clean. Frontend
    untouched by the catch-up commit; 162 test files / 2148 tests passed
    after the housekeeping one.
    **This change is on the data path the ADR-0031 gate measures** — the
    gate is the orchestrator's task-end run, not this phase's.

- **2026-08-15, phase 6 (`task72-p6-extrapolation-shots`, branched off
  `task72-p5-batched-catchup`):** make the rendering photographable, and
  produce the sign-off set.

  **Delivered: a committed fixture carrying every ruled shape, a
  dialog-free capture scenario that opens it, and four PNGs (dark +
  light × two windows) in which five of the six shapes render as ruled.
  The sixth — the one-sample hline's _leading_ wing — was found drawing
  solid, attributed to a one-ended clamp in `splitExtrapolatedRows`, and
  fixed test-first. The shots predate that fix and photographing it needs
  a build this phase was not allowed to run.**

  - _The fixture (`a4854949`)._ `examples/extrapolation/`: 20 s, 871
    frames, ~5 KB, seven single-signal messages and nothing else. Six
    carry a ruled shape; the seventh (`RefLevel`, 50 ms throughout)
    exists **only to carry the window's right edge** — without a series
    that outlives the others, every other series' last sample _is_ the
    edge and there is no tail to draw. The generator is deterministic (no
    RNG, no wall clock), so the file is byte-identical across runs. The
    project puts all seven on one **per-unit** area, which is the mode
    that gives the enums a shared lanes axis, so one frame holds
    everything.

    Guarded from both ends, because these captures are **eyeballed rather
    than diffed** and nothing else in the build would notice a fixture
    that stopped exhibiting a shape.
    `the_screenshot_fixture_exhibits_every_ruled_extrapolated_shape`
    reads the committed BLF through the real reader, decodes it against
    the committed DBC, and asserts each series' classified spans over the
    photographed window — `StoppedLevel [(8, 20)]`, `StalledLevel
    [(6, 13)]`, `OneShotLevel [(0, 10), (10, 20)]`, `StoppedMode
    [(6, 20)]`, `StalledMode [(7, 15)]`, and **nothing** for `RefLevel`
    or `DenseMode`, the two controls. `parses_the_checked_in_
    extrapolation_example_project` keeps the project openable and its one
    area whole.

  - _The scenario (`632e02e5`)._ `--scenario extrapolation`, a second
    scenario rather than a step of the parity walk: the walk photographs
    an **idle** app on purpose, and this one needs data. The import is
    dialog-free because the file picker is a native dialog outside
    everything a page can reach — `--capture` is seeded into the run's
    own profile as `recent_blfs`, and the step opens it from the
    toolbar's Recent menu, which is the same import call with a path.
    The channel dialog's own defaults map the one BLF channel onto the
    project's one bus, so the step presses **Open**. No fixed sleeps: it
    waits for the dialog, then for the app's own "Loading trace…" to go
    away, because a shutter falling mid-import photographs a partial
    capture — whose series all end early, which is the very shape the
    scenario exists to show. Then **fit x axis**, which is what pins the
    window to the capture's whole extent. Follow-live is left on: with a
    static capture the newest frame is the fixture's last, so the window
    comes to rest where the fit put it (phase 2's ceiling fix is what
    makes that true).

    The label guard now walks **every** scenario and learned the second
    spelling the frontend has — a command or toolbar label is declared
    (`label: "…"`), a modal's button carries its text as JSX, matched as
    a line of its own. Verified red against a bogus modal label.

  - _Defect found by the photograph (`a874e4c9`)._ The whole point of
    taking the picture.

    - _Observation (raw)._ In `dark-02`, `OneShotLevel`'s hline runs
      **solid** from 0 to 10 s and **dashed** from 10 to 20 s. Measured
      on the PNG along the lit row: left of the sample, one unbroken run
      of 600 lit pixels, 5 px thick; right of it, 57 runs of 5 px on a
      10 px period — the `[6, 4]` dash. The ruling is that both wings
      dash.

    - _Hypothesis._ `splitExtrapolatedRows` clamps only one end of a
      stretch to the column grid: a span running past the newest column
      is drawn to that column (`found >= 0 ? found : xs.length - 1`),
      while a span starting before the oldest column is discarded whole
      (`if (i0 < 0) continue`). Both cases arise for the same reason —
      the fetch reaches past the visible x range while no series has a
      sample before the capture's first frame — so a _leading_ span
      routinely starts left of column 0. Falsifiable: if the function
      produced two dashed wings for a leading span that starts before
      column 0, the mechanism would be elsewhere (the spans not reaching
      the renderer, or the classification itself).

    - _Data._ The two inputs side by side at the unit seam. A leading
      span starting **exactly at** column 0 gives row `[7, null, 7, null,
      null]` and segments `[{0,2},{2,4}]` — both wings blanked and
      dashed. The same span starting **half a second earlier** gives
      `[7, 7, 7, null, null]` and `[{2,4}]` — solid left, dashed right,
      which is the photograph. Hypothesis confirmed; the classification
      and the wire are exonerated, and the host-side test above already
      pins that both spans are computed.

    - _Fix._ `Math.max(lastAtOrBefore(xs, a), 0)` — the same rule the far
      end already had. The rule it sits beside is unchanged and pinned by
      its own new case: a multi-sample series is still not drawn before
      its first sample, because its near-end column carries `null` and
      the stretch is skipped whole; a series whose first sample _is_
      column 0 has a leading span covering no column and is skipped by
      the existing `i1 <= i0`.

  - _Harness isolation, one layer down (`632e02e5`)._ Found the hard way:
    every capture run after **17:41:25 UTC** died at the attach with a
    bare `Connection refused`, on two different `--port`s, from a harness
    that had worked at 17:40. At 17:41:25 the operator's own
    `cannet-gui.exe` started, and its `WebView2` browser process holds
    `--user-data-dir=%LOCALAPPDATA%\dev.cannet.app\EBWebView` with no
    `--remote-debugging-port`. **`WebView2` keys its browser process by
    user data folder**, and the app's is a fixed path unaffected by
    `--app-data-dir` — so the capture's child was served by the browser
    process already running, and
    `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` was never applied.
    Falsification: give the child its own `WEBVIEW2_USER_DATA_FOLDER`
    inside the run's app-data directory and re-run the capture that had
    just failed, with the operator's app still open — it attached and
    wrote both PNGs. Same isolation argument phase 4 made for the app
    profile, one layer down; it lands in `gui_env` beside `gui_args` so
    it is testable without running a GUI, and it is the sixth determinism
    lever in the harness README.

  - _The set._ Four PNGs at 1600×1000, dark and light, from
    `target/release/cannet-gui.exe` as built at the tip of phase 5.
    `01-capture-imported` is the follow-live window the import leaves
    (10–20 s in both themes — a zoomed second view; its width is the
    panel's own, not a pinned one), `02-extrapolated-stretches` is the
    fitted 0–20 s sign-off frame. Read and checked, not just written.
    **Five of six shapes render as ruled** in both themes: the dashed
    tail (8 → 20 s), the dashed interior stall (6 → 13 s), the one-sample
    hline's trailing wing, the striped lane tail (`Running`, 6 → 20 s)
    with a haloed label, the partially striped tile (`Open`, striped
    7 → 15 s inside a tile spanning 3 → 20 s), and lane sample markers on
    all three lanes. The sixth is the leading wing above. Kept out of the
    repo, per the no-committed-review-artifacts rule.

    Side observation for the owner, not acted on: in the **light** theme
    the enum tile labels (`Idle`, `Active`, `Derate`, `Fault`) read much
    weaker against their colormap tints than the dark theme's do — the
    halo that makes a label survive hatching does not also make it
    survive a light tint. Visible in `light-02`.

  - Host: `cargo test -p cannet-gui` 665 passed / 6 ignored (from 663 at
    phase 5 — the fixture-shape and project-parse tests);
    `cargo test -p cannet-perf-measurement` 44 lib tests passed (from 40
    — the recents seeding, its JSON escaping, the scenario selector and
    the WebView2 profile); `cargo clippy --workspace --all-targets`
    clean; `cargo fmt --check` clean. Frontend: 162 test files / 2150
    tests passed (from 2148 — the two clamp cases); `tsc --noEmit` and
    `pnpm build` clean. No release rebuild, no perf-gate run.

## Blockers / side effects

- ~~**The enum leading-edge lag is attributed but NOT fixed.**~~ **Fixed
  in phase 5** (`880eb5f9`), by the owner's shape 1: the serve's budget
  is spent in rounds across the batch's message groups, so an area's
  per-group catch-up throughput no longer divides by its group count.
  Shape 3 (background decode progression, task 77) remains the
  architecturally right answer and is unaffected by this. See phase 5's
  status entry.
- ~~**Marker _visibility_ on a lane axis is still governed by uPlot's
  density rule.**~~ **Fixed in phase 4** (`1b8913b6`): a tile axis turns
  uPlot's point layer off and draws its own markers over the tiles, so
  the density rule, the ≤32 floor and the tile over-paint are reconciled
  by there being one mechanism instead of two competing ones. See phase
  4's status entry.
- ~~**The scenario cannot photograph the extrapolation rendering at
  all.**~~ **Fixed in phase 6** (`a4854949`, `632e02e5`): a committed
  fixture carrying every ruled shape, and a `--scenario extrapolation`
  that imports it without a native dialog (seeded `recent_blfs` → the
  toolbar's Recent menu → the channel dialog's own defaults) and pins the
  x window with **fit x axis**. Verified for real against the shipping
  binary, twice per theme.
- **The sign-off set predates the leading-wing fix, and re-shooting it
  needs a build this phase could not run.** The four PNGs were taken from
  `target/release/cannet-gui.exe` as built at the tip of phase 5, and
  phase 6 then found and fixed (`a874e4c9`) the one-sample hline's
  **leading** wing drawing solid. So five of the six ruled shapes are
  photographed as ruled and the sixth is photographed as the defect. The
  fix is landed and pinned at the unit seam; what is outstanding is one
  `pnpm --dir apps/gui tauri build --no-bundle` plus two
  `screenshot --scenario extrapolation --theme dark|light` runs, which
  now take about a minute each. **This is the owner/orchestrator
  decision left in this task**: sanction the rebuild, or accept the set
  with the leading wing read from the test rather than the picture.
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
