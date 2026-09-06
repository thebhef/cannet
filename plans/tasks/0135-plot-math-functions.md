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

## Status log

### 2026-09-16 — a pair's operands are slots (`task135-editor`)

Owner-ordered on the 2026-09-16 queue walk ("should get fixed"): a pair
function's first pick landed in A even when the user picked into B.

**Observation.** `withPick(definition, 1, ref)` against a fresh
`difference` wrote `picks: [ref]`, and the editor then rendered that
operand in section A with B still asking for one. The frontend unit
test that stood there said so in as many words — *"lands a pair's first
pick in A whichever slot it was made in"*, with the reason: the picks
are an ordered list with no room for a hole.

**Hypothesis.** The hole is the whole defect. If a fixed-arity
function's picks are **slots** — each position one named operand,
`null` for one standing empty — end to end, then a pick into B is
stored at position 1 and read back at position 1, and nothing else
about the model has to move.

**Experiment 1 (red, at the wire).**
`a_pairs_empty_slot_survives_the_wire` deserialises
`{"picks":[null,{…}],"patterns":[]}` and asserts the operand is in slot
B. It did not compile: `expected MathOperandRef, found Option<_>`, and
`no method named filled` — the defect stated as a type fact, since a
`Vec<MathOperandRef>` cannot hold the state the user put the editor in.
Alongside it, `a_pair_with_an_empty_slot_is_not_usable_yet` (the hole
must still read as unfinished) and the DOM test `leaves a pick made
into B in B, with A still empty`, which drags a signal onto section B
of a blank pair and reads the write.

**Experiment 2 (falsification).** Three mutations against the new
tests, each run on its own:

| mutation | result |
|---|---|
| `withPick` back to "append when past the end" | the unit test and the DOM test fail; the rest pass |
| `withoutPick` always closes the list up | `keeps a pair's pick in the slot it was made in` fails on clearing A |
| `validate` counts `picks.len()` rather than filled slots | `a_pair_with_an_empty_slot_is_not_usable_yet` fails with `Ok(())` — a pair holding only B would be judged **usable** |

So all three halves of the fix — the padding on the way in, the hole
left on the way out, and "an empty slot is not an operand" — are
load-bearing and each is pinned by a test.

**Conclusion / what landed.** `MathOperands::picks` is
`Vec<Option<MathOperandRef>>`, with `MathOperands::filled()` as the one
way the model reads operands out of it — validation, resolution, the
cycle walk and the default-name rule all go through it, so an empty
slot contributes no operand, no unit and no membership, and a pair
holding only B fails the arity it always failed. Frontend-side,
`withPick` pads to the slot instead of appending, `withoutPick` empties
a fixed-arity slot (and closes a *set* up, where order is only the
order the user built it in), and `pickInSlot` is what a section
renders.

**Serde compat is the type's own.** An old file's dense
`[{…},{…}]` deserialises into `[Some, Some]` untouched, and a
definition whose slots fill from the front re-serialises to exactly
the JSON it always wrote — trailing empties are not stored, so `null`
appears only for the one state that could not be expressed before.
`a_pick_list_written_before_slots_still_fills_them_in_order` pins both
directions.

**Also on this branch:** the `busNames` residue the project-bus-map
entry below left for the frontend phases, for the call sites this
branch owns — `list_math_signals` / `define_math_signal` /
`update_math_signal` in `DatabasePanel.tsx` and `MathSignalEditor.tsx`,
the `mathDefine` / `mathUpdate` edit-history records and App's replay
of them. The `refreshMath` listener kept its bus trigger (a rename
moves what a pattern selects) as an effect dependency rather than an
argument. `mathSignalsContext.tsx` does not exist on this branch — its
`list_math_signals` call site belongs to `task135-surfaces`.

### 2026-09-16 — a standing project-bus map on `AppState` (`task135-engine`)

Owner-ordered on the 2026-09-16 queue walk, fixing the blocker phase 1
recorded: bus names reached the host only on a math command's payload.

**Observation.** `AppState` carried `math_bus_names`, written by
`math_commands::latch_bus_names` and by nothing else. A pattern is
evaluated against the canonical path (ADR 0038), whose first segment is
the bus *name*, so until the frontend had listed or written a math
signal the map was empty, every path in the catalog was built from the
bus *id*, and `^Powertrain/` selected nothing. A project whose
definitions are all pattern-defined therefore served empty series on
the first serve after an open.

**Hypothesis.** The map is project state, not command state: if the
host installs it wherever the project's bus list already arrives — the
open parse, and the frontend's push on every bus add / rename /
remove — a name-anchored pattern resolves with no math command having
run, and the per-call carry has nothing left to do.

**Experiment 1 (red).**
`a_name_anchored_math_pattern_matches_before_any_math_command` defines a
`^Powertrain/` set against a DBC on bus `b0` and installs the bus names
the way an open does, with no command called. It did not compile: no
seam existed to install them through (`no method named
set_project_bus_names`) — the defect stated as an API fact.

**Experiment 2 (falsification, after the fix).** Two mutations, each
run against the pair of bus-name tests: a setter that stores nothing
fails both; a setter that stores but does not drop the resolved model
fails `a_math_pattern_matches_the_canonical_path_with_the_projects_bus_name`
(which builds a model before the names land) and passes the new one. So
both halves of the setter are load-bearing and both are pinned.

