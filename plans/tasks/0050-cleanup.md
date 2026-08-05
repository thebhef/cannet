# Task 50 — Cleanup and Usage Fixes

Loose ends carried out of task 48, plus a further round of defects and
small features found by using the app.

They share no design and gate nothing. Land them independently, one
commit each, and strike each as it goes.

## 1. Show progress while a cold signal cache builds

**Done.** An area waiting on the first sample for its signal set draws an
indeterminate `building…` overlay over its canvas. Frontend only — no
host-side progress reporting, no new IPC, and the cold-pyramid design
(`SignalCacheStore::new` wipes its root every launch) is unchanged.

**Where the pending state lives: a new
`apps/gui/src/useFirstSampleWait.ts`**, a view-local hook holding one
boolean and one timer. It is armed by the *signal set*, not the area:
`PlotArea` passes `signals.length > 0 ? signalSetKey : null`, so a
changed set re-arms and an empty area arms nothing. `PlotArea`'s
`resample` calls the hook's `settled()` immediately after the
`outcome.kind === "pending"` early-return — past that point the area
knows what it holds, and `settled()` disarms until the set changes
again. That one call site covers `empty`, `unchanged` and `sampled`.

**Threshold: 300 ms** (`FIRST_SAMPLE_INDICATOR_MS`). The gate is the
load-bearing half — the first fetch after *any* signal-set change is a
whole-window one (the re-anchor clears `useDecimatedRange`'s `base`, and
with no `base` the request carries `fromSeconds`/`toSeconds` of `null`),
so this path fires on every signal add and an ungated indicator would
flash as jitter.

