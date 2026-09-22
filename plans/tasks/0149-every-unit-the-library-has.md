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
  in `COMPOSITION_ORDER` whose base is ISQ-convertible with it (so
  `N · m` reads as torque before energy). Many of the 110 share ISQ
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

## Open questions

Each with the overseer's recommendation; ruled answers move to
§ Rulings.

1. **The ratio family's scale column.** Today the `ratio` row offers
   three scales (0–1, %, ppm) by design ruling; the crate's `Ratio`
   quantity has eleven (parts per hundred/thousand/ten thousand, ‰,
   bp, ppm, ppb, ppt, ppq…). *Recommend:* the scale column lists all
   of them, since a scale choice is that family's "prefix".
2. **Composition order across 110 quantities.** *Recommend:* today's
   15 in today's order first (the automotive readings a product is
   most likely meant as), the remaining quantities alphabetically
   after; the phase records the ISQ collisions it finds in its status
   log so the order can be corrected on evidence.
3. **Temperature interval vs absolute.** *Recommend:* two dimensions,
   `temperature` (absolute, offsets) and `temperature interval`
   (ΔK, Δ°C, Δ°F, Δ°R), since a temperature difference is a common
   bus signal and converts without the offset.

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
   confirmed in tests; `LPM = L / min` defined through the settings
   entry and a database's `LPM` reads as it. Technology inventory
   entry, `units.rs` module docs and `docs/CONTEXT.md` updated where
   the wording changed.

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
8. `plans/technology-inventory.md`'s `runtime_units` entry and the
   `units.rs` module docs describe the no-curation table.

## Blockers / side effects

(none yet)

## Status log

- 2026-09-21 — opened from ungroomed item 11; survey and rulings
  above.
