# Task 63 — Plot Usage-Feedback Round

Opened 2026-08-11 from owner usage feedback on the plot during live
use. Four items; captured, not yet groomed — each carries its open
grooming questions inline.

## Items

### 1. A baseline disclosure toggle

The ▾/▸ disclosure arrow for collapsing plot areas is far too small a
target — and this has been a problem every time a disclosure icon was
added. The fix is not another one-off size bump: establish a single
baseline disclosure-toggle implementation (one shared
component/style with a properly sized hit area, distinct from its
ink), and migrate the existing disclosure sites onto it.

Groomed 2026-08-13 (owner): a single **`DisclosureToggle`
component** (owns hit area, ink, rotation, aria-expanded — not a
CSS contract a site can half-adopt). Hit area **≥ 24×24 CSS px**
(WCAG 2.5.8 floor), ink ~12 px so dense rows don't bloat. All
twelve sites found in the sweep migrate: PlotArea, SignalsPanel,
RbsPanel (×3), PlotMeasurements (×2), ByIdTable, DbcPanel,
ConnectionManagement, ProjectPanel, ProjectGraphPanel,
BlfChannelMapModal, TransmitFrameRow, traceTable. A shared test
asserts the hit-area dimension.

### 2. Collapsing a plot area should give the space back

Collapsing a plot area today reclaims essentially nothing — the plot
height goes, but the rest of the area still holds its space. A
collapsed area should reduce to essentially its heading row.

Groomed 2026-08-13 (owner): collapsed representation is **one
heading row — area name + signal-count chip + match chip** (when a
pattern rule feeds the area); nothing else. Expanding restores the
prior layout exactly. ADR 0026 composition: a run of adjacent
collapsed areas keeps the shared drag handle; each heading stays
individually expandable.

