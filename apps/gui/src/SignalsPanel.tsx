import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { SignalDescriptorRecord, SignalSelectionWire, SignalSnapshotRecord } from "./types";
import { TraceControls } from "./TraceControls";
import { TraceHeader } from "./traceTable";
import { useTraceData } from "./traceData";
import { useTrace } from "./trace";
import { useElementRegistry } from "./projectElements";
import { useProjectContext } from "./projectContext";
import { useSignalView } from "./useSignalView";
import { busDisplayName, busLookup, nextSort, reorderColumn, resizeColumn, toggleColumn } from "./traceColumns";
import {
  DEFAULT_SIGNAL_SORT,
  SIGNAL_COLUMN_DEFS,
  signalColumnDef,
  signalColumnsFromParams,
  signalGridTemplateColumns,
  type SignalColumnKey,
  type SignalColumnState,
  type SignalSortState,
} from "./signalColumns";
import { formatMsgRate, formatTimestamp } from "./format";
import { buildColorResolver } from "./colorMap";
import { SignalValueCell } from "./SignalValueCell";
import { SignalPatternEditor } from "./SignalPatternEditor";
import { effectiveSourceBuses, resolvePatterns, scopeCatalog } from "./signalSelection";
import { signalKey } from "./plotData";
import { stableSignalColor } from "./palette";
import { elementLabel } from "./elementLabel";
import { SourcesContextMenu } from "./SourcesPicker";
import { Combobox } from "./Combobox";
import {
  SIGNAL_DND_MIME,
  dedupeSignalRefs,
  parseSignalDragData,
  setSignalDragData,
  type DraggableSignalRef,
} from "./dragSignals";
import {
  maxAnchorRow,
  rowFromScroll,
  scaledHeight,
  visibleRowCount,
  ROW_HEIGHT,
} from "./traceViewport";
import { diagCount } from "./diag"; // DIAG

/// The element id from a panel's params, or a fresh one if absent.
function elementIdFromParams(params: unknown): string {
  const p = params as { elementId?: unknown } | undefined;
  return typeof p?.elementId === "string" ? p.elementId : crypto.randomUUID();
}

/// A persisted manual pick. Same fields as `DraggableSignalRef` — the
/// drag payload is the interchange shape for signal identity.
type SelectedKey = DraggableSignalRef;

/// Parse the persisted selection ({keys, patterns}) from config.
function selectionFromParams(raw: unknown): { keys: SelectedKey[]; patterns: string[] } {
  const o = raw as { keys?: unknown; patterns?: unknown } | undefined;
  const keys = Array.isArray(o?.keys)
    ? o.keys.filter(
        (k): k is SelectedKey =>
          k != null &&
          typeof k === "object" &&
          typeof (k as SelectedKey).messageId === "number" &&
          typeof (k as SelectedKey).signalName === "string",
      )
    : [];
  const patterns = Array.isArray(o?.patterns)
    ? o.patterns.filter((p): p is string => typeof p === "string")
    : [];
  return { keys, patterns };
}

const keyOf = (k: { busId: string | null; messageId: number; extended: boolean; signalName: string }) =>
  signalKey(k.busId, k.messageId, k.extended, k.signalName);

/**
 * The signal view panel: the by-id view's per-signal analog. One row
 * per *selected* signal (manual picks + regex patterns over the
 * ADR 0038 canonical path), always present — a signal with no
 * in-window update renders blank rather than disappearing. Values are
 * latest-per-signal within the trace window (mux-aware host-side);
 * Start/Pause/Stop and the window semantics are identical to the trace
 * views. Selection, sort, and paging all run host-side
 * (`fetch_signal_page`); the panel holds only the visible page.
 */
