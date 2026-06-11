import { memo } from "react";

import type { ByIdSnapshotRecord, SignalRecord, TraceFrameRecord } from "./types";
import { formatSignalValueWithLabel } from "./format";
import { type ColorResolver, colorMapTint } from "./colorMap";
import { setSignalDragData } from "./dragSignals";
import {
  type BusLookup,
  type ColumnKey,
  type ColumnState,
  type SortState,
  columnDef,
  gridTemplateColumns,
  sortRows,
  visibleColumns,
} from "./traceColumns";
import { TraceHeader, cellContent } from "./traceTable";

/// Stable key for a by-id row — bus + arbitration id + std/ext. Bus is
/// part of the key so two frames sharing the same `(id, extended)`
/// across different buses get distinct rows (otherwise multi-bus
/// captures collapse them into one).
export function byIdRowKey(f: TraceFrameRecord): string {
  return `${f.bus_id ?? "_"}:${f.id}:${f.extended ? "x" : "s"}`;
}

interface ByIdTableProps {
  /// One row per arbitration id (the host's latest-by-id snapshot, each
  /// with its current message rate), in the host's order; this table
  /// re-sorts a copy when `sort` is set.
  rows: readonly ByIdSnapshotRecord[];
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
  onColumnReorder,
  resolveColor,
  sort,
  onSortColumn,
  baseTimestamp,
  busLookup,
  expanded,
  onToggleExpand,
}: ByIdTableProps) {
  const visible = visibleColumns(columns);
  const gridTemplate = gridTemplateColumns(columns);
  const sorted = sortRows(rows, sort, busLookup);

  return (
    <div className="trace">
      {/* Header lives inside the scroll container so it tracks the rows
          horizontally when the columns are wider than the panel; its
          `position: sticky; top: 0` keeps it pinned while scrolling
          down. */}
      <div className="by-id-rows">
        <TraceHeader
          columns={columns}
          onColumnResize={onColumnResize}
          onColumnToggle={onColumnToggle}
          onColumnReorder={onColumnReorder}
          sort={sort}
          onSortColumn={onSortColumn}
          byId
        />
        {sorted.map((s) => {
          const key = byIdRowKey(s.frame);
          return (
            <ByIdRow
              key={key}
              rowKeyId={key}
              frame={s.frame}
              rate={s.rate}
              count={s.count}
              columns={visible}
              gridTemplate={gridTemplate}
              baseTimestamp={baseTimestamp}
              busLookup={busLookup}
              resolveColor={resolveColor}
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
  count: number;
  columns: readonly ColumnState[];
  gridTemplate: string;
  baseTimestamp: number | null;
  busLookup: BusLookup;
  resolveColor: ColorResolver | null;
  isExpanded: boolean;
  onToggle: (rowKey: string) => void;
}

const ByIdRow = memo(function ByIdRow({
  rowKeyId,
  frame,
  rate,
  count,
  columns,
  gridTemplate,
  baseTimestamp,
  busLookup,
  resolveColor,
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
          {cellContent(c.key, frame, frame.index, baseTimestamp, isExpanded, busLookup, rate, count)}
        </span>
      ))}
      {isExpanded && frame.decoded && (
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
