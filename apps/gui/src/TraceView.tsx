import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { SignalRecord, TraceFrameRecord } from "./types";
import { theme, useThemeName } from "./theme";
import type { TimelineEvent } from "./notes";
import type { TraceRow } from "./trace";
import { formatTimestamp, type CanIdFormat } from "./format";
import { type ColorResolver } from "./colorMap";
import { DecodedSignalCell } from "./DecodedSignalCell";
import { ColorChip } from "./ColorChip";
import {
  ROW_HEIGHT,
  SIGNAL_LINE_HEIGHT,
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
import {
  type BusLookup,
  type ColumnKey,
  type ColumnState,
  COLUMN_DEFS,
  columnDef,
  gridTemplateColumns,
  visibleColumns,
} from "./traceColumns";
import {
  ERROR_FRAME_ROW_CLASS,
  ERROR_FRAME_TITLE,
  TraceTimeCell,
  cellContent,
} from "./traceTable";
import { GridviewHeader, GridviewRow, contentWidthStyle } from "./gridviewColumns";
import { useGridview } from "./useGridview";
import type { GridviewAdapter, GridviewRow as GridviewRowModel } from "./gridviewRows";
import {
  contentRowId,
  contentRowSpace,
  type ContentRowSpace,
  type OpenContentRun,
} from "./gridviewContentRows";
import {
  messageDragRefs,
  setSignalDragPayload,
  type DraggableSignalRef,
} from "./dragSignals";
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
  /// Set or clear the disclosed description body (ADR 0035).
  onDescribe?: (id: string, description: string | null) => void;
  /// Set or clear the user-defined tag the event view filters on.
  onRetag?: (id: string, tag: string | null) => void;
  onGoto?: (timestampNs: number) => void;
}

/// Stable ids for the chronological row space (ADR 0044). A frame is
/// named by its **absolute index in the capture**, which does not move
/// as the window slides or as timeline events interleave; an event by
/// its own id. A row whose page has not landed has no identity to
/// offer — the frontend holds one page of a host-owned row space — so
/// the space's ids are exactly the rows it holds.
const FRAME_ROW_PREFIX = "f:";
const EVENT_ROW_PREFIX = "e:";
const frameRowId = (frame: TraceFrameRecord) => `${FRAME_ROW_PREFIX}${frame.index}`;
/// The decoded signals a frame row discloses — rows of the space in
/// their own right (ADR 0044), empty for anything that discloses
/// nothing.
function signalsOf(r: TraceRow | null): readonly SignalRecord[] {
  return r?.row === "frame" ? r.frame.decoded?.signals ?? [] : [];
}
/// The rows an event discloses when opened (ADR 0035): its user tag and
/// its description body, each editable in place. Named so their content-row
/// ids are stable across a re-render, like a signal's name.
const EVENT_BODY_ROWS = ["tag", "description"] as const;

/// Does this event disclose a body at all? One that carries a tag or a
/// description does; so does an editable one, which is how an empty note
/// gets given either. A read-only event with neither has nothing to open.
function eventDiscloses(e: TimelineEvent): boolean {
  return e.editable || e.description != null || e.tag != null;
}

/// How many rows a row discloses when opened — a frame's decoded signals,
/// or an event's body. One notion, because the row heights, the scroll
/// space and the keyboard cursor all have to agree on it.
function contentCountOf(r: TraceRow | null): number {
  if (r?.row === "event") return eventDiscloses(r.event) ? EVENT_BODY_ROWS.length : 0;
  return signalsOf(r).length;
}

/// The name of the `i`th disclosed row, for its stable content-row id.
function contentNameAt(r: TraceRow | null, i: number): string | null {
  if (r?.row === "event") return EVENT_BODY_ROWS[i] ?? null;
  return signalsOf(r)[i]?.name ?? null;
}

function rowIdOf(r: TraceRow | null): string | null {
  if (!r) return null;
  return r.row === "event" ? `${EVENT_ROW_PREFIX}${r.event.id}` : frameRowId(r.frame);
}

