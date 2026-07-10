# Task 32 — Initial Hands-On Feedback

The first round of fixes from actually using the GUI in anger. A
grab-bag of concrete, independently-shippable items — each lands with a
test or a documented manual repro. Not a feature; the theme is "things
that felt wrong the first time a real user drove the tool."

## Items

### 1. Persistent BLF channel↔bus mapping

Loading a BLF assigns its channels to project buses (the ordered
project bus list maps 1:1 to BLF channel numbers — channel `N` ↔
`project.buses[N]`; see [`../../CLAUDE.md`](../../CLAUDE.md) § File
formats). That assignment is lost on reload: reopening the same BLF
makes the user re-map every time. Persist it so a reloaded BLF keeps
its channel→bus mapping.

**Decided — rides in host-side `state.json`**
([ADR 0032](../../docs/adr/0032-machine-local-ui-state-host-side.md) /
[ADR 0034](../../docs/adr/0034-settings-vs-state-and-custom-settings-panel.md)),
not the BLF (bus ids are project-scoped; mutating a user's capture on
open is wrong) and not the project file. It is durable machine-local
state — unlike the spill caches it is user-authored and not
recomputable, so it must not be evictable.

- Shape: nested map `project_id (UUID) → { absolute BLF path →
  { channel → bus_id } }`. Bus identity is `Bus.id` (stable across
  renames), not `name`.
- A stored `bus_id` no longer present in the project degrades to
  unmapped for that channel.
- UX: the mapping **pre-fills the channel↔bus selection dialog** as
  defaults; the user can change them, and whatever they last accept
  is stored back. Not a silent auto-apply.
- The existing global `recent_blfs` list in `state.json` stays as-is;
  this is a new nested entry, not a recents restructure.

### 2. Trace-view inline signals rework

The trace view's expanded-row decoded signals should render as inline
lines under the message row, replacing today's expand-to-show grid —
the trace-side counterpart to "signals are first-class." (Moved here
from Task 20; the signal-*view* panel stays in Task 20.)

**Decided — pure view-layer rework.** The grid's *content* was right
(name, value+unit, enum label via `formatSignalValueWithLabel`); the
problem was layout — it wrapped poorly and couldn't fit consistently.
Replace it with nested sub-rows: one line per signal, indented under
the message row. Expanded row height becomes `ROW_HEIGHT + n_signals ×
line height` (variable-height placements; no cap). Signals already
arrive with the paged frame (`TraceFrameRecord.decoded.signals`), so
no new host command; expansion stays view-local. Each line remains a
drag source for plot drag-drop.

### 3. Consistent time-label format across trace and plot

The relative-time label is formatted differently in the trace view and
the plot view. Both derive time through the shared `useTrace` timing
model ([ADR 0024](../../docs/adr/0024-trace-like-view-timing.md)); the
*rendering* diverges. Unify the format (one shared formatter) so a
timestamp reads identically in both surfaces.

**Decided.** All timeline *positions* (trace rows, plot cursor x
readout, plot x-axis ticks) use `formatElapsed` from `format.ts`,
extended with adaptive fractional precision chosen from the plot's
visible x-window span (trace keeps the 4-decimal default). *Durations*
(Δ(A−B), periods) stay in seconds — `s.ffff`-style, trailing zeros
trimmed, no SI unit scaling; `0.00003 s`-scale values render as-is.

### 4. Plot cursor values across all plot areas

A plot panel stacks multiple filter-defined plot areas
([ADR 0020](../../docs/adr/0020-filter-defined-plot-areas.md)). The
cursor should display each series' value in *every* plot area it
crosses, not just the area under the pointer — one shared x-cursor,
per-area value readouts.

**Decided.** This is specifically the mouse *crosshair*: `hoverX` is
per-`PlotArea` state today, while cursor A/B and note cursors are
panel-level and already read out across areas. Lift `hoverX` to
`PlotPanel` (one shared x, single rAF throttle); every area draws the
crosshair line at that x *and* computes its side-panel readouts from
it.

### 5. Native window controls; fix macOS maximize

Prefer native OS window controls over the current custom chrome. In
particular, maximize/zoom on macOS does not behave correctly today.
Switch to native decorations and verify minimize / maximize (zoom) /
close on each supported OS.

**Decided.** Full native: `decorations: true`, delete `TitleBar.tsx`
(it carries no functionality beyond controls/branding; no hybrid
overlay styles). Native window title set dynamically to
`<project name> — cannet` (bare `cannet` with no project). The
always-visible version string goes away — version lives in
About/diagnostics.

### 6. New views don't hook into the session buffer

A trace or plot view added mid-session comes up **empty** — it only
becomes a window onto the buffer after the capture is restarted or the
BLF is re-loaded. A new view must subscribe to the existing session
buffer at creation (thin-view rule — see
[`../../CLAUDE.md`](../../CLAUDE.md) § GUI architecture), not rely on
the next load to wire it up. Fix the subscribe-on-create path for both
view types.

**Decided.** Today's "created mid-session starts stopped" behavior is
deliberate (see the comment by `startAllElements` in `App.tsx`) and is
overturned: `create` initializes the element the same way
`startAllElements` does — anchored at 0, spanning the existing buffer,
following live — whenever a session buffer exists. New views become
indistinguishable from views present at session start; the special
case and its comment are deleted.

### 7. Crash loading a BLF in a release build

