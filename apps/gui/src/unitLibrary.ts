// The unit library, as the host's `units` facade lists it for a picker.
//
// Which units exist, how they group, and how each is spelled are the
// host's answers — this module holds no table of its own. It is the
// same shape `hostSettings` takes for the same reason: several
// unrelated views need the list (the math editor's target and
// source-unit pickers, the settings view's units section), it never
// changes while the app runs, so it is hydrated once before first render
// and read synchronously thereafter.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { ComboboxOption } from "./Combobox";
import type { UnitId } from "./types";

/// One unit as `units::list_units` serves it.
export interface UnitInfo {
  /// The stable id — what a unit *id* field stores: a customization's
  /// value, a math operand's source-unit override.
  id: string;
  /// The label to show — `mV`, `°C`.
  display: string;
  /// The physical quantity, kebab-case; only units sharing one convert.
  dimension: string;
  /// The heading a picker groups this unit under.
  dimensionLabel: string;
  /// What to write where a unit *string* is stored (a math definition's
  /// target unit): the display form where the host recognises it back to
  /// this unit, the id otherwise. Never derived here — a display that is
  /// not a spelling of its own (`C`, between coulomb and Celsius) is the
  /// host's judgement to make.
  spelling: string;
}

/// One choice in the picker's **second** column, as
/// `units::UnitScale` serves it.
export interface UnitScale {
  /// What picking this commits — the whole unit identity.
  unit: UnitId;
  /// What the column shows: a prefix symbol, or a ratio scale's own
  /// words. Empty for the unprefixed rung, which renders as a dash.
  label: string;
  /// How the composed unit reads — `mV`, `nAh`, `%`. **Spelled by the
  /// host**: a view never composes a unit string.
  display: string;
  /// The power of ten this scale carries, for its `×10ⁿ`. Absent where
  /// the scale is not one rung of the SI ladder.
  exponent?: number | null;
}

/// One row of the picker's **first** column, as `units::UnitPickerEntry`
/// serves it: a base unit and the scales it takes. A unit's identity is
/// base × prefix, so a prefixed variant is a *scale* here and never a
/// row of its own.
export interface UnitPickerEntry {
  id: string;
  display: string;
  dimension: string;
  dimensionLabel: string;
  /// Never empty — a pick is always a whole unit.
  scales: UnitScale[];
}

let cache: readonly UnitInfo[] = [];
let pickerCache: readonly UnitPickerEntry[] = [];
const listeners = new Set<() => void>();

/// Load the library. Tolerant of no host (unit tests, a failed command):
/// an empty library renders pickers with nothing in them rather than
/// throwing.
export async function loadUnits(): Promise<readonly UnitInfo[]> {
  try {
    return (await invoke<UnitInfo[] | null>("list_units")) ?? [];
  } catch {
    return [];
  }
}

/// Load the base × prefix picker model, under the same tolerance.
export async function loadUnitPicker(): Promise<readonly UnitPickerEntry[]> {
  try {
    return (await invoke<UnitPickerEntry[] | null>("list_unit_picker")) ?? [];
  } catch {
    return [];
  }
}

/// Load the library into the in-memory cache and notify subscribers.
/// Called once before rendering. Both lists are one hydrate: they are
/// two readings of the same host table and nothing wants one without
/// the other.
export async function hydrateUnits(): Promise<void> {
  const [units, picker] = await Promise.all([loadUnits(), loadUnitPicker()]);
  cache = units;
  pickerCache = picker;
  for (const fn of [...listeners]) fn();
}

/// The library, synchronously.
export function unitLibrary(): readonly UnitInfo[] {
  return cache;
}

/// The base × prefix picker model, synchronously.
export function unitPickerModel(): readonly UnitPickerEntry[] {
  return pickerCache;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/// The library, re-rendering the caller when it arrives.
export function useUnitLibrary(): readonly UnitInfo[] {
  return useSyncExternalStore(subscribe, unitLibrary);
}

/// The picker model, re-rendering the caller when it arrives.
export function useUnitPickerModel(): readonly UnitPickerEntry[] {
  return useSyncExternalStore(subscribe, unitPickerModel);
}

/// The library as combobox options, grouped under their dimensions.
///
/// `valueOf` says which of a unit's two names the picker commits — its
/// `spelling` where a unit string is stored, its `id` where a unit id
/// is. A unit whose two differ says so in its label, because what the
/// row shows and what the field ends up holding are then not the same
/// word.
export function unitOptions(
  units: readonly UnitInfo[],
  valueOf: (unit: UnitInfo) => string,
): ComboboxOption[] {
  return units.map((unit) => ({
    value: valueOf(unit),
    label:
      valueOf(unit) === unit.display ? unit.display : `${unit.display} (${valueOf(unit)})`,
    path: [unit.dimensionLabel],
  }));
}
