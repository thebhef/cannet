# Task 56 — Regex-Derived Signal Attributes (Generators)

Owner feature request (2026-08-07): a **project-level** mechanism
that derives per-signal values from regex matches on signal names —
"generators."

## The idea

A generator is a project-scoped rule: a partial-match regex over
signal names plus a derivation of some attribute from the match.

Motivating example — **signal color map**: `/Cell(\d+)/` → the
captured number indexes into the color wheel, so `Cell1…Cell16`
get stable, meaningful wheel slots wherever they appear, instead of
hash- or order-assigned colors.

Second named use: **sort ordering** — the same capture could supply
the sort key for signal lists (the backlog's plot-side-panel sorting
item names this task).

## Grooming (2026-08-07)

- **Carrier (owner ruling): project-level for v1, stored in the
  project like the color maps.** The DBC-carried form (a database-
  level `Cannet*` `BA_` attribute — confirmed parseable today via
  `can-dbc`'s `attribute_values_database`, which `parse.rs` never
  reads) is **backlogged**, not rejected: it remains the way to ship
  coloration with a DBC, and the project-level rules land first.
- **Capture semantics (owner ruling): start simple.** First capture
  group parsed as an integer → wheel index directly; same index =
  same slot across rules (`Cell5` and `CellTemperature5` share a
  hue — index alignment is the point). No per-rule offset ("not
  better, just confusing"). A rule whose capture is missing or
  non-numeric doesn't apply to that signal; rules evaluate in list
  order, first match wins; no match → today's fallback. (Per-family
  line *style* was floated as the eventual differentiator, but it's
  project-wide and needs more thought — out of scope.)
