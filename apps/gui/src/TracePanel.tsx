import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { TraceView } from "./TraceView";
import { TraceControls } from "./TraceControls";
import { useTraceData } from "./traceData";
import { useTrace } from "./trace";
import { useElementRegistry } from "./projectElements";
import {
  type ColumnKey,
  type ColumnState,
  columnDef,
  columnsFromParams,
  resizeColumn,
  toggleColumn,
} from "./traceColumns";

/// The element id from a panel's params, or a fresh one if absent (a
/// layout saved before elements existed, or a corrupt blob).
function elementIdFromParams(params: unknown): string {
  const p = params as { elementId?: unknown } | undefined;
  return typeof p?.elementId === "string" ? p.elementId : crypto.randomUUID();
}

/**
 * A trace panel inside the dockview layout: a chronological trace-style
 * view of one trace *element* (`useTrace`), with the common
 * Start/Stop/Pause/Resume/Clear controls and the per-panel state —
 * auto-scroll, column layout. Scroll position and expanded rows live
 * inside `TraceView`.
 *
 * The element it shows is `params.elementId`; the trace window lives in
 * the element registry, so closing the panel doesn't destroy it. The
 * auto-scroll toggle and the column layout are this *panel*'s — they
 * persist in the dockview panel `params` (and thus the layout / the
 * project). (The trace window isn't persisted: it re-anchors to the
 * session buffer, empty on a fresh launch, regardless.)
 */
export function TracePanel(props: IDockviewPanelProps) {
  const data = useTraceData();
  const { ensureTrace } = useElementRegistry();

  const params = props.params as
    | { elementId?: unknown; autoScroll?: unknown; columns?: unknown }
    | undefined;
  const [elementId] = useState(() => elementIdFromParams(params));
  useEffect(() => {
    ensureTrace(elementId, "chronological");
  }, [ensureTrace, elementId]);

  const trace = useTrace(data, elementId);

  // While true the view pins to the live tail of the trace; a user
  // scroll flips it off (TraceView calls onAutoScrollDisabled).
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
  const { api } = props;
  useEffect(() => {
    api.updateParameters({ elementId, autoScroll, columns });
  }, [api, elementId, autoScroll, columns]);

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
        <label className="checkbox">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          auto-scroll
        </label>
        <ColumnsMenu columns={columns} onToggle={handleColumnToggle} />
      </div>
      <TraceView
        count={trace.frameCount}
        version={trace.version}
        // "Auto-scroll to the live edge" only applies while the trace
        // is running — a paused/stopped trace is a frozen window, so
        // the view scrolls freely and fetches its rows on demand (the
        // live-tail overlay only covers a running trace's edge).
        autoScroll={autoScroll && trace.status === "running"}
        baseTimestampSeconds={trace.baseTimestampSeconds}
        columns={columns}
        onColumnResize={handleColumnResize}
        getFrame={trace.getFrame}
        ensureVisible={trace.ensureVisible}
        onAutoScrollDisabled={handleAutoScrollDisabled}
      />
    </div>
  );
}

/** Toolbar dropdown for showing / hiding individual trace columns. */
function ColumnsMenu({
  columns,
  onToggle,
}: {
  columns: readonly ColumnState[];
  onToggle: (key: ColumnKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="columns-menu" ref={wrapRef}>
      <button
        type="button"
        className="columns-menu-button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        columns ▾
      </button>
      {open && (
        <div className="columns-menu-popover" role="menu">
          {columns.map((c) => (
            <label key={c.key} className="checkbox">
              <input type="checkbox" checked={c.visible} onChange={() => onToggle(c.key)} />
              {columnDef(c.key).label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
