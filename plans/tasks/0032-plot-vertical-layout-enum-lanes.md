# Task 32 — Plot Vertical Layout: Fit-to-Panel Weights, Splitters, Enum Lanes

Three coupled vertical-space problems in the plot panel
(`apps/gui/src/PlotPanel.tsx`, governed by ADR 0026). Today every
derived axis gets `flex: 1 1 0; min-height: 90px` and
`.plot-panel-areas` scrolls once N × 90 px exceeds the panel — so
per-unit / individual modes turn the panel into a scroll list.
There is no way to trade height between areas. And enums are
vertically expensive: ADR 0026's per-unit design gives *each* enum
its own axis (and even that `isEnum` slot is unwired —
`PlotPanel.tsx` calls `deriveAxesForArea` without the predicate, so
enums currently just mix into unit groups; the ADR's
"What's still rough" section documents the gap).

Decisions already made (with the user):

- **Fit-to-panel** — all derived axes always visible, no stack
  scrolling; heights are proportional weights.
- **Splitter drag** — draggable separators between adjacent axes
  adjust the two neighbors' weights.
- **Per-unit enum lanes** — all enum signals of an area collect onto
  **one** shared axis, rendered as stacked horizontal lanes
  (logic-analyzer style); each lane draws its tiles with the
  signal's stepped waveform normalized into and centered behind its
  lane band. The combined axis has **no y-gutter labels** (tiles
  carry value labels, the side panel carries identity).

Absorbs two notes from Task 23: "dragging size of plot
areas/individual traces vertically" and "per-unit trace areas should
combine enums … packed tightly to conserve vertical space."

## Design

- **Weights keyed by derived-axis id**, default 1, persisted in the
  panel config as `axisWeights: Record<string, number>` (same
  pattern as `signalsWidthPx`). Applied as inline `flexGrow` — flex
  distributes proportionally, so weights never need renormalizing
  and a new axis simply appears at weight 1. Prune stored entries to
  the live derived-id set. A y-axis-mode change produces new axis
  ids and thus resets that area's custom weights — acceptable, the
  composition changed. The shared enum axis gets the stable id
  `${areaId}/u:enum` (no signal keys), so lane-membership churn
  doesn't reset its weight.
- **Enum-lane axis is a new `DerivedAxis` kind**
  (`"numeric" | "enum-lanes"`). Per-unit derivation buckets all
  enums into one group at the first enum's position in area order.
  `individual` (one enum per axis, existing single-lane render) and
  `unified` (plain numeric) are unchanged. The panel grows a
  panel-level `list_value_tables` fetch to build the `isEnum`
  predicate it currently never passes.
- **Lane scale is a table fact, not observed data.** Each lane's y
  range is its value table's `min − 0.5 … max + 0.5`, mapped into
  the lane's sub-band of the [0, 1] scale. Lane axes ignore fit-y
  snapshots, follow-live host extents, and slice min/max entirely —
  the range-source interaction is designed out. Lane order = area
  config order, top first; hidden signals keep their lane slot
  (stable layout) and draw nothing.
- **Floors move in lockstep**: `.plot-area` CSS `min-height` drops
  90 → 24 px and the three uPlot height floors (`Math.max(60, …)` at
  construction and in the ResizeObserver path) drop to 24, or
  canvases overflow their boxes. Splitter drag clamps at a
  friendlier `AXIS_MIN_PX = 48`; 24 px is only the pathological
  floor, where `overflow: hidden` clips (accepted degenerate,
  noted in the ADR — previously it scrolled).

## Scope

Pure logic lands first as tested helpers (TDD), then the panel
wiring; each slice is independently landable:

1. **`plotAreaLayout.ts`** (new, + test): `axisWeightsFromRaw`
   (tolerant parse), `resolveAxisWeights`, `applySplitterDelta`
   (conserves the pair sum, clamps at min-px, returns the same
   reference on no-op), `pruneAxisWeights` (same reference when
   unchanged — prevents effect loops), `equalizePair`.
2. **Fit-to-panel layout + persistence**: CSS
   (`overflow-y: auto` → `overflow: hidden`, min-height 24),
   `axisWeights` in `PlotPanelParams` / config round-trip, weights
   resolved in the derived-axis JSX map and applied as `flexGrow`,
   uPlot floors lowered.
3. **Splitters**: `role="separator"` divs between adjacent axes
   cloning the side-panel resizer's mousedown/window-mousemove
   pattern (`row-resize` cursor, hit-slop margins); double-click
   equalizes the pair. Weight updates never touch the uPlot
   construction deps, so drags cause no rebuilds; the existing
   equal-size guard breaks ResizeObserver feedback.
4. **Derivation**: `DerivedAxis.kind`, single `enum` bucket in the
   per-unit branch of `plotAxisDerivation.ts` (id
   `${areaId}/u:enum`, subtitle `(enums)` / `name (enum)`), tests
   rewritten from the one-axis-per-enum expectation.
