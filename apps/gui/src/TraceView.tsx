import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { SignalRecord, TraceFrameRecord } from "./types";
import type { TimelineEvent } from "./notes";
import type { TraceRow } from "./trace";
import { formatSignalValueWithLabel, formatTimestamp } from "./format";
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
  /// job is to re-render this component so `getRow` is re-consulted
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
  /// One row of the merged base-typed stream (ADR 0035): a frame or a
  /// timeline event. Frame rows page by index; event rows are merged in by
  /// the parent. `null` is a not-yet-loaded frame placeholder.
  getRow: (absoluteIndex: number) => TraceRow | null;
  ensureVisible: (start: number, end: number) => void;
  /// Called when the user scrolls the view themselves while
  /// `autoScroll` was on, so the parent can uncheck it.
  onAutoScrollDisabled: () => void;
  /// Inline edit handlers for *editable* event rows (ADR 0035): rename (click
  /// the label), recolour (click the swatch → native picker), remove (the row
  /// button). Omitted where events aren't editable, which also hides the
  /// controls. Must be referentially stable (the row is memoised).
  eventActions?: EventActions;
  /// A one-shot request to scroll a given display row into view (e.g. a
  /// cross-panel "goto", ADR 0035). `seq` distinguishes successive requests so
  /// the same `row` can be re-targeted; the view acts only when `seq` changes.
  scrollTarget?: { row: number; seq: number } | null;
  /// Show the frame column header. Default `true`; the dedicated events
  /// panel (ADR 0035) passes `false` since its rows carry no frame columns.
  showHeader?: boolean;
}

/// Inline mutators for an editable timeline event (ADR 0035), wired by the
/// panel to the host notes commands. A single object so the memoised row
/// takes one stable prop rather than three. `onGoto` is the odd one out: a
/// cross-panel timeline jump keyed by the event's timestamp (not its id),
/// since every panel resolves it against time (ADR 0024). Only the events
/// view supplies it; where it's absent the goto button is hidden, and it
/// works on any event (the truncation marker included), not just editable
/// ones.
export interface EventActions {
  onRename: (id: string, label: string) => void;
  onRecolor: (id: string, color: string | null) => void;
  onRemove: (id: string) => void;
  onGoto?: (timestampNs: number) => void;
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
  getRow,
  ensureVisible,
  onAutoScrollDisabled,
  eventActions,
  scrollTarget,
  showHeader = true,
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

  // A cross-panel "goto" (ADR 0035): drop out of auto-scroll and anchor the
  // requested display row near the top (a couple of rows of lead-in for
  // context). Acts only on a new `seq` so the same row can be re-targeted.
  const lastGotoSeq = useRef<number | null>(null);
  useEffect(() => {
    if (!scrollTarget || scrollTarget.seq === lastGotoSeq.current) return;
    lastGotoSeq.current = scrollTarget.seq;
    if (autoScroll) onAutoScrollDisabled();
    setAnchoredRow(Math.max(0, Math.min(scrollTarget.row - 2, anchorMax)));
  }, [scrollTarget, autoScroll, anchorMax, onAutoScrollDisabled]);

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
      {showHeader && (
        <TraceHeader
          columns={shown}
          onColumnResize={onColumnResize}
          onColumnToggle={onColumnToggle}
          onColumnReorder={onColumnReorder}
        />
      )}
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
            {placements.map(({ posKey, absIdx, top, isExpanded }) => {
              // Resolve the base-typed row once and hand the frame / event to
              // the single Row renderer as separate props — the inner objects
              // are ref-stable (chunk cache / events array), so `Row`'s memo
              // still skips unchanged rows where wrapping in a fresh
              // `{ row, … }` object each render would not (ADR 0035).
              const r = getRow(absIdx);
              return (
                <Row
                  key={posKey}
                  top={top}
                  absoluteIndex={absIdx}
                  isExpanded={isExpanded}
                  frame={r?.row === "frame" ? r.frame : null}
                  event={r?.row === "event" ? r.event : null}
                  baseTimestamp={baseTimestampSeconds}
                  columns={visible}
                  gridTemplate={gridTemplate}
                  busLookup={busLookup}
                  resolveColor={resolveColor}
                  onToggle={toggleExpanded}
                  eventActions={eventActions}
                />
              );
            })}
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
  /// Set when this row is a timeline event (ADR 0035) rather than a frame;
  /// the single renderer draws an event row instead of frame cells.
  event: TimelineEvent | null;
  baseTimestamp: number | null;
  columns: readonly ColumnState[];
  gridTemplate: string;
  busLookup: BusLookup;
  resolveColor: ColorResolver | null;
  onToggle: (absoluteIndex: number) => void;
  eventActions?: EventActions;
}

