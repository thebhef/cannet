# 0139 — Units and Scaling for Math Signals

> **Opened 2026-09-06** by owner instruction, immediately after the
> task-135 math engine landed. **Executes now, on the current stack**
> (owner ruling): branch `task139-units` on `task135-surfaces`, with
> `doc-closeout` restacked on top. Groomed 2026-09-06; all questions
> ruled.

The ask, in the owner's words:

- apply a scalar to the upstream signals in our math channels, and
  scalars on the outputs;
- a unit library would be really nice to use for this — being able to
  choose units, and load them from the DBC;
- unit is an arbitrary field in DBC, so users add customizations to a
  selectable list of units in a settings-view section; a sparse dict
  config persists whatever the user has changed.

## Grooming notes

**2026-09-06 (owner rulings):**

1. **Unit-aware resolve ("architecture B").** The definition stores
   intent, not numbers: a target unit on the definition means the host
   derives each member's conversion from its *own* DBC unit string —
   through the unit library plus the user's customization dict — fresh
   at resolve time. Pattern members with mixed units each get their
   own correct factor; a customization edit rescales every dependent
   channel (factors join the cache fingerprint, so caches rebuild).
   Rejected: storing computed scalars with the unit picker as a
   one-shot calculator — it cannot serve pattern operands and throws
   the intent away at edit time.
2. **Affordances for what the DBC doesn't map cleanly** (accepted
   2026-09-06): manual `{gain, offset}` on any operand and on the
   output (the unit-free path, composes with or replaces conversion);
   per-operand source-unit override ("treat this operand as mA")
   local to the channel; unconvertible members pass through unscaled
   and are *reported* by resolve, never silent; a unit outside the
   library's list means manual scalars (a define-custom-unit row is
   deliberately out of scope until it bites).
3. **Conversions are affine** (gain + offset) — covers °C↔K↔°F.
4. **No mapping dialog.** The customization UI is a **section in the
   settings view**: a selectable list of units provided by the unit
   library, to which the user adds customizations (DBC unit string →
   library unit). The settings model's existing `workspace` scope
   carries it, so the sparse dict persists with the project — it
   interprets that project's DBCs and travels with them. Built-in
   recognitions cover common strings ("V", "mV", "A", "degC", "°C",
   "rpm", "%", …); the dict stores only what the user changes.
5. **Unit library: `runtime_units`** (MIT, 0.6.x) — found and adopted
   2026-09-06 at owner instruction to use a library rather than an
   in-repo table; see `plans/technology-inventory.md` § Units /
   Quantities for the evaluation and the rejected candidates
   (rink-core's GPL data file, uom/dimensioned's compile-time types).
   Wrapped behind a host-side facade so the depended-on surface stays
   narrow.

**2026-09-06, evening bench (owner ruling — integration and time):**

6. **Convertibility accounts for the function's time dimension.** An
   integration of an `A` operand with unit `Ah` was badged
   unconvertible: resolve compared operand dimension (current) to
   target (charge) as if the function were pointwise. The operand is
   right as the DBC declares it — the *decision* is wrong: integration
   multiplies by time, so the question is whether `current x time`
   reaches the requested unit. Design: the facade learns the
   rate<->integral pairings (current x t = charge, canonical A*s =
   coulomb; power x t = energy, W*s = joule); for Integration a
   requested unit in the *integrated* dimension means no operand
   conversion where the operand already speaks the rate family — the
   output affine carries coulomb->Ah (/3600) and kin, via the library.
   A unit in the operand's own family keeps operand-target semantics
   (integrate in mA), so the owner's `A` workaround stays valid. With
   no unit set, integrating a recognised operand derives a *real*
   integrated unit (coulomb, joule) instead of the `*s` string —
   best-effort, per the owner; unrecognised operands keep the suffix.
   The badge then marks only true dead ends.

**Implementation notes (read 2026-09-06):**

- `MathDefinition.unit: Option<String>` already exists (display unit,
  derived when unset) — it becomes the conversion **target**: set and
  recognised ⇒ operands convert to it; unset or unrecognised ⇒
  today's behaviour, no conversion.
- `MathOperandRef` derives `Eq + Hash`; f64 fields would break both.
  Per-operand parameters ride a wrapper (`serde(flatten)` keeps old
  project files deserialising) rather than the ref itself.
- Fingerprints (`signal_fingerprint::math_encoding`) must mix each
  operand's effective `(gain, offset)` and the output pair, so a
  changed scalar or customization rebuilds the cache.
- Per-operand affine applies before the function (on the operand's
  samples), output affine after it; `MathFunction::Scale` remains as
  the chainable standalone.
- `runtime_units` distinguishes TemperatureInterval from
  ThermodynamicTemperature; DBC temperature readings map to the
  absolute kind by default.

## Phases

**Phase 1 — model, engine, conversion** (host). The `runtime_units`
dependency behind a `units` facade (unit list, dimension, affine
gain/offset between units, built-in DBC-string recognitions, the
workspace-scoped customization dict overlaying them); the operand
wrapper schema (manual gain/offset, source-unit override) and output
gain/offset; resolve-time per-member conversion with unconverted
members reported; fingerprint mixing; kernels applying operand affine
pre-function and output affine post-function. TDD throughout.

**Phase 2 — editor and settings section** (frontend). Operand and
output scalar/unit controls in the math editor, unconverted-member
flags, the settings-view units section (library-provided selectable
list + customization rows over the workspace-scoped dict). DOM tests.

**Phase 4 — integration units** — *landed 2026-09-07* (host; opened
from the evening bench, ruling 6). The rate<->integral pairing in the facade;
Integration-aware resolve (integrated-dimension target => output
affine, own-family target => operand semantics, else badge); derived
unit becomes the canonical integrated unit for recognised operands.
Amends `task139-units` (message updated). Tests: A->Ah (/3600),
mA->Ah, W->kWh, derived coulomb, own-family mA target, true-mismatch
badge.

**Phase 5 — composition, prefixes, recognition, derivation** (host).
The facade converts via the library's enumerated prefixed variants plus
`Quantity x Quantity` composition (dimensional analysis), with a
cross-check test against every pair the crate enumerates; unit identity
becomes typed base x prefix — the definition's target moves to the typed
form (strings stay at the ingest boundary only); recognition parses
`[prefix][base]` exact-case with customizations still winning;
`derived_unit` derives for every function — products compose,
integration/derivative compose with their time-unit field on
`MathFunction` (default `s`, old files unchanged), like-kind sets convert
and inherit — and the composed dims name the kind that locks the override
picker; the Derivative function (kernel + resolve, plain
consecutive-sample slope); the per-signal unit reinterpretation store,
served to every consumer; the user-scope mapping store (project wins on
conflict); resolve reports recognition state per operand; the
View-signals nAh flag investigation and fix.

**Phase 6 — selection UI and the settings rework** (frontend; after the
prototype gate). The base + prefix picker replaces the flat unit list in
the math editor; integration/derivative get the function-row time-unit
choice, their unit pickers offering the resulting composition or a named
unit of the dimension, kind-locked to that dimension; the function
select gains Derivative; the operand's "from DBC" chip shows parse state
at edit time; the View-signals reinterpretation picker on the
resolved-unit chip; the plot's per-unit readout chip converts a series'
display unit (persisted per-series in plot config); the settings units
section is rebuilt to the accepted prototype as ruled — the library's
full base-unit list plus config-added units, matched-string rows, and
project/user scope checkboxes on every row.

