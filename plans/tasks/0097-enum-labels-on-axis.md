# Task 97 — Enum Values Still Appear on Axis Labels

> **Status 2026-08-23 — code-complete, awaiting acceptance.** Landed
> 2026-08-21 on the chain (nothing has merged). The three exit criteria
> are walked in the status log, all met. Finding still owed a verdict:
> owner-review-queue 3.6 — whether the owner's report meant the enum
> *lane tiles* rather than the axis.

Opened by owner instruction 2026-08-20, from 0.9.0 usage feedback:

> enum values still appear on the axis labels sometimes. they
> shouldn't. It looks really bad when there are long names or hundreds
> of values, and isn't more needed with the overlay

## The site, and why "sometimes"

`PlotArea.tsx` builds the y-axis three ways. The middle branch fires
when `enumActiveAtConstruct` and emits **one split per enum raw value**,
formatted as the raw value followed by the quoted label:

```js
splits: () => enumRaws,
values: (_u, splits) => splits.map((v) => `${v} "${enumLabelFor(Math.round(v))}"`),
```

with a gutter reserved at `trackGutter(areaId, 80)`.

"Sometimes" is precise, not vague: the branch is gated on
`enumMode = !laneMode && isEnumValueTable(valueTable) && signals.length === 1`.
So it fires only for a **single-signal area, not in lane mode, whose
signal has an enum value table** — which is why the owner sees it
intermittently rather than always.

The failure mode follows directly from `splits: () => enumRaws`: the
tick count is the size of the value table. A signal with hundreds of
enum values gets hundreds of ticks; long names blow out the gutter.

## Why it should go

The owner's reason is that the **enum overlay** (delivered by task 86)
already shows the label at the point of interest, so duplicating every
label down the axis buys nothing and costs the gutter. This is a
removal, not a redesign.

## Scope

- Remove enum labels from the axis. What replaces them — plain numeric
  ticks, a small fixed number of ticks, or no y-axis ticks at all for
  an enum area — is the grooming question below.
- Reclaim the 80px gutter reservation when the labels are gone.
- Check the **enum-lanes** axis (`DerivedAxisKind = "enum-lanes"`,
  `plotAxisDerivation.ts`) separately — it is a different branch with
  its own labelling, and the owner's complaint may or may not cover it.

## Open questions — grooming

- ~~What does an enum area's y-axis show instead?~~ **Decided by the
  overseer 2026-08-20: ticks at the enum raw values, labelled with the
  raw number only, capped and thinned.** The raw values are the only
  meaningful positions on an enum axis, so keeping them preserves the
  reader's sense of scale; dropping the label text is the whole of the
  owner's complaint, and the overlay supplies the name at the point of
  interest. The gutter then shrinks to numeric width.

  **The cap is not optional.** `splits: () => enumRaws` has no bound at
  all today, so a several-hundred-value table emits a tick per value
  regardless of pixel height. Thin to what fits, the way the numeric
  branch already does.

- **Does this apply to the enum-lanes axis too?** Left open — it is a
  different branch (`DerivedAxisKind = "enum-lanes"`) with its own
  labelling, and the owner's report says "axis labels" without
  distinguishing. The implementing phase should **show the owner both**
  before changing the lanes axis, since lane labels may be the thing
  that makes lanes readable at all.

## Exit criteria (draft — firm at grooming)

- No enum label text is drawn on a y-axis.
- An enum signal with hundreds of values renders with a bounded number
  of ticks and a gutter sized to what is actually drawn; tested.
- The enum overlay still identifies values, unchanged.

## Status log

### 2026-08-21 — (branch `task-97-enum-axis-ticks`)

Branched from `task-95-grid-content-rows` (`f80964db`). Three commits:
`d0bc21bd` (the pure tick thinner + its unit tests), `29499f4d` (the
axis change, the DOM regression matrix, the ADR 0026 amendment and the
stale comments it invalidated), and this status log.

#### The path from value-table data to rendered tick

Every function the enum labels pass through, host to canvas:

1. `list_value_tables` (Tauri command) — the host serves a signal's
   `VAL_` rows (DBC) or its channel's value-to-text conversion (MDF) as
   `ValueTableEntryRecord[]` (`{ raw, label }`).
2. `useValueTables(signals)` (`useValueTables.ts`) — one fetch per
   signal set, keyed by canonical `signalKey` plus the DBC generation;
   returns `Map<signalKey, ValueTableEntryRecord[]>`.
3. `PlotArea.tsx`'s `valueTable` memo — narrows that map to the single
   signal an area holds (`signals.length !== 1` gives `null`).
4. `isEnumValueTable(valueTable)` (`types.ts`) — two or more members,
   so a single-member SNA sentinel stays numeric. With `!laneMode` and
   `signals.length === 1` this is `enumMode`.
5. The uPlot construction effect — `enumActiveAtConstruct = enumMode &&
   valueTable != null` selects the middle of three `yAxis` branches.
   The table's raws are captured once per instance as `enumRaws`.
