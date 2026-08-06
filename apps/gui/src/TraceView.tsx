import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { TraceFrameRecord } from "./types";
import type { TimelineEvent } from "./notes";
import type { TraceRow } from "./trace";
import { formatTimestamp, type CanIdFormat } from "./format";
import { type ColorResolver } from "./colorMap";
import { DecodedSignalCell } from "./DecodedSignalCell";
import {
  ROW_HEIGHT,
  anchorFromScroll,
  buildPlacements,
  expandedExtraHeightOf,
  expandedRowHeight,
  maxScrollTop,
  maxWheelRows,
  scrollForAnchor,
  wheelDeltaPx,
} from "./traceViewport";
import { useTraceViewport } from "./useTraceViewport";
import { useSetting } from "./hostSettings";
import { toggleInSet } from "./toggleSet";
import {
  type BusLookup,
  type ColumnKey,
  type ColumnState,
  COLUMN_DEFS,
  columnDef,
  gridTemplateColumns,
  visibleColumns,
} from "./traceColumns";
import { TraceTimeCell, cellContent } from "./traceTable";
import { GridviewHeader, GridviewRow, contentWidthStyle } from "./gridviewColumns";
import { diagCount } from "./diag"; // DIAG

interface TraceViewProps {
  count: number;
  /// Bumped by the parent when the loaded page's contents change; its only
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
  /// the label), recolor (click the swatch → native picker), remove (the row
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
  version,
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

  // How the `id` column renders (`can_id_format`). Read through
  // `useSetting` — not `hostSettings()` — because the rows are memoised:
  // a change has to arrive as a *changed prop* or the visible window
  // keeps painting the old format until something else moves.
  const idFormat = useSetting("can_id_format") as CanIdFormat;

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // The event row the user last clicked, by event id (ADR 0035) — view-local
  // selection, keyed by identity rather than row position because the row
  // slots are recycled as the view scrolls. `null` means none.
  const [focusedEvent, setFocusedEvent] = useState<string | null>(null);
  // Absolute row at the top of the viewport, and the single source of
  // truth for what's shown: `firstVisibleRow` and the scrollbar
  // position both derive from it, so the rendered rows never depend on
  // the live `scrollTop` and can't jitter when `count` grows
  // underneath the user. A user scroll points it at whatever row the
  // scrollbar now sits on; the re-pin effect drags `scrollTop` to match
  // as the trace lengthens (which shifts the row↔scroll mapping past
  // ~730k rows, where it's compressed).
  //
  // `null` means "pinned to the live tail", where the anchor is
  // *derived* from `anchorMax` rather than stored. Storing it there
  // needed a post-render write on every `count` growth, so each live
  // tick rendered twice: once against the stale anchor, discarded, then
  // again against the new one.
  const [anchoredRow, setAnchoredRow] = useState<number | null>(autoScroll ? null : 0);
  // Auto-scroll always means pinned, whatever the stored anchor says —
  // so nothing has to race the toggle to keep the two consistent.
  const anchor = autoScroll ? null : anchoredRow;

  // Set true when *we* move scrollTop (the re-pin effect) so the
  // resulting scroll event isn't taken for a user scroll — which would
  // both disable auto-scroll and re-anchor the view to itself.
  const programmaticScrollRef = useRef(false);

  // Signal count for expanded-row sizing: only frames have signals; an
  // event row or a not-yet-loaded frame sizes as a plain row.
  const signalCount = useCallback(
    (absIdx: number) => {
      const r = getRow(absIdx);
      return r?.row === "frame" ? r.frame.decoded?.signals.length ?? 0 : 0;
    },
    // `version` is a dep so a page landing re-derives the heights even
    // though it isn't read directly (what `getRow` answers changes
    // behind it).
    [getRow, version],
  );

  // The rendered height of a row, and what the expanded ones add over
  // the plain-row baseline. Both go to the scaffold, so the anchor
  // bound and the scroll spacer are computed over the rows this view
  // actually draws — without them, expanding a row near the tail
  // stacks its signal lines below the sticky viewport's fold with no
  // scroll position that reaches them, and the scroll range doesn't
  // grow to make one.
  const rowHeightAt = useCallback(
    (absIdx: number) =>
      expanded.has(absIdx) ? expandedRowHeight(signalCount(absIdx)) : ROW_HEIGHT,
    [expanded, signalCount],
  );
  // Iterates the expanded set, not the trace: `count` here is the whole
  // capture and reaches millions.
  const extraHeight = useMemo(
    () => (expanded.size === 0 ? 0 : expandedExtraHeightOf(expanded, count, rowHeightAt)),
    [expanded, count, rowHeightAt],
  );

