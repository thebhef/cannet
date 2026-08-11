/**
 * Plot-area transfer between plot panels (ADR 0045): what a plot-area
 * drag carries, how a receiving panel keys it, and how the source panel
 * learns the area it gave up.
 *
 * A plot-area drag writes the whole serialized area — series, patterns,
 * y-axis mode, primary signal, collapsed flag — plus the *source
 * panel's* manual y ranges for the axes that area derives, so a move
 * lands looking like what left. Layout weights are not part of it: they
 * describe the stack the area came out of, not the area.
 *
 * The drop is the only place that knows whether the gesture was a move
 * (the area leaves its source) or a copy, so removal is driven from the
 * target: it {@link claimPlotArea}s the area from the source panel,
 * which is subscribed by id. A drag that ends anywhere else — cancelled,
 * or dropped on some other panel as the degraded signal payload — never
 * claims, so the source keeps its area.
 *
 * Pure except for the claim registry, which is a plain
 * subscriber map with no React in it.
 */
import { axisScalesFromRaw, type AxisScales } from "./plotAxisScale";
import { PLOT_AREA_DND_MIME, areasFromParams, type PlotAreaConfig } from "./plotPanelConfig";

/** One plot-area drag's cargo. */
export interface PlotAreaDragPayload {
  /** The dragged area exactly as its panel persists it. */
  area: PlotAreaConfig;
  /** The source panel's manual y ranges for this area's derived axes,
   * keyed as they were there ({@link areaAxisScales}). */
  axisScales: AxisScales;
  /** The panel the area came from — how the receiver tells a same-panel
   * reorder from a cross-panel move, and whom to claim the area from. */
  sourcePanelId: string;
}

/** Write a plot-area drag onto the event's `DataTransfer`. Both drop
 * effects are allowed so the copy cursor is available for a Ctrl-drag;
 * which one applies is decided at drop time, from the drop event. */
export function setPlotAreaDragData(
  e: { dataTransfer: DataTransfer },
  payload: PlotAreaDragPayload,
): void {
  e.dataTransfer.setData(PLOT_AREA_DND_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = "copyMove";
}

/** Parse a plot-area drag payload. `null` for anything unparseable or
 * missing a half the receiver needs, so a drop can no-op uniformly. */
export function parsePlotAreaDragData(raw: string): PlotAreaDragPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as { area?: unknown; axisScales?: unknown; sourcePanelId?: unknown };
  if (typeof o.area !== "object" || o.area === null) return null;
  if (typeof o.sourcePanelId !== "string") return null;
  // The persisted-area parser is the one definition of what an area
  // is — a transferred area goes through exactly the same tolerance
  // (and the same field set) as one read back off a saved project.
  return {
    area: areasFromParams([o.area])[0],
    axisScales: axisScalesFromRaw(o.axisScales),
    sourcePanelId: o.sourcePanelId,
  };
}

/** True when `key` is a derived-axis id belonging to `areaId` — the
 * area's own id (the unified axis) or one of its `${areaId}/…`
 * suffixes (`plotAxisDerivation.ts`). */
function belongsToArea(key: string, areaId: string): boolean {
  return key === areaId || key.startsWith(`${areaId}/`);
}

/** The slice of a panel's manual y ranges that belongs to one area —
 * what travels with it. */
export function areaAxisScales(scales: AxisScales, areaId: string): AxisScales {
  const out: AxisScales = {};
  for (const [k, v] of Object.entries(scales)) {
    if (belongsToArea(k, areaId)) out[k] = v;
  }
  return out;
}

/** Re-key an area's manual y ranges onto a different area id. A move
 * carries the area's id with it, so its keys land unchanged; a copy
 * gets a fresh id, and its ranges have to follow it. */
export function rekeyAxisScales(
  scales: AxisScales,
  fromAreaId: string,
  toAreaId: string,
): AxisScales {
  const out: AxisScales = {};
  for (const [k, v] of Object.entries(scales)) {
    out[belongsToArea(k, fromAreaId) ? `${toAreaId}${k.slice(fromAreaId.length)}` : k] = v;
  }
  return out;
}

/** A copy of an area under a fresh id — a Ctrl-drag between panels, so
 * source and copy are two areas and not one shared identity. */
export function copyOfArea(area: PlotAreaConfig): PlotAreaConfig {
  return {
    ...area,
    id: crypto.randomUUID(),
    signals: area.signals.map((s) => ({ ...s })),
    patterns: area.patterns ? [...area.patterns] : undefined,
  };
}

/** Insert a transferred area where the drop landed: at the target
 * area's position, pushing it down. An unknown target (the stack moved
 * under the drag) appends. */
export function insertAreaAt(
  areas: PlotAreaConfig[],
  area: PlotAreaConfig,
  targetId: string,
): PlotAreaConfig[] {
  const at = areas.findIndex((a) => a.id === targetId);
  const next = areas.slice();
  next.splice(at < 0 ? next.length : at, 0, area);
  return next;
}

/** Panels that can be asked to give up an area, by element id. One
 * mounted panel per id, so a plain map is the whole registry. */
const claimHandlers = new Map<string, (areaId: string) => void>();

/** Subscribe a panel to move-claims against it. Returns the
 * unsubscribe, for the effect's cleanup. */
export function onPlotAreaClaimed(
  panelId: string,
  handler: (areaId: string) => void,
): () => void {
  claimHandlers.set(panelId, handler);
  return () => {
    // Guard against remount ordering: a late cleanup from the previous
    // instance must not clobber the new registration.
    if (claimHandlers.get(panelId) === handler) claimHandlers.delete(panelId);
  };
}

/** Tell `sourcePanelId` that `areaId` has moved out of it. `false` when
 * that panel isn't mounted — the drop still stands, there is simply
 * nothing left to remove the area from. */
export function claimPlotArea(sourcePanelId: string, areaId: string): boolean {
  const handler = claimHandlers.get(sourcePanelId);
  if (!handler) return false;
  handler(areaId);
  return true;
}
