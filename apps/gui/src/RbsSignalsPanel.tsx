/// The RBS signals panel: every field one `.cannet_rbs` config
/// transmits, and where its bits actually came from — the same shared
/// gridview (ADR 0044) `ViewSignalsPanel` uses, scoped to **one** RBS
/// element instead of combined across every open view. That is the
/// whole difference the grooming names ("same
/// component, opposite scoping rule"): both panels are thin views over
/// `GridviewHeader`/`GridviewRow`/`useGridview`/`arrayRowSpace`, a
/// status-chip taxonomy with toggleable row washes, and a status +
/// bus toolbar filter on the nothing-selected-is-no-filter model —
/// this one is simply not a singleton, and its rows never merge across
/// two `.cannet_rbs` files, because two RBS sims are meant to hold
/// different values and timings.
///
/// Unlike the views grid, this one edits: the value cell is the same
/// `RbsValueCell` the RBS panel's own tree uses, clamped on entry
/// through the same shared code (`rbsValueClamp.ts`) — the two must
/// agree at the boundary, so there is exactly one implementation.
///
/// Sorting runs client-side (`sortRbsSignalRows`), not delegated to
/// the host the way `list_view_signals` is: Out of Range is decided in
/// the frontend, so no host sort key alone determines this grid's
/// severity order. The row set is one config's fields — bounded the
/// same way the views panel's is — so this adds no cost `CLAUDE.md`'s
/// paging rule is about.