Extended 2026-08-13 (owner): **axes within an area collapse too** —
the individual series' lane in an individual-mode area, and the
per-unit axis in a per-unit-mode area, each get the same
`DisclosureToggle` and collapse to a single label strip. A
collapsed axis's height share redistributes to the remaining axes
(the axis-weight machinery); the series keeps existing and
ingesting — collapse is layout, not signal visibility (distinct
from item 3's hide). Collapsed state persists per axis id, like
axis weights do.

### 3. Hidden signals collapse to a single row

A hidden signal's side-panel row keeps its full readout height. It
should drop to a compact single-line representation while hidden
(name only), returning to full height when shown again. The solo
masked signals should visually behave the same as hidden signals.

### 4. Enum overlays lag the other series — scales with trace length

During live rendering, enum overlays visibly lag the numeric series,
and the lag grows with trace length; live-observing a very long
capture, it starts to look like the enum values have stopped arriving
altogether. The scaling-with-length symptom suggests the enum-lane
path re-walks history rather than answering from the windowed /
decimated serve the numeric series use (ADR 0049 territory).

Investigation phase first: reproduce at scale, attribute the cost
(observation → hypothesis → experiment → data → conclusion), then fix
on the confirmed cause. No fix lands without the attributing
experiment's data.

### 5. Solo paging scrolls the selection into view

Stepping the solo cycle to a different page (added 2026-08-11)
should scroll the plot's signal side panel so the first on-show row
is visible — today the selection can land entirely off-screen and
the page change reads as nothing happening.

Groomed 2026-08-14 (owner): rows outside the current solo page are
**hidden from the side list entirely** while a solo page is
active — the page is the working set; the page indicator carries
the "there's more" context. Item 3's single-line compaction applies
to individually-hidden signals in normal (non-solo) mode.
Scroll-into-view then reduces to scrolling to the top of the short
on-show list.

## Exit criteria (to be firmed in grooming)

- One shared disclosure-toggle implementation exists with a
  documented hit-area standard; the known disclosure sites use it;
  the plot-area toggle passes a hit-area assertion.
- A collapsed plot area's rendered height is its heading row
  (dom-tested), and expanding restores the prior layout exactly.
- A hidden signal row renders single-line (dom-tested both ways).
- Stepping to a solo page scrolls the first on-show row into view
  (dom-tested); the masked-row visibility question is resolved in
  grooming and the resolved behavior pinned.
- The enum-lag cause is written up with the confirming experiment's
  data; after the fix, enum overlays stay current with the numeric
  series at the reproduction's trace length, and the ADR-0031 gate is
  green (multi-run).

## Status log

### 2026-08-14 — item 4 phase 1: enum-lag investigation (no fix)

Investigation only, per the item's own instruction. Branch
`task63a-enum-lag-investigation` off `task66c-picker-removal`
(`c399413`). All instrumentation described below is **temporary** and
removed in the final commit; the substance is this log.

#### Rig (hardware-free — the PEAK dongles were never touched)

The self-driving ADR-0031 flags (`--project`, `--connect-on-start`,
`--perf-capture-secs`, `--perf-out`) against a **temporary vbus-bound
copy of `examples/ev-zonal`**: same DBCs, same saved plot layout, same
rest-of-bus simulation, but the two `interface_bindings` re-pointed at
in-process `local-vbus://` buses instead of `pcan:PCAN_USBBUS1/2`. The
RBS synthesises the identical load — measured `tx_fps` 1608.8 /
1605-1614 across runs, matching the committed hardware baseline's
1605.8. Only the frame *source* differs, and the plot reads the trace
store either way, so the rig is faithful for a rendering/serving
question. (`fps.rx` reads 0: a `SharedBus` participant does not receive
its own transmissions the way a PEAK adapter self-receives, so the
store is fed by tx-confirms alone. Frame rate, decode, pyramid and plot
paths are unaffected.)

Probe: a per-signal **currency** gauge added to `PlotArea`'s resample —
`lag = snapshot.lastT − (newest served sample's t)`, i.e. how far
behind the window's live edge each plotted series actually ends —
alongside the served point count, the requested `max_points`, the fetch
span, the per-axis resample rate and the per-axis render cost. Gauges
ride the existing ADR-0031 `RenderReport`, so each run yields
mean/max/last **and a least-squares slope per minute**, which is
directly the "does it grow with trace length" question.

#### Observation 0 — there is no enum-specific host path

An end-to-end read of the enum overlay (`apps/gui/src-tauri` +
`apps/gui/src`) found **no host command, cache or code path that is
specific to enum lanes**. Enum lanes are a frontend *render mode* over
the same serve the numeric series use: one `sample_signals` call per
axis, `SignalCacheStore::slice_many` → the per-signal decimation
pyramid → `decimate_min_max`. The enum-lanes axis is simply another
`PlotArea` with the same `max_points` (canvas width) and the same
self-paced loop. The only enum-named host surface is the DBC value-table
lookup, which never touches the trace store. So the item's stated
suspicion is already implausible at the code level — but it needed
data, not reading.

#### H1 (the item's hypothesis) — refuted

> *The enum-lane path re-walks history rather than answering from the
> windowed / decimated serve the numeric series use.*

**Falsifying design.** If H1 holds, an enum series' currency must be
worse than a numeric series' *on the same message* (identical frames,
identical rate, identical window — the only difference left is the
path), and the gap must grow with capture length. Measured at three
lengths, with the enum signals (`PackState` 0x100, `MainPositiveState`
0x103) sitting on the shared enum-lanes axis and the numeric signals on
their unit axes.

