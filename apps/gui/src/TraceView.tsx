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
  /// Bumped when chunk-cache contents change so the view re-renders.
  version: number;
  /// `true`: scroll position is pinned to the live tail; `false`: the
  /// view is anchored at `anchorRow`.
  autoScroll: boolean;
  /// Absolute row index that the view should keep at the top of the
  /// viewport while `autoScroll` is false.
  anchorRow: number;
  baseTimestampSeconds: number | null;
  getFrame: (absoluteIndex: number) => TraceFrameRecord | null;
  ensureVisible: (start: number, end: number) => void;
  /// Called when the user moves the scroll position themselves. The
  /// parent typically responds by turning off autoScroll and
  /// remembering the new anchor row.
  onUserScroll: (newAnchorRow: number) => void;
}

const ROW_HEIGHT = 22;
const EXPANDED_ROW_HEIGHT = 22 + 18 * 6;
/// Cap on the rendered scroll-container height. Browsers cap CSS
/// dimensions around 17M (Firefox) - 33M (Chromium) pixels; 16M
/// stays safely under both. Past roughly 730k rows the scrollbar
/// represents the trace at a compressed scale — each scrollbar
/// pixel covers multiple rows. Mouse-wheel and arrow keys still
/// resolve row-by-row because the visible row math runs off the
/// (continuous) scrollTop value rather than discrete pixel
/// positions.
const MAX_SCROLL_HEIGHT_PX = 16_000_000;

export function TraceView({
  count,
  autoScroll,
  anchorRow,
  baseTimestampSeconds,
  getFrame,
  ensureVisible,
  onUserScroll,
}: TraceViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Number of rows that fit in the viewport plus a small overshoot
  // so partial top/bottom rows draw cleanly.
  const visibleRowCount = Math.ceil(viewportHeight / ROW_HEIGHT) + 2;

  // Total height of all rows at native 1:1 scale, capped to a value
  // browsers can actually represent.
  const naturalHeight = count * ROW_HEIGHT;
  const scaledHeight = Math.max(
    viewportHeight,
    Math.min(naturalHeight, MAX_SCROLL_HEIGHT_PX),
  );

  // The highest row index that can appear at the top of the viewport
  // without leaving blank space at the bottom.
  const maxAnchorRow = Math.max(0, count - visibleRowCount);
  const maxScroll = Math.max(1, scaledHeight - viewportHeight);

  // First visible row — either the live tail or the user's anchor,
  // clamped to a valid range.
  const firstVisibleRow = autoScroll
    ? maxAnchorRow
    : Math.min(maxAnchorRow, Math.max(0, anchorRow));
  const lastVisibleRow = Math.min(count, firstVisibleRow + visibleRowCount);

  // scrollTop that puts `firstVisibleRow` at the top of the viewport.
  const targetScrollTop =
    maxAnchorRow === 0 ? 0 : (firstVisibleRow / maxAnchorRow) * maxScroll;

  // When we change scrollTop ourselves to match a count or anchor
  // update, the browser fires a scroll event. We don't want that to
  // be treated as a user scroll — flag it so handleScroll skips its
  // "user moved the scrollbar" branch.
  const programmaticScrollRef = useRef(false);

  // Observe viewport size so the visible row count updates on resize.
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

  // Tell the parent which absolute rows are currently visible so it
  // can fetch the covering chunks.
  useEffect(() => {
    if (count === 0) return;
    ensureVisible(firstVisibleRow, lastVisibleRow);
  }, [firstVisibleRow, lastVisibleRow, count, ensureVisible]);

  // Push scrollTop to match the computed target whenever it drifts
  // (count growth in autoScroll mode, anchor change, viewport
  // resize, etc.).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (Math.abs(el.scrollTop - targetScrollTop) > 0.5) {
      programmaticScrollRef.current = true;
      el.scrollTop = targetScrollTop;
    }
  }, [targetScrollTop]);

  // Reset transient view state when the trace is cleared.
  useEffect(() => {
    if (count === 0) {
      setExpanded(new Set());
    }
  }, [count]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        return;
      }
      if (maxAnchorRow === 0) return;
      const newScrollTop = e.currentTarget.scrollTop;
      const fraction = newScrollTop / maxScroll;
      const newAnchor = Math.min(
        maxAnchorRow,
        Math.max(0, Math.round(fraction * maxAnchorRow)),
      );
      onUserScroll(newAnchor);
    },
    [maxAnchorRow, maxScroll, onUserScroll],
  );

  const toggleExpanded = (absoluteIndex: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(absoluteIndex)) next.delete(absoluteIndex);
      else next.add(absoluteIndex);
      return next;
    });
  };

  // Per-visible-row stacking offset, accounting for expanded rows
  // (which take EXPANDED_ROW_HEIGHT instead of ROW_HEIGHT).
  const placements: { absIdx: number; topOffset: number; isExpanded: boolean }[] = [];
  let cursor = 0;
  for (let absIdx = firstVisibleRow; absIdx < lastVisibleRow; absIdx++) {
    const isExp = expanded.has(absIdx);
    placements.push({ absIdx, topOffset: cursor, isExpanded: isExp });
    cursor += isExp ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT;
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
          {placements.map(({ absIdx, topOffset, isExpanded }) => {
            const frame = getFrame(absIdx);
            return (
              <div
                key={absIdx}
                className={`trace-row ${isExpanded ? "expanded" : ""} ${frame ? "" : "loading"}`}
                style={{
                  position: "absolute",
                  // The visible rows ride along with scrollTop so they
                  // appear at the same viewport positions regardless
                  // of how the scrollbar is scaled.
                  top: targetScrollTop + topOffset,
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
                  <span className="col-idx">{(absIdx + 1).toLocaleString()}</span>
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
