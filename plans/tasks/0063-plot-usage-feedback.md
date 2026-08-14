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
  data; after the fix, **at a window wider than the point budget the
  served enum series contains every code and every transition the raw
  series holds** (host test, and observed on the reproduction), enum
  overlays stay current with the numeric series at the reproduction's
  trace length, and the ADR-0031 gate is green (multi-run).
  Restated 2026-08-14 from the phase-1 conclusion: currency alone
  would pass today. The confirmed cause is a *fidelity* loss — above
  the decimation threshold the min/max envelope kept each bucket's two
  extreme codes and discarded the states held in between — and a lane
  can be perfectly current while showing none of them.

## Status log

### 2026-08-14 — item 2: collapse reclaims space (area heading row + axis collapse)

Branch `task63d-collapse-reclaims-space` off `task63c-disclosure-toggle`
(`15e69f8`). Two commits: the pure per-axis collapsed store
(`af9a84b`), then the panel/area wiring, docs and tests (`92df21a`).

#### The collapsed area — what goes, and what is deliberately kept

A collapsed area renders exactly one heading row: **grip · area
disclosure · name · signal-count chip · pattern match chip**. The
chips reuse the solo chip's ink (`.plot-area-count-chip` joins
`.plot-solo-chip`'s rule) rather than a new look. Everything else is
gone from that row — fit y, the y-axis-mode selector, the patterns
button, the remove ×, the filter status line, the y-cursor readout,
and the signal rows.

Two things go further than "hide the body":

- **The derived axes after the first are not rendered at all.** One
  collapsed area is one row, however many axes its mode stacks — a
  per-unit area with three unit groups used to leave three strips.
  `renderedAxes` filters them out of the render pass only; they stay in
  `derivedAreaConfigs` and so in `derivedAxisIds`, which is what keeps
  `pruneAxisWeights` / `pruneAxisScales` from retiring their entries
  while the area is collapsed. That is the whole mechanism behind
  "expanding restores the prior layout exactly": the collapse writes one
  boolean and touches no weight. Splitter pairing and collapsed-run
  heads are computed over `renderedAxes`, not the full list, so they
  describe what is actually in the DOM.
- **Unmount, not zero-height.** The dropped axes leave the tree
  entirely. They hold no state that has to survive: a collapsed axis
  already constructs no uPlot, and everything persisted about it
  (weight, manual range, y-cursors, sampled series for the measurement
  strip) is panel-level and keyed by axis id. The one thing lost is the
  axis's `useDecimatedRange` cache, so re-expanding refetches instead of
  repainting from cache — one round trip against a warm host cache,
  which is cheaper than keeping N mounted components running.

**Kept: the all-hidden collapse still shows its compact rows.** ADR
0026's original rationale for keeping rows was the un-hide path — a
swatch in one of those rows is the only way back — and that is still
true. So the row-suppression keys on a *deliberate* collapse
(`headingOnly` = the area's own flag, or this axis's own), never on the
all-hidden / solo-masked rule. Reducing an all-hidden area to a heading
would strand its signals.

#### Axis collapse

`axisCollapsed: Record<string, true>` on the panel, keyed by
derived-axis id, sparse, pruned to the live axis set — deliberately the
same store shape and the same lifecycle as `axisWeights`, since both
describe the layout the user is looking at (a y-axis-mode change
retires them together, unlike the manual ranges which survive it). It
folds into the per-axis `collapsed` flag `deriveAreaConfigs` already
computes, so an axis collapse inherits the entire existing treatment
for free: `flexGrow: 0` (the share redistributes, the stack still
fits), `splitterPartnerAbove` reach-over, `collapsedRunHeads`, and the
gesture-replaying placeholder.

Decisions taken with the code:

| question | ruling |
| --- | --- |
| which axes get a toggle | those with a subtitle — a per-unit unit group, an individual-mode series. In unified mode the area *is* the axis, so its toggle is the only one; a second one on that row would say nothing. |
| splitter between a collapsed axis and its neighbour | **hidden**, and the neighbours pair *across* it. Already `splitterPartnerAbove`'s contract for the all-hidden collapse — a zero-weight axis has nothing to trade, and severing the stack would remove the only handle for resizing either side. |
| last axis uncollapsible? | **no rule.** An area with every axis collapsed is exactly the shape the all-hidden rule already reaches, each strip keeps its own (enabled) toggle, and the panel's flex column simply leaves blank space below. Nothing wedges, so nothing needs forbidding. |
| does it travel with an area drag? | **no** — same as the axis weights, which the drag payload deliberately leaves behind (the manual ranges do travel). Collapse is layout state of *this* stack. |

