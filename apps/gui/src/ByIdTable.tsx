import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SignalRecord, TraceFrameRecord } from "./types";
import { formatSignalValueWithLabel } from "./format";
import { type ColorResolver, colorMapTint } from "./colorMap";
import { setSignalDragData } from "./dragSignals";
import {
  EXPANDED_ROW_HEIGHT,
  ROW_HEIGHT,
  buildPlacements,
  maxAnchorRow,
  rowFromScroll,
  scaledHeight,
  visibleRowCount,
} from "./traceViewport";
import {
  type BusLookup,
  type ColumnKey,
  type ColumnState,
  type SortState,
  columnDef,
  gridTemplateColumns,
  visibleColumns,
} from "./traceColumns";
import { TraceHeader, cellContent } from "./traceTable";
import type { ByIdSnapshotRecord } from "./types";
import { diagCount } from "./diag"; // DIAG

/// Stable key for a by-id row — bus + arbitration id + std/ext. Bus is
/// part of the key so two frames sharing the same `(id, extended)`
/// across different buses get distinct rows (otherwise multi-bus
/// captures collapse them into one). Used for expand/collapse identity:
/// expansion tracks the row, not its position, so it survives a re-sort
/// or a new id appearing above it.
export function byIdRowKey(f: TraceFrameRecord): string {
  return `${f.bus_id ?? "_"}:${f.id}:${f.extended ? "x" : "s"}`;
}

interface ByIdTableProps {
  /// Total by-id rows (the scrollbar extent) and the paged, host-sorted
  /// accessors over them, from `useByIdView`. The table windows this
  /// exactly like the chronological `TraceView` windows the trace — it
  /// holds no rows of its own and does no sorting (both are host-side).
  count: number;
  /// Bumped when the loaded page's content changes, so the virtualizer
  /// re-consults `getRow` (a placeholder row's data just landed, or the
  /// live refresh updated rates).
  version: number;
  getRow: (index: number) => ByIdSnapshotRecord | null;
  ensureVisible: (start: number, end: number) => void;
  columns: readonly ColumnState[];
  onColumnResize: (key: ColumnKey, width: number) => void;
  onColumnToggle: (key: ColumnKey) => void;
  onColumnReorder: (key: ColumnKey, beforeKey: ColumnKey | null) => void;
  /// Resolves a decoded signal's value→color tint (ADR 0029), or null.
  resolveColor: ColorResolver | null;
  sort: SortState;
  onSortColumn: (key: ColumnKey) => void;
  baseTimestamp: number | null;
  busLookup: BusLookup;
  /// Expanded rows, by [`byIdRowKey`] (stable identity, not position).
  expanded: ReadonlySet<string>;
  onToggleExpand: (rowKey: string) => void;
}

