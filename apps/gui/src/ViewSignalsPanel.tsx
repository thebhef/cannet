import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { ViewSignalCandidate, ViewSignalRow, ViewSignalStatus } from "./types";
import { useRemapSignal } from "./signalRemap";
import { useProjectContext } from "./projectContext";
import { useDbcGeneration } from "./dbcChanged";
import { basename } from "./windowTitle";
import { formatCanIdHex } from "./format";
import { nextSort, resizeColumn, toggleColumn, reorderColumn } from "./traceColumns";
import {
  VIEW_SIGNAL_UNSORTABLE,
  viewSignalColumnsFromParams,
  viewSignalGridTemplateColumns,
  DEFAULT_VIEW_SIGNAL_SORT,
  VIEW_SIGNAL_COLUMN_DEFS,
  type ViewSignalColumnKey,
  type ViewSignalColumnState,
  type ViewSignalSortState,
} from "./viewSignalsColumns";
import {
  VIEW_SIGNAL_ATTENTION_STATUSES,
  VIEW_SIGNAL_STATUSES,
  applyViewSignalFilters,
  isAttentionFilter,
  viewSignalBusOptions,
} from "./viewSignalsFilter";
import { GridviewHeader, GridviewRow } from "./gridviewColumns";
import { useGridview } from "./useGridview";
import { arrayRowSpace, type GridviewAdapter, type GridviewRow as GridviewRowModel } from "./gridviewRows";
import { useDismissableMenu } from "./useDismissableMenu";
import { toggleInSet } from "./toggleSet";
import { NameText } from "./NameText";

/// This panel's persisted view state — the column layout, sort, the
/// toolbar filters and the wash toggle. All workspace state (nothing
/// here grows with the project, and none of it is a model fact — the
/// rows themselves always come from the host).
interface ViewSignalsPanelParams {
  [key: string]: unknown;
  columns?: unknown;
  sort?: unknown;
  statusFilter?: unknown;
  busFilter?: unknown;
  washesOn?: unknown;
}

function sortFromParams(raw: unknown): ViewSignalSortState {
  if (raw === null) return null;
  const o = raw as { key?: unknown; dir?: unknown } | undefined;
  const key = o?.key;
  const dir = o?.dir;
  if (
    typeof key === "string" &&
    (VIEW_SIGNAL_COLUMN_DEFS.some((d) => d.key === key)) &&
    (dir === "asc" || dir === "desc")
  ) {
    return { key: key as ViewSignalColumnKey, dir };
  }
  return DEFAULT_VIEW_SIGNAL_SORT;
}

function stringSetFromParams<T extends string>(raw: unknown, valid: readonly T[]): Set<T> {
  if (!Array.isArray(raw)) return new Set();
  const known = new Set<string>(valid);
  return new Set(raw.filter((v): v is T => typeof v === "string" && known.has(v)));
}

/// The status taxonomy's chip class suffix — `"not-decoded"` etc. reads
/// verbatim as a CSS class already (kebab-case), so this is just the
/// central place that says so.
const STATUS_CLASS: Record<ViewSignalStatus, string> = {
  "not-decoded": "not-decoded",
  scale: "scale",
  ambiguous: "ambiguous",
  stale: "stale",
  decoded: "decoded",
};
const STATUS_LABEL: Record<ViewSignalStatus, string> = {
  "not-decoded": "Not Decoded",
  scale: "Scale",
  ambiguous: "Ambiguous",
  stale: "Stale",
  decoded: "Decoded",
};
/// A short reason for a row's status when the host reports no `diffs`
/// to state instead (Not Decoded / Ambiguous never carry one — there is
/// nothing to compare, only a fact to state). Purely presentational: the
/// fact itself (`row.status`) is the host's; this only phrases it.
const STATUS_NOTE: Partial<Record<ViewSignalStatus, string>> = {
  "not-decoded": "No mapped database decodes this field",
  ambiguous: "Multiple databases decode this field",
};

/// One row's detail cell: the diff pairs the host reported ("mapped as
/// X, decoded by Y" per drifted field), or a status-keyed note when
/// there is nothing to diff, or nothing at all for a clean Decoded row.
function detailContent(row: ViewSignalRow): { mapped: string; decoded: string } | string | null {
  if (row.diffs.length > 0) {
    return {
      mapped: row.diffs.map((d) => d.mapped).join(", "),
      decoded: row.diffs.map((d) => d.decoded).join(", "),
    };
  }
  return STATUS_NOTE[row.status] ?? null;
}