**"Collapse does not stop ingest."** There is no host-side subscription
to change: the phase-1 investigation established that the plot pulls
`sample_signals` per axis and the host decodes on demand, so there is
nothing a collapsed axis could unsubscribe from. What the requirement
reduces to at this layer is that the *signals* are untouched — the test
asserts the persisted `areas` blob is byte-identical across a collapse
round-trip (no `hidden` written, no membership change) and that the
rows and their series come straight back on expand. A collapsed axis
does stop *fetching pixels*, exactly as an area collapsed by the flag
already did, because it has no canvas to draw them on.

#### Label split

The head used to render one concatenated `Area 1 · [V]` string. It is
now the area name, a decorative `·`, the axis disclosure and the axis's
own label as separate spans — the toggle has to sit *on the thing it
collapses*. Two existing tests queried the concatenated text and now
read the two spans.

#### Tests

2026 frontend tests (`pnpm --dir apps/gui test`, +14: 4 in
`plotAreaLayout.test.ts` for the collapsed store, 10 DOM tests across
the two collapse suites — heading-row reduction, the one-row multi-axis
collapse, the pattern chip, the area round-trip, and the axis suite's
collapse/redistribute, round-trip, persisted read-back, layout-not-
visibility, all-axes-collapsed, unified-mode absence and pruning).
`pnpm --dir apps/gui build` green. No host changes.

#### Blockers / side effects

- **Removing a collapsed area now needs an expand first** — the remove
  × is one of the controls the heading row drops ("nothing else"). Noted
  rather than carved out; say so if the × should be the exception.
- A collapse toggle re-derives every area's axes (`axisCollapsed` is a
  panel-wide dependency of the derivation memo) rather than just the
  touched one. One click, so the scoping was not worth a per-area slice.

### 2026-08-14 — item 1: the DisclosureToggle component and its 12-site migration

Branch `task63c-disclosure-toggle` off `task63b-categorical-serve`
(`1e055cf`). Seven commits: the component, then one per coherent
group (plot family; standalone panel headers; the signal-section fold;
the RBS tree; the DBC tree; the transmit row + trace table).

#### The component