6. **Before:** `splits: () => enumRaws` handed uPlot one tick per table
   row, and `values` formatted each as the raw followed by the quoted
   label through `enumLabelFor`; `size: () => trackGutter(areaId, 80)`
   reserved a flat 80 px whatever those strings measured.
   **After:** `splits: (_u, _idx, min, max, incr) =>
   enumTickSplits(enumRaws, min, max, incr)`, `values` renders
   `String(Math.round(v))`, and `size` measures the drawn strings via
   `measureAxisSize` exactly as the numeric branch does.
7. `trackGutter` then `reportGutterNeed` then `createGutterCoordinator`
   (`plotAxisDerivation.ts`) — the panel agrees one gutter width for
   the whole stack (the widest any axis asks for), latched by
   `axisGutterWidth`'s hysteresis.
8. The scale the ticks land on is pinned in the resample:
   `u.setScale("y", { min: rawMin - 0.5, max: rawMax + 0.5 })` — an
   enum axis plots raw codes un-normalised, so a tick's value *is* a
   raw code.
9. uPlot's own `convergeSize` / `drawAxesGrid` then calls `axis.space`,
   `axis.incrs`, `findIncr`, `axis.splits(...)`, `axis.filter`,
   `axis.values`, `axis.size`, and strokes the result into the gutter.

Separately, and untouched: the *names* reach the canvas through
`laneLabels(table)` (`plotEnumLanes.ts`) inside `drawEnumTiles`, called
from the `PlotArea` draw hook — the single-enum ribbon on branch one,
the per-lane tiles on branch two.

#### Observation (raw data)

Owner, from 0.9.0 use: enum values appear on the y-axis labels; long
names and hundreds of values make it unusable.

#### Hypothesis

The enum branch of `PlotArea`'s y-axis config emits a tick per
value-table row, so tick count and gutter width are both functions of
the table rather than of the axis's pixel height.

#### Experiment — reproduce, with a control that discriminates

A throw-away printing test (deleted before commit) over the existing
`PlotPanel.dom.test.tsx` harness mounted a real `PlotPanel`, dropped one
signal on an `individual` axis, and printed that axis's `splits`
override, tick count, widest label and requested gutter. jsdom has no
canvas 2d context, which short-circuits `measureAxisSize` to a
constant, so the probe stood in a measurer at 6 px a character to make
the gutter observable at all.

Three rows: a 3-value table, a 300-value table with long names, and —
as the **control** — the same axis with **no value table**, i.e. the
ordinary numeric branch. Without the control a reading here is not a
discrimination: it could be reporting the harness.

Data:

| Row | `splits` override | ticks | widest label | gutter |
| --- | --- | --- | --- | --- |
| CONTROL numeric (no table) | **no** | uPlot decides | – | **52 px** |
| enum, 3 values | yes | 3 | 9 ch | **80 px** |
| enum, 300 values | yes | **300** | 26 ch | **80 px** |

Sample labels on the 300 row: `0 "LongishStateName_0"`,
`1 "LongishStateName_1"`, and so on for every one of the 300.

#### Conclusion

Confirmed, and the control locates it exactly: the numeric axis
installs **no** `splits` at all, so uPlot's own density decides, and it
sizes its gutter from the strings it drew (52 px, the floor). The enum
axis opts out of both — a `splits` callback bypasses uPlot's increment
search entirely, and the fixed `80` bypasses the measurement. The tick
count is `valueTable.length`, unbounded, exactly as the task file said.

#### Capping and thinning — leaning on uPlot rather than hand-rolling

The task asked whether uPlot already handles tick density and the
config overrides it, or whether this needs new logic. **Both, and the
answer follows from the first.** uPlot's `findIncr` picks the finest
increment from `numIncrs` whose ticks still clear the axis's minimum
pixel spacing (`space`, 30 px on a y axis) at the axis's current
height, and it *passes that increment to a custom `splits` callback* as
`foundIncr`. So the density calculation is not lost by overriding
`splits` — only its application is.

Ticks must stay on the raw codes (the overseer's ruling; a tick at 1.5
names nothing on an enum axis), so uPlot's default splits cannot simply
be restored. `enumTickSplits` therefore keeps a raw code only when it
is at least `foundIncr` away from the last one kept. The result is
uPlot's own tick count, at positions the codes occupy. No new density
constant was invented and no pixel arithmetic was written: **the cap is
uPlot's, applied to our positions.**

Spacing by *value* rather than by table index is deliberate and is the
one place this is more than a stride: a sparse table `0, 1, 2, 255`
strided every fourth entry keeps all four and stacks three labels in
the bottom 1 % of the axis — the crowding the change exists to remove.

