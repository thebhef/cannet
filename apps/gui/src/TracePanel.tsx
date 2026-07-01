import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { TraceView, type EventActions } from "./TraceView";
import { GOTO_EVENT, type GotoPayload } from "./gotoEvent";
import { ByIdTable } from "./ByIdTable";
import { TraceControls } from "./TraceControls";
import { useTraceData } from "./traceData";
import { useTrace, type TraceRow } from "./trace";
import { useNotes } from "./notesContext";
import { timelineEvents } from "./notes";
import { buildEventMerge } from "./eventMerge";
import { useFilteredTrace } from "./useFilteredTrace";
import { useByIdView } from "./useByIdView";
import { useElementRegistry } from "./projectElements";
import { useProjectContext } from "./projectContext";
import { buildSinkPredicate } from "./sinkPredicate";
import { buildColorResolver } from "./colorMap";
import { elementLabel } from "./elementLabel";
import { SourcesContextMenu } from "./SourcesPicker";
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

/// The element id from a panel's params, or a fresh one if absent (a
/// layout saved before elements existed, or a corrupt blob).
function elementIdFromParams(params: unknown): string {
  const p = params as { elementId?: unknown } | undefined;
  return typeof p?.elementId === "string" ? p.elementId : crypto.randomUUID();
}

/**
 * One trace-style panel: a view of one trace *element* (`useTrace`),
 * switchable between **chronological** (one row per frame, virtualized,
 * follows the live edge) and **by ID** (one row per arbitration id with
 * its latest frame; click a column to sort). Both modes share the
 * column layout (resize a divider; right-click a header to show / hide
 * columns) and the trace controls; the element lives in the registry,
 * so closing the panel doesn't destroy it. The mode (default by ID),
 * auto-scroll (chronological), and the column layout are this view's
 * config, persisted on the element (so they survive closing and
 * reopening the panel) and mirrored into the dockview `params`.
 */
