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
import { EventSubjectChips, SubjectChipView } from "./EventSubjectChips";
import { chipRemovable } from "./notesContext";
import {
  subjectChips,
  subjectIndexFor,
  type SubjectChip,
  type SubjectIndex,
} from "./eventSubjects";
import {
  eventHighlight,
  highlightsMessage,
  hoverEvent,
  useActiveEventIds,
} from "./eventHighlight";
import { useSignalCatalog } from "./signalCatalogContext";
import { Icon } from "./Icon";
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
  /// Every timeline event this view's parent holds, unfiltered — what an
  /// event→event reference resolves against (ADR 0056). A link is stored
  /// once and read from both ends, so a row cannot answer "what am I
  /// linked to" from its own event alone. Must be referentially stable
  /// (the rows are memoised).
  events?: readonly TimelineEvent[];
  /// Let event rows join the grid's selection. Off by default — an event
  /// row is not a message and carries nothing a drop target could take
  /// (ADR 0044) — and on in the events view, whose Link Events control
  /// acts on exactly two selected events (ADR 0056).
  selectableEvents?: boolean;
  /// The selected event ids, whenever they change. Only meaningful with
  /// {@link TraceViewProps.selectableEvents}.
  onEventSelectionChange?: (ids: readonly string[]) => void;
  /// A frame row was right-clicked. Given, the row keeps the event to
  /// itself — `preventDefault` and `stopPropagation`, so a panel-wide
  /// context menu does not also open — and the owner puts up a menu
  /// about that message. Omitted, a right-click bubbles as it always
  /// did, which is what every view showing no frames wants.
  onFrameContextMenu?: (frame: TraceFrameRecord, e: React.MouseEvent) => void;
}

/// Inline mutators for an editable timeline event (ADR 0035), wired by the
/// panel to the host notes commands. A single object so the memoised row
/// takes one stable prop rather than three. `onGoto` is the odd one out: a
/// cross-panel timeline jump keyed by the event's timestamp (not its id),
/// since every panel resolves it against time (ADR 0024). Both views that
/// draw event rows supply it; where it's absent the goto button is hidden
/// and the gridview's Space has nothing to run, and it works on any event
/// (the truncation marker included), not just editable ones.
export interface EventActions {
  onRename: (id: string, label: string) => void;
  onRecolor: (id: string, color: string | null) => void;
  onRemove: (id: string) => void;
  /// Set or clear the disclosed description body (ADR 0035).
  onDescribe?: (id: string, description: string | null) => void;
  /// Set or clear the user-defined tag the event view filters on.
  onRetag?: (id: string, tag: string | null) => void;
  onGoto?: (timestampNs: number) => void;
  /// Drop what one of the event's chips references (ADR 0056) — the
  /// `×` on the chip itself. Absent in a view that does not edit.
  onRemoveChip?: (event: TimelineEvent, chip: SubjectChip) => void;
}

/// Stable ids for the chronological row space (ADR 0044). A frame is
/// named by its **absolute index in the capture**, which does not move
/// as the window slides or as timeline events interleave; an event by
/// its own id. A row whose page has not landed has no identity to
/// offer — the frontend holds one page of a host-owned row space — so
/// the space's ids are exactly the rows it holds.
const FRAME_ROW_PREFIX = "f:";
const EVENT_ROW_PREFIX = "e:";
/// A row an event being acted on is about (ADR 0056). Transient by
/// construction: the class is applied from derived state that is empty
/// whenever nothing is hovered or selected, so the trace at rest carries
/// it nowhere.
export const SUBJECT_ROW_CLASS = "trace-row-subject";
const frameRowId = (frame: TraceFrameRecord) => `${FRAME_ROW_PREFIX}${frame.index}`;
/// The decoded signals a frame row discloses — rows of the space in
/// their own right (ADR 0044), empty for anything that discloses
/// nothing.
function signalsOf(r: TraceRow | null): readonly SignalRecord[] {
  return r?.row === "frame" ? r.frame.decoded?.signals ?? [] : [];
}
/// The rows an event discloses when opened (ADR 0035): its label in
/// full, then its user tag and its description body, each editable in
/// place. Named so their content-row ids are stable across a re-render,
/// like a signal's name.
const EVENT_BODY_ROWS = ["tag", "description"] as const;