/// The per-message-ID body: a sortable trace header over a virtualized
/// list of host-sorted by-id rows (one per arbitration id), paged through
/// the shared windowed-source primitive. Bounded by id-space, so a single
/// page usually covers it — but it is the same windowed code path as the
/// chronological views, not a special whole-fetch.
export function ByIdTable({
  count,
  version,
  getRow,
  ensureVisible,
  columns,
  onColumnResize,
  onColumnToggle,
  onColumnReorder,
  resolveColor,
  sort,
  onSortColumn,
  baseTimestamp,
  busLookup,
  expanded,
  onToggleExpand,
}: ByIdTableProps) {
  diagCount("render.ByIdTable"); // DIAG
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(600);
  // Absolute row at the top of the viewport — the single source of truth
  // for what's shown (the rows never depend on the live `scrollTop`).
  // Unlike the chronological view there is no live tail to pin to: by-id
  // is a sorted snapshot, so the anchor only moves when the user scrolls.
  const [anchoredRow, setAnchoredRow] = useState(0);

  const visible = useMemo(() => visibleColumns(columns), [columns]);
  const gridTemplate = useMemo(() => gridTemplateColumns(columns), [columns]);

  const rows = visibleRowCount(viewportHeight);
  const spacerHeight = scaledHeight(count, viewportHeight);
  const anchorMax = maxAnchorRow(count, viewportHeight);
  const firstVisibleRow = Math.min(anchorMax, Math.max(0, anchoredRow));
  const lastVisibleRow = Math.min(count, firstVisibleRow + rows);

  // Observe viewport size so the visible-row count tracks resizes.
  useEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      if (containerRef.current) setViewportHeight(containerRef.current.clientHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Prefetch the covering page for the visible rows.
  useEffect(() => {
    if (count === 0) return;
    ensureVisible(firstVisibleRow, lastVisibleRow);
  }, [firstVisibleRow, lastVisibleRow, count, ensureVisible]);

  // Reset the scroll anchor when the snapshot empties (clear / new sort).
  useEffect(() => {
    if (count === 0) setAnchoredRow(0);
  }, [count]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setAnchoredRow(rowFromScroll(el.scrollTop, count, viewportHeight));
  }, [count, viewportHeight]);

  // Which visible positions are expanded — derived from the loaded rows'
  // stable keys, so `buildPlacements` can size them. `version` is a dep so
  // a page landing (or a live refresh) re-derives it.
  const expandedPositions = useMemo(() => {
    const s = new Set<number>();
    for (let i = 0; i < rows; i++) {
      const abs = firstVisibleRow + i;
      if (abs >= count) break;
      const r = getRow(abs);
      if (r && expanded.has(byIdRowKey(r.frame))) s.add(abs);
    }
    return s;
    // `version` is a dep so a page landing / live refresh re-derives the
    // set even though it isn't read directly (the row content it gates
    // changes behind `getRow`).
  }, [rows, firstVisibleRow, count, getRow, expanded, version]);

  const placements = buildPlacements(firstVisibleRow, count, rows, expandedPositions);

  return (
    <div className="trace">
      <TraceHeader
        columns={columns}
        onColumnResize={onColumnResize}
        onColumnToggle={onColumnToggle}
        onColumnReorder={onColumnReorder}
        sort={sort}
        onSortColumn={onSortColumn}
        byId
      />
      <div ref={containerRef} className="trace-rows" onScroll={handleScroll}>
        {/* Spacer: gives the scrollbar the snapshot's full extent. */}
        <div style={{ height: spacerHeight, position: "relative" }}>
          {/* Sticky viewport: the compositor keeps this pinned so the rows
              never lag the scrollbar — React only swaps their content. */}
          <div style={{ position: "sticky", top: 0, height: viewportHeight, overflow: "hidden" }}>
            {placements.map(({ posKey, absIdx, top, isExpanded }) => {
              const row = getRow(absIdx);
              return (
                <ByIdRow
                  key={posKey}
                  top={top}
                  row={row}
                  isExpanded={isExpanded}
                  columns={visible}
                  gridTemplate={gridTemplate}
                  baseTimestamp={baseTimestamp}
                  busLookup={busLookup}
                  resolveColor={resolveColor}
                  onToggle={onToggleExpand}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

interface ByIdRowProps {
  top: number;
  row: ByIdSnapshotRecord | null;
  isExpanded: boolean;
  columns: readonly ColumnState[];
  gridTemplate: string;
  baseTimestamp: number | null;
  busLookup: BusLookup;
  resolveColor: ColorResolver | null;
  onToggle: (rowKey: string) => void;
}

const ByIdRow = memo(function ByIdRow({
  top,
  row,
  isExpanded,
  columns,
  gridTemplate,
  baseTimestamp,
  busLookup,
  resolveColor,
  onToggle,
}: ByIdRowProps) {
  const height = isExpanded ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT;
  const frame = row?.frame ?? null;
  const rowKey = frame ? byIdRowKey(frame) : undefined;
  return (
    <div
      className={`trace-row ${isExpanded ? "expanded" : ""} ${frame ? "" : "loading"}`}
      style={{ position: "absolute", top, left: 0, right: 0, height, gridTemplateColumns: gridTemplate }}
      onClick={() => frame?.decoded && rowKey && onToggle(rowKey)}
    >
      {columns.map((c) => (
        <span key={c.key} className={columnDef(c.key).className}>
          {cellContent(c.key, frame, frame?.index ?? 0, baseTimestamp, isExpanded, busLookup, row?.rate, row?.count)}
        </span>
      ))}
      {isExpanded && frame?.decoded && (
        <div className="signals">
          {frame.decoded.signals.map((sig) => (
            <DecodedSignalCell
              key={sig.name}
              frame={frame}
              messageName={frame.decoded!.name}
              sig={sig}
              resolveColor={resolveColor}
            />
          ))}
        </div>
      )}
    </div>
  );
});

/// One decoded signal cell in a by-id row's expanded grid. Drag
/// source identical to the chronological trace's version — same
/// payload shape, same single-ref form, scoped to the frame's
/// own `bus_id`. Shared component would force a cross-file import
/// dance for a six-line render; the duplication is cheaper to
/// maintain than the abstraction.
function DecodedSignalCell({
  frame,
  messageName,
  sig,
  resolveColor,
}: {
  frame: TraceFrameRecord;
  messageName: string;
  sig: SignalRecord;
  resolveColor: ColorResolver | null;
}) {
  const tint = resolveColor?.(
    {
      messageId: frame.id,
      extended: frame.extended,
      signalName: sig.name,
      busId: frame.bus_id ?? null,
    },
    sig.value,
  );
  return (
    <div
      className="signal"
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        setSignalDragData(e, [
          {
            busId: frame.bus_id ?? null,
            messageId: frame.id,
            extended: frame.extended,
            signalName: sig.name,
            messageName,
            unit: sig.unit,
          },
        ]);
      }}
    >
      <span className="signal-name">{sig.name}</span>
      <span
        className="signal-value"
        style={tint ? { background: colorMapTint(tint) } : undefined}
      >
        {formatSignalValueWithLabel(sig.value, sig.unit, sig.label)}
      </span>
    </div>
  );
}
