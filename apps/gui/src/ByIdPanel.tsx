import { memo, useCallback, useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

import { TraceControls } from "./TraceControls";
import { useTraceData } from "./traceData";
import { useTrace } from "./trace";
import {
  formatData,
  formatId,
  formatKind,
  formatSignalValue,
  formatTimestamp,
} from "./format";
import type { TraceFrameRecord } from "./types";

/// Fixed column widths for the by-ID table (no resize / hide here — a
/// follow-up; the chronological panel's `traceColumns` machinery could
/// be lifted to cover both). Order: last-seen time, channel, direction,
/// id, type, length, data, decoded name.
const BY_ID_GRID = "110px 36px 36px 96px 110px 40px 1fr 220px";

/** Stable key for a by-ID row — channel + arbitration id + std/ext. */
function rowKey(f: TraceFrameRecord): string {
  return `${f.channel}:${f.id}:${f.extended ? "x" : "s"}`;
}

/**
 * Per-message-ID panel: one row per arbitration id holding its latest
 * frame within this panel's {@link useTrace | trace} window, sorted by
 * id, updating live while the trace is running and frozen when it's
 * paused / stopped. A trace-style view, so it carries the common
 * Start/Stop/Pause/Resume/Clear controls. (Backed by the host-side
 * latest-by-id index — see `fetch_latest_by_id` — not by walking the
 * buffer.)
 */
export function ByIdPanel(_props: IDockviewPanelProps) {
  const data = useTraceData();
  const trace = useTrace(data);

  const [rows, setRows] = useState<TraceFrameRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    void invoke<TraceFrameRecord[]>("fetch_latest_by_id", { since: trace.offset })
      .then(setRows)
      .catch(() => {
        /* a failed snapshot just leaves the last one up */
      });
  }, [trace.offset]);

  // Refresh on mount and on offset change (clear / start give a new
  // `refresh`), on every tick while running (`refreshTrigger` tracks
  // `frameCount`), and once on a status change — which is what captures
  // the snapshot when the trace is paused / stopped.
  const refreshTrigger = trace.status === "running" ? trace.frameCount : -1;
  useEffect(() => {
    refresh();
  }, [refresh, trace.status, refreshTrigger]);

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <div className="by-id-panel">
      <div className="trace-panel-toolbar">
        <TraceControls
          status={trace.status}
          onStart={trace.start}
          onStop={trace.stop}
          onPause={trace.pause}
          onResume={trace.resume}
          onClear={trace.clear}
        />
        <span className="by-id-count">{rows.length} id{rows.length === 1 ? "" : "s"}</span>
      </div>
      <div className="trace">
        <div className="trace-header" style={{ gridTemplateColumns: BY_ID_GRID }}>
          <span className="col-time">last (s)</span>
          <span className="col-ch">ch</span>
          <span className="col-dir">dir</span>
          <span className="col-id">id</span>
          <span className="col-kind">type</span>
          <span className="col-len">len</span>
          <span className="col-data">data</span>
          <span className="col-msg">message</span>
        </div>
        <div className="by-id-rows">
          {rows.map((r) => {
            const key = rowKey(r);
            return (
              <ByIdRow
                key={key}
                rowKeyId={key}
                frame={r}
                baseTimestamp={trace.baseTimestampSeconds}
                isExpanded={expanded.has(key)}
                onToggle={toggle}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface ByIdRowProps {
  rowKeyId: string;
  frame: TraceFrameRecord;
  baseTimestamp: number | null;
  isExpanded: boolean;
  onToggle: (key: string) => void;
}

const ByIdRow = memo(function ByIdRow({
  rowKeyId,
  frame,
  baseTimestamp,
  isExpanded,
  onToggle,
}: ByIdRowProps) {
  return (
    <div
      className={`trace-row ${isExpanded ? "expanded" : ""}`}
      style={{ gridTemplateColumns: BY_ID_GRID }}
      onClick={() => frame.decoded && onToggle(rowKeyId)}
    >
      <span className="col-time">{formatTimestamp(frame.timestamp_seconds, baseTimestamp)}</span>
      <span className="col-ch">{frame.channel}</span>
      <span className="col-dir">{frame.direction}</span>
      <span className="col-id">{formatId(frame)}</span>
      <span className="col-kind">{formatKind(frame)}</span>
      <span className="col-len">{frame.data.length}</span>
      <span className="col-data">{formatData(frame)}</span>
      <span className="col-msg">
        {frame.decoded ? frame.decoded.name : ""}
        {frame.decoded ? <span className="hint">{isExpanded ? " ▾" : " ▸"}</span> : null}
      </span>
      {isExpanded && frame.decoded && (
        <div className="signals">
          {frame.decoded.signals.map((sig) => (
            <div className="signal" key={sig.name}>
              <span className="signal-name">{sig.name}</span>
              <span className="signal-value">{formatSignalValue(sig.value, sig.unit)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
