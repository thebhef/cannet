import { memo, useCallback, useEffect, useMemo, useState } from "react";

import type { TraceFrameRecord } from "./types";
import { type ColorResolver } from "./colorMap";
import { DecodedSignalCell } from "./DecodedSignalCell";
import {
  ROW_HEIGHT,
  anchorFromScroll,
  buildPlacements,
  expandedExtraHeight,
  expandedRowHeight,
  maxScrollTop,
} from "./traceViewport";
import { useTraceViewport } from "./useTraceViewport";
import { useSetting } from "./hostSettings";
import type { CanIdFormat } from "./format";
import {
  type BusLookup,
  type ColumnKey,
  type ColumnState,
  type SortState,
  columnDef,
  gridTemplateColumns,
  visibleColumns,
} from "./traceColumns";
import { TraceHeader, cellContent, contentWidthStyle } from "./traceTable";
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
  // Absolute row at the top of the viewport — the single source of truth
  // for what's shown (the rows never depend on the live `scrollTop`).
  // Unlike the chronological view there is no live tail to pin to: by-id
  // is a sorted snapshot, so the anchor only moves when the user scrolls.
  const [anchoredRow, setAnchoredRow] = useState(0);
  // The `id` column's format (`can_id_format`), read here rather than
  // in `cellContent` so it reaches the memoised rows as a prop and a
  // change repaints them. Same as `TraceView`.
  const idFormat = useSetting("can_id_format") as CanIdFormat;

  const visible = useMemo(() => visibleColumns(columns), [columns]);
  const gridTemplate = useMemo(() => gridTemplateColumns(columns), [columns]);
  const contentWidthVar = useMemo(() => contentWidthStyle(columns), [columns]);

  // Rendered height of a row: an expanded row carries a line per decoded
  // signal, everything else is a plain row. A row outside the loaded
  // page reads as a plain row until it lands — the same degradation as
  // `signalCount` below.
  const rowHeightAt = useCallback(
    (absIdx: number) => {
      const r = getRow(absIdx);
      if (!r || !expanded.has(byIdRowKey(r.frame))) return ROW_HEIGHT;
      return expandedRowHeight(r.frame.decoded?.signals.length ?? 0);
    },
    // `version` is a dep so a page landing / live refresh re-derives the
    // heights even though it isn't read directly (what `getRow` answers
    // changes behind it).
    [getRow, expanded, version],
  );

  // What the expanded rows add to the snapshot's height, so the scroll
  // range covers them. Bounded work over the id space, and only when
  // something is expanded — the common case skips the walk entirely.
  const extraHeight = useMemo(
    () => (expanded.size === 0 ? 0 : expandedExtraHeight(count, rowHeightAt)),
    [expanded, count, rowHeightAt],
  );

  const {
    containerRef,
    headerRef,
    viewportHeight,
    rows,
    spacerHeight,
    anchorMax,
    firstVisibleRow,
    lastVisibleRow,
  } = useTraceViewport(count, anchoredRow, undefined, { extraHeight, rowHeightAt });

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
    setAnchoredRow(
      anchorFromScroll(
        el.scrollTop,
        anchorMax,
        maxScrollTop(count, viewportHeight, extraHeight),
      ),
    );
  }, [anchorMax, count, viewportHeight, extraHeight]);

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

  // Signal count for expanded-row sizing; a not-yet-loaded row sizes as
  // a plain row.
  const signalCount = (absIdx: number) =>
    getRow(absIdx)?.frame.decoded?.signals.length ?? 0;
  const placements = buildPlacements(
    firstVisibleRow,
    count,
    rows,
    expandedPositions,
    signalCount,
  );
  // How tall the rendered rows actually stack. The sticky viewport clips
  // (`overflow: hidden`), so it takes the larger of the panel height and
  // the stack — an expanded row taller than the panel then slides into
  // view as the scroll runs past the sticky element's own height instead
  // of being cut off at the fold.
  const last = placements[placements.length - 1];
  const stackHeight = last ? last.top + last.height : 0;

  return (
    <div className="trace">
      <TraceHeader
        columns={columns}
        headerRef={headerRef}
        onColumnResize={onColumnResize}
        onColumnToggle={onColumnToggle}
        onColumnReorder={onColumnReorder}
        sort={sort}
        onSortColumn={onSortColumn}
        byId
      />
      <div ref={containerRef} className="trace-rows" onScroll={handleScroll}>
        {/* Spacer: gives the scrollbar the snapshot's full extent
            vertically, and the columns' own width horizontally — the rows
            are absolutely positioned against it, so without that the
            columns past the panel's right edge are clipped by the sticky
            viewport with no scroll position that reaches them. */}
        <div
          className="trace-scroll-content"
          style={{ height: spacerHeight, position: "relative", ...contentWidthVar }}
        >
          {/* Sticky viewport: the compositor keeps this pinned so the rows
              never lag the scrollbar — React only swaps their content. */}
          <div
            style={{
              position: "sticky",
              top: 0,
              height: Math.max(viewportHeight, stackHeight),
              overflow: "hidden",
            }}
          >
            {placements.map(({ posKey, absIdx, top, isExpanded, height }) => {
              const row = getRow(absIdx);
              return (
                <ByIdRow
                  key={posKey}
                  top={top}
                  height={height}
                  row={row}
                  isExpanded={isExpanded}
                  columns={visible}
                  gridTemplate={gridTemplate}
                  baseTimestamp={baseTimestamp}
                  idFormat={idFormat}
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
  /// Row height from the placement (`RowPlacement.height`), so the
  /// rendered box always matches the stacking arithmetic.
  height: number;
  row: ByIdSnapshotRecord | null;
  isExpanded: boolean;
  columns: readonly ColumnState[];
  gridTemplate: string;
  baseTimestamp: number | null;
  idFormat: CanIdFormat;
  busLookup: BusLookup;
  resolveColor: ColorResolver | null;
  onToggle: (rowKey: string) => void;
}

const ByIdRow = memo(function ByIdRow({
  top,
  height,
  row,
  isExpanded,
  columns,
  gridTemplate,
  baseTimestamp,
  idFormat,
  busLookup,
  resolveColor,
  onToggle,
}: ByIdRowProps) {
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
          {cellContent(c.key, frame, frame?.index ?? 0, baseTimestamp, idFormat, isExpanded, busLookup, row?.rate, row?.count)}
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

// `DecodedSignalCell` is shared with `TraceView` — see `DecodedSignalCell.tsx`.
