/// The RBS signals panel: every field one `.cannet_rbs` config
/// transmits, and where its bits actually came from — the same shared
/// gridview (ADR 0044) `ViewSignalsPanel` uses, scoped to **one** RBS
/// element instead of combined across every open view. That is the
/// whole difference the grooming names ("same
/// component, opposite scoping rule"): both panels are thin views over
/// `GridviewHeader`/`GridviewRow`/`useGridview`/`arrayRowSpace`, a
/// status-chip taxonomy said in the status cell, and a status +
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
import { usePanelEditRecorder } from "./panelEditRecorder";

import type { RbsSignalRow } from "./types";
import { useHostMirror } from "./useHostMirror";
import { RbsValueCell, formatValue } from "./rbsValueCell";
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
import { makeRowGridPropsCache, useGridview, type RowGridProps } from "./useGridview";
import { arrayRowSpace, type GridviewAdapter, type GridviewRow as GridviewRowModel } from "./gridviewRows";
import { useDismissableMenu } from "./useDismissableMenu";
import { toggleInSet } from "./toggleSet";
import { formatCanIdHex } from "./format";
import { ChipButton } from "./ChipButton";
import { NameText } from "./NameText";
import { TwoStageRemoveButton } from "./TwoStageRemoveButton";

interface RbsSignalsPanelParams {
  [key: string]: unknown;
  elementId?: unknown;
  columns?: unknown;
  sort?: unknown;
  statusFilter?: unknown;
  busFilter?: unknown;
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
  // A fresh panel opens with every status on except Default (owner
  // ruling 2026-08-30): Default rows are DBC facts, not
  // customizations, so a new grid shows what the file changes and what
  // needs attention. Only when the params carry no filter at all — a
  // persisted one, the explicitly cleared empty set included, is
  // honored as saved.
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<RbsSignalDisplayStatus>>(() =>
    params?.statusFilter === undefined
      ? new Set(RBS_SIGNAL_STATUSES.filter((s) => s !== "default"))
      : stringSetFromParams(params.statusFilter, RBS_SIGNAL_STATUSES),
  );
  const [busFilter, setBusFilter] = useState<ReadonlySet<string>>(
    () => new Set(Array.isArray(params?.busFilter) ? params.busFilter.filter((v): v is string => typeof v === "string") : []),
  );
  useMemo(() => {
    api.updateParameters({
      elementId,
      columns,
      sort,
      statusFilter: [...statusFilter],
      busFilter: [...busFilter],
    });
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, elementId, columns, sort, statusFilter, busFilter]);

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

  // The recorder serves the *enable* toggle below and nothing else;
  // value edits — the Drop included — are deliberately unrecorded.
  // Undo covers project contents *except values* (ADR 0058), so no
  // chord ever changes what a message carries on the bus.
  const recordEdit = usePanelEditRecorder();
  const editSignal = useCallback(
    (row: RbsSignalRow, value: string | number | null) => {
      const target = { bus: row.busKey, ecu: row.ecuName, message: row.messageKey };
      void invoke("rbs_set_signal", { elementId, target, signal: row.signalName, value }).catch(
        () => {},
      );
    },
    [elementId],
  );
  const onCommit = useCallback(
    (row: RbsSignalRow, value: string | number) => editSignal(row, value),
    [editSignal],
  );
  const onClear = useCallback(
    (row: RbsSignalRow) => {
      // Clearing a row with no override moves nothing.
      if (!row.overridden) return;
      editSignal(row, null);
    },
    [editSignal],
  );
  // The Drop repair: a not-encoded row IS a stale override key, so the
  // delete goes straight through — no overridden guard (the synthesized
  // row reports false; the file entry is what the row exists for).
  // Unrecorded, final ruling: values are outside undo with NO
  // exceptions — the chord is global, and tripping on it must never
  // write an override. Which is why the button carries a confirm
  // stage: there is deliberately no way back but re-typing the entry.
  const onDrop = useCallback((row: RbsSignalRow) => editSignal(row, null), [editSignal]);

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
  /// Space is the layer's primary action on the cursor's row
  /// (ADR 0044). One idiom across both RBS panels: it activates or
  /// deactivates a message. Here the row is a *field* of one, so the
  /// press toggles the message that carries it — the state the row
  /// already reports, since Muted is exactly "this message will not
  /// play". Derived from that status rather than from the message's own
  /// flag on purpose: where the mute comes from the bus or the ECU the
  /// press is inert, which is honest, whereas flipping the message flag
  /// under it would be a change with nothing on screen to show it.
  const rowsRef = useRef<readonly RbsSignalRow[]>(allRows);
  rowsRef.current = allRows;
  const onPrimaryAction = useCallback(
    (id: string) => {
      const row = rowsRef.current.find((r) => r.id === id);
      if (row == null) return;
      const enabled = row.status === "muted";
      const base = {
        kind: "rbsEnable" as const,
        elementId,
        bus: row.busKey,
        ecu: row.ecuName,
        message: row.messageKey,
      };
      recordEdit({ undo: [{ ...base, enabled: !enabled }], redo: [{ ...base, enabled }] });
      void invoke("rbs_set_enabled", {
        elementId,
        bus: row.busKey,
        ecu: row.ecuName,
        message: row.messageKey,
        enabled,
      }).catch(() => {});
    },
    [elementId, recordEdit],
  );
  const grid = useGridview({
    adapter,
    pageRows: PAGE_ROWS,
    idPrefix: "rbs-signals",
    onPrimaryAction,
  });
  rowDomIdRef.current = grid.rowDomId;
  /// The row's DOM id and its click — the click is what hands the
  /// keyboard to the container, so a mouse-then-keyboard session can
  /// arrow (ADR 0044).
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const rowProps = useMemo(() => makeRowGridPropsCache(gridRef, containerRef), []);

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
                className="status-chip chip-button"
                aria-pressed={pressed}
                title={pressed ? `Stop filtering to ${STATUS_LABEL[s]}` : `Filter to ${STATUS_LABEL[s]}`}
                onClick={() => toggleStatus(s)}
              >
                <i className={`rbs-signals-chip rbs-signals-chip--${STATUS_CLASS[s]}`} aria-hidden="true" />
                <span className="status-chip-label">
                  {STATUS_LABEL[s]} ({count})
                </span>
              </button>
            );
          })}
        </span>
        <span className="chip-menu">
          <ChipButton
            label={busFilter.size === 0 ? "Bus: All" : `Bus: ${[...busFilter].sort().join(", ")}`}
            title="filter by bus"
            menuOpen={busMenuOpen}
            onPress={() => setBusMenuOpen((v) => !v)}
          />
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
        <span className="spacer" />
        <ChipButton
          label={countsLabel}
          title={onProblems ? "Show every status again" : "Filter to fields the frame does not carry as written"}
          onPress={toggleProblemsShortcut}
        />
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
              gridProps={rowProps(r.id)}
              onCommit={onCommit}
              onClear={onClear}
              onDrop={onDrop}
              selected={grid.selection.has(r.id)}
              active={grid.cursor === r.id}
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
  gridProps: RowGridProps;
  onCommit: (row: RbsSignalRow, value: string | number) => void;
  onClear: (row: RbsSignalRow) => void;
  onDrop: (row: RbsSignalRow) => void;
  selected: boolean;
  /// The gridview's cursor is on this row.
  active: boolean;
}

