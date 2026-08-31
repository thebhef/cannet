import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { usePanelEditRecorder } from "./panelEditRecorder";
import { listen } from "@tauri-apps/api/event";

import type { ViewSignalCandidate, ViewSignalRow, ViewSignalStatus } from "./types";
import { useAcceptSignalDrift, useRemapSignal } from "./signalRemap";
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
import { ChipButton } from "./ChipButton";

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
 * The source (candidate) picker makes all of this panel's picks, and
 * which one a choice is depends only on how it differs from the row:
 *
 * - **the ambiguity pick** — the row's own signal on the row's own bus,
 *   under a different database. Recorded in the project
 *   (`set_signal_dbc_pick`) as the database the *decoder* resolves this
 *   signal through, not merely what this panel displays.
 * - **the remap pick** — a different signal of the same message, which
 *   is what a renamed signal looks like from here. It rewrites every
 *   persisted reference to the old name through the one shared
 *   operation (`signalRemap.ts`), so it lands on every view at once
 *   rather than per view.
 * - **the re-point** — a definition on a *different bus*, which the
 *   host offers only to a reference that names no bus. Such a reference
 *   decodes nothing (ADR 0054) and this is its repair; it goes through
 *   the same shared rewrite, with the bus moving alongside the name.
 *
 * A drifted row (Scale / Stale) additionally carries **the accept**: a
 * one-click adoption of what now decodes, re-recording every view's
 * mapped fields as the decoded values through the same shared module
 * (`acceptSignalDrift`). The identity never moves — only the comparand
 * the drift was measured against — which is what turns the row back to
 * Decoded.
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
  useEffect(() => {
    api.updateParameters({
      columns,
      sort,
      statusFilter: [...statusFilter],
      busFilter: [...busFilter],
    });
  }, [api, columns, sort, statusFilter, busFilter]);

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
  // already listens for. The undo step is recorded here (task 129) —
  // the inverse is the *pick* in force right now, read before the
  // write erases it: null when there was none, so undoing a first pick
  // returns the row to unresolved rather than to a pick of the old
  // winner. A row nothing decodes goes unrecorded (the write is a
  // no-op host-side — the path names no definer).
  const recordEdit = usePanelEditRecorder();
  const onPick = useCallback(
    (row: ViewSignalRow, dbcPath: string) => {
      if (row.servingDbc !== null) {
        recordEdit({
          undo: [{ kind: "pick", signal: row.id, dbcPath: row.pickedDbc }],
          redo: [{ kind: "pick", signal: row.id, dbcPath }],
        });
      }
      void invoke("set_signal_dbc_pick", { signal: row.id, dbcPath }).catch(() => {
        /* best effort — the panel keeps showing the host's last answer */
      });
    },
    [recordEdit],
  );

  // A remap pick: the candidate names a *different* signal, so what
  // has to change is every view's stored reference rather than which
  // database decodes it. One operation over every store
  // (`signalRemap.ts`) — the rows come back through the views' own
  // re-push, as they do for any other config edit.
  // The accept: a drifted row's repair. The row's own `messageName` /
  // `unit` are the serving database's current values (the host swaps in
  // the recorded ones only when nothing decodes — and an undecoded row
  // never carries diffs), so they are exactly what the views' records
  // are rewritten to.
  const acceptDrift = useAcceptSignalDrift();
  const onAccept = useCallback(
    (row: ViewSignalRow) => {
      acceptDrift({
        busId: row.busId,
        messageId: row.messageId,
        extended: row.extended,
        signalName: row.signalName,
        messageName: row.messageName,
        unit: row.unit,
      });
    },
    [acceptDrift],
  );

  const remapSignal = useRemapSignal();
  const onRemap = useCallback(
    (row: ViewSignalRow, candidate: ViewSignalCandidate) => {
      remapSignal({
        fromBusId: row.busId,
        toBusId: candidate.busId,
        messageId: row.messageId,
        extended: row.extended,
        from: row.signalName,
        to: candidate.signalName,
        messageName: candidate.messageName,
        unit: candidate.unit,
        dbcPath: candidate.dbcPath,
        // The undo step's inverse for the pick this rewrite drops —
        // read from the row before the write erases it (task 129).
        fromPickedDbc: row.pickedDbc,
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
  // expansion or disclosure content. There is no virtualization here,
  // unlike the paged trace/by-id/signal views: the row count is the
  // signals the open views reference, which is bounded by the loaded
  // databases rather than by the capture. It is not small, though — a
  // view selecting by pattern contributes every signal its pattern
  // matches, so a broad pattern over a large database set puts a
  // thousand rows or more here.
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
                className="status-chip chip-button"
                aria-pressed={pressed}
                title={pressed ? `Stop filtering to ${STATUS_LABEL[s]}` : `Filter to ${STATUS_LABEL[s]}`}
                onClick={() => toggleStatus(s)}
              >
                <i className={`view-signals-chip view-signals-chip--${STATUS_CLASS[s]}`} aria-hidden="true" />
                <span className="status-chip-label">
                  {STATUS_LABEL[s]} ({count})
                </span>
              </button>
            );
          })}
        </span>
        <span className="chip-menu">
          <ChipButton
            label={
              busFilter.size === 0
                ? "Bus: All"
                : `Bus: ${busOptions.filter((o) => busFilter.has(o.key)).map((o) => o.label).join(", ")}`
            }
            title="filter by bus"
            menuOpen={busMenuOpen}
            onPress={() => setBusMenuOpen((v) => !v)}
          />
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
        <span className="spacer" />
        <ChipButton
          label={countsLabel}
          title={onAttention ? "Show every status again" : "Filter to the signals needing attention"}
          onPress={toggleAttentionShortcut}
        />
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
              rowDomId={grid.rowDomId}
              onPick={onPick}
              onRemap={onRemap}
              onAccept={onAccept}
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

