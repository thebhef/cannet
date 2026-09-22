# Task 149 — Every Unit the Library Has

Opened by owner instruction 2026-09-21 from user feedback (ungroomed
item 11, "no volume units in the unit list"). **Executes now, on the
current stack.** Grooming in progress.

## Why

From the feedback: a project carries an `LPM` unit string and there
is nothing to map it to. Litres are not offered and `L / min` cannot
be composed either, because the app's dimension list names neither
volume nor volume rate. The underlying crate (`runtime_units` 0.6.3)
has both quantities.

The owner's ruling on grooming widened it from "add volume" to the
policy behind the table (see § Rulings): the app is not to curate
the library's units at all.

## Scope

The host's unit facade (`apps/gui/src-tauri/src/units.rs`) offers
**every base unit of every quantity the crate carries**, presented as
prefix + base unit, with no hand-picked subset at any level: not of
quantities, not of units within a quantity. The picker, the settings
view's units table and the recognition of database unit strings all
follow from that table as they do today.

## Findings (2026-09-21 survey)

- **The library supplies finished quantities, not base dimensions.**
  `runtime_units` has 110 quantities behind Cargo features, each an
  enum of units with a multiplier to the quantity's SI base and a
  symbol, a singular and a plural name. 15 features are enabled
  (`Cargo.toml`, "the automotive set"). `Volume` (66 units) and
  `VolumeRate` (71) exist and are not enabled.