`DisclosureToggle` (`apps/gui/src/DisclosureToggle.tsx`) owns hit
area, ink, rotation and `aria-expanded`. The default box is a real
24x24 CSS px hit area (padding-based: `min-width`/`min-height: 24px`
on the button itself, not a negative-margin/pseudo-element overlay) —
`~12px` ink centered inside it. A `compact` size variant trades the
floor's *height* for the row it sits in, keeping width at the full
24px (width costs nothing there): used wherever a row's height is
fixed by a shared virtualizer constant or a toolbar line's sibling
controls, so growing it would either bloat every row or need a
pseudo-element hack whose hit area doesn't actually reach past
neighbouring, tightly-stacked rows reliably (rejected — the task's own
"must genuinely receive clicks, not just occupy space" caution). Six
of the twelve sites take it: SignalsPanel (row ties to
`traceViewport.ts`'s `ROW_HEIGHT` = 22px), DatabasePanel
(`dbcPanelViewport.ts`'s `ROW_HEIGHT` = 20px), RbsPanel's three rows
and TransmitFrameRow's identity line (no shared constant, but growing
any of these would bloat the row's layout — out of this task's
surgical scope regardless of the reason).

Keyboard: the button's own `onKeyDown` toggles directly on Enter/Space
and calls `preventDefault()`, rather than relying on a real
`<button>`'s native synthetic-click activation — confirmed by a
throwaway probe that jsdom does *not* implement that native behavior
(`fireEvent.keyDown` on a plain button never reaches `onClick`), so a
component that only wired `onClick` would silently fail every keyboard
test under this suite while still working by accident in a real
browser. `preventDefault` also stops the *browser's* native
double-activation in a real WebView2/Chromium host.

`onToggle` receives the activating event (mouse or keyboard) rather
than being a bare `() => void`, so a site nested inside another
clickable element (a gridview row, ADR 0044) can call
`stopPropagation` itself — the component takes no view on whether
that's wanted, since roughly half the twelve sites need it and half
don't (preserved exactly per site, not defaulted on).

11 new tests in `DisclosureToggle.dom.test.tsx`: a real `<button>` (not
a decorative span), the 24x24 floor and the compact variant's width-
only floor (read from `index.css` as text — jsdom does no layout, the
established idiom here per `dockPanelScrolling.test.ts`), click-toggles,
Enter/Space-toggles (and an arbitrary key does not), `aria-expanded`
tracking, the glyph swap (hidden from the accessible name),
children-as-accessible-name, `tabIndex` override, disabled behavior,
and that a nested toggle's `stopPropagation` reaches an ancestor.

#### The twelve sites

| site | shape | variant | notes |
| --- | --- | --- | --- |
| PlotArea | icon-only | default | `disabled` passthrough for the "nothing to expand to" state |
| PlotMeasurements | label ("measurements") | default | glyph moves out of the accessible name into an aria-hidden span — previously read literally by a screen reader |
| ProjectPanel | label (section title) | default | two-class `.project-panel .project-section-toggle` kept — it exists to outrank `.project-panel button`'s bordered look, not to duplicate the shared class |
| ConnectionManagement | label + explicit aria-label | default | same two-class reasoning as ProjectPanel |
| ProjectGraphPanel | icon-only | default | filter-node predicate-editor disclosure |
| BlfChannelMapModal | label ("Markers (N)") | default | |
| SignalsPanel | icon-only | compact | row shares `traceViewport.ts`'s `ROW_HEIGHT` |
| RbsPanel ×3 | icon-only, `tabIndex=-1` | compact | bus/ECU/message rows; row itself is the gridview tab stop (ADR 0044), caret is a secondary mouse target — pre-existing pattern, generalized |
| DatabasePanel | icon-only, `tabIndex=-1` | compact | glyph standardized from `▼`/`▶` (this site's own drift) to the `▾`/`▸` every other site used; `onChevronClick`'s param type widened from `MouseEvent` to `SyntheticEvent` to fit the shared `onToggle` signature |
| TransmitFrameRow | icon-only | compact | gains an `aria-label` — the original had none, so its accessible name was the raw glyph character |

Two sites did **not** take the component, both documented exceptions
rather than silent gaps:

- **ByIdTable**: no change. Its row is already the entire disclosure
  (full row height and width, real `aria-expanded`/`tabIndex`,
  Enter/Space handling) — a deliberate, tested prior decision
  (`2c1949a`, "drop the by-id caret; the row is the disclosure") that
  explicitly removed a glyph for saying nothing a mid-row caret could
  say. `ByIdTable.dom.test.tsx` asserts no caret and no button in the
  message cell; adding either back would revert a settled, regression-
  guarded call, not migrate it.
- **traceTable** (the chronological trace's row, `TraceView.tsx`):
  keeps its decorative caret, now sharing DisclosureToggle's
  `.disclosure-toggle-glyph` ink class and gaining `aria-hidden`
  (neither present before). Unlike ByIdTable, this row carries no
  `aria-expanded`/`tabIndex` of its own — TraceView's `Row` never
  wires them, only an `onClick` — so removing the glyph the way
  ByIdTable did would leave the row with *no* expand/collapse
  affordance for any user, sighted or not. Fixing that gap is a larger,
  separate change (giving the chronological row the same ARIA/keyboard
  contract ByIdTable has) that this item's "toggle affordance only"
  scope does not cover; noted here rather than folded in.

**Discrepancy from the grooming's site count**: the item lists
"PlotMeasurements (×2)". Inspection of `PlotMeasurements.tsx` and its
one call site in `PlotPanel.tsx` found exactly one disclosure (the
"measurements" menu trigger) — the "measurements" checkbox beside it
toggles the strip's visibility but is a real `<input type="checkbox">`,
not a disclosure. No second caret/`aria-expanded` control exists
anywhere in the file. Migrated the one found; flagging the mismatch
rather than inventing a second site.

#### CSS

Retired per-site hit-area/ink rules the migration orphaned:
`.plot-area-collapse` (kept only spacing/hover color),
`.blf-map-markers-toggle`/`-caret` (caret rule deleted outright,
toggle rule trimmed to its full-width/left-align/hover shape),
`.project-section-caret` (deleted — no longer referenced),
`.graph-node-expand` (split out of its combined rule with
`.graph-node-insert-filter`, which keeps its own full styling),
`.trace-disclosure` (deleted), `.rbs-caret` (deleted — all three
RbsPanel rows always have a caret, no placeholder-span concern),
`.dbc-row-chevron` (kept, but trimmed — a childless DBC row's
placeholder `<span>` still carries this class for indent alignment,
so its `min-width` widened to 24px to keep expandable and leaf rows'
indents lined up rather than retiring the rule), `.tx-row-identity
.tx-expand` (split out of its combined rule with `.tx-remove`, which
keeps its own full styling; `.tx-expand` keeps only the reserved-
border hover reveal DisclosureToggle doesn't provide).

#### Tests

2012 frontend tests (`pnpm --dir apps/gui test`, +11 — all in the one
new `DisclosureToggle.dom.test.tsx` file; every migrated site's
existing tests updated to the new markup where they touched it at all,
and all pass unmodified otherwise since they query by role/name/aria
attributes rather than DOM shape) and `pnpm --dir apps/gui build`
green after every commit. No host changes; `cargo test -p cannet-gui`
untouched by this branch.

### 2026-08-14 — item 4 phase 2: the categorical serve (fix)

Branch `task63b-categorical-serve` off `task63a-enum-lag-investigation`
(`dd452a7`). Three commits:

| commit | what |
| --- | --- |
| `feat(gui): serve categorical signals by runs, not by extremes` | host: `signal_sampler::reduce_transitions`, `SignalCache::window_categorical` + `level_points`, the `Reduction` mode on `slice_many`, the `categorical` arg on `sample_signals` |
| `feat(gui): request the categorical reduction from the enum-lane axes` | frontend: `DecimatedRequest.categorical`, in the fetch memo, set by `PlotArea` on the lanes / single-enum axes |
| `perf(gui): stop paying per tile segment in the enum lane draw` | `laneLabels` (per-table code→label map) and `measureTileLabel` (width memo per `(label, font)`) in `plotEnumLanes.ts`, used by `drawEnumTiles` |

F1 (the follow-window freeze) is **not** touched here — it has its own
leg, and the measurements below use the same temporary scaffold phase 1
used to see past it.

#### Design decision — the host does not infer "categorical"

The serve's reduction is chosen by an explicit `categorical` flag on the
request, not by the host noticing a DBC value table. Render mode is view
state: the same signal is a line on a numeric axis and a lane of held
states on an enum-lanes axis, and a value table is present in both cases
(a labelled-but-plotted-as-a-line signal is normal). Inferring would also
make the reduction depend on which databases happen to be loaded.

It is a property of the **request**, not of each signal in it, because a
plot fetch batches exactly one derived axis (`deriveAxesForArea` splits an
area into `numeric` / `enum-lanes` axes and `PlotArea` renders one), and
an axis has exactly one render mode. It rides the fetch memo — the same
window under the other reducer is different bytes.

#### Degradation shape — coarsest-run merging, never truncate-and-continue

Above the read budget (`PYRAMID_BRANCH × max_points`, the same order the
numeric serve reads) the serve answers off a coarser pyramid level, and if
the runs *still* exceed `max_points` it steps up another level and
re-reduces. Short runs merge into their neighbours; long ones keep their
code and land within a fraction of a pixel column. A window that fits at
level 0 is exact.

ADR 0049's other partial-answer shape — answer part of it, say so, let the
view re-request — is **not** available here. That contract converges
because each serve has decoded more than the last; an identical request
over an unchanged window returns the identical prefix forever, and the ADR
forbids the caller accumulating across responses. Coarsening keeps the
answer whole and bounded, and costs resolution only where the transitions
are already sub-pixel.

One second-order fix rides along: `fold` only promotes *complete* buckets,
so any pyramid level stops short of the newest samples. Read off a coarse
level that is a lane visibly trailing the capture — the reported symptom.
`level_points` therefore splices each finer level's un-folded tail (fewer
than `PYRAMID_BRANCH` points each, so still `O(max_points)`), and the
newest samples are served at full resolution. **The numeric serve has the
same tip lag and does not do this** — noted under side effects.

#### Validation — the phase-1 V2 scenario, matched A/B

Same rig as phase 1 (temporary vbus-bound copy of `examples/ev-zonal`,
kept outside the repo this time; PEAK dongles untouched), same
transitioning-enum RBS counters (`PackState` 0..5 on 0x100 at 100 Hz,
`MainPositiveState` 0..3 on 0x103 at 10 Hz, `MaxCellVoltage` the numeric
control on 0x102), `follow_window_ms` raised in the copy's workspace
settings so the follow window grows to the whole capture. 300 s runs,
`tx_fps` 1610.0 / 1610.8, `winw` 301.3 / 301.4 s, `max_points` 2248.

Two runs off **one build**, differing only in whether the lane axis asks
for the categorical reduction — so the numbers isolate the serve (both
carry the tile-draw memos). Temporary probes, removed afterwards: served
point count and distinct-code count per signal, tile segments walked and
tile-draw wall clock.

| gauge | phase-1 V2 (before) | control: same build, envelope | **after** |
| --- | --- | --- | --- |
| `p63.n` PackState | mean 3440, max **4497** | mean 3443, max **4497** | mean 1278, max **2247** |
| distinct codes served, PackState (of 6) | — | mean 2.95, **last 2** | mean 5.87, **last 6** |
| distinct codes served, MainPositiveState (of 4) | — | 4 | 4 |
| `p63.segs` | mean 4400, max 6789, slope +536/min | mean 4404, max 6787, slope +535/min | mean 2294, max 3672, slope +265/min |
| `p63.tilems` | mean 6.24, max 13.8, slope +0.51/min | mean 10.31, max 18.8, slope +1.01/min | mean 5.28, max 9.5, slope +0.53/min |
| `longtask_ms_per_s` mean / p95 / max | 72.9 / 384.5 / 543 | 43.0 / 329.3 / 588 | **0.0 / 0.0 / 0.0** |
| `jank_fraction` | 0.267 | 0.163 | **0.0** |
| draws/s vs resamples/s | 24.1 vs 41.8 | 24.2 vs 41.0 | 41.8 vs 48.2 |

**Reading.** The control reproduces phase-1 V2's signature to within
noise (`4497 = 2·max_points + 1`, segs 4404 vs 4400, slope +535 vs +536),
so the rig is the same experiment. Under the categorical serve the point
count is no longer envelope-shaped — it is bounded by `max_points`, which
is the coarsening branch doing its job, because `PackState` genuinely
transitions 30 000 times in this window against a 2248-point budget. The
fidelity criterion is met where it matters: **all six codes are in the
served series at the end of a 300 s wide-window run, against two under
the envelope.** The lane's own draw cost halves with its segment count,
its slope with capture length halves, and the UI thread stops hitching
altogether (`longtask` and `jank_fraction` to zero from a p95 of 329 ms
and 16 % of seconds hitching).

The per-segment µs is **not** comparable across phases — this phase's
`p63.tilems` probe brackets more of the lanes pass than phase 1's did
(lane bands and `valToPos` per lane). The `table.find`/`measureText`
removal is pinned by unit tests that count the calls, not by this run.

`p63.n` for the numeric control signals is unchanged (StateOfCharge mean
1735 → 1733), confirming the numeric path was not touched.

#### Tests

617 host tests (`cargo test -p cannet-gui`, +4: the reducer contrast, the
reducer edges, and three serve tests), clippy `-D warnings` clean;
2001 frontend tests (`pnpm --dir apps/gui test`, +5) and `pnpm build`
green. `cargo test -p cannet-perf-measurement` green (37) — its
`signal_bench` calls `decimate_min_max` directly and is unaffected.

#### Blockers / side effects

- **The numeric serve has the same tip lag** the categorical one now
  splices away: `window()` reads a coarse level and stops at its last
  folded bucket, so a wide-window *line* also ends short of the live
  edge. Not fixed here (it is not this item's defect and the fix belongs
  with a measurement of its own), but it is now a known asymmetry
  between the two reductions.
- **The wide-window regime is still unreachable in a shipped build**
  because of F1 — every number above needed the phase-1 scaffold. Item 4
  cannot be signed off from a normal run until F1's leg lands.
- **`follow_window_ms` reached the run through the project's
  `.cannet/settings.json`**; a first attempt without the F1 scaffold sat
  at `winw` 0.1 s regardless, which is F1 in isolation and independent
  confirmation of its mechanism.

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