  const {
    containerRef,
    headerRef,
    viewportHeight,
    rows,
    spacerHeight,
    anchorMax,
    firstVisibleRow,
    lastVisibleRow,
  } = useTraceViewport(count, anchor, "traceview.resizeObserver", {
    extraHeight,
    rowHeightAt,
  });
  // The scroll range the anchor maps through, in both directions. Read
  // from the same `extraHeight` the scaffold used, so the bottom of the
  // scrollbar and the tail anchor are the same place.
  const scrollRange = maxScrollTop(count, viewportHeight, extraHeight);
  // `scrollForAnchor(anchorMax)` is exactly the bottom, so this is "the
  // bottom" while auto-scrolling and the anchored row's scrollTop
  // otherwise.
  const targetScrollTop = scrollForAnchor(firstVisibleRow, anchorMax, scrollRange);

  // Tell the parent which absolute rows are visible so it can page them
  // in — but skip this while auto-scrolling: the `trace-grew` live-tail
  // overlay already carries enough trailing frames to cover every
  // visible row, so asking here would re-page the window every tick and
  // pull it off whatever the other consumers of the same query need.
  useEffect(() => {
    if (count === 0 || autoScroll) return;
    ensureVisible(firstVisibleRow, lastVisibleRow);
  }, [autoScroll, firstVisibleRow, lastVisibleRow, count, ensureVisible]);

  // Turning auto-scroll off from the toolbar is the one path that stops
  // following the tail without naming a row (every other one — a scroll,
  // a wheel step, a goto — sets the anchor itself), so fill in the row
  // the view is already showing. Keyed on the `autoScroll` edge, so it
  // costs one render per toggle and none per tick; `?? ` leaves an
  // anchor a handler set while disabling alone.
  const anchorMaxRef = useRef(anchorMax);
  anchorMaxRef.current = anchorMax;
  const wasAutoScroll = useRef(autoScroll);
  useLayoutEffect(() => {
    const was = wasAutoScroll.current;
    wasAutoScroll.current = autoScroll;
    if (autoScroll && !was) setAnchoredRow(null);
    else if (!autoScroll && was) setAnchoredRow((r) => r ?? anchorMaxRef.current);
  }, [autoScroll]);

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
      const fromRow = anchorFromScroll(el.scrollTop, anchorMax, scrollRange);
      const toRow = anchorFromScroll(el.scrollTop + px, anchorMax, scrollRange);
      const max = maxWheelRows(viewportHeight);
      if (Math.abs(toRow - fromRow) <= max) return; // small enough — native scroll
      e.preventDefault();
      const step = px > 0 ? max : -max;
      if (autoScroll) {
        if (step > 0) return; // already pinned to the tail
        onAutoScrollDisabled(); // wheel-up: release the pin to look back
      }
      setAnchoredRow((r) => {
        const base = autoScroll || r == null ? anchorMax : Math.min(anchorMax, Math.max(0, r));
        return Math.min(anchorMax, Math.max(0, base + step));
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewportHeight, autoScroll, anchorMax, scrollRange, onAutoScrollDisabled]);

