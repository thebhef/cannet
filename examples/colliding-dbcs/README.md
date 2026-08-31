# colliding-dbcs — two databases that disagree about one id

Two databases assigned to one bus, both defining arbitration id `0x100`,
and disagreeing about it in every way two databases can. This is the
input the resolution rule exists for: something has to decide which of
them decodes a frame, and every surface that shows a decoded value has to
show the same answer.

The id is `VehicleState` in `../cannet-demo.dbc`, so the committed demo
captures already carry traffic both files claim. There is no capture
here — import `../cannet-demo.blf` (1810 frames, `0x100` at 20 Hz) or
`../capture-features/annotated.blf`.

## Files

| File | What it is |
| --- | --- |
| `legacy-vehicle.dbc` | The outgoing database. `VehicleState` (`0x100`), plus `LegacyOnly` (`0x101`). |
| `modern-vehicle.dbc` | Its replacement. `VehicleStateV2` — the same id under a new name — plus `ModernOnly` (`0x102`). |
| `colliding-dbcs.cannet_prj` | One bus, both databases scoped to it, a by-id trace, a plot of the contested signals and a **Watch list** signals view — every signal reference recorded under the legacy definitions. |

## The disagreements

| | `legacy-vehicle.dbc` | `modern-vehicle.dbc` |
| --- | --- | --- |
| Message name for `0x100` | `VehicleState` | `VehicleStateV2` |
| `VehSpeed` | `× 0.01`, `km/h` | `× 0.00621371`, `mph` |
| `EngineRpm` | `× 0.25`, `rpm` | identical |
| `GearLever` value labels | `P` `R` `N` `D` `S` `L` `Manual` `Reserved` | `Park` `Reverse` `Neutral` `Drive` `Sport` `Low` `Manual` `Undefined` |
| Bits 35–42 | `BrakePedal`, `%` | `DriveMode`, unitless |
| Counter / CRC | none declared | `AliveCtr` + `Crc8` (`CannetCounter` / `CannetCrc`) |
| Its own message | `LegacyOnly` (`0x101`) | `ModernOnly` (`0x102`) |

Read as cases:

- **The renamed message.** A view or an event that references `0x100`
  by the old name has to keep working; the resolution rule decides which
  name it now reads as.
- **The contested scale.** The same wire bits are `64.0 km/h` or
  `39.8 mph` depending on which database wins. Whatever wins must win in
  the trace row, the plot, the value table and the calculated fields
  alike — a rendered amplitude and its unit cannot come from different
  databases.
- **The harmless collision.** `EngineRpm` is identical in both, so it is
  the control: whatever the rule does here, nothing visibly changes.
- **The contested vocabulary.** Same signal, same bits, different enum
  labels — so an enum lane, an overlay and a value dropdown all have to
  agree about which vocabulary is in force.
- **The contested bits.** One database calls bits 35–42 a brake pedal;
  the other calls them a drive mode. Only one of those signals exists at
  a time.
- **The one-sided declaration.** Only the replacement declares a counter
  and a CRC, so which database decodes `0x100` decides whether those
  fields exist at all.
- **The one-sided messages.** Each file defines a message the other has
  never heard of, so the union — not the winner alone — is what the
  database view has to list.

## Opening it by hand

Open `colliding-dbcs.cannet_prj`, then import `../cannet-demo.blf`. Its
single channel maps onto `Pack`. The by-id table and the plot both draw
`0x100`; the database view lists both files under the one bus.

The project binds no interface. It is an import fixture — there is
nothing here to connect to.

## Walking every signal-mapping repair

The plot and the **Watch list** tab reference five signals, each
recorded under `legacy-vehicle.dbc`'s definitions — which makes this
project the acceptance script for the signal-mapping panel's status
taxonomy and every repair it offers. Open the signal mapping panel and
walk it in two stages.

**Stage 1 — both databases assigned, as the project opens:**

| Row | Status | Why |
| --- | --- | --- |
| `VehSpeed`, `EngineRpm`, `GearLever` | **Ambiguous** | both databases define `0x100`, and load order (the legacy file is listed first) settles it silently |
| `BrakePedal`, `LegacyHeartbeat` | Decoded | only the legacy file defines them — no collision |

**The ambiguity pick:** choose a database in an Ambiguous row's Source
picker. The row leaves Ambiguous, and `Mod+Z` reverses the pick.

**Stage 2 — unassign `legacy-vehicle.dbc` from `Pack`** (the upgrade,
as a project that outlived its database experiences it):

| Row | Status | Why | Repair |
| --- | --- | --- | --- |
| `VehSpeed` | **Scale** | mapped as `km/h`, decoded by `mph` | **Accept** — re-records every view's mapped fields as what now decodes |
| `GearLever` | **Stale** | `VehicleState` is now `VehicleStateV2`; the value still decodes right | **Accept** |
| `EngineRpm` | Decoded | identical in both files — the control | — |
| `BrakePedal` | **Not Decoded** | the replacement calls those bits `DriveMode` | the **remap pick** — choose `DriveMode` in the Source picker and every stored reference moves |
| `LegacyHeartbeat` | **Not Decoded** | `0x101` does not exist in the replacement | none — a truly missing signal; the picker reads "nothing available" |

`VehSpeed` is referenced by the plot *and* the Watch list, so its row's
**Used by** names both — one Accept (or one remap) lands on every view
at once. Every repair is one undo step (`Mod+Z`).

The remaining shape — a reference that names **no bus**, repaired by
re-pointing it at a bus that decodes — needs a project whose series
name no bus: `../mapping-repair/` carries it.

## What checks it

`crates/cannet-dbc/tests/colliding_dbcs_fixture.rs` pins every
disagreement in the table above, and
`project::tests::parses_the_checked_in_colliding_dbcs_example_project`
(`cannet-gui`) keeps both databases on the same bus and the five
repair-walk references recorded under the legacy definitions. A pair
that quietly stopped colliding would still parse, still open, and
demonstrate nothing.