- **Precedence / one-wheel (owner confirmed):** this task creates
  the shared color resolver ADR 0026 implies but the code lacks:
  **explicit user pick → generator → hash**, consumed by the signal
  view and the plot alike. Plot `SignalRef.color` survives only as
  an explicit per-series pick; the add/drop area-position seeding is
  removed — unpicked series always render through the resolver, so
  generator/override changes recolor live everywhere ("persist only
  on customize"). Accepted side effect: previously position-seeded
  unpicked plot series re-resolve on upgrade; this is also the fix
  for the 4-areas×16-signals color inconsistency from the owner's
  test drive.
- **Sort key (owner agreed): v1 is a one-shot "sort area" action,
  accessed via context menu on the plot area's signal panel** —
  reorders `area.signals` by (generator index, then name) once,
  persisting through the normal list; drag order stays the primary
  model. The signal-view sort column on generator keys is
  **deferred** (needs the derived key in the host's sort path; no
  driving ask yet).

## Scope questions to groom before implementation

- **Carrier: is there a non-hacky DBC extension for this?** (Owner,
  2026-08-07.) The `Cannet*` `BA_` custom-attribute mechanism
  (ADR 0043) already carries counter/CRC/display designations in the
  DBC itself, and ADR 0010 forbids sidecar files — a
  `CannetColorGen` / generator attribute would let the regex travel
  with the DBC the signals come from. Weigh against project-level
  storage (a generator spanning signals from several DBCs can't live
  in one of them); possibly both, with a precedence rule.
- **Regex-acceptance best practices are a requirement, not a nice-to
  have** (owner, 2026-08-07). Arbitrary user regex means ReDoS and
  resource limits are in scope: evaluate in the host with the Rust
  `regex` crate (guaranteed linear-time, no backtracking — the right
  engine for untrusted patterns); cap pattern length and compiled
  size (`RegexBuilder::size_limit`); surface compile errors in the
  UI at entry time, not at match time; never hand the raw pattern to
  a backtracking engine (JS `RegExp`) on unbounded input. If the
  frontend needs to preview matches, it asks the host.
- Where generators live in the project model (a new element kind vs
  a project-level list) and their UI (project panel?).
- Attribute set for v1: color (wheel index from capture) and sort
  key? What wins when a generator, a `signal_colors` override, and
  the theme-derived default all apply (precedence rule; the task-53
  decision "stored user colors render verbatim" suggests explicit
  override > generator > derived).
- Capture semantics: first capture group as integer for wheel index;
  what happens on non-numeric captures, multiple groups, multiple
  matching generators.
- Which surfaces consume it in v1 (plot series colors at minimum;
  signal-view name text and DBC value renderer share the wheel —
  ADR 0026's one-wheel rule means a generator recolors everywhere or
  the rule needs a stated scope).

## Exit criteria

- A project can declare generator rules (ordered `generator`
  project elements) mapping a signal-name regex capture to a
  color-wheel index; matching signals render the derived color
  everywhere signal color appears, through the new shared resolver
  (explicit pick → generator → hash), plot included.
- Plot add/drop area-position color seeding is removed; unpicked
  series resolve live.
- Rules validate and evaluate host-side (Rust `regex`,
  `size_limit`, entry-time compile errors surfaced in the editor);
  the frontend never executes user-supplied regex.
- Sort: a one-shot "sort area" context-menu action on the plot
  area's signal panel orders by (generator index, name). The
  signal-view sort column is deferred (recorded above).
- Persistence in the project file, with tests; docs updated
  (CONTEXT.md gains the term "generator"; README's plot/project
  sections updated).

## Status log

### 2026-08-08 — phase 56.A: the shared signal-color resolver

Landed on `task56a-color-resolver` (from `task55e-area-drag`):

| commit | subject |
| --- | --- |
| `2a44431` | `docs(perf): post-55e gate reports` |
| `f09af6a` | `feat(gui): one place decides a signal's color — pick, generator, hash` |
| `55c5046` | `feat(gui): plot series resolve their color instead of seeding it` |

Frontend suite 1613 → 1625 tests (133 → 134 files), all green;
`pnpm --dir apps/gui build` clean. No Rust changes.

What landed:

- **`apps/gui/src/signalColorResolver.ts`** — the single resolution
  point: `resolveSignalColor(key, pick, generator)` (pure, the
  precedence rule itself) and `buildSignalColorResolver(elements)`,
  which compiles the project's rules once per render the way
  `buildColorResolver` does for value color maps. 7 unit tests.
- **Signal view** (`SignalsPanel`) resolves its name text through it;
  the `signal_colors` project entry is the pick. Row prop
  `signalColors` → `signalColor(key)`.
- **Plot**: `SignalRef.color` → `SignalRef.colorPick`, written only by
  the swatch's color picker. Area-position seeding is gone from
  `placeSignal`, `parseDroppedSignals` and the config parser
  (`withColor` → `signalRefFromRaw`); `signalsFromPatterns` no longer
  bakes the hash into a pattern row. `PlotArea` takes a `seriesColor`
  prop and reads it live through a ref for the series stroke, the enum
  lane accent, the primary-signal axis color and the side-panel
  swatch — so a recolor still needs no uPlot rebuild.
- ADR 0026 gains the one-wheel / one-resolution-point decision and the
  implementation-status bullet that replaces the seeding one; README's
  plot section says a series' color comes from the signal's identity
  and only a pick is stored.

**Upgrade semantics — the reading implemented, and its cost.** The
grooming accepted "previously position-seeded unpicked plot series
re-resolve on upgrade". A stored `SignalRef.color` cannot be told
apart from an old explicit pick, so *every* stored `color` is dropped
at parse time and the series re-resolves; picks made from now on live
in the new `colorPick` field and persist. **Cost:** a color a user
explicitly picked on a plot series before this change is lost and
re-resolves like any other series (the signal view's `signal_colors`
picks and bus colors are untouched). This is the trade the grooming
chose — it is also the fix for the 4-areas × 16-signals inconsistency
from the owner's test drive — but it is a one-time visible change to
existing projects, so it wants an explicit nod at the completion
review.

**The generator slot 56.B fills.** `signalColorResolver.ts`:

```ts
export type SignalColorGenerator = (key: string) => number | null;

function buildSignalColorGenerator(
  _elements: readonly ProjectElement[],
): SignalColorGenerator {
  return () => null; // nothing declares a generator yet
}
```

`key` is the canonical `signalKey(busId, messageId, extended,
signalName)` — the same key the color maps and every caller use. The
return is a **color-wheel index** (`wheelColor` wraps it; `0` is a
real answer, `null` means "no rule claims this signal"), which is what
the groomed capture semantics produce (first capture group parsed as
an integer). 56.B replaces the body with a compile of the project's
ordered `generator` elements, evaluated **host-side** (Rust `regex`,
`size_limit`, entry-time compile errors) per the exit criteria: the
frontend gets a key → index answer and never runs a user regex.
Nothing else has to move — both surfaces already call
`buildSignalColorResolver(elements)`, and both re-render when the
element set changes.

Two live-recolor seams worth knowing for 56.B:

- A plot's uPlot instance resolves its stroke through
  `seriesColorRef` per draw, so a generator change repaints on the
  next draw — but a **stopped** plot needs a nudge. The colormap
  resolver has one (`useEffect(() => uplotRef.current?.redraw(), [resolveColor])`
  in `PlotArea`); the series resolver will want the same effect keyed
  on `seriesColor` once its identity can actually change.
- `PlotPanel.seriesColor` / `SignalsPanel.signalColor` are memoised on
  `registry.entries`, so a generator edit invalidates them for free.

### 2026-08-08 — phase 56.B: generator rules, end to end

Landed on `task56b-generator-rules` (from `task56a-color-resolver`):

| commit | subject |
| --- | --- |
| `49121e0` | `feat(gui): the host decides what a generator rule claims` |
| `3fe5807` | `feat(gui): a project can write generator rules` |
| `7c4c696` | `feat(gui): generator rules colour the signal view and the plot` |

Frontend suite 1625 → 1640 tests (134 → 136 files); Rust
`cannet-gui` 482 → 495 tests (2 ignored, unchanged). `pnpm --dir
apps/gui build` and `cargo clippy -p cannet-gui --all-targets` clean.

**Command shapes** (`apps/gui/src-tauri/src/signal_generator.rs`):

| command | args | returns |
| --- | --- | --- |
| `validate_signal_generator` | `{ pattern: String }` | `Result<(), String>` — the message the editor shows inline |
| `evaluate_signal_generators` | `{ patterns: Vec<String>, names: Vec<String> }` | `Vec<Option<u32>>`, one wheel slot per name, positionally |

Evaluation is by **name**, not by signal key: the rules match the
display name, so one question answers every bus a name appears on and
the host never has to mint the frontend's `signalKey` string. The
frontend zips the positional answers back onto the keys.

**Design readings recorded:**

- **Case sensitivity: sensitive.** DBC signal names are, so `Cell(\d+)`
  must not claim `cell5`; `(?i)Cell(\d+)` opts out. Matching is
  partial (unanchored).
- **A rule with no capture group is an entry-time error**, not a silent
  no-op — a forgotten `(` would otherwise match everything and apply to
  nothing.
- **A rule that matches but captures nothing usable does not apply**,
  and evaluation continues with the next rule. "First match wins" is
  read as "first *applying* rule wins".
- **A pattern that doesn't compile is skipped at evaluation** (the
  editor already reported it), so one bad rule in a project can't blank
  out its neighbours. Same spirit as `filter.rs`'s "bad pattern matches
  nothing".
