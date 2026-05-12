import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { TraceView } from "./TraceView";
import { TraceControls } from "./TraceControls";
import { useTraceData } from "./traceData";
import { useTrace } from "./trace";
import {
  type ColumnKey,
  type ColumnState,
  columnDef,
  defaultColumns,
  resizeColumn,
  toggleColumn,
} from "./traceColumns";

/**
 * A trace panel inside the dockview layout: a chronological trace-style
 * view backed by its own {@link useTrace | trace} (a window over the
 * shared session buffer), with the common Start/Stop/Pause/Resume/Clear
 * controls and the per-panel state — auto-scroll, column layout. Scroll
 * position and expanded rows live inside `TraceView`. (Persisting the
 * per-panel state, and managing the trace through the project panel —
 * close-without-destroying, reopen — is the project-file step; for now
 * closing the panel discards its trace.)
 */
export function TracePanel(_props: IDockviewPanelProps) {
  const data = useTraceData();
  const trace = useTrace(data);

  // While true the view pins to the live tail of the trace; a user
  // scroll flips it off (TraceView calls onAutoScrollDisabled).
  const [autoScroll, setAutoScroll] = useState(true);
  const handleAutoScrollDisabled = useCallback(() => setAutoScroll(false), []);

  const [columns, setColumns] = useState<ColumnState[]>(defaultColumns);
  const handleColumnResize = useCallback(
    (key: ColumnKey, width: number) => setColumns((cs) => resizeColumn(cs, key, width)),
    [],
  );
  const handleColumnToggle = useCallback(
    (key: ColumnKey) => setColumns((cs) => toggleColumn(cs, key)),
    [],
  );

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
        autoScroll={autoScroll}
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