**How it is distinguished from "no data":** three states, three
renderings. *No signals* — the side panel's existing "pick a signal
above" empty state, and the gate is never armed (`null` key). *No data* —
the `empty` outcome settles the wait, so a collapsed window draws a bare
canvas exactly as before. *Not yet* — the overlay, and only after the
gate. Indeterminate rather than a percentage because the host discovers
the decode work while doing it; and the round-trip costs the UI thread
nothing (0.6 % of the main thread in task 48 item 12's profile), so this
informs rather than unblocks.

**Presentation:** `.plot-area-building` — a sliding chip on a 6 rem
track plus italic muted `building…`, matching `.plot-area-empty`'s
muted-italic idiom and the panel's `#4ecbff` accent. Absolutely
positioned over the canvas column (`.plot-area` gains `position:
relative`; the side panel's width is excluded by an inline `right`), so
nothing reflows when it clears, and `pointer-events: none` keeps the
canvas's gestures. It is the repo's first `@keyframes`, so it carries a
`prefers-reduced-motion` opt-out.

Tests: `apps/gui/src/useFirstSampleWait.test.tsx` — six fake-timer cases
(nothing under the gate, indication after it, cleared on arrival, no
signals never arms, a changed set re-arms, emptying the area clears).
Wiring is covered by two `PlotPanel.dom.test.tsx` cases over a stalled
`sample_signals`; both failed before the change. The stall fixture now
parks its resolver so a test can let the slow fetch *finish* — a fresh
fetch could not, since the in-flight one holds the area's resample guard,
which is exactly what the real slow sample does.

## 2. Restore the commit gate — surgically

**Done.** `cargo test` is a commit gate again, scoped to the crates a
commit touches; the frontend hook runs the whole vitest suite alongside
its build. Both hooks' comments now state what they run, what it costs
and what it misses.

**The Rust gate: `scripts/cargo-test-touched.sh`.** pre-commit passes
the staged filenames; the script maps each to the crate that owns it
(`crates/<name>/…` → `<name>`, `apps/gui/src-tauri/…` → `cannet-gui`)
and issues one `cargo test -p …` over the union. A root `Cargo.toml` /
`Cargo.lock` / `rust-toolchain.toml`, or any Rust path with no rule,
falls back to `--workspace` rather than guessing and under-testing. A
frontend-only commit never reaches the hook (`files:` filters it out).

**Measured here** (Windows, warm target dir), marginal cost on top of
the clippy hook that runs first:

| commit touching | scoped | `cargo test --workspace` |
| --- | --- | --- |
| `crates/cannet-dbc` | 4.2 s | 49.0 s |
| `apps/gui/src-tauri` | 23.9 s | 46.8 s |
| nothing to rebuild | 1.0–4.9 s | 17.3–18.9 s |

**The item's "clippy already builds every target" hypothesis is false.**
clippy checks metadata only, so `cargo test` still pays codegen and
linking: after a `cannet-dbc` edit, clippy (9.3 s) is followed by 4.2 s
of test work against 1.0–2.1 s with nothing to rebuild; for
`cannet-gui`, 23.9 s against 4.7 s. The saving is real, but it comes
from scoping, not from clippy having pre-built anything.

**Dependents are deliberately not included, and the measurement is
why.** `cannet-perf-measurement` and `cannet-gui` between them depend on
nearly every crate, so "touched crates + their dependents" is the entire
workspace for anything under `cannet-core` or `cannet-blf`, and costs
41.9 s for a `cannet-dbc` change — the blanket run this replaces,
wearing a scoped name. Type-level breakage in a dependent is still
caught, because `cargo clippy --workspace --all-targets` runs first and
compiles every dependent's test targets.

**Frontend: the whole suite, concurrent with the build**
(`scripts/frontend-gate.sh`). `vitest related` over the files of three
real commits from this stack ran in 20.3 / 29.8 / 28.2 s against 41.0 s
for all 109 files (1216 tests) — vitest's worker + jsdom startup
dominates (one file costs 4.4 s, 24 files 31.3 s), so scoping buys
~13 s while mapping a deleted file or a config change to *no tests at
all*. The guess that it would also miss the stylesheet assertions was
**refuted**: `dockPanelScrolling.test.ts` imports `./index.css?raw`, so
`vitest related src/index.css` does find it — the import graph is
better than assumed, the arithmetic still isn't. Build and suite are
independent, so the script runs both and waits on each: 41.8 / 40.6 /
41.5 s across three runs against 67 s in sequence (`pnpm build` alone is
25.7 s). Each job's output is buffered and printed only if that job
failed, so a failure reads as one tool's output rather than two
interleaved ones.

**`cargo-nextest`: rejected**, entry in
`plans/technology-inventory.md`. It was not installed; installing it to
measure cost 3 m 35 s from source. On Windows it is *slower* than
`cargo test` here, because it spawns a process per test:
`-p cannet-gui` 8.9–9.3 s against 4.7–5.2 s, `-p cannet-dbc` 3.1 s
against 1.0–2.1 s, `--workspace` 18.3 s against 17.3 s. There is also
nothing left to win — the scoped gate's test *execution* share is 1–5 s
and the rest is codegen and linking, which nextest does not change. It
would add an unpinned per-clone prerequisite and silently stop running
doctests (the workspace has none today, so nothing is lost yet, but a
future one would be invisible locally). It has been uninstalled again.

**What the gate can still miss**, said in the config comment rather than
papered over:

- A *behavioural* break in a crate that merely depends on what changed.
  CI's `cargo test --workspace` catches it per-PR.
- Anything that only appears under the workspace's unified feature
  resolution. Cargo unifies features over the *selected* packages, so
  `-p <crate>` and `--workspace` produce different builds of shared
  dependencies; that is also why alternating between this hook and a
  hand-run `cargo test --workspace` rebuilds (measured 23.6–45.2 s each
  way). Expected, not a fault. Alternating `-p` sets between commits
  does *not* thrash (measured 1.0 / 4.8 / 1.5 s over a
  dbc → gui → core+blf cycle).

**Verified** by driving the hooks rather than reading them. A cargo shim
on `PATH` shows the selection: `crates/cannet-dbc/src/lib.rs` →
`test -p cannet-dbc`; that plus `crates/cannet-core/src/lib.rs`,
`apps/gui/src-tauri/src/state.rs` and `crates/cannet-blf/Cargo.toml` →
`test -p cannet-core -p cannet-gui -p cannet-blf`; `Cargo.lock`,
`rust-toolchain.toml` or an unrecognised `.rs` path → `test
--workspace`. Then for real: `pre-commit run cargo-test --files
crates/cannet-dbc/src/lib.rs` passes in 3.8 s running only that crate's
tests, the same hook over `apps/gui/src/App.tsx` reports "(no files to
check) Skipped", and `pre-commit run frontend --files
apps/gui/src/App.tsx` passes in 45.6 s. Both hooks were also shown to
*fail*: a planted failing `cannet-dbc` test, a planted TS type error
(the build log printed, the test log not), and a planted failing vitest
case (the test log printed, the build log not). `pre-commit run
--all-files` is green end to end, all eleven hooks, in 3 m 9 s. Both
scripts were also run with CRLF line endings — `core.autocrlf` is on and
the repo has no `.gitattributes`, so that is how they arrive in a
Windows clone — and behave identically.

**Docs.** README § Pre-commit hook said the whole-project checks include
`cargo test` and the frontend `vitest` — which was false in both
directions; it now says the Rust test run is crate-scoped and points at
the config for the trade-off. `plans/technology-inventory.md` gains the
nextest rejection and mentions the two new hook drivers in the
`pre-commit` entry.

## 3. The shared-x-window plot test is flaky

**Fixed — the test was at fault, not the coalescer.** rAF was already
under test control (`captureFrames`); what raced was a *different* real
timer. Each `PlotArea` schedules a one-shot post-mount uPlot rebuild 250
ms after it mounts (`PlotArea.tsx`), and the three areas mount at three
different instants. The test captured uPlot instances and then asserted
against those objects, so a run slow enough to straddle one area's timer
found that area's instance deregistered and silent — which reads exactly
like "the panel slid one area's window and not another's".

Evidence: injecting a delay into the assertion window turned the flake
into a function of elapsed wall clock. At 0–120 ms all three captured
instances were live and each recorded the one coalesced slide (pass); at
140–160 ms Area 1 alone had been rebuilt and its captured instance
recorded nothing, failing at `expect(last[1]).toEqual(last[0])` with
`expected { min: +0, max: 1.7 } to deeply equal undefined` — the
reported failure; at 200 ms all three had been rebuilt, every instance
was silent, and the test **passed vacuously** (`undefined` equals
`undefined`). The uPlot instance count rose 8 → 9 → 11 across those three
delays, and a staleness check on the captured instances read
`[false,false,false]` → `[true,false,false]` → `[true,true,true]`. The
fan-out itself did exactly one slide in every run, at every delay.

Changed: the test now waits the post-mount rebuild out (it fires once per
area) before capturing instances, so the captured ones are final and no
later delay can move them; and each area must record **at least** one
slide as well as at most two, which closes the vacuous-pass direction.
No production code changed.

Verified: with the delay injection still in place the fixed test passes
at 0/60/150/200/400/800 ms — the whole range that previously broke it.
Then, uninstrumented: 20 consecutive green runs of the test, 3 green runs
of the whole file under 48 competing CPU burners, and a green full
frontend suite (102 files, 1086 tests) plus `pnpm build`.

## 4. Constant signals still get a degenerate plot scale

**Fixed.** Task 48 item 8 had let a constant's degenerate extent
(`hi === lo`) into its unit group's union, which fixed a constant
*sharing* a group; a group whose whole union had no span still fell to
the renderer's midline fallback and drew on a bare 0.0–1.0 axis.

**Rule implemented: a group whose whole union has no span is widened to
±10 % of that value, centred on it. At exactly zero the proportional
band collapses, so the fallback is an absolute ±1** — there is no
magnitude to take a fraction of, and ±1 keeps the axis in the signal's
own units rather than inventing one. The trace still sits mid-canvas
(that part was never wrong); what changes is that the tick labels now
read `2700 A / 3000 A / 3300 A` instead of `0 / 0.5 / 1`.

**Where it lives:** `groupScaleRanges` in `apps/gui/src/plotData.ts` —
the pure helper that already owns unit-group scale derivation. Widening
happens on the **group union**, not per signal, so a constant sharing a
group with a moving signal still takes the plain union (a union with a
span is a measurement and is left alone) and task 48 item 8's behaviour
is unchanged. `PlotArea`'s midline fallback now covers only a signal
with no range at all — nothing decoded yet — which is still what keeps
the normalise free of a divide-by-zero.

**ADR 0026 changed**, in the same commit: it recorded "Only when a
group's *whole* union has no span does the midline fallback apply",
which this makes false. It now carries a fourth refinement stating the
±10 % rule, the ±1 zero fallback, and that the widening is on the union
rather than per signal.

Tests: `groupScaleRanges` unit tests for the constant, negative-constant,
zero and shares-a-group-with-a-moving-signal cases
(`apps/gui/src/plotData.test.ts`), plus two `PlotPanel.dom.test.tsx`
tests asserting the axis *labels* — the only place the settled scale is
observable, since the normalised data reads 0.5 either way. Both DOM
tests failed with `["0", "0.5", "1"]` before the fix.

## 5. Collapsible sections in the project view

**Done.** All six sections fold from their headers, and the Elements
section's contents are grouped by element type with each group folding
the same way. Both assumptions held: state persists in the workspace
scope, and the grouping replaces the flat list rather than toggling
against it.

**Persistence: the dockview panel params.** No new IPC, no new
`state.json` key, no host change. `ProjectPanel` writes
`api.updateParameters({ …, collapsed })`, so the set rides the layout
blob — which the workspace scope persists as `layout` in the project's
`.cannet/state.json` (ADR 0042 §3, `SCOPES` in
`apps/gui/src-tauri/src/state.rs`) and which `gatherProject` also
embeds in the project file. That is literally "alongside the rest of
the layout", and it is the panel-local idiom already in use: the DBC
panel's expanded-node set, the system-messages source filter and the
graph's node positions all persist exactly this way. Adding a `UiState`
field would have been a second channel for the same class of fact.

Stored **sparsely** — the ids of what is *folded*, so a panel nobody
folded persists nothing and a fresh panel opens fully expanded. Ids are
stable strings (`project`, `elements`, `buses`, `virtual-buses`,
`connection`, `dbc`, and `elements/<kind>` for the groups), not the
header text, so rewording a header cannot silently unfold everyone's
panel. A junk value in the params is filtered out rather than thrown on
— nothing upstream validates the blob.

**Grouping order: the declaration order of `elementKindLabel`** —
Trace, Plot, Signals, Transmit, Filter, RBS, Color Map. Registry order
is kept *within* a group. The order lives in a `Record<
ProjectElementKind, number>` rather than an array so a new element kind
is a compile error there, matching how `elementKindLabel` itself is
kept exhaustive. Only kinds with elements get a group; the "No
elements." empty state is unchanged.

**Consequence: `ElementRow` no longer prints the kind.** The group
header carries it, and a fixed 4.5rem `TRACE` column repeated under a
`TRACE` heading is exactly the width this panel does not have.
`.project-element-kind` went with it.

**A11y: button-in-heading with `aria-expanded`.** The `<h3>` / `<h4>`
stays, so the panel keeps its heading outline, and the toggle inside it
is the disclosure control. The caret is a `▾` / `▸` glyph swap in an
`aria-hidden` span — the repo has no rotate-chevron anywhere (RBS,
transmit, the graph filter node and the trace rows all swap glyphs),
and `aria-expanded` already carries the state. The body is unmounted
rather than CSS-hidden, matching `RbsPanel`.

**Task 48 item 5's scroll fix is untouched**: `.project-panel` keeps
`height: 100%` + `overflow: auto` as its first rule, so
`dockPanelScrolling.test.ts` still reads it, and folding only removes
children — it can shorten the scrolled content, never un-bound it.

Tests: `apps/gui/src/ProjectPanel.collapse.dom.test.tsx` — twelve cases
over fold/unfold, the params write (including the key coming back out
on unfold), restore-from-params, an unmount/remount round-trip through
the written params, junk tolerance, group order, per-group folding, and
the outer section folding over its groups. Eleven of the twelve failed
before the change. It is also the first test to render the whole
`ProjectPanel`, which needed stubs for `containerApi` and the sidecar
status command — the reason the existing file only ever rendered leaf
components.

## 6. Rename should rename in place

**Superseded by item 13.** The command now collects the name in the
palette's second stage, and the editable tab described below was
removed outright at the user's direction — `RenamableTab`,
`RenameTabContext` and the dock's tab-rename input are all gone, and
the dock is back on the stock `DockviewDefaultTab`. Everything the
record says about *where the name lives* still holds.

**Fixed.** `panel.rename` no longer maps to `showProjectPanel`; it
records the focused panel's dockview id as the rename target, and that
panel's own tab renders an input in place of its title.

**Where it lives:** a new `RenamableTab` (`apps/gui/src/RenamableTab.tsx`)
replaces `DockviewDefaultTab` as the dock's `defaultTabComponent` — it
renders the untouched default tab unless its panel is the target, so
middle-click-to-close and every other tab behaviour is unchanged. The
target is held in `useCommands` and published through
`RenameTabContext` (same shape as the existing `PanelCommandsContext`
wiring); the tab clears it on commit or cancel.

**No second rename path.** The edit writes `registry.update(id, { name })`
— the same mutation the project panel's inline rename performs — and
`App`'s existing title-lockstep effect carries the new name into the tab
title, the graph and the go-to-view palette. ADR 0019 already allowed
this ("other views may add inline-rename affordances later, but the
project panel is the canonical edit surface"), so no ADR changed.

**Semantics match the one existing inline-edit precedent** (`EventRow`
in `TraceView.tsx`): Enter commits, Escape reverts the draft and exits,
blur commits, an empty box reverts rather than clearing the name.

**Command context.** The command was ungated (offered everywhere, doing
nothing useful anywhere) — the `focusedPanelKind === "project"` predicate
in `commands.test.ts` is a local fixture in a binding-conflict test, not
the shipped spec. It is now gated to the panel kinds whose title is a
model-owned name: trace, plot, signals, transmit, rbs, colormap. That
required adding `colormap` to `FOCUSED_PANEL_KINDS` and
`panelKindForFocus` — an element-backed panel that could hold focus but
reported `null`, so no context-gated command could ever see it. The
keybinding path is unchanged (the command has no default chord; the
palette is the entry point).

Tests: `apps/gui/src/App.renameInPlace.dom.test.tsx` runs the command
through the real palette against the real App and asserts the tab enters
edit mode inside the still-active group (not the project panel's),
that Enter writes the name through to the project panel's own input,
and that Escape leaves it alone; plus a `commands.test.ts` case for the
context gate. Both DOM tests failed before the change with "tab did not
enter rename mode".

## 7. Audit every view for scroll correctness

**REOPENED 2026-08-05 — the chrono fix does not survive row expansion.**
User repro in the running app: capture longer than the window, scroll to
the bottom, expand messages to show their signals — content flows out of
the bottom and the view cannot scroll further. The audit's Chromium
measurements covered plain rows only; the chronological view's scroll
bound evidently does not include expanded rows' extra height (the by-ID
table feeds expansion into its geometry via `expandedRowHeight` /
`buildPlacements`; the chrono view appears not to). Diagnose exactly
where expansion height is dropped, fix, and this time the Chromium
verification must include an expanded-rows-at-the-tail case.

**Fixed (second pass).** The report was right and the first pass's audit
was the reason it was missed: every measurement it took was of plain
rows, so it verified a bound the repro never uses.

**Where the expansion height was dropped: `TraceView` called
`useTraceViewport` with no `variable` argument.** The view has the
expansion facts — it sizes and stacks its own expanded rows through
`buildPlacements` and `expandedRowHeight` — but never handed them to
the scaffold, so the scaffold computed the anchor bound *and* the
scroll spacer as if every row were `ROW_HEIGHT`. `ByIdTable` passes
`{ extraHeight, rowHeightAt }`; the chronological view passed nothing.
The first pass unified the bound over **plain** rows and never asked
what this caller supplied for its expansions.

That is one omission with **three** consequences, and each was
falsified separately by reverting it alone:

| Dropped | Consequence | Data |
| --- | --- | --- |
| the anchor bound | the stack from the bound overruns the viewport, and the sticky viewport clips | last 3 rows expanded in a 440 px panel: stack 548 px, 108 px = 3 × (58 − 22) below the fold |
| the scroll spacer | nowhere further to scroll — the "will not scroll further" half of the report | expanding a row grew the spacer by **0** |
| the sticky viewport's height | a row taller than the panel is cut off at the panel height at every scroll position | a 30-signal row is 562 px, clipped at 440 |

**The fix is in the shared math, with facts the view already had.**
`TraceView` derives `rowHeightAt` / `extraHeight` from its own expanded
set and passes them to `useTraceViewport`; it takes the sticky
viewport's height from the stack (`Math.max(viewportHeight,
stackHeight)`, the `ByIdTable` rule); and it maps scroll↔anchor through
`anchorFromScroll` and the new `scrollForAnchor` using that one bound
and range, so the two directions cannot disagree again. `scrollForRow`
/ `rowFromScroll` remain as the plain-row wrappers for callers whose
rows really are uniform.

**`expandedExtraHeightOf` is new, and the reason is `count`.**
`expandedExtraHeight` walks the whole row range because the by-ID
table's expansion set is keyed by a stable row key — there is no way to
ask *which* indices are expanded without asking every index. The
chronological view's set is keyed by absolute index and its `count` is
the whole capture (millions), so it sums over the **set** instead:
O(expanded), not O(count). A unit test pins that it asks
`rowHeightAt` exactly `expanded.size` times over a 5 M-row trace, and
that it agrees with the walking form.

**Chromium measurement, with expanded rows at the tail** — the case the
first pass never took. Same method as the sweep (headless Edge over
CDP, real `index.css` + `dockview.css`, dockview's real group chain,
600 × 300 group), with one correction that mattered: **the anchors are
derived in the page from the scroller's measured `clientHeight`**, as
`useTraceViewport` does. The panel's toolbar and column header take 53
px of the group, so `.trace-rows` is **247 px**, not 300 — a bound
hand-computed for the group height measures a viewport the app never
has. 1000 rows, the last three expanded with 2 signals each (58 px).

| Case | Anchor | Stack | Last visible row | `scrollHeight` / `maxScrollTop` | Verdict |
| --- | --- | --- | --- | --- | --- |
| chrono, before | 989 | 350 px in a 247 px viewport | **997** — 998 and 999 unreachable, last row 103 px past the fold | 22000 / 21753 — unchanged by expanding | the repro |
| chrono, after | 994 | 240 px | **999**, 7 px of slack inside the fold | 22108 / 21861 — **+108**, so there is somewhere further to scroll | fixed |
| by-ID, expanded tail | 994 | 240 px | **999** | 22108 / 21861 | already correct — measured, not assumed |
| one 562 px row, before | 999 | 562 px | — | sticky held at 247 px, so 315 px of the row is unreachable at every scroll position | broken |
| one 562 px row, after | 999 | 562 px | — | sticky grows to 562 px, the row is fully laid out and the scroll runs through it | fixed |

**The other views that combine expansion with a windowed viewport.**
The by-ID table is in the table above: the same geometry over the same
expanded tail reaches row 999, so its task 48 fix holds and this pass
did not disturb it. The **signal view** has no expansion at all, and
item 16's section headers do not introduce any: the host emits a header
as an ordinary row in the paged row space, and it is rendered at
`ROW_HEIGHT` like every other slot. Measured — with headers every fifth
row, the distinct rendered row heights are `[22]`, the headers' own
heights are `[22]`, and every row lands exactly on `i × ROW_HEIGHT`
(the global `box-sizing: border-box` absorbs the header's border). So
its rows are uniform, the plain-row bound is the correct bound there,
and this failure mode cannot arise. `DbcPanel` has variable-height rows
too but does not use this scaffold — it translates rows to real pixel
offsets under a full-height spacer, where the browser's own scroll
geometry supplies the extremes.

Tests, all failing first: `TraceView.anchor.dom.test.tsx` — three cases
over a stubbed 440 px viewport (the tail rows expanded and dragged back
down, the spacer growing by exactly what expansion adds, and a row
taller than the panel), each verified to fail when its own half of the
fix is reverted. The scroll fake in those cases now clamps `scrollTop`
to `scrollHeight − clientHeight` like a real element: without the clamp
the view's own re-pin effect saw an impossible position, took the next
scroll event for its own correction and swallowed it — an artefact of
the fake that hid the second half of the fix.
`traceViewport.test.ts` — `expandedExtraHeightOf` (agreement, cost,
out-of-range indices), `scrollForAnchor` round-tripping against
`anchorFromScroll` at three bounds including the compressed regime, and
the tail-bound invariant over expanded rows (the stack from the bound
fits; the plain bound overruns it by exactly 108 px).

**What the first pass should have done, for the next reader:** its
audit table asked "can the last row be reached" of every view in its
*default* state. Expansion, folding and any other per-row height are
part of a view's state, and a bound that is only correct for uniform
rows is only tested by a case that has non-uniform ones. The sweep's
Chromium harness now carries the expanded-tail case as well.

**Done (first pass).** The chronological trace reaches its last rows; the sweep found
one more view with the same arithmetic defect and one new CSS one; and
the base-implementation question is answered below — *two* primitives,
one of which is a test rather than a component.

**The chronological trace: one anchor bound, not two.** `maxAnchorRow`
subtracted `visibleRowCount`, which is the *render* pad — the two extra
rows that draw the partial rows at the viewport's edges — not an anchor
bound. Subtracting it stops the anchor two whole rows past the end, so
the last two rows stacked below the sticky viewport's fold with no
scroll position that reached them.

Task 48 item 5 deferred this view because its anchor interacts with
auto-scroll and `scrollForRow`, and that interaction is exactly why a
per-caller fix is wrong: `scrollForRow` and `rowFromScroll` derive the
bound *themselves*, so a scaffold that used `tailAnchorRow` while they
kept `count - visibleRowCount` would map the bottom of the scrollbar
back onto the old anchor and pin the view two rows short again. So
**`maxAnchorRow` is now `tailAnchorRow` over plain rows** — one bound,
derived once, and every consumer of it moves together.

**The auto-scroll interaction resolves to nothing, by construction.**
Following the live tail anchors at `anchorMax`, and
`scrollForRow(anchorMax)` is still exactly `maxScrollTop`, so the pin is
still the bottom of the scrollbar — it just now shows the rows that were
hidden under it. Toggling follow off and on is a no-op (both paths read
the same bound), and `handleScroll`'s off-the-edge test is on pixels,
not rows, so it is untouched. `visibleRowCount` keeps its two-row pad,
which is still right for what it is for.

Tests: `traceViewport.test.ts` — the two bounds are one function over
plain rows, and anchoring at the bound leaves the last row inside the
viewport; `TraceView.anchor.dom.test.tsx` — three cases over a stubbed
440 px viewport (a captured trace dragged to the bottom, the live tail,
and the toggle), all three failing before the change with the anchor two
rows short. The existing auto-scroll cases are unchanged and green.

### The sweep

Method, per the item's binding note. jsdom does no layout, so **layout
claims were measured in headless Edge (Chromium 151, the engine behind
the WebView2 host) over CDP**, with the real `index.css` and the real
`dockview.css`, each panel built in its own class chain inside
dockview's real group chain (`.dv-groupview` → `.dv-content-container` →
`.dv-react-part`) at a 600 × 300 dock group. Each container was scrolled
to its extreme and asked whether its last content element had come
inside *both* the scroller and the group. The harness carried a
**control** — the project panel with `height: 100%` overridden back to
`auto`, the defect task 48 item 5 fixed — which reports its tail 418 px
past the fold, so the sweep is not measuring nothing. Two claims are
arithmetic rather than layout (marked *unit*): the anchor bound decides
what the sticky viewport can ever show, and that is a pure function.

The harness itself was a throwaway (a generated page plus a
dependency-free CDP driver); what is durable is the guard it justified,
in `dockPanelScrolling.test.ts`.

| Surface | Scroll container | Method | Verdict |
| --- | --- | --- | --- |
| Chronological trace — rows | `.trace-rows`, virtual | unit + Chromium | **was broken** (tail 2 rows short); fixed |
| Chronological trace — columns | `.trace-scroll-content` | Chromium | ok (`scrollWidth` 1227 / `clientWidth` 600, last column in reach) |
| By-ID trace | `.trace-rows`, virtual | unit | ok (`tailAnchorRow` since task 48 item 5) |
| Signal view | `.trace-rows`, virtual | unit | **was broken** (last row at `top: 462` in a 440 px viewport); fixed |
| Events panel | `TraceView` | — | covered by the chronological fix (same renderer) |
| DBC panel tree | `.dbc-panel-tree`, virtual | Chromium | ok (4000 / 266, `scrollTop` reaching 3734) |
| System messages — rows | `.system-messages-list`, virtual | Chromium | ok (880 / 273, last row in reach) |
| System messages — long line | `.system-messages-list` | Chromium | ok (1456 / 600, `scrollLeft` reaching 856) |
| Project panel | `.project-panel` | Chromium | ok (744 / 300); the control proves the measurement bites |
| Colormap panel | `.colormap-panel` | Chromium | ok (755 / 300, "+ range" in reach) |
| Settings — group tree | `.settings-tree` | Chromium | ok (331 / 255) |
| Settings — settings list | `.settings-list` | Chromium | ok (2048 / 255) |
| About / shortcuts panel | `.settings-panel` | Chromium | ok (1618 / 300) |
| About — license text | `.about-licenses` | Chromium | ok (2816 / 483 at `max-height: 60vh`) |
| Transmit — frame list | `.tx-panel-list` | Chromium | ok (360 / 268) |
| Transmit — byte editor | `.tx-bytes` | Chromium | ok (2554 / 600 horizontally, last byte in reach) |
| RBS tree | `.rbs-tree` | Chromium | ok (648 / 266) |
| Plot area — signal list | `.plot-area-signals` | Chromium | ok (771 / 300) |
| Project graph — canvas | `.graph-panel-canvas` | read | n/a — xyflow pans by transform and clips itself |
| Project graph — empty state | `.graph-empty` | Chromium | **was broken** in a short panel; fixed |
| Command palette list | `.palette-list` | Chromium | ok (1836 / 323 at `max-height: 40vh`) |
| Combobox dropdown | `.combobox-list` | Chromium | ok (911 / 160) — bounded by its `.combobox-pop` parent, not by itself |
| BLF channel-map modal | `.blf-map-rows` | Chromium | ok (511 / 288 at `max-height: 18rem`) |

**Fixes landed.**

1. *The chronological trace's tail* — above.
2. *The signal view's tail.* `SignalsPanel` had hand-rolled
   `useTraceViewport` — its own container ref, `ResizeObserver`, render
   window, spacer and anchor bound — and its copy carried the same
   defect, so fix 1 repaired it silently. It now takes the shared
   scaffold, and its scroll handler reads the scaffold's `anchorMax`
   (the `ByIdTable` idiom) rather than re-deriving one through
   `rowFromScroll`, which is what let the two drift. Test:
   `SignalsPanel.dom.test.tsx`, failing before at `top: 462` in a 440 px
   viewport.
3. *The project graph's empty state.* The canvas declares no overflow —
   right for xyflow, which pans by transform — but the empty state is
   ordinary flow content in that same box, `height: 100%` and centred,
   with nothing to scroll. Measured at a 140 px dock group:
   `scrollHeight` 137 against `clientHeight` 110, `scrollTop` stuck at
   0, the last paragraph 27 px past the fold. (At the 300 px group
   everything else is measured at, it fits — which is why nobody hit
   it.) `overflow: auto` alone does **not** close it: a centred flex
   line that overflows puts its start edge outside the scroll origin,
   and the measurement shows the first paragraph then 27 px *above* row
   zero. It takes `justify-content: safe center` as well — measured,
   `scrollHeight` 228, `maxScrollTop` 118, both ends reachable.

### Is there a base implementation? Yes — two, and they are different kinds of thing

The six defects were not one bug class. They split cleanly, and the
split is the answer.

**Virtual scrolling: one primitive, and it already exists —
`traceViewport.ts` + `useTraceViewport`.** Three views (chronological
trace, by-ID trace, signal view) share the same model: a scaled
scrollbar over a spacer, a *derived anchor row*, and a sticky clipping
viewport. They need it because `count` can exceed the browser's CSS
height cap (~730k rows at `MAX_SCROLL_HEIGHT_PX`), which native
scrolling cannot express. Every anchor defect found — by-ID's in task 48,
the chronological view's and the signal view's here — was the same
arithmetic, and the reason it recurred is that the bound was written
three times. It is now written **once**: `tailAnchorRow` is the
definition, `maxAnchorRow` is its plain-row case, `useTraceViewport`
hands it out, and both scroll handlers consume that value rather than
re-deriving one. That is the "adopting it is the deliverable, the
individual fixes fall out" outcome, and the signal-view migration is
where the falling-out is visible.

Two other views virtualize (`DbcPanel`, `SystemMessagesPanel`) and do
**not** use it, deliberately: they translate rows to real pixel offsets
under a full-height spacer, so the browser's own scroll geometry
supplies the extremes and an unreachable tail is structurally
impossible. That model is strictly better where it applies — it just
cannot represent a trace longer than the height cap. Converting them
would buy nothing and cost the guarantee.

**Plain panels: no shared component, and the reason is concrete.** The
remaining surfaces are native-overflow scrollers whose defects were CSS
geometry. A shared `.scrollable-panel` class cannot serve them because
the boxes are not the same kind of box: a panel root pinned to its dock
group needs `height: 100%` (project, colormap, settings, about); a list
under a toolbar needs `flex: 1 1 auto` in a column parent (transmit,
DBC, RBS, system messages, trace rows, settings list); a popup or modal
needs `max-height` (palette, combobox pop, BLF map, license text). Any
one class would be wrong for two thirds of them — and two of the
reported defects were not about the container at all: the trace table's
was a *content width* the rows had to publish, the system messages
view's was an ellipsised grid track.

What generalises is not a declaration, it is the **question**, so the
shared thing is a test. `dockPanelScrolling.test.ts` now walks every
rule in `index.css`, finds every one that turns on scrolling in the
block axis, and requires each to declare a definite size in that axis
(`height`, `max-height` or `flex`) — the invariant both the project and
colormap defects violated. It is generic, so a panel added next year is
covered without anyone remembering to add a case, and it is falsifiable:
removing `height: 100%` from `.project-panel` makes it name
`.project-panel`. One selector carries a documented exemption —
`.combobox-list` is bounded by its `.combobox-pop` parent's
`max-height`, verified in Chromium rather than assumed.

So the honest answer to "why did six panels each get their geometry
wrong independently" is: three of them shared arithmetic that was
written three times (now once), and the rest shared an invariant that
nothing checked (now checked). Neither half wanted a component.

**Noticed in passing, not acted on:** `.by-id-rows` in `index.css` is
dead — the by-ID table renders into `.trace-rows` like the other two
trace views, and nothing references the class. It satisfies the new
guard, so it is invisible rather than harmful. Left alone rather than
removed inline. No blockers: nothing found here needed host-side work.

## 8. Put the version and project in the title bar

**Done.** The title reads `<project> — <capture source> — cannet
<version>`, with a `•` prefix while there are unsaved changes and the
capture segment omitted when nothing is loaded — the decided format,
unchanged.

**Mechanism.** The app already had the wiring: `windowTitle`
(`apps/gui/src/windowTitle.ts`) is a pure builder and an `App` effect
pushes its result through `getCurrentWindow().setTitle`. Both were
widened rather than replaced — no new IPC, no `document.title`, no
custom title bar.

Where each fact comes from:

| Segment | Source |
| --- | --- |
| Project name | `projectPath` state, basename minus its last extension (unchanged) |
| Unsaved `•` | `App`'s `dirty` — the flag the project view's `●` marker and the close prompt already read |
| Capture source | new pure `captureLabel(state, remoteSessions)` in the same module |
| `cannet <version>` | `app_version`, the host command the About panel reads; fetched once per session |

`captureLabel` gives a **live session priority over a loaded BLF**, the
same precedence `splitStatus` applies in the status line. A session
reports its one subscribed interface's `display_name`, or `N
interfaces` when it carries several (the status line's existing
phrasing); with none running it falls back to the BLF's basename while
the log is loading, streaming or done. The version is `git describe`
output, so a leading `v` is stripped (`v0.9.3` → `0.9.3`) and the rest
kept verbatim; an empty version drops the segment rather than showing a
placeholder.

**One deviation, recorded rather than fixed:** the close prompt treats
"unsaved" as a dirty project **or** any dirty `.cannet_rbs`, and the
RBS half is only knowable by calling `rbs_dirty` — the host publishes no
event for it and the frontend holds no reactive mirror. The title
therefore tracks the project `dirty` flag, exactly as the project
view's own `●` marker does. Making the title cover RBS too means giving
that fact a reactive home, which is host work and not this item's.

**The About panel is unchanged** apart from a stale comment: it said the
native title bar carries only the project name, which this makes false.

Tests: `apps/gui/src/windowTitle.test.ts` covers all five documented
states plus the version-prefix and empty-version edges, and
`captureLabel` across idle / streaming / done / errored / one interface
/ several / live-beats-BLF. `apps/gui/src/App.windowTitle.dom.test.tsx`
mounts the real App with `setTitle` spied and asserts the settled title
carries the mocked host version — and the `•`, since seeding the default
layout already marks the session dirty. Both failed before the change.

### The title never reached the window — a missing capability

The work above shipped **inert**, and so had the effect it widened: the
running app still showed the static `tauri.conf.json` title. Every jsdom
test passed because the mocked `setTitle` enforces no capabilities.

**Root cause.** `getCurrentWindow().setTitle` is ACL-gated on
`core:window:allow-set-title`, and
`apps/gui/src-tauri/capabilities/default.json` never granted it.
Tauri's `core:default` does **not** cover it: the generated
`core:window` default set (`gen/schemas/acl-manifests.json`) grants
`allow-title` — the *getter* — and nothing that writes. So every call
rejected, the `.catch` swallowed it, and the static title survived.
This predates the title-bar work: the pre-existing
`<project> — cannet` effect never worked either, which is why nobody
had noticed that the About panel's claim that "the native title bar
carries only the project name" was describing something that never
happened.

**Confirmed by experiment, not inspection.** With the rejection routed
to the system log (below) and the capability still absent, a real run
logged Tauri's own message verbatim:

```text
2026-08-05T16:56:28.369Z ERROR window: window title could not be set:
window.set_title not allowed. Permissions associated with this command:
core:window:allow-set-title — the host may be missing the
core:window:allow-set-title capability
```

**The fix, in three parts:**

1. `core:window:allow-set-title` added to `capabilities/default.json`.
2. **The rejection is no longer swallowed.** The effect now reports the
   first failure per session (a denied `setTitle` fails identically on
   every later change) to both `console.error` and the host system log
   via `gui_emit_system_log`, at `error`, source `window` — so it
   reaches `cannet.log` and the system-messages badge. A permission
   regression cannot be silent again.
3. **A regression test pins the capability file.**
   `the_capability_set_grants_set_title` in
   `apps/gui/src-tauri/src/tests.rs` parses `capabilities/default.json`
   and asserts the grant, with the reason in the failure message. It
   was confirmed to fail with the permission removed and pass with it
   present.

**Real-window verification.** The user confirmed the fixed title in
their own `tauri dev` session on 2026-08-05. Independently observed
from that session's live process before it exited, the Win32
`MainWindowTitle` read:

```text
• ev-zonal — cannet 0.6.0-49-gc41f3cc-dirty
```

recorded through a non-UTF-8 console as `" ev-zonal - cannet
0.6.0-49-gc41f3cc-dirty"` — the console renders `—` as `-` and drops
the `•`, so the ASCII rendering is what was literally captured and the
line above is the same string with its real characters. It shows the
project segment, the unsaved marker, the omitted capture segment
(nothing loaded) and the `v`-stripped `git describe` version, all as
specified.

**A trap worth writing down for the next person who verifies a GUI
change.** Neither `target/debug/cannet-gui.exe` nor `cargo build
--release -p cannet-gui` produces a runnable app: both lack the
`custom-protocol` feature, so the binary points at `devUrl`
(`localhost:5173`) and comes up with **no frontend at all** — the tells
are `jsheap_mb=?` and `trace_len=0` on every `health:` tick in
`cannet.log`, and no `opened project` line. The two ways to get a real
window are `pnpm --dir apps/gui tauri dev` and `pnpm --dir apps/gui
tauri build --no-bundle`, and the README documents the latter.

## 9. Manual y-axis control from a right-click menu on the axis

**Done.** Right-clicking a y axis opens a menu with a **min**, a
**max** and a **log-scale toggle**. Both bounds default to empty, and
empty means the autoscaling that was already there — item 4's
constant-signal minimum range included — so an axis nobody opens the
menu on is unchanged and persists nothing.

**Where the settings live: `apps/gui/src/plotAxisScale.ts`.** One
`AxisScale` (`min?`, `max?`, `log?`) per derived axis, keyed by
`DerivedAxis.id`, riding the plot panel's persisted config as
`axisScales` — the same versioned-params path `axisWeights` uses
(tolerant parse `axisScalesFromRaw`, persisted by `PlotPanel`'s
existing `persist` effect). **Sparse**: `setAxisScale` deletes an entry
that ends up with no override rather than storing an empty one, and
returns the same reference when nothing changed.

**Pruning: `retainedAxisIds` (`plotAxisDerivation.ts`).** The weights
prune to the *live* axis set, which is right for them — a weight
describes the layout on screen. A manual range must survive a mode
change (the ids regenerate identically), so it prunes instead to the
union of every id an area's signals could mint in **any** mode:
`areaId`, `${areaId}/u:unit:<unit>` per distinct unit,
`${areaId}/u:enum`, `${areaId}/i:<signalKey>` per signal. That is
exactly the required lifetime — a per-unit entry outlives all but the
last signal of its unit, an individual entry retires with its signal,
and a unit test asserts the set covers what all three modes derive so
no live axis can ever be pruned. The enum-lane id is retained whenever
the area holds any signal, deliberately **without** consulting
`isEnum`: enum-ness comes from an async value-table fetch, and a set
that briefly reads as "no enums" must not delete a lane axis's entry.

**Precedence, in `resolveAxisRange`.** A pinned bound replaces the
derived one *after* `groupScaleRanges`, so it beats the follow-live
all-time extent, the paused visible-fit and the Fit Y pin alike; an
unset bound stays automatic. Applied per **unit group**, because the
axis's one setting governs every scale drawn on it and the groups are
what those scales are. Two edges fell out and are tested: a manual
bound the automatic side has crossed (a max under the data's floor)
would leave no span, so it takes item 4's `constantRange` band around
the value the user pinned; and a manual bound with no automatic range
at all (nothing decoded) draws nothing rather than half a range.

**Log scale.** Enabling it removes the min box — the min becomes the
smallest positive value each group actually holds, snapped down to a
decade — while the max stays settable and is used *exactly* (only
auto-derived bounds snap). The typed min is **held** in the store, not
discarded, so turning log off returns it. Non-positive samples are
dropped (`null`, a gap) rather than clamped. A series with nothing
positive in it draws nothing and the area says which one, in a new
stationary `.plot-area-note` overlay beside the existing `building…`
one. Ticks come from `logDecadeSplits` (decade boundaries, capped at
ten) and the labels invert the same mapping, so `1 / 10 / 100` rather
than uPlot's even `1 / 3.98 / 15.8`.

**Rendering approach: no `distr: 3`.** The plot already normalises its
data to [0, 1] in JS and pins uPlot's y scale there (the tick formatter
maps back through the axis's range), so a log axis is a different
*normalisation*, not a different uPlot scale — `(log10 v − log10 lo) /
(log10 hi − log10 lo)` in the same in-place loop. Handing uPlot a log
distribution would have meant giving it raw values, which is the
architecture the unit-group scales are built on. Toggling log rebuilds
the instance (it is in the construction effect's deps) because the
splits callback is installed at construction; a bound change does not —
it drops the fetch memo and resamples, the proven path the
hidden-signal toggle uses, which is what makes a *stopped* trace redraw
at the new bound.

**Fit Y clears a manual range** (`min: null, max: null`) and then does
its usual visible-fit; the log flag is not a range and survives. Both
entry points route through the area's `fitY`, so the toolbar button and
the per-area one agree.

**Enum axes are excluded** — the menu is omitted on the enum-lanes axis
*and* on the single-enum axis, and any setting left over from a mode
change is ignored while an axis renders either way. The item only asked
for lanes; the single-enum axis takes its y from the value table's raw
range by the same argument, so offering it a bound would be equally
inert.

**Menu pattern:** the app's existing floating-context-menu idiom —
`useDismissableMenu` (outside-click + Escape), `position: fixed` at the
cursor, shell styled like `.rbs-context-menu` / `.sources-context-menu`
— and the repo's one inline-edit precedent for the fields (Enter and
blur commit, an empty box means automatic; unparseable text is left in
the box rather than committed as a clear). It does not fight uPlot:
only a right-click in the **gutter** opens it, decided against the
width the axis reports through `axis.size` (tracked in `PlotArea` from
the same call that feeds the panel's gutter coordinator), so a
right-click inside the plot box still reaches uPlot's box-zoom.

**`yMode` stays discarded, not migrated.** It was a per-*area* fixed
range and the settings that replace it are keyed by derived-axis ids
that did not exist when it was written, so there is no axis an old
range can be said to have meant. The comment in `plotPanelConfig.ts`
now says that, and a test pins it.

**Docs.** `PlotAreaConfig.yAxisMode`'s "Y scales are always auto-derived
(no fixed-range option)" is gone; **ADR 0026** loses the same claim in
its decision and its "why", gains the log-axis rules (derived min,
dropped non-positives, decade bounds, held min) beside the axis-property
half item 11 recorded, and carries an implementation-status entry.

Tests: `plotAxisScale.test.ts` (parse/junk tolerance, sparse
set/clear/held-min, prune identity, the whole precedence table, log
derivation, decade splits, the non-positive drop);
`plotAxisDerivation.test.ts` for the retention rule, including that it
covers what every mode derives; `plotPanelConfig.test.ts` for the
discarded `yMode`; and eleven `PlotPanel.dom.test.tsx` cases — manual
max beating the follow-live extent, either bound alone, decade
normalisation + tick labels, the dropped non-positive point, the
all-non-positive message, Fit Y clearing, mode-change survival with
stale-unit retirement, menu open/apply/clear, the log toggle hiding and
restoring the min box, and the enum-lanes exclusion. Each failed before
its change.

## 10. The plot's value formatting ignores what kind of signal it is

**Done.** A plotted value now reads by what the signal is, and the two
formatters that used to disagree share one threshold.

**The model fact added: `decimals`.** `cannet_dbc::SignalDescriptor`
grows `decimals: Option<u8>` — the decimal places a signal's physical
values land on, computed from its `factor` at
`model.rs::fixed_decimals` (`0.25` → 2, `0.1` → 1, an unscaled or
integral factor → 0). `None` where the DBC implies no fixed precision:
a `SIG_VALTYPE_` float, or a factor with no finite decimal expansion.
The probe runs to **nine** decimals and gives up past that — beyond
nine a factor is a computed ratio, not the "this signal steps by 0.25"
fact a readout is after — with a `1e-12` relative tolerance, which
absorbs `0.392157 * 1e6 = 392157.00000000006` while staying far below
the ~0.33 residue `1/3` leaves at every probe. Both documented edges
fall out of computing from the factor alone: `factor == 1` with an
offset or a unit is `Some(0)` (an integer, not a bit field, so decimal
rather than hex), and `1/3` is `None`.

It rides out on `list_signals`' `SignalDescriptorRecord` alongside
**`display_hex`**, which the catalog did not carry either. **`raw_field`
was not added**: the formatter never needs it. A raw field's
`decimals` is 0, which already says "render this as an integer", and
`display_hex` is the whole radix verdict (the host gated it on
`is_raw_field` in item 11). Adding the combined flag would have been a
third way to say what those two already say.

**The formatter.** `fmtVal(v, fmt?)` in `plotPanelConfig.ts`, where
`fmt` is `{ decimals, hex }` — hex first, then fixed decimals
(`toFixed`), then the float rule. `signalValueFormats(catalog)` builds
the `signalKey → format` map; `PlotPanel` builds it once per panel next
to `ecuLookup` (same reason: a DBC fact, not part of a plotted signal's
identity) and passes it to every area. The hex branch calls
`format.ts::formatSignalValue(v, true)`, so a raw field reads
identically in the plot, the trace rows and the signal view.

**The shared threshold: `MAX_PLAIN_DECIMALS = 5`,** owned by
`fmtSigFigs(v, sigFigs)` — round to `sigFigs`, render plainly unless
that needs more than five decimals, then exponential with the
mantissa's trailing zeros trimmed (`1e-6`, not `1.00000e-6`). The
readouts call it at 6 figures, the y-axis ticks at 3. The large end is
untouched: both formatters already went exponential at `1e6` and
`fmtSigFigs` keeps that constant.

**Where the tick labels diverge, deliberately:** they share the
threshold and nothing else. They keep 3 significant figures (the gutter
starts at 52 px), and they do **not** follow a signal's fixed decimals
or hex radix — a tick is a position on an axis that several signals may
share, not one signal's reading. The width-driven fallback the item
allowed for was not needed beyond that, because `measureAxisSize`
already grows the gutter to the widest formatted label.

**Derived quantities keep the plain float rule** — the A/B delta in both
the side panel and the measurement strip, and the strip's mean. A mean
of 0.25-quantised readings need not land on that grid, and a difference
of two bit patterns is not itself a bit pattern (rendering one in hex
would print `0x1.8`). `@A` / `@B` / `min` / `max` are real readings and
take the signal's format. The y-cursor readouts (`H1` / `H2` / `ΔH`) and
the diagnostic `y[lo … hi]` also stay on the float rule: they are axis
values, and an axis can span several signals' formats.

`formatSignalValue` was **not** unified with, as directed — only the hex
rendering is shared, by call.

Tests: `crates/cannet-dbc/src/tests.rs::signals_descriptor_carries_the_decimals_its_factor_implies`
(0.25 → 2, 0.1 → 1, 1-with-offset → 0, an integral factor → 0, `1/3`
→ `None`, a factor finer than the probe → `None`, a `SIG_VALTYPE_`
float → `None`); `plotPanelConfig.test.ts` for each branch of the
three-way rule, the hex case, the `fmtSigFigs` threshold and
`signalValueFormats`; and two `PlotPanel.dom.test.tsx` cases that carry
the fact end-to-end — a `decimals: 2` signal reading `12.50 rpm`
(`12.5` before) and an axis over 0…0.0002 reading `0.0001 A` rather
than `1.0e-4 A`. All failed before the change.

## 11. Raw integers default to base-10; hex becomes a per-signal opt-in

**Done.** Raw integer bit fields render **base-10** everywhere task 48
item 3 made them hex — expanded trace rows, the signal view, the DBC
panel's value column. Hex is now a per-signal DBC opt-in. The
unconditional half of item 3 is untouched: an exact integer still never
renders in scientific notation (`0xDEADBEEF` reads `3735928559`, not
`3.7e+9`).

**The attribute.** `BA_DEF_ SG_ "CannetDisplay" STRING ;`, default
`""`, value a `key=value;key=value` one-liner — the grammar
`CannetCounter` / `CannetCrc` already use (`key_value_pairs` in
`crates/cannet-dbc/src/calc.rs` is now `pub(crate)` and shared). One
key is implemented: `radix=hex`. `scale=log` is **not** in scope and
ADR 0043 records why. Read-only: no DBC writer, no project-side
override, no UI.

Three warnings, all through the existing `Database::parse_warnings`
channel and all leaving the default rendering in place:

| Input | Warning |
| --- | --- |
| unknown key / unknown radix / malformed pair | `<msg>.<sig>: bad CannetDisplay attribute: …` |
| `radix=hex` on a signal with a unit, a scale factor or a `VAL_` table | `<msg>.<sig>: CannetDisplay radix=hex ignored — not a raw integer field …` |
| empty value | none — "unconfigured", same as `CannetCounter` |

**Where the verdict is settled: at parse, once.** `SignalEntry` gains
`display_hex`, set only when the attribute asks for hex *and*
`is_raw_field` passes, so no consumer combines two flags — a renderer
renders what it is told. It rides out on `DecodedSignal::display_hex`
and `SignalDescriptor::display_hex` (the same twin pattern
`value_is_raw_integer` uses), then over the wire as `display_hex` on
`SignalRecord` and `SignalSnapshotRecord`, omitted when false.

**`raw_field` stays and keeps its meaning** — the signal is an opaque
bit pattern rather than a measurement. It no longer decides the radix;
it says the value is a digit-exact integer.

**For item 10:** consume **`display_hex`** for the radix and
**`raw_field`** for "this is an integer, format it as one". Both are
already on `SignalRecord` / `SignalSnapshotRecord`; `SignalDescriptor`
(the plot's `list_signals` catalog) carries `display_hex` and
`value_is_raw_integer` but *not* the combined `raw_field` — the plot
either combines it host-side through `cannet_dbc::is_raw_field(…)` the
way `trace_query.rs` does, or the descriptor grows the combined flag
alongside the `decimals` fact item 10 needs anyway.

**Docs.** New **ADR 0043** — the `Cannet*` namespace and its
conventions, that cannet never writes a DBC, the DBC-versus-project
test (*a fact about the signal itself → DBC; a fact that varies per
rig / session / user → project*), project-wins precedence, and the
per-value / per-axis asymmetry that is why `radix` ships and `scale`
does not. **ADR 0026** gains the axis half: a log scale is an axis
property and a DBC hint never overrides an explicit per-axis setting
(item 9 implements it; this only records the rule). **ADR 0027** gains
a pointer to 0043 as the general rule it was the first instance of.
**README** grows `CannetDisplay` in the calculated-fields `BA_DEF_` /
`BA_` block plus a paragraph on the attribute set, and
`examples/cannet-demo.dbc` carries a real example (`BmsCommand.Crc8`)
so the block is not describing a signal that doesn't exist.

**The large fixture got one too.** `examples/ev-zonal/dbc/zonal.dbc`
gains `PackStateCommand` (id `0x60A`, CentralCompute): a `CannetCounter`
rollover counter and a `CannetCrc` CRC-8/SAE-J1850, with `radix=hex` on
the CRC only — the counter beside it is just as raw a field and stays
decimal, which is the per-signal point. That file is generated, so
`generate_dbcs.py` grew a per-signal `cannet` attribute map that
declares only the `BA_DEF_`s a file actually uses (`pack.dbc`
regenerates byte-identical).

Tests: `crates/cannet-dbc/src/tests.rs` — the attribute read (catalog
and decode sides agree), each bad-value shape, the ineligible-signal
warning on both a united/scaled signal and an enum, and the demo DBC's
example; `tests/ev_zonal_fixture.rs` pins the `PackStateCommand`
example (the fixture loader already asserts a warning-free parse, which
is what proves `radix=hex` landed somewhere eligible). Host:
`wire_signals_flag_only_raw_bit_fields` and
`signal_snapshot_rows_flag_raw_bit_fields` now separate the two flags
(a raw field with no attribute stays base-10). Frontend:
`SignalValueCell.dom.test.tsx` (base-10 default, hex on the flag),
`TraceView.signals.dom.test.tsx` (expanded row, both renderings), and
`SignalsPanel.dom.test.tsx` (the same row with and without the flag).

Noticed in passing, not acted on: `PlotPanel.dom.test.tsx > re-renders
no plot area when only panel-local state changes` failed once in a
full-suite run (`expected 1 to be +0`) and passed in the file alone and
in a repeat full run — a render-count assertion racing a loaded
machine, the same family as item 3. Not touched by this item's change.

## 12. Plot series don't take a changed color

**Fixed.** A recolored series now takes its new color on the live uPlot
instance, without a rebuild.

**Diagnosis: the stroke was a construction-time snapshot, and nothing
could have updated it.** The color reaches the model correctly —
`PlotPanel`'s `setSignalColor` rewrites the area's `SignalRef.color`, so
the swatch, the measurement strip and the y-axis stroke (which reads
`primaryColorRef` per draw) all follow it. The series did not, for three
reasons that compound:

- `PlotArea`'s uPlot construction effect built each series with
  `stroke: s.color` — a *string*, resolved once.
- Its dep list (`[signalSetKey, areaId, resizeTick, valueTable,
  showPoints, isLast, logActive]`) carries no color, and `signalSetKey`
  deliberately excludes `color` and `hidden`, so a recolor never
  rebuilds the instance. Hence the reopen-the-panel workaround.
- The in-place escape hatch the hidden-signal toggle uses does not
  extend to color: uPlot's `setSeries` only acts on `focus` and `show`
  (`uPlot.esm.js::setSeries`) and drops any other option.

*Confirming experiment:* the new DOM test captured the live instance,
fired the swatch picker's `change` with `#123456`, and read
`opts.series[1].stroke` back. It was the string `#c6f24e` — the wheel
color the series was constructed with. A string (not a stale function)
and an unchanged instance count together falsify both alternative
hypotheses: no rebuild fired *and* no restyle was attempted.

**Fix: a function stroke reading the live signals ref** —
`stroke: () => signalsRef.current[i]?.color ?? s.color`. uPlot resolves a
function stroke on every draw (`cacheStrokeFill`, called from
`drawSeries` on each commit) and defaults `points.stroke` to the same
function, so markers follow too. This is the idiom the file already uses
for the y-axis stroke (`() => primaryColorRef.current ?? AXIS_STROKE`)
and for the colormap resolver — a live ref read at draw time rather than
a captured value. The construction-time color stays as the fallback for
the one render between a signal-set change and the rebuild it triggers.

**No new redraw effect.** A color change gives `signals` a new identity,
which the existing primary-signal effect already depends on
(`u?.redraw(false, true)`), so a *stopped* trace repaints at the new
color with no extra work. That is load-bearing, so the test pins it:
the fake uPlot now counts redraws and the case asserts one landed.

Tests: one `PlotPanel.dom.test.tsx` case — new stroke, no rebuild, a
redraw — which failed before the change with `expected '#c6f24e' to be
'#123456'`.

## 13. Rename: palette second stage, and trace-panel field editing

**Done.** `panel.rename` collects the name in the palette, and an event
row in the trace focuses on click and carries a rename button.

**The second stage: `PalettePrompt` (`apps/gui/src/PaletteModal.tsx`).**
The palette had no argument input — the three palettes were one
`PaletteModal` over three item lists — so this adds one, in the same
file and the same shell (`.modal.palette` on the palette backdrop), as
a sibling component rather than a mode of the list palette: they share
no state and every line of `PaletteModal` (fzf, the clamped selection,
arrow keys) is about a list. It renders one field seeded with a value
and pre-selected, a label line saying what is being asked for (also the
field's accessible name), Enter to submit, Escape / backdrop to cancel.

**How a command reaches it: `setPrompt` in `useCommands`**, holding one
`CommandPrompt` (`label`, `initial`, `submit`) or `null`. A handler
opens the stage by setting it and the palette clears it on either exit,
so the second stage is part of invoking the command (ADR 0037) — not a
parallel mechanism, not a new surface, and not a `CommandSpec` field.
Nothing about it is rename-specific, which is the whole of "reusable"
this item needed; no `argument` declaration, no multi-stage machinery.

**`panel.rename` now** reads the focused panel's element, seeds the
stage with `elementLabel(element)` and, on Enter, writes `update(id,
{ name })` — the one rename path (ADR 0019), reached through a new
narrow `renameElement` option rather than handing the command subsystem
the registry's general patch power (its context is provided *below*
`App`, so it cannot consume it). An empty box reverts, matching every
other inline rename in the app. Nothing navigates: the trace panel's
group is still the active one when the stage opens, and the test pins
that.

**Item 6's editable tab is gone, and the palette prompt is the only way
to rename a panel.** It was first kept as a double-click affordance
(the command path removed, the direct manipulation retained); the user
revoked that too — *"remove tab rename path, even if you bothered to
hook it up another way. The palette prompt is what I asked for."* So
the removal is total: `RenamableTab` deleted, `RenameTabContext`, the
`renameTarget` state in `useCommands` and the `renameTab` member of its
result all gone with it, the `.dock-tab-rename-input` styling gone, and
the dock back on the stock `DockviewDefaultTab` rather than a
pass-through wrapper of it. The project panel's inline rename (ADR
0019's canonical edit surface) is untouched.

**The trace-panel interaction model.** The "elements" are the timeline
event rows (ADR 0035) — notes and the derived truncation marker —
rendered by `EventRow` in `TraceView.tsx`. Before this, the *only* way
to rename one was clicking its label, announced by a `title` tooltip
and by nothing else; the row had no notion of being focused at all.
Now:

| Gesture | Effect |
| --- | --- |
| Click anywhere on the row | Focuses that row (and only it) |
| The row's ✎ button | Turns the label into a field |
| Double-click the label | The same, as the direct-manipulation shortcut |
| Enter / blur, Escape | Commit, revert — unchanged |

Focus is view-local state in `TraceView`, keyed by **event id** rather
than row position, because the row slots are recycled as the view
scrolls — a position-keyed selection would follow the slot onto a
different event. `Row` takes it as a *boolean*, not the focused id, so
moving the focus re-renders the two rows it touches and leaves the
memoised rest alone. The row is a real focus target (`tabIndex={0}`,
`:focus-visible` outline) as well as carrying the selected style. The ✎
button hides while its own field is open, which is also what keeps the
remove button pinned right (it takes the auto margin back).

Tests: `App.renameInPlace.dom.test.tsx` — the palette's second stage
seeded and committing, without the project panel being brought up, and
Escape leaving the name alone. Both failed before the change (they
asserted the tab input item 6 shipped); the third case, over the tab
double-click, went with the affordance. `EventsPanel.dom.test.tsx` — focus moving
between two rows and the row being focusable, a row click *not*
starting an edit, the ✎ button opening the field and Enter committing
through `renameNote`, the double-click shortcut, and no ✎ on the
derived truncation marker. Four of the five failed before the change.
The event rows are tested through the events view because it is the
cheap mount of the same renderer the trace panel interleaves.

Noticed in passing while the tab affordance still existed, and recorded
because the next person to reach for a dock-tab gesture will hit it: a
double-click on a dock tab has to be fired on the tab's *content* in
jsdom (`.dv-default-tab-content`), not dockview's outer `.dv-tab`
wrapper — a handler passed to `DockviewDefaultTab` lands on the inner
default-tab div, which a real click reaches by bubbling.

## 14. RBS enum values commit late, and enum selection costs an extra click

**Fixed, and both reports were the same defect.** An enum label picked
from a value cell's datalist now takes effect on the pick.

**Report 1 — where RBS value edits commit.** Every value input in the
panel is a `ValidatedInput` (`apps/gui/src/ValidatedInput.tsx`), the
shared draft-then-commit box: the message period, the numeric signal
cell and the enum signal cell alike. Its only commit triggers were
`onBlur` and Enter (which just calls `blur()`). So the report is
literally true and it *was* true of all of them — but only for the
enum cell is it wrong. The blur commit is deliberate and load-bearing
for free text: an RBS signal edit partial-encodes into the message's
payload buffer, which goes out on the wire on the next emission while
the row is running, so a per-keystroke commit would put "1", "12" and
"127" on the bus on the way to `127`. A label picked from a list has
no half-typed states.

**Report 2 — the extra click, and it is not the selects.** The
mechanism is the `<datalist>`, not event ordering: picking a suggestion
replaces the input's value and fires `input` with focus unmoved (HTML
§ input suggestions), so a blur-commit box cannot see it. The user's
next click — anywhere — is what blurs the box and commits, which is
exactly one more click than a pick should cost. Every other
enum-selection surface was already correct and stays untouched:

| Surface | Commit trigger | Verdict |
| --- | --- | --- |
| `Combobox` — 19 call sites over 12 files (plot, trace filters, colormap, transmit, calc editor, sources, BLF channel map, RBS add-bus) | option click → `onChange` | already correct (`Combobox.dom.test.tsx`) |
| Native `<select>` (`settingControls.tsx`, enum settings) | `change` | already correct (`settingControls.dom.test.tsx`) |
| Bitrate / FD-rate preset datalists (`ConnectionManagement.tsx`) | `change`, per keystroke | already correct |
| RBS signal value cell, transmit signal value cell | **blur / Enter only** | the defect |

The two clicks a *closed* picker costs (open, then choose) are inherent
to any dropdown, native or not, and are not what was reported.

**The `choices` mechanism below is superseded by item 19**, which
moved both enum cells onto the shared `Combobox` and deleted the prop.
The commit model it records still holds — a discrete choice commits
when it lands — but the combobox's `onChange` is what delivers it now.

**Commit model adopted — one rule, both panels: a discrete choice
commits when it lands; free text commits on Enter or blur.** It lives
in `ValidatedInput` as one optional prop, `choices` — the texts that
are a choice rather than a prefix of one, which for these cells is the
signal's VAL_ table labels. `onChange` commits through the same path
the blur would have taken (parse, drop the draft, `onCommit`), so the
box ends the edit either way and a following blur cannot send it twice.
Anything not in `choices` — a raw out-of-table value, `0x…`, a number
for fault injection — is unchanged.

**No `inputType` sniffing.** Chromium tags a datalist pick with
`insertReplacementText`, which would distinguish a pick from typing the
label out, but it is untestable in jsdom and not uniform across the
WebViews the app ships on. Matching against the label set is
browser-independent and treats a typed-out label as what it is: the
same choice. The one behavioural consequence is a label that is a
strict prefix of another (`Park` before `Parking`) committing once on
the way if it is typed rather than picked — accepted, since the final
value is still what the user typed and the override is idempotent.

**The transmit enum cell moved onto `ValidatedInput`** rather than
growing a second copy of the rule. It was a hand-rolled duplicate of
that component (draft state, focus-clear, blur commit, Enter→blur)
inside `TransmitSignalsTable.tsx`, contradicting `ValidatedInput`'s own
docstring — "the one shared implementation the transmit and RBS panels
both use". The swap is net smaller, keeps the label-then-number parse
order verbatim, and picks up Escape-to-revert for free. Its numeric
sibling `NumericValueCell` is still hand-rolled; it is already on the
right model, so it was left alone.

**What jsdom cannot show.** A datalist popup is browser chrome with no
DOM presence — neither jsdom nor CDP can click a suggestion — so the
"a pick does not blur" half of the diagnosis is not directly
reproducible in a test. What the tests pin is the consequence that
makes the click cost real and the fix observable: the value arriving by
`change` alone must commit. Both new panel cases failed that way before
the change.

Tests: `apps/gui/src/ValidatedInput.dom.test.tsx` (new) — six cases
over the model itself: free text on blur only, a choice on the change,
no double commit when the blur follows, free text still deferred while
choices exist, a choice with surrounding whitespace, Escape. Plus
`RbsPanel.dom.test.tsx` — the label committing without a blur (and the
blur not re-sending), free text in an enum cell still deferred, and a
numeric cell still deferred (its `sampleView` fixture grew a plain
`PackVoltage` signal, since every other signal there is either an enum
or a calc destination) — and `TransmitPanel.dom.test.tsx` for the same
pick-commits case on the transmit cell. Four failed before the change.

Noticed in passing, not acted on: the RBS "Add bus to simulation"
control is the one place where an enum pick alone still does nothing —
a `Combobox` plus a separate button. That is a deliberate two-step add
action rather than a value edit, so it is left as it is.

## 15. Collapsible sections in the signals view

**Done, for the by-ID view — but this item misread the request.** The
user's intent (clarified 2026-08-05) was **arbitrary named sections in
the per-signal signal view, as a way to organize signals** — not
per-message grouping. That feature is now item 16, and the per-message
blocker recorded at the bottom of this item is moot: nobody asked for
per-message grouping, so its host-side design is not scheduled.

The by-ID fold work below stands as landed, but **awaits user review in
the running app before it is accepted** — and if kept, it likely wants
a way to disable it. Decision pending; nothing further built here until
the user has seen it.

**The collapse unit: one message's decoded-signal block, folding under
its ID row in the by-ID trace view** (`ByIdTable` / `TracePanel`).
That is the only view in the app whose rows are already "grouped under
message ids", which is how the item describes its subject; the
per-signal signals view (`SignalsPanel`) is a *flat* host-sorted list
with one row per selected signal and no message grouping at all. The
fold key is `byIdRowKey` — bus + arbitration id + std/ext — the stable
identity the expand set already used, chosen precisely so a fold
survives a re-sort or a new id appearing above it.

**It composes with the paged viewport without touching the anchor
math, because the fold *is* the geometry that was already there.** The
by-ID table sizes an expanded row through `expandedRowHeight` /
`expandedExtraHeight` / `rowHeightAt` / `buildPlacements`, anchors with
`tailAnchorRow` (task 48 item 5), and derives the expanded *positions*
from the loaded page only — a row outside it reads as a plain row until
it lands. Nothing in `traceViewport.ts` or `useTraceViewport` changed.
What was missing was a control and a memory:

- **The row is the control — there is no caret.** This landed twice.
  The first attempt turned the `▾` / `▸` beside the message name into a
  `<button aria-expanded>`, on the reading that item 5's
  button-in-heading idiom transferred. **The user rejected it, button
  and glyph both:** *"The caret conveys nothing. It's buried mid row
  around the message. Disclosures would typically go at the start of
  the row. Get rid of it."* Both halves of that are right — a caret
  three columns into a dense row is not where a reader looks for
  structure, and it was carrying the state for a control that was
  really the whole row.

  So the **row itself** is the disclosure: `tabIndex={0}`, Enter and
  Space toggle it (both `preventDefault`, or Space scrolls the rows
  container out from under the focused row), and `aria-expanded` sits
  on the row element. That is the row-as-focus-target model item 13
  gave the trace event rows, and it reuses their `:focus-visible`
  outline — the existing `.trace-event-row:focus-visible` rule is now
  `.trace-row:focus-visible`, which already covered the event rows
  (they carry both classes) and now covers these. **Mouse behaviour is
  unchanged**: click anywhere on the row, exactly as before.

  A row with no decode **claims nothing** — no `tabIndex`, no
  `aria-expanded` — rather than advertising an expandability it does
  not have; its click was already inert. `ByIdRow` now renders the
  message cell itself (the name, nothing else) instead of taking
  `cellContent`'s glyph-bearing one, which keeps the *chronological*
  trace's own caret exactly as it was — that view was not part of the
  ruling. `.trace-disclosure`, the class the rejected button used,
  stays in the stylesheet: item 16's signal-view section headers adopted
  it, and there the caret is at the **start** of the row, which is
  where the user says it belongs.

  Longer term the indicator is not this item's to design. The shared
  gridview interaction layer item 17 mandates — being worked up into
  its own planning task — owns disclosure indicators across these
  panels, at row start, per the user. Adding one here per-panel is
  exactly the five-times patching that item forbids.
- **Persistence.** The expanded set was `useState` in `TracePanel` and
  died with the panel. It joins that panel's existing dual-write config
  (element `config` + dockview `params`, through `useElementPanel`'s
  `persist`) as `expanded` — no new channel, no `UiState` field, no
  host change, exactly item 5's mechanism. Stored **sparsely, as stable
  ids**: item 5 persisted what is *folded* because its sections default
  to open; a by-ID row defaults to *collapsed*, so the sparse set here
  is what is **expanded**. Same rule — persist only the deviation from
  the default — inverted because the default is. Junk in the array is
  filtered rather than thrown on, matching `collapsedFromParams`.

One ordering consequence: the `persist` effect moved below the by-id
state block, since it now reads `expanded` and a dep array evaluated
above the `const` is a TDZ error.

Tests: `apps/gui/src/ByIdTable.dom.test.tsx` gains six row-disclosure
cases — no caret and no button in the message cell (open or shut), the
row carrying `tabIndex` and `aria-expanded` both ways, Enter and Space
toggling while an unrelated key does not, the mouse path unchanged, and
a row with no decode claiming neither the tab stop nor the state nor
responding to either input. New
`apps/gui/src/TracePanel.byIdCollapse.dom.test.tsx` — seven cases over
the state travelling: the id written to the params, taken back out on
unfold, mirrored onto the element, restored from params, an
unmount/remount round-trip through the params the panel itself wrote,
junk tolerance, and the restored fold reaching the scroll spacer (the
paging composition, asserted on the height the view *writes* — jsdom
does no layout). All seven failed before the change, and stayed green
across the caret's removal — only their row-locating helper moved off
the button and onto the row.

**Blocker: per-message grouping in the per-signal signals view
(`SignalsPanel`) needs host-side awareness, so it is not in this
item.** Recorded here for review rather than built. That panel's rows
come from `fetch_signal_page`: the host resolves the selection
(manual keys + ADR 0038 regex patterns), sorts by the user's column,
and returns `count` plus one page of up to `PAGE_ROWS` rows. The
frontend holds only the page. Folding a message there means inserting
group header rows and removing a group's rows from the row space, and
both need facts only the host has:

- *Where a group starts and how long it is,* for every group above the
  viewport — needed to map a visible index to an absolute one. That is
  a walk of the whole ordered row list, which is exactly the array the
  frontend must not hold.
- *The visible row count,* which drives the scrollbar extent. It is
  `count` minus the folded groups' lengths, and only the host can
  count.

The three frontend-only escapes were considered and all fail: a
render-time row filter over the loaded page leaves the scroll extent
at the unfolded total and punches holes wherever a folded group sits;
subtracting the folded messages from the wire selection works for
manual keys but a pattern cannot be subtracted (the selection is
additive, and a folded group with no rows left has no header to unfold
from); and re-deriving the group structure from the catalog in JS
duplicates `select_descriptors`, which the panel's own `view.error`
proves can disagree with the host (the two regex dialects differ), so
the scroll geometry would silently desync from the row list. Groups
are also only contiguous under the *default* (null) sort — the host's
descriptor order — and scatter under any column sort, so grouping
there is not even well-defined for most of the panel's states.

The correct implementation is host-side: `fetch_signal_page` takes the
folded `(bus, id, extended)` set, emits a group row per message
boundary in descriptor order, and returns a `count` that already
excludes folded groups' signals. That is a shape change to
`SignalSnapshotRecord` and a new parameter on the command, i.e. new
model surface — out of this item's scope and left for the user to
schedule.

## 16. Named sections in the signal view

**REOPENED 2026-08-05 — the feature does not work in the running app,
and two design corrections.** User report:

- **Defect: sections can be created but signals cannot be moved into
  them** — new sections stack up at the bottom, empty. The jsdom suite
  passes, so the break is somewhere jsdom does not exercise: prime
  suspects are the frontend↔host identity key not actually matching
  byte-for-byte (assignments silently bucketing nothing — which would
  produce exactly this symptom: names arrive, assignments don't apply),
  the Tauri invoke argument shape (camelCase conversion / serde naming
  on the nested `sections` object or the `kind`-tagged rows), or the
  row-menu move never issuing its update against the real panel. This
  must be diagnosed against the real host (Rust integration test using
  frontend-produced values, or the live app), not only jsdom.
- **Creation flow correction:** the new section should be created
  immediately with a starter name and its header dropped into the
  existing inline edit mode — not named beforehand in the add control.
- **Design extension:** each section should carry **its own pattern
  collection** in addition to individually assigned signals, so a
  pattern group can be organized — and moved — as a unit.

Keyboard navigation in this panel is deliberately NOT part of this item
— it belongs to the pending gridview keyboard-nav item (17).

### Resolution (2026-08-05)

**Diagnosis — the host and the wire were exonerated by experiment; the
control was unreachable.**

The two suspects that could be tested directly were tested and
falsified. `experiment_frontend_json_buckets_a_row`
(`signal_snapshot.rs`) takes the *exact* `sections` payload the panel
builds — `{"names":["Pack"],"assignments":{"p|s:256:EngineSpeed":"Pack"},"folded":[]}`
— deserializes it the way the command deserializes it, and arranges a
row with the matching descriptor: it buckets. So serde does not mangle
the nested object (suspect b), and the identity string the frontend
writes is byte-for-byte the one `signal_identity` computes (suspect
a). The user's own report corroborates the first half independently:
empty section *headers were rendering*, and headers only exist because
`names` arrived and `arrange_sections` ran.

That left suspect (c), and it is what the evidence fits: with
`assignments` empty on the wire and `names` populated, **no move was
ever performed**. The control shipped inside `.signals-name` — which
is `draggable="true"` — as a bare `▾` glyph appended *after* the
signal name in the 220px `col-signal` grid item, and
`.trace-row span { overflow: hidden }` clips a blockified grid item.
Two consequences, either sufficient: any name long enough to fill the
column pushes the button past the clip edge, where it cannot be seen
or hit; and what survives is a glyph-sized hit target nested in a drag
source, where a press-and-twitch starts a drag instead of a click.
**jsdom does no layout and runs no drag heuristics**, so the original
eleven tests found the button by role either way — the suite could not
have caught this.

Both preconditions are structural, so both are now pinned without
needing layout: the regression test asserts the control has no
`[draggable="true"]` ancestor and is not inside `.col-signal`.

**Fix: the control is its own column.** A `section` column shows which
section a row is in and *is* the button that opens the move menu —
fixed width, full-cell hit target, outside the drag source, and
self-labelling (there was previously no way to see a signal's section
at all). Sorting is suppressed on it: rows are already grouped by
section and the sort runs within each one, so a sort arrow there would
reorder nothing.

The section name is **stamped on the row by the host**
(`SignalSnapshotRecord.section`), not looked up in the assignment map,
because a row can reach a section two ways and the frontend can only
see one of them — a pattern-claimed row has no assignment.

**Correction: creation is immediate.** `+ section` creates
`Section N` (first unused) straight away and hands its header to the
inline editor; the name-first control is gone. The row menu's "new
section…" is the same operation with the row assigned to it. Naming
first put a text box between the user and a section they could see.

**Extension: a section owns patterns.** `sections.patterns` maps a
section name to its own ADR 0038 patterns, edited from the header
through the shared `SignalPatternEditor` — so a pattern behaves
identically wherever it is typed; only which selection it belongs to
differs. The three design questions:

- **Where they live relative to the view-level selection: a section's
  patterns are part of the view's selection contribution.**
  `selection_with_section_patterns` unions every *live* section's
  patterns into the selection before it resolves, so their matches get
  rows; then the arrangement files those rows under the owning section.
  Without the union a pattern typed into a section would collect
  nothing until the same pattern was also typed at view level.
- **Pattern vs. explicit assignment: the explicit assignment wins.**
  The user moved that signal by hand; another section's pattern must
  not drag it back. This is why "Unsectioned" is now written as an
  *explicit* assignment to the implicit section (`""`) rather than by
  deleting the entry — a deleted assignment is indistinguishable from
  "never touched", so the pattern would re-claim the row on the next
  poll. `""` is already the implicit section's wire name, so the host
  needed no new concept.
- **Two sections matching the same signal: the earlier section in
  creation order takes it.** Creation order is the order already on
  screen, so the tie-break is readable off the panel rather than
  inferred — unlike "most specific pattern" or "last wins".

Deleting a section stays a `names` edit and nothing else: its patterns
go dormant alongside its assignments (the host only reads either for a
live section), so re-creating the name restores the whole section.
Renaming carries both across.

Tests added, all failing first. Rust (eight): the wire experiment; a
section pattern collecting its matches; explicit assignment beating a
pattern; explicit-unsectioned beating a pattern; creation-order
tie-break (asserted both ways round, so name order cannot be what is
being read); a deleted section's pattern collecting nothing; a
non-compiling pattern matching nothing rather than panicking; the
selection union; and the per-row section stamp. Frontend (six): the
two structural facts behind the defect, the section column's contents,
immediate creation with a starter name, non-colliding starter names,
per-section patterns reaching config and wire, and patterns surviving
a rename / going dormant on delete.

**Done (first pass, defective).** The signal view takes user-authored named sections: create,
rename, delete, and a per-row move-to-section menu with a "new
section…" entry. A signal is in at most one section; everything else
sits in an implicit unnamed section, and a user who makes no sections
sees no change at all.

**The arrangement is host-side, because the item 15 blocker analysis
says it has to be.** `fetch_signal_page` owns selection, sort, count
and paging; the frontend holds one page. So the query grew a
`sections` argument and the reply grew a row kind:

```text
sections: {
  names:       [String],            // creation order
  assignments: { <identity>: name },// canonical signal identity → name
  patterns:    { name: [String] },  // a section's own ADR 0038 patterns
  folded:      [String],            // sparse; "" is the implicit section
}
```

```text
rows: [ { kind: "signal", ...SignalSnapshotRecord }
      | { kind: "section_header", name, signal_count } ]
```

`arrange_sections` (`signal_snapshot.rs`) buckets the collected rows,
sorts each bucket, and emits header-then-rows per section. Everything
downstream is unchanged: `RowPage::count` is the arranged length, so it
is already fold-aware, and `start + i` addresses a row exactly as in
every other paged view (ADR 0025).

The decisions this item owned:

- **A section header is a page row, not a side table.** It occupies one
  row slot, so the view stays *one uniform row space* and the panel's
  anchor/spacer arithmetic — the shared scaffold from item 7 — did not
  change by a line. The alternative (rows plus a section-boundary
  table) would have put header placement and index→row mapping back in
  JS, which is the arithmetic CLAUDE.md keeps in the model and which
  item 15 showed the frontend cannot do from one page.
- **The implicit section renders first**, and prints no header when it
  is the only section. First because creating your first section must
  not reshuffle the list under you: the signals you have not moved stay
  where they were, and everything that arrives later (a new pick, a new
  pattern match) appears in a known place at the top rather than after
  an arbitrary number of sections. A named section always prints its
  header even when empty — otherwise a section you just made would be
  invisible and undeletable.
- **Assignments key on the canonical signal identity**
  (`signal_identity`, the ADR 0038 stable descriptor key
  `bus|s|x:id:name`, byte-for-byte the frontend's `signalKey`). That is
  the identity the selection, the per-signal colours and the plot
  series already use, so an assignment survives selection edits and DBC
  renames of ECUs/messages.
- **Regex selections compose with no special case.** Assignment is by
  identity and sectioning runs *after* selection resolution, so a
  pattern-matched row is bucketed like a manual pick and its row
  carries the same move menu. The host test asserts this directly: its
  selection is pattern-only and its two assignments are canonical keys.
- **An assignment whose signal leaves the selection stays dormant.** It
  is simply never consulted while there is no row for it, and the
  signal returns to its section if it comes back — item 9's
  retained-ids reasoning. Nothing prunes assignments, so nothing has to
  decide when a signal is "gone".
- **Deleting a section is a `names` edit and nothing else.** The host
  reads an assignment naming no existing section as unassigned, so its
  signals fall back to the implicit section and stay in the selection;
  the assignments stay dormant, which makes re-creating the name an
  undo. **Renaming does rewrite** the assignments that pointed at the
  old name — otherwise a rename would silently empty the section.
- **Sort sorts within a section.** Sectioning subsumes the sort rather
  than following it: `arrange_sections` sorts each bucket, so there is
  no pass that could order rows across a boundary.
- **Section order is creation order**; no reordering UI (it did not
  fall out cheaply — it needs a drag surface on the header rows).

**Persistence splits across the two scopes on purpose.** The section
names and assignments are element config — project data, alongside the
selection, because they say what the view *means*. The fold set rides
the dockview params **only** (sparse, junk-tolerant, item 5's idiom):
which sections happen to be shut is workspace state. That is a
sharper split than items 5 and 15 needed, and it is why the panel's
dual write is no longer symmetric — `folded` goes to
`api.updateParameters` and never to `update(elementId, {config})`.

Tests, all failing first. Rust: seven in `signal_snapshot.rs` (the
identity string matching `signalKey`, the no-sections flat list, order
with the implicit section first, an empty named section keeping its
header, a folded section keeping its header and count, sort within
rather than across sections, and an assignment to a deleted section
falling back), plus `fetch_signal_page_pages_across_section_headers_
with_a_fold_aware_count` in `tests.rs` — the paging claim end to end: a
page straddling a boundary carries the header as an ordinary row, and
folding drops rows from `count` but not the header. Frontend:
`SignalsPanel.sections.dom.test.tsx`, eleven cases over no-sections
rendering unchanged, header rendering, the disclosure fold reaching
both the params and the query, restore-from-params with junk, the
scope split (fold in params, sections on the element), toolbar create in
creation order, the row menu's move both ways, "new section…"
creating-and-assigning, rename carrying its members, Escape abandoning
a rename, and delete leaving the selection alone with the assignment
dormant.

## 17. Keyboard navigation in the gridview-like panels

Captured 2026-08-05; **held until the user finishes the current
feedback round — do not start without their go-ahead.**

The grid-like presentations — trace panel in **both** modes
(chronological and by-ID), the signal view, the event rows — cannot be
navigated by keyboard: rows cannot be highlighted, focus cannot move
row-to-row. The by-ID row being Tab-reachable at all (item 15) only
highlighted that nothing else is, and that a tab stop per row is not
navigation.

**Architectural mandate, from the user:** anything rendering in this
gridview style must not be patched five times. Keyboard nav is to be
built once as part of a **shared gridview interaction layer** over the
existing shared viewport scaffold (`useTraceViewport`), and the
presentations migrated onto it — the same consolidation move item 7
made for the scroll math, one layer up. Design it together with item
18, which shares the selection model.

## 18. Selection, multiselect, and drag-and-drop across panels

Captured 2026-08-05; **held until the user finishes the current
feedback round — do not start without their go-ahead.**

In the gridview-like panels: select a row, multiselect, and drag items.
Motivating cases from the user:

- Necessary to make item 16's sections workable — organizing signals by
  menu alone doesn't scale.
- Drag a signal or message out of a by-ID panel onto a plot or transmit
  panel.
- Drag a **pattern group** (item 16's per-section patterns) and drop it
  somewhere that supports it — signal view → plot and plot → signal
  view.

Same architectural mandate as item 17: one shared selection/drag layer
for the gridview presentations plus a drop contract for the receiving
panels, not per-panel implementations. Design items 17 and 18 together.

## 19. Enum dropdown rendering and the reopen-filter bug

**Fixed. Both defects were the native `<datalist>`, not our code** —
and neither is reachable from JS, so the enum value cells moved onto
the shared `Combobox` instead.

**The two controls, and which one is at fault.** The app had two
select-like things. `Combobox` (`Combobox.tsx`), the designated one —
"any new select/combobox is one of these" — used by 19 call sites
across 12 files. And the RBS / transmit *signal value cells*, which
were `ValidatedInput` text boxes with a native `<datalist>` attached.
Only the second reproduces either report.

*Rendering.* Those datalists emitted an option carrying both a `value`
(the label) **and** text content (the raw). Chromium renders a
suggestion carrying both as two lines — the value, then the option's
text beneath it. That is the multiline. `Combobox` renders one list
item per option and never did this.

*Reopen filter — the differential experiment.* Walking the user's
four-step repro against each control decides it. `Combobox`: ArrowDown
on the closed trigger calls `openDropdown("")`, which **seeds the
filter empty regardless of `value`**, so step 4 lists everything — and
a new test asserting exactly that (`reopening after a pick lists every
option, not just the picked one`) **passed before any change**, which
falsifies the "it's the Combobox" hypothesis outright. The datalist
path reproduces all four steps: Chromium filters the suggestion popup
by the input's current text, focus never leaves the field between
steps 3 and 4, and after a commit the box holds the committed label —
so the popup matches one row.

The confirming evidence for that mechanism is **in the repository,
written by whoever hit the first half of it**: `ValidatedInput`'s
`focusBehavior="clear"` existed solely to empty the box *on focus* so
"the datalist offers all labels instead of filtering on the current
one (which locked the picker to the already-selected value)". The
reported repro is the hole that patch left — a reopen with no focus
change never re-fires `onFocus`.

**Why not patch the datalist.** The suggestion popup is browser chrome
with no DOM presence: it cannot be styled, its filtering cannot be
turned off, and neither jsdom nor CDP can click a row in it. The only
lever from JS is blanking the input's text, which is what the focus
patch did and what would have to be repeated on ArrowDown, on click,
and on every other gesture that reopens the popup — each of them
unobservable in a test. There is no fix in that control; there is only
a longer chain of workarounds.

**So both cells now render `Combobox`,** and the two defects are fixed
by the same move — which is also the "common control" the user asked
for and what the codebase's own convention already required.

| Where | What changed |
| --- | --- |
| `Combobox.tsx` | new `freeText` |
| `useValueTables.ts` | new `valueTableOptions` — the shared option shape |
| `RbsPanel.tsx`, `TransmitSignalsTable.tsx` | enum cell → `Combobox`; datalists gone |
| `ValidatedInput.tsx` | `list`, `choices`, `focusBehavior="clear"` removed — no callers left |
| every other `Combobox` call site | untouched; they never had either defect |

**`freeText`, because a value cell is not a closed list.** An RBS or
transmit enum signal must still take a raw code the DBC never named —
fault injection is the point of a rest-of-bus simulator. When the
filter text matches no option, it becomes **one extra row at the end
of the list** (`use "127"`). Last, not first, is load-bearing: the
active row resets to index 0 on every keystroke, so a leading free-text
row would steal Enter from the label the user was half-way through
typing. At the end it is unreachable by accident and is the only
pickable row when nothing matches, which is exactly when it is wanted.
No row is offered when the text already *is* an option.

**Option text: `<label> (<raw>)`, one line — a deliberate deviation
from the requested `Name(Value)`,** by the escape clause the item
allowed. The app already renders an enum reading that way in the plot's
side panel (`formatValueFor` in `PlotArea.tsx`, and `useValueTables`'s
own docstring describes the shape), so `Standby (1)` in a picker and
`Standby (1)` in the readout are the same fact rendered the same way.
The one-line requirement — the actual complaint — is met either way.
It lives in `valueTableOptions` next to the shared fetcher, so any
future enum picker inherits it rather than re-deriving it.

**What the cells submit.** The option's value is the **label**, which
is what the RBS file stores (`RbsValue::Text`) and what the host
resolves through the VAL_ table; the transmit cell maps the label back
to its raw through the same table it built the options from. Free text
commits as a number (RBS also still accepts `0x…`, via the extracted
`parseSignalText` its numeric cells share). The closed trigger shows
the matched option, falling back to a `placeholder` of the decoded
value so an out-of-table code is still legible.

**Item 14's guarantee survives:** picking commits in one click, with no
second send. It is now the combobox's `onChange` doing it rather than
`ValidatedInput`'s `choices`, so that prop went with the datalist —
**item 14's `choices` mechanism is superseded, its behaviour is not.**

**Not verified in jsdom:** that the trigger button styles like the
input it replaced. Both site classes (`.rbs-signal-input`,
`.tx-signal-input`) are declared *after* `.combobox-trigger`, so at
equal specificity they win on source order and keep the cells' own
background, border, width and monospace font; the overridden-cell
marker (`.rbs-signal-overridden .rbs-signal-input`) and the disabled
colour (`.combobox-trigger:disabled`, higher specificity) both still
apply. No CSS was added.

Tests: `Combobox.dom.test.tsx` — reopen-after-pick lists everything
(the control-level pin for the user's repro), and four `freeText`
cases: the typed row appears and commits, it sorts last so a matching
option still wins Enter, it is absent when the text is exactly an
option, and nothing changes when `freeText` is off. `RbsPanel.dom.test.tsx`
and `TransmitPanel.dom.test.tsx` — one line per option reading
`label (raw)`, pick-commits-once, reopen-after-selection lists every
label, and a raw out-of-table value going through as free text. Eleven
failed before the change; the one that passed is the one that
falsified the Combobox hypothesis.

## Exit criteria

- Every item above is fixed or struck with a recorded reason, and this
  file is deleted when the list empties.
- Each fix lands with a test that fails before it — except item 3, whose
  deliverable is a test that stops failing intermittently.
- Item 4 changes ADR 0026 in the same commit if the per-unit axis rule
  needs to say something about constant signals.
- Item 11 lands **ADR 0043** (cannet's DBC custom-attribute namespace,
  the DBC-versus-project test, and display-authority precedence) and
  **amends ADR 0026** for log scale as an axis property. The attribute
  is not shipped without the ADR: `CannetDisplay` is an extension point,
  and an extension point with no written rule is how the next three get
  added inconsistently.
- Item 2 records any new tool in `plans/technology-inventory.md`,
  adopted or rejected.
- Item 7 answers the base-implementation question explicitly — either a
  shared scroll primitive lands and the individual fixes fall out of it,
  or the record says why one does not fit. "We fixed the six we knew
  about" does not close it.
- Where jsdom cannot verify a layout claim, the record says so and the
  claim is backed by a Chromium measurement instead. No test that passes
  either way.