Loading a BLF crashes the app in a **release** build (not seen in dev).
Reproduce against a release build, capture the failure, and fix — a
release-only crash on the primary load path is a blocker for the alpha.
Lands with a regression test (or a documented repro if it turns out to
be a release-profile-only path).

**Observations so far** (macOS crash report,
`crash-report-open-blf-while-previous-blf-stalled.txt`): trigger was
opening a BLF **while a previous BLF load was stalled**. Main thread,
`SIGABRT` from a Rust panic: `core::result::unwrap_failed` inside
`TraceStore::start_session`, called from `clear_trace_store`. The
original BLF is not available; severity unknown until reproduced.

**Hypotheses** (both consistent with the stack; neither confirmed):

- H1 — poisoned store mutex: the stalled loader thread panicked while
  holding the lock; `start_session`'s
  `expect("trace store mutex poisoned")` (`trace_store.rs`) fires on
  the next open.
- H2 — scratch-clear I/O failure: `raw.clear()` →
  `DiskRawStore::clear`'s
  `expect("cannet-spill: clearing scratch segments failed")`
  (`cannet-spill/src/disk.rs`), racing the stalled load's in-flight
  segment writes.

**Experiment first, then fix**: reproduce against a release build with
a large/slow BLF — open a second BLF mid-load — capturing stderr; the
panic *message* discriminates H1 from H2 (and H1 implies a prior
loader-thread panic whose message is the real root cause). No fix
until the repro exists.

### 8. fzf filter on the colour map and other signal/message pickers

The DBC panel filters with `fzf`; the plot **colour-map** picker and
the other signal/message search boxes across the GUI don't. Give them
the same fzf-backed filter so choosing a signal or message feels the
same everywhere.

**Decided.** Fuzzy matching stays frontend (the `fzf` npm package —
there is no Rust-side matcher; today's consumers are DbcPanel,
PaletteModal, RbsPanel). Build one shared combobox control: text
input plus fzf-filtered dropdown, keyboard nav, rendering
**hierarchically**
(bus → ecu → message → signal, like the DBC panel) when the options are
hierarchical and flat otherwise. Hand-rolled (crib PaletteModal's
fzf-list pattern), no new dependency. Adopt in: the colour-map signal
picker (today a plain unfiltered `<select>`), the CalcFieldEditor
destination pickers, the transmit panel's catalog pickers, **and every
remaining `<select>`/combobox in the GUI** — small fixed enum selects
(operators, modes) included, as the flat degenerate case.
DbcPanel/PaletteModal/RbsPanel keep their existing fzf UIs. Convention
going forward: any new select/combobox uses this control.

### 9. Don't treat single-member enums as enums

A signal whose value table has a **single** member (typically just an
SNA sentinel) currently renders *every* value through that enum, so
ordinary values get shown as the lone enum label. Stop treating
single-member value tables as enums — decode such signals as raw
numeric (keeping the unit when one is specified). Scope is deliberately
narrow: only single-member tables, at least for now.

**Decided.** Separate "is an enum" from "has labels", centrally in
`cannet-dbc`: `is_enum = value_table.len() >= 2`. The enum-driven UI
(plot enum y-axis, per-unit axis stacking, unit suppression, enum
mode) keys on `is_enum`, so single-member signals get a numeric axis
with unit. Labels stay available everywhere: `list_value_tables`
still returns single-member tables, and both the trace row and the
plot readout render the label on an **exact raw match** (`65535
"SNA"`) — a label attached by equality can't mislabel ordinary
values.

### 10. Plot visibility toggle blanks all series until redraw

Toggling one series' show/hide state makes **every** series disappear
from the plot area; a pan or zoom (anything that forces a
resample/redraw) brings them back. Make the toggle redraw in place.

**Debug needed — mechanism unknown.** Observed with a loaded capture,
not live, not connected (data present, session stopped). Note the
obvious explanation is contradicted by the code: `PlotPanel.tsx`
already has an in-place effect (`u.setSeries(i + 1, { show })` keyed
on the hidden flags) and `setSeries` redraws by itself — so this is
*not* a missing redraw call. Reproduce first, instrument whether that
effect fires and with what indices, then fix with a regression test.

## Exit criteria

- A reloaded BLF pre-fills the channel↔bus dialog from `state.json`
  (keyed `project_id` → absolute BLF path → `channel → bus_id`); the
  last-accepted mapping is stored back; covered by a test.
- Trace-row expanded signals render as inline lines under the row (grid
  removed); covered by a frontend test.
- Trace and plot render the same relative-time string for the same
  timeline position (shared `formatElapsed`, plot precision adapted to
  the visible x-span; durations in trimmed seconds), covered by a test.
- The plot mouse crosshair draws in all stacked plot areas and each
  area's readouts show per-series values at the shared x.
- Native window controls are in use (`TitleBar.tsx` gone, dynamic
  native title); macOS maximize/zoom works, with a documented manual
  repro per OS.
- A view created mid-session immediately shows the existing buffer
  anchored at 0 and following live (no restart / re-load needed);
  covered by a test for both view types.
- The BLF release-build crash is reproduced and fixed, with a
  regression test (or a documented repro if it's release-profile-only).
- Every `<select>`/combobox in the GUI uses the shared fzf combobox
  (hierarchical for catalog pickers), including the colour-map picker.
- Single-member value tables are not enums (`is_enum` requires ≥ 2
  members): numeric plot axis with unit, exact-match label preserved
  in trace and plot readouts; covered by a test.
- Toggling a series' visibility redraws in place without blanking the
  other series, with the mechanism confirmed by repro before the fix.
