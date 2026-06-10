import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

import {
  DEFAULT_MIN_LEVEL,
  applySystemLogFilter,
  distinctSources,
  formatLogLine,
  formatLogTimestamp,
} from "./systemLog";
import type { SystemLogLevel, SystemMessage } from "./types";
import { useSystemLog } from "./systemLogContext";

const ROW_HEIGHT = 22;
/// Rows rendered outside the visible window on either side so brisk
/// scrolling doesn't bottom out into blanks before the next paint.
const OVERSCAN = 6;

interface PanelParams {
  filterSource?: string;
  minLevel?: SystemLogLevel;
}

/**
 * System Messages panel. Renders the host's structured log
 * bus as a virtualised list with timestamp, source, level, and message
 * columns. Filterable by source and by minimum level (default `warn`;
 * drop to `info` in the toolbar to see breadcrumb context).
 * Per-panel filter state lives in dockview `params`; the bus itself
 * lives in the host (`src-tauri/src/system_log.rs`) and is delivered
 * to the frontend by `fetch_system_log` plus incremental
 * `system-log-appended` events.
 */
export function SystemMessagesPanel(props: IDockviewPanelProps) {
  const { messages, clear, markRead } = useSystemLog();
  const { api } = props;

  const params = props.params as PanelParams | undefined;
  const [filterSource, setFilterSource] = useState(params?.filterSource ?? "");
  const [minLevel, setMinLevel] = useState<SystemLogLevel>(
    params?.minLevel ?? DEFAULT_MIN_LEVEL,
  );

  useEffect(() => {
    api.updateParameters({ filterSource, minLevel });
  }, [api, filterSource, minLevel]);

  // Focusing the panel marks every current warn/error as read so the
  // toolbar badge clears. Triggered on mount and any time the panel's
  // active state toggles to active. (Closing and reopening also fires
  // mount → markRead.)
  useEffect(() => {
    markRead();
    const d = api.onDidActiveChange((event) => {
      if (event.isActive) markRead();
    });
    return () => d.dispose();
  }, [api, markRead]);

  const sources = useMemo(() => distinctSources(messages), [messages]);
  const filtered = useMemo(
    () => applySystemLogFilter(messages, filterSource, minLevel),
    [messages, filterSource, minLevel],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // Auto-scroll to the live edge unless the user has scrolled away.
  const [stuckToTail, setStuckToTail] = useState(true);

  // Re-pin to the tail when stuck and new entries arrive.
  useEffect(() => {
    if (!stuckToTail) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setScrollTop(el.scrollTop);
  }, [filtered.length, stuckToTail]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    setViewportHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback((ev: React.UIEvent<HTMLDivElement>) => {
    const el = ev.currentTarget;
    setScrollTop(el.scrollTop);
    // "Stuck" once the user is within one row of the bottom.
    const atTail = el.scrollHeight - el.clientHeight - el.scrollTop < ROW_HEIGHT;
    setStuckToTail(atTail);
  }, []);

  const total = filtered.length;
  const totalHeight = total * ROW_HEIGHT;
  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount =
    viewportHeight > 0
      ? Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
      : Math.min(total, 64);
  const lastVisible = Math.min(total, firstVisible + visibleCount);
  const offsetY = firstVisible * ROW_HEIGHT;

  const copyEntry = useCallback((m: SystemMessage) => {
    void navigator.clipboard?.writeText(formatLogLine(m));
  }, []);
  const copyAll = useCallback(() => {
    const text = filtered.map(formatLogLine).join("\n");
    void navigator.clipboard?.writeText(text);
  }, [filtered]);
  const restartSidecar = useCallback(() => {
    void invoke("restart_sidecar").catch(() => {
      /* best-effort — the command emits its own System Messages */
    });
  }, []);

  return (
    <div className="system-messages-panel">
      <div className="system-messages-toolbar">
        <label>
          Source:{" "}
          <select
            value={filterSource}
            onChange={(e) => setFilterSource(e.target.value)}
          >
            <option value="">All</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Min level:{" "}
          <select
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value as SystemLogLevel)}
          >
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </label>
        <button type="button" onClick={copyAll} disabled={filtered.length === 0}>
          Copy all
        </button>
        <button type="button" onClick={clear} disabled={messages.length === 0}>
          Clear
        </button>
        <button
          type="button"
          onClick={restartSidecar}
          title="Stop the python-can sidecar (if running) and start it again. Clears the per-session crash-budget counter."
        >
          Restart sidecar
        </button>
        <span className="system-messages-count">
          {filtered.length} / {messages.length}
        </span>
      </div>
      <div
        className="system-messages-list"
        ref={scrollRef}
        onScroll={onScroll}
      >
        <div style={{ height: totalHeight, position: "relative" }}>
          <div style={{ transform: `translateY(${offsetY}px)` }}>
            {filtered.slice(firstVisible, lastVisible).map((m) => (
              <div
                key={m.seq}
                className={`system-messages-row system-messages-row-${m.level}`}
                style={{ height: ROW_HEIGHT }}
                onDoubleClick={() => copyEntry(m)}
                title="double-click to copy this entry"
              >
                <span className="system-messages-ts">
                  {formatLogTimestamp(m.ts_ms)}
                </span>
                <span className="system-messages-source">{m.source}</span>
                <span className="system-messages-level">{m.level}</span>
                <span className="system-messages-msg">{m.message}</span>
              </div>
            ))}
          </div>
        </div>
        {filtered.length === 0 && (
          <div className="system-messages-empty">No messages match the filter.</div>
        )}
      </div>
    </div>
  );
}
