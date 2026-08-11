/// The gridview's selection model (ADR 0044). Pure: no DOM, no React.
///
/// Selection is separate from the cursor and is built with the mouse —
/// plain click replaces, Ctrl/Cmd+click toggles, Shift+click replaces
/// the selection with the range from the click anchor, Ctrl+Shift+click
/// *adds* that same range, Ctrl/Cmd+A takes everything selectable.
/// There is no keyboard multiselect. Both the set and the anchor are
/// ephemeral — never persisted.
///
/// [`selectOnClick`] is written against an ordered list of ids rather
/// than the row space, so it is the click reducer for any mouse-built
/// selection, gridview or not — the plot panel's per-area signal
/// selection (`plotAreaSelection.ts`) is the other caller.

import type { GridviewRow, GridviewRowSpace } from "./gridviewRows";

export interface GridviewSelection {
  /// The selected rows, by stable id.
  ids: ReadonlySet<string>;
  /// The row the last click landed on — where an additive range
  /// extends from. `null` before the first click.
  anchor: string | null;
}

export const EMPTY_SELECTION: GridviewSelection = { ids: new Set(), anchor: null };

/// The modifiers a click carries. `mod` is the platform's primary
/// modifier — Cmd on mac, Ctrl elsewhere — matching the command
/// framework's `Mod` (`keybindings.ts`).
export interface GridviewClickModifiers {
  mod: boolean;
  shift: boolean;
}

/// The selectable rows in display order — what a range walks and what
/// select-all takes. Which rows qualify is the adapter's declaration.
export function selectableIdsInOrder(
  space: GridviewRowSpace,
  isSelectable: (row: GridviewRow) => boolean,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < space.count; i += 1) {
    const id = space.rowIdAt(i);
    const row = id == null ? null : space.rowAt(id);
    if (row != null && isSelectable(row)) out.push(row.id);
  }
  return out;
}

/// Apply a click on `id`. `order` is [`selectableIdsInOrder`]; a click
/// on a row that isn't in it changes nothing, so an unselectable
/// container can be clicked (to expand, to move the cursor) without
/// disturbing the selection.
export function selectOnClick(
  current: GridviewSelection,
  id: string,
  modifiers: GridviewClickModifiers,
  order: readonly string[],
): GridviewSelection {
  if (!order.includes(id)) return current;

  // Either range chord: the rows from the anchor to the target,
  // inclusive. `null` when there is no usable anchor — none has been
  // set yet, or it has left the row space — and then each chord falls
  // back to what a click on the target alone means.
  if (modifiers.shift) {
    const range = anchorRange(current.anchor, id, order);
    // Ctrl+Shift+click: *add* the range. Additive, so a noncontiguous
    // selection accumulates.
    if (modifiers.mod) {
      if (range == null) return { ids: new Set([...current.ids, id]), anchor: id };
      return { ids: new Set([...current.ids, ...range]), anchor: current.anchor };
    }
    // Shift+click: *replace* the selection with the range — the
    // file-explorer gesture.
    if (range == null) return { ids: new Set([id]), anchor: id };
    // The anchor is kept by both, so a follow-up range extends from the
    // same point rather than from the last target.
    return { ids: new Set(range), anchor: current.anchor };
  }

  // Ctrl/Cmd+click: toggle this row, and anchor here so a follow-up
  // range extends from it.
  if (modifiers.mod) {
    const ids = new Set(current.ids);
    if (!ids.delete(id)) ids.add(id);
    return { ids, anchor: id };
  }

  // Plain click replaces the selection.
  return { ids: new Set([id]), anchor: id };
}

/// The contiguous run of selectable rows between the anchor and the
/// target, or `null` when the anchor names no row `order` holds.
function anchorRange(
  anchor: string | null,
  id: string,
  order: readonly string[],
): string[] | null {
  const anchorAt = anchor == null ? -1 : order.indexOf(anchor);
  if (anchorAt < 0) return null;
  const targetAt = order.indexOf(id);
  const [lo, hi] = anchorAt <= targetAt ? [anchorAt, targetAt] : [targetAt, anchorAt];
  return order.slice(lo, hi + 1);
}

/// Ctrl/Cmd+A: every selectable row. The anchor is left alone — the
/// user's last click still says where a range would extend from.
export function selectAll(
  current: GridviewSelection,
  order: readonly string[],
): GridviewSelection {
  return { ids: new Set(order), anchor: current.anchor };
}

/// Collapse the selection onto the cursor's row — what a cursor move
/// does (single-select-follows-focus). Pass `null` for a cursor sitting
/// on a row the adapter doesn't allow to be selected; the selection
/// clears rather than picking up an unselectable row.
export function collapseToCursor(id: string | null): GridviewSelection {
  return id == null ? EMPTY_SELECTION : { ids: new Set([id]), anchor: id };
}
