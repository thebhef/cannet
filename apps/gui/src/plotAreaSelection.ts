/// The plot side panel's signal-row selection. Pure: no DOM, no React.
///
/// One selection per panel, and it names the logical plot area it
/// belongs to: a selection never spans two areas, so clicking a row in
/// another area starts that area's selection fresh rather than
/// extending across the stack. Within an area the gestures are the
/// gridview's (ADR 0044) over the area's ordered signal keys — plain
/// click replaces (and, at the call site, promotes the row to primary),
/// Ctrl/Cmd+click toggles membership, Shift+click takes the range from
/// the anchor. Mouse only; both the set and the anchor are transient
/// view state, never persisted with the panel's params.

import { arrayRowSpace, cursorAction, type GridviewRow } from "./gridviewRows";
import {
  EMPTY_SELECTION,
  extendToCursor,
  selectOnClick,
  type GridviewClickModifiers,
} from "./gridviewSelection";

export interface PlotSignalSelection {
  /// The logical area the selection belongs to. `null` while nothing is
  /// selected.
  areaId: string | null;
  /// The selected rows, by signal key (`signalRefKey`).
  ids: ReadonlySet<string>;
  /// The row a range extends *from* — the last click that set one. Kept
  /// across Shift gestures, so successive ranges run from one point.
  anchor: string | null;
  /// The row a range extends *to* — where the last click landed, and
  /// what Shift+Up/Down steps from. Separate from the anchor because
  /// only one of the two moves under a range gesture.
  cursor: string | null;
}

export const NO_PLOT_SIGNAL_SELECTION: PlotSignalSelection = {
  areaId: null,
  ids: EMPTY_SELECTION.ids,
  anchor: null,
  cursor: null,
};

/// Apply a click on the signal row `key` of the logical area `areaId`.
/// `order` is that area's signal keys in the panel's canonical order —
/// across every derived axis, so a range spans the split a per-unit /
/// individual y-axis mode makes. A click on a key the area does not
/// hold changes nothing, and returns `current` itself.
export function selectPlotSignal(
  current: PlotSignalSelection,
  areaId: string,
  key: string,
  modifiers: GridviewClickModifiers,
  order: readonly string[],
): PlotSignalSelection {
  // A click in a different area starts from empty: neither the previous
  // area's set nor its anchor names a row this area holds, so carrying
  // either would only let a toggle or a range reach across areas.
  const base = current.areaId === areaId ? current : EMPTY_SELECTION;
  const next = selectOnClick(base, key, modifiers, order);
  if (next === base) return current;
  return { areaId, ids: next.ids, anchor: next.anchor, cursor: key };
}

/// Shift+Up / Shift+Down over the signal rows: step the cursor one row
/// within the area the selection belongs to and extend the range to it
/// (the gridview's rule, [`extendToCursor`], over this area's order).
/// The rows are a flat space, so the step is the gridview's own cursor
/// arithmetic over it — one movement rule for both, not a second copy.
///
/// Inert while nothing is selected: there is no area to move within and
/// no row to step from.
export function extendPlotSignalSelection(
  current: PlotSignalSelection,
  key: "ArrowUp" | "ArrowDown",
  order: readonly string[],
): PlotSignalSelection {
  if (current.areaId == null) return current;
  const rows: GridviewRow[] = order.map((id) => ({
    id,
    kind: "leaf",
    expandable: false,
    depth: 0,
  }));
  const action = cursorAction(arrayRowSpace(rows, () => false), current.cursor, key, 1);
  if (action.type !== "move" || action.id === current.cursor) return current;
  const next = extendToCursor(current, current.cursor, action.id, order);
  return { areaId: current.areaId, ids: next.ids, anchor: next.anchor, cursor: action.id };
}