/// Row-key identity for the gridview (ADR 0044): the row's own signal
/// identity, already unique per row (`view_signals.rs` keys the model
/// on it).
function rowId(r: ViewSignalRow): string {
  return r.id;
}

const PAGE_ROWS = 20;

/**
 * The view-signals panel: every signal the open views
 * reference, live, and what currently decodes it — the one place the
 * mapping between a view's signal picks and the databases assigned to
 * its bus is surfaced and (in later phases) repaired.
 *
 * A thin view over [`list_view_signals`]: status, serving database,
 * used-by and the candidates are all host-computed (`view_signals.rs`);
 * this panel shapes them for the shared gridview (ADR 0044) and nothing
 * more. Refetches on `view-signals-changed` (a view's push changed) and
 * on the DBC-change generation (ADR 0053 — a database was
 * assigned/unassigned/edited). Not paged: the row count is bounded by
 * how many signals the open views reference, not by capture length, so
 * one unbounded fetch is the host's own answer
 * (`ViewSignalPage`) and there is nothing here for `CLAUDE.md`'s paging
 * rule to apply to.
 *
 * Singleton, like the Database / Events panels: the model is
 * project-wide, so a second instance would carry no differentiation.
 *
 * The source (candidate) picker makes both of this panel's picks, and
 * which one a choice is depends only on whether it names the row's own
 * signal:
 *
 * - **the ambiguity pick** — the same signal under a different
 *   database. Recorded in the project (`set_signal_dbc_pick`) as the
 *   database the *decoder* resolves this signal through, not merely
 *   what this panel displays.
 * - **the remap pick** — a different signal of the same message, which
 *   is what a renamed signal looks like from here. It rewrites every
 *   persisted reference to the old name through the one shared
 *   operation (`signalRemap.ts`), so it lands on every view at once
 *   rather than per view.
 *
 * Neither has an apply step. The element writes land synchronously and
 * the host writes announce themselves (a DBC change, a transmit-pool
 * change, and the views' own re-push), which is what brings this
 * panel's rows back carrying the new answer.
 */
