/// The gridview container hook (ADR 0044): binds the pure row-space
/// cursor arithmetic (`gridviewRows.ts`) and the selection model
/// (`gridviewSelection.ts`) to a real DOM container.
///
/// Headless by design — it returns props and state, never markup. The
/// panel keeps its own rendering and scrolling; the two virtualizers
/// and the non-virtualized panels sit unchanged beneath one interaction
/// model.

import { useCallback, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { GRIDVIEW_ATTR } from "./keybindings";
import {
  cursorAction,
  type GridviewAdapter,
  type GridviewNavKey,
} from "./gridviewRows";
import {
  EMPTY_SELECTION,
  collapseToCursor,
  selectAll,
  selectOnClick,
  selectableIdsInOrder,
  type GridviewClickModifiers,
} from "./gridviewSelection";

/// Stable empty extras, so the default doesn't hand `useCallback` a
/// fresh array on every render.
const EMPTY_EXTRAS: readonly string[] = [];

const NAV_KEYS = new Set<string>([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export interface UseGridviewOptions {
  /// The panel's row space plus the operations only it can perform.
  adapter: GridviewAdapter;
  /// How many rows the viewport holds — what PageUp/PageDown move by.
  pageRows: number;
  /// Namespace for the row DOM ids `aria-activedescendant` points at.
  /// Unique per panel instance, so two gridviews on screen can't name
  /// each other's rows.
  idPrefix: string;
  /// Space: the panel's primary action on the cursor's row. Most
  /// panels define none — expansion is already Left/Right's job, so
  /// the layer binds no default. Enter is deliberately left unbound
  /// for the user's own keybindings.
  onPrimaryAction?: (id: string) => void;
  /// Selectable items that are **not** rows of the scrolled space,
  /// appended to the selection order after them: ADR 0045's pattern
  /// chips, which are "selectable items in the same selection set as
  /// rows" so one drag can carry both kinds. They take no part in the
  /// cursor — there is nothing to arrow onto — only in the selection.
  extraSelectableIds?: readonly string[];
}

/// Props the panel spreads onto its container element. The container —
/// not a row — holds DOM focus: rows are recycled or absent entirely in
/// the paged viewports, so the active row is *named* rather than
/// focused.
export interface GridviewContainerProps {
  tabIndex: number;
  "aria-activedescendant": string | undefined;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  [GRIDVIEW_ATTR]: string;
}

export interface Gridview {
  /// The active row's id, or `null` before the first move.
  cursor: string | null;
  /// The selected rows' ids. Ephemeral — never persisted.
  selection: ReadonlySet<string>;
  containerProps: GridviewContainerProps;
  /// The DOM id a row element must carry for `aria-activedescendant`
  /// to name it.
  rowDomId: (id: string) => string;
  /// Feed a click on a row — or on one of the consumer's extra
  /// selectable items — in, with the platform's primary modifier as
  /// `mod` (Cmd on mac, Ctrl elsewhere).
  onRowClick: (id: string, modifiers: GridviewClickModifiers) => void;
}

export function useGridview({
  adapter,
  pageRows,
  idPrefix,
  onPrimaryAction,
  extraSelectableIds = EMPTY_EXTRAS,
}: UseGridviewOptions): Gridview {
  const [cursor, setCursor] = useState<string | null>(null);
  const [selection, setSelection] = useState(EMPTY_SELECTION);

  /// Everything the selection may hold, in display order: the
  /// selectable rows, then the consumer's non-row items. A panel that
  /// answers the row half itself is taken at its word — the default
  /// walk is O(count), which a host-paged row space cannot afford.
  const selectionOrder = useCallback(
    () => [
      ...(adapter.selectionOrder?.() ?? selectableIdsInOrder(adapter, adapter.isSelectable)),
      ...extraSelectableIds,
    ],
    [adapter, extraSelectableIds],
  );

  const rowDomId = useCallback(
    // Row ids carry arbitrary text (DBC paths, signal names), so
    // URI-encode to keep the DOM id whitespace-free.
    (id: string) => `${idPrefix}-${encodeURIComponent(id)}`,
    [idPrefix],
  );

  /// Move the cursor and let the selection follow it, the mainstream
  /// single-select-follows-focus rule. A cursor landing on a row the
  /// adapter won't let be selected clears the selection rather than
  /// picking the row up.
  const moveCursor = useCallback(
    (id: string) => {
      setCursor(id);
      const row = adapter.rowAt(id);
      setSelection(collapseToCursor(row != null && adapter.isSelectable(row) ? id : null));
      const index = adapter.indexOf(id);
      if (index >= 0) adapter.scrollToRow(index);
    },
    [adapter],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      // Ctrl/Cmd+A — the one modified chord the layer claims.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        const order = selectionOrder();
        setSelection((current) => selectAll(current, order));
        return;
      }
      // Every other chord belongs to the command dispatcher, and
      // Shift+arrow to nobody — there is no keyboard multiselect.
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      // Tab passes into the row's interactive content; Enter ships
      // unbound.
      if (e.key === "Tab" || e.key === "Enter") return;
      if (e.key === " ") {
        if (!onPrimaryAction || cursor == null) return;
        e.preventDefault();
        onPrimaryAction(cursor);
        return;
      }
      if (!NAV_KEYS.has(e.key)) return;
      // The grid consumes the navigation keys whether or not this
      // particular press has somewhere to go — otherwise a no-op Right
      // would scroll the container sideways instead.
      e.preventDefault();
      const action = cursorAction(adapter, cursor, e.key as GridviewNavKey, pageRows);
      switch (action.type) {
        case "move":
          moveCursor(action.id);
          break;
        case "expand":
          adapter.setExpanded(action.id, true);
          break;
        case "collapse":
          adapter.setExpanded(action.id, false);
          break;
        case "none":
          break;
      }
    },
    [adapter, cursor, moveCursor, onPrimaryAction, pageRows, selectionOrder],
  );

  const onRowClick = useCallback(
    (id: string, modifiers: GridviewClickModifiers) => {
      // A non-row item has no place in the row space, so the cursor
      // stays where it is; only the selection moves.
      if (adapter.indexOf(id) >= 0) setCursor(id);
      setSelection((current) => selectOnClick(current, id, modifiers, selectionOrder()));
    },
    [adapter, selectionOrder],
  );

  const containerProps = useMemo(
    (): GridviewContainerProps => ({
      tabIndex: 0,
      "aria-activedescendant": cursor == null ? undefined : rowDomId(cursor),
      onKeyDown,
      [GRIDVIEW_ATTR]: "",
    }),
    [cursor, onKeyDown, rowDomId],
  );

  return { cursor, selection: selection.ids, containerProps, rowDomId, onRowClick };
}
