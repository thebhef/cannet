# 0135 — Plot Math Functions

> **Opened 2026-09-05** from owner usage feedback (split out of task 134). **Grooming in progress 2026-09-06** — design draft below,
> open questions at the bottom.

Math functions on plotted signals. The function set (owner, 2026-09-05 + 2026-09-06): sum, difference, product, **scale** (a scaled
copy: gain·x + offset — distinct from task 23's per-series display offset/gain), exponential filter, hline, integration, duty cycle,
frequency, and max / min / average / median / **range** over a set of signals.

## Design (draft)

- **Host-side derived series**: a new decode provenance in the signal cache, on the file-backed-signal precedent ("provenance decides
  the fill, and only the fill") — the pyramid, paged serve, `signal_min_max`, persistence, catalog and plot are all inherited.
- Rationale: ADR 0007 (the renderer paints, the model works) and ADR 0025 forbid re-deriving model facts in JS; decisively, the
  **exponential filter is stateful** and must run on the raw series (pyramid level 0) or its output depends on zoom level — it cannot
  be a frontend post-process.
- **Identity**: a fourth provenance flag in the series key (today `s|x|f`, mirrored byte-for-byte host/frontend); a math series has no
  bus/ecu/message path — the same gap file-backed signals already have (ADR 0038).
- **Fixed function set** (sum, difference, product, exponential filter, hline) with typed parameters — shaped so a general expression
  tree can come later. Definitions reference operand signals by provenance-keyed signal reference.
- **Validity** (owner-confirmed 2026-09-06): math signals are **cached the same way as other signals**, with analogous
  fingerprinting — fingerprint = function + parameters + **operand signal fingerprints** (the compositional analogue of
  `dbc_encoding`, ADR 0054); an operand redefinition parks the derived pyramid like any encoding change (ADR 0047).
- **Completeness**: a serve over a still-catching-up operand propagates `complete = false` (ADR 0049); catch-up runs off the model
  lock like every other fill (ADR 0048).
- **SIMD/vector math wherever possible** (owner, 2026-09-06): kernels run over contiguous aligned slices — operands resampled onto a
  shared timeline (sample-and-hold union, the host analogue of the plot's `mergeSeries`) so the pointwise ops (sum, difference,
  product, scale, min/max/average) vectorize cleanly; median is a small per-point k-select, duty/frequency ride prefix sums, and the
  exponential filter is a sequential recurrence (vectorizable across signals, not across time). Whether auto-vectorized slice loops
  suffice or an explicit SIMD crate (`wide` / `pulp`) pays is a benchmark-backed technology-inventory decision at implementation.
- **hline** is the zero-operand math channel; it renders as data (solid), settling the one-sample-series dashed-wings question
  (ADR 0026) in favour of user-authored constants.
- **Task 23 boundary**, by task 23's own rule ("offset and gain are transforms on a series"): `scale` is a per-series display
  transform and belongs with task 23's offset/gain; 135 owns everything that mints a *new* series.

## GUI rulings (owner, 2026-09-06)

- ~~Math signals are added to plot areas via a context menu on the plot view~~ **Superseded later 2026-09-06: math signals are
  created from the Database view**, then added to the plot view, signals view, etc. like any other signal.
- Each shows in the signal panel as an **expandable** row. ~~No bus swatch — the disclosure goes in that slot~~ **Superseded later
  2026-09-06: the bus color chip is retained** — one chip per bus contributing input; with multiple busses the label becomes
  "Math - Multiple Busses".
- **No heuristic names from selections** (2026-09-06): a pattern-defined set may default to the literal `fn(pattern)`; a
  manually-picked set gets no derived name — the user names it.
- The result's **units are user-specifiable**.
- Computed **host-side**, living in a **central repository** (resolves the persistence question: own registry, 0112-aligned).
- They appear in the Database panel under a **"Computed"** branch (resolves the catalog question).
- **One expansion/edit view everywhere**: math signals expand in the Database panel and signal panels too, and are edited there
  with the same views the plot panel uses — one shared row + detail + edit dialog over the central definition.
- **Math signals are selectable as inputs** to other math signals; cycles are refused at definition time. (The compositional
  fingerprint already covers this: a change deep in the chain reflows every dependent fingerprint.)
- **Regexes are the idiom** (owner, 2026-09-06): default names use them (`max(Cell\d+)`), and a set function's membership is manual
  picks ∪ live regex-pattern matches — the plot-area filter-mode model (ADR 0020), so a new matching signal joins automatically
  (membership change flows through the fingerprint).
- **The operand selector IS the Signals panel (`SignalsPanel`), columns trimmed way down** (owner, 2026-09-06; clarified: the
  Signals *panel*, NOT the plot's side signal area). Signals are dragged in or join via a pattern — the problem the Signals panel
  already solves; the editor is non-modal so drags can reach it.
- **Prepopulated operand sections with validation** (owner, 2026-09-06): the Signals panel **already has section support** — the
  editor embeds it with fixed, prepopulated sections users cannot add or remove: A and B for a pair, Signal for single-operand
  functions, Signals for a set. Each section shows its own validity in the edit control (e.g. "A — pick one" until it holds exactly
  one).
- **Single-slot picking gets a combobox** (owner, 2026-09-06): where exactly one signal must be chosen (difference's A/B, scale and
  the other single-operand functions), the slot offers a combobox whose flyout is a **trimmed database tree** filtered by **fzf-style
  fuzzy search** — drag-in still works too.
- **The prototype must look like the real plot panel.** A long-lived, faithful plot-panel shell goes into `plans/prototypes/` as the
  starting point for this and future GUI prototypes; the math-signals page rebuilds on it.
- **Prototype required**: how each function gets added and what its GUI looks like — `plans/prototypes/math-signals.html`. It must
  render **every function type's edit controls at once** (a gallery of all the edit views), not gated behind adding each one.

## Performance

- The integrated perf test (ADR 0031 harness) grows a **math test case**: a collection of math signals computed from the same
  project as the existing baseline (ev-zonal), measured alongside the current metrics. (Owner, 2026-09-06.)

**2026-09-06 (owner rulings closing the residue):**

- **No dialog, ever.** The editor is anchored wherever it's invoked and reads as an in-place expansion of that surface (Database
  detail area, an expanded row in a signal panel / plot side list) — never a floating dialog.
- **Parameter sets approved as prototyped**: τ (exponential filter); threshold + window seconds (duty cycle, frequency);
  gain + offset (scale); value (hline).
- **Definitions persist in the project file**, referenced by stable id (display names mutable, renames safe) — the generators /
  signal-colors precedent.
- **Enum operands participate as raw numeric values**; no special casing.
- **Export: MDF only.** (Note: cannet does support MDF export today — Save Capture writes MDF 4.10 including file-backed signals —
  so math signals ride the existing `write_mdf_capture` path as already-decoded channels; BLF carries none.)

**2026-09-06 (final function-set rulings):**

- **Owner reaction to 135-1's session-scoped pyramids (2026-09-06): "almost certainly not ok, at least long term."** The
  original "cached the same way as other signals" ruling stands as the long-term target; the session-scoped implementation is
  a tolerated interim. Flagged for review at campaign close-out (owner-review-queue § 3) with the perf math case's
  reopen-recompute number; expected follow-up: persist per-kernel resume state beside the level files + park-on-redefinition.
- **Set functions stay pointwise** (time-varying: `max(Cell\d+)` is the cell-max curve).
- **New function `statistic`** (renamed from `stats`, owner 2026-09-06 — singular; it yields one statistic): ONE signal + a
  selected statistic (min / max / mean / median / common percentile) → a capture-constant value drawn as an hline.
- **New function `rms`**: single operand, ~~over a trailing window (like duty cycle / frequency)~~ **superseded 2026-09-06:
  instantaneous** — pointwise √(x²) (= |x|), no window parameter; smoothing is user-composed (e.g. an expfilter downstream).
  *Note for implementation:* expfilter∘rms yields a rectified average, not true windowed RMS — that would need square/sqrt
  primitives; flagged, owner accepted the instantaneous form.
- **MDF-only export confirmed** (owner hadn't used the existing MDF save; it exists — use it).

**2026-09-06 (owner prototype feedback, after the in-place rework):**

- **Math rows use the app's standard disclosure control** (`disclosure-toggle`) at its standard prominence — the prototype's
  small bespoke arrow was what read as "not prominent enough". ~~larger/brighter than the standard chevron~~ (orchestrator
  misread, corrected same day: no custom variant).
- **No two-stage view**: expanding a math row shows the edit view **immediately** — no read-only detail with an Edit… step.
  Remove moves into the editor footer.
- **Operand sections stack under their headings**, full width — not beside a label column — so the editor fits the narrow
  plot signal area.
- **The Percentile field is hidden** (not just disabled) unless the selected statistic is `percentile`.
- **The disclosure must not sit close to the row's remove (✕) button** — clear separation between expand and remove.
- **No Remove/Cancel/Save buttons in the editor.** Edits **apply on blur** (field-level commit), and **undo/redo applies** —
  math edits record into the app's element edit history. Consequence: creation materializes the definition immediately (from
  the context menu) and the registry holds **incomplete/invalid definitions** (marked invalid, serving nothing) rather than
  refusing them; hard refusals remain only for what can't be stored meaningfully (duplicate id, cycles).
- **Deletion is the Database view's job**: a **two-stage delete button** (arm, then confirm) on the Computed row removes the
  definition from the signal registry.

## Remaining work to close grooming

1. ~~Prototype: rework the editor from floating panel to **in-place expansion**; add `stats` and `rms` gallery cards~~ **done
   2026-09-06**: the editor now renders in place on the invoking surface (plot side-list row detail, Database row detail, or
   under the Computed branch for creation — the floating panel is gone); `statistic` = signal + Statistic select
   (min/max/mean/median/percentile, Percentile field enabled only for `percentile`); `rms` = signal only, no parameters
   (instantaneous ruling above). **Owner ruling 2026-09-06: don't block on the confirming look** — implementation proceeds; the
   look can land any time and still overrule.
2. ~~Write exit criteria~~ **drafted 2026-09-06** (below); phases sliced (engine / creation+editor / surfaces+perf) and queued
   behind tasks 136 and 137 in the approved execution plan.

## Exit criteria

**Draft 2026-09-06** — to confirm with one owner look at the reworked prototype (in-place editor + statistic/rms cards). The
prototype (`plans/prototypes/math-signals.html`) is the behavioural reference; every behaviour lands with a test written first.

1. **Engine**: every function (sum, difference, product, scale, expfilter, hline, integration, duty cycle, frequency,
   min/max/average/median/range of set, statistic, rms) computes host-side as a new decode provenance in the signal cache —
   pyramids, paged serve, `signal_min_max`, completeness propagation all inherited; expfilter runs on level 0.
2. **Identity + caching**: fourth provenance flag in the series key; compositional fingerprint (function + params + operand
   fingerprints); an operand redefinition parks dependent pyramids; math-on-math allowed, cycles refused at definition time.
3. **Persistence + membership**: definitions live in the project file by stable id (renames safe); a set's membership is manual
   picks ∪ live regex matches — a new matching signal joins automatically and reflows the fingerprint.
4. **Creation + editing**: created from the Database view; listed under the Computed branch; rows expand in the Database panel,
   signal panels, and the plot side list into one shared **in-place** editor (never a dialog): fixed prepopulated operand
   sections with per-section validation, drag-in, single-slot fzf combobox over a trimmed tree, per-section pattern popover;
   no heuristic names (`fn(pattern)` default only for pattern-only sets); user-specifiable units. The editor is single-stage
   (expansion opens it directly), has **no Save/Cancel/Remove buttons** — edits commit on blur and ride undo/redo — and the
   Database view carries the **two-stage delete** that removes a definition from the registry.
5. **Signals everywhere**: math series drag to plots and signal views like any signal; bus chips per contributing bus
   ("Math - Multiple Busses" label when several); statistic renders as a capture-constant hline; hline draws solid; MDF export
   carries math series as decoded channels, BLF carries none.
6. **Kernels**: pointwise ops vectorize over contiguous slices on a shared resampled timeline; the explicit-SIMD-crate question
   is settled by benchmark and recorded in `technology-inventory.md` either way.
7. **Perf case**: the ADR 0031 harness grows a math test case (a collection of math signals over the ev-zonal project),
   collected alongside the existing metrics.
8. **Docs**: README covers math signals; rustdoc on new public API; CONTEXT.md gains the terms (math signal, Computed branch).

## Status log

### 2026-09-06 — phase 1 of 3, registry + compute engine (`task135-engine`)

Exit criteria 1, 2, 3 and 6 met. No GUI beyond the Tauri command
surface phase 2 calls; the frontend touch is the mirrored series key
and its types.

**What landed**

| Area | Where |
|---|---|
| Definitions, registry, membership resolution, cycle refusal | `apps/gui/src-tauri/src/math_signals.rs` (new) |
| Kernels: shared timeline + one per function | `apps/gui/src-tauri/src/math_kernels.rs` (new) |
| Definition CRUD commands | `apps/gui/src-tauri/src/math_commands.rs` (new) |
| Fourth provenance, the math fill, completeness | `signal_cache.rs` |
| Compositional fingerprint `math_encoding` | `signal_fingerprint.rs` |
| Registry + resolved-model cache on `AppState`, project load/save | `app_state.rs`, `project.rs`, `lib.rs` |
| Mirrored `m` flag | `plotData.ts`, `plotPanelConfig.ts`, `types.ts` |

Tests: 61 new (24 kernel, 21 definition/registry/membership, 10 cache
integration, 6 fingerprint composition, 2 `AppState`, 2 project
round-trip). `cargo test -p cannet-gui` 1118 pass.

**Design decisions worth carrying forward**

- **The fill is incremental, and it has a watermark.** A round reads
  each operand's unread level-0 tail (capped at 16 384 samples), merges
  onto the sample-and-hold union timeline, runs the kernel and appends.
  A block stops at the *earliest* of the operands' newest sample times:
  emitting past it would mean a later-arriving sample from a slower
  operand needing insertion before an existing row, and every pyramid
  level has to stay non-decreasing in time. The stateful kernels'
  carry (filter output, integrator accumulator, trailing-window running
  sums) lives beside the series and survives rounds, so a series built
  across four serves of a growing capture equals one built in a single
  pass — pinned by a test over all four stateful functions.
- **Math pyramids are session-scoped: not persisted, and not parked.**
  Persistence and parking both reopen a pyramid from its level files
  alone, which for a math series would leave it with no fill state
  (operand cursors, held values, kernel carry) and so unable to ever be
  extended again. Persisting all of that beside the samples would be a
  second, parallel serialisation format for something that is cheap to
  recompute: rebuilding a math series reads samples that are *already
  decoded*, a fraction of the decode a persisted pyramid exists to
  avoid. So `persist` skips them and `invalidate_dbcs` drops rather
  than parks them. The trade genuinely runs the other way here than it
  does for a decoded series (ADR 0047); flagged for the owner.
- **Completeness recurses.** `caught_up` follows a math key into its
  operands: the series is complete only when its fill has consumed
  everything they hold *and* every operand is itself caught up. So a
  serve over a math signal whose input is still decoding reports the
  partial answer ADR 0049 asks for rather than a finished-looking curve
  over half a capture.
- **`hline` and `statistic` do not read a chunk.** `hline` has no
  operands, so it takes the capture's span: one point at the start, one
  extended to the live edge per serve — two points over a stopped
  capture, not one per frame. `statistic` recomputes over the operand's
  whole level-0 whenever the operand has grown, appending a point each
  time. Over a stopped capture that settles to two points at one value
  (the flat line the ruling asks for); over a *live* capture it is a
  converging staircase, because the statistic genuinely is still
  moving. Phase 3's renderer should know that.
- **Median has two conventions, deliberately.** The pointwise
  `median` of a *set* takes the mean of the two middle values (a
  handful of operands, an instantaneous middle); `statistic`'s median
  is nearest-rank, because it must equal `percentile 50` — a median
  that disagreed with the 50th percentile of the same data would be
  worse than either convention.
- **Set functions with a set of one are legal**, so `sum` over a
  pattern that currently matches one signal is that signal, and the
  series does not vanish while the user is building it up.

**Investigation: a revived math pyramid could never advance**

- *Observation*: `an_operand_redefinition_parks_the_dependent_pyramid`
  asserted 2 revivals after reverting a DBC edit and got 1.
- *Hypothesis*: the parked math row is never revived, because
  `revive_retained` recomputes every retained row's stamp with
  `dbc_encoding` and reconstructs its key from `PersistedSignal`, which
  carries no math discriminant.
- *Experiment*: read `PersistedSignal::key`, which returns `None` for a
  row with no bus and no file — exactly a math row. Confirmed: such a
  row is skipped and leaks in the pool.
- *Data, and the larger finding*: fixing the key would not have been
  enough. A revived cache comes back through `SignalCache::from_levels`,
  which has only the level files — so the revived math series would
  have had `math: None`, no fill, and would have sat frozen at whatever
  it held while reporting itself never-complete.
- *Conclusion*: park is the wrong mechanism for this provenance. Math
  keys now route to `drop_keys` on an encoding change and recompute.
  The test asserts one revival (the operand) and that the recomputed
  series equals the original.

**Deviations from the phase brief**

- **`docs/CONTEXT.md` gained the "Math signal" glossary entry** rather
  than waiting for phase 3. New rustdoc and TS comments cite
  `docs/CONTEXT.md` for the term, and a doc reference to a term the
  glossary does not carry is the doc-vs-code mismatch CLAUDE.md forbids
  leaving. README still waits for phase 3's user-facing surface.
- **`math_signals` and `math_kernels` are `pub mod`**, like
  `signal_cache`: `signal_cache`'s and `project`'s own public rustdoc
  name these types, which a private module cannot carry
  (`rustdoc::private_intra_doc_links`), and phase 3's harness math case
  will need them anyway.
- **`Project` lost its derived `Eq`** (kept `PartialEq`): a math
  signal's parameters are `f64`. Nothing used it as a key.

### 2026-09-06 — phase 2 of 3, creation + the in-place editor (`task135-editor`)

Exit criterion 4 met, as the day's rulings rewrote it. No plot or
signal-panel surface: phase 3 mounts the same editor there.

**What landed**

| Area | Where |
|---|---|
| The shared editor: fixed sections, drag-in, combobox, pattern popover, commit-on-blur | `apps/gui/src/MathSignalEditor.tsx` (new) |
| Function metadata + the pure definition transforms one commit makes | `apps/gui/src/mathSignals.ts` (new) |
| Computed branch, creation menu, two-stage delete, editor mounting | `DatabasePanel.tsx` |
| Wire mirrors (`MathDefinition`, `MathSignalRecord`, …) | `types.ts` |
| Math edits on the panel-edit undo stack | `panelEditHistory.ts`, `App.tsx` |
| Registry stores unfinished definitions; `Unnamed` validity | `math_signals.rs`, `math_commands.rs` |

Tests: 50 new frontend (12 pure, 24 editor DOM, 14 panel DOM) + 3 new
Rust. `pnpm test` 3316 pass, `cargo test -p cannet-gui` 1122 pass.

**A phase-1 wire defect, found and fixed**

`MathSignalRecord` flattened the definition (which has its own
`operands`) beside a field *also* called `operands`, so both serialised
under one key and a JSON reader kept only the last — the resolved list.
The editor could therefore never prefill a stored pattern.

- *Observation*: `serde_json::to_value(record)["operands"]` is the
  resolved array, not the definition's `{picks, patterns}` object.
- *Experiment*: a throwaway test serialising a record whose definition
  carried both a pick and a pattern, printing the key.
- *Conclusion*: the resolved field is now `resolvedOperands`, pinned by
  `a_listing_carries_the_stored_selection_and_its_resolution_apart`. A
  second test pins the parameter names, which are **snake_case**
  (`window_seconds`, `tau_seconds`): the enum renames its variants, not
  their fields.

**The day's rulings, and what each cost**

- *No two-stage view*: there is no read-only detail. Expanding a math
  row **is** opening its editor, so the row's disclosure is the only
  way in and `dbc-row-details` never renders for one.
- *No buttons; commit on blur*: the editor holds **no draft**. Text
  fields are the shared `ValidatedInput` (ADR 0027 — blur or Enter
  applies, Escape abandons), a combobox commits on the pick, an operand
  on the drop or the ✕. That is what let the draft state the first cut
  kept in the panel disappear: the editor can now be unmounted and
  remounted freely, which a virtualized row does whenever it scrolls.
- *Undo*: each commit records one `PanelEditStep` whose inverse is the
  definition as it stood, on the existing panel-edit stack — so Mod+Z
  reverses a math edit exactly as it reverses a decoder pick. Three new
  ops (`mathDefine` / `mathUpdate` / `mathDelete`), each mirroring one
  command's args, dispatched by `App.tsx` like the rest.
- *Creation materializes immediately*: the menu writes a blank
  definition and expands its row. The registry therefore **stores
  unfinished definitions** — `define`/`update` no longer run
  `validate()`, and only a duplicate id and a cycle are still refused.
  `MathDefinition::validate` is now purely the listing's `invalid`
  reason, and it gained `Unnamed`: with no Save to press, "the name is
  required" can only mean "invalid until named".
- *An unknown math operand stopped being an error.* It was refused at
  define time, which after this ruling would have made a dependent of a
  deleted definition uneditable — the one state the user most needs to
  repair. `check_graph` now walks past it (`walk` already did) and the
  listing shows the operand as missing.
- *Sections stack full width*; the percentile field is **not rendered**
  unless the statistic is one.

**Judgment calls**

- **The editor refuses nothing.** Every per-section message ("pick
  one", "needs ≥ 2", "bad regex") is guidance in a section header; the
  host's prose is what appears when a write is refused, and its
  `invalid` is what the row and the editor's own line show. A set of one
  stays legal, as phase 1 ruled.
- **A pair's first pick lands in A** whichever slot it was made in: the
  picks are an ordered list with no room for a hole.
- **Math rows are not drag sources yet.** `DraggableSignalRef` has no
  math provenance slot, so a drag would name a DBC-backed signal that
  does not exist. Phase 3 adds the flag and the row becomes a source
  like any other.

**Deviations from the phase brief**

- **Rust was touched**, as ruling 7 requires (registry, validity,
  commands) plus the phase-1 wire fix. Both Rust lanes were run.
- **`docs/CONTEXT.md`'s math entry gained the unfinished-definition
  rule** — the code comments cite the glossary for the term, and this is
  now part of what the term means.
- **No README yet**: the surface is complete only when phase 3 mounts
  math signals in the plot and signal views.

### 2026-09-06 — phase 3 of 3, surfaces + MDF + perf (`task135-surfaces`)

Exit criteria 5, 7 and 8 met, and 4's remaining "signal panels and the
plot side list". The task-final full CI matrix ran on this branch.

**What landed**

| Area | Where |
|---|---|
| Math provenance on the drag payload; the Database row becomes a source | `dragSignals.ts`, `DatabasePanel.tsx` |
| Contributing buses, transitively, on the listing | `math_signals.rs` (`ResolvedMath::bus_ids`), `math_commands.rs`, `types.ts` |
| `mathBusLabel` / `MATH_MESSAGE_LABEL` | `mathSignals.ts` |
| One shared listing for all three surfaces | `mathSignalsContext.tsx` (new), mounted in `App.tsx`; `DatabasePanel` moved onto it |
| Plot side-list math rows: disclosure, chips, in-place editor | `PlotArea.tsx`, `index.css` |
| `math` plumbed onto the sample / extent queries | `useDecimatedRange.ts`, `PlotArea.tsx`, `plotPanelConfig.ts` |
| Signal-view math rows: host row synthesis + variable-height expansion | `signal_snapshot.rs` (`select_math`, `selected_math_ids`, `row_identity`), `trace_query.rs`, `ipc.rs`, `SignalsPanel.tsx` |
| Latest-sample and whole-series reads that *drive* the fill | `signal_cache.rs` (`math_latest`, `math_series`) |
| Constants draw solid | `signal_cache.rs` (`MathFill::constant`), ADR 0026 amended |
| MDF carries math as a `Computed` channel group; BLF names what it drops | `capture.rs`, `crates/cannet-mdf/examples/export_sample.rs` |
| The harness's math case + `--math-on-start` | `perfMathCase.ts` (new), `diag.rs`, `App.tsx` |
| README's math-signals section and the new flag | `README.md` |

Tests: 30 new frontend (10 pure math-case, 6 signals-panel DOM, 6 plot
DOM, 4 drag, 4 bus-label) + 11 new Rust. `pnpm test` 3374 pass,
`cargo test --workspace` 1913 pass.

- **2026-09-08 — amended in place: math signals never appear in View
  signals** (owner defect ruling). *Observation*: the View signals panel
  listed math series, named by their definition's stable id and flagged
  over a unit it could not place. *Cause*: this phase is where math picks
  first reached a plot area's `signals` and a signal view's
  `selection.keys`, and `plotViewSignalRefs` / `signalsViewSignalRefs`
  (`viewSignalsPush.ts`) pushed both unfiltered. *Fix*: both builders
  drop math-provenance picks. That panel is a database-mapping repair
  surface and no database bears on a math series — its unit is its
  definition's business, settled in its own editor — so the view-local
  push simply does not track one. Filtered **frontend-side**: provenance
  rides on every persisted pick (`SignalRef.math`,
  `DraggableSignalRef.math`), so no wire flag was needed and
  `ViewSignalRef` / `signal_identity` are untouched; a *pattern* cannot
  reach a math signal either, since `list_signals` lists none. Two tests
  written first, one per builder, both red on the old code (each pushed
  the definition id as a ref). Suite and `pnpm build` green on the branch
  and at the stack tip.

**The gap that had to close first**

- *Observation*: `PlotArea`'s two host queries (`sample_signals` and the
  `signal_min_max` sidecar) built their `SignalQuery`s without the
  `math` flag, though the comment beside one already said provenance
  rides along.
- *Hypothesis*: a math series dropped on a plot would be keyed
  `*|s:0:<id>` host-side and serve empty — nothing would draw, whatever
  the row showed.
- *Experiment*: the fake host in `PlotPanel.dom.test.tsx` now answers a
  math query with no samples unless it carries the flag, exactly as it
  already did for file-backed ones. The new test drew zero points.
- *Conclusion*: the flag is carried on both queries (and through
  `DecimatedSignal`). The test asserts the payload **and** that three
  points reach the canvas, so a future caller that drops it fails on
  what the user sees rather than only on the request.

**Design decisions worth carrying forward**

- **One listing, three surfaces.** `MathSignalsProvider` fetches
  `list_math_signals` once and shares it; the Database panel moved off
  its own poller onto it. Three independent pollers would have shown
  three different answers on the tick a database loads, because the
  resolved half of a listing moves with the catalog.
- **A signal view's math rows are host rows.** `select_math` is
  `select_file_backed`'s shape one provenance further: only a *manual*
  key selects one (a math series has no canonical path for a pattern to
  match), and a bus-wired view takes none. Their values come from
  `math_latest`, which runs `slice_many`'s prologue — a math pyramid is
  session-scoped, so a row has to *drive* the fill rather than read what
  happens to be there. The fill is incremental with a watermark, so a
  poll tick pays for the tail alone.
- **The row pitch went variable, using the machinery that was there.**
  `useTraceViewport` already takes `VariableRowHeights`, and
  `expandedExtraHeightOf` / `tailAnchorRow` are the by-id table's
  precedent — so an expanded math row grows its own row and the ones
  below stack past it, with the host paging untouched. The expansion
  height is held beside the id, because a row scrolled off the loaded
  page can no longer be asked how tall it is.
- **Constants are suppressed in the model, not the renderer.** ADR
  0026's rule 1 would dash both wings of an `hline` / `statistic` — a
  horizontal line held past its own two samples. `MathFill::constant`
  makes `extrapolated_spans` answer empty for those two functions, so
  the renderer still styles what it is told and re-derives nothing.
  Falsified before it was believed: with the guard disabled the new
  test fails on `hline`.
- **MDF writes the series, not the definition.** A math channel goes
  through the same `add_signal` a file-backed one does, under a
  `Computed` acquisition group. There is nowhere in MDF to say "the
  median of these six signals" that a reader would understand, so the
  project file keeps the definition. BLF's drop warning now names math
  signals beside file-backed ones — a user asking for BLF needs the
  whole of what is being left behind.
- **The perf case is a launch flag, and it mounts itself.** Growing
  `examples/ev-zonal` would invalidate every reading ever taken against
  it, so `--math-on-start` defines the case over whatever project the
  launch opened. Defining costs nothing on its own — a math pyramid is
  built by a *serve* — so the flag also writes the series into the open
  plot areas and signal views through the ordinary element-config path,
  which is what a person measuring would do by dragging them there.
  Nothing reaches the project file; the harness never saves.

**Perf readings — unjudged, no gating, no baseline touched**

Build `f97ce5b5`, ev-zonal, 60 s, `--perf-interact scrub`; 174 ids
measured and 266 gestures performed in every run.

| run | rx | tx | lag mean / max | longtask | renderer max | host max | tree max | flush mean/max | tx-late mean/max | gap p95 / short |
|---|---|---|---|---|---|---|---|---|---|---|
| `task135p3` | 1567.4 | 1623.4 | +0.002 / 3.5 | 0 | 321 | 62 | 735 | 2.88 / 8.76 | 4.57 / 45.04 | 3.13 / 0.209 |
| `task135p3-run2` | 1607.2 | 1610.5 | +0.020 / 5.4 | 0 | 316 | 62 | 727 | 2.95 / 7.31 | 3.29 / 5.75 | 1.18 / 0.0005 |
| `task135p3-math` | 1608.6 | 1614.1 | +0.012 / 1.3 | 0 | 329 | 70 | 755 | 3.39 / 9.51 | 3.38 / 10.24 | 1.17 / 0.0007 |

The first plain run is an outlier and is reported as one: it was taken
minutes after a release build, and its `rx_gap` (3.13 / 0.209) and
`tx_late_ms.max` (45.04 ms) are the shape of a busy machine rather than
of this diff — `run2`, same binary, reads 1607 / 1.18 / 5.75. ADR 0031's
procedure says a single-run breach with the rest clean is re-run, not
ruled on, so `run2` is the plain comparand.

Against it, the math case costs: host +6.5 MB mean, renderer tree
+18 MB peak, JS heap +8 MB mean, `flush_ms` mean 2.95 → 3.39, with rx
and the timing family unmoved. That is the whole reading; reading the
*series* across builds is the overseer's.

**Deviations from the phase brief**

- **The plot side list's disclosure leads the row** rather than sitting
  beside the ✕ under a gap, as the prototype has it. The ruling is
  "clear separation between expand and remove", and putting the value
  readout physically between them is a stronger reading than a CSS gap
  — and it matches the Database tree row, where the disclosure also
  leads. Queued for the owner.
- **`--math-on-start` mounts the case into the open views**, which the
  brief did not ask for. Without it the flag defines four definitions
  that nothing ever serves, and the "math case" would have measured
  nothing — the failure mode ADR 0031 is most explicit about.
- **A math row's rate column is blank** in a signal view (its cadence is
  its operands'), and its bus chips ride in the *message* column,
  because the bus column is hidden by default. Both queued.
- **Three files needed line-ending repair** before each commit — the
  CRLF trap the brief warned about, caught by `git show --stat` each
  time and normalized back to the committed blob's endings.

## Blockers / side effects

- **Bus names reach the host only through a math command.** A pattern
  is evaluated against the canonical path (ADR 0038), whose first
  segment is the bus *name*, and the host has no standing record of
  what a project's buses are called — `fetch_signal_page` and
  `list_view_signals` are handed the map per call. The math commands
  do the same and *latch* it on `AppState` for the serves that have no
  caller to ask. Consequence phase 2 must respect: **every math
  command must pass `busNames`**, and until one has, a pattern anchored
  on a bus name matches nothing (the bus id is the subject instead).
  If that proves fragile, the fix is a standing project-bus map on
  `AppState` rather than a per-call argument — worth raising with the
  owner rather than deciding inside a phase.
- **`statistic` recomputes over the operand's whole level-0** each time
  the operand grows — `select_nth_unstable`, so linear, but linear in
  the capture on every serve of a live capture. Fine for a stopped
  capture (one pass) and for the phase's targets; phase 3's perf case
  should include a `statistic` definition so the cost is measured
  rather than assumed.
- **A deleted definition leaves dangling operand references** by
  design: dependents keep the reference, serve empty, and show the
  operand as missing. Phase 2's editor needs to render that state.

- **Phase 2 left three surfaces to phase 3**, all mounting the same
  `MathSignalEditor`: a plot side-list row, a signal-panel row, and the
  chips / "Math - Multiple Busses" label. The component takes
  `{record, definitions}` and needs `ProjectContext`,
  `SignalCatalogContext` and (for undo) `PanelEditRecorderContext`
  above it; `mathEditorLines(record)` gives a virtualizer a height for
  its block.
- **The owner's ruling 5 (disclosure away from the delete) is only
  half-satisfiable here**: the Database row leads with the disclosure
  and ends with the two-stage delete. A plot side-list row already has
  a ✕ of its own at that end, so phase 3 has to place the math
  disclosure without pairing the two.
- **An undone deletion reappears at the end of the Computed listing**,
  not in its old place: `define_math_signal` appends. Restoring the
  position would need an insert-at command; flagged rather than
  invented.

## Exit criteria verdicts (orchestrator walk, 2026-09-06)

1. **Met** (135-1): all 16 functions as the fourth provenance; pyramids/serve/min-max/completeness inherited; expfilter on level 0.
2. **Met in-session, with an owner-flagged deviation cross-session** (135-1): compositional fingerprints and cycle refusal landed;
   pyramids are session-scoped (not persisted, not parked) — owner: "almost certainly not ok, at least long term"; interim
   tolerated, review queued with the measured cost (§ 3 of the review queue).
3. **Met** (135-1/2): project-file persistence by stable id; membership = picks ∪ live regex; unfinished definitions stored as
   invalid (owner ruling 7).
4. **Met, as amended by the eight 2026-09-06 editor rulings** (135-2): single-stage in-place editor, buttonless, blur commits,
   undo/redo via the element edit history, two-stage delete in the Database view, sections stacked, percentile hidden,
   standard disclosure control.
5. **Met** (135-3): drag sources everywhere, per-bus chips + "Math - Multiple Busses", statistic as capture-constant hline,
   hline solid (ADR 0026 amended), MDF export carries the Computed group (oracle extended), BLF none. Minor queued residue:
   disclosure placement vs prototype, blank rate column, chips ride the message column.
6. **Met** (135-1): `wide` benchmarked and rejected (memory-bound reductions), recorded in technology-inventory with a revisit
   trigger.
7. **Met** (135-3): `--math-on-start` harness case (set-over-pattern, expfilter, statistic + mounting); plain vs math readings
   on one build — host +6.5 MB mean, flush_ms mean 2.95 → 3.39, timing family unmoved.
8. **Met** (135-1/2/3): README math section, rustdoc, CONTEXT.md terms.

Awaiting owner acceptance; the criterion-2 deviation is the one open ruling.