5. **Panel predicate**: panel-level value-table fetch → `enumKeys`
   set → pass `(k) => enumKeys.has(k)` at the `deriveAxesForArea`
   call site; thread `kind` down to `PlotArea` as an `enumLanes`
   prop. Intermediate state is landable (the shared axis renders as
   plain numeric lines until slice 7). Async table resolution shifts
   derived ids once per mount when enums are present — one extra
   uPlot rebuild, same class as today's valueTable-resolution
   rebuild. **Clean up along the way** — this slice adds a fourth
   `list_value_tables` fetch to PlotPanel, exactly the duplication
   [Task 30 § #14](0030-code-quality-dedup.md) targets (`useValueTables`
   hook across ColorMapPanel / PlotPanel / RbsPanel / TransmitPanel).
   Build/consume that shared hook here instead of adding another copy,
   and use it to serve the `enumKeys` set.
6. **`plotEnumLanes.ts`** (new, + test): `laneBands` (top-first
   sub-intervals of [0, 1] with a small gap), `laneValueRange`,
   `normalizeIntoLane`, `laneTileBand` (centered, min-px, capped).
7. **Lane rendering in `PlotArea`**: resample branch normalizes each
   enum into its lane band (missing table → flat lane midline) and
   skips the range machinery; construction gets a blank y axis
   (`size` small, no splits/values/grid) and stepped paths for all
   series; the existing tile-drawing block is extracted into a
   `drawEnumTiles(...)` helper taking a band rect, called once per
   lane (and once, full-band, by the existing single-enum path);
   `fitY` is a no-op on lane axes so no stale manual latch survives
   a mode switch. The waveform-behind-tiles requirement falls out:
   uPlot draws the stepped line inside the lane band and the
   ~0.65-alpha tile fill keeps it visible. Value→color tints
   (ADR 0029) generalize from the single `enumTarget` to
   per-signal targets.

ADR 0026 and the `docs/CONTEXT.md` glossary ("Y-axis mode",
"Logic-analyzer lane") are updated in the same commits as the
behavior they describe. Follow-up for the backlog, not this task:
the panel- and area-level value-table fetches coexist after slice 5
— pass the panel's map down and delete the area copy. This is the
same seam as [Task 30 § #14](0030-code-quality-dedup.md); collapsing
both PlotPanel fetches into the shared `useValueTables` hook resolves
it.

## Overlap with Task 30 (code-quality dedup)

This task edits `PlotPanel.tsx` — the largest file called out in
[Task 30's god-file split](0030-code-quality-dedup.md) — so several
of its dedup items are in scope to knock out along the way rather than
after:

- **§ #14 value-table fetch (×4)** — see slice 5 and the follow-up
  note above; land the `useValueTables` hook here.
- **PlotPanel.tsx / `PlotArea` split** — slices 3 and 7 already carve
  logic out into new tested modules (`plotAreaLayout.ts`,
  `plotEnumLanes.ts`) and extract `drawEnumTiles` from the ~1,670-line
  `PlotArea`. That is exactly the direction Task 30's decomposition
  sketch wants; keep new surface in these modules rather than growing
  `PlotArea`. While in the slice-3 drag/drop code, fold the duplicated
  drop-target logic Task 30 flags (PlotPanel.tsx 3193–3215 vs
  3398–3421 — re-confirm the lines, they drift) if it is a small
  reach.

Out of scope here (owned elsewhere): `decimatePoints` dead-code
removal in `plotData.ts` (Task 30 § #21) is assigned to Task 25; the
`plotSignalIdentity.ts` identity/palette extraction is a broader
PlotPanel↔plotFilter refactor best left to Task 30 proper.

## Design questions

- Lane gap fraction and tile-band fraction within a lane (defaults
  to tune by eye; the helpers make them parameters).
- Does the blank-gutter enum axis need any hover affordance to name
  the lane under the cursor, or is the side panel enough? (Start
  with side panel only.)

## Exit criteria

- Tests-first pure modules: `plotAreaLayout` (conservation, clamps,
  reference-identity no-ops, garbage parse) and `plotEnumLanes`
  (band coverage/order, degenerate counts 0/1, single-value table →
  non-zero span) pass.
- Derivation tests prove one shared `enum-lanes` axis carrying all
  of an area's enums in config order, with a membership-stable id,
  and unchanged `unified` / `individual` output.
- DOM tests: `.plot-area` elements carry resolved `flexGrow`;
  `axisWeights` round-trips through `updateParameters`; N axes
  render N − 1 separators; a synthetic drag changes exactly the two
  neighbors and conserves their sum; a lanes axis constructs uPlot
  with stepped series and a blank y axis.
- Manually verified: a per-unit area with 2–3 enums plus numeric
  signals shows one compact stacked-lane axis (tiles, labels,
  color-map tints, waveforms centered per lane); 6+ axes always fit
  the panel with no scrollbar; splitter drag feels right and
  weights survive an app restart; fit-y / follow-live still behave
  on numeric axes.
- ADR 0026 and CONTEXT.md match the shipped behavior; Task 23's
  notes no longer carry the two absorbed items.