/// Characters a body row's value holds before the label needs another
/// row to wrap into. Conservative — a panel narrower than this
/// ellipsises the last line rather than dropping it, and one wider just
/// leaves the reserved space unused.
const LABEL_ROW_CHARS = 60;
/// Rows the label may claim. A label is a one-line name; past four rows
/// of it the body has become the note, and the description field is
/// where prose belongs.
const LABEL_ROW_MAX = 4;

/// How many rows of the body space this event's label needs.
///
/// The label is truncated everywhere it is drawn — the plot marker caps
/// it, the row ellipsises it at whatever width it has — so the body is
/// the one place it is read in full, and it has to be given the height
/// to show it.
export function labelRowCount(label: string): number {
  const wanted = Math.ceil(label.length / LABEL_ROW_CHARS);
  return Math.max(1, Math.min(LABEL_ROW_MAX, wanted));
}

/// The body rows this event discloses. The label's rows lead; a
/// continuation row carries no content of its own, only the id the
/// keyboard cursor names it by, so the wrapped label reads as one field.
/// Keyed off the *stored* subject list rather than off what resolves, so
/// the row geometry does not move when a database is assigned or
/// dropped.
function eventBodyRows(e: TimelineEvent): readonly string[] {
  const label = Array.from({ length: labelRowCount(e.label) }, (_, i) =>
    i === 0 ? "label" : `label:${i + 1}`,
  );
  return e.subjects.length > 0
    ? [...label, "subjects", ...EVENT_BODY_ROWS]
    : [...label, ...EVENT_BODY_ROWS];
}

/// Does this event disclose a body at all? One that carries a tag, a
/// description or a subject does; so does an editable one, which is how
/// an empty note gets given either — and so does one whose label is too
/// long to read on the row, which is the only place a host-derived
/// event's full text can be shown.
function eventDiscloses(e: TimelineEvent): boolean {
  return (
    e.editable ||
    e.description != null ||
    e.tag != null ||
    e.subjects.length > 0 ||
    labelRowCount(e.label) > 1
  );
}

/// How many rows a row discloses when opened — a frame's decoded signals,
/// or an event's body. One notion, because the row heights, the scroll
/// space and the keyboard cursor all have to agree on it.
function contentCountOf(r: TraceRow | null): number {
  if (r?.row === "event") return eventDiscloses(r.event) ? eventBodyRows(r.event).length : 0;
  return signalsOf(r).length;
}