## Exit criteria

- [x] A set function over a pattern whose members carry mixed units
      (mA next to A) computes in the definition's target unit, each
      member converted by its own factor; changing a customization
      rescales the channel on the next serve.
- [x] Manual gain/offset works on operands and output with no units
      anywhere; source-unit override converts a mislabelled operand.
- [x] Unconvertible members pass through unscaled and the editor
      shows which; nothing converts silently wrong.
- [x] °C/°F/K convert correctly (affine, absolute temperature).
- [x] Old project files load unchanged; a definition saved with the
      new fields round-trips.
- [x] The settings-view units section lists the library's units and
      persists only the user's customizations, with the project.
- [x] The signal-mapping panel flags every signal whose DBC unit
      string the project cannot place (blank never flagged), names the
      string, points at Settings → Units, and offers a filter to those
      rows; adding the customization clears the flag with no reopen.
- [x] Technology inventory records the dependency decision; docs
      match shipped behaviour.
- [x] An integration reaches a target its operand only reaches through
      time: `A`→`Ah` and `mA`→`Ah`, `W`→`kWh`. A target in the
      operand's own family (`mA` on an `A` operand) still converts the
      operand; a target in neither dimension is still badged; with no
      target, a recognised rate derives its integral's unit.

- [x] Unit identity is base x SI prefix: `nAh` recognises and converts
      to `Ah` through composition; the composed-factor cross-check test
      passes against every pair the crate enumerates.
- [x] Every math function derives an output unit: a product of `A` and
      `s` ships as `A·s`; integration and derivative follow their
      function-row time unit (`operand · h` derives `Ah`); a like-kind
      mixed set converts and inherits; an additive set mixing dimensions
      derives nothing and is badged.
- [x] Derivative works end to end (host half): d/dt of an `Ah` counter
      over `d/ds` reads `Ah/s` and converts to `A` on request.
- [x] A signal's unit reinterpreted in View signals reads as the chosen
      unit everywhere, with no scaling applied.
- [x] A mapping promoted to user scope is effective in another project,
      and project wins where both scopes map one string.
- [x] The owner's `nAh` View-signals flag case is explained and fixed.
- [x] Unit pickers in applied contexts are kind-locked — for
      integration/derivative to the composed dimension, offering the
      composition plus named units only; View signals reassigns
      arbitrarily with no scaling.
- [x] The plot's per-unit lanes converge through the readout-chip
      conversion (an mV series joins the V lane at ÷1000).
- [x] The settings units section lists the library's full base-unit
      set plus config-added units, one row per unit with its matched
      strings and project/user scope checkboxes; promoting a mapping
      to user scope makes it effective in another project, and
      project wins where both scopes map one string.
- [x] Derivative is usable end to end from the UI.

## Status log

**2026-09-10 — the percent scale is settled by the spelling** (owner
ruling 2026-09-09, `plans/owner-review-queue.md` § 2). Folded into
`task139-units`, the branch that introduces the recognition table.

- **`%` already read as the 0–100 percent unit** before this change,
  twice over: it is the `percent` entry's `display`, and it is a
  built-in row of `RECOGNITIONS` (`("%", "percent")`), pinned by
  `the_common_dbc_spellings_are_recognised`. No change was needed
  there, and the new test asserts it so it stays true.
- **`%1.0` is new**, added as a built-in spelling of `ratio`, the bare
  0–1 scale. One row in the same table: the observed range of a
  number is data, not a declaration, so the string is the only thing
  that can say which scale a proportion is on — which is why range
  inference and a `BA_` attribute were both dropped.
- **Precedence needed no work.** `recognize` consults the
  customization dict before the built-in table, so both spellings are
  defaults a project or user remaps like any other
  (`a_customization_remaps_either_percent_spelling` passed before the
  table row was added, which is the point).
- **The settings table is derived, not enumerated.** `mappings` (which
  lands later in the stack, on `task139-apply`) builds every row's
  spellings from `RECOGNITIONS` through `recognize` itself, and
  `the_mapping_table_puts_each_string_on_the_row_it_recognises_to`
  pins that derivation — so a new built-in row appears on its unit's
  row as `BuiltIn` by construction, with no second list to keep in
  step.
- **Composed units are unaffected.** `units-composition` has
  `recognize` fall through to custom *definitions* only after the
  built-in table, and the customization dict still precedes both, so
  the ordering the ruling asks for holds above and below that branch.
- Tests: `the_two_percent_spellings_read_at_the_scales_they_name` and
  `a_customization_remaps_either_percent_spelling` (units), and
  `a_database_declaring_the_ratio_percent_spelling_reads_at_the_bare_scale`
  (math_signals — a database string of `%1.0` reaching a `%` target
  ×100, and the reverse ×0.01). All three red first; the first two
  failed only on the `%1.0` assertions, confirming `%` was already
  right.

> Phase 4 was absorbed into `task139-units` after the later phases
> had already landed above it in the stack, so its entry leads this
> log rather than closing it.

**2026-09-07 — owner defect: a ratio target converted nothing.**
Reported from the bench: signals read on the bare 0–1 scale were
collected by a pattern filter, and the math editor served the *same*
value whether the target was left derived, set to the bare scale
explicitly, to `%`, or to `ppm` — where `%` should be ×100 and `ppm`
×10⁶. Investigated by falsifying one hypothesis at a time; the record
is below because the answer was not where it looked.

- **Observation.** Four target choices, one served value.
- **H1 — the facade returns the identity inside the ratio family.**
  *Falsified.* `convert` gives `ratio`→`%` ×100, `ratio`→`ppm` ×10⁶,
  `%`→`ppm` ×10⁴, each the plain power of ten
  (`the_ratio_family_converts_by_its_powers_of_ten`, which passed
  against the unfixed table).
- **H2 — the three spellings recognise to one unit.** *Falsified.*
  `percent`, `part-per-million` and `ratio` are three ids with three
  multipliers.
- **H3 — resolve skips the conversion for this dimension.**
  *Falsified.* With operands whose unit string is `%` or `ppm`, a
  target in the family converts every member correctly.
- **H4 — the operands' unit strings do not recognise, so no
  conversion is possible.** *Confirmed, and the cause is ours.* The
  bare scale's **display string was `ratio 0–1`**, which
  `recognize` cannot place. Every surface that reports a signal's
  unit hands on a string (a database's own, or the one a reinterpreted
  unit renders as), and resolve reads that string back — so a signal
  read on the bare scale arrived carrying a unit nothing could place.
  Derivation then yielded nothing, no member converted, and each of
  the four targets served the operands' own numbers.