- **The app's table is an explicit whitelist at two levels.**
  `Dimension` (15 variants, one per enabled quantity) and `UNITS`
  (49 rows, hand-typed, documented as "deliberately a curated
  subset"). Across the 15 enabled quantities the crate carries ~190
  non-prefixed units; across all 110 it carries 918 (2334 including
  the crate's enumerated prefix variants).
- **Prefix + base is already the model.** `UnitId` is base × `Prefix`;
  the full SI ladder is composed where the crate has no variant, and
  a test cross-checks composed factors against every variant the
  crate does enumerate. What this task changes is the base list, not
  the mechanism.
- **The crate tabulates some prefixed composites as units of their
  own** (`kW · h`, `kA · h`, ten prefixes each). Under prefix + base
  these are the base `W · h` / `A · h` with a prefix, which the
  composed-factor path already handles; the classification rule is
  "strip the SI prefix from the first factor where the unprefixed
  sibling exists in the same quantity".
- **Imperial and US customary units** ride in every quantity (psi,
  hp ×5, Btu ×6, lbf·ft, gal and gal (UK), ft³/min, °F, °R…). They
  are base units with prefix `none`, the footing `bar` has today; no
  special casing.
- **A user-composed unit must land on a named `Dimension`**
  (`define`, "lands on no dimension this app names"), so today
  `L = 0.001 * m * m * m` is refused and `LPM = L / min` cannot
  follow. Once volume and volume rate are dimensions, the existing
  settings-view composition entry defines `LPM` with no new
  mechanism.
- **Temperature.** The facade merges the crate's temperature-interval
  units with hand-written offsets into one `temperature` dimension,
  on the note that the crate's absolute-temperature quantity "is not
  built in this release". 0.6.3 does carry `ThermodynamicTemperature`
  and its table lists °C with `273.15` and °F with `459.67` beside
  the multiplier; whether `UnitDefinition` exposes that constant is
  for the phase to check (the facade's offsets stay if it does not).
- **Composition order matters more at 110 quantities.**
  `Composed::dimension()` resolves a product to the first dimension
  in `COMPOSITION_ORDER` whose base is ISQ-convertible with it (the
  order has always put energy ahead of torque, so `N · m` reads as
  energy; an earlier draft of this note had it backwards). Many of
  the 110 share ISQ
  dimensions (frequency / radioactivity / angular velocity; energy /
  torque; heat capacity / entropy; and more); the order decides what
  a math product is called.
- **`Dimension` is serialized** (kebab-case) in the math signal
  model's `kind`; the 15 existing names must keep their spelling.
- **The technology inventory entry** for `runtime_units` describes
  the 15-quantity feature set; it changes with this task.

## Rulings

- **No curation** (owner, 2026-09-21): the only shaping is rigour
  about presenting every unit as prefix + base unit; no base unit
  the library provides is omitted.
- **All 110 quantities are built** (owner, 2026-09-21: "probably
  #2", confirmed "let's do that"). Choosing quantities would be the
  same omission one level up; the picker's grouping and filter are
  what keep 918 bases usable.
- **The ratio family's scale column lists every ratio unit the crate
  carries** (owner, 2026-09-21), not the three of the earlier design
  ruling; a scale choice is that family's prefix.
- **Composition resolves to the first match, and the user can override
  it with any dimension of the same ISQ exponents** (owner,
  2026-09-21: "make the first resolution and let the user override
  it"). Overseer's reading into mechanism: `COMPOSITION_ORDER` keeps
  today's 15 at its head in today's order, the other quantities
  alphabetically behind; wherever a composed kind locks a picker (a
  math signal's output unit) the lock widens to every dimension
  ISQ-equivalent to the composition, grouped under their own headings
  with the first resolution's group first and its unit preselected.
  So a `N · m` product opens on energy (the order's first) and offers
  torque under it, unless the owner moves torque ahead (queued). A
  settings-view composition (`X = N * m`) is placed by the same first
  resolution; overriding it there is naming the target explicitly,
  which the entry already allows by composing from a unit of the
  wanted dimension.
- **Temperature interval is its own dimension** beside absolute
  temperature (overseer recommendation, owner deferred 2026-09-21).
- **Owner review, 2026-09-22.** `LPM` composed and was picked up
  automatically; the units are comprehensive but overwhelming (that is
  task 151's gridview). Ruled: (a) **energy-first for `N · m` stands**,
  "as long as the user can easily override it in the signal mapping
  panel" — the override must be easy wherever a math signal's unit is
  chosen (which panel the owner means is open question 1); the owner
  was surprised torque and energy resolve as one class — they share
  ISQ exponents (kg·m²·s⁻²) and are separate dimensions here, never
  converted between; only a *composed* product has to be given a
  name, and that is the first-match the override corrects. (b) **The
  user must be able to alias `mi/h` as `mph`** through the settings
  entry (`mph = mile / hour`, a composition of one unit, displaying as
  `mph` and converting 1:1) — the phase verifies the entry accepts a
  single-unit alias and documents it. (c) `absement` (the time
  integral of displacement, m·s) is a real library quantity; the
  no-curation ruling keeps it, collapsed under its own branch once
  task 151 lands.

## Open questions

1. **Which "signal mapping panel"?** The composed-kind override lives
   in the math signal editor's Units button (phase 2). The View
   signals panel's Units button passes no kind (offers everything,
   which is reinterpretation, not conversion), and the settings
   view's Units section maps database strings to units. *Recommend*
   the math signal editor is the place and the View signals panel
   gains the same class-locked picker for a math signal's row.

## Phases

1. **The table from the crate.** `Dimension` and `UNITS` stop being
   hand-written: every enabled quantity becomes a dimension and every
   unit the crate carries for it becomes a row, classified as a base
   or as a prefixed form of a base by the rule in § Findings. All 110
   features enabled. The offsets, the ratio family's scale policy and
   the scalar placeholder remain the facade's own. Recognition of
   database strings extends to the crate's symbol, singular and plural
   for every unit. Existing tests hold (the family, id-uniqueness,
   spelling round-trip and prefix cross-check tests now run over the
   whole table); new tests enumerate the crate's units and assert
   each is offered. Compile-time and binary-size deltas measured and
   recorded, not gated.
2. **Surfaces at scale.** The picker and the settings view's units
   table over ~900 bases in 110 groups: grouping, filter and order
   confirmed in tests; the math output picker's widened lock (every
   ISQ-equivalent dimension, first resolution preselected);
   `LPM = L / min` defined through the settings entry and a
   database's `LPM` reads as it. Technology inventory
   entry, `units.rs` module docs and `docs/CONTEXT.md` updated where
   the wording changed.
3. **Owner review follow-ups (2026-09-22).** A single-unit alias
   (`mph = mile / hour`) through the settings entry, displayed and
   converting as such; the composed-kind override reachable from the
   panel open question 1 names; README documents the alias.

## Exit criteria

1. Every non-prefixed unit in every quantity of `runtime_units` 0.6.3
   is offered by `list_units` / `list_unit_picker`, as a base unit or
   as one rung of a base's ladder — asserted by a test that enumerates
   the crate, not a hand list.
2. No hand-typed unit rows remain; the facade's own contributions are
   exactly the temperature offsets, the ratio scale policy and the
   scalar placeholder, each documented in the module docs.
3. The 15 existing `Dimension` serde names are unchanged; a project
   with a math signal of `kind: voltage` reads back identically.
4. `LPM = L / min` defined in the settings view's units section is
   accepted, lands on the volume-rate dimension, and a database unit
   string `LPM` converts to `L/s` and `m³/s` by the right factors.
5. Every existing units test passes over the full table, including
   `every_dimension_is_one_convertible_family` and
   `every_prefixed_variant_the_crate_enumerates_matches_the_composed_factor`.
6. The picker groups by dimension and filters by substring over 110
   groups; a dom test finds `litre` and `psi` by typing.
7. Compile-time and release binary-size deltas from enabling all 110
   features are recorded in the status log.
8. A math signal whose composed unit is `N · m` opens its output unit
   picker on the composition order's first resolution — energy, as
   the order has always read it — with torque offered beneath; picking
   a newton-metre converts by the right factor. (Whether torque should
   move ahead of energy is a queued owner question; either answer is
   one line in the `dimensions!` list.) A test pins the first
   resolution of every composition today's tests name.
9. `plans/technology-inventory.md`'s `runtime_units` entry and the
   `units.rs` module docs describe the no-curation table.
10. `mph = mile / hour` defined in the settings entry is accepted,
    displays `mph`, converts 1:1 with `mi/h`, and a database `mph`
    reads as it; README says an alias is a composition of one unit.
11. A math signal's composed-kind override is reachable from the panel
    open question 1 names, tested.

## Blockers / side effects

- **`runtime_units` 0.6.3, `DoseEquivalent`**: every sievert above the
  sievert carries a stray `prefix!(centi)` factor, so `decasievert` is
  0.1 Sv and collides with `decisievert`. The classification rule
  refuses it (name says deca, number does not), so it is offered as a
  base of its own and the deca rung is composed from the sievert.
  Guarded by
  `a_library_unit_whose_number_contradicts_its_name_is_a_base_of_its_own`.
- **`runtime_units` 0.6.3, `PressureImpulse`**:
  `pound_force_per_square_inch_sec` carries the pressure's symbol
  `lbf/in²`, so that symbol is ambiguous and recognises to nothing.
  `psi` is unaffected.
- **Three crate units are unreachable through the crate's own
  enumeration API** (`CubeRootScaledLength` gives two units each of the
  singulars `scaled_kilometer`, `scaled_foot` and
  `meter_per_cube_root_kiloton_tnt`; `units()` lists singulars and
  `try_from` resolves the first), so the three
  `scaled_*_per_kiloton_tnt` units are not in the table. 3 of 2285;
  naming variants by hand would be the curation this task removes.
- **`°R` is offered but no spelling reaches it**: the crate gives the
  absolute and the interval Rankine the same `°R`. Its id
  `degree-rankine` still names it.
- **`mph` now displays `mi/h`** (the crate's symbol); `mph` still
  recognises. Keeping `mph` would be a hand-typed display override.
  Queued for the owner.
- **The picker renders all 920 base rows at once.** No virtualiser
  (adding one would be a technology-inventory decision). Numbers in
  the 2026-09-22 phase 2 status log; typing narrows it in ~50 ms,
  clearing the filter costs ~215 ms in jsdom.
- **`litre` finds nothing; `liter` and `L` do.** The library spells the
  unit American, so the picker filter (display and id) and recognition
  have no British spelling to match. Alternates would mean the host
  carrying extra searchable spellings on the picker row.

## Status log

- 2026-09-21 — opened from ungroomed item 11; survey and rulings
  above.
- 2026-09-22 — **phase 1 (the table from the crate) landed** on
  `task149-units-table` (`1befcfd4`, one commit, no squash).
  `Cargo.toml` takes the crate's `All` feature; `units.rs` derives
  `Dimension` and `UNITS` from it. The only hand-written part left is
  the `dimensions!` list — one row per library quantity naming what
  this facade calls it — and `Dimension::rows()` reads each quantity's
  units back out of the crate (`units()` → `try_from` → variant name,
  symbol, singular, plural, multiplier). Shape: a macro over the
  quantity list building a `LazyLock<Table>` — a generated table would
  need a build script and a second copy of the crate's data, a purely
  runtime table cannot produce a `Dimension` enum with serde names;
  `serde(rename_all = "kebab-case")` + `stringify!` derive the
  serialized name, the picker label and the id qualifier from one
  spelling. **Table: 2289 rows over 109 dimensions** (930 bases, 1359
  prefixed rungs, 115 bases with an SI ladder). 108 crate quantities
  build, not 110: `ThermodynamicTemperature` is commented out of the
  crate's own `system!` and `scaled_length` is unlisted, so the crate
  still has **no absolute-temperature quantity and the facade's offsets
  stay** (§ Findings check answered); absolute temperature is a facade
  dimension of four scales (K, °C, °F, °R) and `temperature-interval`
  its own beside it. **Classification**: a rung where the variant name
  splices the prefix at a word boundary *and* the multiplier ratio is
  that prefix's power of ten (`ampere per micrometer` is a million
  `ampere per meter`; `psi` and `pound_force_per_square_inch` share a
  multiplier); rungs of rungs walked to their base, dropped to a base
  of their own where the exponents are no SI prefix. All 49 old ids,
  displays and `(base, prefix)` identities survive, except `mph` →
  `mi/h` and the symbol-less bare ratio reading as its id. Displays
  close up the crate's ` · ` (`Ah`, `Nmm`). **Recognition** gains a
  unique-or-nothing pass over every crate spelling (symbol, singular,
  plural) after the ids and before prefix composition: 6544 spellings,
  123 ambiguous and refused; `prefixed_spelling` unique-or-nothing too
  (21 `?g/m³` collisions). `C` kept unrecognised via a one-entry
  `REFUSED` list (owner ruling predates this task). Automotive spellings
  (`V`, `A`, `rpm`, `km/h`, `bar`, `°C`, `%`, `psi`, `Ah`, `Nm`, `mph`,
  `h`, `K`, `°F`) all still place, asserted by
  `the_spellings_an_automotive_database_writes_still_place_their_units`.
  **Composition** resolves against `Dimension::all()` (composition
  order); new `Composed::dimensions()` returns the ISQ-equivalence class
  in that order, first element = `dimension()`; `N · m` → energy, as it
  always did (criterion 8 corrected, order question queued). **Deltas**
  (`cargo clean -p cannet-gui -p runtime_units --release` then `cargo
  build -p cannet-gui --release`, one machine, same day): compile
  **137 s → 176 s (+39 s, +28 %)**; `target/release/cannet-gui.exe`
  **24,467,968 → 25,579,520 bytes (+1.06 MiB, +4.5 %)**. Tests: 77 in
  `units` (8 new), 1336 host, 3608 frontend, workspace clippy and
  rustdoc clean; release host built. README's ratio-scale and
  unplaceable-unit sentences corrected in the commit. Exit criteria 1,
  2, 3, 5, 7 and 8's host half met. For phase 2: `list_units()` 2289
  rows, `list_unit_picker()` 930 bases over 109 groups; `RATIO_SCALES`
  → `ratio_scales()` (11 scales, descending); `UnitScale::label` is now
  `String` (JSON-identical); the crate has no litre-per-minute, so
  `LPM` is composed (`liter` over `minute` → volume-rate, 1/60000 to
  `cubic-meter-per-second`). Overseer's review: the module doc's
  "Recognising a DBC unit string" paragraph omits the new crate-spelling
  pass that `recognize`'s own doc lists — phase 2 fixes the wording.
- 2026-09-22 — **phase 2 (surfaces at scale) landed** on
  `task149-units-surfaces` (`f3e7ecf1`, one commit, no squash). Task-final.
  **The picker gained a filter** — it had none, which the grooming
  assumed it did. `filterRows` (`unitSelection.ts`) is a substring over
  the row's display, id and dimension label, keeping the host's order
  and always keeping the row that commits nothing (the composition /
  derivation, the only way back to the derived unit). Emptied groups
  lose their headings; nothing matching says "no unit matches"; the box
  autofocuses. **The lock widened to a class.** `ResolvedMath` gains
  `kinds` — the ISQ-equivalence class in composition order, what the
  series is read in at its head, a target outside the class inserted
  ahead so the picker always shows the current selection. Travels as
  `unitKinds: string[]` on `MathSignalRecord` (`unitKind` unchanged);
  `UnitPicker`/`UnitButton` take `UnitPickerKind = string | readonly
  string[] | null`; `pickerEntries` emits the lock's order, one pass per
  locked dimension so each keeps the host's row order. `N · m` opens on
  energy with torque beneath; the newton-metre converts ×1.
  **`LPM = L / min` needed no code**: `parse_composition` already
  divides and volume rate is a dimension since phase 1; a host test
  (accepted → volume rate → `recognize("LPM")` → ×1/60 to `L/s`,
  ×1/60000 to `m³/s`) and a settings dom test pin it. **Settings table**
  needed no change (already filtered and dimension-contiguous); a dom
  test pins both at scale; the ratio family's 11-scale column is pinned
  host-side. **Render cost, reported not gated** (throwaway jsdom probe,
  920 bases / 109 groups, 4 runs): 945 options on open, mount
  314–329 ms, first narrowing keystroke 49–58 ms, later 5.7–16.7 ms,
  clearing back to all rows 210–221 ms; the picker renders every base
  row at once, no virtualiser (queued). **Docs**: inventory
  `runtime_units` entry rewritten (`All`, no-curation numbers and cost,
  the 0.6.3 defects and enumeration gaps); `units.rs` recognition
  paragraph now lists the crate-spelling pass; `UnitPickerEntry::scales`
  doc corrected; README picker paragraph gains the filter and the
  widened lock; `docs/CONTEXT.md` unchanged (its dimension/scale entries
  are plot-axis terms). One bug caught by the full suite and fixed: a
  test mock built a `MathSignalRecord` without `unitKind`/`unitKinds`.
  Tests: 78 in `units`, 2127 workspace, 3622 frontend. Full CI matrix
  green; python, proto, MDF-oracle and sidecar-freeze lanes unreachable.

## Exit criteria verdicts (2026-09-22)

| # | Verdict |
| --- | --- |
| 1 | met — crate-enumerating test, floor 2000 (phase 1); 3 `CubeRootScaledLength` units unreachable through the crate's API (§ Blockers) |
| 2 | met — no hand-typed rows; offsets, ratio policy, scalar placeholder documented (phase 1) |
| 3 | met — 15 serde names pinned; `kind: voltage` reads back (phase 1) |
| 4 | met — `LPM = L / min` accepted, volume-rate, ×1/60 and ×1/60000 (phase 2) |
| 5 | met — 78 `units` tests over the full table incl. the family and prefix cross-check (phase 1, re-confirmed) |
| 6 | met — picker filter added and tested (`liter`, `L`, `psi`, `charge`); `litre` does not match (§ Blockers) |
| 7 | met — +39 s compile, +1.06 MiB binary (phase 1) |
| 8 | met — `N · m` opens on energy with torque beneath, newton-metre ×1; first resolutions pinned (both phases); torque-first is a queued owner question |
| 9 | met — inventory entry, module docs, README (phase 2) |
- 2026-09-22 — owner review: accepted with follow-ups (rulings above); phase 3 opened; picker render cost folded into task 151.
