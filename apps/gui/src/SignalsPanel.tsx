import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import type {
  SignalDescriptorRecord,
  SignalSectionHeaderRecord,
  SignalSectionsWire,
  SignalSelectionWire,
  SignalSnapshotRecord,
} from "./types";
import { sectionHeaderOf, signalOf } from "./types";
import { TraceControls } from "./TraceControls";
import { TraceHeader, contentWidthStyle } from "./traceTable";
import { useTrace } from "./trace";
import { useElementRegistry } from "./projectElements";
import { useProjectContext } from "./projectContext";
import { useSignalCatalog } from "./signalCatalogContext";
import { useSignalView } from "./useSignalView";
import { useTraceViewport } from "./useTraceViewport";
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
import { anchorFromScroll, maxScrollTop, ROW_HEIGHT } from "./traceViewport";
import { useDismissableMenu } from "./useDismissableMenu";
import { toggleInSet } from "./toggleSet";
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

/// The view's user-authored sections: names in creation order, plus the
/// canonical-identity → name assignment map. Project data — persisted on
/// the element with the selection, because it describes what the view
/// *means*. The fold set is deliberately not here: which sections happen
/// to be shut is workspace state and rides the dockview params alone.
interface SectionState {
  names: string[];
  assignments: Record<string, string>;
  patterns: Record<string, string[]>;
}

/// The label the implicit unassigned section wears. Its wire name is the
/// empty string, so it can never collide with a name the user typed.
const UNSECTIONED = "Unsectioned";

/// Stable empty list, so a section with no patterns doesn't hand its
/// header a fresh array every render.
const EMPTY_PATTERNS: string[] = [];