- **Caps:** pattern length 512 chars, `RegexBuilder::size_limit`
  64 KiB. The size-limit test asserts the rejected pattern compiles
  under the crate's 10 MiB default, so it proves *our* cap is what
  turns it away.
- **Capture parsed as `u32`.** A negative or overflowing capture makes
  the rule not apply, which is the same door as "non-numeric".
- **Several `generator` elements are allowed**; their rules concatenate
  in element order. `enabled: false` parks a rule (only an explicit
  `false` disables, so a project saved before the flag still works).

**Evaluation-refresh triggers** (`signalGeneratorContext.tsx`): the
effect keys on the *joined enabled patterns* and on the catalog's
distinct-name list. So it re-asks the host when a rule is added,
edited, reordered, enabled/disabled or deleted, and when the DBC
catalog changes (bus set, DBC set, `dbc-changed` watcher) — and **not**
when an unrelated element edit replaces `registry.entries`, which
happens on every panel config write. One provider mounted in `App`
serves every panel, so a rule edit costs one round-trip, not one per
plot.

**What landed:**

- `signal_generator.rs` — `compile` / `evaluate` + the two commands,
  13 unit tests (validation errors, size-limit rejection, partial
  match, case sensitivity, missing/non-numeric capture, first-applying
  rule wins, same index across rules, uncompilable rule skipped,
  catalog-order evaluation).
