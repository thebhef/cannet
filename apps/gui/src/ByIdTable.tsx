import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

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
  scrollForAnchor,
} from "./traceViewport";
import { useTraceViewport } from "./useTraceViewport";
import { useGridview } from "./useGridview";
import type { GridviewAdapter, GridviewRow as GridviewRowModel } from "./gridviewRows";
import {
  messageDragRefs,
  setSignalDragPayload,
  type DraggableSignalRef,
} from "./dragSignals";
import { useSetting } from "./hostSettings";
import type { CanIdFormat } from "./format";
import {
  type BusLookup,
  type ColumnKey,
  type ColumnState,
  type SortState,
  COLUMN_DEFS,
  gridTemplateColumns,
  visibleColumns,
} from "./traceColumns";
import { TraceTimeCell, cellContent } from "./traceTable";
import { GridviewHeader, GridviewRow, contentWidthStyle } from "./gridviewColumns";
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
  /// Owned by the panel, which persists it with the rest of its view
  /// config — so which messages are open survives a reopen.
  expanded: ReadonlySet<string>;
  onToggleExpand: (rowKey: string) => void;
}

/// The per-message-ID body: a sortable trace header over a virtualized
/// list of host-sorted by-id rows (one per arbitration id), paged through
/// the shared windowed-source primitive. Bounded by id-space, so a single
/// page usually covers it — but it is the same windowed code path as the
/// chronological views, not a special whole-fetch.
///
/// A row's decoded signals fold under it, and the row itself is the
/// control: click it, or focus it and press Enter / Space. It carries
/// the state as `aria-expanded`; there is no caret. Only the *loaded*
/// rows' folds enter the geometry, so the stacking arithmetic never
/// needs the whole snapshot.
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

  // --- the gridview (ADR 0044) ---
  // The row space is the host-sorted snapshot itself: every row is a
  // leaf, expandable exactly when it has a decode to disclose, and the
  // disclosure grows the row in place rather than adding rows. Ids are
  // the same stable `byIdRowKey`s the fold set is stored under, so the
  // cursor, the selection and the expansion all name the same thing.
  const rowModelAt = useCallback(
    (index: number): GridviewRowModel | null => {
      const r = getRow(index);
      if (!r) return null;
      return {
        id: byIdRowKey(r.frame),
        kind: "leaf",
        expandable: r.frame.decoded != null,
        depth: 0,
      };
    },
    // `version` is a dep for the same reason as everywhere else here:
    // what `getRow` answers changes behind it.
    [getRow, version],
  );
  // The scaffold's live geometry, read by `scrollToRow` without making
  // the adapter a fresh object on every scroll.
  const geometry = useRef({
    firstVisibleRow,
    rows,
    count,
    viewportHeight,
    anchorMax,
    extraHeight,
    getRow,
  });
  geometry.current = {
    firstVisibleRow,
    rows,
    count,
    viewportHeight,
    anchorMax,
    extraHeight,
    getRow,
  };
  const scrollToRow = useCallback(
    (index: number) => {
      const g = geometry.current;
      // `rows` carries the two-row render pad, so the last *whole* row
      // is two short of the window's end.
      const page = Math.max(1, g.rows - 2);
      const next =
        index < g.firstVisibleRow
          ? index
          : index > g.firstVisibleRow + page - 1
            ? index - page + 1
            : null;
      if (next == null) return;
      const anchor = Math.max(0, Math.min(g.anchorMax, next));
      setAnchoredRow(anchor);
      const el = containerRef.current;
      if (el) {
        el.scrollTop = scrollForAnchor(
          anchor,
          g.anchorMax,
          maxScrollTop(g.count, g.viewportHeight, g.extraHeight),
        );
      }
    },
    [containerRef],
  );
  // The panel owns the fold set and offers a toggle; the layer says
  // which state it wants, so ask for the toggle only when they differ.
  const setRowExpanded = useCallback(
    (id: string, want: boolean) => {
      if (expanded.has(id) !== want) onToggleExpand(id);
    },
    [expanded, onToggleExpand],
  );
  const adapter = useMemo<GridviewAdapter>(() => {
    // Bounded by id space, like `expandedExtraHeight`'s walk above.
    const indexOf = (id: string) => {
      for (let i = 0; i < count; i++) if (rowModelAt(i)?.id === id) return i;
      return -1;
    };
    return {
      count,
      rowIdAt: (index) => rowModelAt(index)?.id ?? null,
      indexOf,
      rowAt: (id) => {
        const i = indexOf(id);
        return i < 0 ? null : rowModelAt(i);
      },
      isExpanded: (id) => expanded.has(id),
      scrollToRow,
      setExpanded: setRowExpanded,
      isSelectable: () => true,
    };
  }, [count, rowModelAt, expanded, scrollToRow, setRowExpanded]);
  // Namespaces this instance's row DOM ids, so two by-id tables on
  // screen can't name each other's rows.
  const instanceId = useId();
  const grid = useGridview({
    adapter,
    pageRows: Math.max(1, rows - 2),
    idPrefix: `byid${instanceId}`,
  });
  // The rows are memoised and the hook hands back fresh callbacks every
  // render (its adapter moves with the page), so the row-facing handlers
  // read the live gridview through a ref instead — otherwise every
  // visible row repaints on every live refresh.
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const handleRowClick = useCallback(
    (rowKey: string, e: React.MouseEvent) => {
      gridRef.current.onRowClick(rowKey, { mod: e.ctrlKey || e.metaKey, shift: e.shiftKey });
      // A row with something to disclose is its own focus target, so it
      // keeps the keyboard (its Enter / Space still toggle it, and the
      // grid's keys reach the container by bubbling). A row that isn't
      // one would leave the keyboard nowhere, so hand it to the grid.
      const target = e.target as HTMLElement | null;
      if (target?.closest(".trace-row[tabindex], button, input") == null) {
        containerRef.current?.focus();
      }
    },
    [containerRef],
  );
  /// What one grab carries (ADR 0045): the grabbed row's message, or —
  /// when that row is in the selection — every selected row's message.
  /// Resolved at drag time, so the scroll path pays nothing for it.
  const startRowDrag = useCallback(
    (rowKey: string, e: React.DragEvent) => {
      const g = geometry.current;
      const selection = gridRef.current.selection;
      const ids = selection.has(rowKey) ? selection : new Set([rowKey]);
      const signals: DraggableSignalRef[] = [];
      for (let i = 0; i < g.count; i++) {
        const r = g.getRow(i);
        if (!r || !ids.has(byIdRowKey(r.frame))) continue;
        signals.push(...messageDragRefs(r.frame));
      }
      setSignalDragPayload(e, { signals, patterns: [] });
    },
    [],
  );

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
      <GridviewHeader
        defs={COLUMN_DEFS}
        columns={columns}
        headerRef={headerRef}
        onColumnResize={onColumnResize}
        onColumnToggle={onColumnToggle}
        onColumnReorder={onColumnReorder}
        sort={sort}
        onSortColumn={onSortColumn}
        label={(def) => def.byIdLabel ?? def.label}
      />
      {/* The rows viewport is the gridview container: it holds focus and
          names the active row, because the rows themselves are recycled
          by the paged viewport (ADR 0044). */}
      <div
        ref={containerRef}
        className="trace-rows"
        onScroll={handleScroll}
        {...grid.containerProps}
      >
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
                  rowDomId={grid.rowDomId}
                  selected={row != null && grid.selection.has(byIdRowKey(row.frame))}
                  onSelect={handleRowClick}
                  onDragStart={startRowDrag}
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
  /// The DOM id `aria-activedescendant` names this row by (ADR 0044).
  /// Taken as the layer's stable mapper rather than the finished string
  /// so the memo still skips a row whose id hasn't moved.
  rowDomId: (id: string) => string;
  selected: boolean;
  onSelect: (rowKey: string, e: React.MouseEvent) => void;
  /// The row drags its whole message (ADR 0045); the decoded lines
  /// inside it drag one signal each and stop the event here.
  onDragStart: (rowKey: string, e: React.DragEvent) => void;
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
  rowDomId,
  selected,
  onSelect,
  onDragStart,
}: ByIdRowProps) {
  const frame = row?.frame ?? null;
  const rowKey = frame ? byIdRowKey(frame) : undefined;
  // The row *is* the disclosure control: it toggles on click, it is a
  // focus target, and Enter / Space toggle it from the keyboard. A row
  // with no decode has nothing to open, so it claims neither — it is
  // not a tab stop and does not report an expanded state.
  const expandable = frame?.decoded != null && rowKey != null;
  const toggle = () => {
    if (expandable) onToggle(rowKey);
  };
  return (
    <GridviewRow
      defs={COLUMN_DEFS}
      columns={columns}
      gridTemplate={gridTemplate}
      id={rowKey == null ? undefined : rowDomId(rowKey)}
      className={`trace-row ${isExpanded ? "expanded" : ""} ${frame ? "" : "loading"}${
        selected ? " selected" : ""
      }`}
      style={{ position: "absolute", top, left: 0, right: 0, height }}
      tabIndex={expandable ? 0 : undefined}
      aria-expanded={expandable ? isExpanded : undefined}
      aria-selected={rowKey == null ? undefined : selected}
      draggable={rowKey != null}
      onDragStart={rowKey == null ? undefined : (e) => onDragStart(rowKey, e)}
      onClick={(e) => {
        if (rowKey != null) onSelect(rowKey, e);
        toggle();
      }}
      onKeyDown={(e) => {
        if (!expandable || (e.key !== "Enter" && e.key !== " ")) return;
        // Space would scroll the rows container out from under the row.
        e.preventDefault();
        toggle();
      }}
      renderCell={(key, className) => {
        // The message cell carries the name and nothing else. A caret
        // beside it said nothing about what it did — it is mid-row,
        // where a disclosure indicator does not belong — so this view
        // renders the cell itself rather than taking `cellContent`'s
        // glyph-bearing one.
        if (key === "msg") {
          return <span className={className}>{frame?.decoded ? frame.decoded.name : ""}</span>;
        }
        const content = cellContent(
          key,
          frame,
          frame?.index ?? 0,
          baseTimestamp,
          idFormat,
          isExpanded,
          busLookup,
          row?.rate,
          row?.count,
        );
        return key === "time" ? (
          <TraceTimeCell
            className={className}
            seconds={frame?.timestamp_seconds ?? null}
            base={baseTimestamp}
          >
            {content}
          </TraceTimeCell>
        ) : (
          <span className={className}>{content}</span>
        );
      }}
    >
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
    </GridviewRow>
  );
});

// `DecodedSignalCell` is shared with `TraceView` — see `DecodedSignalCell.tsx`.
