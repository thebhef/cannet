import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  /// Number of rows the virtualizer represents (the size of the
  /// visible window). Always less than or equal to WINDOW_SIZE.
  displayedCount: number;
  /// Absolute index of the row that's at view index 0. Slides as
  /// the user paged-scrolls outside the visible window.
  displayOffset: number;
  /// Bumped when the cache contents change so the virtualizer
  /// re-measures placeholder rows.
  version: number;
  autoScroll: boolean;
  /// Recorded timestamp of absolute row 0, in seconds. Used as the
  /// zero-point for the time column. `null` until the first frame
  /// has been fetched.
  baseTimestampSeconds: number | null;
  /// Synchronous lookup by absolute index. Returns `null` until the
  /// covering chunk lands; the row renders as a placeholder.
  getFrame: (absoluteIndex: number) => TraceFrameRecord | null;
  /// Called whenever the visible *absolute* range changes so the
  /// parent can drive chunk fetches.
  ensureVisible: (absStart: number, absEnd: number) => void;
  /// Whether sliding the window backward / forward is currently
  /// available (only when paused with room to slide).
  canSlideBack: boolean;
  canSlideForward: boolean;
  onSlideBack: () => void;
  onSlideForward: () => void;
  /// Called when the user wheels upward. The parent uses this to
  /// auto-engage pause when the view is live-tailing, so the user
  /// can actually reach the top edge of the visible window (otherwise
  /// autoscroll keeps yanking them back).
  onUserScrollUp: () => void;
}

const ROW_HEIGHT = 22;
const EXPANDED_ROW_HEIGHT = 22 + 18 * 6;
/// Pixel threshold for treating a scroll position as "at the edge".
/// Browsers can leave a fractional pixel of slop; 4 px is generous.
const SCROLL_EDGE_PX = 4;

export function TraceView({
  displayedCount,
  displayOffset,
  version,
  autoScroll,
  baseTimestampSeconds,
  getFrame,
  ensureVisible,
  canSlideBack,
  canSlideForward,
  onSlideBack,
  onSlideForward,
  onUserScrollUp,
}: TraceViewProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  // Expanded rows are tracked by absolute index so a slide doesn't
  // "expand" a different row at the same view index.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const virtualizer = useVirtualizer({
    count: displayedCount,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      expanded.has(displayOffset + index) ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT,
    overscan: 16,
    getItemKey: (index) => displayOffset + index,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [version, virtualizer]);

  useLayoutEffect(() => {
    virtualizer.measure();
  }, [expanded, virtualizer]);

  // Live-tail autoscroll — pin to the bottom of the visible window.
  // (When paused, autoScroll is false and the user controls position.)
  useLayoutEffect(() => {
    if (!autoScroll || displayedCount === 0) return;
    virtualizer.scrollToIndex(displayedCount - 1, { align: "end" });
  }, [autoScroll, displayedCount, displayOffset, virtualizer]);

  const items = virtualizer.getVirtualItems();

  // Drive prefetch off the visible *absolute* range.
  useEffect(() => {
    if (items.length === 0) return;
    const startView = items[0].index;
    const endView = items[items.length - 1].index + 1;
    ensureVisible(displayOffset + startView, displayOffset + endView);
  }, [items, displayOffset, ensureVisible]);

  // Mouse-wheel / touchpad upward intent should auto-pause if we're
  // live-tailing; otherwise autoscroll keeps yanking the user back
  // and they can't reach the top edge to slide.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) onUserScrollUp();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onUserScrollUp]);

  // Sliding: when paused and the user scrolls past the top or bottom
  // edge of the visible window, ask the parent to slide the window.
  // After the slide propagates (displayOffset prop changes), restore
  // the scroll position so the row the user was looking at stays
  // visible at the same place on screen.
  const pendingSlideRef = useRef<{
    type: "back" | "forward";
    preOffset: number;
  } | null>(null);

  const handleScroll = useCallback(() => {
    if (pendingSlideRef.current) return; // a previous slide hasn't settled yet
    const el = parentRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollTop <= SCROLL_EDGE_PX && canSlideBack) {
      pendingSlideRef.current = { type: "back", preOffset: displayOffset };
      onSlideBack();
    } else if (
      scrollHeight - clientHeight - scrollTop <= SCROLL_EDGE_PX &&
      canSlideForward
    ) {
      pendingSlideRef.current = { type: "forward", preOffset: displayOffset };
      onSlideForward();
    }
  }, [canSlideBack, canSlideForward, displayOffset, onSlideBack, onSlideForward]);

  useLayoutEffect(() => {
    const pending = pendingSlideRef.current;
    if (!pending) return;
    if (pending.preOffset === displayOffset) return; // slide hasn't propagated yet
    pendingSlideRef.current = null;
    const el = parentRef.current;
    if (!el) return;
    const offsetDelta = pending.preOffset - displayOffset; // >0 if slid back, <0 if forward
    if (pending.type === "back") {
      // The previously top-of-viewport row was at view index 0,
      // absolute idx preOffset. After sliding back, that absolute idx
      // is at view index (preOffset - displayOffset) = offsetDelta.
      // Put it at the top of the viewport.
      el.scrollTop = offsetDelta * ROW_HEIGHT;
    } else {
      // Slid forward (offsetDelta is negative). The previously
      // bottom-of-viewport row was at view index displayedCount - 1
      // in the old layout; in the new layout it's at view index
      // (displayedCount - 1) - (-offsetDelta). Put it at the bottom.
      el.scrollTop = el.scrollHeight - el.clientHeight + offsetDelta * ROW_HEIGHT;
    }
  }, [displayOffset]);

  const toggleExpanded = (absoluteIndex: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(absoluteIndex)) next.delete(absoluteIndex);
      else next.add(absoluteIndex);
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
      <div ref={parentRef} className="trace-rows" onScroll={handleScroll}>
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
          }}
        >
          {items.map((virtualRow) => {
            const absoluteIndex = displayOffset + virtualRow.index;
            const frame = getFrame(absoluteIndex);
            const isExpanded = expanded.has(absoluteIndex);
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
                onClick={() => frame?.decoded && toggleExpanded(absoluteIndex)}
              >
                {frame ? (
                  <RowContents
                    frame={frame}
                    absoluteIndex={absoluteIndex}
                    isExpanded={isExpanded}
                    baseTimestamp={baseTimestampSeconds}
                  />
                ) : (
                  <span className="col-idx">{(absoluteIndex + 1).toLocaleString()}</span>
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
  absoluteIndex: number;
  isExpanded: boolean;
  baseTimestamp: number | null;
}

function RowContents({
  frame,
  absoluteIndex,
  isExpanded,
  baseTimestamp,
}: RowContentsProps) {
  return (
    <>
      <span className="col-idx">{(absoluteIndex + 1).toLocaleString()}</span>
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