- `generator` project element (`types.ts`, `normalizeElement`,
  `isProjectElement`, `elementLabel`, `ProjectPanel` group order,
  `dockLayout`, `commands`, `App`), ambient like a colormap: no
  `sources`, not a graph node. **No host/schema change** — `elements`
  is `Vec<serde_json::Value>` and round-trips opaquely.
- `GeneratorPanel.tsx` + 7 DOM tests — rule list with enable toggle,
  reorder arrows, delete, add; entry-time errors from the host keyed by
  pattern text (not row index) so reordering can't mis-attach one; a
  blank row is unfinished, not wrong, and isn't validated.
- `signalGeneratorContext.tsx` + 3 DOM tests — the cached
  `Map<signalKey, slot>` every surface reads.
- `buildSignalColorResolver(indexes)` replaces
  `buildSignalColorResolver(elements)`; both call sites
  (`PlotPanel.seriesColor`, `SignalsPanel.signalColor`) memoise on the
  map.
- **56.A Blockers item 3 closed**: `PlotArea` now redraws on a
  `seriesColor` change, so a stopped plot repaints on a rule edit.
  Driven by a PlotPanel test (stroke, swatch, no rebuild, redraw
  count) that was red before the effect.
- Docs: CONTEXT.md gains "generator"; README gains a Generator rules
  section (Cell1–16 table, case sensitivity, where the regex runs);
  ADR 0026 gains the generator bullet and loses "compiled from the
  project's elements".

### 2026-08-08 — phase 56.C: the one-shot "sort area" action

Landed on `task56c-sort-area` (from `task56b-generator-rules`):

| commit | subject |
| --- | --- |
| `698ffe9` | `feat(gui): a pure sort key for a plot area's signal list` |
| `6612566` | `feat(gui): a one-shot "Sort area" action on the plot's row context menu` |

Frontend suite 1640 → 1648 tests (136 → 136 files; `plotPanelConfig.test.ts`
gained 5, `PlotPanel.dom.test.tsx` gained 3). `pnpm --dir apps/gui build`
clean, `tsc --noEmit` clean. No Rust changes — evaluation and generator
indexes were already host-answered as of 56.B; this phase only consumes
the cached `signalKey → slot` map.

**What landed:**

- **`sortAreaSignals(signals, generatorIndexes)`** (`plotPanelConfig.ts`)
  — the pure sort key: a generator-claimed signal (present in the map)
  sorts by `(index, name)`; an unclaimed one tails, by name alone. Name
  collation is `localeCompare(..., { sensitivity: "base" })` — the same
  case-insensitive rule `DbcPanel`'s ECU grouping uses. `Array.prototype.sort`
  is a stable sort (ES2019+), so a real tie (same index *and*
  case-insensitive name, e.g. `Cell1`/`cell1`) keeps its input order —
  covered by a dedicated stability test. 5 unit tests (index+name order,
  no-index tail, case-insensitive collation, stability, non-mutating).
- **`AxisHandlers.onSortArea: () => void`** — routed to the *parent*
  area's id, same pattern as `onSetPrimarySignal`, so invoking it from
  a per-unit/individual derived axis still sorts the whole logical
  area, not that axis's slice. `PlotPanel.sortArea` is the one new
  `setAreas` write: `{ ...a, signals: sortAreaSignals(a.signals,
  generatorIndexes) }` — nothing else on the area or its signals is
  touched (no `hidden`/`colorPick` rewrite).
