/// The gridview container hook (ADR 0044): binds the pure row-space
/// cursor arithmetic (`gridviewRows.ts`) and the selection model
/// (`gridviewSelection.ts`) to a real DOM container.
///
/// Headless by design — it returns props and state, never markup. The
/// panel keeps its own rendering and scrolling; the two virtualizers
/// and the non-virtualized panels sit unchanged beneath one interaction
/// model.

import { useCallback, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { GRIDVIEW_ATTR, isActivatableTarget, isEditableTarget } from "./keybindings";
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

/// Everything that can hold DOM focus, before the tab-order filter
/// below. `[tabindex]` catches the composite controls (a combobox is a
/// div that takes focus itself).
const FOCUSABLE_SELECTOR = "a[href], button, input, select, textarea, [tabindex]";

/// The row's own controls, in tab order. A row's decorative buttons opt
/// out with `tabindex="-1"` — a caret whose job Left/Right already does,
/// a clear-override ×  — and Tab into the row must land where the
/// keyboard can then walk, so they are skipped here too.
function rowTabbables(row: HTMLElement): HTMLElement[] {
  return Array.from(row.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLInputElement).disabled,
  );
}

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

/// Drop the text selection a Shift+click extended on its way to the
/// grid. The gesture selects rows, not text, and only some of the row
/// surfaces are `user-select: none` — so the layer undoes the browser's
/// side effect for all of them. A selection inside a text field is not
/// the document's (the field owns its own), so this cannot reach one:
/// the document selection is collapsed while focus sits in an input,
/// and the collapsed case returns early.
function collapseTextSelection(): void {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (selection == null || selection.isCollapsed) return;
  selection.removeAllRanges();
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
  /// `index` comes from the arithmetic that chose the row, not from
  /// asking the space again: in a host-paged space the target is
  /// routinely a row the panel has not loaded, and that is exactly when
  /// it has to be scrolled to.
  const moveCursor = useCallback(
    (id: string, index: number) => {
      setCursor(id);
      const row = adapter.rowAt(id);
      setSelection(collapseToCursor(row != null && adapter.isSelectable(row) ? id : null));
      adapter.scrollToRow(index);
    },
    [adapter],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      const container = e.currentTarget as HTMLElement;
      // Escape is the way *out* of a row's content, mirroring Tab's way
      // in (ADR 0044): focus returns to the container and the cursor is
      // still where it was, so the arrows navigate again. Content keeps
      // first claim — a control that consumed the press either stopped
      // it reaching here (a combobox closing its dropdown) or marked it
      // handled, and a global Escape command's capture-phase
      // `preventDefault` counts the same way. A press on the container
      // itself has nothing to come back from and is left alone.
      if (
        e.key === "Escape" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.target !== container &&
        !e.defaultPrevented
      ) {
        e.preventDefault();
        container.focus();
        return;
      }
      // A text field inside a row owns its own keys: the arrows move
      // the caret, Home/End jump within the value, Ctrl+A selects the
      // text. The rows carry inline editors (a section's name, an event
      // row's label), so the grid makes the same exemption the global
      // dispatcher does rather than swallowing them.
      if (isEditableTarget(e.target)) {
        // Those editors end an edit by blurring — commit on Enter,
        // revert on Escape — and a blur with nowhere to go leaves focus
        // on the document body, where the arrows are dead and the next
        // Tab restarts from the top of the page. The grid takes the
        // keyboard back, so the cursor's row is still where it is. Only
        // when focus was dropped: a control that moves it somewhere of
        // its own choosing is left alone.
        if (
          (e.key === "Enter" || e.key === "Escape") &&
          (document.activeElement == null || document.activeElement === document.body)
        ) {
          container.focus();
        }
        return;
      }
      // Ctrl/Cmd+A — the one modified chord the layer claims.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        const order = selectionOrder();
        setSelection((current) => selectAll(current, order));
        return;
      }
      // Tab moves into the cursor row's own controls (ADR 0044), and
      // Shift+Tab into them from the far end. Only from the container
      // itself: the container is the one thing in the grid that holds
      // focus, so a Tab arriving here is a Tab from the grid, and once
      // focus is inside a row, Tab is the browser's again — it walks
      // that row's controls and then out of the row. A cursor with no
      // row on screen (a paged viewport names rows it has not rendered)
      // or a row with no controls has nothing to move to, so the press
      // stays the browser's.
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.target !== container || cursor == null) return;
        const row = document.getElementById(rowDomId(cursor));
        const tabbables = row == null ? [] : rowTabbables(row);
        const target = e.shiftKey ? tabbables[tabbables.length - 1] : tabbables[0];
        if (target == null) return;
        e.preventDefault();
        target.focus();
        return;
      }
      // Every other chord belongs to the command dispatcher, and
      // Shift+arrow to nobody — there is no keyboard multiselect.
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      // Enter ships unbound.
      if (e.key === "Enter") return;
      if (e.key === " ") {
        // A focused button owns Space — pressing it is how a button is
        // activated. The same exemption in spirit as the editable-target
        // one above: the grid's action key must not double-fire a
        // control the user is standing on.
        if (isActivatableTarget(e.target)) return;
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
          moveCursor(action.id, action.index);
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
    [adapter, cursor, moveCursor, onPrimaryAction, pageRows, rowDomId, selectionOrder],
  );

  const onRowClick = useCallback(
    (id: string, modifiers: GridviewClickModifiers) => {
      if (modifiers.shift) collapseTextSelection();
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
