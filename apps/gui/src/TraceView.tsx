import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { TraceFrameRecord } from "./types";
import {
  formatData,
  formatId,
  formatKind,
  formatSignalValue,
  formatTimestamp,
} from "./format";

interface TraceViewProps {
  /// Total number of frames in the host-side trace store. Drives the
  /// virtualizer's scrollable height.
  count: number;
  /// Bumped when the cache contents change (chunk arrival, cache
  /// invalidation). Tells the virtualizer to re-measure.
  version: number;
  autoScroll: boolean;
  /// Synchronous lookup. Returns null if the row's chunk hasn't been
  /// fetched yet; the row renders as a placeholder.
  getFrame: (index: number) => TraceFrameRecord | null;
  /// Called whenever the visible range changes so the parent can
  /// trigger chunk fetches around it.
  ensureVisible: (startIndex: number, endIndex: number) => void;
}

const ROW_HEIGHT = 22;
const EXPANDED_ROW_HEIGHT = 22 + 18 * 6; // generous default for ≤6 signals

export function TraceView({
  count,
  version,
  autoScroll,
  getFrame,
  ensureVisible,
}: TraceViewProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Pin the timestamp baseline to the first row's timestamp once we've
  // seen one. Recomputing every render would shift the displayed
  // relative times as new chunks land.
  const baseTimestampRef = useRef<number | null>(null);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      expanded.has(index) ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT,
    overscan: 16,
    getItemKey: (index) => index,
  });

  // Tell the virtualizer the underlying data changed (cache update) so
  // it re-measures any rows that were placeholders.
  useEffect(() => {
    virtualizer.measure();
  }, [version, virtualizer]);

  // Re-measure rows whose expansion state just changed.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [expanded, virtualizer]);

  // Auto-scroll: pin to bottom as new frames land.
  useLayoutEffect(() => {
    if (!autoScroll || count === 0) return;
    virtualizer.scrollToIndex(count - 1, { align: "end" });
  }, [autoScroll, count, virtualizer]);

  const items = virtualizer.getVirtualItems();

  // Drive prefetch off the visible range. ensureVisible is debounced
  // upstream by "skip if cached or in-flight", so calling it on every
  // render is cheap.
  useEffect(() => {
    if (items.length === 0) return;
    const start = items[0].index;
    const end = items[items.length - 1].index + 1;
    ensureVisible(start, end);
  }, [items, ensureVisible]);

  // Update the timestamp baseline once a first row has loaded.
  if (baseTimestampRef.current === null && count > 0) {
    const first = getFrame(0);
    if (first) baseTimestampRef.current = first.timestamp_seconds;
  }
  // Reset baseline when the trace is cleared.
  if (count === 0 && baseTimestampRef.current !== null) {
    baseTimestampRef.current = null;
  }

  const toggleExpanded = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className="trace">
      <div className="trace-header">
        <span className="col-idx">#</span>
        <span className="col-time">time (s)</span>
        <span className="col-ch">ch</span>
        <span className="col-dir">dir</span>
        <span className="col-id">id</span>
        <span className="col-kind">type</span>
        <span className="col-len">len</span>
        <span className="col-data">data</span>
        <span className="col-msg">message</span>
      </div>
      <div ref={parentRef} className="trace-rows">
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
          }}
        >
          {items.map((virtualRow) => {
            const frame = getFrame(virtualRow.index);
            const isExpanded = expanded.has(virtualRow.index);
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className={`trace-row ${isExpanded ? "expanded" : ""} ${frame ? "" : "loading"}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={() =>
                  frame?.decoded && toggleExpanded(virtualRow.index)
                }
              >
                {frame ? (
                  <RowContents
                    frame={frame}
                    rowIndex={virtualRow.index}
                    isExpanded={isExpanded}
                    baseTimestamp={baseTimestampRef.current}
                  />
                ) : (
                  <span className="col-idx">{virtualRow.index + 1}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface RowContentsProps {
  frame: TraceFrameRecord;
  rowIndex: number;
  isExpanded: boolean;
  baseTimestamp: number | null;
}

function RowContents({
  frame,
  rowIndex,
  isExpanded,
  baseTimestamp,
}: RowContentsProps) {
  return (
    <>
      <span className="col-idx">{rowIndex + 1}</span>
      <span className="col-time">
        {formatTimestamp(frame.timestamp_seconds, baseTimestamp)}
      </span>
      <span className="col-ch">{frame.channel}</span>
      <span className="col-dir">{frame.direction}</span>
      <span className="col-id">{formatId(frame)}</span>
      <span className="col-kind">{formatKind(frame)}</span>
      <span className="col-len">{frame.data.length}</span>
      <span className="col-data">{formatData(frame)}</span>
      <span className="col-msg">
        {frame.decoded ? frame.decoded.name : ""}
        {frame.decoded ? (
          <span className="hint">{isExpanded ? " ▾" : " ▸"}</span>
        ) : null}
      </span>
      {isExpanded && frame.decoded && (
        <div className="signals">
          {frame.decoded.signals.map((sig) => (
            <div className="signal" key={sig.name}>
              <span className="signal-name">{sig.name}</span>
              <span className="signal-value">
                {formatSignalValue(sig.value, sig.unit)}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