- **Placement reading:** the row context menu (`SignalSelectionMenu`,
  task 49.B's Hide/Show shell) gained a third button, **Sort area** —
  the "context menu on the plot area's signal panel" the grooming
  names, read literally as the existing per-row menu rather than a new
  header-level one. Unlike Hide/Show it ignores the selection entirely
  (a title attribute says so) and always acts on the whole area.
- **Collation reading:** case-insensitive, `localeCompare` at `"base"`
  sensitivity — matches how names are browsed elsewhere (`DbcPanel`'s
  ECU grouping is the only other collation precedent in the codebase).
- **Pattern-derived rows:** untouched by design — they aren't in
  `signals`, so `sortAreaSignals` never sees them; they keep rendering
  in pattern-evaluation order, as the grooming's consequence read.
- 3 DOM tests (`PlotPanel.dom.test.tsx`): the button is present on the
  row menu; invoking it reorders a scrambled unified-mode area's rows
  by (index, name) in one persist; and — the per-unit-mode case the
  brief called out — invoking it from one derived axis (the unit-A
  axis, showing neither of the two generator-claimed signals) still
  produces a persisted parent `signals` order that interleaves all
  four signals across units, which only a whole-list sort can produce
  (a "sort this axis's slice only" bug would leave the two axes not
  clicked from untouched, and the assertion is against the *persisted*
  list rather than DOM row order for exactly that reason — per-unit
  grouping can make a slice-only sort's visual output coincide with a
  whole-list sort's for small fixtures).
- README's plot section gains a paragraph on Sort area beside the
  Hide/Show one. No new CONTEXT.md term — "Sort area" is a UI action
  name over the already-defined "generator" concept, not a new domain
  concept of its own.

## Blockers / side effects

- **Sort area forces the same cold-refetch treatment as adding or
  removing a signal.** `PlotArea`'s uPlot-construction effect keys on
  `signalSetKey = signals.map(signalRefKey).join("|")`
  (`PlotArea.tsx`), which is **order-sensitive** — reordering with no
  membership change still changes the string. That effect drops the
  decimation cache and host extents and re-fetches the whole window
  (`PlotArea.tsx`'s construction effect, guarded by
  `builtSignalSetRef.current !== signalSetKey`) whenever it fires, so
  invoking Sort area costs a full-window uPlot rebuild + refetch, the
  same as an add/remove — not the cheaper "just resample" path a
  same-membership reorder could in principle take. This is what the
  brief asked to check rather than fix: `signalSetKey` is depended on
  by several other effects too (float rule, value tables, log axis…),
  so making it order-insensitive is a wider change than this task's
  scope, and the sort action is one-shot rather than something a user
  invokes on every tick, so the cost is a single hitch, not a
  steady-state one. Left as-is; a candidate for `plans/backlog.md` if
  it turns out to matter in practice — not added there in this pass
  since it wasn't observed to visibly regress anything under test.
- **Pre-upgrade explicit plot picks re-resolve.** See the upgrade
  reading above: dropping every stored `SignalRef.color` is the only
  way to re-resolve the position-seeded ones, because nothing
  distinguishes the two populations. Signal-view picks
  (`signal_colors`) and bus colors are unaffected.
- **"Clear project colors" doesn't reach a plot series' pick.** The
  command (`ClearColorsConfirmModal`, `App.tsx`) clears bus colors and
  the `signal_colors` map. Before this phase a plot's `color` was a
  seed, so leaving it alone was right; now `colorPick` is a genuine
  user pick and the command arguably should discard it too. Out of
  scope here (it reaches into every plot element's config) and left
  unchanged — worth an owner ruling.
- ~~**A stopped plot won't repaint on a generator change**~~ — closed
  in 56.B: `PlotArea` redraws on a `seriesColor` change, under test.
- **A generator can only claim a signal the DBC catalog knows.**
  Evaluation runs over `list_signals`, so a plot series bound to a
  message no loaded DBC covers falls through to the hash however well
  its name matches. Correct for the colour use (the name comes from a
  DBC in the first place), but it means removing a DBC silently drops
  the colours it was carrying.
- **A pattern holding a literal newline would break the effect keys.**
  Both the editor and the provider join patterns on `
` to key their
  effects. The single-line pattern field can't produce one, but a
  hand-edited project file could; the result is a mis-keyed refresh,
  not a crash or a wrong match.