/// Stable empties, so a view with nothing open hands the same objects
/// to the memoised rows on every live tick.
const EMPTY_EXPANDED: ReadonlyMap<string, number> = new Map();
const EMPTY_POSITIONS: ReadonlySet<number> = new Set();
const EMPTY_RUNS: readonly OpenContentRun[] = [];

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

  // The open rows, by stable id, each carrying how many decoded signals
  // it discloses. Keyed by id rather than by row position because a
  // display index names a different frame the moment the window slides
  // or an event interleaves (ADR 0044); the signal count rides along
  // because the scroll geometry needs the height of *every* open row,
  // including ones scrolled out of the loaded page, which can no longer
  // be asked. Ephemeral — the chronological rows are capture-scoped.
  const [expanded, setExpanded] = useState<ReadonlyMap<string, number>>(EMPTY_EXPANDED);
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

  // Disclosed-row count for expanded-row sizing: a frame's decoded
  // signals, an event's body, nothing for a not-yet-loaded frame.
  const contentCount = useCallback(
    (absIdx: number) => contentCountOf(getRow(absIdx)),
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
    (absIdx: number) => {
      if (expanded.size === 0) return ROW_HEIGHT;
      const id = rowIdOf(getRow(absIdx));
      return id != null && expanded.has(id) ? expandedRowHeight(contentCount(absIdx)) : ROW_HEIGHT;
    },
    [expanded, getRow, contentCount],
  );
  // Iterates the open rows, not the trace: `count` here is the whole
  // capture and reaches millions.
  const extraHeight = useMemo(() => expandedExtraHeightOf(expanded.values()), [expanded]);

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
      setExpanded(EMPTY_EXPANDED);
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

  const toggleExpanded = useCallback((rowId: string, signals: number) => {
    setExpanded((prev) => {
      const next = new Map(prev);
      if (!next.delete(rowId)) next.set(rowId, signals);
      return next;
    });
  }, []);
  const focusEvent = useCallback((id: string) => setFocusedEvent(id), []);

  // The open rows in the render window, each with the number of rows it
  // discloses: the runs the row space splices content into, and the
  // positions the placement arithmetic sizes. Ascending by
  // construction — the walk goes down the window. An open row scrolled
  // out of the window is not among them: its height still counts
  // through `extraHeight`, and its id resolves to nothing while it is
  // gone, exactly as every other id outside the window does. `version`
  // is a dep so a page landing re-derives it (the content it gates
  // changes behind `getRow`).
  const openRuns = useMemo<readonly OpenContentRun[]>(() => {
    if (expanded.size === 0) return EMPTY_RUNS;
    const out: OpenContentRun[] = [];
    for (let i = 0; i < rows; i++) {
      const abs = firstVisibleRow + i;
      if (abs >= count) break;
      const r = getRow(abs);
      const id = rowIdOf(r);
      if (id != null && expanded.has(id)) out.push({ index: abs, content: contentCountOf(r) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, rows, firstVisibleRow, count, getRow, version]);
  const contentSpace = useMemo<ContentRowSpace>(
    () => contentRowSpace(count, openRuns),
    [count, openRuns],
  );

  // --- the gridview (ADR 0044) ---
  // The row space is the merged display space: frames and timeline
  // events alike, every row a leaf, a frame expandable exactly when it
  // has a decode to disclose — and what it discloses are rows too, one
  // per decoded signal, spliced in under their message. Its ids exist
  // for the rows this view holds — one page of a host-owned space whose
  // `count` is the whole capture — so everything id-keyed resolves
  // through the render window, which is where the cursor lives by
  // construction.
  const geometry = useRef({
    firstVisibleRow,
    rows,
    count,
    getRow,
    autoScroll,
    anchorMax,
    contentSpace,
  });
  geometry.current = {
    firstVisibleRow,
    rows,
    count,
    getRow,
    autoScroll,
    anchorMax,
    contentSpace,
  };
  /// Where a row id sits in the display space, or `-1`. Runs on a key
  /// press or a click, never in the render path.
  const windowIndexOf = useCallback((id: string) => {
    const g = geometry.current;
    for (let i = 0; i < g.rows; i++) {
      const abs = g.firstVisibleRow + i;
      if (abs >= g.count) break;
      const r = g.getRow(abs);
      const rowId = rowIdOf(r);
      if (rowId == null) continue;
      if (rowId === id) return g.contentSpace.indexOf({ index: abs, content: null });
      // A disclosed row is named after the row that disclosed it, so
      // only that row's own signals can answer for it.
      if (!id.startsWith(`${rowId}/`)) continue;
      const k = Array.from({ length: contentCountOf(r) }, (_, i) =>
        contentRowId(rowId, contentNameAt(r, i) ?? ""),
      ).indexOf(id);
      if (k >= 0) return g.contentSpace.indexOf({ index: abs, content: k });
    }
    return -1;
  }, []);
  const rowModelAt = useCallback(
    (index: number): GridviewRowModel | null => {
      const pos = contentSpace.at(index);
      if (pos == null) return null;
      const r = getRow(pos.index);
      const id = rowIdOf(r);
      if (r == null || id == null) return null;
      if (pos.content != null) {
        const name = contentNameAt(r, pos.content);
        // Depth 1, so Left walks out of a disclosed row to the message
        // that disclosed it.
        return name == null
          ? null
          : { id: contentRowId(id, name), kind: "leaf", expandable: false, depth: 1 };
      }
      return {
        id,
        kind: "leaf",
        expandable: contentCountOf(r) > 0,
        depth: 0,
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contentSpace, getRow, version],
  );
  const scrollToRow = useCallback(
    (index: number) => {
      const g = geometry.current;
      // The scroll geometry is in message rows: a disclosed row is
      // brought into view by bringing its message there.
      const target = g.contentSpace.at(index)?.index ?? index;
      // `rows` carries the two-row render pad, so the last *whole* row
      // is two short of the window's end.
      const page = Math.max(1, g.rows - 2);
      const next =
        target < g.firstVisibleRow
          ? target
          : target > g.firstVisibleRow + page - 1
            ? target - page + 1
            : null;
      // Already on screen: the live pin is never disturbed by a cursor
      // move within the tail the user is watching.
      if (next == null) return;
      // Moving the window is what releases the pin, exactly as a
      // wheel-up does — otherwise the anchor is written and ignored.
      if (g.autoScroll) onAutoScrollDisabled();
      setAnchoredRow(Math.max(0, Math.min(g.anchorMax, next)));
    },
    [onAutoScrollDisabled],
  );
  const setRowExpanded = useCallback(
    (id: string, want: boolean) => {
      if (expanded.has(id) === want) return;
      const abs = contentSpace.at(windowIndexOf(id))?.index ?? -1;
      toggleExpanded(id, want ? contentCount(abs) : 0);
    },
    [expanded, toggleExpanded, contentCount, windowIndexOf, contentSpace],
  );
  const adapter = useMemo<GridviewAdapter>(
    () => ({
      count: contentSpace.count,
      rowIdAt: (index) => rowModelAt(index)?.id ?? null,
      indexOf: windowIndexOf,
      rowAt: (id) => {
        const i = windowIndexOf(id);
        return i < 0 ? null : rowModelAt(i);
      },
      isExpanded: (id) => expanded.has(id),
      scrollToRow,
      setExpanded: setRowExpanded,
      // An event row is not a message: it carries nothing a drop target
      // could take, so it takes part in the cursor but not the
      // selection. A message's disclosed rows are named after it, so
      // they are selectable with it.
      isSelectable: (row) => row.id.startsWith(FRAME_ROW_PREFIX),
      // The space is the whole capture; the page this view holds is the
      // honest answer, and the only affordable one (the default walk is
      // O(count) per click).
      selectionOrder: () => {
        const out: string[] = [];
        for (let i = 0; i < rows; i++) {
          const abs = firstVisibleRow + i;
          if (abs >= count) break;
          const r = getRow(abs);
          const id = rowIdOf(r);
          if (id == null || !id.startsWith(FRAME_ROW_PREFIX)) continue;
          out.push(id);
          if (!expanded.has(id)) continue;
          for (const sig of signalsOf(r)) out.push(contentRowId(id, sig.name));
        }
        return out;
      },
    }),
    [
      contentSpace,
      count,
      rows,
      firstVisibleRow,
      getRow,
      rowModelAt,
      expanded,
      scrollToRow,
      setRowExpanded,
      windowIndexOf,
    ],
  );
  // Namespaces this instance's row DOM ids, so two chronological views
  // on screen can't name each other's rows.
  const instanceId = useId();
  const grid = useGridview({
    adapter,
    pageRows: Math.max(1, rows - 2),
    idPrefix: `trace${instanceId}`,
  });
  // The rows are memoised and the hook hands back fresh callbacks every
  // render (its adapter moves with the window), so the row-facing
  // handlers read the live gridview through a ref instead — otherwise
  // every visible row repaints on every live tick.
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const handleRowClick = useCallback(
    (id: string, e: React.MouseEvent) => {
      gridRef.current.onRowClick(id, { mod: e.ctrlKey || e.metaKey, shift: e.shiftKey });
      // An event row is its own focus target and keeps the keyboard (the
      // grid's keys still reach the container by bubbling); a frame row
      // is not one, so the grid takes it.
      const target = e.target as HTMLElement | null;
      if (target?.closest(".trace-row[tabindex], button, input") == null) {
        containerRef.current?.focus();
      }
    },
    [containerRef],
  );
  /// What one grab carries (ADR 0045): the grabbed row's message, or —
  /// when that row is in the selection — every selected row's message.
  /// Resolved from the rows this view holds, at drag time, so the scroll
  /// path pays nothing for it.
  const startRowDrag = useCallback(
    (id: string, e: React.DragEvent) => {
      const g = geometry.current;
      const selection = gridRef.current.selection;
      const ids = selection.has(id) ? selection : new Set([id]);
      const signals: DraggableSignalRef[] = [];
      for (let i = 0; i < g.rows; i++) {
        const abs = g.firstVisibleRow + i;
        if (abs >= g.count) break;
        const r = g.getRow(abs);
        if (r?.row !== "frame" || !ids.has(frameRowId(r.frame))) continue;
        signals.push(...messageDragRefs(r.frame));
      }
      setSignalDragPayload(e, { signals, patterns: [] });
    },
    [],
  );

  // The chronological view drops by-id-only columns (e.g. "msg/s" — a
  // single frame has no rate). Memoised so a `trace-grew` re-render
  // (which leaves `columns` untouched) doesn't hand every `Row` a fresh
  // array and force the whole window to re-render; they only change on
  // a resize / toggle.
  const shown = useMemo(() => columns.filter((c) => !columnDef(c.key).byIdOnly), [columns]);
  const visible = useMemo(() => visibleColumns(shown), [shown]);
  const gridTemplate = useMemo(() => gridTemplateColumns(shown), [shown]);
  const contentWidthVar = useMemo(() => contentWidthStyle(shown), [shown]);

  // The open rows as positions, which is how the placement arithmetic
  // asks. Same walk as `openRuns`, read a second way.
  const expandedPositions = useMemo(
    () => (openRuns.length === 0 ? EMPTY_POSITIONS : new Set(openRuns.map((r) => r.index))),
    [openRuns],
  );

  const placements = buildPlacements(firstVisibleRow, count, rows, expandedPositions, contentCount);
  // How tall the rendered rows actually stack. The sticky viewport
  // clips (`overflow: hidden`), so it takes the larger of the panel
  // height and the stack — an expanded row taller than the panel then
  // slides into view as the scroll runs past the sticky element's own
  // height instead of being cut off at the fold. Same rule as
  // `ByIdTable`.
  const lastPlacement = placements[placements.length - 1];
  const stackHeight = lastPlacement ? lastPlacement.top + lastPlacement.height : 0;
  const anySelected = grid.selection.size > 0;

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
      {/* The rows viewport is the gridview container: it holds focus and
          names the active row, because the rows themselves are recycled
          by the paged viewport (ADR 0044). */}
      <div
        ref={containerRef}
        className="trace-rows"
        onScroll={handleScroll}
        {...grid.containerProps}
      >
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
              const frame = r?.row === "frame" ? r.frame : null;
              const rowId = frame ? frameRowId(frame) : null;
              return (
                <Fragment key={posKey}>
                  <Row
                    top={top}
                    // The message line is one row tall; what it
                    // discloses stacks below it as rows of its own, and
                    // the placement's `height` is the block they make
                    // together.
                    height={isExpanded ? ROW_HEIGHT : height}
                    absoluteIndex={absIdx}
                    isExpanded={isExpanded}
                    frame={frame}
                    event={r?.row === "event" ? r.event : null}
                    baseTimestamp={baseTimestampSeconds}
                    idFormat={idFormat}
                    columns={visible}
                    gridTemplate={gridTemplate}
                    busLookup={busLookup}
                    onToggle={toggleExpanded}
                    eventActions={eventActions}
                    // A boolean rather than the focused id, so moving the
                    // focus re-renders the two rows it touches and no others.
                    eventFocused={r?.row === "event" && r.event.id === focusedEvent}
                    onEventFocus={focusEvent}
                    rowDomId={grid.rowDomId}
                    // Deriving the id costs a string per row, so the
                    // common case — nothing selected — never asks.
                    selected={anySelected && grid.selection.has(rowIdOf(r) ?? "")}
                    onSelect={handleRowClick}
                    onDragStart={startRowDrag}
                  />
                  {isExpanded && r?.row === "event" && (
                    <EventBody
                      event={r.event}
                      top={top + ROW_HEIGHT}
                      actions={eventActions}
                      rowDomId={grid.rowDomId}
                    />
                  )}
                  {isExpanded &&
                    rowId != null &&
                    frame?.decoded &&
                    signalsOf(r).map((sig, k) => {
                      const id = contentRowId(rowId, sig.name);
                      return (
                        <DecodedSignalCell
                          key={sig.name}
                          frame={frame}
                          messageName={frame.decoded!.name}
                          sig={sig}
                          resolveColor={resolveColor}
                          top={top + ROW_HEIGHT + k * SIGNAL_LINE_HEIGHT}
                          rowId={id}
                          domId={grid.rowDomId(id)}
                          selected={anySelected && grid.selection.has(id)}
                          onSelect={handleRowClick}
                        />
                      );
                    })}
                </Fragment>
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
  /// Open or shut this row's decoded block, by the row's stable id and
  /// the number of signal lines it discloses.
  onToggle: (rowId: string, signals: number) => void;
  eventActions?: EventActions;
  /// This row is the focused event row (event rows only).
  eventFocused: boolean;
  onEventFocus: (id: string) => void;
  /// The DOM id `aria-activedescendant` names this row by (ADR 0044).
  /// Taken as the layer's stable mapper rather than the finished string
  /// so the memo still skips a row whose id hasn't moved.
  rowDomId: (id: string) => string;
  selected: boolean;
  onSelect: (rowId: string, e: React.MouseEvent) => void;
  /// The row drags its whole message (ADR 0045); the decoded lines
  /// inside it drag one signal each and stop the event there.
  onDragStart: (rowId: string, e: React.DragEvent) => void;
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
  onToggle,
  eventActions,
  eventFocused,
  onEventFocus,
  rowDomId,
  selected,
  onSelect,
  onDragStart,
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
        domId={rowDomId(`${EVENT_ROW_PREFIX}${event.id}`)}
        onSelect={onSelect}
        isExpanded={isExpanded}
        onToggle={onToggle}
      />
    );
  }
  const rowId = frame ? frameRowId(frame) : null;
  const isErrorFrame = frame?.kind.kind === "error";
  // The row is the disclosure control (matching ByIdTable's settled
  // call): a row with no decode has nothing to open, so it reports no
  // expanded state at all rather than a permanent `false`.
  const expandable = frame?.decoded != null && rowId != null;
  return (
    <GridviewRow
      defs={COLUMN_DEFS}
      columns={columns}
      gridTemplate={gridTemplate}
      id={rowId == null ? undefined : rowDomId(rowId)}
      aria-expanded={expandable ? isExpanded : undefined}
      aria-selected={rowId == null ? undefined : selected}
      draggable={rowId != null}
      onDragStart={rowId == null ? undefined : (e) => onDragStart(rowId, e)}
      className={`trace-row ${isExpanded ? "expanded" : ""} ${frame ? "" : "loading"}${
        frame?.violation ? " trace-row-violation" : ""
      }${isErrorFrame ? ` ${ERROR_FRAME_ROW_CLASS}` : ""}${selected ? " selected" : ""}`}
      title={
        frame?.violation
          ? `calculated-field check failed: ${frame.violation}`
          : isErrorFrame
            ? ERROR_FRAME_TITLE
            : undefined
      }
      style={{ position: "absolute", top, left: 0, right: 0, height }}
      onClick={(e) => {
        if (rowId != null) onSelect(rowId, e);
        if (frame?.decoded) onToggle(frameRowId(frame), frame.decoded.signals.length);
      }}
      renderCell={(key, className) => {
        const content = cellContent(
          key,
          frame,
          absoluteIndex,
          baseTimestamp,
          idFormat,
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
    />
  );
});

/// Default color per event kind when an event carries no explicit color
/// (ADR 0035): notes share the plot's event blue; the truncation marker a
/// muted amber; a coalesced bus error a fault red.
const EVENT_KIND_COLOR: Record<string, () => string> = {
  note: () => theme().eventMarker,
  truncation: () => theme().eventTruncation,
  busError: () => theme().eventBusError,
  // A comment is the user's own annotation like a note, so it takes the
  // same default; what distinguishes it is the record it rides, not a hue.
  messageBound: () => theme().eventMarker,
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
  domId,
  onSelect,
  isExpanded,
  onToggle,
}: {
  top: number;
  event: TimelineEvent;
  baseTimestamp: number | null;
  actions?: EventActions;
  focused: boolean;
  onFocus: (id: string) => void;
  /// The DOM id `aria-activedescendant` names this row by. An event row
  /// takes part in the grid's cursor, but not in its selection — it is
  /// not a message (ADR 0044).
  domId: string;
  onSelect: (rowId: string, e: React.MouseEvent) => void;
  /// This row's body is disclosed. The body itself is drawn by the view,
  /// under this row, like a message's decoded signals.
  isExpanded: boolean;
  onToggle: (rowId: string, contentRows: number) => void;
}) {
  // An event with no color of its own takes the theme's. Subscribed
  // here rather than in `Row`: this is the component that resolves the
  // color, and `Row` is behind a `memo` that would swallow a parent
  // re-render anyway.
  useThemeName();
  const color = event.color ?? (EVENT_KIND_COLOR[event.kind] ?? EVENT_KIND_COLOR.note)();
  const editable = event.editable && actions != null;
  const discloses = eventDiscloses(event);
  const onGoto = actions?.onGoto;
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
      id={domId}
      tabIndex={0}
      onClick={(e) => {
        onFocus(event.id);
        onSelect(`${EVENT_ROW_PREFIX}${event.id}`, e);
      }}
    >
      {discloses ? (
        <button
          type="button"
          className="trace-event-disclose"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? "hide event details" : "show event details"}
          title={isExpanded ? "hide the tag and description" : "show the tag and description"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(`${EVENT_ROW_PREFIX}${event.id}`, isExpanded ? 0 : EVENT_BODY_ROWS.length);
          }}
        >
          {isExpanded ? "\u25be" : "\u25b8"}
        </button>
      ) : (
        <span className="trace-event-disclose trace-event-disclose-empty" aria-hidden="true" />
      )}
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
        <ColorChip
          color={color}
          onChange={(hex) => actions?.onRecolor(event.id, hex)}
          swatchClassName="trace-event-swatch"
          inputClassName="trace-event-swatch-input"
          title="pick a color"
          swatchAriaLabel="pick event color"
          pickerAriaLabel="event color"
        />
      ) : (
        <ColorChip color={color} swatchClassName="trace-event-swatch" />
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
              // Consumed here, so the gridview leaves the press alone
              // (ADR 0044): the grid's Escape takes focus back to the
              // container, and this field commits on blur — abandoning
              // the edit would commit the draft being abandoned.
              e.preventDefault();
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

/// The body an open event row discloses (ADR 0035): the user-defined tag
/// the event view filters on, and the description. Two rows of the row space
/// in their own right, like a message's decoded signals, so the keyboard
/// cursor walks into them. Editable in place on a user-authored event; a
/// host-derived one shows what it computed and takes no edits.
function EventBody({
  event,
  top,
  actions,
  rowDomId,
}: {
  event: TimelineEvent;
  top: number;
  actions?: EventActions;
  rowDomId: (id: string) => string;
}) {
  const rowId = `${EVENT_ROW_PREFIX}${event.id}`;
  return (
    <>
      <EventBodyField
        top={top}
        domId={rowDomId(contentRowId(rowId, "tag"))}
        name="tag"
        value={event.tag ?? ""}
        placeholder="no tag"
        ariaLabel="event tag"
        onCommit={
          event.editable && actions?.onRetag
            ? (v) => actions.onRetag?.(event.id, v || null)
            : undefined
        }
      />
      <EventBodyField
        top={top + SIGNAL_LINE_HEIGHT}
        domId={rowDomId(contentRowId(rowId, "description"))}
        name="description"
        value={event.description ?? ""}
        placeholder="no description"
        ariaLabel="event description"
        onCommit={
          event.editable && actions?.onDescribe
            ? (v) => actions.onDescribe?.(event.id, v || null)
            : undefined
        }
      />
    </>
  );
}

/// One disclosed field of an event body. Reads as text until it is clicked,
/// which is the same direct-manipulation shortcut the label uses; a
/// non-editable event renders the text and nothing else.
function EventBodyField({
  top,
  domId,
  name,
  value,
  placeholder,
  ariaLabel,
  onCommit,
}: {
  top: number;
  domId: string;
  name: string;
  value: string;
  placeholder: string;
  ariaLabel: string;
  onCommit?: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  // A virtualized slot is reused for a different event as the view
  // scrolls, so the draft re-seeds whenever the value under it changes.
  useEffect(() => {
    setEditing(false);
    setDraft(value);
  }, [domId, value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit?.(next);
    setEditing(false);
  };
  return (
    <div
      className="trace-event-body-row"
      id={domId}
      style={{ position: "absolute", top, left: 0, right: 0, height: SIGNAL_LINE_HEIGHT }}
    >
      <span className="trace-event-body-name">{name}</span>
      {editing ? (
        <input
          className="trace-event-body-input"
          autoFocus
          aria-label={ariaLabel}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") {
              // Consumed, like the label editor: the grid's Escape would
              // blur this field, and the blur commits.
              e.preventDefault();
              setDraft(value);
              setEditing(false);
            }
          }}
          onBlur={commit}
        />
      ) : (
        <span
          className={`trace-event-body-value${onCommit ? " trace-event-body-editable" : ""}${
            value ? "" : " trace-event-body-placeholder"
          }`}
          title={onCommit ? `click to edit the ${name}` : value}
          onClick={onCommit ? () => setEditing(true) : undefined}
        >
          {value || placeholder}
        </span>
      )}
    </div>
  );
}

// `DecodedSignalCell` is shared with `ByIdTable` — see `DecodedSignalCell.tsx`.