  // Reset transient view state when the trace is cleared.
  useEffect(() => {
    if (count === 0) {
      setExpanded(new Set());
      setFocusedEvent(null);
      setAnchoredRow(autoScroll ? null : 0);
    }
  }, [count, autoScroll]);

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
    setAnchoredRow(anchorFromScroll(el.scrollTop, anchorMax, scrollRange));
  }, [autoScroll, onAutoScrollDisabled, anchorMax, scrollRange]);

  const toggleExpanded = useCallback((absoluteIndex: number) => {
    setExpanded((prev) => toggleInSet(prev, absoluteIndex));
  }, []);
  const focusEvent = useCallback((id: string) => setFocusedEvent(id), []);

  // The chronological view drops by-id-only columns (e.g. "msg/s" — a
  // single frame has no rate). Memoised so a `trace-grew` re-render
  // (which leaves `columns` untouched) doesn't hand every `Row` a fresh
  // array and force the whole window to re-render; they only change on
  // a resize / toggle.
  const shown = useMemo(() => columns.filter((c) => !columnDef(c.key).byIdOnly), [columns]);
  const visible = useMemo(() => visibleColumns(shown), [shown]);
  const gridTemplate = useMemo(() => gridTemplateColumns(shown), [shown]);
  const contentWidthVar = useMemo(() => contentWidthStyle(shown), [shown]);

  const placements = buildPlacements(firstVisibleRow, count, rows, expanded, signalCount);
  // How tall the rendered rows actually stack. The sticky viewport
  // clips (`overflow: hidden`), so it takes the larger of the panel
  // height and the stack — an expanded row taller than the panel then
  // slides into view as the scroll runs past the sticky element's own
  // height instead of being cut off at the fold. Same rule as
  // `ByIdTable`.
  const lastPlacement = placements[placements.length - 1];
  const stackHeight = lastPlacement ? lastPlacement.top + lastPlacement.height : 0;

  return (
    <div className="trace">
      {showHeader && (
        <GridviewHeader
          defs={COLUMN_DEFS}
          columns={shown}
          headerRef={headerRef}
          onColumnResize={onColumnResize}
          onColumnToggle={onColumnToggle}
          onColumnReorder={onColumnReorder}
        />
      )}
      <div ref={containerRef} className="trace-rows" onScroll={handleScroll}>
        {/* Spacer: gives the scrollbar the trace's full (scaled) extent
            vertically, and the columns' own width horizontally — the
            rows are absolutely positioned against it, so without that
            the columns past the panel's right edge are clipped by the
            sticky viewport with no scroll position that reaches them. */}
        <div
          className="trace-scroll-content"
          style={{ height: spacerHeight, position: "relative", ...contentWidthVar }}
        >
          {/* Sticky viewport: the compositor keeps this pinned to the
              top of the scroll area, so the rows never lag the
              scrollbar — React only swaps their content. */}
          <div
            style={{
              position: "sticky",
              top: 0,
              height: Math.max(viewportHeight, stackHeight),
              overflow: "hidden",
            }}
          >
            {placements.map(({ posKey, absIdx, top, isExpanded, height }) => {
              // Resolve the base-typed row once and hand the frame / event to
              // the single Row renderer as separate props — the inner objects
              // are ref-stable (the loaded page / the events array), so `Row`'s memo
              // still skips unchanged rows where wrapping in a fresh
              // `{ row, … }` object each render would not (ADR 0035).
              const r = getRow(absIdx);
              return (
                <Row
                  key={posKey}
                  top={top}
                  height={height}
                  absoluteIndex={absIdx}
                  isExpanded={isExpanded}
                  frame={r?.row === "frame" ? r.frame : null}
                  event={r?.row === "event" ? r.event : null}
                  baseTimestamp={baseTimestampSeconds}
                  idFormat={idFormat}
                  columns={visible}
                  gridTemplate={gridTemplate}
                  busLookup={busLookup}
                  resolveColor={resolveColor}
                  onToggle={toggleExpanded}
                  eventActions={eventActions}
                  // A boolean rather than the focused id, so moving the
                  // focus re-renders the two rows it touches and no others.
                  eventFocused={r?.row === "event" && r.event.id === focusedEvent}
                  onEventFocus={focusEvent}
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
  /// Row height from the placement (`RowPlacement.height`), so the
  /// rendered box always matches the stacking arithmetic.
  height: number;
  absoluteIndex: number;
  isExpanded: boolean;
  frame: TraceFrameRecord | null;
  /// Set when this row is a timeline event (ADR 0035) rather than a frame;
  /// the single renderer draws an event row instead of frame cells.
  event: TimelineEvent | null;
  baseTimestamp: number | null;
  idFormat: CanIdFormat;
  columns: readonly ColumnState[];
  gridTemplate: string;
  busLookup: BusLookup;
  resolveColor: ColorResolver | null;
  onToggle: (absoluteIndex: number) => void;
  eventActions?: EventActions;
  /// This row is the focused event row (event rows only).
  eventFocused: boolean;
  onEventFocus: (id: string) => void;
}

const Row = memo(function Row({
  top,
  height,
  absoluteIndex,
  isExpanded,
  frame,
  event,
  baseTimestamp,
  idFormat,
  columns,
  gridTemplate,
  busLookup,
  resolveColor,
  onToggle,
  eventActions,
  eventFocused,
  onEventFocus,
}: RowProps) {
  // Event rows (truncation marker, notes) render through the same renderer
  // as frames but with their own row layout (ADR 0035).
  if (event) {
    return (
      <EventRow
        top={top}
        event={event}
        baseTimestamp={baseTimestamp}
        actions={eventActions}
        focused={eventFocused}
        onFocus={onEventFocus}
      />
    );
  }
  return (
    <GridviewRow
      defs={COLUMN_DEFS}
      columns={columns}
      gridTemplate={gridTemplate}
      className={`trace-row ${isExpanded ? "expanded" : ""} ${frame ? "" : "loading"}${
        frame?.violation ? " trace-row-violation" : ""
      }`}
      title={
        frame?.violation
          ? `calculated-field check failed: ${frame.violation}`
          : undefined
      }
      style={{ position: "absolute", top, left: 0, right: 0, height }}
      onClick={() => frame?.decoded && onToggle(absoluteIndex)}
      renderCell={(key, className) => {
        const content = cellContent(
          key,
          frame,
          absoluteIndex,
          baseTimestamp,
          idFormat,
          isExpanded,
          busLookup,
        );
        return key === "time" ? (
          <TraceTimeCell
            className={className}
            seconds={frame?.timestamp_seconds ?? null}
            base={baseTimestamp}
          >
            {content}
          </TraceTimeCell>
        ) : (
          <span className={className}>{content}</span>
        );
      }}
    >
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
    </GridviewRow>
  );
});

/// Default color per event kind when an event carries no explicit color
/// (ADR 0035): notes share the plot's event blue; the derived truncation
/// marker a muted amber.
const EVENT_KIND_COLOR: Record<string, string> = {
  note: "#4ecbff",
  truncation: "#e0a030",
};

/// One timeline-event row (ADR 0035), rendered by the same `Row` path as a
/// frame but with its own layout: the event time (relative to the trace
/// origin, like a frame's time cell), a full-height color swatch, and the
/// label. Used for the truncation marker and for notes.
///
/// **Clicking the row focuses it** — it is a focus target in its own right,
/// and the focused row is the one the row's controls act on. Editable events
/// (notes, given `actions`) carry those controls inline: a rename button
/// (which is what turns the label into a field), the swatch (click to recolor,
/// the same native picker the plot uses), and a remove button. Double-clicking
/// the label renames it too, as the direct-manipulation shortcut. Derived
/// events (the truncation marker) render the same shape, focusable but inert.
function EventRow({
  top,
  event,
  baseTimestamp,
  actions,
  focused,
  onFocus,
}: {
  top: number;
  event: TimelineEvent;
  baseTimestamp: number | null;
  actions?: EventActions;
  focused: boolean;
  onFocus: (id: string) => void;
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
      }${focused ? " trace-event-focused" : ""}`}
      style={{ position: "absolute", top, left: 0, right: 0, height: ROW_HEIGHT }}
      title={event.label}
      tabIndex={0}
      onClick={() => onFocus(event.id)}
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
        // Swatch over a stacked native color input — same control as the
        // plot's series swatch (PlotPanel's `SignalSwatch`).
        <span className="trace-event-swatch-wrap">
          <button
            type="button"
            className="trace-event-swatch"
            style={{ background: color }}
            title="pick a color"
            aria-label="pick event color"
            onClick={() => colorInputRef.current?.click()}
          />
          <input
            ref={colorInputRef}
            type="color"
            className="trace-event-swatch-input"
            aria-label="event color"
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
          title={editable ? "double-click to rename" : undefined}
          onDoubleClick={editable ? () => setEditing(true) : undefined}
        >
          {event.label}
        </span>
      )}
      {editable && !editing && (
        <button
          type="button"
          className="trace-event-edit"
          title="rename"
          aria-label="rename event"
          onClick={() => setEditing(true)}
        >
          ✎
        </button>
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

// `DecodedSignalCell` is shared with `ByIdTable` — see `DecodedSignalCell.tsx`.
