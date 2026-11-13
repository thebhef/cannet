# Task 166 — Plot Panel Fixes

> **Opened 2026-10-13** from four owner-reported items in
> `plans/ungroomed-user-feedback.md` (collapse, label hiding, copy-drag,
> and the 0.10.0 line-without-a-point report). Groomed 2026-10-14;
> all four phases landed; awaiting the owner's acceptance.

## Why

Four things the plot panel does that a user reading it finds wrong,
each small, each in the plot's side panel or series drawing. None
changes what the plot *is*; together they are one pass over the plot
panel.

## Items

### 1. Collapse is an axis thing (feedback item 9)

> Sub-area collapse is confusing; we have ability to collapse an area
> and then independently each sub-area. I think subareas probably
> should be collapsible, not the top-level area, when we have per-unit
> enabled. — owner, 2026-10-13

Today two independent stores are ORed into one collapsed state:
`PlotAreaConfig.collapsed` (per plot area, the project element config)
and `PlotPanelParams.axisCollapsed[axisId]` (per derived axis). In
per-unit and individual mode the first axis head carries both toggles
side by side (`PlotArea.tsx` `.plot-area-collapse` beside the grip,
`.plot-axis-collapse` between the area label and the axis label), and
expanding the area resurfaces whatever axis collapses sat underneath
it. ADR 0026 § "An area can be collapsed" / "An axis can be collapsed"
documents both as intended.

**Ruling (owner, 2026-10-13):** collapse exists **only at the axis
level**, and the disclosure toggle sits at the **left-hand end of the
head bar — never in the middle**.

Design that follows:

- The area flag goes: `PlotAreaConfig.collapsed`, `toggleAreaCollapsed`,
  `collapsedByFlag`, the "only the first axis of a collapsed area
  renders" filter, and the collapsed-run drag handle built on it. A
  project carrying `collapsed: true` on an area opens with that area
  expanded (the key is dropped on read, no migration — the thing it
  described no longer exists).
- Every derived axis head — unified mode's single axis included — gets
  one `DisclosureToggle` writing `axisCollapsed[axisId]`, as the
  leftmost element of the head. On the parent head the grip follows
  it; the area label, separator, axis label and the rest keep their
  order after that.
- The all-hidden automatic collapse (`collapsedBySolo` / every signal
  hidden) stays, per axis, with its inert toggle and reason.
- ADR 0026 is amended to one collapse (per axis); CONTEXT.md's
  **Collapse** entry loses its plot-area half.

### 2. A label that does not fit hides all at once (feedback item 11)

> plot bus/ecu/message names get hidden all at once as soon as the whole
> thing doesn't fit. — owner, 2026-10-13

No fit logic exists; this is CSS. `.plot-signal-message` holds the bus
dot(s) and one `NameText` for the joined `bus · ecu · message` string
(`plotSignalLabel.ts::signalRowLabel`). A string over 32 characters
renders `NameText`'s head/tail split as an `inline-flex` box with
`max-width: 100%`; the dot in front pushes that box past the line, and
the parent's `text-overflow: ellipsis` hides an atomic inline box
whole (`index.css` `.plot-signal-message`, `.name-text`). Inferred from
the CSS, not yet reproduced in a browser — the phase reproduces it
first. The expected behaviour is the one short labels already have:
progressive middle-ellipsis, the tail kept.

### 3. Copy-drag follows the platform (feedback item 12)

> Alt+drag/ctrl+drag of plot areas should copy on mac/win respectively.
> — owner, 2026-10-13

ADR 0045 specifies "plot area: move here, Ctrl to copy". Only
`e.ctrlKey` is read, at the drop (`PlotArea.tsx::areaDrop`); `altKey`
and `metaKey` never are, `dragover` always forces `dropEffect = "move"`
so the pointer never shows a copy cursor, and a same-panel drop is
always a reorder whatever the modifier.

**Ruling (owner, 2026-10-14):** a modifier drop inside the same panel
copies the area too — "that's baseline computer behavior going back
decades". The modifier is Alt on macOS and Ctrl elsewhere, read at the
drop; the drag cursor shows copy while it is held (`dropEffect` follows
the modifier during `dragover`). No modifier: same-panel drop stays the
reorder, cross-panel drop stays the move. ADR 0045's drop table is
amended with the platform rule and the same-panel copy.

### 4. A line bends where no sample is (feedback item 10)

> weird plotting artifact reported on 0.10.0, saw line but no point,
> and couldn't find a corresponding message to the point. — owner
> relaying, 2026-10-13

Investigation (2026-10-13, from the code; no repro available):

