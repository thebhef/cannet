/// **Per-series display units** for a plot panel (ADR 0026): the unit a
/// series is read in, where the user converted it through the side
/// list's readout chip.
///
/// The choice itself is view state and persists per series in the plot
/// panel's config (`SignalRef.displayUnit`, a typed unit). Everything
/// else is the host's and is asked for in one call — what a declared
/// unit string means, the family a kind-locked picker offers, the
/// spelling the result reads as, and the affine that carries a value
/// there (`resolve_display_units`, ADR 0025). This module holds the
/// fetch, the cache key, and the two pure applications the renderer
/// makes of the answer.
///
/// Converting is a **real conversion**, unlike the View-signals panel's
/// reinterpretation: the values drawn and the extents the axis scales to
/// both go through the affine, and the series joins the lane of the unit
/// it now reads in — which is how the affordance converges per-unit
/// lanes (an mV series joins the V lane at ÷1000).

import { invoke } from "@tauri-apps/api/core";

import { signalRefKey, type SignalRef } from "./plotPanelConfig";
import { recordSignalKey, type RawSeries } from "./plotData";
import type {
  MathSignalRecord,
  SignalDescriptorRecord,
  UnitAffine,
  UnitId,
} from "./types";

/// How one series reads and converts, as `resolve_display_units`
/// answers it.
export interface SeriesDisplayUnit {
  /// The unit its declared string places — what the chip's picker opens
  /// on before anything is chosen. `null` where nothing places it, which
  /// is also why no conversion is possible.
  source: UnitId | null;
  /// The dimension a kind-locked picker offers against; `null` disables
  /// the affordance.
  kind: string | null;
  /// How the series reads after the choice.
  display: string;
  /// Declared unit → display unit. The identity where nothing was
  /// chosen, and **also** where a choice cannot be reached: a view never
  /// rescales by a factor nothing computed.
  affine: UnitAffine;
}

/// The unit a series is **read in**, as the host answers it — the
/// catalog's typed unit for a DBC or file-backed signal, the resolved
/// one for a math signal, and `null` where nothing places one.
///
/// Passing this rather than letting the host re-read `SignalRef.unit` is
/// the whole point: the stored spelling is one-way. A series
/// reinterpreted as a coulomb reads `C`, which the host refuses to read
/// back, so a query carrying only the spelling could convert nothing.
export type SeriesUnitSource = (s: SignalRef) => UnitId | null;

/// The default when no catalog is at hand (tests, a panel whose catalog
/// has not arrived): nothing placed, and the host falls back to reading
/// the declared string.
const noSource: SeriesUnitSource = () => null;

/// The {@link SeriesUnitSource} the host's own answers make: the
/// catalog's typed unit per DBC or file-backed signal, and the resolved
/// one per math signal (keyed by the identity the host stamps, which is
/// the same `signalKey` a plotted ref composes).
///
/// A signal neither list holds — a database unloaded under a saved
/// layout — places nothing, which is exactly what it means.
export function seriesUnitSources(
  catalog: readonly SignalDescriptorRecord[],
  math: readonly MathSignalRecord[],
): SeriesUnitSource {
  const placed = new Map<string, UnitId>();
  for (const s of catalog) {
    if (s.unit_typed) placed.set(recordSignalKey(s), s.unit_typed);
  }
  for (const m of math) {
    if (m.unitTyped) placed.set(m.identity, m.unitTyped);
  }
  return (s) => placed.get(signalRefKey(s)) ?? null;
}

function sourceTag(unit: UnitId | null): string {
  return unit ? `${unit.base}:${unit.prefix ?? ""}` : "";
}

/// The identity of one fetch: the facts the answer depends on, **sorted**
/// so it does not depend on the order the panel happens to hold its rows
/// in. Used as a memo key, so a redraw that changed neither a series'
/// unit nor a display choice re-asks nothing — and neither does a
/// reorder, a recolor or a hide, each of which would otherwise churn the
/// answer map and re-render every area in the panel.
///
/// The placed unit is part of it: reinterpreting a signal moves what the
/// host answers without touching the spelling a saved layout stored.
export function displayUnitsKey(
  signals: readonly SignalRef[],
  sourceOf: SeriesUnitSource = noSource,
): string {
  return signals
    .map((s) => {
      const chosen = s.displayUnit;
      return `${signalRefKey(s)} ${s.unit} ${sourceTag(sourceOf(s))} ${
        chosen ? sourceTag(chosen) : ""
      }`;
    })
    .sort()
    .join("");
}

/// Ask the host how each series reads and converts.
///
/// Tolerant of no host (unit tests, a failed command): an empty map
/// leaves every series reading as its database declared it, which is
/// exactly what a panel with no display choices does anyway.
export async function loadDisplayUnits(
  signals: readonly SignalRef[],
  sourceOf: SeriesUnitSource = noSource,
): Promise<Map<string, SeriesDisplayUnit>> {
  const out = new Map<string, SeriesDisplayUnit>();
  if (signals.length === 0) return out;
  try {
    const answers = await invoke<SeriesDisplayUnit[] | null>("resolve_display_units", {
      series: signals.map((s) => ({
        source: sourceOf(s),
        declared: s.unit,
        chosen: s.displayUnit ?? null,
      })),
    });
    (answers ?? []).forEach((a, i) => {
      const s = signals[i];
      if (s) out.set(signalRefKey(s), a);
    });
  } catch {
    /* no host: every series reads as declared */
  }
  return out;
}

/// How a series reads: its display unit's spelling, and the string its
/// database declared where nothing has been chosen or nothing answered.
export function displayUnitOf(
  units: ReadonlyMap<string, SeriesDisplayUnit>,
  s: SignalRef,
): string {
  return units.get(signalRefKey(s))?.display ?? s.unit;
}

/// The affine a series' values are drawn through — the identity for a
/// series nothing converted, which the callers below skip outright.
export function displayAffineOf(
  units: ReadonlyMap<string, SeriesDisplayUnit>,
  key: string,
): UnitAffine | null {
  const affine = units.get(key)?.affine;
  if (!affine || (affine.gain === 1 && affine.offset === 0)) return null;
  return affine;
}

/// One paged series' values carried into its display unit.
///
/// Returns the series unchanged where nothing converts, so the common
/// case allocates nothing and the arrays the cache handed over are not
/// copied. The time base is untouched: a unit conversion is about
/// values.
export function convertSeries(series: RawSeries, affine: UnitAffine | null): RawSeries {
  if (!affine) return series;
  return {
    ...series,
    v: series.v.map((v) => v * affine.gain + affine.offset),
  };
}

/// A host-served `(lo, hi)` extent carried into the display unit.
///
/// A negative gain would swap the ends, so they are re-ordered — an
/// extent is a pair of bounds, not a pair of readings.
export function convertExtent<T extends { lo: number; hi: number }>(
  extent: T,
  affine: UnitAffine | null,
): T {
  if (!affine) return extent;
  const a = extent.lo * affine.gain + affine.offset;
  const b = extent.hi * affine.gain + affine.offset;
  return { ...extent, lo: Math.min(a, b), hi: Math.max(a, b) };
}
