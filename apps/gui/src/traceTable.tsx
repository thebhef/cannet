import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { TraceFrameRecord } from "./types";
import {
  COLUMN_DEFS,
  type BusLookup,
  type ColumnDef,
  type ColumnKey,
  type ColumnState,
  type SortState,
  busDisplayName,
  columnDefFor,
  gridTemplateColumnsFor,
  visibleColumns,
} from "./traceColumns";
import { formatData, formatId, formatKind, formatMsgRate, formatTimestamp } from "./format";

/// DnD payload type for dragging a column header to reorder it. Carries
/// the dragged column's `ColumnKey` as plain text.
const COLUMN_DND_MIME = "application/x-cannet-trace-column";

/// The content for one trace cell, given the column. The `#` column is
/// the row's 1-based index in the chronological view, and the total
/// frame count for the id in the by-id view (passed as `count`); it's
/// shown even for a not-yet-loaded row. Every other column is blank
/// until the frame arrives. `rate` and `count` are only meaningful in
/// by-id mode (the "msg/s" column and the per-id frame total);
/// elsewhere they're omitted. `busLookup` resolves a frame's `bus_id`
/// to the project's bus name for the "bus" column. Shared by the
/// chronological rows (`TraceView`) and the by-id rows (`ByIdTable`).
export function cellContent(
  key: ColumnKey,
  frame: TraceFrameRecord | null,
  absoluteIndex: number,
  baseTimestamp: number | null,
  isExpanded: boolean,
  busLookup: BusLookup,
  rate?: number,
  count?: number,
): ReactNode {
  if (key === "idx") {
    return (count ?? absoluteIndex + 1).toLocaleString();
  }
  if (key === "rate") return rate != null ? formatMsgRate(rate) : null;
  if (!frame) return null;
  switch (key) {
    case "time":
      return formatTimestamp(frame.timestamp_seconds, baseTimestamp);
    case "bus":
      return busDisplayName(frame.bus_id, busLookup);
    case "ecu":
      // Blank for undecoded rows and the `Vector__XXX` "no sender"
      // placeholder — unlike bus, there's no meaningful fallback name.
      return frame.decoded?.transmitter ?? "";
    case "dir":
      return frame.direction;
    case "id":
      return formatId(frame);
    case "kind":
      return formatKind(frame);
    case "len":
      return frame.data.length;
    case "data":
      return formatData(frame);
    case "msg":
      return (
        <>
          {frame.decoded ? frame.decoded.name : ""}
          {frame.decoded ? <span className="hint">{isExpanded ? " ▾" : " ▸"}</span> : null}
        </>
      );
  }
}

interface TraceHeaderProps<K extends string> {
  /// The full column set (visible + hidden), so the right-click menu can
  /// re-show hidden ones.
  columns: readonly ColumnState<K>[];
  /// The column definitions the state refers to. Defaults to the trace
  /// set; the signal view passes its own (`signalColumns.ts`) so both
  /// tables share this one header implementation.
  defs?: readonly ColumnDef<K>[];
  onColumnResize: (key: K, width: number) => void;
  onColumnToggle: (key: K) => void;
  /// Drag-to-reorder: move `key` to immediately before `beforeKey`
  /// (`null` = to the end). Omitted ⇒ headers aren't draggable.
  onColumnReorder?: (key: K, beforeKey: K | null) => void;
  /// If given, column headers are clickable to sort (cycled by the
  /// caller via `onSortColumn`) and the active one shows ▲ / ▼.
  sort?: SortState<K>;
  onSortColumn?: (key: K) => void;
  /// Render the by-id variant of each column's label where one exists
  /// (e.g. `idx` shows "count" instead of "index"). Defaults to the
  /// chronological labels.
  byId?: boolean;
}

/// The trace-table header row: column labels, drag-to-resize dividers,
/// a right-click menu to show / hide columns, and — in per-id mode —
/// click-to-sort with a direction marker.
export function TraceHeader<K extends string = ColumnKey>({
  columns,
  defs = COLUMN_DEFS as unknown as readonly ColumnDef<K>[],
  onColumnResize,
  onColumnToggle,
  onColumnReorder,
  sort,
  onSortColumn,
  byId,
}: TraceHeaderProps<K>) {
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
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    // A `mousedown` anywhere (the menu's own checkboxes use `click`)
    // closes it; so does Escape.
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <div
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
        const label = byId ? def.byIdLabel ?? def.label : def.label;
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
            {label}
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
          className="column-context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
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
                {byId ? def.byIdLabel ?? def.label : def.label}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