import { useCallback, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

import type { RbsSignalRow } from "./types";
import { useHostMirror } from "./useHostMirror";
import { RbsValueCell } from "./rbsValueCell";
import { nextSort, resizeColumn, toggleColumn, reorderColumn } from "./traceColumns";
import {
  RBS_SIGNAL_UNSORTABLE,
  rbsSignalColumnsFromParams,
  rbsSignalGridTemplateColumns,
  sortRbsSignalRows,
  DEFAULT_RBS_SIGNAL_SORT,
  RBS_SIGNAL_COLUMN_DEFS,
  type RbsSignalColumnKey,
  type RbsSignalColumnState,
  type RbsSignalSortState,
} from "./rbsSignalsColumns";
import {
  RBS_SIGNAL_PROBLEM_STATUSES,
  RBS_SIGNAL_STATUSES,
  applyRbsSignalFilters,
  isRbsProblemFilter,
  rbsSignalBusOptions,
  rbsSignalDisplayStatus,
  type RbsSignalDisplayStatus,
} from "./rbsSignalsFilter";
import { GridviewHeader, GridviewRow } from "./gridviewColumns";
import { useGridview } from "./useGridview";
import { arrayRowSpace, type GridviewAdapter, type GridviewRow as GridviewRowModel } from "./gridviewRows";
import { useDismissableMenu } from "./useDismissableMenu";
import { toggleInSet } from "./toggleSet";
import { formatCanIdHex } from "./format";

interface RbsSignalsPanelParams {
  [key: string]: unknown;
  elementId?: unknown;
  columns?: unknown;
  sort?: unknown;
  statusFilter?: unknown;
  busFilter?: unknown;
  washesOn?: unknown;
}

function elementIdFromParams(params: unknown): string {
  const p = params as RbsSignalsPanelParams | undefined;
  return typeof p?.elementId === "string" ? p.elementId : "";
}

function sortFromParams(raw: unknown): RbsSignalSortState {
  if (raw === null) return null;
  const o = raw as { key?: unknown; dir?: unknown } | undefined;
  const key = o?.key;
  const dir = o?.dir;
  if (
    typeof key === "string" &&
    RBS_SIGNAL_COLUMN_DEFS.some((d) => d.key === key) &&
    (dir === "asc" || dir === "desc")
  ) {
    return { key: key as RbsSignalColumnKey, dir };
  }
  return DEFAULT_RBS_SIGNAL_SORT;
}

function stringSetFromParams<T extends string>(raw: unknown, valid: readonly T[]): Set<T> {
  if (!Array.isArray(raw)) return new Set();
  const known = new Set<string>(valid);
  return new Set(raw.filter((v): v is T => typeof v === "string" && known.has(v)));
}

const STATUS_CLASS: Record<RbsSignalDisplayStatus, string> = {
  "not-encoded": "not-encoded",
  "out-of-range": "out-of-range",
  "unknown-value": "unknown-value",
  override: "override",
  default: "default",
  muted: "muted",
};
const STATUS_LABEL: Record<RbsSignalDisplayStatus, string> = {
  "not-encoded": "Not Encoded",
  "out-of-range": "Out of Range",
  "unknown-value": "Unknown Value",
  override: "Override",
  default: "Default",
  muted: "Muted",
};

function rowId(r: RbsSignalRow): string {
  return r.id;
}

const PAGE_ROWS = 20;

export function RbsSignalsPanel(props: IDockviewPanelProps) {
  const { api, params: rawParams } = props;
  const params = rawParams as RbsSignalsPanelParams | undefined;
  const elementId = elementIdFromParams(rawParams);

  const [columns, setColumns] = useState<RbsSignalColumnState[]>(() =>
    rbsSignalColumnsFromParams(params?.columns),
  );
  const [sort, setSort] = useState<RbsSignalSortState>(() => sortFromParams(params?.sort));
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<RbsSignalDisplayStatus>>(() =>
    stringSetFromParams(params?.statusFilter, RBS_SIGNAL_STATUSES),
  );
  const [busFilter, setBusFilter] = useState<ReadonlySet<string>>(
    () => new Set(Array.isArray(params?.busFilter) ? params.busFilter.filter((v): v is string => typeof v === "string") : []),
  );
  const [washesOn, setWashesOn] = useState<boolean>(() =>
    typeof params?.washesOn === "boolean" ? params.washesOn : true,
  );

  useMemo(() => {
    api.updateParameters({
      elementId,
      columns,
      sort,
      statusFilter: [...statusFilter],
      busFilter: [...busFilter],
      washesOn,
    });
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, elementId, columns, sort, statusFilter, busFilter, washesOn]);

  // --- the host model ---
  const fetchRows = useCallback(
    () => invoke<RbsSignalRow[] | null>("rbs_signal_rows", { elementId }),
    [elementId],
  );
  const { value: rows } = useHostMirror<RbsSignalRow[] | null, string>({
    fetch: fetchRows,
    fallback: null,
    // `rbs-changed` already covers every input this grid depends on:
    // the element's own edits, and a DBC assignment/edit
    // (`refresh_all_elements` broadcasts `"*"` on every DBC mutation).
    event: "rbs-changed",
    matches: (payload) => payload === elementId || payload === "*",
  });
  const allRows = rows ?? [];

  const onCommit = useCallback(
    (row: RbsSignalRow, value: string | number) => {
      void invoke("rbs_set_signal", {
        elementId,
        target: { bus: row.busKey, ecu: row.ecuName, message: row.messageKey },
        signal: row.signalName,
        value,
      }).catch(() => {});
    },
    [elementId],
  );
  const onClear = useCallback(
    (row: RbsSignalRow) => {
      void invoke("rbs_set_signal", {
        elementId,
        target: { bus: row.busKey, ecu: row.ecuName, message: row.messageKey },
        signal: row.signalName,
        value: null,
      }).catch(() => {});
    },
    [elementId],
  );

  // --- toolbar filters (nothing selected is no filter) ---
  const toggleStatus = useCallback(
    (s: RbsSignalDisplayStatus) => setStatusFilter((prev) => toggleInSet(prev, s)),
    [],
  );
  const busOptions = useMemo(() => rbsSignalBusOptions(allRows), [allRows]);
  const toggleBus = useCallback((key: string) => setBusFilter((prev) => toggleInSet(prev, key)), []);
  const filteredRows = useMemo(
    () => applyRbsSignalFilters(allRows, statusFilter, busFilter),
    [allRows, statusFilter, busFilter],
  );
  const sortedRows = useMemo(() => sortRbsSignalRows(filteredRows, sort), [filteredRows, sort]);
  const onProblems = isRbsProblemFilter(statusFilter);
  const toggleProblemsShortcut = useCallback(() => {
    setStatusFilter(onProblems ? new Set() : new Set(RBS_SIGNAL_PROBLEM_STATUSES));
  }, [onProblems]);

  const [busMenuOpen, setBusMenuOpen] = useState(false);
  const busMenuRef = useDismissableMenu<HTMLDivElement>(busMenuOpen, () => setBusMenuOpen(false));

  // --- columns ---
  const onColumnResize = useCallback(
    (key: RbsSignalColumnKey, width: number) => setColumns((cs) => resizeColumn(cs, key, width)),
    [],
  );
  const onColumnToggle = useCallback(
    (key: RbsSignalColumnKey) => setColumns((cs) => toggleColumn(cs, key)),
    [],
  );
  const onColumnReorder = useCallback(
    (key: RbsSignalColumnKey, beforeKey: RbsSignalColumnKey | null) =>
      setColumns((cs) => reorderColumn(cs, key, beforeKey)),
    [],
  );
  const onSortColumn = useCallback((key: RbsSignalColumnKey) => {
    if (RBS_SIGNAL_UNSORTABLE.has(key)) return;
    setSort((s) => nextSort(s, key));
  }, []);
  const gridTemplate = useMemo(() => rbsSignalGridTemplateColumns(columns), [columns]);
  const visible = useMemo(() => columns.filter((c) => c.visible), [columns]);

  // --- the gridview (ADR 0044) ---
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gridRows = useMemo<GridviewRowModel[]>(
    () => sortedRows.map((r) => ({ id: rowId(r), kind: "leaf", expandable: false, depth: 0 })),
    [sortedRows],
  );
  const rowDomIdRef = useRef<(id: string) => string>(() => "");
  const adapter = useMemo<GridviewAdapter>(() => {
    const space = arrayRowSpace(gridRows, () => false);
    return {
      ...space,
      scrollToRow: (index) => {
        const id = space.rowIdAt(index);
        const container = containerRef.current;
        if (id == null || container == null) return;
        const el = document.getElementById(rowDomIdRef.current(id));
        if (el == null) return;
        const c = container.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.top < c.top) container.scrollTop += r.top - c.top;
        else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom;
      },
      setExpanded: () => {},
      isSelectable: () => true,
    };
  }, [gridRows]);
  const grid = useGridview({ adapter, pageRows: PAGE_ROWS, idPrefix: "rbs-signals" });
  rowDomIdRef.current = grid.rowDomId;

  const busCount = new Set(allRows.map((r) => r.busKey)).size;
  const problemCount = allRows.filter((r) => RBS_SIGNAL_PROBLEM_STATUSES.includes(rbsSignalDisplayStatus(r))).length;
  const countsLabel =
    statusFilter.size === 0 && busFilter.size === 0
      ? `${problemCount} of ${allRows.length} need attention`
      : `${filteredRows.length} of ${allRows.length} shown`;

  return (
    <div className="rbs-signals-panel">
      <div className="rbs-signals-toolbar">
        <span className="rbs-signals-filters">
          {RBS_SIGNAL_STATUSES.map((s) => {
            const pressed = statusFilter.has(s);
            const count = allRows.filter((r) => rbsSignalDisplayStatus(r) === s).length;
            return (
              <button
                key={s}
                type="button"
                className="rbs-signals-status-filter"
                aria-pressed={pressed}
                title={pressed ? `Stop filtering to ${STATUS_LABEL[s]}` : `Filter to ${STATUS_LABEL[s]}`}
                onClick={() => toggleStatus(s)}
              >
                <i className={`rbs-signals-chip rbs-signals-chip--${STATUS_CLASS[s]}`} aria-hidden="true" />
                <span>
                  {STATUS_LABEL[s]} ({count})
                </span>
              </button>
            );
          })}
        </span>
        <span className="rbs-signals-busfilter">
          <button
            type="button"
            className="rbs-signals-busbtn"
            aria-haspopup="menu"
            aria-expanded={busMenuOpen}
            onClick={() => setBusMenuOpen((v) => !v)}
          >
            {busFilter.size === 0
              ? "Bus: all"
              : `Bus: ${[...busFilter].sort().join(", ")}`}
          </button>
          {busMenuOpen && (
            <div ref={busMenuRef} className="rbs-signals-busmenu" role="menu">
              {busOptions.map((o) => (
                <label key={o.key}>
                  <input type="checkbox" checked={busFilter.has(o.key)} onChange={() => toggleBus(o.key)} />
                  <span className="rbs-signals-busmenu-label">{o.key}</span>
                  <span className="rbs-signals-busmenu-n">{o.count}</span>
                </label>
              ))}
              {busFilter.size > 0 && (
                <>
                  <div className="rbs-signals-busmenu-rule" />
                  <button type="button" onClick={() => setBusFilter(new Set())}>
                    Clear (show all buses)
                  </button>
                </>
              )}
            </div>
          )}
        </span>
        <label
          className="rbs-signals-wash-toggle"
          title="highlight each row's background by its status; the status column always names it"
        >
          <input type="checkbox" checked={washesOn} onChange={(e) => setWashesOn(e.target.checked)} />
          row highlights
        </label>
        <span className="spacer" />
        <button
          type="button"
          className="rbs-signals-counts"
          title={onProblems ? "Show every status again" : "Filter to fields the frame does not carry as written"}
          onClick={toggleProblemsShortcut}
        >
          {countsLabel}
        </button>
      </div>
      <div ref={containerRef} className="rbs-signals-rows" {...grid.containerProps}>
        <GridviewHeader<RbsSignalColumnKey>
          defs={RBS_SIGNAL_COLUMN_DEFS}
          columns={columns}
          onColumnResize={onColumnResize}
          onColumnToggle={onColumnToggle}
          onColumnReorder={onColumnReorder}
          sort={sort}
          onSortColumn={onSortColumn}
        />
        {sortedRows.length === 0 ? (
          <div className="rbs-signals-empty">
            {allRows.length === 0 ? "This config transmits no fields yet." : "No row matches the current filters."}
          </div>
        ) : (
          sortedRows.map((r) => (
            <RbsSignalRowLine
              key={r.id}
              row={r}
              columns={visible}
              gridTemplate={gridTemplate}
              washesOn={washesOn}
              rowDomId={grid.rowDomId}
              onCommit={onCommit}
              onClear={onClear}
              selected={grid.selection.has(r.id)}
              onSelect={(id, e) => grid.onRowClick(id, { mod: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
            />
          ))
        )}
      </div>
      <div className="rbs-signals-footer">
        {allRows.length} fields across {busCount} buses
      </div>
    </div>
  );
}

interface RbsSignalRowLineProps {
  row: RbsSignalRow;
  columns: readonly RbsSignalColumnState[];
  gridTemplate: string;
  washesOn: boolean;
  rowDomId: (id: string) => string;
  onCommit: (row: RbsSignalRow, value: string | number) => void;
  onClear: (row: RbsSignalRow) => void;
  selected: boolean;
  onSelect: (id: string, e: React.MouseEvent) => void;
}

function RbsSignalRowLine({
  row,
  columns,
  gridTemplate,
  washesOn,
  rowDomId,
  onCommit,
  onClear,
  selected,
  onSelect,
}: RbsSignalRowLineProps) {
  const status = rbsSignalDisplayStatus(row);
  const disabled = row.status === "not-encoded" || row.status === "muted";
  return (
    <GridviewRow<RbsSignalColumnKey>
      defs={RBS_SIGNAL_COLUMN_DEFS}
      columns={columns}
      gridTemplate={gridTemplate}
      id={rowDomId(row.id)}
      className={`trace-row rbs-signals-row${washesOn ? ` rbs-signals-row--wash-${STATUS_CLASS[status]}` : ""}${selected ? " selected" : ""}`}
      aria-selected={selected}
      onClick={(e) => onSelect(row.id, e)}
      renderCell={(key, className) => {
        switch (key) {
          case "status":
            return (
              <span className={className}>
                <i
                  className={`rbs-signals-chip rbs-signals-chip--${STATUS_CLASS[status]}`}
                  title={STATUS_LABEL[status]}
                  aria-hidden="true"
                />
                {!washesOn && <span className="rbs-signals-status-text">{STATUS_LABEL[status]}</span>}
              </span>
            );
          case "bus":
            return <span className={className}>{row.busKey}</span>;
          case "msg":
            return (
              <span className={className}>
                0x{formatCanIdHex(row.messageId, row.extended)} {row.messageName ?? ""}
              </span>
            );
          case "signal":
            return <span className={className}>{row.signalName}</span>;
          case "value":
            return (
              <span className={className} onClick={(e) => e.stopPropagation()}>
                <RbsValueCell
                  signal={{
                    name: row.signalName,
                    value: row.value,
                    label: row.label,
                    overridden: row.overridden,
                    overrideText: row.overrideText,
                    calcRole: row.calcRole,
                    factor: row.factor,
                    offset: row.offset,
                    min: row.min,
                    max: row.max,
                    size: row.size,
                    signed: row.signed,
                    hasValueTable: row.hasValueTable,
                  }}
                  busId={row.busId}
                  messageId={row.messageId}
                  extended={row.extended}
                  disabled={disabled}
                  onCommit={(value) => onCommit(row, value)}
                  onClear={() => onClear(row)}
                />
              </span>
            );
          case "unit":
            return <span className={className}>{row.unit}</span>;
          case "detail":
            return <span className={`${className} rbs-signals-detail`}>{row.detail}</span>;
          default:
            return <span className={className} />;
        }
      }}
    />
  );
}
