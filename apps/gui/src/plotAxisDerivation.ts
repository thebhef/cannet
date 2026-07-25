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
 *   live on the same axis. Per the ADR every *enum* series (i.e. one
 *   carrying a `VAL_` table) is pulled off its unit axis and onto a
 *   single shared **enum-lanes** axis for the area (logic-analyzer
 *   style, ADR 0026), positioned where the first enum appeared.
 *   Enum-ness isn't on the bare `SignalRef`; callers pass an
 *   `isEnum(key)` predicate.
 * - `individual` — one axis per series.
 *
 * The derivation is a pure function so it can be unit-tested without
 * uPlot / React.
 */
import type { SignalRef } from "./PlotPanel";
import { signalKey } from "./plotData";

export type YAxisMode = "unified" | "per-unit" | "individual";

/** How an axis renders its series. `numeric` is the ordinary
 * lines-on-a-shared-y axis; `enum-lanes` is the combined per-unit enum
 * axis drawn as stacked logic-analyzer lanes (ADR 0026). */
export type DerivedAxisKind = "numeric" | "enum-lanes";

/** Output of deriving one axis from a plot area's signals + mode.
 * Each axis maps to one uPlot instance (ADR 0026). */
export interface DerivedAxis {
  /** Stable id, unique within the panel. For unified it's the area's
   * id (so saved cursor/zoom state stays anchored); for the other
   * modes it carries a per-group suffix. The shared enum-lanes axis
   * uses `${areaId}/u:enum` (no signal keys), so its identity — and
   * thus its persisted weight — survives lane-membership churn. */
  id: string;
  /** The plot area this axis belongs to — used to dispatch edits
   * (add/remove/colour-pick signal) back to the underlying area. */
  parentAreaId: string;
  /** Render style for this axis (ADR 0026). */
  kind: DerivedAxisKind;
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
    return [{ id: areaId, parentAreaId: areaId, kind: "numeric", subtitle: null, signals }];
  }
  if (mode === "individual") {
    return signals.map((s) => ({
      id: `${areaId}/i:${signalRefKey(s)}`,
      parentAreaId: areaId,
      kind: "numeric",
      subtitle: s.signalName,
      signals: [s],
    }));
  }
  // per-unit: group by unit (empty unit → "·"), but pull every enum
  // onto one shared enum-lanes axis, positioned at the first enum.
  const order: string[] = [];
  const groups = new Map<string, SignalRef[]>();
  for (const s of signals) {
    const key = signalRefKey(s);
    const groupKey = isEnum && isEnum(key) ? "enum" : `unit:${s.unit || ""}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
      order.push(groupKey);
    }
    groups.get(groupKey)!.push(s);
  }
  return order.map((key) => {
    const group = groups.get(key)!;
    const isEnumGroup = key === "enum";
    const subtitle = isEnumGroup
      ? group.length === 1
        ? `${group[0].signalName} (enum)`
        : "(enums)"
      : group[0].unit
        ? `[${group[0].unit}]`
        : "(unitless)";
    return {
      id: isEnumGroup ? `${areaId}/u:enum` : `${areaId}/u:${key}`,
      parentAreaId: areaId,
      kind: isEnumGroup ? "enum-lanes" : "numeric",
      subtitle,
      signals: group,
    };
  });
}
