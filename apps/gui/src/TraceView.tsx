import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { SignalRecord, TraceFrameRecord } from "./types";
import { formatSignalValueWithLabel } from "./format";
import { type ColorResolver, colorMapTint } from "./colorMap";
import { setSignalDragData } from "./dragSignals";
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
import {
  type BusLookup,
  type ColumnKey,
  type ColumnState,
  columnDef,
  gridTemplateColumns,
  visibleColumns,
} from "./traceColumns";
import { TraceHeader, cellContent } from "./traceTable";
import { diagCount } from "./diag"; // DIAG

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
  /// Per-panel column state (which columns show, in what order, how
  /// wide). Owned by the panel; this view renders the table from it and
  /// reports drag-resizes / show-hides back.
  columns: readonly ColumnState[];
  onColumnResize: (key: ColumnKey, width: number) => void;
  onColumnToggle: (key: ColumnKey) => void;
  onColumnReorder: (key: ColumnKey, beforeKey: ColumnKey | null) => void;
  /// Resolves a decoded signal's value→color tint (ADR 0029), or null.
  resolveColor: ColorResolver | null;
  /// Bus-id → bus-name lookup for the "bus" column, built once per
  /// render from the project's bus list.
  busLookup: BusLookup;
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
  columns,
  onColumnResize,
  onColumnToggle,
  onColumnReorder,
  resolveColor,
  busLookup,
  getFrame,
  ensureVisible,
  onAutoScrollDisabled,
}: TraceViewProps) {
  diagCount("render.TraceView"); // DIAG
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
      diagCount("traceview.resizeObserver"); // DIAG
      if (containerRef.current) {
        setViewportHeight(containerRef.current.clientHeight);
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Tell the parent which absolute rows are visible so it can prefetch
  // the covering chunks — but skip this while auto-scrolling: the
  // `trace-grew` overlay already carries enough trailing frames to
  // cover every visible row, so prefetching there would just churn the
  // shared chunk cache (at a high frame rate the live edge moves many
  // chunks per tick, evicting other panels' rows from the LRU).
  useEffect(() => {
    if (count === 0 || autoScroll) return;
    ensureVisible(firstVisibleRow, lastVisibleRow);
  }, [autoScroll, firstVisibleRow, lastVisibleRow, count, ensureVisible]);

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
    // A geometry change (window resize) can nudge `scrollTop` and fire
    // a scroll event that isn't a user scroll. While auto-scrolling,
    // only treat it as one if it actually moved us off the live edge —
    // otherwise the re-pin effect snaps us back next render anyway.
    const offBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    if (autoScroll && offBottom > REPIN_THRESHOLD_PX) onAutoScrollDisabled();
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

  // The chronological view drops by-id-only columns (e.g. "msg/s" — a
  // single frame has no rate). Memoised so a `trace-grew` re-render
  // (which leaves `columns` untouched) doesn't hand every `Row` a fresh
  // array and force the whole window to re-render; they only change on
  // a resize / toggle.
  const shown = useMemo(() => columns.filter((c) => !columnDef(c.key).byIdOnly), [columns]);
  const visible = useMemo(() => visibleColumns(shown), [shown]);
  const gridTemplate = useMemo(() => gridTemplateColumns(shown), [shown]);

  const placements = buildPlacements(firstVisibleRow, count, rows, expanded);

  return (
    <div className="trace">
      <TraceHeader
        columns={shown}
        onColumnResize={onColumnResize}
        onColumnToggle={onColumnToggle}
        onColumnReorder={onColumnReorder}
      />
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
                columns={visible}
                gridTemplate={gridTemplate}
                busLookup={busLookup}
                resolveColor={resolveColor}
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
  columns: readonly ColumnState[];
  gridTemplate: string;
  busLookup: BusLookup;
  resolveColor: ColorResolver | null;
  onToggle: (absoluteIndex: number) => void;
}

const Row = memo(function Row({
  top,
  absoluteIndex,
  isExpanded,
  frame,
  baseTimestamp,
  columns,
  gridTemplate,
  busLookup,
  resolveColor,
  onToggle,
}: RowProps) {
  const height = isExpanded ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT;
  return (
    <div
      className={`trace-row ${isExpanded ? "expanded" : ""} ${frame ? "" : "loading"}${
        frame?.violation ? " trace-row-violation" : ""
      }`}
      title={
        frame?.violation
          ? `calculated-field check failed: ${frame.violation}`
          : undefined
      }
      style={{
        position: "absolute",
        top,
        left: 0,
        right: 0,
        height,
        gridTemplateColumns: gridTemplate,
      }}
      onClick={() => frame?.decoded && onToggle(absoluteIndex)}
    >
      {columns.map((c) => (
        <span key={c.key} className={columnDef(c.key).className}>
          {cellContent(c.key, frame, absoluteIndex, baseTimestamp, isExpanded, busLookup)}
        </span>
      ))}
      {isExpanded && frame?.decoded && (
        <div className="signals">
          {frame.decoded.signals.map((sig) => (
            <DecodedSignalCell
              key={sig.name}
              frame={frame}
              messageName={frame.decoded!.name}
              sig={sig}
              resolveColor={resolveColor}
            />
          ))}
        </div>
      )}
    </div>
  );
});

/// One decoded signal cell inside an expanded trace row. It is
/// a drag source — dragging onto a plot area adds the
/// signal as a series. Click events still fall through to the row
/// (`stopPropagation` would prevent the expand-collapse toggle from
/// retracting); dragging is initiated by the browser only when the
/// mouse actually leaves the source, so plain clicks aren't
/// hijacked.
function DecodedSignalCell({
  frame,
  messageName,
  sig,
  resolveColor,
}: {
  frame: TraceFrameRecord;
  messageName: string;
  sig: SignalRecord;
  resolveColor: ColorResolver | null;
}) {
  const tint = resolveColor?.(
    {
      messageId: frame.id,
      extended: frame.extended,
      signalName: sig.name,
      busId: frame.bus_id ?? null,
    },
    sig.value,
  );
  return (
    <div
      className="signal"
      draggable
      onDragStart={(e) => {
        // Stop the parent row's drag from also firing — there isn't
        // a row-level drag today, but the convention pre-empts a
        // surprising one. The drag payload is a single ref; the
        // bus comes from the frame's own routing decision (the
        // host's `bus_id`) so a frame on bus A drops as a signal
        // bound to bus A.
        e.stopPropagation();
        setSignalDragData(e, [
          {
            busId: frame.bus_id ?? null,
            messageId: frame.id,
            extended: frame.extended,
            signalName: sig.name,
            messageName,
            unit: sig.unit,
          },
        ]);
      }}
    >
      <span className="signal-name">{sig.name}</span>
      <span
        className="signal-value"
        style={tint ? { background: colorMapTint(tint) } : undefined}
      >
        {formatSignalValueWithLabel(sig.value, sig.unit, sig.label)}
      </span>
    </div>
  );
}
