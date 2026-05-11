import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { TraceFrameRecord } from "./types";
import {
  formatData,
  formatId,
  formatKind,
  formatSignalValue,
  formatTimestamp,
} from "./format";

interface TraceViewProps {
  count: number;
  /// Bumped when chunk-cache contents change so the view re-renders
  /// (e.g. a placeholder row's data just landed).
  version: number;
  /// `true`: the view pins to the live tail. `false`: the view stays
  /// where the user scrolled to, even as `count` grows.
  autoScroll: boolean;
  baseTimestampSeconds: number | null;
  getFrame: (absoluteIndex: number) => TraceFrameRecord | null;
  ensureVisible: (start: number, end: number) => void;
  /// Called when the user scrolls the view themselves while
  /// `autoScroll` was on, so the parent can uncheck it.
  onAutoScrollDisabled: () => void;
}

const ROW_HEIGHT = 22;
const EXPANDED_ROW_HEIGHT = 22 + 18 * 6;
/// Cap on the rendered scroll-container height. Browsers cap CSS
/// dimensions around 17M (Firefox) - 33M (WebKit/Chromium) px; 16M is
/// safely under both. Past roughly 730k rows the scrollbar represents
/// the trace at a compressed scale (each scrollbar pixel covers
/// multiple rows); the mouse wheel still resolves finely because it
/// moves scrollTop by a fixed pixel count regardless of the scale.
const MAX_SCROLL_HEIGHT_PX = 16_000_000;
/// Re-pin scrollTop only when it drifts from the target by more than
/// this. Keeps the count-growth / auto-scroll re-pin from also firing
/// on every user scroll (where the target ends up a pixel or two off
/// the user's position due to row-index rounding).
const REPIN_THRESHOLD_PX = ROW_HEIGHT;