- **The fix, in one place.** The bare scale reads as `ratio` — which
  is also how a DBC spells it and what the recognition table already
  carried — so the string it renders is one recognition carries
  straight back. Both tests that pin it fail against `ratio 0–1` and
  pass after: the facade round trip
  (`every_ratio_scale_reads_as_a_string_that_recognises_back_to_it`)
  and the end-to-end resolve
  (`a_ratio_set_converts_to_the_scale_its_target_names` — a set
  collected on the bare scale serves ×100 for a `%` target and ×10⁶
  for `ppm`). This also settles the owner's separate dislike of the
  `ratio 0-1` display: the picker's ratio row now reads `ratio`.
- **One conversion path, confirmed.** There is exactly one:
  `units::convert` over the facade's multiplier table, reached by
  `math_signals::effective_affines`. Nothing else scales a member, so
  there is no duplicate to clean up. What *is* duplicated is the
  notion of "how a unit is spelled": `display_of` renders one-way,
  while the string a signal reports has to survive `recognize`. Two
  more units still fail that round trip — see Blockers.

**2026-09-07 — Phase 6 (selection UI and the settings rework), branch
`task139-apply`.** Landed: the base × prefix picker in place of the flat
unit list, the function-row time-unit choice with Derivative in the
creation menu, the operand chip's parse state, the View-signals
reinterpretation picker, the plot's display-unit conversion and lane
merge, and the settings units table with per-row scope checkboxes.

- **One picker, three callers, and the kind is what tells them apart.**
  `UnitPicker.tsx` is two columns over `units::list_unit_picker`, and
  `UnitButton.tsx` is the anchor every surface hangs it off. The caller
  passes a `kind` or `null`, and that single argument *is* the design
  ruling: `null` is the View-signals chip (reinterpretation — kinds may
  cross, no scaling), a dimension is the math target and the plot chip
  (conversion — like-kind only). Nothing about which units exist, how
  they group or how a `(base, prefix)` pair is spelled is decided in JS;
  `list_unit_picker` serves the whole model including the composed
  display (`nAh`), because composing a spelling is the facade's table to
  read.
- **The ratio family is one row, host-side.** `percent`,
  `part-per-million` and `ratio` are three base entries, but a picker
  showing three rows would be showing one quantity three times. The
  collapse happens in `list_unit_picker` rather than in the view, so the
  rule ("a proportion takes a scale choice, not an SI ladder") lives with
  the units.
- **Clearing an override needed no affordance, and got none.** The
  ruling forbids a reset button and says clearing is picking the
  composition again. That only works if the composition is *in* the
  picker, so: `ResolvedMath` now carries `composed` (the `UnitId` the
  derivation **is**, where the table names one) and the editor maps a
  pick equal to it onto `unit: null`. A composition nothing names
  (`Ah/s`) has no such row to reuse, so `pickerEntries` synthesises one
  whose single rung commits nothing — and *only* then, so a named
  composition is never listed twice. A set whose members mix dimensions
  derives nothing at all, and there `clearable` (the caller saying an
  override is in force) grows the same kind of row, so no override is
  ever unclearable.
- **The derivation is hover text, not a note.** `Composed::display`
  contracts `A · h` to `Ah`, which is right on a button and useless in
  saying where `Ah` came from. `Composed::factors` is the
  uncontracted spelling and is what `ResolvedMath::derived` carries;
  `target_conversion` beside it is the unit conversion **alone**, without
  the user's output gain, because that is what the explanation is about.
  Both land in the Units button's `title`: the button reads the unit it
  resolves to and nothing else.
- **Two host arrays, one indexing rule, twice.** Phase 2 recorded that
  `unconverted` indexes the *host's* resolution order; `recognition` is
  index-parallel with the same array, so the operand chip is keyed by
  `operandRefKey` exactly as the unconverted flag is. A test pins it with
  the fixture's resolved order deliberately reversed against the row
  order — indexing the rows would pass every other way of writing that
  test.
- **The plot's conversion is one host question, asked once per series
  set.** `resolve_display_units` answers what a declared string means,
  the family a kind-locked picker offers, the spelling the result reads
  as, and the affine — so the frontend applies a factor and derives
  none. It is applied at exactly two points in `PlotArea`: the paged
  series (`convertSeries`) and the host's all-time extent
  (`convertExtent`), because the axis scales to the values it draws. A
  series nobody converted passes the very same arrays through.
- **A render-count test caught a real churn bug.** *Observation*:
  `reordering rows inside one area re-renders only that area` failed at
  3 renders against a limit of 2. *Hypothesis*: the display-unit memo key
  was order-dependent, so a reorder re-asked the host, and the fresh
  answer map re-rendered every area. *Experiment*: sorted the key's
  entries and re-ran. *Data*: back to 2. *Conclusion*: the key is a set
  of `(series, declared, chosen)` triples and must be spelled as one —
  now `.sort()`ed, with the reasoning in `displayUnitsKey`'s doc.
- **The lane merge is a resolver, not a rewritten ref.**
  `deriveAxesForArea` and `retainedAxisIds` take a `unitOf` (defaulting
  to the declared string) rather than the panel swapping `unit` on the
  `SignalRef`s it hands down — those refs are also what a hidden or
  recolored pattern row materialises from, so a display spelling written
  into one would have been persisted as the recorded unit.
- **The settings table is two scopes and one editor.** The ruling puts
  project/user checkboxes on every row, so `unit_customizations_user`
  cannot also have a row of its own — that would be the second editor
  `EDITED_ELSEWHERE` exists to forbid, and it moved there. The rows
  themselves are `units::mappings`, which places every string through
  `recognize` and so cannot disagree with the app; a string both scopes
  map appears once, on the project's reading. Promoting is a **copy**,
  not a move: the project's own reading of its databases stays in force,
  and the host's join settles the overlap.
- **The Phase 5 seam is gone, and so is the free-text target.** The
  editor commits `UnitTarget::Typed`; `unitTargetSpelling` (which
  rendered a typed target for a picker that could only hold strings)
  went with the combobox it fed, and the free-text box that briefly
  replaced it went too, with the `unitTargetLabel` that read it — the
  library is the only way to name a unit (owner ruling, reversing the
  keep decision). `UnitTarget::Spelling`
  and the untagged union stay host-side — an old project file's string
  still loads, still resolves and still displays; there is simply no
  affordance to type a new one, and picking from the library replaces
  it.
- **One deviation, small.** The View-signals resolved unit is a
  **column**, not a badge beside the signal name: the chip has to be
  clickable and wide enough to read, and `columnsFromParamsFor` inserts a
  new column into a saved layout without resetting it.