| Candidate | Where | Status |
|---|---|---|
| v0.10.0 capped markers at 500 by stride, so extrema lost their dot | `plotPoints.ts` at v0.10.0 | fixed after the tag, #499 `a4b374fc` |
| `Points: auto` hides every marker on an axis once a fast neighbour exceeds uPlot's density rule (32-sample floor) | `plotPoints.ts::AUTO_POINT_MARKER_FLOOR` | by design, ADR 0026 |
| **The merged grid.** `plotData.ts::mergeSeries` sample-and-holds every series onto the union of all series' timestamps (plus an invented `(a+b)/2` column per interior extrapolated stretch); ordinary series then draw uPlot's default *linear* path over those rows. Between two samples A and B of one signal the line runs flat through every neighbour column and then diagonally into B — a corner at another signal's timestamp, where no message of this signal exists and no marker can ever sit | `plotData.ts:170-228`, `PlotArea.tsx` series config | **present at HEAD** |
| No plot → trace action; the user matches by elapsed time by hand | `GOTO_EVENT` is never emitted by the plot | feature gap, not in this task |

The third row is this task's defect: how a series is drawn between its
own samples depends on which other series share its axis. Enum and
lane series already use `uPlot.paths.stepped`, so only ranged series
have the artifact.

**Ruling (owner, 2026-10-14):** option A — a ranged series' line is
linear between its own consecutive samples, with vertices at its own
samples only; non-sample columns of the merged grid carry `null` and
the path spans the gap; the sample-and-hold stays only on the
extrapolated stretches (dashed) ADR 0026 already defines. Step/hold
for on-change series remains task 39's.

> OBVIOUSLY a series' value should not be affected by unrelated series
> values because they happen to be plotted together. — owner

ADR 0026 § "Where the plot extrapolates" is amended: "a stall between
two samples is drawn as a line straight through it" becomes literally
that — a straight segment between the two samples, whatever else
shares the axis.

## Phases

Groomed 2026-10-14 (Q1–Q3 ruled); branches beneath `doc-closeout-2`,
sequential in the shared tree.

1. Axis-level collapse only, disclosure leftmost (item 1) — Sonnet,
   `task166-axis-collapse`.
2. Progressive label ellipsis (item 2) — Sonnet, `task166-label-ellipsis`.
3. Platform copy modifier, copy cursor, same-panel copy (item 3),
   ADR 0045 amended — Sonnet, `task166-copy-drag`.
4. Line vertices only at a series' own samples (item 4), ADR 0026
   amended — Opus, `task166-own-sample-lines`.

## Exit criteria

- [x] No `collapsed` flag on a plot area; one disclosure per axis head,
      leftmost; unified-mode heads have one too. ADR 0026 and
      CONTEXT.md **Collapse** say so. (phase 1, e7f941f9)