export function TraceView({
  count,
  autoScroll,
  baseTimestampSeconds,
  getFrame,
  ensureVisible,
  onAutoScrollDisabled,
}: TraceViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The inner element that holds the visible rows; we move it
  // imperatively in the scroll handler so it tracks the scroll bar
  // without waiting for a React render.
  const innerRef = useRef<HTMLDivElement>(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Set true when we move scrollTop ourselves (auto-scroll re-pin,
  // count-growth re-pin) so the resulting scroll event isn't mistaken
  // for a user scroll.
  const programmaticScrollRef = useRef(false);
  // Absolute row the view should stay anchored at while auto-scroll
  // is off. Updated on every user scroll; consulted on count growth.
  const anchoredRowRef = useRef(0);

  const visibleRowCount = Math.ceil(viewportHeight / ROW_HEIGHT) + 2;
  const naturalHeight = count * ROW_HEIGHT;
  const scaledHeight = Math.max(
    viewportHeight,
    Math.min(naturalHeight, MAX_SCROLL_HEIGHT_PX),
  );
  const maxScroll = Math.max(1, scaledHeight - viewportHeight);
  const maxAnchorRow = Math.max(0, count - visibleRowCount);

  const rowFromScroll = useCallback(
    (top: number) => {
      if (maxAnchorRow === 0) return 0;
      const fraction = Math.min(1, Math.max(0, top / maxScroll));
      return Math.min(maxAnchorRow, Math.round(fraction * maxAnchorRow));
    },
    [maxAnchorRow, maxScroll],
  );

  const scrollForRow = useCallback(
    (row: number) => {
      if (maxAnchorRow === 0) return 0;
      return (Math.min(maxAnchorRow, Math.max(0, row)) / maxAnchorRow) * maxScroll;
    },
    [maxAnchorRow, maxScroll],
  );

  const firstVisibleRow = autoScroll ? maxAnchorRow : rowFromScroll(scrollTop);
  const lastVisibleRow = Math.min(count, firstVisibleRow + visibleRowCount);
  const targetScrollTop = autoScroll
    ? maxScroll
    : scrollForRow(anchoredRowRef.current);

  // Observe viewport size so the visible-row count tracks resizes.
  useEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      if (containerRef.current) {
        setViewportHeight(containerRef.current.clientHeight);
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Tell the parent which absolute rows are visible so it can fetch
  // the covering chunks.
  useEffect(() => {
    if (count === 0) return;
    ensureVisible(firstVisibleRow, lastVisibleRow);
  }, [firstVisibleRow, lastVisibleRow, count, ensureVisible]);

  // Re-pin the scroll position when (and only when) auto-scroll mode
  // or the trace length changes — never in response to a user scroll
  // (scrollTop deliberately isn't in the dep list). The generous
  // threshold means the tiny target/actual mismatch from row-index
  // rounding on a user scroll doesn't trip it.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (Math.abs(el.scrollTop - targetScrollTop) > REPIN_THRESHOLD_PX) {
      programmaticScrollRef.current = true;
      el.scrollTop = targetScrollTop;
      if (innerRef.current) {
        innerRef.current.style.transform = `translate3d(0, ${targetScrollTop}px, 0)`;
      }
      setScrollTop(targetScrollTop);
    }
  }, [targetScrollTop, autoScroll, count, viewportHeight]);

  // Reset transient view state when the trace is cleared.
  useEffect(() => {
    if (count === 0) {
      setExpanded(new Set());
      setScrollTop(0);
      anchoredRowRef.current = 0;
    }
  }, [count]);

  // When auto-scroll is turned back on, snap to the live tail.
  useLayoutEffect(() => {
    if (!autoScroll) return;
    const el = containerRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = maxScroll;
    if (innerRef.current) {
      innerRef.current.style.transform = `translate3d(0, ${maxScroll}px, 0)`;
    }
    setScrollTop(maxScroll);
  }, [autoScroll]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const top = el.scrollTop;
    // Move the rows synchronously, before the browser paints, so the
    // visible rows don't lag the scrollbar by a frame.
    if (innerRef.current) {
      innerRef.current.style.transform = `translate3d(0, ${top}px, 0)`;
    }
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }
    if (autoScroll) onAutoScrollDisabled();
    anchoredRowRef.current = rowFromScroll(top);
    setScrollTop(top);
  }, [autoScroll, onAutoScrollDisabled, rowFromScroll]);

  const toggleExpanded = (absoluteIndex: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(absoluteIndex)) next.delete(absoluteIndex);
      else next.add(absoluteIndex);
      return next;
    });
  };

  // Visible rows, stacked from the top of the inner element. Keyed by
  // viewport position (not absolute index) so the DOM nodes stay put
  // across scrolls — only their content changes.
  const placements: {
    posKey: number;
    absIdx: number;
    top: number;
    isExpanded: boolean;
  }[] = [];
  let cursor = 0;
  for (let pos = 0; pos < visibleRowCount; pos++) {
    const absIdx = firstVisibleRow + pos;
    if (absIdx >= count) break;
    const isExpanded = expanded.has(absIdx);
    placements.push({ posKey: pos, absIdx, top: cursor, isExpanded });
    cursor += isExpanded ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT;
  }

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
      <div ref={containerRef} className="trace-rows" onScroll={handleScroll}>
        <div style={{ height: scaledHeight, position: "relative" }}>
          <div
            ref={innerRef}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: `translate3d(0, ${scrollTop}px, 0)`,
              willChange: "transform",
            }}
          >
            {placements.map(({ posKey, absIdx, top, isExpanded }) => {
              const frame = getFrame(absIdx);
              return (
                <div
                  key={posKey}
                  className={`trace-row ${isExpanded ? "expanded" : ""} ${frame ? "" : "loading"}`}
                  style={{
                    position: "absolute",
                    top,
                    left: 0,
                    right: 0,
                    height: isExpanded ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT,
                  }}
                  onClick={() => frame?.decoded && toggleExpanded(absIdx)}
                >
                  {frame ? (
                    <RowContents
                      frame={frame}
                      absoluteIndex={absIdx}
                      isExpanded={isExpanded}
                      baseTimestamp={baseTimestampSeconds}
                    />
                  ) : (
                    <span className="col-idx">
                      {(absIdx + 1).toLocaleString()}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
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