| capture | signal (msg) | axis | lag mean | lag slope |
| --- | --- | --- | --- | --- |
| 60 s | PackState (256) | enum lanes | −55.0 ms | +1.1 ms/min |
| 60 s | StateOfCharge (256) | numeric `%` | −49.6 ms | +19.2 ms/min |
| 60 s | PackCurrent (256) | numeric `A` | −63.4 ms | +7.9 ms/min |
| 60 s | PackVoltage (256) | numeric `V` | −58.2 ms | −5.6 ms/min |
| 60 s | MainPositiveState (259) | enum lanes | −5.5 ms | −19.5 ms/min |
| 60 s | Min/MaxCellVoltage (258) | numeric `V` | −23.3 ms | +19.8 ms/min |
| 300 s | PackState (256) | enum lanes | −58.7 ms | −1.1 ms/min |
| 300 s | StateOfCharge (256) | numeric `%` | −61.4 ms | +1.2 ms/min |
| 300 s | PackCurrent (256) | numeric `A` | −59.9 ms | +1.7 ms/min |
| 300 s | PackVoltage (256) | numeric `V` | −59.7 ms | +0.2 ms/min |
| 300 s | MainPositiveState (259) | enum lanes | −15.3 ms | −2.3 ms/min |
| 300 s | Min/MaxCellVoltage (258) | numeric `V` | −12.5 ms | −0.3 ms/min |
| 900 s | PackState (256) | enum lanes | −46.5 ms | +0.17 ms/min |
| 900 s | StateOfCharge (256) | numeric `%` | −46.8 ms | +0.17 ms/min |
| 900 s | PackCurrent (256) | numeric `A` | −45.3 ms | +0.20 ms/min |
| 900 s | PackVoltage (256) | numeric `V` | −47.4 ms | +0.25 ms/min |
| 900 s | MainPositiveState (259) | enum lanes | +7.5 ms | −0.06 ms/min |
| 900 s | Min/MaxCellVoltage (258) | numeric `V` | −11.5 ms | −0.04 ms/min |

(900 s = 1 451 373 frames stored, `tx_fps` 1608.6, `winw` 9.97 s.)

