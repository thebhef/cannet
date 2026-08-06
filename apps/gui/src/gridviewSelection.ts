/// The gridview's selection model (ADR 0044). Pure: no DOM, no React.
///
/// Selection is separate from the cursor and is built with the mouse —
/// plain click replaces, Ctrl/Cmd+click toggles, Ctrl+Shift+click adds
/// the range from the click anchor, Ctrl/Cmd+A takes everything
/// selectable. There is no keyboard multiselect and plain Shift+click
/// carries no special meaning. Both the set and the anchor are
/// ephemeral — never persisted.

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

  // Ctrl+Shift+click: *add* the anchor→target range. Additive, so a
  // noncontiguous selection accumulates, and the anchor is kept so a
  // follow-up range extends from the same point rather than from the
  // last target.
  if (modifiers.mod && modifiers.shift) {
    const anchorAt = current.anchor == null ? -1 : order.indexOf(current.anchor);
    if (anchorAt < 0) {
      // No anchor yet (or it has left the row space): the clicked row
      // is the whole range, and becomes the anchor.
      return { ids: new Set([...current.ids, id]), anchor: id };
    }
    const targetAt = order.indexOf(id);
    const [lo, hi] = anchorAt <= targetAt ? [anchorAt, targetAt] : [targetAt, anchorAt];
    return {
      ids: new Set([...current.ids, ...order.slice(lo, hi + 1)]),
      anchor: current.anchor,
    };
  }

  // Ctrl/Cmd+click: toggle this row, and anchor here so a follow-up
  // range extends from it.
  if (modifiers.mod) {
    const ids = new Set(current.ids);
    if (!ids.delete(id)) ids.add(id);
    return { ids, anchor: id };
  }

  // Plain click — and plain Shift+click, which is deliberately
  // unassigned in v1 — replaces the selection.
  return { ids: new Set([id]), anchor: id };
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
