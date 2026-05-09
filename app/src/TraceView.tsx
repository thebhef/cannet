import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { FrameRecord } from "./types";
import {
  formatData,
  formatId,
  formatKind,
  formatSignalValue,
  formatTimestamp,
} from "./format";

interface TraceViewProps {
  frames: FrameRecord[];
  /** Bumped each time `frames` is mutated in place. */
  version: number;
  autoScroll: boolean;
}

const ROW_HEIGHT = 22;
const EXPANDED_ROW_HEIGHT = 22 + 18 * 6; // generous default for ≤6 signals

export function TraceView({ frames, version, autoScroll }: TraceViewProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const baseTimestamp = frames.length > 0 ? frames[0].timestamp_seconds : null;

  const virtualizer = useVirtualizer({
    count: frames.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      expanded.has(index) ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT,
    overscan: 16,
    getItemKey: (index) => index,
  });

  // Tell the virtualizer the underlying data changed without forcing a
  // full re-render of every visible row.
  useEffect(() => {
    virtualizer.measure();
  }, [version, virtualizer]);

  // Re-measure rows whose expansion state just changed.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [expanded, virtualizer]);

  // Auto-scroll: if enabled, keep pinned to the bottom as new frames land.
  useLayoutEffect(() => {
    if (!autoScroll || frames.length === 0) return;
    virtualizer.scrollToIndex(frames.length - 1, { align: "end" });
  }, [autoScroll, frames.length, virtualizer]);

  const items = virtualizer.getVirtualItems();

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
            const frame = frames[virtualRow.index];
            const isExpanded = expanded.has(virtualRow.index);
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className={`trace-row ${isExpanded ? "expanded" : ""}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={() =>
                  frame.decoded && toggleExpanded(virtualRow.index)
                }
              >
                <span className="col-idx">{virtualRow.index + 1}</span>
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
                    <span className="hint">
                      {isExpanded ? " ▾" : " ▸"}
                    </span>
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
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
