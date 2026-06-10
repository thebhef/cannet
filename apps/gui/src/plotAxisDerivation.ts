/**
 * Plot-area → axis derivation (ADR 0026 task 15).
 *
 * A plot area carries a **y-axis mode** that decides how its signals
 * lay out across one or more axes:
 *
 * - `unified` — one axis; all series overlaid. (Within the axis,
 *   signals are grouped by unit and each group auto-scales
 *   independently, but that's a render-time concern; the *derivation*
 *   produces a single axis.)
 * - `per-unit` — one axis per distinct unit. Series sharing a unit
 *   live on the same axis. Per the ADR an *enum* series (i.e. one
 *   carrying a `VAL_` table) gets its own axis even when its raw unit
 *   matches another signal's, because its render style is a logic-
 *   analyzer lane. Enum-ness isn't on the bare `SignalRef`; callers
 *   pass an `isEnum(key)` predicate.
 * - `individual` — one axis per series.
 *
 * The derivation is a pure function so it can be unit-tested without
 * uPlot / React.
 */
import type { SignalRef } from "./PlotPanel";
import { signalKey } from "./plotData";

export type YAxisMode = "unified" | "per-unit" | "individual";

/** Output of deriving one axis from a plot area's signals + mode.
 * Each axis maps to one uPlot instance (ADR 0026). */
export interface DerivedAxis {
  /** Stable id, unique within the panel. For unified it's the area's
   * id (so saved cursor/zoom state stays anchored); for the other
   * modes it carries a per-group suffix. */
  id: string;
  /** The plot area this axis belongs to — used to dispatch edits
   * (add/remove/colour-pick signal) back to the underlying area. */
  parentAreaId: string;
  /** Human-readable subtitle for the axis (per-unit / individual
   * modes). `null` in unified mode, where the area's own label is
   * the only label. */
  subtitle: string | null;
  /** The series this axis renders. */
  signals: SignalRef[];
}

/** Stable key for a signal — the canonical `signalKey` from
 * `plotData`, so keys here (axis ids, the `isEnum` lookup) match the
 * keys the panel uses everywhere else, including the `x:`/`s:`
 * extended-id discriminator. */
function signalRefKey(s: SignalRef): string {
  return signalKey(s.busId, s.messageId, s.extended, s.signalName);
}

/** Derive the axes that should be drawn for one plot area.
 *
 * `isEnum` is consulted in `per-unit` mode to break an enum out onto
 * its own axis (it still has its raw unit, but the lane render style
 * needs the dedicated y scale). When it's omitted the function treats
 * everything as numeric — the panel passes a real predicate.
 *
 * Empty-area edge case: returns one axis with no signals so the area
 * still draws its empty canvas. */
export function deriveAxesForArea(
  areaId: string,
  signals: SignalRef[],
  mode: YAxisMode,
  isEnum?: (key: string) => boolean,
): DerivedAxis[] {
  if (signals.length === 0 || mode === "unified") {
    return [{ id: areaId, parentAreaId: areaId, subtitle: null, signals }];
  }
  if (mode === "individual") {
    return signals.map((s) => ({
      id: `${areaId}/i:${signalRefKey(s)}`,
      parentAreaId: areaId,
      subtitle: s.signalName,
      signals: [s],
    }));
  }
  // per-unit: group by unit (empty unit → "·"), but break each enum
  // out onto its own axis.
  const order: string[] = [];
  const groups = new Map<string, SignalRef[]>();
  let enumIdx = 0;
  for (const s of signals) {
    const key = signalRefKey(s);
    const groupKey =
      isEnum && isEnum(key)
        ? `enum:${key}:${enumIdx++}` // each enum lands in its own bucket
        : `unit:${s.unit || ""}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
      order.push(groupKey);
    }
    groups.get(groupKey)!.push(s);
  }
  return order.map((key) => {
    const group = groups.get(key)!;
    const isEnumGroup = key.startsWith("enum:");
    const subtitle = isEnumGroup
      ? `${group[0].signalName} (enum)`
      : group[0].unit
        ? `[${group[0].unit}]`
        : "(unitless)";
    return {
      id: `${areaId}/u:${key}`,
      parentAreaId: areaId,
      subtitle,
      signals: group,
    };
  });
}