**Data reads:** currency tracks the **message**, not the axis kind. The
0x100 signals cluster at −55…−63 ms whether they are drawn as a line or
as a tile lane; the 0x103 enum and the 0x102 numerics cluster together
at −5…−23 ms — the difference between the two clusters is the two
messages' cycle times (10 ms vs 100 ms), which is what a *correct*
windowed serve produces. (Lag is slightly negative because the fetch
margin deliberately reaches past the window's own last frame, ADR 0024.)
Slopes are noise-level and sign-inconsistent across signals, so there is
no growth with capture length in either kind. Served point counts are
likewise identical per message (1220 for 0x100, 124 for 0x102/0x103) and
per-axis host time is 0.11-0.15 ms everywhere.

**Conclusion: H1 is refuted.** The enum lane answers from the same
bounded windowed serve, with the same currency, and does not degrade
with trace length. Nothing in this branch should be spent on an
"enum serve re-walks history" fix.

#### F1 (incidental defect, well evidenced) — the follow-live window freezes at its first width

Found while establishing the rig, because the first runs served ~8
points per signal into a plot that should have been showing ~1200.

**Mechanism.** `PlotPanel.slideXWindow` calls
`followXWindow(followLive, running, sync.xMin, sync.xMax, …)`, which
treats a non-null `(xMin, xMax)` as *"the width the user last zoomed
to"* and re-slides that width. But `sync` is `xSyncRef`, and
`applyXAll` — the function `slideXWindow` itself calls with the window
it just computed — **writes `sync.xMin` / `sync.xMax` on every
programmatic slide**. So from the second slide onward the panel is
honouring its own previous output as if it were a user's zoom. The
first slide happens a few hundred milliseconds after connect, when the
capture is far shorter than `follow_window_ms`, so `followXWindow` takes
its `min < windowStartT` branch and returns `[windowStart, ext]` — a
sliver. That sliver is then the "user width" forever.

**Evidence.**

- `winw` (the panel's own window-width gauge, already in the
  `RenderReport`) measured **0.1 s** and **0.02 s** on two fresh
  self-driving sessions of this build, against a `follow_window_ms`
  default of 10 s. The committed task-66 close-out report
  (`docs/performance-measurements/frontend/2026-08-14-c399413-task66-closeout.json`)
  carries `winw` mean/max/last **0.0** with `followwin.slide` at 12.7/s
  — i.e. the panel was sliding a sub-50 ms window for that whole
  capture too, so this is not new to this branch.
- The probe measured the consequence directly: fetch span **79.8 ms**
  and **8-12 served points per signal** (most of them the serve's own
  boundary-widening points), versus **13 835 ms** and **1220 points**
  once the width is withheld.
- `followWindow.test.ts` cannot see it: every case passes `xMin`/`xMax`
  in directly, so the feedback edge through `applyXAll` is outside the
  unit. The test at "pins the left edge at the window start until the
  capture exceeds the window width" documents behaviour that, in the
  assembled panel, can only ever apply on tick one.

**Scaffold used.** To measure anything representative, the probe build
withholds the width from `followXWindow` until a real gesture has fired
`onUserXChange`. Every number in the H1 table above was taken with that
scaffold in place (`winw` 9.44-9.88 s), so they characterise the plot as
designed, not as it currently behaves.

**Is F1 the owner's symptom?** The data says *not by itself*: under the
frozen window, enum and numeric are still equally current — the panel
is uniformly wrong, not enum-specifically wrong. But it is a real defect
of its own (a live plot showing a fraction of a second of capture), it
plausibly contributes to "the plot looks wrong during live rendering",
and it needs its own fix leg.

#### H2 — the tile draw's per-segment cost paces the enum axis's own fetch loop

H1's refutation leaves the symptom unexplained, so the next hypothesis
is written down before anything else changes.

> *`drawEnumTiles` costs `O(visible transitions)` per draw — a
> `table.find` and a `ctx.measureText` per segment — and that cost
> lands inside the enum axis's measured resample, which
> `nextResampleDelayMs` uses to back its own fetch loop off (up to
> `RESAMPLE_MAX_DELAY_MS` = 2000 ms). A lane whose enum transitions
> often therefore fetches less often than the numeric axes beside it,
> which is a lag in exactly the sense reported; and the visible
> transition count rises with capture length until it saturates at
> `max_points`, which is the "grows with trace length" part.*

This mechanism is enum-specific (numeric axes draw no tiles), matches
"visibly lag the numeric series", and matches "looks like the enum
values have stopped arriving altogether" — a 2000 ms back-off *is* a
lane that has stopped.

**Why the H1 runs cannot test it.** Every value in
`ev-zonal.cannet_rbs` is a **static** override — `PackState` is held at
`"Drive"`, `MainPositiveState` at `"Closed"` — so each lane has exactly
one segment for the whole capture and the tile draw is free. Measured:
per-axis render cost 0.27 ms on the enum-lanes axis vs 0.18-0.28 ms on
the numeric axes, and every axis resampling at 13.4-13.6 Hz. No
back-off, because there is nothing to draw. The H1 runs therefore
neither confirm nor refute H2.

**Falsifying design.** A second temporary project variant designates
the plotted enums as RBS **counters** (ADR 0028's `counter` spec), so
they step every frame: `PackState` on 0x100 (100 Hz, rollover 5),
`MainPositiveState` on 0x103 (10 Hz, rollover 3), plus `MaxCellVoltage`
on 0x102 as a *numeric* counter so a varying numeric at the same rate
is the control. New probes: wall-clock of the tile-draw block, the
segment count it walked, and the per-axis draw-hook rate. H2 predicts
the enum-lanes axis's tile time and segment count rise together, its
`p63.hz` falls below the numeric axes', and its currency degrades — all
while the numeric control at the same rate stays flat. If the enum axis
keeps pace with the numeric control under a transition every frame, H2
is refuted and the search moves on.

**Re-running the rig.** Copy `examples/ev-zonal/ev-zonal.cannet_prj`,
give it a fresh UUID `project_id`, replace `interface_bindings` with two
`{"kind": "local-virtual-bus", "server": "local-vbus://<id>",
"interface": "bus", "bus_id": …}` entries and declare the matching
`local_virtual_buses`; keep the copy in `examples/ev-zonal/` so the
project-relative DBC and RBS references still resolve (ADR 0030). Then
`pnpm --dir apps/gui tauri build --no-bundle` and run the binary with
`--project <abs> --connect-on-start --perf-capture-secs <n> --perf-out
<abs>`. Absolute paths throughout — the GUI child's working directory is
not the repo root.

**Data (V1 — transitioning enums, 10 s follow window, 300 s).** The rig
works: the enum-lanes axis now walks **1341 tile segments** per draw
(one, in the H1 runs) at **2.41 ms** mean / 5.10 ms max per draw —
~1.8 µs per segment, ~122 ms/s of UI thread at 50.8 draws/s. But the
predicted signature **did not appear**:

| gauge | enum-lanes axis | numeric axes |
| --- | --- | --- |
| resample rate `p63.hz` | 13.19 Hz | 13.22 / 13.24 / 13.24 Hz |
| measured resample cost `p63.rendms` | 0.30 ms | 0.19-0.27 ms |
| tile draw `p63.tilems` | 2.41 ms | — |
| currency, PackState vs 0x100 numerics | −52.4 ms | −45.0 / −48.7 / −48.8 ms |

**Conclusion: H2 is refuted.** The tile draw is real cost but it is
**not inside the quantity that paces the loop**: `renderCostMsRef` is
captured in the resample's `finally`, and uPlot's redraw after
`setData` lands in a *later* task (`plotPacing`'s own docstring says
so). 2.41 ms of tile drawing against 0.30 ms of measured cost proves
the draw is outside the measurement, so `nextResampleDelayMs` never
sees it and never backs off. The enum axis kept pace with the numeric
axes to within 0.05 Hz.

#### H3 — min/max decimation is the wrong summary for a categorical series — **confirmed**

Both refutations share a blind spot: at a 10 s window neither run ever
*decimated* (1217 served points against a 2248 `max_points` budget), so
neither could see what happens when the visible window holds more
samples than the point budget. That is the regime "live-observing a
**very long** capture" actually puts a follow-live plot in — and it is
where the pyramid and `decimate_min_max` engage.

> *The serve reduces an over-budget window with
> `decimate_min_max`, which keeps each bucket's **argmin and argmax by
> value**. For a numeric series that is right and deliberate (spikes
> survive). For a **categorical** series it is a category error: the
> two extreme codes in a bucket are kept and every other code in it is
> discarded, so the lane stops showing the state that was held and
> shows a per-bucket envelope instead. The bucket spans
> `window_samples / max_points` samples, which grows linearly with
> capture length — so the fidelity loss switches on at a threshold and
> then deepens.*

**Experiment (V2).** Same transitioning-enum project, `follow_window_ms`
raised so the follow window is the whole capture (it grew to 301 s over
the run), 300 s capture.

| gauge | value | reading |
| --- | --- | --- |
| `p63.n` PackState (enum, 100 Hz, cycles 0→5) | mean 3440, **max 4497** | `4497 = 2 × max_points + 1` — the exact min/max-envelope signature: two points per bucket |
| `p63.n` 0x100 numerics (**constant** values) | max 2249 | `= max_points + 1` — a flat series collapses to one point per bucket |
| `p63.segs` (tile segments walked) | mean 4400, max 6789, **slope +536/min** | the lane is drawing an alternating stripe, and it grows with capture length |
| `p63.tilems` | mean 6.24 ms, max 13.8 ms, **slope +0.51 ms/min** | tile cost grows with capture length |
| `p63.rendms` enum vs numeric | **0.83 ms** vs 0.20-0.54 ms | the enum axis is now 1.5-4× the cost of its neighbours |
| `p63.hz` enum vs numeric | **11.11 Hz** vs 11.34-11.35 Hz | the enum lane now *does* fetch slower than the numeric series beside it |
| `longtask_ms_per_s` | mean **72.9**, p95 **384.5**, max 543 | (0.0 in every 10 s-window run) |
| `jank_fraction` | **0.267** | (0.0 in every 10 s-window run) |
| draws/s vs resamples/s | 24.1 vs 41.8 | redraws are being dropped |

**Why this is the reported symptom.** `PackState` cycles 0→5. Once a
decimation bucket spans six or more samples, its argmin is code 0 and
its argmax is code 5 **for every bucket** — so the served series is an
alternating `Sleep`/`Fault` stripe and codes 1-4 (`Standby`,
`Precharge`, `Drive`, `Charge`) are absent from the answer entirely.
The held state is not late; it is *gone*, which is exactly "it starts
to look like the enum values have stopped arriving altogether". The
point-count signature (`n = 2·max_points + 1` for the varying series,
`max_points + 1` for the constant ones) is the direct evidence that the
envelope path is what ran; the code establishes which two samples
survive. The onset threshold is `window_samples > max_points`, and the
severity is `window_samples / max_points` — both linear in capture
length under a follow-live window that has grown to the capture, which
is the "scales with trace length" the item reports.

The secondary effect is real too and points the same way: at 4400+
segments the tile draw costs 6.24 ms and drags the enum axis's own
resample rate below its neighbours' (11.11 vs 11.34 Hz). So there *is*
a genuine enum-vs-numeric currency gap in this regime — it is just an
order of magnitude smaller than the fidelity loss, and it is a
consequence of the same cause (an envelope produces ~`2·max_points`
segments where the truth is a handful of runs).

#### Verdict

**Root cause: the enum lane is served through `decimate_min_max`, a
min/max envelope reducer that is correct for a numeric series and
semantically wrong for a categorical one.** Below the decimation
threshold (a short window) the lane is exact and perfectly current —
which is why H1's currency probe found nothing at any of three capture
lengths. Above it the lane silently switches to per-bucket extremes,
losing every intermediate code and inflating the tile-draw cost, and
both effects deepen linearly with the window's sample count.

The item's stated suspicion — "the enum-lane path re-walks history
rather than answering from the windowed/decimated serve" — is refuted:
the enum lane uses *exactly* the windowed serve. The defect is that the
windowed serve's **reduction function** has no categorical mode.

#### Recommendation for phase 2

1. **A categorical serve that preserves runs, not extremes.** The host
   already knows a signal is categorical (it has a DBC value table).
   Give the serve a categorical reduction: emit the signal's
   **transitions** in the window (run boundaries) rather than a
   per-bucket envelope. That is both the correct summary *and* cheaper
   — `O(transitions in window)` instead of `O(2 · max_points)` — and it
   makes the tile lane exact at any zoom. Pin it with a host unit test:
   a synthetic categorical series cycling 0..5, each code held for many
   samples, reduced with a budget far below the sample count, must
   still contain **every code** and each transition's time; the current
   `decimate_min_max` fails that test by construction.
2. **Stop paying per decimated sample in `drawEnumTiles`.** With (1)
   the segment count collapses to the real transition count, which is
   most of the win. Independently, the per-segment linear
   `table.find(r => r.raw === raw)` should be a map lookup and the
   per-segment `ctx.measureText` should be memoised per (label, font) —
   the measured 1.8 µs/segment is nearly all those two.
3. **F1, the follow-window freeze — its own fix leg.** `followXWindow`
   must not take its "user width" from a ref that `applyXAll` writes;
   the panel needs to distinguish *the width the user chose* from *the
   width we last rendered*. **Test seam note:** the existing
   `followWindow.test.ts` cannot catch this — every case passes
   `xMin`/`xMax` in as arguments, so the feedback edge (slide →
   `applyXAll` → next slide) is outside the unit under test. The
   regression guard has to close that loop: either a panel-level DOM
   test that slides twice and asserts the second window is still
   `follow_window_ms` wide, or a pure unit over a `slideXWindow`-shaped
   function that owns both the read and the write.
4. **Re-baseline the frontend perf tier after (3).** Every committed
   frontend baseline was captured with `winw` ≈ 0 — a plot rendering a
   sub-second sliver — so the plot tier has never actually been
   measured at a realistic window. V2 shows what a realistic wide
   window costs today (`longtask` p95 384 ms, `jank_fraction` 0.267),
   which the current gates would not catch because the current
   baselines never enter that regime.
5. **Exit-criteria wording.** The item's criterion ("enum overlays stay
   current with the numeric series at the reproduction's trace length")
   should be restated to match the confirmed cause: *at a window wider
   than the point budget, the served enum series contains every code
   and every transition the raw series holds* — currency alone would
   pass today.
