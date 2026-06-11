import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

import { TraceView } from "./TraceView";
import { ByIdTable } from "./ByIdTable";
import { TraceControls } from "./TraceControls";
import { useTraceData } from "./traceData";
import { useTrace } from "./trace";
import { useFilteredTrace } from "./useFilteredTrace";
import { useElementRegistry } from "./projectElements";
import { useProjectContext } from "./projectContext";
import { buildSinkPredicate } from "./sinkPredicate";
import { buildColorResolver } from "./colorMap";
import { elementLabel } from "./elementLabel";
import { SourcesContextMenu } from "./SourcesPicker";
import {
  type ColumnKey,
  type ColumnState,
  type SortState,
  DEFAULT_SORT,
  busLookup,
  columnsFromParams,
  nextSort,
  reorderColumn,
  resizeColumn,
  toggleColumn,
} from "./traceColumns";
import type { ByIdSnapshotRecord } from "./types";
import { diagCount } from "./diag"; // DIAG

type TraceMode = "chronological" | "by-id";

/// The element id from a panel's params, or a fresh one if absent (a
/// layout saved before elements existed, or a corrupt blob).
function elementIdFromParams(params: unknown): string {
  const p = params as { elementId?: unknown } | undefined;
  return typeof p?.elementId === "string" ? p.elementId : crypto.randomUUID();
}

/**
 * One trace-style panel: a view of one trace *element* (`useTrace`),
 * switchable between **chronological** (one row per frame, virtualized,
 * follows the live edge) and **by ID** (one row per arbitration id with
 * its latest frame; click a column to sort). Both modes share the
 * column layout (resize a divider; right-click a header to show / hide
 * columns) and the trace controls; the element lives in the registry,
 * so closing the panel doesn't destroy it. The mode (default by ID),
 * auto-scroll (chronological), and the column layout are this *panel*'s
 * state, persisted in the dockview panel `params`.
 */
