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
