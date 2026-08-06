/// The gridview's column framework (ADR 0044). The panel declares an
/// ordered column set; the layer owns widths and resize, drag-reorder,
/// the show/hide menu, the sort affordance (sort *execution* stays with
/// the panel and the host), and the row template that puts each cell in
/// its header's track by construction.
///
/// The header is optional and a single column is legal, so a tree-like
/// panel is a headerless one-column instance with arbitrary cell
/// content. The column state arithmetic itself lives in
/// `traceColumns.ts`, already generic over the key set.

import { Fragment, useState } from "react";
import type {
  CSSProperties,
  HTMLAttributes,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from "react";

import {
  type ColumnDef,
  type ColumnState,
  type SortState,
  columnDefFor,
  contentWidth,
  gridTemplateColumnsFor,
  visibleColumns,
} from "./traceColumns";
import { useDismissableMenu } from "./useDismissableMenu";

/// DnD payload type for dragging a column header to reorder it. Carries
/// the dragged column's key as plain text.
const COLUMN_DND_MIME = "application/x-cannet-trace-column";

/// The visible columns' total width, published to the stylesheet as a
/// custom property for the rows' scrolled content
/// (`.trace-scroll-content` in `index.css`) to size itself from. The
/// stylesheet adds the rows' own horizontal padding — that is its fact,
/// not this module's, so the two stay where they belong.
export function contentWidthStyle<K extends string>(
  columns: readonly ColumnState<K>[],
): CSSProperties {
  return { "--trace-content-width": `${contentWidth(columns)}px` } as CSSProperties;
}

interface GridviewRowProps<K extends string> extends HTMLAttributes<HTMLDivElement> {
  /// The panel's column definitions — where each cell's class comes
  /// from.
  defs: readonly ColumnDef<K>[];
  /// The row's columns: the **visible** ones, in display order.
  columns: readonly ColumnState<K>[];
  /// `grid-template-columns` for these columns. Derived from `columns`
  /// when omitted; the virtualized panels pass their memoised value
  /// instead, because it is one computation for a whole window of rows.
  gridTemplate?: string;
  /// One cell for `key`. The layer supplies the column's class and the
  /// slot; the cell element is the panel's, because a cell that owns
  /// state of its own (a hover tooltip, say) must not push that state
  /// up to the row and repaint the whole row with it.
  renderCell: (key: K, className: string) => ReactNode;
  /// The disclosed content block of an expanded leaf, if any — it
  /// follows the cells inside the row.
  children?: ReactNode;
}

/// One gridview row: the grid container, and exactly one cell per
/// visible column in the header's order and tracks. The panel supplies
/// the row's class, positioning and handlers; the tracks are the
/// layer's and survive whatever `style` the panel passes.
export function GridviewRow<K extends string>({
  defs,
  columns,
  gridTemplate,
  renderCell,
  style,
  children,
  ...rest
}: GridviewRowProps<K>) {
  const tracks = gridTemplate ?? gridTemplateColumnsFor(defs, columns);
  return (
    <div {...rest} style={{ ...style, gridTemplateColumns: tracks }}>
      {columns.map((c) => (
        <Fragment key={c.key}>{renderCell(c.key, columnDefFor(defs, c.key).className)}</Fragment>
      ))}
      {children}
    </div>
  );
}

interface GridviewHeaderProps<K extends string> {
  /// The panel's column definitions.
  defs: readonly ColumnDef<K>[];
  /// The full column set (visible + hidden), so the right-click menu
  /// can re-show hidden ones.
  columns: readonly ColumnState<K>[];
  /// `useTraceViewport`'s `headerRef`: the scaffold shifts this element
  /// to follow the rows' horizontal scroll, since the header sits
  /// outside their scroll container.
  headerRef?: RefObject<HTMLDivElement>;
  onColumnResize: (key: K, width: number) => void;
  onColumnToggle: (key: K) => void;
  /// Drag-to-reorder: move `key` to immediately before `beforeKey`
  /// (`null` = to the end). Omitted ⇒ headers aren't draggable.
  onColumnReorder?: (key: K, beforeKey: K | null) => void;
  /// If given, column headers are clickable to sort (cycled by the
  /// caller via `onSortColumn`) and the active one shows ▲ / ▼.
  sort?: SortState<K>;
  onSortColumn?: (key: K) => void;
  /// How a column is labelled, when the panel wants something other
  /// than `def.label` (the by-id trace view renames `index` to
  /// `count`). Applies to the header and to the show/hide menu alike.
  label?: (def: ColumnDef<K>) => string;
}

/// The header row: column labels, drag-to-resize dividers, a
/// right-click menu to show / hide columns, and — where the panel
/// passes a sort — click-to-sort with a direction marker.
export function GridviewHeader<K extends string>({
  defs,
  columns,
  headerRef,
  onColumnResize,
  onColumnToggle,
  onColumnReorder,
  sort,
  onSortColumn,
  label = (def) => def.label,
}: GridviewHeaderProps<K>) {
  const visible = visibleColumns(columns);
  const visibleKeys = visible.map((c) => c.key);
  const gridTemplate = gridTemplateColumnsFor(defs, columns);

  // Drag-to-reorder: the column currently being dragged (for the dimmed
  // affordance). Drop on a header's left/right half inserts the dragged
  // column before/after it.
  const [dragKey, setDragKey] = useState<K | null>(null);

  // Column-resize drag: which column, the pointer X at drag start, and
  // that column's width then. The handle takes pointer capture.
  const [resize, setResize] = useState<{ key: K; startX: number; startWidth: number } | null>(
    null,
  );
  const onResizeDown = (key: K, e: ReactPointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = columns.find((c) => c.key === key)?.width ?? columnDefFor(defs, key).defaultWidth;
    setResize({ key, startX: e.clientX, startWidth });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (resize) onColumnResize(resize.key, resize.startWidth + (e.clientX - resize.startX));
  };
  const onResizeUp = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (resize) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      setResize(null);
    }
  };

  // The show/hide column context menu, at the cursor.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useDismissableMenu<HTMLDivElement>(menu != null, () => setMenu(null));

  return (
    <div
      ref={headerRef}
      className="trace-header"
      style={{ gridTemplateColumns: gridTemplate }}
      onContextMenu={(e) => {
        e.preventDefault();
        // Stop the right-click from also reaching the panel-level
        // context-menu handler (the sources picker) — otherwise both
        // menus open and the sources menu renders over this one.
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {visible.map((c) => {
        const def = columnDefFor(defs, c.key);
        const sortable = !!onSortColumn;
        const active = sort?.key === c.key;
        const draggable = !!onColumnReorder;
        return (
          <span
            key={c.key}
            className={`${def.className}${sortable ? " col-sortable" : ""}${
              draggable ? " col-draggable" : ""
            }${dragKey === c.key ? " col-dragging" : ""}`}
            onClick={sortable ? () => onSortColumn?.(c.key) : undefined}
            draggable={draggable}
            onDragStart={
              draggable
                ? (e) => {
                    e.dataTransfer.setData(COLUMN_DND_MIME, c.key);
                    e.dataTransfer.effectAllowed = "move";
                    setDragKey(c.key);
                  }
                : undefined
            }
            onDragOver={
              draggable
                ? (e) => {
                    if (!e.dataTransfer.types.includes(COLUMN_DND_MIME)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }
                : undefined
            }
            onDrop={
              draggable
                ? (e) => {
                    const moved = e.dataTransfer.getData(COLUMN_DND_MIME) as K;
                    if (!moved) return;
                    e.preventDefault();
                    e.stopPropagation();
                    // Left half ⇒ drop before this column; right half ⇒
                    // after it (before the next visible one, or the end).
                    const rect = e.currentTarget.getBoundingClientRect();
                    const after = e.clientX > rect.left + rect.width / 2;
                    const idx = visibleKeys.indexOf(c.key);
                    const beforeKey = after ? visibleKeys[idx + 1] ?? null : c.key;
                    onColumnReorder?.(moved, beforeKey);
                    setDragKey(null);
                  }
                : undefined
            }
            onDragEnd={draggable ? () => setDragKey(null) : undefined}
          >
            {label(def)}
            {active && <span className="sort-marker">{sort?.dir === "asc" ? " ▲" : " ▼"}</span>}
            <span
              className="col-resize-handle"
              draggable={false}
              onPointerDown={(e) => onResizeDown(c.key, e)}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeUp}
            />
          </span>
        );
      })}
      {menu && (
        <div
          ref={menuRef}
          className="column-context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
        >
          {columns.map((c) => {
            const def = columnDefFor(defs, c.key);
            return (
              <label key={c.key} className="checkbox">
                <input
                  type="checkbox"
                  checked={c.visible}
                  onChange={() => onColumnToggle(c.key)}
                />
                {label(def)}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
