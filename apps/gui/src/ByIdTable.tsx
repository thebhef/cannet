import { memo } from "react";

import type { ByIdSnapshotRecord, TraceFrameRecord } from "./types";
import { formatSignalValue } from "./format";
import {
  type ColumnKey,
  type ColumnState,
  type SortState,
  columnDef,
  gridTemplateColumns,
  sortRows,
  visibleColumns,
} from "./traceColumns";
import { TraceHeader, cellContent } from "./traceTable";

/// Stable key for a by-id row — channel + arbitration id + std/ext.
export function byIdRowKey(f: TraceFrameRecord): string {
  return `${f.channel}:${f.id}:${f.extended ? "x" : "s"}`;
}

interface ByIdTableProps {
  /// One row per arbitration id (the host's latest-by-id snapshot, each
  /// with its current message rate), in the host's order; this table
  /// re-sorts a copy when `sort` is set.
  rows: readonly ByIdSnapshotRecord[];
  columns: readonly ColumnState[];
  onColumnResize: (key: ColumnKey, width: number) => void;
  onColumnToggle: (key: ColumnKey) => void;
  sort: SortState;
  onSortColumn: (key: ColumnKey) => void;
  baseTimestamp: number | null;
  expanded: ReadonlySet<string>;
  onToggleExpand: (rowKey: string) => void;
}

/// The per-message-ID body: a trace header (sortable — click a column)
/// over a plain list of rows (one per id; not many, so no virtualizer).
export function ByIdTable({
  rows,
  columns,
  onColumnResize,
  onColumnToggle,
  sort,
  onSortColumn,
  baseTimestamp,
  expanded,
  onToggleExpand,
}: ByIdTableProps) {
  const visible = visibleColumns(columns);
  const gridTemplate = gridTemplateColumns(columns);
  const sorted = sortRows(rows, sort);

  return (
    <div className="trace">
      <TraceHeader
        columns={columns}
        onColumnResize={onColumnResize}
        onColumnToggle={onColumnToggle}
        sort={sort}
        onSortColumn={onSortColumn}
      />
      <div className="by-id-rows">
        {sorted.map((s) => {
          const key = byIdRowKey(s.frame);
          return (
            <ByIdRow
              key={key}
              rowKeyId={key}
              frame={s.frame}
              rate={s.rate}
              columns={visible}
              gridTemplate={gridTemplate}
              baseTimestamp={baseTimestamp}
              isExpanded={expanded.has(key)}
              onToggle={onToggleExpand}
            />
          );
        })}
      </div>
    </div>
  );
}

interface ByIdRowProps {
  rowKeyId: string;
  frame: TraceFrameRecord;
  rate: number;
  columns: readonly ColumnState[];
  gridTemplate: string;
  baseTimestamp: number | null;
  isExpanded: boolean;
  onToggle: (rowKey: string) => void;
}

const ByIdRow = memo(function ByIdRow({
  rowKeyId,
  frame,
  rate,
  columns,
  gridTemplate,
  baseTimestamp,
  isExpanded,
  onToggle,
}: ByIdRowProps) {
  return (
    <div
      className={`trace-row ${isExpanded ? "expanded" : ""}`}
      style={{ gridTemplateColumns: gridTemplate }}
      onClick={() => frame.decoded && onToggle(rowKeyId)}
    >
      {columns.map((c) => (
        <span key={c.key} className={columnDef(c.key).className}>
          {cellContent(c.key, frame, frame.index, baseTimestamp, isExpanded, rate)}
        </span>
      ))}
      {isExpanded && frame.decoded && (
        <div className="signals">
          {frame.decoded.signals.map((sig) => (
            <div className="signal" key={sig.name}>
              <span className="signal-name">{sig.name}</span>
              <span className="signal-value">{formatSignalValue(sig.value, sig.unit)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
