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

let cache: readonly UnitInfo[] = [];
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

/// Load the library into the in-memory cache and notify subscribers.
/// Called once before rendering.
export async function hydrateUnits(): Promise<void> {
  cache = await loadUnits();
  for (const fn of [...listeners]) fn();
}

/// The library, synchronously.
export function unitLibrary(): readonly UnitInfo[] {
  return cache;
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
