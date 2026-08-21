import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { TraceView, type EventActions } from "./TraceView";
import { GOTO_EVENT, type GotoPayload } from "./gotoEvent";
import { ByIdTable } from "./ByIdTable";
import { TraceControls } from "./TraceControls";
import { useTraceModel } from "./traceData";
import { LIVE_TAIL_ROWS, useLiveTailDemand } from "./liveTailDemand";
import { useTrace, type TraceRow } from "./trace";
import { useNotes } from "./notesContext";
import { timelineEvents } from "./notes";
import { buildEventMerge } from "./eventMerge";
import { useFilteredTrace } from "./useFilteredTrace";
import { useByIdView } from "./useByIdView";
import { useProjectContext } from "./projectContext";
import { buildSinkPredicate } from "./sinkPredicate";
import { buildColorResolver } from "./colorMap";
import { SourcesContextMenu } from "./SourcesPicker";
import { useElementPanel, useElementRehydrate, useElementSources } from "./useElementPanel";
import { hostSettings } from "./hostSettings";
import { toggleInSet } from "./toggleSet";
import {
  type ColumnKey,
  type ColumnState,
  type SortState,
  DEFAULT_SORT,
  busLookup,
  columnsFromParams,
  nextSort,
  reorderColumn,
  resizeColumn,
  toggleColumn,
} from "./traceColumns";
import { diagCount } from "./diag"; // DIAG

type TraceMode = "chronological" | "by-id";

/// Narrow a persisted / configured mode name to a `TraceMode`. The host
/// already refuses an unknown `trace_mode`, but a panel's own saved
/// config is an old project file and gets the same tolerant treatment
/// the rest of the parse does: anything unrecognised reads as by-ID.
function traceMode(value: unknown): TraceMode {
  return value === "chronological" ? "chronological" : "by-id";
}

/// This panel's persisted view config: the mode, auto-scroll,
/// column layout, events toggle, and the by-id rows left open — see
/// {@link useElementPanel}.
interface TraceConfig {
  [key: string]: unknown;
  mode?: unknown;
  autoScroll?: unknown;
  columns?: unknown;
  showEvents?: unknown;
  expanded?: unknown;
}

/// Read the persisted by-id fold set, tolerating whatever an older or
/// hand-edited layout carries — the params blob is round-tripped
/// opaquely, so nothing upstream validates it.
function expandedFromConfig(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === "string"));
}

// The three settings-seeded fields, read the same way whether the panel
// is seeding itself at mount or resyncing from a rewritten config: a
// config that doesn't carry the field falls back to the view default.
const modeFromConfig = (c: TraceConfig | undefined): TraceMode =>
  traceMode(c?.mode ?? hostSettings().trace_mode);
const autoScrollFromConfig = (c: TraceConfig | undefined): boolean =>
  typeof c?.autoScroll === "boolean" ? c.autoScroll : hostSettings().trace_auto_scroll;
const showEventsFromConfig = (c: TraceConfig | undefined): boolean =>
  typeof c?.showEvents === "boolean" ? c.showEvents : hostSettings().trace_show_events;

/**
 * One trace-style panel: a view of one trace *element* (`useTrace`),
 * switchable between **chronological** (one row per frame, virtualized,
 * follows the live edge) and **by ID** (one row per arbitration id with
 * its latest frame; click a column to sort). Both modes share the
 * column layout (resize a divider; right-click a header to show / hide
 * columns) and the trace controls; the element lives in the registry,
 * so closing the panel doesn't destroy it. The mode, auto-scroll
 * (chronological), the events overlay, the column layout, and the by-id
 * rows left open are this view's config, persisted on the element (so
 * they survive closing and reopening the panel) and mirrored into the
 * dockview `params`. A panel
 * with none of them yet — a brand-new one — seeds them from the
 * `trace_mode` / `trace_auto_scroll` / `trace_show_events` settings.
 */