- **2026-09-07 — four fixes from the owner's bench test of the math
  editor**, each with its test written first and watched fail. *Units
  could not be cleared*: the host-side veto is fixed on
  `task139-derive` (a pattern one of whose members has a blank unit
  derives again), and the frontend half is the `clearable` row above —
  a set that derives nothing now still offers a way back to derived.
  *The free-text unit box is gone*: the ruling that kept it is
  reversed, and a stored spelling still displays. *The dim-note read as
  arithmetic nobody asked for* ("the units and a·s → ah box is
  mental"): the button says the unit it resolves to and the derivation
  and its factor moved into its `title`. *A pattern's matches drowned
  the section*: each pattern folds to one `DisclosureToggle` row
  reading the pattern and its count (`Cell.* (24 matches)`), opening to
  the members; picks stay listed, and which folds are open is
  view-local.

- **Perf (ADR 0031), six render-tier captures** —
  `docs/performance-measurements/frontend/2026-09-07-8bce0245-run{1..6}.json`,
  `ev-zonal`, `--perf-capture-secs 60 --perf-interact scrub`. Load real
  on every one: `rx_fps` 1604–1621 (baseline 1602), `rx_gap.ids_measured`
  174, `interact.performed` 266 with nothing missing. Memory is flat
  against baseline — renderer peak 316–326 MB (316.5), tree 746–758 MB
  (741.7), jsheap 87–94 MB (83.6) — and every drift median is *below*
  baseline (jsheap 5.97 vs 8.95, renderer 40.8 vs 45.8, tree 71.8 vs
  74.8). `longtask_ms_per_s` p95 0 throughout.

  `cannet-perf-measurement check` nonetheless reports **FAILED on
  `tx_late_ms_max`** and on nothing else. *Observation*: across six
  captures of **one unchanged build** that metric reads 85.3, 12.0, 81.9,
  28.3, 9.5, 72.5 ms against a 55.7 ms limit — three over, three under,
  a 9× spread. *Hypothesis*: it is the spike-class tail its own doc
  describes ("a generous floor keeps one-off OS writeback noise from
  flapping what the mean rows were deliberately designed not to gate"),
  not a regression. *Experiment*: the first three runs were taken, the
  gate failed, and three more were taken on the identical binary with
  nothing else changed. *Data*: the spread above; the systematic-stall
  rows the mean gate exists for stay clean on every run
  (`tx_late_ms_mean` 5.05–8.92 against an 18 ms ceiling, `flush_ms_mean`
  4.28–4.45 against 25 ms, `flush_ms_max` 11.8–18.4 against 64.5).
  *Conclusion*: not reproducible, and not reachable from this diff —
  `tx_late_ms` is the transmit scheduler's wake lateness and nothing here
  touches the scheduler, the flush path or the append lock. Recorded
  rather than acted on; the series across builds is the overseer's to
  read. `lag_ms_max` bounces the same way (4.1–47.8 ms, median 19.05
  against a 40.8 limit) and its median passes.

- **2026-09-08 — the plot's display-unit chip is handed the unit, not
  the spelling** (owner ruling: units are consumed from a lossless and
  unambiguous representation, never re-parsed). `resolve_display_units`
  answered what a *declared string* means, and the string the panel sent
  was `SignalRef.unit` — which for a reinterpreted signal is the
  rendering of a unit the project had already placed. For the two units
  whose spelling recognition refuses (`C`, `Nmm`) that lost the choice
  outright: no source, no kind, so the chip had no picker and the series
  converted nothing. *Fix*: `DisplayUnitQuery` carries a `source` — the
  unit the model placed — which `display_units` uses outright,
  recognising `declared` only when a caller has none (still ingest).
  `SignalDescriptorRecord` and `MathSignalRecord` gained the typed half
  of the unit they already reported (`unit_typed`), so the panel has one
  to give: `plotDisplayUnits::seriesUnitSources` keys the catalog and
  the math listing by `signalKey` and answers per series. `ResolvedMath`
  keeps the placed target it was already computing, which is what a math
  series' typed unit is (target, else the derivation's own unit).
  Nothing in the frontend reads a unit out of a spelling; the fetch key
  now covers the placed unit too, so reinterpreting a signal re-asks
  without the stored ref moving — which it never did.
  *Kept as it is, and audited*: `MathOperand::source_unit` still names a
  library unit by its stable **id**, resolved with an exact
  `units::typed` lookup and never through recognition — the same
  mechanism the customization dict's values use. It is not a spelling
  and not re-parsed. Its one limit is that an id cannot name a
  composition the table has no entry for (`nAh`), so the operand
  override list is narrower than the target picker's; changing that is a
  redesign of the operand row and an owner call.

Tests: host lib 1231 → 1244 passing (7 ignored, unchanged): 8 in `units`,
2 in `math_signals`, 1 in `view_signals`, 1 in `math_commands`, 1 in
`settings_descriptor`'s existing guards. Frontend 3388 → 3444 across 246
files (57 added, 11 replaced, 1 removed — the target-unit combobox's six
tests became the picker's, the settings section's rows-and-add tests
became the table's, and the free-text label's commit test went with the
box). The 2026-09-08 correction adds one host test (`units`, the placed
source) and four frontend ones (the fetch key over a placed unit, and
`seriesUnitSources` over a catalog signal, a missing one and a math
one), measured 1255 → 1256 and 3446 → 3450 on this branch. Every new
module's tests were written first and watched fail:
`unitSelection`, `UnitPicker`, `plotDisplayUnits`, and the two host
surfaces (which failed to compile, the pickers' fields not existing yet).
Two written-first tests failed on their first run for real reasons — the
picker ladder's unprefixed rung carried no exponent, and the mapping
table's `mA` row already existed from a built-in recognition — and both
findings are in the code and the test names.

**2026-09-07 — Phase 5 (composition, prefixes, recognition,
derivation), branch `task139-derive`.** Landed: base x prefix unit
identity with library composition, `[prefix][base]` recognition, a
derived output unit for every function, the time-unit parameter on
integration and the new Derivative, per-operand recognition state, the
per-signal unit reinterpretation store, and the user-scope mapping
store.

- **Composition is the library's, and it was there all along.** Phase
  1 recorded a gap — "no dimensional algebra" — and that was wrong:
  `UnitDefinition` implements `Mul` and `Div`, so base exponents add
  and multipliers multiply. `units::Composed` is built on it, and the
  hand-written rate/integral pairing table (`integral_of`,
  `RATE_INTEGRALS`) is **gone**: composition subsumes it and reaches
  further, since nothing had to name the millicoulomb for `mA · s` to
  be one. The real gap is the way *back* — nothing maps a computed base
  to a named unit — so `Composed::named` searches the facade's own
  base x prefix space for the entry whose definition matches.
  `plans/technology-inventory.md` is corrected in this commit, and a
  second gap recorded: the crate's compound entries stop at
  `microampere_hour`, so `nAh` is composed rather than read.
- **Where the enumerated variant is preferred, and why the cross-check
  exists.** `definition_of` takes the crate's own tabulated constant
  where it has one for a `(base, prefix)` pair and composes `base x 10ⁿ`
  otherwise — two answers for the same question, which is a second
  source of truth unless they agree.
  `every_prefixed_variant_the_crate_enumerates_matches_the_composed_factor`
  asks the crate for `<prefix symbol><base abbreviation>` across every
  base entry and every prefix and asserts the composed factor equals
  the enumerated one; it refuses to pass on fewer than 100 pairs, so a
  cross-check that stopped checking anything cannot go green. It
  currently covers several hundred.
- **A composition is *named* for conversion and *spelled* for display,
  and they differ.** `A · s` **is** a coulomb — that is what makes
  `A`→`Ah` reachable at ÷3600 — but it **reads** `A·s`, because a
  contraction is used only where the named unit spells what the factors
  spell (`A` + `h` = `Ah`, `nA` + `h` = `nAh`). This changes Phase 4's
  visible label: an integration with no target read `coulomb` and now
  reads `A·s`. The exit criterion asks for exactly that, and `C` is the
  spelling this module refuses to guess at in the first place. Nothing
  about the conversions moved; the kind is served separately, so a
  picker still offers the charge family.
- **Two families can share a base dimension**, so composition needs an
  order to resolve one: torque and energy are both kg·m²·s⁻², rpm and
  hertz both s⁻¹. `COMPOSITION_ORDER` states it — an engineer who
  multiplies a current by an hour means a charge, and nobody composing
  anything means revolutions.
- **The composed-output conversion replaced the integration special
  case**, and generalised it. Resolve tries the operands' own family
  first (Phase 4's ruling stands: `mA` on an `A` operand still
  integrates in milliamps), and only where *no* operand reached the
  target does it ask whether the **function's own composition** does.
  That one rule now serves integration, derivative and product alike.
  Consequence worth noting: for `mA`→`Ah` the whole factor moved onto
  the output (Phase 4 split it ÷1000 on the operand, ÷3600 on the
  output); the product is identical and the test now asserts the
  product rather than the split.
- **Derivation drives conversion when nothing else does.** A set whose
  members are like-kind now derives the first member's unit *and
  converts the others to it* with no target set — `1 A + 500 mA` was
  501 and is 1.5. That is the exit criterion, and it is the one change
  in this phase that alters numbers a project already computed.
  `signal_cache::a_target_unit_converts_each_member_before_the_function`
  had used the unconverted mixed set as its baseline and now uses
  units nothing can place.
- **`scalar` split from `ratio`.** The no-unit placeholder is its own
  kind, so a count never converts into a proportion; `count`, `counts`
  and `cnt` recognise to it, and `HLine` derives it.
- **The nAh investigation** — *observation*: the owner's `nAh` signal
  carried no unplaceable-unit badge in View signals.
  *Hypothesis*: the flag path works and something upstream of it drops
  the row. *Experiment*:
  `which_row_shapes_carry_the_unplaceable_unit_flag` builds the panel's
  rows for one unplaceable unit string in four reference shapes.
  *Data*: a manual pick flags; a pattern match (identity only, unit
  from the serving database) flags; a reference naming no bus has no
  unit to flag and does not; and a **file-backed** reference produces
  **no row at all** — `build_rows` skipped these outright.
  *Conclusion*: the suppression is the file-backed skip, and the
  justification it carried ("no DBC ever bore on it, so there is no
  mapping to repair") stopped being true the moment the panel grew a
  resolved-unit chip and a per-signal reinterpretation store: an
  imported channel's unit string needs placing exactly as much as a
  database's. *Fix*: a file-backed reference is a row, reading
  **Decoded** with no candidates and no diffs — so the attention count,
  which was the original reason for the skip, is unchanged — and its
  unit is flagged and reinterpretable like any other.
  `an_imported_channels_unplaceable_unit_is_flagged_and_reinterpretable`
  is the regression guard.
- **Reinterpretation has one application point.**
  `signal_units::unit_of` is the only place a signal's unit is decided,
  and the four surfaces that report one read it: the picker catalog
  (`list_signals`), the signal rows (`trace_query::snapshot_row`), the
  View-signals chip, and the math catalog — so a reinterpreted operand
  is what a math definition converts *from*. No scaling anywhere: the
  label was wrong, and correcting a label does not move a number. The
  drift comparisons deliberately stay on the database's declared
  string, since drift is a statement about the database.
- **The per-row cost of the store is zero when it is empty.**
  `unit_of_signal` composes the signal identity — a `format!` — only
  where there is something to look up, because the catalog and the
  signal-panel snapshot call it once per row per fetch and every
  project that has reinterpreted nothing would otherwise pay an
  allocation per row for a map that answers nothing.
- **Two scopes, one dict.** `unit_customizations_user` is the new
  user-scope map; `settings::unit_customizations()` joins it with the
  project's and is what every reader takes. Project wins on a shared
  key. The settings renderer is key-agnostic, so the second scope needed
  a descriptor and nothing else.
- **The compatibility seam Phase 6 removes.** `MathDefinition::unit` is
  now `UnitTarget` — `serde(untagged)`, so a JSON string is a spelling
  and an object is the typed form — and the editor still commits
  spellings, which the host recognises into the typed form at resolve.
  `unitTargetSpelling` renders a typed target from `unitResolved` so a
  picker that commits one cannot render `[object Object]`. Phase 6
  replaces the combobox with the base + prefix picker and commits
  `UnitId` directly.
- **2026-09-07 fix — an unplaced member vetoed the whole set's
  derivation.** *Observation* (owner, bench): "units from patterns seem
  like they may not be getting put into the units engine", and a
  pattern-fed `range` served no derived unit, so the editor's
  "(from the operands)" option had nothing behind it and could not
  clear an override. *Hypothesis*: patterns feed units fine, but
  `MathFunction::derived_unit`'s pointwise-inherit arm was written as
  `recognized.first()?.clone()?` plus `unit.as_ref()?` per member, so a
  **single** blank or unrecognized member — routine in a wide pattern
  match — returns `None` for the entire set. *Experiment*:
  `an_unplaced_member_does_not_veto_the_unit_its_set_inherits` resolves
  a `Range` over `Cell` with one unplaced member in each of the three
  positions, and asserts the same pattern-fed and hand-picked.
  *Data*: the unplaced-first case derived `""` where `"V"` was
  expected; the pattern/pick pair was never reached, and
  `operand_unit` proved not to be at fault — it looks a pattern match
  up by `MathOperandRef` in the same catalog a pick uses, and the
  pre-existing `a_uniform_set_inherits_its_operand_unit…` already
  passes on a pattern. *Conclusion*: the veto, not pattern plumbing.
  *Fix*: the inherit arm skips unplaced members and requires only that
  the **placed** ones convert to the first placed unit. Silence is not
  disagreement; a genuine dimension mix still derives nothing, which
  `an_unplaced_member_does_not_rescue_a_set_that_mixes_dimensions`
  guards from the other side. Badging is untouched — `effective_affines`
  only reports `unconverted` when a target was asked for or every
  member is placed and they disagree, so both cases read exactly as
  before.
- **2026-09-08 — a unit is handed on as a unit, never as the string it
  reads as** (owner ruling: "we should not be relying on parsing the
  unit strings anywhere in our application ... anywhere we care about
  units in cannet, they are consumed from a lossless and unambiguous
  representation"). This phase introduced the two typed stores — the
  per-signal reinterpretation and the definition's `UnitTarget::Typed`
  — and then flattened both back to a spelling on the way out:
  `signal_units::unit_of` rendered a chosen unit with `display_of`, the
  math catalog carried a `String`, and `derived_unit`,
  `effective_affines` and `recognition_of` each ran `recognize` on it
  again. The round trip is lossy exactly where it matters — `coulomb`
  reads `C` and `newton-millimeter` reads `Nmm`, neither of which
  recognition will place — so a signal read as a coulomb, or a
  definition targeted at one, converted nothing and was badged
  unplaceable while the user had picked it from a kind-locked picker.
  *Fix*: `units::UnitReading` is the hand-off — the `UnitId` and the
  string it shows, together — and it is built at exactly two ingest
  points (`UnitReading::declared`, over a database's own wording and
  the user's customization dict) or passed through typed
  (`UnitReading::typed` / `::placed`). `MathCatalogEntry::unit` is one,
  `derived_unit` and `effective_affines` take placed `UnitId`s, and
  `recognition_of` reports a reading rather than parsing one. The one
  string left in the model is `UnitTarget::Spelled` from a project file
  written before the typed form, which `resolve` still recognises once
  — that is ingest, and it stays.
  *Consequence worth noting*: the customization dict is now read where
  the **catalog** is built (`app_state::math_model`) rather than inside
  `MathModel::resolve`, which is the same boundary a DBC string already
  crossed there; `set_settings` drops the math-model cache, so editing
  one still rebuilds every entry and rescales every dependent channel
  (`a_math_stamp_moves_when_a_unit_customization_does`, rewritten to
  rebuild the catalog under the dict, is what pins that).
  `view_signals`' unplaceable flag is likewise the reading's, so it
  judges a database's wording and never a unit the user chose.
  Four acceptance tests were written first and three watched fail
  (identity where a factor was expected): a reinterpreted-coulomb
  operand and a reinterpreted-`Nmm` operand each converting to a
  picked target, and a definition targeted at coulombs handing that
  unit to the definition that reads it. Host lib 1236 → 1242 passing
  (7 ignored, unchanged); no frontend change — the command shapes are
  untouched.

Tests: host lib 1182 → 1233 passing (7 ignored, unchanged): 12 in
`units`, 17 in `math_signals`, 5 in `math_kernels`, 4 in
`signal_units`, 3 in `view_signals`, 1 in `settings`, 1 in
`math_commands`, and the rewrites below. Frontend 3388 across 243
files, unchanged (five listing fixtures completed with the new
`unitKind` / `recognition` fields rather than the type made optional).
The `units` tests were written first and watched fail to compile; the
Derivative kernel tests were written first and one of them
(`a_derivative_holds_its_slope_across_a_zero_length_step`) failed on
the first run, which is how the held slope reached `MathCarry` instead
of a per-block local. Seven existing tests asserted contracts this
phase deliberately changes (the `coulomb`/`joule` derived labels, the
unconverted mixed set, the file-backed skip) and were rewritten to the
new contract rather than deleted.

**2026-09-07 — Phase 4 (integration units), absorbed into
`task139-units`.** Landed: the rate↔integral pairing in the facade,
Integration-aware resolve, and the derived integrated unit. The owner's
report — an integration of an `A` operand asked for `Ah` badged
unconvertible — now converts.

- **Where the factor rides.** A pointwise conversion cannot express
  `A`→`Ah`, because the operand is not what changes: integrating amps
  over seconds already produces coulombs, and coulombs are amp-hours
  ÷3600. So the operand converts only as far as its family's canonical
  rate (identity for `A`, ÷1000 for `mA`) and the **output affine**
  carries canonical-integral → target. That lands the whole change on
  data the model already had — `ResolvedMath::output_affine` is applied
  post-function in `signal_cache` and mixed into
  `signal_fingerprint::math_encoding` — so no kernel and no fill
  changed, and a target edit parks the pyramid computed under the old
  factor (a new fingerprint test pins that:
  `a_math_stamp_moves_when_an_integrations_charge_target_does`).
- **Order of the try, and why it is that way.** Resolve attempts the
  operand's own family *first*, so `mA` on an `A` operand keeps the
  pointwise semantics and integrates in milliamps — the owner's
  pre-ruling workaround stays valid — and only a target the family
  cannot reach is offered to the integral path. Neither: unconverted,
  reported, badged, exactly as before.
- **The manual output scalars compose ahead of it.** The user's
  `(output_gain, output_offset)` corrects the value the function
  computed, in the unit it computed it in; the time conversion is the
  function's own and runs last, so the series ends in the unit the
  definition names. Same rule as the operand side, where the manual
  pair runs ahead of the conversion.
- **The pairing is the facade's, not the library's** —
  `units::integral_of(unit_id) -> Option<RateIntegral {rate, integral}>`,
  keyed on the *dimension* so every unit of a rate family answers the
  same pairing. *Observation*: `runtime_units` 0.6.3 exposes no
  multiplication of base dimensions and no way back from a computed
  base to a named unit. *Conclusion*: the two pairings (current × t =
  charge, canonical coulomb; power × t = energy, canonical joule) are
  ours; the library still supplies every multiplier they convert
  through. Recorded as the third gap in
  `plans/technology-inventory.md`. **No unit table entry and no
  `runtime_units` feature had to be added** — `coulomb`, `ampere-hour`,
  `milliampere-hour`, `joule`, `kilojoule`, `watt-hour` and
  `kilowatt-hour` were all already curated, and `Energy` and
  `ElectricCharge` already on.
- **The derived unit is the integral's id, and only where it is
  true.** With no target set nothing converts, so integrating `mA`
  produces milliampere-seconds — millicoulombs, which the table does
  not carry — and claiming `coulomb` there would be wrong by a
  thousand. `MathFunction::derived_unit` therefore names the integral
  only when the operand's unit *is* its family's canonical rate (`A` →
  `coulomb`, `W` → `joule`) and keeps the `·s` suffix otherwise
  (`mA·s`, `widgets·s`). The **id** rather than the display, because
  coulomb's display is `C`, which Phase 1 deliberately refuses to
  recognise (a DBC saying `C` means Celsius as often as coulomb) — and
  because Phase 2's id pass makes `coulomb` a string that reads back to
  the unit it names. `derived_unit` gained the customization dict as an
  argument for the same reason resolve has it: an in-house spelling the
  user has placed must derive the same integral `A` does.

Tests: 1173 → 1190 host lib tests passing (7 ignored, unchanged): 4 in
`units`, 9 in `math_signals`, 3 in `signal_cache`, 1 in
`signal_fingerprint`. All 17 were written first: the facade and resolve
tests were watched fail before the code existed, and the end-to-end
`signal_cache` ones were falsified afterwards by short-circuiting
`integrated_conversion` to `None` — `integrating_a_current_serves_amp_hours`
failed, `integrating_toward_the_operands_own_family_still_scales_the_operand`
stayed green, which is the split the ruling asks for.

**2026-09-06 — Phase 1 (model, engine, conversion), branch
`task139-units`.** Landed: the `runtime_units` dependency behind a
`units` facade; the per-operand wrapper schema and definition-level
output scalars; resolve-time per-member conversion with unconverted
members reported; fingerprint mixing; kernels applying operand affine
pre-function and output affine post-function; the workspace-scoped
customization dict on the settings model.

- **Facade surface** (`apps/gui/src-tauri/src/units.rs`): `Affine
  {gain, offset}` with `IDENTITY` / `apply` / `then` / `is_identity`;
  `Dimension` (14 groups); `UnitInfo {id, display, dimension}` with
  `all()` and `get(id)`; `convert(from_id, to_id) -> Option<Affine>`;
  `Customizations` (a `BTreeMap<String, String>`); `recognize(raw,
  &Customizations) -> Option<&'static str>`.
- **Two library gaps, absorbed by the facade rather than worked
  around** — both recorded in `plans/technology-inventory.md` in this
  commit:
  1. *Observation*: `runtime_units` 0.6.3's `UnitDefinition` is
     `{base bitfield, multiplier}` with no offset field, and
     `ThermodynamicTemperature` is commented out of its `system!`
     invocation. *Experiment*: built the crate with the
     `ThermodynamicTemperature` feature on and grepped
     `src/unit_definitions.rs`; the feature exists, the quantity does
     not. *Conclusion*: the °C/°F constants cannot come from the
     library, so the facade carries the three temperature offsets over
     the library's `TemperatureInterval` multipliers. Absolute
     readings, per the grooming ruling.
  2. *Observation*: a probe printing `is_convertible` said `rpm` ↔
     `Hz` and `N·m` ↔ `J`. *Conclusion*: the library's base-dimension
     equality is not a usable conversion rule for a user-facing
     picker; the facade groups units into its own dimensions and
     converts only within one. `every_dimension_is_one_convertible_family`
     pins that the grouping is never *looser* than the library's.
- **Where the dict landed.** `Settings::unit_customizations`, the
  first `Scope::Workspace` key — writes always go to the project's
  `.cannet/settings.json` (ADR 0042 §3), which is what makes it travel
  with the project as ruled. Consequence, and the one behaviour change
  outside math: a project's settings file now always carries that key
  (empty or not), because a workspace-scoped key's home *is* that
  file. `a_project_that_overrides_nothing_never_gets_its_settings_file_written`
  asserted the old, stronger invariant and was rewritten as
  `a_project_overriding_nothing_gets_only_the_workspace_scoped_keys`,
  which still forbids promoting any user or user-overridable key into
  the project's file.
- **Two tests asserted the contract this task deliberately changes**
  and were narrowed rather than deleted:
  `signal_fingerprint::a_math_stamp_does_not_move_for_a_rename_or_a_unit`
  and `signal_cache::a_rename_leaves_the_pyramid_where_it_is` both set
  `unit = "mV"` on a definition whose operand is in volts. That is now
  a conversion, so the stamp must move; both keep testing the rename
  with an *unrecognised* unit string (still a pure label), and new
  tests cover the converting case.
- **Scope deviation, small and deliberate.** The settings-view units
  section is Phase 2, but a `Backing::Field` setting must have a
  descriptor or an `EDITED_ELSEWHERE` entry
  (`descriptors_and_settings_name_the_same_keys`), and a descriptor
  naming an unregistered custom renderer renders a visible "No
  renderer registered" error. So Phase 1 ships the descriptor plus a
  minimal `UnitCustomizations` renderer that lists the project's rows
  and removes one; Phase 2 grows it into the section with the
  library-provided unit picker and an add path.
- **Kernel cost.** `math_kernels::scale` returns on
  `Affine::is_identity()` before touching the slice, so a definition
  that scales nothing pays one comparison per column per block and no
  multiply. Nothing else was added to the per-sample path.

Tests: 1145 → 1180 host lib tests (1173 passing, 7 ignored;
`a_thousand_member_set_benchmark` left `#[ignore]`).

**2026-09-06 — Phase 2 (editor and settings section), branch
`task139-editor`.** Landed: the math editor's scaling controls (a
target-unit picker over the library, per-operand gain/offset and
source-unit override, output gain/offset, and the flag on a member the
host could not convert), and the settings-view units section grown into
the library-picker + add path the grooming ruled.

- **One host command, and one host *policy* it forced.**
  `units::list_units` serves a `UnitListing` — a `UnitInfo` plus the
  dimension's picker label and a `spelling`. The spelling exists
  because of an observation: *a target-unit picker has to commit a unit
  **string**, and `recognize` is what reads it back.* Probing every
  unit's `display` through `recognize` found three that do not round
  trip — `coulomb` ("C"), `newton-millimeter` ("Nmm") and `scalar`. A
  picker offering those would have committed a unit that silently
  converts nothing. Rather than guess `C` into the recognition table
  (it is the Celsius spelling too, and Phase 1's rule is that nothing
  is guessed), `recognize` now also matches a unit's **own id**
  exactly, and `spelling` is the display where that recognises back and
  the id otherwise. `every_listed_spelling_recognises_back_to_its_unit`
  pins the contract the editor depends on. The id pass is placed after
  the exact-spelling pass and before the case-insensitive one, so no
  existing recognition changes meaning
  (`an_unrecognised_string_is_nothing_rather_than_a_guess` still holds,
  "C" included).
- **The flag is keyed by reference, not by index.**
  `ResolvedMath::unconverted` indexes the *host's* resolution order,
  and a section renders its picks plus its own JS-side pattern
  resolution, whose order need not be that one. The editor turns the
  indices into a set of `operandRefKey`s and each row asks the set, so
  a pattern-collected member is flagged correctly too.
- **Scaling rides only a pick.** A pattern match is not a stored
  operand (the host wraps it with `MathOperand::new` and it takes the
  conversion alone), so no scaling row is offered on one — the editor
  would otherwise show three controls with nowhere to write.
- **Two spellings, deliberately not one.** The target-unit picker
  commits `spelling` (a unit *string*, which becomes the series' label);
  the source-unit override and the settings customization commit `id` (a
  unit *id*, which the host resolves with `units::get`). Options whose
  two differ say so in the row — `C (coulomb)` — so what the field ends
  up holding is never a surprise.
- **A latent bug found and fixed with a test.** `definitionOf` — the
  stored half of a listing record, which every editor commit is built
  from — did not carry `outputGain`/`outputOffset`, so any edit through
  the editor would have silently dropped a definition's output scalars
  the moment Phase 2 let a user set them.
- **Free text kept.** The Units control is the shared `Combobox` with
  `freeText`, so the library is offered but anything typed still
  commits, and a stored unit the library does not carry is listed under
  a "not in the library" heading rather than falling back to the
  placeholder.
- **Three test fixtures were missing the Phase-1 fields.**
  `DatabasePanel.math.dom`, `PlotPanel.dom` built listing records
  without `operandAffines`/`unconverted`, which the host always sends;
  they were completed rather than the component made defensive against
  a shape the host cannot produce.

Tests: host lib 1173 → 1177 passing (7 ignored, unchanged); frontend
3359 → 3380 across 243 files (23 added, 2 replaced — the free-text unit
box's two tests became the picker's six).

**2026-09-06 — Phase 3 (unrecognised units in the signal-mapping
panel), branch `task139-panel`.** Owner ask: "the signal panel should
show signals whose unit is not blank and is not recognized" — the
**View signals** mapping panel (`ViewSignalsPanel.tsx`), so the DBC unit
strings that need a customization are visible where the signals are.

- **The fact is the host's, not the panel's.** `ViewSignalRow` grew one
  boolean, `unit_unrecognized`, computed in `view_signals::row` from the
  string the row will actually render (the serving database's unit, or
  the view's own record when nothing decodes) through
  `units::recognize`. The frontend never re-implements the recognition —
  `CLAUDE.md`'s rule that domain computation belongs in the model — and
  the blank case is decided once, host-side: `!unit.trim().is_empty()`
  guards the call, because `recognize`'s *first* pass is the
  customization map and a dict keyed on `""` would otherwise place a
  blank unit.
- **The refresh path, and why it needed one.** The panel's two existing
  triggers are `view-signals-changed` and the DBC generation; a
  customization edit is neither — it is a settings write, and settings
  announce themselves only through `hostSettings.ts`'s own subscriber
  list. So the panel reads `useSetting("unit_customizations")` and puts
  it in `refresh`'s dependency list: the value is never used for the
  recognition, only to re-ask the host, which reads the dict from
  `settings::effective()` (a cache `set_settings` refreshes) on each
  fetch. The DOM test drives it end to end — mounted panel, a customization
  written from outside it, badge gone with no remount.
- **The filter shape found: two selection sets, no free text.** The
  toolbar carries status chips (`aria-pressed` toggles) and a bus
  fly-out, ANDed together by `applyViewSignalFilters`; there is no
  search box. An unplaceable unit is orthogonal to the decode taxonomy —
  a Decoded row can have one — so it is a fourth dimension rather than a
  sixth status: one more pressed chip, `Unknown unit (N)`, wearing the
  row badge's own `≠` so the toolbar and the rows read as one thing.
  `unknownUnitOnly` is a plain boolean, not a set: a unit either needs a
  customization or does not. Persisted in the panel's params beside the
  other two filters.
- **The badge sits in the signal cell**, not a new column: a column
  would change every persisted layout for a flag that is blank on almost
  every row.
- **One clippy shape change, forced.** `row` reached 8 arguments and then
  101/100 lines. The two project-wide inputs every row reads identically
  (`bus_names`, `customizations`) became a `ProjectFacts` struct built
  once per build rather than per row, and the flag predicate moved to its
  own `unit_unrecognized` function.

Tests: host lib 1177 → 1182 passing (7 ignored, unchanged); frontend
3380 → 3386 across 243 files.

**2026-09-09 — bench fixes folded into `task139-apply`.** Three owner
findings from the same walk over the units surfaces, all fixed in place
on the branch that introduced them.

- **The View-signals unit column now sorts.** It was in
  `VIEW_SIGNAL_UNSORTABLE` on the reasoning that "the chip is a picker
  over a host-side store" — but what the chip *reads* is a value, and
  the host already carries it as `ViewSignalRow::unit`. A `unit` arm
  joins `view_signals::sort_rows`, case-folded so `mV` and `MV` sit
  beside `V` instead of on either side of it, with the raw string as
  tiebreak; a row that declares no unit groups at the end either way,
  the rule `database` already follows for a row nothing decodes.
- **The settings units table refreshes live.** *Observation:* a
  spelling added or removed did not appear or disappear until the
  settings panel was reopened. *Hypothesis:* the table re-asks the host
  too early to see its own write. *Experiment:* mount the section under
  `SettingsPanel`'s real `commit` — optimistic `setSettings`, then
  `updateSettings` — and add a spelling. *Data:* the row did not change
  until remount. *Conclusion, confirmed:* the fetch was keyed on the
  dict this component is handed, which the panel sets **optimistically**
  the instant a commit is made; `updateSettings` is still a
  read-modify-write round trip from the host, so `list_unit_mappings`
  answered out of the pre-write cache, and when the write did land the
  value was already what the component held — the key never changed
  again, so it was never re-asked. The fetch is now keyed on the
  settings store's own publish, which fires when a write is *accepted*
  (and on a re-hydrate after a hand-edit).
- **One order for every unit list.** *Current order, measured:* the
  settings table listed 30 base rows in `UNITS` declaration order
  (`voltage, current, charge, charge, power, energy, …`) and then a
  21-row tail of prefixed units in the ASCII order of whichever spelling
  reached them first (`frequency, pressure, voltage, power, length,
  current, …`) — so `mV` sat 30 rows below `V`, and the picker's base
  column and the source-unit combobox each inherited the hand-grouped
  table order. *After:* every list surface sorts through one
  `units::list_order` — dimension label alphabetically, then the base
  unit's display, then up the prefix ladder — so voltage reads
  `mV, V, kV, MV`, charge `mAh, Ah, C`, time `d, h, min, µs, ms, s`, and
  the picker and the table agree. `UNITS` stays grouped by hand for
  reading; nothing now inherits its order. The alternative considered
  was keeping the curated dimension sequence (electrical first) and
  sorting only within it; alphabetical groups won because the surfaces
  then need no key to read.
- **One doc-vs-code fix in passing.** `UnitMappingRow::mappings` claimed
  "built-ins first then the two customization scopes"; the code has
  always emitted one alphabetical spelling order regardless of source
  (the chip says which scope). The comment now says what the code does.

Tests: host lib 1260 → 1262 passing (7 ignored, unchanged); frontend
3462 → 3463 across 246 files. All four were written red first.

## Blockers / side effects

- **`coulomb` and `newton-millimeter` still read `C` and `Nmm`**, and
  recognition still refuses both — `C` is a guess between charge and
  Celsius, and that rule stays. Nothing depends on it any more: a unit
  the model holds travels as a `units::UnitReading` (the unit, and the
  string it shows) rather than as its spelling, so choosing either
  converts and renders exactly as any other unit does. A *database*
  that writes `C` still places nothing and is still flagged for a
  mapping in Settings → Units, which is the ingest question and a
  different one.
- **`unit_customizations_user` no longer has a settings row.** The
  ruling puts project/user checkboxes on every row of the units table,
  which makes that table the editor of both dicts; a second row would be
  the second editor `EDITED_ELSEWHERE` exists to forbid, and two tests
  enforce that. The key is unchanged in `settings.json` and still
  hand-editable — it is only the row that is gone. Flagged because a user
  who went looking for it will not find it.
- **The View-signals panel gained a `unit` column.** The chip has to be
  clickable and wide enough to read a unit, so it is a column rather than
  a badge in the signal cell (Phase 3 put the unplaceable-unit flag
  there, and that flag stays). A saved layout takes the new column
  without resetting (`columnsFromParamsFor` inserts it where a fresh
  panel would put it), but every open panel's layout does move.
- **The math editor's free-text unit box is gone.** It was kept here
  (the ruling then said free text "stays as a label path") and flagged
  as the one place the shipped editor differed from the accepted
  prototype; the owner ruled on it at the bench and it was removed on
  `task139-apply`. A spelling an old file stored still loads and
  displays — only the affordance to type a new one is gone.
- **A project's `.cannet/settings.json` now always carries
  `unit_customizations`**, empty or not, and the settings view
  therefore marks it as project-overridden. That is what
  `Scope::Workspace` means (the key's home is the project's file) and
  `unit_customizations` is the first key to use it; the alternative —
  omitting an empty map — would break ADR 0034's "the file lists every
  knob", which two tests enforce. Flagged because it is a visible
  change to a file users hand-edit.
- **`runtime_units` 0.6.3 ships no absolute-temperature quantity and
  no offsets at all**, so the °C/°F constants are ours (see the status
  log and `plans/technology-inventory.md`). A future release that
  builds `ThermodynamicTemperature` would let the facade drop that
  table; nothing else changes.