export function SignalsPanel(props: IDockviewPanelProps) {
  diagCount("render.SignalsPanel"); // DIAG
  const data = useTraceData();
  const registry = useElementRegistry();
  const { ensure, update } = registry;
  const project = useProjectContext();
  const { api } = props;
  const buses = project.buses;
  const lookup = useMemo(() => busLookup(buses), [buses]);
  const resolveColor = useMemo(
    () => buildColorResolver(registry.entries.map((e) => e.element)),
    [registry.entries],
  );

  const params = props.params as
    | { elementId?: unknown; selection?: unknown; columns?: unknown }
    | undefined;
  const [elementId] = useState(() => elementIdFromParams(params));
  useEffect(() => {
    ensure(elementId, "signals");
  }, [ensure, elementId]);
  const [savedConfig] = useState<typeof params>(() => {
    const cfg = (registry.get(elementId)?.element as { config?: typeof params } | undefined)?.config;
    return cfg ?? params;
  });

  const trace = useTrace(data, elementId);

  // The selection (manual keys + patterns) is this view's model input;
  // persisted with the element like other panel config.
  const [selection, setSelection] = useState(() => selectionFromParams(savedConfig?.selection));
  const [columns, setColumns] = useState<SignalColumnState[]>(() =>
    signalColumnsFromParams(savedConfig?.columns),
  );
  const [sort, setSort] = useState<SignalSortState>(DEFAULT_SIGNAL_SORT);
  const onSortColumn = useCallback(
    (key: SignalColumnKey) => setSort((s) => nextSort(s, key)),
    [],
  );
  const handleColumnResize = useCallback(
    (key: SignalColumnKey, width: number) => setColumns((cs) => resizeColumn(cs, key, width)),
    [],
  );
  const handleColumnToggle = useCallback(
    (key: SignalColumnKey) => setColumns((cs) => toggleColumn(cs, key)),
    [],
  );
  const handleColumnReorder = useCallback(
    (key: SignalColumnKey, beforeKey: SignalColumnKey | null) =>
      setColumns((cs) => reorderColumn(cs, key, beforeKey)),
    [],
  );

  // Dual-write the persistable config (element + dockview params), the
  // same pattern as the trace/plot panels.
  useEffect(() => {
    const config = { selection, columns };
    update(elementId, { config });
    api.updateParameters({ elementId, ...config });
  }, [api, update, elementId, selection, columns]);

  // Sources wiring (sink node): bounds the catalog, the patterns, and
  // the rows to the buses this view consumes.
  const element = registry.get(elementId)?.element;
  const currentSources =
    element && element.kind !== "transmit" && element.kind !== "rbs" && element.kind !== "colormap"
      ? element.sources ?? ["*"]
      : ["*"];
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
  const [sourcesMenu, setSourcesMenu] = useState<{ x: number; y: number } | null>(null);
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setSourcesMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const sourceBusSet = useMemo(() => {
    const filterSources = new Map<string, readonly string[]>(
      registry.entries
        .filter((e) => e.element.kind === "filter")
        .map((e) => [e.element.id, (e.element as { sources?: string[] }).sources ?? []]),
    );
    return effectiveSourceBuses(currentSources, buses.map((b) => b.id), filterSources);
    // `currentSources` is a fresh array each render; key on its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(currentSources), buses, registry.entries]);
  const sourceBusList = useMemo(
    () => (sourceBusSet == null ? null : [...sourceBusSet]),
    [sourceBusSet],
  );

  // The catalog for the manual picker + pattern match counts, scoped
  // to the view's sources like the plot's.
  const [catalog, setCatalog] = useState<SignalDescriptorRecord[]>([]);
  const refreshCatalog = useCallback(() => {
    void invoke<SignalDescriptorRecord[]>("list_signals", {
      projectBuses: buses.map((b) => b.id),
    }).then(setCatalog);
  }, [buses]);
  useEffect(() => {
    refreshCatalog();
  }, [refreshCatalog, project.dbcPaths]);
  useEffect(() => {
    const un = listen("dbc-changed", refreshCatalog);
    return () => {
      void un.then((fn) => fn());
    };
  }, [refreshCatalog]);
  const scopedCatalog = useMemo(
    () => scopeCatalog(catalog, sourceBusSet),
    [catalog, sourceBusSet],
  );

  // Selection edits.
  const addKeys = useCallback((refs: readonly DraggableSignalRef[]) => {
    if (refs.length === 0) return;
    setSelection((prev) => {
      const have = new Set(prev.keys.map(keyOf));
      const fresh = refs.filter((r) => !have.has(keyOf(r)));
      if (fresh.length === 0) return prev;
      return { ...prev, keys: [...prev.keys, ...fresh.map((r) => ({ ...r }))] };
    });
  }, []);
  const removeKey = useCallback((key: string) => {
    setSelection((prev) => ({ ...prev, keys: prev.keys.filter((k) => keyOf(k) !== key) }));
  }, []);
  const setPatterns = useCallback((patterns: string[]) => {
    setSelection((prev) => ({ ...prev, patterns }));
  }, []);
  /// Convert regex → manual: materialize the patterns' current catalog
  /// matches into explicit picks (one-way), then drop the patterns.
  const materializePatterns = useCallback(() => {
    setSelection((prev) => {
      const have = new Set(prev.keys.map(keyOf));
      const picks = [...prev.keys];
      for (const res of resolvePatterns(prev.patterns, scopedCatalog, lookup)) {
        for (const s of res.matches) {
          const ref: SelectedKey = {
            busId: s.bus_id,
            messageId: s.message_id,
            extended: s.extended,
            signalName: s.signal_name,
            messageName: s.message_name,
            unit: s.unit,
          };
          if (have.has(keyOf(ref))) continue;
          have.add(keyOf(ref));
          picks.push(ref);
        }
      }
      return { keys: picks, patterns: [] };
    });
  }, [scopedCatalog, lookup]);

  // The wire selection: manual keys always; patterns go host-side
  // verbatim (the host validates and surfaces bad ones as `error`).
  const wireSelection = useMemo<SignalSelectionWire>(
    () => ({
      keys: selection.keys.map((k) => ({
        busId: k.busId,
        messageId: k.messageId,
        extended: k.extended,
        signalName: k.signalName,
      })),
      patterns: selection.patterns,
    }),
    [selection],
  );
  const busNames = useMemo<[string, string][]>(() => buses.map((b) => [b.id, b.name]), [buses]);
  const projectBusIds = useMemo(() => buses.map((b) => b.id), [buses]);

  const view = useSignalView(
    true,
    trace.offset,
    trace.offset + trace.frameCount,
    wireSelection,
    sort,
    busNames,
    projectBusIds,
    sourceBusList,
    trace.status === "running",
  );

  // Manual add via the catalog picker (same option shape as the plot).
  const catalogOptions = useMemo(() => {
    const opts = scopedCatalog.map((s) => {
      const busLabel = s.bus_id == null ? null : lookup.get(s.bus_id) ?? s.bus_id;
      const ecu = s.transmitter ?? "(no transmitter)";
      return {
        value: signalKey(s.bus_id, s.message_id, s.extended, s.signal_name),
        path: busLabel ? [busLabel, ecu, s.message_name] : [ecu, s.message_name],
        label: `${s.signal_name}${s.unit ? ` [${s.unit}]` : ""}`,
        desc: s,
      };
    });
    return opts.sort((a, b) => {
      const pa = a.path.join(" ");
      const pb = b.path.join(" ");
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  }, [scopedCatalog, lookup]);
  const handlePick = useCallback(
    (value: string) => {
      const opt = catalogOptions.find((o) => o.value === value);
      if (!opt) return;
      addKeys([
        {
          busId: opt.desc.bus_id,
          messageId: opt.desc.message_id,
          extended: opt.desc.extended,
          signalName: opt.desc.signal_name,
          messageName: opt.desc.message_name,
          unit: opt.desc.unit,
        },
      ]);
    },
    [catalogOptions, addKeys],
  );

  // Drop target: DBC panel / trace / plot signals land in the manual list.
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(SIGNAL_DND_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const { signals } = parseSignalDragData(e.dataTransfer.getData(SIGNAL_DND_MIME));
      if (signals.length === 0) return;
      e.preventDefault();
      addKeys(dedupeSignalRefs(signals));
    },
    [addKeys],
  );

  const [editOpen, setEditOpen] = useState(false);

  // --- virtualized rows (fixed height, no expansion) ---
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [anchoredRow, setAnchoredRow] = useState(0);
  useEffect(() => {
    if (!containerRef.current) return;
    const updateH = () => {
      if (containerRef.current) setViewportHeight(containerRef.current.clientHeight);
    };
    updateH();
    const ro = new ResizeObserver(updateH);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);
  const count = view.count;
  const rows = visibleRowCount(viewportHeight);
  const spacerHeight = scaledHeight(count, viewportHeight);
  const anchorMax = maxAnchorRow(count, viewportHeight);
  const firstVisibleRow = Math.min(anchorMax, Math.max(0, anchoredRow));
  const lastVisibleRow = Math.min(count, firstVisibleRow + rows);
  useEffect(() => {
    if (count === 0) return;
    view.ensureVisible(firstVisibleRow, lastVisibleRow);
  }, [firstVisibleRow, lastVisibleRow, count, view]);
  useEffect(() => {
    if (count === 0) setAnchoredRow(0);
  }, [count]);
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setAnchoredRow(rowFromScroll(el.scrollTop, count, viewportHeight));
  }, [count, viewportHeight]);

  const visible = useMemo(() => columns.filter((c) => c.visible), [columns]);
  const gridTemplate = useMemo(() => signalGridTemplateColumns(columns), [columns]);
  const manualKeys = useMemo(() => new Set(selection.keys.map(keyOf)), [selection.keys]);
  const signalColors = project.signalColors;

  const positions = [];
  for (let i = 0; i < rows; i++) {
    const abs = firstVisibleRow + i;
    if (abs >= count) break;
    positions.push(abs);
  }

  return (
    <div className="trace-panel signals-panel" onContextMenu={handleContextMenu} onDragOver={onDragOver} onDrop={onDrop}>
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
        <Combobox
          className="signals-add"
          options={catalogOptions}
          value=""
          placeholder="add signal…"
          ariaLabel="add signal"
          onChange={handlePick}
        />
        <button
          type="button"
          className={editOpen ? "active" : undefined}
          title="edit this view's selection: manual picks and regex patterns (bus/ecu/message/signal)"
          onClick={() => setEditOpen((v) => !v)}
        >
          selection ({selection.keys.length}
          {selection.patterns.length > 0 ? ` + ${selection.patterns.length} patterns` : ""})
        </button>
        {view.error && (
          <span className="signals-error" role="alert" title={view.error}>
            {view.error}
          </span>
        )}
      </div>
      {editOpen && (
        <div className="signals-selection-editor">
          <SignalPatternEditor
            patterns={selection.patterns}
            catalog={scopedCatalog}
            busNames={lookup}
            onChange={setPatterns}
            onMaterialize={materializePatterns}
          />
          {selection.keys.length > 0 && (
            <div className="signals-manual-list">
              {selection.keys.map((k) => {
                const key = keyOf(k);
                return (
                  <span className="signals-manual-pick" key={key}>
                    <span
                      className="signals-manual-name"
                      style={{ color: signalColors[key] ?? stableSignalColor(key) }}
                    >
                      {k.signalName}
                    </span>
                    <button title="remove from selection" onClick={() => removeKey(key)}>
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div className="trace">
        <TraceHeader<SignalColumnKey>
          columns={columns}
          defs={SIGNAL_COLUMN_DEFS}
          onColumnResize={handleColumnResize}
          onColumnToggle={handleColumnToggle}
          onColumnReorder={handleColumnReorder}
          sort={sort}
          onSortColumn={onSortColumn}
        />
        <div ref={containerRef} className="trace-rows" onScroll={handleScroll}>
          <div style={{ height: spacerHeight, position: "relative" }}>
            <div style={{ position: "sticky", top: 0, height: viewportHeight, overflow: "hidden" }}>
              {positions.map((abs, i) => (
                <SignalRow
                  key={abs}
                  top={i * ROW_HEIGHT}
                  row={view.getRow(abs)}
                  columns={visible}
                  gridTemplate={gridTemplate}
                  baseTimestamp={trace.baseTimestampSeconds}
                  busLookup={lookup}
                  resolveColor={resolveColor}
                  manual={manualKeys}
                  signalColors={signalColors}
                  onSetSignalColor={project.onSetSignalColor}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SignalRowProps {
  top: number;
  row: SignalSnapshotRecord | null;
  columns: readonly SignalColumnState[];
  gridTemplate: string;
  baseTimestamp: number | null;
  busLookup: ReadonlyMap<string, string>;
  resolveColor: ReturnType<typeof buildColorResolver> | null;
  manual: ReadonlySet<string>;
  signalColors: Record<string, string>;
  onSetSignalColor: (key: string, color: string | null) => void;
}

function SignalRow({
  top,
  row,
  columns,
  gridTemplate,
  baseTimestamp,
  busLookup: lookup,
  resolveColor,
  manual,
  signalColors,
  onSetSignalColor,
}: SignalRowProps) {
  const key = row ? signalKey(row.bus_id, row.message_id, row.extended, row.signal_name) : "";
  const nameColor = row ? signalColors[key] ?? stableSignalColor(key) : undefined;
  const colorInputRef = useRef<HTMLInputElement>(null);
  const cell = (c: SignalColumnState): React.ReactNode => {
    if (!row) return null;
    switch (c.key) {
      case "bus":
        return busDisplayName(row.bus_id, lookup);
      case "ecu":
        return row.transmitter ?? "";
      case "msg":
        return row.message_name;
      case "signal":
        return (
          <span
            className="signals-name"
            style={{ color: nameColor }}
            title={`${row.signal_name} — drag to a plot; right-click to recolour`}
            draggable
            onDragStart={(e) => {
              e.stopPropagation();
              setSignalDragData(e, [
                {
                  busId: row.bus_id,
                  messageId: row.message_id,
                  extended: row.extended,
                  signalName: row.signal_name,
                  messageName: row.message_name,
                  unit: row.unit,
                },
              ]);
            }}
            onContextMenu={(e) => {
              // Right-click the name opens the native colour picker —
              // the same affordance as a plot series swatch (ADR 0026).
              e.preventDefault();
              e.stopPropagation();
              colorInputRef.current?.click();
            }}
          >
            {row.signal_name}
            {manual.has(key) ? "" : " ◇"}
            <input
              ref={colorInputRef}
              type="color"
              value={nameColor ?? "#ffffff"}
              style={{ display: "none" }}
              onChange={(e) => onSetSignalColor(key, e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
          </span>
        );
      case "rate":
        return row.rate != null ? formatMsgRate(row.rate) : "";
      case "time":
        return row.time_seconds != null ? formatTimestamp(row.time_seconds, baseTimestamp) : "";
      case "count":
        return row.count != null ? row.count.toLocaleString() : "";
      case "value":
        return (
          <SignalValueCell
            value={row.value}
            unit=""
            label={row.label}
            target={{
              messageId: row.message_id,
              extended: row.extended,
              signalName: row.signal_name,
              busId: row.bus_id,
            }}
            resolveColor={resolveColor}
          />
        );
      case "unit":
        return row.unit;
    }
  };
  return (
    <div
      className={`trace-row ${row ? "" : "loading"}`}
      style={{ position: "absolute", top, left: 0, right: 0, height: ROW_HEIGHT, gridTemplateColumns: gridTemplate }}
    >
      {columns.map((c) => (
        <span key={c.key} className={signalColumnDef(c.key).className}>
          {cell(c)}
        </span>
      ))}
    </div>
  );
}