const Row = memo(function Row({
  top,
  absoluteIndex,
  isExpanded,
  frame,
  event,
  baseTimestamp,
  columns,
  gridTemplate,
  busLookup,
  resolveColor,
  onToggle,
  eventActions,
}: RowProps) {
  // Event rows (truncation marker, notes) render through the same renderer
  // as frames but with their own row layout (ADR 0035).
  if (event) {
    return <EventRow top={top} event={event} baseTimestamp={baseTimestamp} actions={eventActions} />;
  }
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

/// Default colour per event kind when an event carries no explicit colour
/// (ADR 0035): notes share the plot's event blue; the derived truncation
/// marker a muted amber.
const EVENT_KIND_COLOR: Record<string, string> = {
  note: "#4ecbff",
  truncation: "#e0a030",
};

/// One timeline-event row (ADR 0035), rendered by the same `Row` path as a
/// frame but with its own layout: the event time (relative to the trace
/// origin, like a frame's time cell), a full-height colour swatch, and the
/// label. Used for the truncation marker and for notes. Editable events
/// (notes, given `actions`) carry inline controls: click the label to rename,
/// click the swatch to recolour (the same native picker the plot uses), and a
/// remove button on the row. Derived events (the truncation marker) render the
/// same shape but inert.
function EventRow({
  top,
  event,
  baseTimestamp,
  actions,
}: {
  top: number;
  event: TimelineEvent;
  baseTimestamp: number | null;
  actions?: EventActions;
}) {
  const color = event.color ?? EVENT_KIND_COLOR[event.kind] ?? EVENT_KIND_COLOR.note;
  const editable = event.editable && actions != null;
  const onGoto = actions?.onGoto;
  const colorInputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(event.label);

  // This is a virtualized row slot: when scrolling reuses it for a different
  // event (or the label changes under us), drop any in-progress edit and
  // re-seed the draft from the new label.
  useEffect(() => {
    setEditing(false);
    setDraft(event.label);
  }, [event.id, event.label]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== event.label) actions?.onRename(event.id, next);
    setEditing(false);
  };

  return (
    <div
      className={`trace-row trace-event-row trace-event-${event.kind}${
        editable ? " trace-event-editable" : ""
      }`}
      style={{ position: "absolute", top, left: 0, right: 0, height: ROW_HEIGHT }}
      title={event.label}
    >
      <span className="trace-event-time">
        {formatTimestamp(event.timestampNs / 1e9, baseTimestamp)}
      </span>
      {onGoto && (
        <button
          type="button"
          className="trace-event-goto"
          title="go to this event in every trace and plot"
          aria-label="go to this event"
          onClick={() => onGoto(event.timestampNs)}
        >
          ⇥
        </button>
      )}
      {editable ? (
        // Swatch over a stacked native colour input — same control as the
        // plot's series swatch (PlotPanel's `SignalSwatch`).
        <span className="trace-event-swatch-wrap">
          <button
            type="button"
            className="trace-event-swatch"
            style={{ background: color }}
            title="pick a colour"
            aria-label="pick event colour"
            onClick={() => colorInputRef.current?.click()}
          />
          <input
            ref={colorInputRef}
            type="color"
            className="trace-event-swatch-input"
            aria-label="event colour"
            value={color}
            onChange={(e) => actions?.onRecolor(event.id, e.target.value)}
          />
        </span>
      ) : (
        <span className="trace-event-swatch" style={{ background: color }} aria-hidden />
      )}
      {editing ? (
        <input
          className="trace-event-label-input"
          autoFocus
          aria-label="event label"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") {
              setDraft(event.label);
              setEditing(false);
            }
          }}
          onBlur={commit}
        />
      ) : (
        <span
          className={`trace-event-label${editable ? " trace-event-label-editable" : ""}`}
          title={editable ? "click to rename" : undefined}
          onClick={editable ? () => setEditing(true) : undefined}
        >
          {event.label}
        </span>
      )}
      {editable && (
        <button
          type="button"
          className="trace-event-remove"
          title="remove event"
          aria-label="remove event"
          onClick={() => actions?.onRemove(event.id)}
        >
          ×
        </button>
      )}
    </div>
  );
}

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