Verified against uPlot 1.6.32's real `numIncrs` / `findIncr` (replayed
in node against `node_modules/uplot`): a 300-value table on a 400 px
axis gives `foundIncr = 25`, so **12 ticks**; at 200 px, 50, so 6; at
800 px, 20, so 15; a 3-value table gives 0.25 and keeps all 3. Tick
count now moves with the axis's height and not with the table's length.

#### The enum-lanes axis: no change, and the evidence for it

The task asked for this branch to be checked separately and for the
owner to be shown both before changing it. **There is nothing to show
and nothing to change**: the `enum-lanes` branch already sets
`splits: () => []`, `values: () => []`, `grid: { show: false }`,
`ticks: { show: false }` and a 14 px gutter — it draws *nothing* in its
y gutter, which ADR 0026 states as a rule and
`PlotPanel.dom.test.tsx`'s "a lanes axis constructs uPlot with stepped
series and a blank y axis" has pinned since it landed. The owner's
report cannot be about a gutter that is empty. Its labels are the
**tiles**, which are the overlay the owner named as the reason the axis
labels are redundant — removing them would delete the thing the ruling
relies on. Left alone.

#### Other enum-label consumers — found, and confirmed still working

`enumLabelFor` in `PlotArea.tsx` had exactly one caller (the axis
`values`), so it was deleted as an orphan of this change. Every other
place a value table becomes text is off the path touched:

| Consumer | Site | Covered by |
| --- | --- | --- |
| Single-enum ribbon tiles | `plotEnumLanes.ts::laneLabels` into `drawEnumTiles` | `PlotArea.draw.test.ts`; new "still names the held value in the overlay" |
| Enum-lanes tiles | same helper, per lane | `PlotArea.draw.test.ts`, `PlotPanel.dom.test.tsx` lane suite |
| Plot side-panel readout, label plus raw | `PlotArea.tsx::formatValueFor` | `PlotPanel.dom.test.tsx` |
| Colormap rule editor's enum list | `ColorMapPanel.tsx` | `ColorMapPanel.dom.test.tsx` |
| Database panel value tables | `DatabasePanel.tsx` | `DatabasePanel.dom.test.tsx` |
| Transmit panel value entry by name | `TransmitSignalsTable.tsx` | `TransmitPanel.dom.test.tsx` |
| Enum combobox options, label plus raw | `useValueTables.ts` | `useValueTables.test.ts`, `RbsSignalsPanel.dom.test.tsx` |
| Signal view / Database live column / expanded trace rows | `SignalValueText.tsx` (host-decoded label, not `useValueTables`) | `SignalValueCell.dom.test.tsx`, `TraceView.signals.dom.test.tsx` |

All green in the full run below.

#### Verification

`npx tsc --noEmit` clean; `npx vite build` clean; `npx vitest run`
**2457 passed / 186 files** (baseline 2449 / 186 — the 8 new tests are
4 in `plotAxisScale.test.ts` and 4 in `PlotPanel.dom.test.tsx`).
`git grep -Ein "task [0-9]|plans/" -- apps/ crates/` empty. No Rust
touched, so the cargo gates were not run.

#### Exit-criterion verdicts

- **No enum label text is drawn on a y-axis.** Met —
  `PlotPanel.dom.test.tsx` "labels its ticks with the raw number
  alone — no enum text" (`values` is `["0", "1", "2"]`, was the raw
  followed by the quoted label), and "bounds its tick count for a table
  with hundreds of values" asserts every label is a bare integer. The
  other two y-axis branches draw no enum text either: the lanes axis
  draws nothing, and the numeric branch formats through
  `denormalizeOnAxis`.
- **An enum signal with hundreds of values renders with a bounded
  number of ticks and a gutter sized to what is actually drawn;
  tested.** Met — same DOM test: a 300-entry table yields at most 13
  ticks (12 at uPlot's real increment for a 400 px axis) and a 52 px
  gutter measured from the drawn strings, against the CONTROL row's
  52 px on a numeric axis. The thinning rule itself is pinned per shape
  in `plotAxisScale.test.ts` `enumTickSplits` (4 cases: dense-enough,
  hundreds, sparse, unsorted-and-clipped).
- **The enum overlay still identifies values, unchanged.** Met —
  `PlotPanel.dom.test.tsx` "still names the held value in the overlay"
  fires the real draw hook on the single-enum instance and finds
  `Idle`, `Run` and `Fault` painted as tile text; no file under the
  overlay's path (`plotEnumLanes.ts`, `drawEnumTiles`,
  `PlotArea.draw.test.ts`) was modified.

## Blockers / side effects

None. Two things worth the overseer's eye, neither blocking:

- The grooming note asked the owner be **shown both** axes before the
  lanes axis changed. No comparison was produced because the lanes
  axis has no y-gutter labels to compare — see the status log. If the
  owner meant the lane *tiles*, that is a different request and
  contradicts the stated reason for this one.
- `plans/owner-review-queue.md` is untracked in the working tree and is
  not this task's; left alone, along with the `Cargo.toml` line-ending
  noise and the two `scratch-perf*` directories.