**Conclusion / what landed.** `AppState::project_bus_names` (renamed
from `math_bus_names`) with `set_project_bus_names`, which stores and
drops the resolved math model when the pairs moved. Written from
`project::open_project` via `project::bus_name_pairs(&p.buses)`, cleared
by `close_project` alongside the definitions it belongs with, and
refreshed by `rbs_sync_project_buses` — the frontend's existing push on
every bus add / rename / remove, which now feeds both the RBS bus keys
and the math patterns.

The latch is **gone**, not kept beside it: `latch_bus_names` and the
`busNames` parameter of `list_math_signals`, `define_math_signal` and
`update_math_signal` are deleted, so there is one writer. Tauri reads
command arguments by key, so a caller still sending `busNames` is
simply not read — nothing breaks on the way through the stack, but the
frontend call sites added by the later phases have a key to drop.

### 2026-09-16 — a math row's rate, and where its chips live (`task135-surfaces`)

Owner-ordered on the 2026-09-16 queue walk, against two of phase 3's
own recorded deviations ("both seem like they should be
straightforward to resolve").

#### (a) The rate column

**Observation.** `signal_snapshot::select_math` set `rate: None` on
every math row it built, with the reason written beside it: "a math
series' cadence is its operands', which is not a fact about this
series". So the `msg/s` column was blank for every computed row in a
signal view, whatever the series actually did.

**Hypothesis.** The cadence being the operands' makes it a fact about
the *filled series*, not a reason there is no fact: the fold lays every
computed sample on the union of the operands' timelines, so the filled
pyramid has a real sample spacing — and `SignalCache::rate()` already
measures exactly that for every other provenance. If `math_latest`
reports it beside the newest sample, the column fills from the model
with nothing derived in JS (CLAUDE.md § thin views).

**Experiment 1 (red).**
`a_math_rows_rate_is_the_cadence_its_operands_gave_it` folds a `Sum`
over two operands carried by a 50-frame, 1 Hz capture and asserts the
row's rate is `Some(1.0)` — the operands' cadence — and, beside it,
that an `hline` reports `None`. It did not compile: `no field rate on
type (SamplePoint, usize)`, the defect stated as a type fact, since the
pair `math_latest` returned had no room for the answer.

**Experiment 2 (falsification).** Two mutations, each run on its own
against the pair of rate tests:

| mutation | result |
|---|---|
| report `cache.rate()` unconditionally | the `hline` half fails — a constant reads `0.02` Hz, which is `2/span`, not a cadence |
| keep `select_math`'s `rate: None` and only widen the tuple | `a_math_signal_is_a_row_of_a_signal_view` fails with `None` against `Some(9.5)` |

So both halves are load-bearing: the measurement and the
constant's exemption, and the pass-through into the row.

**Conclusion / what landed.** `SignalCacheStore::math_latest` returns
`MathLatest { newest, count, rate }` instead of a `(SamplePoint,
usize)` pair — the math analogue of `FileSignalEntry`, whose statistics
are read off the pyramid in the model for the same reason. `rate` is
`SignalCache::rate()` except for a **capture-constant** (`MathFill`'s
`constant`: an `hline`, a `statistic`), which is two points spanning
the capture and has no cadence to report. `select_math` passes it into
the row's `rate`, so the column reads through the same
`formatMsgRate` every other row's does and the frontend derives
nothing.

#### (b) Where the chips live

**Observation.** A math row's bus chips are rendered in the `msg` cell,
and the bus cell rendered `mathBusLabel` — the same string the message
cell already shows. The recorded reason for the placement was "because
the bus column is hidden by default".

**Hypothesis.** The placement is right and the *reason* is wrong, and
what made it look arbitrary is the duplicate label. Two independent
facts say the message cell is the home: it is this table's **provenance
cell** — the one that speaks when bus / ECU / message cannot, which is
why the file-backed badge is already in it — and it is the direct
analogue of a plot side list's message line, which renders these very
chips before this very label. Both of the owner's criteria (visible on
a default panel; consistent with the plot side list) are then met by
where they already are.

**Experiment (red).** `names the contributing buses in the bus cell,
and its rate in msg/s` opens the panel from a saved layout that shows
both default-hidden columns and asserts the bus cell reads
`Powertrain, Zonal` and holds no `Math`. It failed on the bus cell
(`Math - Multiple Busses`) and passed on `msg/s` — the frontend was
already rendering whatever the host served, which is the data that the
blank column was the host's doing and not the view's. The chips'
home is pinned in the same file by a cell-scoped assertion (`.col-msg`
holds the swatches), so a future move has to argue with a test.

**Conclusion / what landed.** The chips did not move. The bus cell now
names the buses feeding the row — what a bus column names — instead of
repeating the message-line label, and both cells carry the reason. The
plot side list is untouched.

#### Also on this branch

The `busNames` residue this branch owns, from the standing project-bus
map (entry above): `mathSignalsContext.tsx` no longer passes the map to
`list_math_signals`, no longer publishes `mathBusNames` (nothing on the
stack consumed it), and its module doc says what is now true. The
project's buses stay a refetch **dependency** — a rename moves what a
name-anchored pattern selects and `rbs_sync_project_buses` emits no
`math-signals-changed` — the same treatment `DatabasePanel` got on
`task135-editor`. The `--math-on-start` harness path in `App.tsx` was
carrying the key into `define_math_signal` too, and drops it; the
Database panel's DOM test that asserted the key is what now asserts the
call has no argument at all.