/// The name of the `i`th disclosed row, for its stable content-row id.
function contentNameAt(r: TraceRow | null, i: number): string | null {
  if (r?.row === "event") return eventBodyRows(r.event)[i] ?? null;
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
/// A view whose parent holds no event list — the by-id and frame-only
/// callers. Shared so the memoised rows get the same object each render.
const EMPTY_EVENTS: readonly TimelineEvent[] = [];

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
  events: allEvents = EMPTY_EVENTS,
  selectableEvents = false,
  onEventSelectionChange,
  onFrameContextMenu,
}: TraceViewProps) {
  diagCount("render.TraceView"); // DIAG

  // How the `id` column renders (`can_id_format`). Read through
  // `useSetting` — not `hostSettings()` — because the rows are memoised:
  // a change has to arrive as a *changed prop* or the visible window
  // keeps painting the old format until something else moves.
  const idFormat = useSetting("can_id_format") as CanIdFormat;

  // What the assigned databases can name right now — the one input a
  // subject reference resolves against (ADR 0056). Read once for the
  // whole view and handed to the rows as a prop, so a database being
  // assigned or dropped repaints every chip and nothing else does.
  const { catalog } = useSignalCatalog();
  const subjectIndex = subjectIndexFor(catalog);

  // What acting on an event is lighting up right now (ADR 0056), or
  // `null` — the state the view is in unless a pointer or a selection
  // says otherwise, and the cheap check every row makes. Transient: it
  // is derived from a session-scoped channel and reaches nothing that
  // persists.
  const activeEvents = useActiveEventIds();
  const highlight = useMemo(
    () => eventHighlight(allEvents, activeEvents),
    [allEvents, activeEvents],
  );

  // The open rows, by stable id, each carrying how many decoded signals
  // it discloses. Keyed by id rather than by row position because a
  // display index names a different frame the moment the window slides
  // or an event interleaves (ADR 0044); the signal count rides along
  // because the scroll geometry needs the height of *every* open row,
  // including ones scrolled out of the loaded page, which can no longer
  // be asked. Ephemeral — the chronological rows are capture-scoped.
  const [expanded, setExpanded] = useState<ReadonlyMap<string, number>>(EMPTY_EXPANDED);
  // The event row whose label is being renamed in place (ADR 0035), by
  // event id — not by row position, because the row slots are recycled as
  // the view scrolls. Owned here rather than by the row so the gridview's
  // F2 can begin the edit the row's own button begins (ADR 0044); keying
  // by identity is also what makes a recycled slot drop the edit, with no
  // reset to write. `null` means none.
  const [editingEvent, setEditingEvent] = useState<string | null>(null);
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
      setEditingEvent(null);
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
  const setEventEditing = useCallback(
    (id: string, on: boolean) =>
      setEditingEvent((cur) => (on ? id : cur === id ? null : cur)),
    [],
  );

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
      // could take, so by default it takes part in the cursor but not
      // the selection. A message's disclosed rows are named after it, so
      // they are selectable with it. Which rows are selectable is the
      // adapter's declaration (ADR 0044), and the events view declares
      // its event rows selectable — there the selection is what the
      // Link Events control acts on (ADR 0056).
      isSelectable: (row) =>
        row.id.startsWith(FRAME_ROW_PREFIX) ||
        (selectableEvents && row.id.startsWith(EVENT_ROW_PREFIX)),
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
          if (id == null) continue;
          if (id.startsWith(EVENT_ROW_PREFIX)) {
            if (selectableEvents) out.push(id);
            continue;
          }
          if (!id.startsWith(FRAME_ROW_PREFIX)) continue;
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
      selectableEvents,
      setRowExpanded,
      windowIndexOf,
    ],
  );
  /// The timeline event a row id names, or `null` — for a frame row, or
  /// for an event outside the render window. Resolved by walking the
  /// window, like every other id-keyed lookup here; runs on a key press,
  /// never in the render path.
  const eventOf = useCallback((rowId: string): TimelineEvent | null => {
    if (!rowId.startsWith(EVENT_ROW_PREFIX)) return null;
    const g = geometry.current;
    for (let i = 0; i < g.rows; i++) {
      const abs = g.firstVisibleRow + i;
      if (abs >= g.count) break;
      const r = g.getRow(abs);
      if (r?.row === "event" && `${EVENT_ROW_PREFIX}${r.event.id}` === rowId) return r.event;
    }
    return null;
  }, []);
  // Space is the event row's goto button from the keyboard (ADR 0044's
  // primary action): the same broadcast, so the trace scrolls and every
  // plot re-centres. A frame row has no primary action, and a view that
  // wires no goto has nothing to run.
  const onPrimaryAction = useCallback(
    (id: string) => {
      const goto = eventActions?.onGoto;
      const event = eventOf(id);
      if (goto == null || event == null) return;
      goto(event.timestampNs);
    },
    [eventActions, eventOf],
  );
  // F2 begins the same rename the row's ✎ button begins — and on the
  // same rows. Editability is the gate, not the input device: a derived
  // event shows no rename control to the mouse and must not grow one
  // because the cursor is standing on it (ADR 0035).
  const onRenameAction = useCallback(
    (id: string) => {
      const event = eventOf(id);
      if (event == null || !event.editable || eventActions == null) return;
      setEditingEvent(event.id);
    },
    [eventActions, eventOf],
  );
  // Namespaces this instance's row DOM ids, so two chronological views
  // on screen can't name each other's rows.
  const instanceId = useId();
  const grid = useGridview({
    adapter,
    pageRows: Math.max(1, rows - 2),
    idPrefix: `trace${instanceId}`,
    onPrimaryAction,
    onRenameAction,
  });
  // The events view's Link Events control acts on the grid's selection
  // (ADR 0056); the selection model stays where ADR 0044 put it and this
  // reports it up, rather than the panel keeping a second one. Read
  // through a ref so a parent that rebuilds the callback each render does
  // not re-run the effect.
  const reportSelection = useRef(onEventSelectionChange);
  reportSelection.current = onEventSelectionChange;
  useEffect(() => {
    if (!selectableEvents) return;
    const ids: string[] = [];
    for (const id of grid.selection) {
      if (id.startsWith(EVENT_ROW_PREFIX)) ids.push(id.slice(EVENT_ROW_PREFIX.length));
    }
    reportSelection.current?.(ids);
  }, [grid.selection, selectableEvents]);
  // Ending an inline rename unmounts the field, and focus with nowhere
  // to go lands on the document body — where the grid's keys are dead
  // and the next Tab restarts from the top of the page (ADR 0044). The
  // layer's own recovery cannot see this one: the field is still the
  // focused element while the key is being handled, and only goes away
  // on the render after. So the view takes the keyboard back once the
  // editor is gone, and only where the focus actually went nowhere — a
  // click into another panel ends the edit too, and that focus is the
  // user's.
  const wasEditing = useRef(false);
  useLayoutEffect(() => {
    const editing = editingEvent != null;
    if (
      wasEditing.current &&
      !editing &&
      (document.activeElement == null || document.activeElement === document.body)
    ) {
      containerRef.current?.focus();
    }
    wasEditing.current = editing;
  }, [editingEvent, containerRef]);
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
  /// The row-level right-click, kept ref-stable so a live tick does not
  /// repaint every visible row. `null` when nobody wants it, which is
  /// what leaves the event free to bubble to the panel.
  const frameContextRef = useRef(onFrameContextMenu);
  frameContextRef.current = onFrameContextMenu;
  const handleFrameContextMenu = useCallback(
    (frame: TraceFrameRecord, e: React.MouseEvent) => {
      const handler = frameContextRef.current;
      if (!handler) return;
      e.preventDefault();
      e.stopPropagation();
      handler(frame, e);
    },
    [],
  );
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
                    // Booleans rather than the cursor's / editor's id, so
                    // moving either re-renders the two rows it touches and
                    // no others.
                    eventFocused={
                      r?.row === "event" &&
                      grid.cursor === `${EVENT_ROW_PREFIX}${r.event.id}`
                    }
                    eventEditing={r?.row === "event" && r.event.id === editingEvent}
                    onEventEditing={setEventEditing}
                    events={allEvents}
                    subjectIndex={subjectIndex}
                    selectableEvents={selectableEvents}
                    rowDomId={grid.rowDomId}
                    // Deriving the id costs a string per row, so the
                    // common case — nothing selected — never asks.
                    selected={anySelected && grid.selection.has(rowIdOf(r) ?? "")}
                    // A boolean, not the highlight object, for the same
                    // reason the cursor and the selection are: a hover
                    // then re-renders the rows it lights and no others.
                    // Keyed by what the row *is* — a message identity, an
                    // event id — never by its position in the window.
                    subject={
                      r?.row === "event"
                        ? (highlight?.events.has(r.event.id) ?? false)
                        : frame != null && highlightsMessage(highlight, frame.id, frame.extended)
                    }
                    onSelect={handleRowClick}
                    onDragStart={startRowDrag}
                    onFrameContextMenu={handleFrameContextMenu}
                    frameContextMenu={onFrameContextMenu != null}
                  />
                  {isExpanded && r?.row === "event" && (
                    <EventBody
                      event={r.event}
                      chips={subjectChips(r.event, allEvents, subjectIndex, idFormat)}
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
  /// The gridview cursor is on this row (event rows only). Event rows
  /// are not selectable, so this is the only thing an event row can show
  /// about the grid's state — and what says which row Space and F2 act
  /// on.
  eventFocused: boolean;
  /// This event row's label is being renamed in place (event rows only).
  eventEditing: boolean;
  /// Start or end that rename, by event id.
  onEventEditing: (id: string, on: boolean) => void;
  /// Every event the parent holds — what an event row's link chips
  /// resolve against (ADR 0056).
  events: readonly TimelineEvent[];
  /// What the assigned databases can name, for the subject chips.
  subjectIndex: SubjectIndex;
  /// Event rows take part in the selection in this view.
  selectableEvents: boolean;
  /// The DOM id `aria-activedescendant` names this row by (ADR 0044).
  /// Taken as the layer's stable mapper rather than the finished string
  /// so the memo still skips a row whose id hasn't moved.
  rowDomId: (id: string) => string;
  selected: boolean;
  /// An event being acted on names this row (ADR 0056) — this frame's
  /// message, or this event, is one of its subjects. Transient: it goes
  /// with the hover or the selection that raised it.
  subject: boolean;
  onSelect: (rowId: string, e: React.MouseEvent) => void;
  /// The row drags its whole message (ADR 0045); the decoded lines
  /// inside it drag one signal each and stop the event there.
  onDragStart: (rowId: string, e: React.DragEvent) => void;
  /// Right-click on a frame row, when the view's owner wants one
  /// (ADR 0056). Always given; it is inert unless the owner asked.
  onFrameContextMenu: (frame: TraceFrameRecord, e: React.MouseEvent) => void;
  /// Whether that handler does anything — the row attaches no
  /// `onContextMenu` at all when it does not, so the event bubbles.
  frameContextMenu: boolean;
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
  eventEditing,
  onEventEditing,
  events,
  subjectIndex,
  selectableEvents,
  rowDomId,
  selected,
  subject,
  onSelect,
  onDragStart,
  onFrameContextMenu,
  frameContextMenu,
}: RowProps) {
  // Event rows (truncation marker, notes) render through the same renderer
  // as frames but with their own row layout (ADR 0035).
  if (event) {
    return (
      <EventRow
        top={top}
        event={event}
        chips={subjectChips(event, events, subjectIndex, idFormat)}
        baseTimestamp={baseTimestamp}
        actions={eventActions}
        focused={eventFocused}
        editing={eventEditing}
        onEditing={onEventEditing}
        domId={rowDomId(`${EVENT_ROW_PREFIX}${event.id}`)}
        selectable={selectableEvents}
        selected={selected}
        subject={subject}
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
      onContextMenu={
        frame && frameContextMenu ? (e) => onFrameContextMenu(frame, e) : undefined
      }
      className={`trace-row ${isExpanded ? "expanded" : ""} ${frame ? "" : "loading"}${
        frame?.violation ? " trace-row-violation" : ""
      }${isErrorFrame ? ` ${ERROR_FRAME_ROW_CLASS}` : ""}${selected ? " selected" : ""}${
        subject ? ` ${SUBJECT_ROW_CLASS}` : ""
      }`}
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
/// **Clicking the row puts the grid's cursor on it** — it is a focus target
/// in its own right, and the cursor's row is the one the action keys act on
/// (Space goes to the event, F2 renames it — ADR 0044). Editable events
/// (notes, given `actions`) carry those controls inline: a rename button
/// (which is what turns the label into a field), the swatch (click to recolor,
/// the same native picker the plot uses), and a remove button. Double-clicking
/// the label renames it too, as the direct-manipulation shortcut. Derived
/// events (the truncation marker) render the same shape, focusable but inert.
function EventRow({
  top,
  event,
  chips,
  baseTimestamp,
  actions,
  focused,
  editing,
  onEditing,
  domId,
  selectable,
  selected,
  subject,
  onSelect,
  isExpanded,
  onToggle,
}: {
  top: number;
  event: TimelineEvent;
  /// What the event is about, already resolved against the databases
  /// assigned right now (ADR 0056).
  chips: readonly SubjectChip[];
  baseTimestamp: number | null;
  actions?: EventActions;
  /// The grid's cursor is on this row.
  focused: boolean;
  /// The label is a field rather than text. Owned by the view, so the
  /// gridview's F2 reaches it (ADR 0044) and so a recycled row slot
  /// drops the edit by construction — the state is keyed by event id.
  editing: boolean;
  onEditing: (id: string, on: boolean) => void;
  /// The DOM id `aria-activedescendant` names this row by. An event row
  /// takes part in the grid's cursor, but not in its selection — it is
  /// not a message (ADR 0044) — except in the events view, which
  /// declares them selectable so the Link Events control has something
  /// to act on.
  domId: string;
  /// Event rows take part in this view's selection.
  selectable: boolean;
  selected: boolean;
  /// This event is one an act of highlighting lights up — the one being
  /// acted on, or an event it is linked to (ADR 0056).
  subject: boolean;
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
  const bodyRows = eventBodyRows(event).length;
  const onGoto = actions?.onGoto;
  const onRemoveChip = actions?.onRemoveChip;
  const removeChip = useMemo(
    () =>
      onRemoveChip === undefined
        ? undefined
        : (chip: SubjectChip) => {
            if (chipRemovable(event, chip)) onRemoveChip(event, chip);
          },
    [onRemoveChip, event],
  );
  const [draft, setDraft] = useState(event.label);

  // This is a virtualized row slot: when scrolling reuses it for a different
  // event (or the label changes under us), re-seed the draft from the new
  // label. Any in-progress edit is dropped by the view's own state, which is
  // keyed by event id and so names no row this slot now shows.
  useEffect(() => {
    setDraft(event.label);
  }, [event.id, event.label]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== event.label) actions?.onRename(event.id, next);
    onEditing(event.id, false);
  };

  return (
    <div
      className={`trace-row trace-event-row trace-event-${event.kind}${
        editable ? " trace-event-editable" : ""
      }${focused ? " trace-event-focused" : ""}${selectable && selected ? " selected" : ""}${
        subject ? ` ${SUBJECT_ROW_CLASS}` : ""
      }`}
      style={{ position: "absolute", top, left: 0, right: 0, height: ROW_HEIGHT }}
      title={event.label}
      id={domId}
      // Pointing at an event is acting on it: its subjects light up
      // wherever they are drawn, for exactly as long as the pointer
      // rests here. The channel is session-scoped and view-local —
      // nothing about a hover reaches the host (ADR 0056).
      onMouseEnter={() => hoverEvent(event.id)}
      onMouseLeave={() => hoverEvent(null)}
      // The row is what `aria-activedescendant` names, so the row is
      // where its disclosed state has to be readable — the caret below
      // carries its own, but a cursor on the row never reaches it. Same
      // shape as every other gridview row (ADR 0044): absent, not
      // `false`, where there is nothing to open. `aria-selected` is
      // absent unless this view declares event rows selectable — saying
      // "not selected" about a row that cannot be selected is a lie.
      aria-expanded={discloses ? isExpanded : undefined}
      aria-selected={selectable ? selected : undefined}
      tabIndex={0}
      onClick={(e) => onSelect(`${EVENT_ROW_PREFIX}${event.id}`, e)}
    >
      {discloses ? (
        <button
          type="button"
          className="trace-event-disclose"
          // Out of the tab order, like every other gridview's caret: what
          // it does is already Left/Right's, and Tab into the row must
          // land on a control the keyboard does not otherwise have.
          tabIndex={-1}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? "hide event details" : "show event details"}
          title={isExpanded ? "hide the tag and description" : "show the tag and description"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(`${EVENT_ROW_PREFIX}${event.id}`, isExpanded ? 0 : bodyRows);
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
          <Icon name="goto" />
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
              onEditing(event.id, false);
            }
          }}
          onBlur={commit}
        />
      ) : (
        <span
          className={`trace-event-label${editable ? " trace-event-label-editable" : ""}`}
          title={editable ? "double-click to rename" : undefined}
          onDoubleClick={editable ? () => onEditing(event.id, true) : undefined}
        >
          {event.label}
        </span>
      )}
      {chips.length > 0 && (
        <EventSubjectChips
          chips={chips}
          expanded={isExpanded}
          onExpand={() =>
            onToggle(`${EVENT_ROW_PREFIX}${event.id}`, isExpanded ? 0 : bodyRows)
          }
          onRemoveChip={removeChip}
        />
      )}
      {editable && !editing && (
        <button
          type="button"
          className="trace-event-edit"
          title="rename"
          aria-label="rename event"
          onClick={() => onEditing(event.id, true)}
        >
          <Icon name="edit" />
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
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}

/// The body an open event row discloses (ADR 0035): the label in full,
/// then the user-defined tag the event view filters on, and the
/// description. Rows of the row space in their own right, like a
/// message's decoded signals, so the keyboard cursor walks into them.
/// Editable in place on a user-authored event; a host-derived one shows
/// what it computed and takes no edits.
///
/// The label leads because it is the one thing the row above cannot
/// show: it is capped on the plot marker and ellipsised on the row, so
/// this is where it is read.
function EventBody({
  event,
  chips,
  top,
  actions,
  rowDomId,
}: {
  event: TimelineEvent;
  /// The event's subject chips, already resolved — the same list the row
  /// draws, in full here (ADR 0056). Empty when it is about nothing.
  chips: readonly SubjectChip[];
  top: number;
  actions?: EventActions;
  rowDomId: (id: string) => string;
}) {
  const rowId = `${EVENT_ROW_PREFIX}${event.id}`;
  // The label's rows lead, then the subject line when the event has one,
  // so the `…` control on the row lands the reader on the chips it could
  // not fit.
  const labelRows = labelRowCount(event.label);
  const labelHeight = labelRows * SIGNAL_LINE_HEIGHT;
  const lead = labelRows + (event.subjects.length > 0 ? 1 : 0);
  return (
    <>
      <div
        className="trace-event-body-row"
        id={rowDomId(contentRowId(rowId, "label"))}
        style={{ position: "absolute", top, left: 0, right: 0, height: labelHeight }}
      >
        <span className="trace-event-body-name">label</span>
        <span
          className="trace-event-body-value trace-event-body-wrap"
          style={{ WebkitLineClamp: labelRows }}
          title={event.label}
        >
          {event.label}
        </span>
      </div>
      {/* The continuation rows carry only the ids the keyboard cursor
          names them by — the label above already spans their height, so
          a wrapped label is one field to read and one field to walk. */}
      {Array.from({ length: labelRows - 1 }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          id={rowDomId(contentRowId(rowId, `label:${i + 2}`))}
          style={{
            position: "absolute",
            top: top + (i + 1) * SIGNAL_LINE_HEIGHT,
            left: 0,
            right: 0,
            height: SIGNAL_LINE_HEIGHT,
            pointerEvents: "none",
          }}
        />
      ))}
      {event.subjects.length > 0 && (
        <div
          className="trace-event-body-row"
          id={rowDomId(contentRowId(rowId, "subjects"))}
          style={{
            position: "absolute",
            top: top + labelHeight,
            left: 0,
            right: 0,
            height: SIGNAL_LINE_HEIGHT,
          }}
        >
          <span className="trace-event-body-name">about</span>
          <span className="trace-event-body-subjects">
            {chips.map((chip) => (
              <SubjectChipView
                key={chip.key}
                chip={chip}
                onRemove={
                  actions?.onRemoveChip !== undefined && chipRemovable(event, chip)
                    ? () => actions.onRemoveChip?.(event, chip)
                    : undefined
                }
              />
            ))}
          </span>
        </div>
      )}
      <EventBodyField
        top={top + lead * SIGNAL_LINE_HEIGHT}
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
        top={top + (lead + 1) * SIGNAL_LINE_HEIGHT}
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
