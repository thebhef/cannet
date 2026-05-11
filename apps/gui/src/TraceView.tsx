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
  maxWheelRows,
  rowFromScroll,
  scaledHeight,
  scrollForRow,
  visibleRowCount,
  wheelDeltaPx,
} from "./traceViewport";

interface TraceViewProps {
  count: number;
  /// Bumped by the parent when chunk-cache contents change; its only
  /// job is to re-render this component so `getFrame` is re-consulted
  /// (e.g. a placeholder row's data just landed). Not read directly.
  version: number;
  /// `true`: the view pins to the live tail. `false`: the view stays
  /// on the row the user scrolled to, even as `count` grows.
  autoScroll: boolean;
  baseTimestampSeconds: number | null;
  getFrame: (absoluteIndex: number) => TraceFrameRecord | null;
  ensureVisible: (start: number, end: number) => void;
  /// Called when the user scrolls the view themselves while
  /// `autoScroll` was on, so the parent can uncheck it.
  onAutoScrollDisabled: () => void;
}

/// Re-pin scrollTop only when it drifts from the target by more than
/// this. The target derived from a user-scrolled row is a pixel or two
/// off the user's actual scrollTop (row-index rounding); the generous
/// threshold keeps that from being treated as drift worth correcting.
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

  const [viewportHeight, setViewportHeight] = useState(600);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Absolute row at the top of the viewport, and the single source of
  // truth for what's shown: `firstVisibleRow` and the scrollbar
  // position both derive from it, so the rendered rows never depend on
  // the live `scrollTop` and can't jitter when `count` grows
  // underneath the user. While `autoScroll` is on a layout effect
  // keeps it pinned to the live tail (`maxAnchorRow`); a user scroll
  // re-points it at whatever row the scrollbar now sits on; the re-pin
  // effect drags `scrollTop` to match as the trace lengthens (which
  // shifts the row↔scroll mapping past ~730k rows, where it's
  // compressed).
  const [anchoredRow, setAnchoredRow] = useState(0);

  // Set true when *we* move scrollTop (the re-pin effect) so the
  // resulting scroll event isn't taken for a user scroll — which would
  // both disable auto-scroll and re-anchor the view to itself.
  const programmaticScrollRef = useRef(false);

  const rows = visibleRowCount(viewportHeight);
  const spacerHeight = scaledHeight(count, viewportHeight);
  const anchorMax = maxAnchorRow(count, viewportHeight);
  const firstVisibleRow = Math.min(anchorMax, Math.max(0, anchoredRow));
  const lastVisibleRow = Math.min(count, firstVisibleRow + rows);
  // `scrollForRow(anchorMax)` is exactly the bottom (`maxScrollTop`),
  // so this is "the bottom" while auto-scrolling and the anchored
  // row's scrollTop otherwise.
  const targetScrollTop = scrollForRow(firstVisibleRow, count, viewportHeight);

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

  // While auto-scrolling, keep the anchor glued to the live tail. This
  // is also what makes turning auto-scroll off (toolbar checkbox) a
  // no-op visually: the anchor is already the tail row, so nothing
  // jumps.
  useLayoutEffect(() => {
    if (autoScroll && anchoredRow !== anchorMax) setAnchoredRow(anchorMax);
  }, [autoScroll, anchorMax, anchoredRow]);

  // Keep the actual scroll position in sync with where the view wants
  // to be. Fires only when the *target* moves — i.e. on auto-scroll
  // following the tail or on `count` growth shifting the mapping under
  // the anchor — never on a user scroll, because `handleScroll` sets
  // the anchor to the position the user just scrolled to, so the
  // target already matches (within the threshold).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (Math.abs(el.scrollTop - targetScrollTop) > REPIN_THRESHOLD_PX) {
      programmaticScrollRef.current = true;
      el.scrollTop = targetScrollTop;
    }
  }, [targetScrollTop]);

  // The wheel: let the browser's native (compositor-smooth) scroll
  // handle a normal notch, and only step in when it would overshoot —
  // a "scroll one screen at a time" mouse, a page-granular deltaMode,
  // or the compressed scaled-scrollbar regime at huge `count`, where a
  // fixed-pixel notch maps onto a jump of many rows. In those cases,
  // preventDefault and move the anchor by a bounded number of rows
  // instead; the re-pin layout effect drags the scrollbar to follow.
  // Attached imperatively so the listener can be non-passive.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // ctrl+wheel is zoom — leave it alone
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal scroll
      const px = wheelDeltaPx(e.deltaY, e.deltaMode, viewportHeight);
      const fromRow = rowFromScroll(el.scrollTop, count, viewportHeight);
      const toRow = rowFromScroll(el.scrollTop + px, count, viewportHeight);
      const max = maxWheelRows(viewportHeight);
      if (Math.abs(toRow - fromRow) <= max) return; // small enough — native scroll
      e.preventDefault();
      const step = px > 0 ? max : -max;
      if (autoScroll) {
        if (step > 0) return; // already pinned to the tail
        onAutoScrollDisabled(); // wheel-up: release the pin to look back
      }
      setAnchoredRow((r) => {
        const base = autoScroll ? anchorMax : Math.min(anchorMax, Math.max(0, r));
        return Math.min(anchorMax, Math.max(0, base + step));
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewportHeight, autoScroll, anchorMax, count, onAutoScrollDisabled]);

  // Reset transient view state when the trace is cleared.
  useEffect(() => {
    if (count === 0) {
      setExpanded(new Set());
      setAnchoredRow(0);
    }
  }, [count]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }
    if (autoScroll) onAutoScrollDisabled();
    setAnchoredRow(rowFromScroll(el.scrollTop, count, viewportHeight));
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