/// Parse the persisted sections from config, tolerating whatever an
/// older or hand-edited blob carries — nothing upstream validates it.
function sectionsFromConfig(raw: unknown): SectionState {
  const o = raw as { names?: unknown; assignments?: unknown; patterns?: unknown } | undefined;
  const names: string[] = [];
  if (Array.isArray(o?.names)) {
    for (const n of o.names) {
      if (typeof n === "string" && n !== "" && !names.includes(n)) names.push(n);
    }
  }
  const assignments: Record<string, string> = {};
  if (o?.assignments != null && typeof o.assignments === "object") {
    // `""` is kept: it is the explicit "unsectioned" assignment, the
    // only thing that can override a section pattern's claim.
    for (const [k, v] of Object.entries(o.assignments as Record<string, unknown>)) {
      if (typeof v === "string") assignments[k] = v;
    }
  }
  const patterns: Record<string, string[]> = {};
  if (o?.patterns != null && typeof o.patterns === "object") {
    for (const [k, v] of Object.entries(o.patterns as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const ps = v.filter((p): p is string => typeof p === "string" && p !== "");
      if (ps.length > 0) patterns[k] = ps;
    }
  }
  return { names, assignments, patterns };
}

/// The next unused `Section N` — the starter name a freshly created
/// section wears until the user types over it in the header editor.
function starterSectionName(names: readonly string[]): string {
  for (let i = 1; ; i++) {
    const candidate = `Section ${i}`;
    if (!names.includes(candidate)) return candidate;
  }
}

/// Read the persisted fold set from the panel params (item 5's idiom):
/// sparse, so a panel nobody folded persists nothing.
function foldedFromParams(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === "string"));
}

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
    | {
        elementId?: unknown;
        selection?: unknown;
        columns?: unknown;
        sections?: unknown;
        folded?: unknown;
      }
    | undefined;
  const [elementId] = useState(() => elementIdFromParams(params));
  useEffect(() => {
    ensure(elementId, "signals");
  }, [ensure, elementId]);
  const [savedConfig] = useState<typeof params>(() => {
    const cfg = (registry.get(elementId)?.element as { config?: typeof params } | undefined)?.config;
    return cfg ?? params;
  });

  // `false`: the signals view reads the window bounds and run state,
  // never a frame row — so it does not page one (ADR 0025).
  const trace = useTrace(elementId, false);

  // The selection (manual keys + patterns) is this view's model input;
  // persisted with the element like other panel config.
  const [selection, setSelection] = useState(() => selectionFromParams(savedConfig?.selection));
  const [columns, setColumns] = useState<SignalColumnState[]>(() =>
    signalColumnsFromParams(savedConfig?.columns),
  );
  const [sort, setSort] = useState<SignalSortState>(DEFAULT_SIGNAL_SORT);
  const onSortColumn = useCallback((key: SignalColumnKey) => {
    // The rows are already grouped by section, and the sort runs
    // *within* each one — so there is no sort-by-section to offer, and
    // showing an arrow that reorders nothing would be a lie.
    if (key === "section") return;
    setSort((s) => nextSort(s, key));
  }, []);
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

  // The view's sections and which of them are shut. The sections are
  // project data and travel with the element; the fold set is workspace
  // state and rides the dockview params only — the same split items 5
  // and 15 made, with the two halves landing in different scopes here
  // because they are different kinds of fact.
  const [sections, setSections] = useState<SectionState>(() =>
    sectionsFromConfig(savedConfig?.sections),
  );
  const [folded, setFolded] = useState<Set<string>>(() => foldedFromParams(params?.folded));
  /// The section whose header is in inline-edit mode. Declared with the
  /// rest of the section state because `createSection` hands a brand-new
  /// section straight to it.
  const [renaming, setRenaming] = useState<string | null>(null);
  const toggleFold = useCallback((name: string) => {
    setFolded((prev) => toggleInSet(prev, name));
  }, []);
  /// Create a section *now*, with a starter name, and hand its header
  /// to the inline editor. Naming it up front put a text box between the
  /// user and a section they could see; this way the section exists the
  /// moment they ask for it and the name is just its first edit.
  /// `assign` moves one signal in at the same time — the row menu's
  /// "new section…" is this operation with a member attached.
  const createSection = useCallback(
    (assign: string | null) => {
      const name = starterSectionName(sections.names);
      setSections((prev) => ({
        ...prev,
        names: [...prev.names, name],
        assignments: assign == null ? prev.assignments : { ...prev.assignments, [assign]: name },
      }));
      setRenaming(name);
    },
    [sections.names],
  );
  const renameSection = useCallback((from: string, raw: string) => {
    const to = raw.trim();
    if (to === "" || to === from) return;
    setSections((prev) => {
      if (prev.names.includes(to)) return prev;
      const assignments: Record<string, string> = {};
      // Members follow the name: an assignment left pointing at the old
      // name would read as unassigned and silently empty the section.
      for (const [k, v] of Object.entries(prev.assignments)) assignments[k] = v === from ? to : v;
      // …and so do the section's own patterns, for the same reason.
      const patterns: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(prev.patterns)) patterns[k === from ? to : k] = v;
      return { names: prev.names.map((n) => (n === from ? to : n)), assignments, patterns };
    });
  }, []);
  const setSectionPatterns = useCallback((name: string, next: string[]) => {
    setSections((prev) => ({ ...prev, patterns: { ...prev.patterns, [name]: next } }));
  }, []);
  /// Delete a section: a `names` edit and nothing else. Its signals fall
  /// back to unassigned (the host resolves an assignment — or a section
  /// pattern — naming no existing section that way) and stay in the
  /// selection; both the assignments and the section's patterns stay
  /// dormant, so re-creating the name restores the whole section — the
  /// same reasoning as retained plot series ids.
  const deleteSection = useCallback((name: string) => {
    setSections((prev) => ({ ...prev, names: prev.names.filter((n) => n !== name) }));
    setFolded((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }, []);
  /// Move one signal. `""` is the implicit section, written explicitly
  /// rather than by deleting the entry: a deleted assignment is
  /// indistinguishable from "never touched", so a section pattern would
  /// simply re-claim the row the user just moved out.
  const assignSignal = useCallback((key: string, name: string) => {
    setSections((prev) => ({ ...prev, assignments: { ...prev.assignments, [key]: name } }));
  }, []);

  // Dual-write the persistable config (element + dockview params), the
  // same pattern as the trace/plot panels. `folded` goes to the params
  // only — it is workspace state, not part of what the view means.
  useEffect(() => {
    const config = { selection, columns, sections };
    update(elementId, { config });
    api.updateParameters({ elementId, ...config, folded: [...folded] });
  }, [api, update, elementId, selection, columns, sections, folded]);

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
  const { catalog } = useSignalCatalog();
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
  // The wire sections: the host orders the rows, emits the header rows
  // and counts fold-aware, so the panel states the structure and holds
  // only the page it gets back.
  const wireSections = useMemo<SignalSectionsWire>(
    () => ({
      names: sections.names,
      assignments: sections.assignments,
      patterns: sections.patterns,
      folded: [...folded],
    }),
    [sections, folded],
  );
  const busNames = useMemo<[string, string][]>(() => buses.map((b) => [b.id, b.name]), [buses]);
  const projectBusIds = useMemo(() => buses.map((b) => b.id), [buses]);

  const view = useSignalView(
    true,
    trace.offset,
    trace.offset + trace.frameCount,
    wireSelection,
    wireSections,
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

  // Section editing surfaces. `renaming` is the section whose header is
  // in edit mode; the move menu and the per-section pattern popover are
  // positioned at the panel root like the sources menu, because a popup
  // inside a row would be clipped by the sticky viewport.
  const [sectionMenu, setSectionMenu] = useState<{
    x: number;
    y: number;
    key: string;
    signalName: string;
    current: string | null;
  } | null>(null);
  const [patternPopover, setPatternPopover] = useState<{ x: number; y: number; name: string } | null>(
    null,
  );
  const openSectionMenu = useCallback(
    (e: React.MouseEvent, key: string, signalName: string, current: string | null) => {
      e.stopPropagation();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setSectionMenu({ x: r.left, y: r.bottom, key, signalName, current });
    },
    [],
  );
  const openPatternPopover = useCallback((e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPatternPopover({ x: r.left, y: r.bottom, name });
  }, []);

  // --- virtualized rows (fixed height, no expansion) ---
  // The scaffold is the shared one (`useTraceViewport`): container
  // measurement, the render window, the spacer and — the part that
  // matters — the *anchor bound*, so this view cannot drift from the
  // chronological and by-id tables the way a hand-rolled copy did.
  // Like `ByIdTable` there is no live tail to pin to: the snapshot is
  // host-sorted, so the anchor only moves when the user scrolls.
  const [anchoredRow, setAnchoredRow] = useState(0);
  const count = view.count;
  const {
    containerRef,
    headerRef,
    viewportHeight,
    rows,
    spacerHeight,
    anchorMax,
    firstVisibleRow,
    lastVisibleRow,
  } = useTraceViewport(count, anchoredRow);
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
    // Read the scaffold's bound rather than re-deriving one: the
    // scroll↔row mapping and the render window have to agree, or the
    // bottom of the scrollbar maps onto a row short of the end.
    setAnchoredRow(
      anchorFromScroll(el.scrollTop, anchorMax, maxScrollTop(count, viewportHeight)),
    );
  }, [anchorMax, count, viewportHeight]);

  const visible = useMemo(() => columns.filter((c) => c.visible), [columns]);
  const gridTemplate = useMemo(() => signalGridTemplateColumns(columns), [columns]);
  const contentWidthVar = useMemo(() => contentWidthStyle(columns), [columns]);
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
      {sectionMenu && (
        <MoveToSectionMenu
          position={sectionMenu}
          signalName={sectionMenu.signalName}
          names={sections.names}
          current={sectionMenu.current}
          onMove={(name) => {
            assignSignal(sectionMenu.key, name);
            setSectionMenu(null);
          }}
          onNewSection={() => {
            createSection(sectionMenu.key);
            setSectionMenu(null);
          }}
          onClose={() => setSectionMenu(null)}
        />
      )}
      {patternPopover && (
        <div
          className="signals-section-patterns"
          style={{ left: patternPopover.x, top: patternPopover.y }}
        >
          <SectionPatternPopover
            name={patternPopover.name}
            patterns={sections.patterns[patternPopover.name] ?? EMPTY_PATTERNS}
            catalog={scopedCatalog}
            busNames={lookup}
            onChange={(next) => setSectionPatterns(patternPopover.name, next)}
            onClose={() => setPatternPopover(null)}
          />
        </div>
      )}
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
        <button
          type="button"
          aria-label="add section"
          title="group this view's signals under a named section"
          onClick={() => createSection(null)}
        >
          + section
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
          headerRef={headerRef}
          defs={SIGNAL_COLUMN_DEFS}
          onColumnResize={handleColumnResize}
          onColumnToggle={handleColumnToggle}
          onColumnReorder={handleColumnReorder}
          sort={sort}
          onSortColumn={onSortColumn}
        />
        <div ref={containerRef} className="trace-rows" onScroll={handleScroll}>
          {/* The scrolled content carries the columns' own width as well
              as the snapshot's extent: the rows are absolutely positioned
              against it inside a viewport that clips, so without it the
              columns past the panel's right edge are unreachable. */}
          <div
            className="trace-scroll-content"
            style={{ height: spacerHeight, position: "relative", ...contentWidthVar }}
          >
            <div style={{ position: "sticky", top: 0, height: viewportHeight, overflow: "hidden" }}>
              {positions.map((abs, i) => {
                const pageRow = view.getRow(abs);
                const header = sectionHeaderOf(pageRow);
                if (header) {
                  return (
                    <SectionHeaderRow
                      key={abs}
                      top={i * ROW_HEIGHT}
                      header={header}
                      folded={folded.has(header.name)}
                      renaming={renaming === header.name}
                      patternCount={(sections.patterns[header.name] ?? EMPTY_PATTERNS).length}
                      onOpenPatterns={(e) => openPatternPopover(e, header.name)}
                      onToggleFold={() => toggleFold(header.name)}
                      onStartRename={() => setRenaming(header.name)}
                      onRename={(next) => {
                        renameSection(header.name, next);
                        setRenaming(null);
                      }}
                      onCancelRename={() => setRenaming(null)}
                      onDelete={() => deleteSection(header.name)}
                    />
                  );
                }
                return (
                  <SignalRow
                    key={abs}
                    top={i * ROW_HEIGHT}
                    row={signalOf(pageRow)}
                    columns={visible}
                    gridTemplate={gridTemplate}
                    baseTimestamp={trace.baseTimestampSeconds}
                    busLookup={lookup}
                    resolveColor={resolveColor}
                    manual={manualKeys}
                    signalColors={signalColors}
                    onSetSignalColor={project.onSetSignalColor}
                    onOpenSectionMenu={openSectionMenu}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/// A section name field. Enter commits, Escape reverts and exits, blur
/// commits, an empty box reverts — the repo's one inline-edit semantic
/// (`EventRow`, the project panel's rename).
function SectionNameInput({
  ariaLabel,
  initial,
  onCommit,
  onCancel,
}: {
  ariaLabel: string;
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const commit = () => {
    if (draft.trim() === "") onCancel();
    else onCommit(draft);
  };
  return (
    <input
      className="signals-section-name-input"
      aria-label={ariaLabel}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={commit}
    />
  );
}

/// One section header, occupying a row slot of its own in the paged row
/// space. The disclosure is item 5's idiom: a `<button aria-expanded>`
/// with an `aria-hidden` glyph swap. The implicit unassigned section
/// (empty name) can be folded but not renamed or deleted — it is not a
/// thing the user made.
function SectionHeaderRow({
  top,
  header,
  folded,
  renaming,
  patternCount,
  onOpenPatterns,
  onToggleFold,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
}: {
  top: number;
  header: SignalSectionHeaderRecord;
  folded: boolean;
  renaming: boolean;
  patternCount: number;
  onOpenPatterns: (e: React.MouseEvent) => void;
  onToggleFold: () => void;
  onStartRename: () => void;
  onRename: (next: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  const label = header.name === "" ? UNSECTIONED : header.name;
  return (
    <div
      className="trace-row signals-section-header"
      style={{ position: "absolute", top, left: 0, right: 0, height: ROW_HEIGHT }}
    >
      <button
        type="button"
        className="trace-disclosure"
        aria-expanded={!folded}
        aria-label={`${label} section`}
        onClick={onToggleFold}
      >
        <span className="hint" aria-hidden="true">
          {folded ? "▸" : "▾"}
        </span>
      </button>
      {renaming ? (
        <SectionNameInput
          ariaLabel="section name"
          initial={header.name}
          onCommit={onRename}
          onCancel={onCancelRename}
        />
      ) : (
        <span className="signals-section-label">{label}</span>
      )}
      <span className="hint">({header.signal_count})</span>
      {header.name !== "" && !renaming && (
        <>
          <button
            type="button"
            aria-label={`patterns for section ${header.name}`}
            title="regex patterns this section collects (bus/ecu/message/signal)"
            onClick={onOpenPatterns}
          >
            /…/{patternCount > 0 ? ` ${patternCount}` : ""}
          </button>
          <button type="button" aria-label={`rename section ${header.name}`} onClick={onStartRename}>
            ✎
          </button>
          <button
            type="button"
            aria-label={`delete section ${header.name}`}
            title="delete this section; its signals stay in the view, unsectioned"
            onClick={onDelete}
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}

/// A section's own pattern list (ADR 0038), in a dismissable popover.
/// The editor is the shared `SignalPatternEditor` the view-level
/// selection uses, so a pattern behaves identically wherever it is
/// typed — the difference is only which selection it belongs to.
function SectionPatternPopover({
  name,
  patterns,
  catalog,
  busNames,
  onChange,
  onClose,
}: {
  name: string;
  patterns: readonly string[];
  catalog: readonly SignalDescriptorRecord[];
  busNames: ReadonlyMap<string, string>;
  onChange: (next: string[]) => void;
  onClose: () => void;
}) {
  const ref = useDismissableMenu<HTMLDivElement>(true, onClose);
  return (
    <div ref={ref} role="group" aria-label={`patterns in ${name}`}>
      <div className="signals-section-patterns-title">{name} patterns</div>
      <SignalPatternEditor
        patterns={patterns}
        catalog={catalog}
        busNames={busNames}
        onChange={onChange}
      />
    </div>
  );
}

/// The per-row move-to-section menu: the existing sections, the way back
/// out to unsectioned, and "new section…". Positioned at the panel root
/// (`position: fixed`) because the rows live in a clipping viewport.
function MoveToSectionMenu({
  position,
  signalName,
  names,
  current,
  onMove,
  onNewSection,
  onClose,
}: {
  position: { x: number; y: number };
  signalName: string;
  names: readonly string[];
  current: string | null;
  onMove: (name: string) => void;
  onNewSection: () => void;
  onClose: () => void;
}) {
  const menuRef = useDismissableMenu<HTMLDivElement>(true, onClose);
  return (
    <div
      ref={menuRef}
      className="signals-section-menu"
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label={`section for ${signalName}`}
    >
      <button
        type="button"
        className={current == null ? "active" : undefined}
        aria-label={`move to ${UNSECTIONED}`}
        onClick={() => onMove("")}
      >
        {UNSECTIONED}
      </button>
      {names.map((n) => (
        <button
          key={n}
          type="button"
          className={current === n ? "active" : undefined}
          aria-label={`move to ${n}`}
          onClick={() => onMove(n)}
        >
          {n}
        </button>
      ))}
      <button type="button" aria-label="new section…" onClick={onNewSection}>
        new section…
      </button>
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
  onOpenSectionMenu: (
    e: React.MouseEvent,
    key: string,
    signalName: string,
    current: string | null,
  ) => void;
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
  onOpenSectionMenu,
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
            title={`${row.signal_name} — drag to a plot; right-click to recolor`}
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
              // Right-click the name opens the native color picker —
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
      case "section":
        // The cell *is* the control. Its own fixed-width column, outside
        // the draggable name cell — the first cut put this button after
        // the (variable-length) signal name in a 220px `overflow:
        // hidden` grid item, where a long name clipped it out of reach.
        return (
          <button
            type="button"
            className="signals-section-pick"
            aria-label={`move ${row.signal_name} to section`}
            title="move this signal to a section"
            onClick={(e) => onOpenSectionMenu(e, key, row.signal_name, row.section ?? null)}
          >
            {row.section ?? "—"}
          </button>
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
            displayHex={row.display_hex}
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