export function TracePanel(props: IDockviewPanelProps) {
  diagCount("render.TracePanel"); // DIAG
  const model = useTraceModel();
  const project = useProjectContext();
  const buses = project.buses;
  const lookup = useMemo(() => busLookup(buses), [buses]);
  const panel = useElementPanel<TraceConfig>(props, "trace");
  const { elementId, registry, element, savedConfig, persist } = panel;
  // Signal value→color maps (ADR 0029) are ambient: compile every
  // colormap element in the project into one resolver the decoded-signal
  // cells call to tint themselves. Rebuilt only when the element set
  // changes, so the memoised rows aren't churned.
  const resolveColor = useMemo(
    () => buildColorResolver(registry.entries.map((e) => e.element)),
    [registry.entries],
  );

  // The three view defaults (`trace_mode`, `trace_auto_scroll`,
  // `trace_show_events`) are read *here* and nowhere else — once, as
  // this panel seeds its state. A panel that already carries the value
  // keeps it, and a later change to a default leaves open panels alone.
  const [mode, setMode] = useState<TraceMode>(() => modeFromConfig(savedConfig));
  const switchMode = useCallback((m: TraceMode) => setMode(m), []);

  // Per-panel: auto-scroll (chronological) and the column layout.
  const [autoScroll, setAutoScroll] = useState(() => autoScrollFromConfig(savedConfig));
  const handleAutoScrollDisabled = useCallback(() => setAutoScroll(false), []);
  // View-local: whether timeline events (ADR 0035) interleave into this
  // chronological trace. Persisted with the rest of the config.
  const [showEvents, setShowEvents] = useState(() => showEventsFromConfig(savedConfig));
  const [columns, setColumns] = useState<ColumnState[]>(() => columnsFromParams(savedConfig?.columns));
  const handleColumnResize = useCallback(
    (key: ColumnKey, width: number) => setColumns((cs) => resizeColumn(cs, key, width)),
    [],
  );
  const handleColumnToggle = useCallback(
    (key: ColumnKey) => setColumns((cs) => toggleColumn(cs, key)),
    [],
  );
  const handleColumnReorder = useCallback(
    (key: ColumnKey, beforeKey: ColumnKey | null) =>
      setColumns((cs) => reorderColumn(cs, key, beforeKey)),
    [],
  );

  // By-id mode state. The snapshot itself is host-paged and host-sorted
  // (see `useByIdView` below); the panel owns only the view-local sort
  // and expand state.
  //
  // The fold set is persisted with the rest of the config, sparsely: a
  // by-id row defaults to collapsed, so what is stored is the ids of
  // the rows that are *open*. They are `byIdRowKey`s (bus + id +
  // std/ext), so a fold survives a re-sort, a new id appearing above
  // it, and the panel being closed and reopened.
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    expandedFromConfig(savedConfig?.expanded),
  );
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const onSortColumn = useCallback((key: ColumnKey) => setSort((s) => nextSort(s, key)), []);
  const onToggleExpand = useCallback((rowKey: string) => {
    setExpanded((prev) => toggleInSet(prev, rowKey));
  }, []);

  // …and re-read the same fields when the element's config is rewritten
  // by anyone else — the mirror image of the seeding above.
  useElementRehydrate(panel, (config) => {
    setMode(modeFromConfig(config));
    setAutoScroll(autoScrollFromConfig(config));
    setShowEvents(showEventsFromConfig(config));
    setColumns(columnsFromParams(config.columns));
    setExpanded(expandedFromConfig(config.expanded));
  });

  // Dual-write this panel's persistable state (mode, auto-scroll,
  // column layout, events toggle, the open by-id rows) onto the element
  // and into the dockview params — see `useElementPanel`'s `persist`.
  useEffect(() => {
    persist({ mode, autoScroll, columns, showEvents, expanded: [...expanded] });
  }, [persist, mode, autoScroll, columns, showEvents, expanded]);

  // The fetch predicate the host applies before returning rows. Built
  // from the element's `sources` (and any upstream filter's predicate).
  // `null` means "no constraint" — the common case for `sources=["*"]`.
  const fetchFilter = useMemo(() => {
    if (!element) return null;
    return buildSinkPredicate(element, (id) => registry.get(id)?.element);
  }, [element, registry]);
  const { currentSources, availableFilters, handleSourcesChange } = useElementSources(
    registry,
    elementId,
    element,
  );

  // Chronological + filtered rows come from `useFilteredTrace`, and by-id
  // rows from `useByIdView`; only the *unfiltered* chronological table
  // reads `trace.getFrame`. Everywhere else the window's bounds and run
  // state are all this panel wants, so it doesn't page rows (ADR 0025).
  const chronoFiltered = mode === "chronological" && fetchFilter != null;
  const trace = useTrace(elementId, mode === "chronological" && !chronoFiltered);
  // Right-click anywhere in the trace panel opens the sources
  // context menu at the cursor. The menu owns its own outside-click
  // / Escape dismissal.
  const [sourcesMenu, setSourcesMenu] = useState<{ x: number; y: number } | null>(null);
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setSourcesMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // By-id: the host-paged, host-sorted snapshot of the window
  // `[offset, offset + frameCount)`. Paged through the same windowed
  // primitive as the chronological views — it holds only the visible
  // page and does no sorting (host-side). The host applies `fetchFilter`
  // before returning, so unchecking a bus in the source picker drops its
  // frames here. `busNames` lets the host sort the "bus" column by the
  // project name the user sees. Bounding to `offset + frameCount` keeps a
  // paused / stopped snapshot reflecting the window, not the live tip.
  const busNames = useMemo<[string, string][]>(
    () => buses.map((b) => [b.id, b.name]),
    [buses],
  );
  const byId = useByIdView(
    mode === "by-id",
    trace.offset,
    trace.offset + trace.frameCount,
    sort,
    fetchFilter,
    busNames,
    trace.status === "running",
  );

  // Chronological + filtered: `useTrace`'s window is unfiltered, so when
  // this panel has a filter the chronological view is paged separately,
  // host-side, through `useFilteredTrace` — it holds only the visible
  // page, never the whole filtered set. A `null` `fetchFilter` (the
  // `sources=["*"]` common case) leaves the plain window in charge.
  const filtered = useFilteredTrace(
    chronoFiltered,
    trace.offset,
    trace.offset + trace.frameCount,
    fetchFilter,
    autoScroll && trace.status === "running",
    trace.status === "running",
  );

  // The live tail exists for exactly this case: an unfiltered
  // chronological table auto-scrolling a running capture overlays it so
  // the live edge never shows a placeholder between re-pages. Declare the
  // demand so the host does the collect + decode only while someone reads
  // it — every other mode, and a parked or stopped one, wants none.
  useLiveTailDemand(
    elementId,
    mode === "chronological" && !chronoFiltered && autoScroll && trace.status === "running"
      ? LIVE_TAIL_ROWS
      : 0,
  );

  // Timeline events (ADR 0035): host notes + the derived truncation marker,
  // the whole (sparse) set. They render in the chronological trace, spliced
  // among the frame rows by timestamp.
  const { notes, renameNote, recolorNote, removeNote } = useNotes();
  const events = useMemo(
    () => timelineEvents(notes, model.truncationTsNs),
    [notes, model.truncationTsNs],
  );

  // Interleave events into the chronological view when the view-local toggle
  // is on — for both the unfiltered and the filtered chronological trace.
  const interleave = mode === "chronological" && showEvents;
  const baseCount = chronoFiltered ? filtered.count : trace.frameCount;
  const baseGetFrame = chronoFiltered ? filtered.getFrame : trace.getFrame;
  const baseEnsureVisible = chronoFiltered ? filtered.ensureVisible : trace.ensureVisible;

  // The host anchors each event to a row in this view's index space (the host
  // owns time→index, ADR 0024). For the unfiltered trace that's an absolute
  // frame index (`frame_indices_at_ns`); for a filtered trace it's a
  // window-local match position (`filtered_positions_at_ns`, which maps the
  // event's frame through the active filter index, ADR 0002 DS-3) — the raw
  // frame anchors don't index the filtered stream. We refetch when the event
  // set, the filter, or the window start changes; an event's anchor is
  // otherwise stable as frames append. Not because frames arrive in time order
  // — they do not, a multi-bus capture interleaves deliveries (ADR 0024) — but
  // because the anchor is the *first* row at or after the event, and appending
  // to the end cannot put a row in front of one that already qualified.
  // `anchors` lags `events` by one async tick; the merge treats a length
  // mismatch as "no events yet" (frames only) until it catches up.
  const [anchors, setAnchors] = useState<number[]>([]);
  useEffect(() => {
    let live = true;
    const ts = events.map((e) => e.timestampNs);
    if (!interleave || ts.length === 0) {
      setAnchors([]);
      return;
    }
    const pending = chronoFiltered
      ? invoke<number[]>("filtered_positions_at_ns", {
          filter: fetchFilter,
          scanStart: trace.offset,
          timestamps: ts,
        })
      : invoke<number[]>("frame_indices_at_ns", { timestamps: ts });
    void pending
      .then((a) => {
        if (live) setAnchors(a);
      })
      .catch(() => {
        /* best effort — interleaving just stays off until it resolves */
      });
    return () => {
      live = false;
    };
  }, [interleave, chronoFiltered, fetchFilter, events, trace.offset, model.epoch]);

  // The merge places each event at `anchor - offset`. Unfiltered anchors are
  // absolute frame indices, so the offset is the window start; filtered
  // anchors are already window-local match positions, so the offset is zero.
  const mergeOffset = chronoFiltered ? 0 : trace.offset;
  const merge = useMemo(
    () =>
      buildEventMerge(
        interleave ? events : [],
        interleave && anchors.length === events.length ? anchors : [],
        mergeOffset,
        baseCount,
      ),
    [interleave, events, anchors, mergeOffset, baseCount],
  );
  // Base-typed rows (ADR 0035) for TraceView's one renderer: an event, or a
  // frame (resolved through the windowed query at its local index). Inner
  // frame / event refs are ref-stable, so Row's memo still holds.
  const chronoGetRow = useCallback(
    (d: number): TraceRow | null => {
      const r = merge.rowAt(d);
      if (r.row === "event") return { row: "event", event: r.event };
      const f = baseGetFrame(r.localIndex);
      return f ? { row: "frame", frame: f } : null;
    },
    [merge, baseGetFrame],
  );
  const chronoEnsureVisible = useCallback(
    (d0: number, d1: number) => {
      const [f0, f1] = merge.frameRange(d0, d1);
      baseEnsureVisible(f0, f1);
    },
    [merge, baseEnsureVisible],
  );

  // Inline edit handlers for editable event rows (ADR 0035): rename / color /
  // remove, wired straight to the host notes commands. Memoised (the row is
  // memoised) — the dispatchers are themselves stable.
  const eventActions = useMemo<EventActions>(
    () => ({ onRename: renameNote, onRecolor: recolorNote, onRemove: removeNote }),
    [renameNote, recolorNote, removeNote],
  );

  // Cross-panel "goto" (ADR 0035): a broadcast carries an event's absolute
  // timestamp; the chronological view resolves it to a display row and scrolls
  // there. The resolver reads its inputs (window, filter, merge) through a ref
  // so the listener subscribes once instead of re-subscribing as those churn
  // each frame. Only the chronological mode has rows to scroll.
  const [scrollTarget, setScrollTarget] = useState<{ row: number; seq: number } | null>(null);
  const gotoSeq = useRef(0);
  const gotoCtx = useRef({ mode, chronoFiltered, fetchFilter, offset: trace.offset, mergeOffset, merge });
  gotoCtx.current = { mode, chronoFiltered, fetchFilter, offset: trace.offset, mergeOffset, merge };
  useEffect(() => {
    let live = true;
    const unlisten = listen<GotoPayload>(GOTO_EVENT, async (e) => {
      const ctx = gotoCtx.current;
      if (ctx.mode !== "chronological") return;
      const anchors = ctx.chronoFiltered
        ? await invoke<number[]>("filtered_positions_at_ns", {
            filter: ctx.fetchFilter,
            scanStart: ctx.offset,
            timestamps: [e.payload],
          })
        : await invoke<number[]>("frame_indices_at_ns", { timestamps: [e.payload] });
      if (!live) return;
      const abs = anchors[0];
      if (abs == null) return;
      // Re-read the ref post-await — the window may have advanced while the
      // host resolved the anchor; map against the live merge.
      const c = gotoCtx.current;
      setScrollTarget({ row: c.merge.frameToDisplay(abs - c.mergeOffset), seq: ++gotoSeq.current });
    });
    return () => {
      live = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="trace-panel" onContextMenu={handleContextMenu}>
      {sourcesMenu && (
        <SourcesContextMenu
          position={sourcesMenu}
          value={currentSources}
          buses={buses}
          filters={availableFilters}
          onChange={handleSourcesChange}
          onClose={() => setSourcesMenu(null)}
        />
      )}
      <div className="trace-panel-toolbar">
        <TraceControls
          status={trace.status}
          onStart={trace.start}
          onStop={trace.stop}
          onPause={trace.pause}
          onResume={trace.resume}
          onClear={trace.clear}
        />
        <span className="mode-toggle">
          <button
            type="button"
            className={mode === "chronological" ? "active" : undefined}
            onClick={() => switchMode("chronological")}
          >
            trace
          </button>
          <button
            type="button"
            className={mode === "by-id" ? "active" : undefined}
            onClick={() => switchMode("by-id")}
          >
            by&nbsp;ID
          </button>
        </span>
        {mode === "chronological" && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            auto-scroll
          </label>
        )}
        {mode === "chronological" && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={showEvents}
              onChange={(e) => setShowEvents(e.target.checked)}
            />
            events
          </label>
        )}
      </div>
      {mode === "by-id" ? null : (
        <TraceView
          count={merge.displayCount}
          version={chronoFiltered ? filtered.version : trace.version}
          autoScroll={autoScroll && trace.status === "running"}
          baseTimestampSeconds={trace.baseTimestampSeconds}
          columns={columns}
          onColumnResize={handleColumnResize}
          onColumnToggle={handleColumnToggle}
          onColumnReorder={handleColumnReorder}
          busLookup={lookup}
          resolveColor={resolveColor}
          getRow={chronoGetRow}
          ensureVisible={chronoEnsureVisible}
          onAutoScrollDisabled={handleAutoScrollDisabled}
          eventActions={eventActions}
          scrollTarget={scrollTarget}
        />
      )}
      {mode === "by-id" && (
        <ByIdTable
          count={byId.count}
          version={byId.version}
          getRow={byId.getRow}
          ensureVisible={byId.ensureVisible}
          columns={columns}
          onColumnResize={handleColumnResize}
          onColumnToggle={handleColumnToggle}
          onColumnReorder={handleColumnReorder}
          resolveColor={resolveColor}
          sort={sort}
          onSortColumn={onSortColumn}
          baseTimestamp={trace.baseTimestampSeconds}
          busLookup={lookup}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
        />
      )}
    </div>
  );
}