export function ViewSignalsPanel(props: IDockviewPanelProps) {
  const { api } = props;
  const params = props.params as ViewSignalsPanelParams | undefined;
  const { buses } = useProjectContext();

  const [columns, setColumns] = useState<ViewSignalColumnState[]>(() =>
    viewSignalColumnsFromParams(params?.columns),
  );
  const [sort, setSort] = useState<ViewSignalSortState>(() => sortFromParams(params?.sort));
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<ViewSignalStatus>>(() =>
    stringSetFromParams(params?.statusFilter, VIEW_SIGNAL_STATUSES),
  );
  const [busFilter, setBusFilter] = useState<ReadonlySet<string>>(
    () => new Set(Array.isArray(params?.busFilter) ? params.busFilter.filter((v): v is string => typeof v === "string") : []),
  );
  const [washesOn, setWashesOn] = useState<boolean>(() =>
    typeof params?.washesOn === "boolean" ? params.washesOn : true,
  );

  useEffect(() => {
    api.updateParameters({
      columns,
      sort,
      statusFilter: [...statusFilter],
      busFilter: [...busFilter],
      washesOn,
    });
  }, [api, columns, sort, statusFilter, busFilter, washesOn]);

  // --- the host model ---
  const [rows, setRows] = useState<ViewSignalRow[]>([]);
  const [attentionCount, setAttentionCount] = useState(0);
  const [total, setTotal] = useState(0);
  const busNames = useMemo<[string, string][]>(
    () => buses.map((b) => [b.id, b.name]),
    [buses],
  );
  const refresh = useCallback(() => {
    let cancelled = false;
    void invoke<{ rows: ViewSignalRow[]; attentionCount: number; total: number }>(
      "list_view_signals",
      { sortKey: sort?.key ?? null, sortDir: sort?.dir ?? null, busNames },
    )
      .then((page) => {
        if (cancelled) return;
        setRows(page.rows);
        setAttentionCount(page.attentionCount);
        setTotal(page.total);
      })
      .catch(() => {
        /* best effort — the panel keeps showing its last snapshot */
      });
    return () => {
      cancelled = true;
    };
  }, [sort, busNames]);
  // The other half of the model's inputs: a database
  // assigned/unassigned/edited (ADR 0053 §2, which also covers
  // assignment changes). One effect, not two — `refresh`
  // already runs on mount and on every `sort` / `busNames` change; this
  // just adds the DBC generation to that same dependency list rather
  // than firing a second fetch alongside it on every render.
  const dbcGeneration = useDbcGeneration();
  useEffect(() => refresh(), [dbcGeneration, refresh]);
  // A view's push changed — a signal selection added, removed, or a
  // recorded field (message name / unit) edited (`view_signals.rs`).
  useEffect(() => {
    const unlisten = listen("view-signals-changed", () => refresh());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  // A source pick. No apply step and no local state: the host records
  // the choice and announces it as a DBC change, which the fetch above
  // already listens for.
  const onPick = useCallback((signal: string, dbcPath: string) => {
    void invoke("set_signal_dbc_pick", { signal, dbcPath }).catch(() => {
      /* best effort — the panel keeps showing the host's last answer */
    });
  }, []);

  // A remap pick: the candidate names a *different* signal, so what
  // has to change is every view's stored reference rather than which
  // database decodes it. One operation over every store
  // (`signalRemap.ts`) — the rows come back through the views' own
  // re-push, as they do for any other config edit.
  const remapSignal = useRemapSignal();
  const onRemap = useCallback(
    (row: ViewSignalRow, candidate: ViewSignalCandidate) => {
      remapSignal({
        busId: row.busId,
        messageId: row.messageId,
        extended: row.extended,
        from: row.signalName,
        to: candidate.signalName,
        messageName: candidate.messageName,
        unit: candidate.unit,
        dbcPath: candidate.dbcPath,
      });
    },
    [remapSignal],
  );

  // --- toolbar filters (owner ruling: nothing selected is no filter) ---
  const toggleStatus = useCallback(
    (s: ViewSignalStatus) => setStatusFilter((prev) => toggleInSet(prev, s)),
    [],
  );
  const busOptions = useMemo(() => viewSignalBusOptions(rows), [rows]);
  const toggleBus = useCallback(
    (key: string) => setBusFilter((prev) => toggleInSet(prev, key)),
    [],
  );
  const filteredRows = useMemo(
    () => applyViewSignalFilters(rows, statusFilter, busFilter),
    [rows, statusFilter, busFilter],
  );
  const onAttention = isAttentionFilter(statusFilter);
  const toggleAttentionShortcut = useCallback(() => {
    setStatusFilter(onAttention ? new Set() : new Set(VIEW_SIGNAL_ATTENTION_STATUSES));
  }, [onAttention]);

  const [busMenuOpen, setBusMenuOpen] = useState(false);
  const busMenuRef = useDismissableMenu<HTMLDivElement>(busMenuOpen, () => setBusMenuOpen(false));

  // --- columns ---
  const onColumnResize = useCallback(
    (key: ViewSignalColumnKey, width: number) => setColumns((cs) => resizeColumn(cs, key, width)),
    [],
  );
  const onColumnToggle = useCallback(
    (key: ViewSignalColumnKey) => setColumns((cs) => toggleColumn(cs, key)),
    [],
  );
  const onColumnReorder = useCallback(
    (key: ViewSignalColumnKey, beforeKey: ViewSignalColumnKey | null) =>
      setColumns((cs) => reorderColumn(cs, key, beforeKey)),
    [],
  );
  // Sort execution stays with the host (`gridviewColumns.tsx`'s own
  // header comment: the gridview owns the sort affordance, not sort
  // execution — matching `CLAUDE.md`'s paging rule that the host sorts
  // and the frontend renders): this just cycles the affordance and
  // re-fetches. `source` / `detail`
  // carry no host sort, so a click on them is a no-op — the same shape
  // the signals view's `section` column uses.
  const onSortColumn = useCallback((key: ViewSignalColumnKey) => {
    if (VIEW_SIGNAL_UNSORTABLE.has(key)) return;
    setSort((s) => nextSort(s, key));
  }, []);
  const gridTemplate = useMemo(() => viewSignalGridTemplateColumns(columns), [columns]);
  const visible = useMemo(() => columns.filter((c) => c.visible), [columns]);

  // --- the gridview (ADR 0044) ---
  // A flat leaf list — every row the host already sorted, with no
  // expansion or disclosure content. The row count is bounded (the
  // signals the open views reference), so there is no virtualization
  // here, unlike the paged trace/by-id/signal views.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gridRows = useMemo<GridviewRowModel[]>(
    () => filteredRows.map((r) => ({ id: rowId(r), kind: "leaf", expandable: false, depth: 0 })),
    [filteredRows],
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
  const grid = useGridview({ adapter, pageRows: PAGE_ROWS, idPrefix: "view-signals" });
  rowDomIdRef.current = grid.rowDomId;

  const countsLabel =
    statusFilter.size === 0 && busFilter.size === 0
      ? `${attentionCount} of ${total} need attention`
      : `${filteredRows.length} of ${total} shown`;
  const busCount = new Set(rows.map((r) => r.busId ?? "")).size;

  return (
    <div className="view-signals-panel">
      <div className="view-signals-toolbar">
        <span className="view-signals-filters">
          {VIEW_SIGNAL_STATUSES.map((s) => {
            const pressed = statusFilter.has(s);
            const count = rows.filter((r) => r.status === s).length;
            return (
              <button
                key={s}
                type="button"
                className="view-signals-status-filter"
                aria-pressed={pressed}
                title={pressed ? `Stop filtering to ${STATUS_LABEL[s]}` : `Filter to ${STATUS_LABEL[s]}`}
                onClick={() => toggleStatus(s)}
              >
                <i className={`view-signals-chip view-signals-chip--${STATUS_CLASS[s]}`} aria-hidden="true" />
                <span>
                  {STATUS_LABEL[s]} ({count})
                </span>
              </button>
            );
          })}
        </span>
        <span className="view-signals-busfilter">
          <button
            type="button"
            className="view-signals-busbtn"
            aria-haspopup="menu"
            aria-expanded={busMenuOpen}
            onClick={() => setBusMenuOpen((v) => !v)}
          >
            {busFilter.size === 0
              ? "Bus: all"
              : `Bus: ${busOptions.filter((o) => busFilter.has(o.key)).map((o) => o.label).join(", ")}`}
          </button>
          {busMenuOpen && (
            <div ref={busMenuRef} className="view-signals-busmenu" role="menu">
              {busOptions.map((o) => (
                <label key={o.key}>
                  <input
                    type="checkbox"
                    checked={busFilter.has(o.key)}
                    onChange={() => toggleBus(o.key)}
                  />
                  <span className="view-signals-busmenu-label">{o.label}</span>
                  <span className="view-signals-busmenu-n">{o.count}</span>
                </label>
              ))}
              {busFilter.size > 0 && (
                <>
                  <div className="view-signals-busmenu-rule" />
                  <button type="button" onClick={() => setBusFilter(new Set())}>
                    Clear (show all buses)
                  </button>
                </>
              )}
            </div>
          )}
        </span>
        <label
          className="view-signals-wash-toggle"
          title="highlight each row's background by its status; the status column always names it"
        >
          <input
            type="checkbox"
            checked={washesOn}
            onChange={(e) => setWashesOn(e.target.checked)}
          />
          row highlights
        </label>
        <span className="spacer" />
        <button
          type="button"
          className="view-signals-counts"
          title={onAttention ? "Show every status again" : "Filter to the signals needing attention"}
          onClick={toggleAttentionShortcut}
        >
          {countsLabel}
        </button>
      </div>
      {/* The rows container is the gridview container (ADR 0044): it
          holds focus and names the active row via
          `aria-activedescendant`. The header renders inside it (sticky,
          not a separate scroller) so it scrolls horizontally in lockstep
          with the rows without the trace views' header-scroll-sync
          machinery — this panel is never virtualized, so there is no
          reason the header has to sit outside the one scroll container. */}
      <div ref={containerRef} className="view-signals-rows" {...grid.containerProps}>
        <GridviewHeader<ViewSignalColumnKey>
          defs={VIEW_SIGNAL_COLUMN_DEFS}
          columns={columns}
          onColumnResize={onColumnResize}
          onColumnToggle={onColumnToggle}
          onColumnReorder={onColumnReorder}
          sort={sort}
          onSortColumn={onSortColumn}
        />
        {filteredRows.length === 0 ? (
          <div className="view-signals-empty">
            {total === 0
              ? "No open view references a signal yet."
              : "No row matches the current filters."}
          </div>
        ) : (
          filteredRows.map((r) => (
            <ViewSignalRowLine
              key={r.id}
              row={r}
              columns={visible}
              gridTemplate={gridTemplate}
              washesOn={washesOn}
              rowDomId={grid.rowDomId}
              onPick={onPick}
              onRemap={onRemap}
              selected={grid.selection.has(r.id)}
              onSelect={(id, e) =>
                grid.onRowClick(id, { mod: e.ctrlKey || e.metaKey, shift: e.shiftKey })
              }
            />
          ))
        )}
      </div>
      <div className="view-signals-footer">
        {total} signals across {busCount} buses
      </div>
    </div>
  );
}

/// One candidate's `<option>` value: its database path and signal
/// name, separated by a NUL so neither half can be confused with the
/// other whatever a path contains.
function candidateValue(dbcPath: string, signalName: string): string {
  return `${dbcPath}\0${signalName}`;
}

/// The `(database, signal)` pair an `<option>` value names.
function parseCandidateValue(value: string): { dbcPath: string; signalName: string } | null {
  const sep = value.lastIndexOf("\0");
  if (sep < 0) return null;
  return { dbcPath: value.slice(0, sep), signalName: value.slice(sep + 1) };
}

interface ViewSignalRowLineProps {
  row: ViewSignalRow;
  columns: readonly ViewSignalColumnState[];
  gridTemplate: string;
  washesOn: boolean;
  rowDomId: (id: string) => string;
  onPick: (signal: string, dbcPath: string) => void;
  onRemap: (row: ViewSignalRow, candidate: ViewSignalCandidate) => void;
  selected: boolean;
  onSelect: (id: string, e: React.MouseEvent) => void;
}

function ViewSignalRowLine({
  row,
  columns,
  gridTemplate,
  washesOn,
  rowDomId,
  onPick,
  onRemap,
  selected,
  onSelect,
}: ViewSignalRowLineProps) {
  const detail = detailContent(row);
  return (
    <GridviewRow<ViewSignalColumnKey>
      defs={VIEW_SIGNAL_COLUMN_DEFS}
      columns={columns}
      gridTemplate={gridTemplate}
      id={rowDomId(row.id)}
      className={`trace-row view-signals-row${washesOn ? ` view-signals-row--wash-${STATUS_CLASS[row.status]}` : ""}${selected ? " selected" : ""}`}
      aria-selected={selected}
      onClick={(e) => onSelect(row.id, e)}
      renderCell={(key, className) => {
        switch (key) {
          case "status":
            return (
              <span className={className}>
                <i
                  className={`view-signals-chip view-signals-chip--${STATUS_CLASS[row.status]}`}
                  title={STATUS_LABEL[row.status]}
                  aria-hidden="true"
                />
                {!washesOn && <span className="view-signals-status-text">{STATUS_LABEL[row.status]}</span>}
              </span>
            );
          case "bus":
            return <span className={className}>{row.busName ?? row.busId ?? "—"}</span>;
          case "signal":
            return (
              <span className={className}>
                <NameText name={row.signalName} />
              </span>
            );
          case "msg":
            return (
              <span className={className}>
                0x{formatCanIdHex(row.messageId, row.extended)} <NameText name={row.messageName} />
              </span>
            );
          case "database":
            return (
              <span className={className}>{row.servingDbc ? basename(row.servingDbc) : "—"}</span>
            );
          case "source":
            return (
              <select
                className={className}
                disabled={row.candidates.length === 0}
                value={row.servingDbc ? candidateValue(row.servingDbc, row.signalName) : ""}
                // The row's own click handler is selection, not a
                // gesture the picker should also fire.
                onClick={(e) => e.stopPropagation()}
                // Which pick a choice is depends only on whether it
                // names this row's own signal: the same signal under
                // another database is the ambiguity pick, a different
                // signal of the same message is the remap.
                onChange={(e) => {
                  const chosen = parseCandidateValue(e.target.value);
                  if (chosen === null) return;
                  if (chosen.signalName === row.signalName) {
                    onPick(row.id, chosen.dbcPath);
                    return;
                  }
                  const candidate = row.candidates.find(
                    (c) => c.dbcPath === chosen.dbcPath && c.signalName === chosen.signalName,
                  );
                  if (candidate) onRemap(row, candidate);
                }}
              >
                {row.candidates.length === 0 ? (
                  <option value="">
                    {row.servingDbc ? row.signalName : "— nothing available —"}
                  </option>
                ) : (
                  row.candidates.map((c) => (
                    <option
                      key={candidateValue(c.dbcPath, c.signalName)}
                      value={candidateValue(c.dbcPath, c.signalName)}
                      title={
                        c.signalName === row.signalName
                          ? undefined
                          : `point every view that references ${row.signalName} at ${c.signalName} instead`
                      }
                    >
                      {basename(c.dbcPath)}: {c.signalName}
                    </option>
                  ))
                )}
              </select>
            );
          case "used":
            return <span className={className}>{row.usedBy.join(", ")}</span>;
          case "detail":
            return (
              <span className={`${className} view-signals-detail`}>
                {typeof detail === "string" ? (
                  detail
                ) : detail ? (
                  <>
                    <span className="view-signals-detail-k">Mapped as:</span>{" "}
                    <span className="view-signals-detail-v">{detail.mapped}</span>
                    <span className="view-signals-detail-sep">·</span>
                    <span className="view-signals-detail-k">Decoded by:</span>{" "}
                    <span className="view-signals-detail-v">{detail.decoded}</span>
                  </>
                ) : null}
              </span>
            );
          default:
            return <span className={className} />;
        }
      }}
    />
  );
}