/// One candidate's `<option>` value: its bus, database path and signal
/// name, separated by NULs so no part can be confused with another
/// whatever a path contains. The bus is in the value because a
/// candidate on a different bus is a different choice — the re-point a
/// reference that names no bus needs.
function candidateValue(busId: string, dbcPath: string, signalName: string): string {
  return `${busId}\0${dbcPath}\0${signalName}`;
}

/// The `(bus, database, signal)` triple an `<option>` value names.
function parseCandidateValue(
  value: string,
): { busId: string; dbcPath: string; signalName: string } | null {
  const first = value.indexOf("\0");
  const last = value.lastIndexOf("\0");
  if (first < 0 || last === first) return null;
  return {
    busId: value.slice(0, first),
    dbcPath: value.slice(first + 1, last),
    signalName: value.slice(last + 1),
  };
}

/// What choosing one candidate would do, in words — the `<option>`'s
/// tooltip. Nothing for the choice that is only "which database", which
/// the option's own text already states.
function optionTitle(row: ViewSignalRow, c: ViewSignalCandidate): string | undefined {
  if (c.busId !== row.busId) {
    return `point every view that references ${row.signalName} at ${c.signalName} on ${c.busName}`;
  }
  if (c.signalName !== row.signalName) {
    return `point every view that references ${row.signalName} at ${c.signalName} instead`;
  }
  return undefined;
}

interface ViewSignalRowLineProps {
  row: ViewSignalRow;
  columns: readonly ViewSignalColumnState[];
  gridTemplate: string;
  rowDomId: (id: string) => string;
  onPick: (row: ViewSignalRow, dbcPath: string) => void;
  onRemap: (row: ViewSignalRow, candidate: ViewSignalCandidate) => void;
  onAccept: (row: ViewSignalRow) => void;
  selected: boolean;
  onSelect: (id: string, e: React.MouseEvent) => void;
}

function ViewSignalRowLine({
  row,
  columns,
  gridTemplate,
  rowDomId,
  onPick,
  onRemap,
  onAccept,
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
      className={`trace-row view-signals-row${selected ? " selected" : ""}`}
      aria-selected={selected}
      onClick={(e) => onSelect(row.id, e)}
      renderCell={(key, className) => {
        switch (key) {
          case "status":
            // The chip alone: the column is swatch-wide, and the words
            // live on the chip (tooltip and accessible name) rather
            // than as text the column would truncate.
            return (
              <span className={className}>
                <i
                  className={`view-signals-chip view-signals-chip--${STATUS_CLASS[row.status]}`}
                  title={STATUS_LABEL[row.status]}
                  role="img"
                  aria-label={STATUS_LABEL[row.status]}
                />
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
                // An ambiguous row shows no selection: load order is a
                // default, not a choice, and a control that displays
                // the winner as chosen cannot record choosing it (a
                // select fires no change for its current value).
                value={
                  row.servingDbc && row.status !== "ambiguous"
                    ? candidateValue(row.busId ?? "", row.servingDbc, row.signalName)
                    : ""
                }
                // The row's own click handler is selection, not a
                // gesture the picker should also fire.
                onClick={(e) => e.stopPropagation()}
                // Which pick a choice is depends only on how it differs
                // from the row: the row's own signal on its own bus
                // under another database is the ambiguity pick;
                // anything else moves the stored references — a
                // different signal is the rename repair, a different
                // bus the re-point.
                onChange={(e) => {
                  const chosen = parseCandidateValue(e.target.value);
                  if (chosen === null) return;
                  const candidate = row.candidates.find(
                    (c) =>
                      c.busId === chosen.busId &&
                      c.dbcPath === chosen.dbcPath &&
                      c.signalName === chosen.signalName,
                  );
                  if (candidate === undefined) return;
                  if (candidate.busId === row.busId && candidate.signalName === row.signalName) {
                    onPick(row, candidate.dbcPath);
                    return;
                  }
                  onRemap(row, candidate);
                }}
              >
                {row.candidates.length === 0 ? (
                  <option value="">
                    {row.servingDbc ? row.signalName : "— nothing available —"}
                  </option>
                ) : (
                  <>
                    {/* Nothing decodes the row, so nothing is selected —
                        without this the browser would show the first
                        offer as if it were in force. */}
                    {row.servingDbc === null && <option value="">— not decoded —</option>}
                    {/* The unmade choice, naming what load order does
                        in the meantime. Disabled: the way out is any
                        real offer, including the winner itself. */}
                    {row.servingDbc !== null && row.status === "ambiguous" && (
                      <option value="" disabled>
                        — load order: {basename(row.servingDbc)} —
                      </option>
                    )}
                    {row.candidates.map((c) => (
                      <option
                        key={candidateValue(c.busId, c.dbcPath, c.signalName)}
                        value={candidateValue(c.busId, c.dbcPath, c.signalName)}
                        title={optionTitle(row, c)}
                      >
                        {c.busId === row.busId ? "" : `${c.busName} · `}
                        {basename(c.dbcPath)}: {c.signalName}
                      </option>
                    ))}
                  </>
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
                    {/* A drift's repair: adopt the decoded values as
                        the views' new record. Only a drifted row has
                        diffs, so only it carries the action. */}
                    <button
                      type="button"
                      className="view-signals-accept"
                      title="Adopt the decoded values: re-record every view's mapped fields as what now decodes"
                      // The row's own click handler is selection, not
                      // part of this gesture.
                      onClick={(e) => {
                        e.stopPropagation();
                        onAccept(row);
                      }}
                    >
                      Accept
                    </button>
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