function RbsSignalRowLine({
  row,
  columns,
  gridTemplate,
  gridProps,
  onCommit,
  onClear,
  onDrop,
  selected,
  active,
}: RbsSignalRowLineProps) {
  const status = rbsSignalDisplayStatus(row);
  const disabled = row.status === "not-encoded" || row.status === "muted";
  return (
    <GridviewRow<RbsSignalColumnKey>
      defs={RBS_SIGNAL_COLUMN_DEFS}
      columns={columns}
      gridTemplate={gridTemplate}
      {...gridProps}
      className={`trace-row rbs-signals-row${selected ? " selected" : ""}`}
      aria-selected={selected}
      data-active={active || undefined}
      renderCell={(key, className) => {
        switch (key) {
          case "status":
            // The chip alone, as in the view-signals grid: the column
            // is swatch-wide, and the words live on the chip (tooltip
            // and accessible name) rather than as text it would
            // truncate.
            return (
              <span className={className}>
                <i
                  className={`rbs-signals-chip rbs-signals-chip--${STATUS_CLASS[status]}`}
                  title={STATUS_LABEL[status]}
                  role="img"
                  aria-label={STATUS_LABEL[status]}
                />
              </span>
            );
          case "bus":
            return <span className={className}>{row.busKey}</span>;
          case "msg":
            return (
              <span className={className}>
                0x{formatCanIdHex(row.messageId, row.extended)}{" "}
                <NameText name={row.messageName ?? ""} />
              </span>
            );
          case "signal":
            return (
              <span className={className}>
                <NameText name={row.signalName} />
              </span>
            );
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
                  inlineClear={false}
                />
              </span>
            );
          case "default":
            // The DBC's start value, or `none` — the fill-bit case,
            // which is a fact about the field rather than something
            // that happened to it, so it reads as a value here instead
            // of as a sentence in the detail column.
            return (
              <span className={className}>
                {row.defaultValue == null ? (
                  <span className="rbs-signals-no-default">none</span>
                ) : (
                  formatValue(row.defaultValue)
                )}
              </span>
            );
          case "unit":
            return <span className={className}>{row.unit}</span>;
          case "detail":
            return <span className={`${className} rbs-signals-detail`}>{row.detail}</span>;
          case "remove":
            // The row's removal, in its own column: every value
            // removal — an applied override's clear, and the
            // not-encoded row's drop (an override key nothing encodes,
            // whose value cell is rightly disabled) — is the shared
            // two-stage trash (`TwoStageRemoveButton`, the transmit
            // panel row's pattern). Not undoable — values never ride
            // the chord — which is why it confirms.
            return (
              <span className={className}>
                {(row.overridden || row.status === "not-encoded") && (
                  <TwoStageRemoveButton
                    label={
                      row.status === "not-encoded"
                        ? "drop override"
                        : `clear ${row.signalName} override`
                    }
                    title={
                      row.status === "not-encoded"
                        ? "drop this override — delete its entry from the RBS file"
                        : `clear override (track DBC default)${row.overrideText ? ` — currently ${row.overrideText}` : ""}`
                    }
                    onRemove={() => onDrop(row)}
                  />
                )}
              </span>
            );
          default:
            return <span className={className} />;
        }
      }}
    />
  );
}