export function TracePanel(props: IDockviewPanelProps) {
  diagCount("render.TracePanel"); // DIAG
  const data = useTraceData();
  const registry = useElementRegistry();
  const { ensure } = registry;
  const project = useProjectContext();
  const { api } = props;
  const buses = project.buses;
  const lookup = useMemo(() => busLookup(buses), [buses]);
  // Signal value→color maps (ADR 0029) are ambient: compile every
  // colormap element in the project into one resolver the decoded-signal
  // cells call to tint themselves. Rebuilt only when the element set
  // changes, so the memoised rows aren't churned.
  const resolveColor = useMemo(
    () => buildColorResolver(registry.entries.map((e) => e.element)),
    [registry.entries],
  );

  const params = props.params as
    | {
        elementId?: unknown;
        mode?: unknown;
        autoScroll?: unknown;
        columns?: unknown;
        showEvents?: unknown;
      }
    | undefined;
  const [elementId] = useState(() => elementIdFromParams(params));
  useEffect(() => {
    ensure(elementId, "trace");
  }, [ensure, elementId]);
  // Hydrate the state initializers below from the config persisted on
  // the *element* (survives closing and reopening this panel within a
  // session); fall back to the dockview `params` for older projects and
  // the unsaved-workspace `localStorage` layout. Read once at mount.
  const [savedConfig] = useState<typeof params>(() => {
    const cfg = (registry.get(elementId)?.element as { config?: typeof params } | undefined)?.config;
    return cfg ?? params;
  });

  const [mode, setMode] = useState<TraceMode>(() =>
    savedConfig?.mode === "chronological" ? "chronological" : "by-id",
  );
  const switchMode = useCallback((m: TraceMode) => setMode(m), []);

  const trace = useTrace(data, elementId);

  // Per-panel: auto-scroll (chronological) and the column layout.
  const [autoScroll, setAutoScroll] = useState(() =>
    typeof savedConfig?.autoScroll === "boolean" ? savedConfig.autoScroll : true,
  );
  const handleAutoScrollDisabled = useCallback(() => setAutoScroll(false), []);
  // View-local: whether timeline events (ADR 0035) interleave into this
  // chronological trace. Default on; persisted with the rest of the config.
  const [showEvents, setShowEvents] = useState(() =>
    typeof savedConfig?.showEvents === "boolean" ? savedConfig.showEvents : true,
  );
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

  // Dual-write this panel's persistable state: onto the element (model
  // state — survives closing and reopening the panel within a session,
  // and is what `Save` serializes) and into the dockview `params` (the
  // unsaved-workspace `localStorage` layout restores from `params` on
  // app restart, and it doesn't persist the registry).
  const { update } = registry;
  useEffect(() => {
    const config = { mode, autoScroll, columns, showEvents };
    update(elementId, { config });
    api.updateParameters({ elementId, ...config });
  }, [api, update, elementId, mode, autoScroll, columns, showEvents]);

  // By-id mode state. The snapshot itself is host-paged and host-sorted
  // (see `useByIdView` below); the panel owns only the view-local sort
  // and expand state.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const onSortColumn = useCallback((key: ColumnKey) => setSort((s) => nextSort(s, key)), []);
  const onToggleExpand = useCallback((rowKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);

  // The fetch predicate the host applies before returning rows. Built
  // from the element's `sources` (and any upstream filter's predicate).
  // `null` means "no constraint" — the common case for `sources=["*"]`.
  const element = registry.get(elementId)?.element;
  const fetchFilter = useMemo(() => {
    if (!element) return null;
    return buildSinkPredicate(element, (id) => registry.get(id)?.element);
  }, [element, registry]);
  // Current sources for the picker. `["*"]` is the default when the
  // element is still being healed or has a legacy shape lacking the
  // field — be defensive so the picker never reads from `undefined`.
  const currentSources =
    element &&
    element.kind !== "transmit" &&
    element.kind !== "rbs" &&
    element.kind !== "colormap"
      ? element.sources ?? ["*"]
      : ["*"];
  // Filters available to wire upstream of this trace. Exclude
  // ourselves (a trace can never be its own source) and any other
  // non-filter elements; the cycle guard in `applyElementPatch`
  // protects against pathological selections.
  const availableFilters = useMemo(
    () =>
      registry.entries
        .filter((e) => e.element.kind === "filter")
        .map((e) => ({ id: e.element.id, label: elementLabel(e.element) })),
    [registry.entries],
  );
  const handleSourcesChange = useCallback(
    (next: string[]) => registry.update(elementId, { sources: next }),
    [registry, elementId],
  );
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

  // Chronological + filtered: the shared chunk cache (App.tsx) is
  // global and unfiltered, so when this panel has a filter the
  // chronological view is paged separately, host-side, through
  // `useFilteredTrace` — it holds only the visible page, never the
  // whole filtered set. A `null` `fetchFilter` (the `sources=["*"]`
  // common case) leaves the cheap shared chunk cache in charge.
  const chronoFiltered = mode === "chronological" && fetchFilter != null;
  const filtered = useFilteredTrace(
    chronoFiltered,
    trace.offset,
    trace.offset + trace.frameCount,
    fetchFilter,
    autoScroll && trace.status === "running",
    trace.status === "running",
  );

  // Timeline events (ADR 0035): host notes + the derived truncation marker,
  // the whole (sparse) set. They render in the chronological trace, spliced
  // among the frame rows by timestamp.
  const { notes, renameNote, recolorNote, removeNote } = useNotes();
  const events = useMemo(
    () => timelineEvents(notes, data.truncationTsNs),
    [notes, data.truncationTsNs],
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
  // otherwise stable as frames append (frames arrive in increasing time, so a
  // newer frame never moves an older event's row). `anchors` lags `events` by
  // one async tick; the merge treats a length mismatch as "no events yet"
  // (frames only) until it catches up.
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
  }, [interleave, chronoFiltered, fetchFilter, events, trace.offset, data.epoch]);

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

  // Inline edit handlers for editable event rows (ADR 0035): rename / colour /
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