export function TracePanel(props: IDockviewPanelProps) {
  diagCount("render.TracePanel"); // DIAG
  const data = useTraceData();
  const registry = useElementRegistry();
  const { ensure } = registry;
  const project = useProjectContext();
  const { api } = props;
  const buses = project.buses;
  const lookup = useMemo(() => busLookup(buses), [buses]);
  // Signal value→color maps (ADR 0029) are ambient: compile every
  // colormap element in the project into one resolver the decoded-signal
  // cells call to tint themselves. Rebuilt only when the element set
  // changes, so the memoised rows aren't churned.
  const resolveColor = useMemo(
    () => buildColorResolver(registry.entries.map((e) => e.element)),
    [registry.entries],
  );

  const params = props.params as
    | { elementId?: unknown; mode?: unknown; autoScroll?: unknown; columns?: unknown }
    | undefined;
  const [elementId] = useState(() => elementIdFromParams(params));
  useEffect(() => {
    ensure(elementId, "trace");
  }, [ensure, elementId]);

  const [mode, setMode] = useState<TraceMode>(() =>
    params?.mode === "chronological" ? "chronological" : "by-id",
  );
  const switchMode = useCallback((m: TraceMode) => setMode(m), []);

  const trace = useTrace(data, elementId);

  // Per-panel: auto-scroll (chronological) and the column layout.
  const [autoScroll, setAutoScroll] = useState(() =>
    typeof params?.autoScroll === "boolean" ? params.autoScroll : true,
  );
  const handleAutoScrollDisabled = useCallback(() => setAutoScroll(false), []);
  const [columns, setColumns] = useState<ColumnState[]>(() => columnsFromParams(params?.columns));
  const handleColumnResize = useCallback(
    (key: ColumnKey, width: number) => setColumns((cs) => resizeColumn(cs, key, width)),
    [],
  );
  const handleColumnToggle = useCallback(
    (key: ColumnKey) => setColumns((cs) => toggleColumn(cs, key)),
    [],
  );
  const handleColumnReorder = useCallback(
    (key: ColumnKey, beforeKey: ColumnKey | null) =>
      setColumns((cs) => reorderColumn(cs, key, beforeKey)),
    [],
  );

  // Mirror this panel's persistable state into its dockview params so
  // it's in `toJSON()` (the project file / the localStorage layout).
  useEffect(() => {
    api.updateParameters({ elementId, mode, autoScroll, columns });
  }, [api, elementId, mode, autoScroll, columns]);

  // By-id mode state.
  const [rows, setRows] = useState<ByIdSnapshotRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const onSortColumn = useCallback((key: ColumnKey) => setSort((s) => nextSort(s, key)), []);
  const onToggleExpand = useCallback((rowKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);

  // The fetch predicate the host applies before returning rows. Built
  // from the element's `sources` (and any upstream filter's predicate).
  // `null` means "no constraint" — the common case for `sources=["*"]`.
  const element = registry.get(elementId)?.element;
  const fetchFilter = useMemo(() => {
    if (!element) return null;
    return buildSinkPredicate(element, (id) => registry.get(id)?.element);
  }, [element, registry]);
  // Current sources for the picker. `["*"]` is the default when the
  // element is still being healed or has a legacy shape lacking the
  // field — be defensive so the picker never reads from `undefined`.
  const currentSources =
    element &&
    element.kind !== "transmit" &&
    element.kind !== "rbs" &&
    element.kind !== "colormap"
      ? element.sources ?? ["*"]
      : ["*"];
  // Filters available to wire upstream of this trace. Exclude
  // ourselves (a trace can never be its own source) and any other
  // non-filter elements; the cycle guard in `applyElementPatch`
  // protects against pathological selections.
  const availableFilters = useMemo(
    () =>
      registry.entries
        .filter((e) => e.element.kind === "filter")
        .map((e) => ({ id: e.element.id, label: elementLabel(e.element) })),
    [registry.entries],
  );
  const handleSourcesChange = useCallback(
    (next: string[]) => registry.update(elementId, { sources: next }),
    [registry, elementId],
  );
  // Right-click anywhere in the trace panel opens the sources
  // context menu at the cursor. The menu owns its own outside-click
  // / Escape dismissal.
  const [sourcesMenu, setSourcesMenu] = useState<{ x: number; y: number } | null>(null);
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setSourcesMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // While in by-id mode: refresh the latest-by-id snapshot on mount, on
  // window change (clear / start moves `offset`), on every tick while
  // running, and once on a status change (which captures the snapshot
  // when the trace is paused / stopped). The host applies `fetchFilter`
  // before returning, so unchecking a bus in the panel's source picker
  // drops its frames here without any frontend post-filter pass.
  const refreshTrigger = trace.status === "running" ? trace.frameCount : -1;
  // DIAG: attribute each by-id effect firing to the dependency that
  // actually changed — during the freeze this fires once per render
  // cycle, and whichever dep churns is the loop's driver.
  const byIdDepsRef = useRef<{
    mode: TraceMode;
    offset: number;
    status: string;
    refreshTrigger: number;
    fetchFilter: unknown;
  } | null>(null);
  useEffect(() => {
    if (mode !== "by-id") return;
    const prev = byIdDepsRef.current; // DIAG
    if (prev) {
      if (prev.mode !== mode) diagCount("byid.dep.mode"); // DIAG
      if (prev.offset !== trace.offset) diagCount("byid.dep.offset"); // DIAG
      if (prev.status !== trace.status) diagCount("byid.dep.status"); // DIAG
      if (prev.refreshTrigger !== refreshTrigger) diagCount("byid.dep.refreshTrigger"); // DIAG
      if (prev.fetchFilter !== fetchFilter) diagCount("byid.dep.fetchFilter"); // DIAG
    } else {
      diagCount("byid.dep.mount"); // DIAG
    }
    byIdDepsRef.current = {
      mode,
      offset: trace.offset,
      status: trace.status,
      refreshTrigger,
      fetchFilter,
    }; // DIAG
    diagCount("invoke.fetch_latest_by_id"); // DIAG
    void invoke<ByIdSnapshotRecord[]>("fetch_latest_by_id", {
      since: trace.offset,
      filter: fetchFilter,
    })
      .then(setRows)
      .catch(() => {
        diagCount("reject.fetch_latest_by_id"); // DIAG
        /* a failed snapshot just leaves the last one up */
      });
  }, [mode, trace.offset, trace.status, refreshTrigger, fetchFilter]);

  // Chronological + filtered: the shared chunk cache (App.tsx) is
  // global and unfiltered, so when this panel has a filter the
  // chronological view is paged separately, host-side, through
  // `useFilteredTrace` — it holds only the visible page, never the
  // whole filtered set. A `null` `fetchFilter` (the `sources=["*"]`
  // common case) leaves the cheap shared chunk cache in charge.
  const chronoFiltered = mode === "chronological" && fetchFilter != null;
  const filtered = useFilteredTrace(
    chronoFiltered,
    trace.offset,
    trace.offset + trace.frameCount,
    fetchFilter,
    autoScroll && trace.status === "running",
    trace.status === "running",
  );

  return (
    <div className="trace-panel" onContextMenu={handleContextMenu}>
      {sourcesMenu && (
        <SourcesContextMenu
          position={sourcesMenu}
          value={currentSources}
          buses={buses}
          filters={availableFilters}
          onChange={handleSourcesChange}
          onClose={() => setSourcesMenu(null)}
        />
      )}
      <div className="trace-panel-toolbar">
        <TraceControls
          status={trace.status}
          onStart={trace.start}
          onStop={trace.stop}
          onPause={trace.pause}
          onResume={trace.resume}
          onClear={trace.clear}
        />
        <span className="mode-toggle">
          <button
            type="button"
            className={mode === "chronological" ? "active" : undefined}
            onClick={() => switchMode("chronological")}
          >
            trace
          </button>
          <button
            type="button"
            className={mode === "by-id" ? "active" : undefined}
            onClick={() => switchMode("by-id")}
          >
            by&nbsp;ID
          </button>
        </span>
        {mode === "chronological" && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            auto-scroll
          </label>
        )}
      </div>
      {mode === "chronological" ? (
        <TraceView
          count={chronoFiltered ? filtered.count : trace.frameCount}
          version={chronoFiltered ? filtered.version : trace.version}
          autoScroll={autoScroll && trace.status === "running"}
          baseTimestampSeconds={trace.baseTimestampSeconds}
          columns={columns}
          onColumnResize={handleColumnResize}
          onColumnToggle={handleColumnToggle}
          onColumnReorder={handleColumnReorder}
          busLookup={lookup}
          resolveColor={resolveColor}
          getFrame={chronoFiltered ? filtered.getFrame : trace.getFrame}
          ensureVisible={chronoFiltered ? filtered.ensureVisible : trace.ensureVisible}
          onAutoScrollDisabled={handleAutoScrollDisabled}
        />
      ) : (
        <ByIdTable
          rows={rows}
          columns={columns}
          onColumnResize={handleColumnResize}
          onColumnToggle={handleColumnToggle}
          onColumnReorder={handleColumnReorder}
          resolveColor={resolveColor}
          sort={sort}
          onSortColumn={onSortColumn}
          baseTimestamp={trace.baseTimestampSeconds}
          busLookup={lookup}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
        />
      )}
    </div>
  );
}
