import { useCallback, useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

import { TraceView } from "./TraceView";
import { ByIdTable } from "./ByIdTable";
import { TraceControls } from "./TraceControls";
import { useTraceData } from "./traceData";
import { useTrace } from "./trace";
import { useElementRegistry } from "./projectElements";
import {
  type ColumnKey,
  type ColumnState,
  type SortState,
  columnsFromParams,
  nextSort,
  resizeColumn,
  toggleColumn,
} from "./traceColumns";
import type { ByIdSnapshotRecord } from "./types";

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
  const data = useTraceData();
  const { ensure } = useElementRegistry();
  const { api } = props;

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

  // Mirror this panel's persistable state into its dockview params so
  // it's in `toJSON()` (the project file / the localStorage layout).
  useEffect(() => {
    api.updateParameters({ elementId, mode, autoScroll, columns });
  }, [api, elementId, mode, autoScroll, columns]);

  // By-id mode state.
  const [rows, setRows] = useState<ByIdSnapshotRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState>(null);
  const onSortColumn = useCallback((key: ColumnKey) => setSort((s) => nextSort(s, key)), []);
  const onToggleExpand = useCallback((rowKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);

  // While in by-id mode: refresh the latest-by-id snapshot on mount, on
  // window change (clear / start moves `offset`), on every tick while
  // running, and once on a status change (which captures the snapshot
  // when the trace is paused / stopped).
  const refreshTrigger = trace.status === "running" ? trace.frameCount : -1;
  useEffect(() => {
    if (mode !== "by-id") return;
    void invoke<ByIdSnapshotRecord[]>("fetch_latest_by_id", { since: trace.offset })
      .then(setRows)
      .catch(() => {
        /* a failed snapshot just leaves the last one up */
      });
  }, [mode, trace.offset, trace.status, refreshTrigger]);

  return (
    <div className="trace-panel">
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
          count={trace.frameCount}
          version={trace.version}
          autoScroll={autoScroll && trace.status === "running"}
          baseTimestampSeconds={trace.baseTimestampSeconds}
          columns={columns}
          onColumnResize={handleColumnResize}
          onColumnToggle={handleColumnToggle}
          getFrame={trace.getFrame}
          ensureVisible={trace.ensureVisible}
          onAutoScrollDisabled={handleAutoScrollDisabled}
        />
      ) : (
        <ByIdTable
          rows={rows}
          columns={columns}
          onColumnResize={handleColumnResize}
          onColumnToggle={handleColumnToggle}
          sort={sort}
          onSortColumn={onSortColumn}
          baseTimestamp={trace.baseTimestampSeconds}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
        />
      )}
    </div>
  );
}