- [x] A long `bus · ecu · message` label shrinks progressively with the
      column, never vanishing whole. (phase 2, 15b27cb4 — mechanism
      reasoned from the CSS; the owner's own run is the browser check)
- [x] Alt-drag copies a plot area on macOS, Ctrl-drag on Windows and
      Linux; the pointer shows copy while the modifier is held; the
      same-panel modifier drop copies. ADR 0045's table matches. (phase
      3, b24d62fc; macOS path awaits the owner's run)
- [x] A ranged series' line has vertices only at its own samples; the
      drawing between two samples no longer depends on neighbouring
      series. ADR 0026 § extrapolation matches. (phase 4, d40c57d8)
- [x] Each phase: six-job local CI green, `comment-references` grep
      clean. (frontend lanes on every phase; Rust/Python/proto lanes
      unreachable by every diff — nothing under `src-tauri`, `crates/`,
      `servers/` or `proto/` changed)

## Status log

- **2026-10-14 — Phase 1 (axis-level collapse only) landed on
  `task166-axis-collapse` @ e7f941f9** (single commit, no pre-squash
  history). Removed `PlotAreaConfig.collapsed` (a persisted `collapsed:
  true` is dropped on read, no migration), `toggleAreaCollapsed`,
  `collapsedByFlag`, the first-of-parent filter and the
  `.plot-area-collapse` toggle. Every axis head, unified mode's
  included, carries one `.plot-axis-collapse` toggle as its leftmost
  element, the grip next on the parent head; the mode combobox,
  patterns button and remove × stay on the parent head whether or not
  its axis is collapsed. The all-hidden/solo collapse and the
  collapsed-run drag handle are kept. The derived-config memo is keyed
  per area by its own collapsed axis ids, so one axis toggle re-renders
  one area (the existing single-area re-render test now covers axis
  collapse). ADR 0026, CONTEXT.md **Collapse**, README and two ADR 0045
  phrases updated (its drop table waits for phase 3). Vitest 3873/3873,
  tsc and build clean, comment-references grep 0 hits,
  `check_local_paths` clean; Rust, Python and proto lanes not reachable
  by the diff. 12 files, +272/−437. Overseer review: faithful to the
  ruling; one nit (memo key joins ids with an empty separator) left as
  is.
- **2026-10-14 — Phase 2 (label ellipsis) landed on
  `task166-label-ellipsis` @ 15b27cb4** (single commit; the plot-only
  first form was c7da2e6a, amended after the overseer's send-back).
  Mechanism inferred from the CSS, not browser-reproduced (jsdom does
  no layout): `.name-text` is an atomic inline-flex box, and a block
  line with `text-overflow: ellipsis` hides an atomic inline whole once
  a sibling ahead of it (bus dot, CAN id) pushes it past the line. Fix
  at the shared layer: `.name-row` is a flex row whose siblings are
  `flex: none` and whose `.name-row-text` box alone shrinks and
  ellipsizes, so the name's head gives way and the tail stays. Backs
  the plot legend's message line and the message cells of the Signals
  (math bus dots, file-backed badge), View Signals (CAN id, unknown-unit
  flag when shown) and RBS Signals (CAN id) panels. `nameOverflow.test.
  ts` asserts the stylesheet contract and lists each surface; ADR 0026
  notes the rule. `.plot-area-axis-label` and the Signals panel's signal
  column unchanged (no fixed sibling). Full frontend suite run twice by
  the overseer (c7da2e6a and 15b27cb4): 3874/3874 both times; build
  clean; comment-references grep 0 hits. 8 files, +93/−23. The agent
  saw one intermediate `PlotPanel.dom` failure ("moves the crosshair and
  places a cursor without one series repaint") that passed on re-run
  with no related change — recorded in the review queue § 3 as a
  possible flaky test.

- **2026-10-14 — Phase 3 (platform copy modifier) landed on
  `task166-copy-drag` @ b24d62fc** (single commit).
  `plotAreaTransfer.ts::isCopyDrag` is the one rule — Alt on macOS,
  Ctrl elsewhere — on the existing `keybindings.isMacPlatform`;
  `copyModifierLabel` spells it for the grip and collapsed-handle
  tooltips. `dragover` sets `dropEffect` copy/move from the modifier on
  every event, so the pointer follows a mid-drag toggle. A modifier drop
  copies the area under a fresh id with ranges re-keyed, in the same
  panel or another; a plain drop keeps the same-panel reorder and the
  cross-panel move; the claim registry runs only on a move. ADR 0045's
  drop table and prose amended; CONTEXT.md and README had no
  Ctrl-to-copy mention. Tests: 3 `isCopyDrag` units, 4 PlotPanel DOM
  tests (replacing the old "same-panel, Ctrl or no Ctrl" one). Full
  frontend suite 3880/3880, build clean, comment-references grep 0
  hits; Rust/Python lanes unreachable. 6 files, +123/−29. Not verified:
  the real macOS Alt path and the visible cursor (jsdom reports non-Mac
  and has no pointer) — the owner's Mac run is the check. Agent wrote
  tests alongside code rather than red-first.

- **2026-10-14 — Phase 4 (own-sample lines) landed on
  `task166-own-sample-lines` @ d40c57d8** (single commit).
  `mergeSeries` fills a row only at the series' own sample columns;
  between its first and last sample the other columns are `undefined`
  (`MergedValue = number | null | undefined`): uPlot 1.6.32's linear
  path joins across `undefined` and breaks at `null`, so a ranged line
  is straight between its own samples whatever shares the axis.
  `spanGaps: true` was rejected — it would also join the `null` blanks
  `splitExtrapolatedRows` writes to keep a stall's solid stroke out from
  under its dashes. The hold is kept past the last sample (the dashed
  tail), on a one-sample series, and — via `{ hold: true }` — on tile
  axes (lanes, single enum) whose stepped runs need every column. The
  minted stall midpoint is unchanged. Markers, the `auto` density rule
  and cursor readouts are unaffected. ADR 0026 § extrapolation gains
  the straight-segment rule and its reason; its marker and one-sample
  paragraphs no longer describe a universal hold. Tests red-first:
  mergeSeries rows, a stall with neighbour columns inside it, a
  real-uPlot `Path2D` recording (vertices at own samples only, stall
  still a gap), two panel data tests. Full frontend suite 3887/3887,
  build clean, comment-references grep 0 hits, local-paths hooks clean;
  Rust/Python lanes unreachable. 7 files, +313/−49. **No perf reading:**
  the ADR 0031 harness needs the PEAK dongles and a `tauri build`
  release host, both outside what agents may do — owed at close-out
  (see Blockers / side effects). Overseer note: the fix leans on uPlot's
  `undefined`-is-spanned convention, read from its source at the pinned
  version; a uPlot upgrade must re-check it (the path test will catch
  it).

## Blockers / side effects

- **Perf reading owed (2026-10-14).** Phase 4 touched the render data
  path (`mergeSeries`) and no ADR 0031 frontend reading was taken: the
  harness needs the PEAK dongles and a `tauri build` release host.
  Owed at the next cycle boundary the owner runs (or lends the dongles
  for). Expected effect: none measurable — the merge does the same
  single walk, writing `undefined` instead of a held number.
- **Not verifiable in jsdom, owner's run is the check:** the label
  ellipsis in a real browser (phase 2); the macOS Alt-drag path and
  the visible copy cursor (phase 3).
