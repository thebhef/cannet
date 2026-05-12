import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { TraceView } from "./TraceView";
import { useTraceData } from "./traceData";
import {
  type ColumnKey,
  type ColumnState,
  columnDef,
  defaultColumns,
  resizeColumn,
  toggleColumn,
} from "./traceColumns";

/**
 * A trace panel inside the dockview layout. Renders the shared capture
 * (via {@link useTraceData}) through a {@link TraceView}, plus the bits
 * of state that are *per panel*: the auto-scroll toggle and the column
 * layout (which columns show, in what order, how wide). Scroll position
 * and expanded rows live inside `TraceView` itself, so they're already
 * per-instance. (Persisting this per-panel state — into the project
 * file — is a later Phase 3 step; for now it resets when the layout is
 * restored, same as the auto-scroll toggle.)
 */
export function TracePanel(_props: IDockviewPanelProps) {
  const { count, version, baseTimestampSeconds, getFrame, ensureVisible } =
    useTraceData();

  // While true the view pins to the live tail; a user scroll in the
  // trace flips it off (TraceView calls onAutoScrollDisabled).
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
        count={count}
        version={version}
        autoScroll={autoScroll}
        baseTimestampSeconds={baseTimestampSeconds}
        columns={columns}
        onColumnResize={handleColumnResize}
        getFrame={getFrame}
        ensureVisible={ensureVisible}
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
