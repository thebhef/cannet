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

- **Set functions stay pointwise** (time-varying: `max(Cell\d+)` is the cell-max curve).
- **New function `statistic`** (renamed from `stats`, owner 2026-09-06 — singular; it yields one statistic): ONE signal + a
  selected statistic (min / max / mean / median / common percentile) → a capture-constant value drawn as an hline.
- **New function `rms`**: single operand, ~~over a trailing window (like duty cycle / frequency)~~ **superseded 2026-09-06:
  instantaneous** — pointwise √(x²) (= |x|), no window parameter; smoothing is user-composed (e.g. an expfilter downstream).
  *Note for implementation:* expfilter∘rms yields a rectified average, not true windowed RMS — that would need square/sqrt
  primitives; flagged, owner accepted the instantaneous form.
- **MDF-only export confirmed** (owner hadn't used the existing MDF save; it exists — use it).

## Remaining work to close grooming

1. Prototype: rework the editor from floating panel to **in-place expansion** (no dialog, ruling above). ~~Add `stats` and `rms`
   gallery cards~~ **done 2026-09-06**: statistic = signal + Statistic select (min/max/mean/median/percentile, Percentile field
   enabled only for `percentile`); rms = signal only, no parameters (instantaneous ruling above) — awaiting owner confirmation.
2. Then: write exit criteria, slice phases (draft: registry+compute engine / creation+editor / surfaces+perf case).

## Exit criteria

To be set as grooming completes.
