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
import { signalRefKey, type SignalRef } from "./plotPanelConfig";

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
   * (add/remove/color-pick signal) back to the underlying area. */
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

/**
 * Stabilise the y-axis gutter width against per-frame label churn.
 *
 * uPlot re-runs `axis.size` on every layout pass, and the numeric
 * y-axis sizes itself from the *current* tick strings. Under follow-live
 * the scale auto-fits, so those strings change width constantly
 * (`1.2` → `12.5` → `125`) — the gutter grows and shrinks, the plot's
 * left edge moves with it, and every fixed-time feature inside the box
 * (gridlines, enum tiles, their labels) shifts left and right in
 * lockstep. Sizing the gutter is a layout decision, not a per-frame
 * readout, so it needs hysteresis.
 *
 * Grow immediately — labels must fit or they run off the canvas. Shrink
 * only once `needed` is a comfortable `hysteresis` px below what's
 * already reserved, so ordinary digit-width wobble stays inside the
 * band and the layout holds still. `current` is `null` on the first
 * pass, which takes `needed` as-is.
 */
export function axisGutterWidth(
  needed: number,
  current: number | null,
  hysteresis: number,
): number {
  if (current == null || needed > current) return needed;
  return needed < current - hysteresis ? needed : current;
}

/** Slack (px) the y-gutter keeps before giving width back. Wide enough
 * to swallow a digit's worth of tick-label churn, narrow enough that a
 * genuinely shorter axis still reclaims the space. */
export const GUTTER_HYSTERESIS_PX = 12;

/** Panel-wide y-gutter agreement. See {@link createGutterCoordinator}. */
export interface GutterCoordinator {
  /** Record what `areaId`'s axis needs, and return the width it should
   * actually reserve. Called from uPlot's `axis.size`, every layout
   * pass, for every axis in the panel. */
  report(areaId: string, needed: number): number;
  /** Drop a destroyed axis so its width stops holding the panel wide. */
  forget(areaId: string): void;
}

/**
 * One y-gutter width for every stacked axis in a panel: the widest any
 * one of them asks for.
 *
 * The stack draws a single shared x window, so the plot boxes have to
 * begin at the same x — otherwise the shared cursors, the x gridlines
 * and the enum tiles all sit at the right *time* but the wrong *pixel*,
 * and nothing lines up down the stack. The left edge is set by each
 * axis's own y-gutter, and those legitimately differ: a numeric axis
 * sizes itself to its tick labels, the enum-lanes axis asks for a bare
 * strip because its tiles carry the labels (ADR 0026). Taking the max
 * costs the narrow axes some blank gutter, which is the price of a
 * collinear cursor.
 *
 * Hysteresis (via {@link axisGutterWidth}) applies to the max, so every
 * axis latches together rather than each drifting on its own.
 *
 * `onChange` fires when the agreed width moves. A report arrives from
 * inside one axis's layout pass, so the *others* won't see the new
 * width until their next one — the caller uses this to nudge them, and
 * gets one call per actual change rather than one per report.
 */
export function createGutterCoordinator(
  hysteresis: number,
  onChange: (width: number) => void = () => {},
): GutterCoordinator {
  const needs = new Map<string, number>();
  let width: number | null = null;
  const settle = (): void => {
    let max: number | null = null;
    for (const v of needs.values()) max = max == null ? v : Math.max(max, v);
    // No axis left to size from: hold the last agreed width rather than
    // resetting, so the next axis to mount doesn't re-converge from
    // scratch (and flash a wrong-width gutter doing it).
    if (max == null) return;
    const next = axisGutterWidth(max, width, hysteresis);
    if (next === width) return;
    width = next;
    onChange(next);
  };
  return {
    report(areaId, needed) {
      needs.set(areaId, needed);
      settle();
      return width ?? needed;
    },
    forget(areaId) {
      if (needs.delete(areaId)) settle();
    },
  };
}
