import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { TraceFrameRecord } from "./types";
import {
  formatData,
  formatId,
  formatKind,
  formatSignalValue,
  formatTimestamp,
} from "./format";
import {
  EXPANDED_ROW_HEIGHT,
  ROW_HEIGHT,
  buildPlacements,
  maxAnchorRow,
  maxScrollTop,
  rowFromScroll,
  scaledHeight,
  scrollForRow,
  visibleRowCount,
} from "./traceViewport";

interface TraceViewProps {
  count: number;
  /// Bumped by the parent when chunk-cache contents change; its only
  /// job is to re-render this component so `getFrame` is re-consulted
  /// (e.g. a placeholder row's data just landed). Not read directly.
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

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Set true when we move scrollTop ourselves (the re-pin effect) so
  // the resulting scroll event isn't mistaken for a user scroll.
  const programmaticScrollRef = useRef(false);
  // Absolute row the view stays anchored at while auto-scroll is off.
  // Updated on every user scroll; consulted by `targetScrollTop` and
  // the re-pin effect when `count` grows so the same row stays put
  // even though the scaled scrollbar's row↔scroll mapping shifted.
  //
  // NOTE: this ref is read during render (via `targetScrollTop`). That
  // is only safe because the one writer — `handleScroll` — always
  // pairs the write with `setScrollTop`, forcing a re-render that
  // re-reads it. Don't mutate it without an accompanying state update.
  const anchoredRowRef = useRef(0);

  const rows = visibleRowCount(viewportHeight);
  const spacerHeight = scaledHeight(count, viewportHeight);
  const maxScroll = maxScrollTop(count, viewportHeight);
  const anchorMax = maxAnchorRow(count, viewportHeight);

  const firstVisibleRow = autoScroll
    ? anchorMax
    : rowFromScroll(scrollTop, count, viewportHeight);
  const lastVisibleRow = Math.min(count, firstVisibleRow + rows);
  const targetScrollTop = autoScroll
    ? maxScroll
    : scrollForRow(anchoredRowRef.current, count, viewportHeight);

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
  // (`scrollTop` deliberately isn't in the dep list). Covers both
  // "follow the live tail" (auto-scroll on, `targetScrollTop ===
  // maxScroll`) and "stay on the anchored row as `count` grows". The
  // generous threshold means the pixel-or-two target/actual mismatch
  // from row-index rounding on a user scroll doesn't trip it.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (Math.abs(el.scrollTop - targetScrollTop) > REPIN_THRESHOLD_PX) {
      programmaticScrollRef.current = true;
      el.scrollTop = targetScrollTop;
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

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const top = el.scrollTop;
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }
    if (autoScroll) onAutoScrollDisabled();
    anchoredRowRef.current = rowFromScroll(top, count, viewportHeight);
    setScrollTop(top);
  }, [autoScroll, onAutoScrollDisabled, count, viewportHeight]);

  const toggleExpanded = useCallback((absoluteIndex: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(absoluteIndex)) next.delete(absoluteIndex);
      else next.add(absoluteIndex);
      return next;
    });
  }, []);

  const placements = buildPlacements(firstVisibleRow, count, rows, expanded);

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
        {/* Spacer: gives the scrollbar the trace's full (scaled) extent. */}
        <div style={{ height: spacerHeight, position: "relative" }}>
          {/* Sticky viewport: the compositor keeps this pinned to the
              top of the scroll area, so the rows never lag the
              scrollbar — React only swaps their content. */}
          <div
            style={{
              position: "sticky",
              top: 0,
              height: viewportHeight,
              overflow: "hidden",
            }}
          >
            {placements.map(({ posKey, absIdx, top, isExpanded }) => (
              <Row
                key={posKey}
                top={top}
                absoluteIndex={absIdx}
                isExpanded={isExpanded}
                frame={getFrame(absIdx)}
                baseTimestamp={baseTimestampSeconds}
                onToggle={toggleExpanded}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  top: number;
  absoluteIndex: number;
  isExpanded: boolean;
  frame: TraceFrameRecord | null;
  baseTimestamp: number | null;
  onToggle: (absoluteIndex: number) => void;
}

const Row = memo(function Row({
  top,
  absoluteIndex,
  isExpanded,
  frame,
  baseTimestamp,
  onToggle,
}: RowProps) {
  const height = isExpanded ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT;
  return (
    <div
      className={`trace-row ${isExpanded ? "expanded" : ""} ${frame ? "" : "loading"}`}
      style={{ position: "absolute", top, left: 0, right: 0, height }}
      onClick={() => frame?.decoded && onToggle(absoluteIndex)}
    >
      <span className="col-idx">{(absoluteIndex + 1).toLocaleString()}</span>
      {frame && (
        <>
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
      )}
    </div>
  );
});
