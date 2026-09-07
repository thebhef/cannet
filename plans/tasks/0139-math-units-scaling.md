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
- [x] Technology inventory records the dependency decision; docs
      match shipped behaviour.
- [x] An integration reaches a target its operand only reaches through
      time: `A`→`Ah` and `mA`→`Ah`, `W`→`kWh`. A target in the
      operand's own family (`mA` on an `A` operand) still converts the
      operand; a target in neither dimension is still badged; with no
      target, a recognised rate derives its integral's unit.

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

## Blockers / side effects

- **Two units still render a string recognition cannot place**, by the
  same mechanism the ratio defect had: `coulomb` reads `C` (left out of
  the recognition table on purpose — it would be a guess between charge
  and Celsius) and `newton-millimeter` reads `Nmm`. Wherever a unit is
  *chosen* and then reported onward as a string, choosing either of
  those two yields a unit string nothing places, so it converts nothing
  and the mapping panel flags it as unplaceable — while the user picked
  it from a kind-locked picker. Not fixed here: the repair changes what
  the unit column renders for those two, which is an owner call. The
  ratio family is clean, and a facade test pins it.

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
