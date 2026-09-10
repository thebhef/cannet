/// The **base × prefix** unit picker's model: what its two columns
/// hold, given the host's picker table and the context the picker was
/// opened in.
///
/// A unit's identity is a base unit and an SI prefix, so a picker is two
/// columns — the base, then the scale — and never one flat list of
/// pre-composed spellings. Which bases exist, what scales each takes and
/// how every `(base, scale)` pair is **spelled** are the host's answers
/// (`units::list_unit_picker`); nothing here composes a unit string or
/// decides what converts to what.
///
/// Kept free of React so the shapes are unit-testable, and so the three
/// callers — the math editor's target, the View-signals reinterpretation
/// chip and the plot's display-unit chip — read one model.

import type { UnitPickerEntry, UnitScale } from "./unitLibrary";
import type { UnitId } from "./types";

/// The composition a caller is offering alongside the library: what
/// dimensional analysis derived for the thing being edited.
export interface UnitPickerComposition {
  /// How it reads — `Ah`, `A·s`, `Ah/s`.
  label: string;
  /// The unit it **is**, where the host names one. `null` for a
  /// composition no unit names, which is the only case that earns a row
  /// of its own.
  unit: UnitId | null;
}

/// The synthetic first row's id — the composition, where the dimension
/// lists no unit for it. Not a base id, and deliberately unspellable as
/// one.
export const COMPOSED_ENTRY_ID = " composed";

/// The synthetic first row's id where there is no composition at all —
/// the caller's "derive it", offered so that an override is always
/// clearable. Like `COMPOSED_ENTRY_ID`, not a base id and deliberately
/// unspellable as one.
export const DERIVED_ENTRY_ID = " from the operands";

/// One row of the picker's first column, after the caller's context has
/// been folded in. A scale whose `unit` is `null` commits **nothing** —
/// the derivation, which is what an unset target is.
export interface PickerRow {
  id: string;
  display: string;
  dimensionLabel: string;
  scales: readonly PickerScale[];
}

export interface PickerScale extends Omit<UnitScale, "unit"> {
  unit: UnitId | null;
}

/// Are these the same unit? An absent prefix and an explicit `none` are
/// the same rung — the host omits the field for an unprefixed unit, so
/// both spellings arrive.
export function sameUnit(a: UnitId | null, b: UnitId | null): boolean {
  if (a == null || b == null) return a == b;
  return a.base === b.base && (a.prefix ?? "none") === (b.prefix ?? "none");
}

/// The rows to offer.
///
/// `kind` locks the picker to one dimension — every context that
/// *applies* a unit passes one, because choosing there is a real
/// conversion. `null` offers everything, which is reinterpretation: the
/// database's label was wrong about what the signal measures, so a
/// like-kind picker could not express the repair.
///
/// A `composition` earns a row only where its dimension lists no unit
/// for it (`Ah/s` is dimensionally a current and is no named unit). A
/// composition the table *does* name is already in the list — picking it
/// is how an override is cleared, which is the caller's rule and not a
/// second row here.
///
/// `clearable` says an override is in force, and it exists for the case
/// no composition covers: a set whose members mix dimensions derives
/// nothing, so neither kind of composition row is offered and an
/// override picked there would have nothing to clear it with. That row
/// commits nothing, exactly as a composition's does.
export function pickerEntries(
  model: readonly UnitPickerEntry[],
  kind: string | null,
  composition?: UnitPickerComposition,
  clearable?: boolean,
): PickerRow[] {
  const rows: PickerRow[] = model
    .filter((e) => kind === null || e.dimension === kind)
    .map((e) => ({
      id: e.id,
      display: e.display,
      dimensionLabel: e.dimensionLabel,
      scales: e.scales,
    }));
  if (composition && !rows.some((r) => sameUnit({ base: r.id }, composition.unit))) {
    rows.unshift({
      id: COMPOSED_ENTRY_ID,
      display: composition.label,
      dimensionLabel: "derived",
      scales: [{ unit: null, label: "", display: composition.label, exponent: null }],
    });
  } else if (clearable && !composition) {
    rows.unshift({
      id: DERIVED_ENTRY_ID,
      display: "derived",
      dimensionLabel: "derived",
      scales: [{ unit: null, label: "", display: "derived", exponent: null }],
    });
  }
  return rows;
}

/// Which row `unit` sits on, or `null` where nothing offered holds it.
/// Nothing set selects the composition row where there is one — that is
/// what "derived" looks like in the first column.
export function selectedEntryId(
  rows: readonly PickerRow[],
  unit: UnitId | null,
): string | null {
  const hit = rows.find((r) => r.scales.some((s) => sameUnit(s.unit, unit)));
  return hit?.id ?? null;
}

/// The unit to commit when a base row is clicked: the current prefix
/// carried over where the new base offers it, and the base's own
/// unprefixed rung otherwise.
///
/// Carrying the prefix is what makes `mV` → `mA` one click; a base with
/// no ladder (°C, `km/h`) has one rung and takes it.
export function rebase(entry: UnitPickerEntry, current: UnitId | null): UnitId {
  const prefix = current?.prefix ?? "none";
  const kept = entry.scales.find((s) => (s.unit.prefix ?? "none") === prefix);
  const bare = entry.scales.find((s) => (s.unit.prefix ?? "none") === "none");
  return (kept ?? bare ?? entry.scales[0]).unit;
}

/// The scale row `unit` is on this entry, or `undefined`.
export function scaleFor(
  entry: UnitPickerEntry,
  unit: UnitId | null,
): UnitScale | undefined {
  return entry.scales.find((s) => sameUnit(s.unit, unit));
}

/// How a typed unit reads, as the host spells it. `undefined` where the
/// model carries no such unit — the frontend never composes a spelling
/// of its own, so there is nothing to fall back to.
export function unitDisplay(
  model: readonly UnitPickerEntry[],
  unit: UnitId | null,
): string | undefined {
  if (unit == null) return undefined;
  for (const entry of model) {
    const scale = scaleFor(entry, unit);
    if (scale) return scale.display;
  }
  return undefined;
}

const SUPERSCRIPTS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/// How a scale row states its factor — `×1`, `×10⁻³`, `×10²⁴`. Empty
/// for a scale that is not a power of ten, which has nothing to state.
export function formatScaleFactor(exponent: number | null | undefined): string {
  if (exponent == null) return "";
  if (exponent === 0) return "×1";
  const digits = [...String(Math.abs(exponent))]
    .map((d) => SUPERSCRIPTS[Number(d)])
    .join("");
  return `×10${exponent < 0 ? "⁻" : ""}${digits}`;
}
