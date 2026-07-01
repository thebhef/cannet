import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { DockviewReact, themeAbyss } from "dockview";
import type { AddPanelOptions, DockviewApi, DockviewReadyEvent } from "dockview";

import type {
  Bus,
  DbcInfo,
  DbcRef,
  InterfaceBinding,
  LocalVirtualBusDef,
  LogFinished,
  OpenLogResult,
  Project,
  ProjectElement,
  ProjectElementKind,
  RbsDirtyRecord,
  RemoteSessionResult,
  TraceFrameRecord,
  TraceGrew,
} from "./types";
import {
  PROJECT_SCHEMA_VERSION,
  isLocalBinding,
  localVbusId,
  resolveServer,
} from "./types";
import { useSidecarStatus } from "./sidecarStatus";
import { projectDir, resolveProjectPath } from "./projectPaths";
import { TitleBar } from "./TitleBar";
import { TracePanel } from "./TracePanel";
import { ProjectPanel } from "./ProjectPanel";
import { ProjectGraphPanel } from "./ProjectGraphPanel";
import { PlotPanel } from "./PlotPanel";
import { TransmitPanel } from "./TransmitPanel";
import { RbsPanel } from "./RbsPanel";
import { ColorMapPanel } from "./ColorMapPanel";
import { SystemMessagesPanel } from "./SystemMessagesPanel";
import { DbcPanel } from "./DbcPanel";
import { SystemLogContext, type SystemLogContextValue } from "./systemLogContext";
import {
  mergeSystemMessage,
  reconcileSnapshot,
  unreadWarnOrError,
} from "./systemLog";
import { NotesContext, type NotesContextValue } from "./notesContext";
import type { Note } from "./notes";
import { sortNotesChronologically } from "./notes";
import {
  loadRecentBlfs,
  recordRecentBlf,
  forgetRecentBlf,
  saveRecentBlfs,
} from "./recentBlfs";
import type { SystemMessage } from "./types";
import { TraceDataContext, type TraceData } from "./traceData";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { CloseConfirmModal, type CloseChoice } from "./CloseConfirmModal";
import { BlfChannelMapModal } from "./BlfChannelMapModal";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
  applyElementPatch,
  isProjectElement,
  normalizeElement,
} from "./projectElements";
import {
  type TraceState,
  clearTraceStartOffset,
  clearedTrace,
  freshTrace,
  reanchorToSession,
} from "./trace";
import { defaultBusColor } from "./busColor";
import { assignDefaultNames, defaultElementName, elementLabel } from "./elementLabel";
import {
  BY_ID_PANEL_COMPONENT,
  DBC_PANEL_COMPONENT,
  DBC_PANEL_ID,
  LAST_PROJECT_KEY,
  LAYOUT_STORAGE_KEY,
  PLOT_PANEL_COMPONENT,
  PROJECT_GRAPH_PANEL_COMPONENT,
  PROJECT_GRAPH_PANEL_ID,
  PROJECT_PANEL_COMPONENT,
  PROJECT_PANEL_ID,
  COLORMAP_PANEL_COMPONENT,
  RBS_PANEL_COMPONENT,
  SYSTEM_MESSAGES_PANEL_COMPONENT,
  SYSTEM_MESSAGES_PANEL_ID,
  TRACE_PANEL_COMPONENT,
  TRANSMIT_PANEL_COMPONENT,
  panelKindForFocus,
  parseSavedLayout,
  validateLayout,
} from "./dockLayout";
import {
  COMMANDS,
  PARSED_BINDINGS,
  commandsAvailableIn,
  type CommandContext,
} from "./commands";
import {
  dispatchStroke,
  formatChord,
  isEditableTarget,
  isMacPlatform,
  type KeyStroke,
} from "./keybindings";
import { PaletteModal, type PaletteItem } from "./PaletteModal";
import {
  loadRecentCommands,
  recordRecentCommand,
  saveRecentCommands,
  sortRecentFirst,
} from "./recentCommands";
import {
  PanelCommandsContext,
  createPanelCommandRegistry,
} from "./panelCommands";
import {
  beginDiagCapture,
  diagCount,
  diagGauge,
  endDiagCapture,
  startDiagReporter,
} from "./diag"; // DIAG

// BLF + global error state. Remote sessions are tracked separately
// (multi-server: one entry per address in `remoteSessions`).
type LogState =
  | { kind: "idle" }
  | { kind: "loading"; result: OpenLogResult }
  | { kind: "running"; result: OpenLogResult }
  | { kind: "done"; result: OpenLogResult; total: number }
  | { kind: "error"; message: string };

type RemoteStatus =
  | { kind: "connecting" }
  | { kind: "running"; result: RemoteSessionResult }
  | { kind: "error"; message: string };

// Self-driving perf automation config, served by the host's
// `diag_autostart` command from the launch flags (ADR 0031). `null` for
// a normal launch. Field names mirror the host's camelCase serialization.
// Every field is optional in effect: `--project` alone just opens the
// project; adding `connectOnStart` connects; adding `captureSecs` records
// for that span, writes `out`, and exits.
type AutomationConfig = {
  project: string | null;
  connectOnStart: boolean;
  captureSecs: number | null;
  out: string | null;
  label: string | null;
};

// How long to let the connected session settle before bracketing a
// capture — connect clears the buffer and the rest-of-bus simulation
// spins up, so the first second or two isn't representative.
const AUTOMATION_SETTLE_MS = 2000;
// Cap on waiting for connect preconditions (bindings loaded; sidecar
// ready for a local binding) before giving up on the auto-connect.
const AUTOMATION_READY_TIMEOUT_MS = 30000;

/// Number of frames per cache chunk. Each chunk is fetched in one
/// IPC round-trip; smaller = more fetches but cheaper each, larger =
/// fewer fetches but each is bigger.
const CHUNK_SIZE = 500;
/// LRU budget for the chunk cache. 120 chunks * 500 frames = 60 k
/// rows cached, plenty to cover the viewport plus scroll prefetch
/// even at high scroll velocities.
const CACHE_CHUNKS = 120;

/// Dockview panel-component registry, defined at module scope so
/// dockview never sees a fresh object and re-registers. The
/// chronological and per-id views are one component now (`TracePanel`,
/// mode is the trace element's `view`); the old `"by-id"` name maps to
/// it too so layouts saved before the merge still restore.
const DOCK_COMPONENTS = {
  [TRACE_PANEL_COMPONENT]: TracePanel,
  [BY_ID_PANEL_COMPONENT]: TracePanel,
  [PROJECT_PANEL_COMPONENT]: ProjectPanel,
  [PLOT_PANEL_COMPONENT]: PlotPanel,
  [TRANSMIT_PANEL_COMPONENT]: TransmitPanel,
  [RBS_PANEL_COMPONENT]: RbsPanel,
  [COLORMAP_PANEL_COMPONENT]: ColorMapPanel,
  [PROJECT_GRAPH_PANEL_COMPONENT]: ProjectGraphPanel,
  [SYSTEM_MESSAGES_PANEL_COMPONENT]: SystemMessagesPanel,
  [DBC_PANEL_COMPONENT]: DbcPanel,
};

export function App() {
  diagCount("render.App"); // DIAG
  useEffect(() => startDiagReporter(), []); // DIAG
  const [count, setCount] = useState(0);
  const [framesPerSecond, setFramesPerSecond] = useState(0);
  const [bufferSeconds, setBufferSeconds] = useState(0);
  // Live sidecar status — needed to resolve the `"local"` sentinel on
  // interface bindings to the sidecar's current bound address before
  // we invoke connect_remote_server (the Rust command takes a
  // concrete host:port, not the sentinel).
  const sidecar = useSidecarStatus();
  const sidecarAddress =
    sidecar.phase === "ready" ? sidecar.address : null;

  // Chunked cache of fetched trace rows, keyed by chunk index. Shared by
  // every trace panel — they all view the one host-side capture; only
  // their scroll position and auto-scroll toggle are per panel.
  const chunkCacheRef = useRef<Map<number, TraceFrameRecord[]>>(new Map());
  const cacheOrderRef = useRef<number[]>([]);
  const inflightChunksRef = useRef<Set<number>>(new Set());
  // The newest frames, as carried by the most recent `trace-grew`
  // event — a contiguous run ending at the live tail. `getFrame`
  // consults this when the chunk cache hasn't caught up, which is what
  // keeps auto-scroll from flashing placeholders. `tailStartRef` is
  // the absolute index of `tailFramesRef.current[0]`.
  const tailFramesRef = useRef<TraceFrameRecord[]>([]);
  const tailStartRef = useRef(0);
  const [version, setVersion] = useState(0);

  const [state, setState] = useState<LogState>({ kind: "idle" });
  // Paths of the loaded DBCs, in priority order (mirrors the host's set
  // — it owns the parsed databases; this is just what the UI shows).
  const [dbcPaths, setDbcPaths] = useState<string[]>([]);
  // Per-DBC bus scoping (path → bus ids). Empty list = unscoped.
  // Mirrors the host's `LoadedDbc.buses`; the project file carries the
  // canonical `dbcs: DbcRef[]` shape.
  const [dbcBuses, setDbcBuses] = useState<Record<string, string[]>>({});
  // Logical buses + interface bindings. Project-owned state.
  const [buses, setBuses] = useState<Bus[]>([]);
  const [interfaceBindings, setInterfaceBindings] = useState<InterfaceBinding[]>([]);
  // Virtual buses owned by the project (ADR 0021).
  const [localVirtualBuses, setLocalVirtualBuses] = useState<LocalVirtualBusDef[]>(
    [],
  );
  // Multi-server remote-session tracking, keyed by address. Connect/
  // Disconnect drives this; entries clear on a server-side hang up via
  // `log-finished` (which doesn't carry an address — we treat it as
  // "something ended" and re-derive from interaction).
  const [remoteSessions, setRemoteSessions] = useState<Map<string, RemoteStatus>>(
    () => new Map(),
  );
  // Snapshot of the per-bus hardware configuration the host was told
  // to apply on the most recent connect, keyed by bus id. Captured at
  // connect time and cleared on disconnect; the banner compares the
  // live `buses` state against this to flag pending hardware config
  // changes the user must reconnect to apply.
  const [busConfigInFlight, setBusConfigInFlight] = useState<
    Map<string, { speed_bps: number | null; fd: boolean | null; fd_data_speed_bps: number | null }>
  >(() => new Map());
  // Path of the open project file, or null for an unsaved workspace.
  const [projectPath, setProjectPath] = useState<string | null>(null);
  // True when the workspace has changed since it was last saved/opened.
  const [dirty, setDirty] = useState(false);
  // Set while the "unsaved changes — Save / Discard / Cancel?" modal is
  // up (the window-close handler awaits the choice via `resolve`).
  const [pendingClose, setPendingClose] = useState<{
    resolve: (choice: CloseChoice) => void;
  } | null>(null);
  // The project's elements + their runtime state (the element registry,
  // handed down via ElementRegistryContext). Restored from
  // `project.elements`, seeded on first launch / New, serialized back
  // on Save. Starts empty; `seedDefaultLayout` (called below) fills it.
  const [registry, setRegistry] = useState<RegistryEntry[]>([]);

  // Host-side log bus mirror. Bootstrapped by
  // `fetch_system_log` and kept current by `system-log-appended`
  // events. Session-scoped, not persisted.
  const [systemMessages, setSystemMessages] = useState<SystemMessage[]>([]);
  // Session-scoped notes mirror (host owns the canonical
  // list at `src-tauri/src/notes.rs`). Bootstrapped by
  // `fetch_notes` and kept current by `notes-changed` events.
  const [notes, setNotes] = useState<Note[]>([]);
  // Recent BLFs (the N most-recent opened BLF paths,
  // persisted in localStorage). Offered in the Open BLF flow and
  // the project panel's BLF import affordance.
  const [recentBlfs, setRecentBlfs] = useState<string[]>(() => loadRecentBlfs(localStorage));
  const rememberRecentBlf = useCallback((path: string) => {
    setRecentBlfs((current) => {
      const next = recordRecentBlf(current, path);
      saveRecentBlfs(localStorage, next);
      return next;
    });
  }, []);
  const dropRecentBlf = useCallback((path: string) => {
    setRecentBlfs((current) => {
      const next = forgetRecentBlf(current, path);
      saveRecentBlfs(localStorage, next);
      return next;
    });
  }, []);
  /// High-water seq the user has acknowledged. The unread badge counts
  /// warn/error entries with `seq > readHighWater`. Starts at -1 so
  /// every initial warn/error counts as unread.
  const [readHighWater, setReadHighWater] = useState<number>(-1);

  // Session-start time (Unix epoch seconds) — every trace view renders
  // frame timestamps relative to this. Driven by the `trace-grew` event,
  // which is in turn driven by `start_session` on the host. Single zero
  // point per session; survives panel close/reopen because it's app
  // state, not panel state. `null` until the first event arrives.
  const [sessionStartSeconds, setSessionStartSeconds] = useState<number | null>(
    null,
  );

  // The dockview layout API, populated once `onReady` fires.
  const dockApiRef = useRef<DockviewApi | null>(null);
  // Current `dirty` / `handleSaveProject`, read by the (once-registered)
  // close-on-quit handler. Updated on every render below.
  const dirtyRef = useRef(false);
  const handleSaveProjectRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  // Current session frame count, mirrored into a ref so `create` /
  // `ensure` can anchor a new (empty, stopped) trace at *now*
  // without taking `count` as a dependency (it changes every tick).
  const countRef = useRef(0);
  countRef.current = count;
  // Perf self-driving config (ADR 0031), fetched once from the host on
  // boot and handed to the orchestration effect below. `null` = normal
  // launch. The mirrored refs let that once-mounted effect read live
  // connect preconditions without re-subscribing on every change.
  const [automation, setAutomation] = useState<AutomationConfig | null>(null);
  const interfaceBindingsRef = useRef<InterfaceBinding[]>([]);
  const sidecarAddressRef = useRef<string | null>(null);
  const handleConnectRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // --- element registry ops ---
  // Latest bus list, mirrored into a ref so element creation can
  // pre-fill a transmit's `sinks` without taking `buses` as a
  // dependency of every `create` / `ensure` call site (those refs
  // change on every bus add/rename, which would invalidate panel
  // memoisation).
  const busesRef = useRef<readonly Bus[]>([]);
  busesRef.current = buses;

  // A freshly created element of a given kind:
  // - `trace` / `plot` / `filter` default `sources` to `["*"]` (the
  //   wildcard meaning "every bus in the project, including ones
  //   added later"). Future bus additions auto-flow in.
  // - `transmit` defaults `sinks` to an *explicit* snapshot of the
  //   current bus list — no wildcard. A future bus added to the
  //   project is a deliberate decision the user makes via the
  //   transmit panel; it does not silently start receiving the
  //   panel's frames.
  //
  // Every fresh element gets a model-owned display `name` (ADR 0019);
  // callers pass the `${Kind} ${n}` default computed against the
  // registry the element is joining.
  const buildFreshElement = (
    kind: ProjectElementKind,
    id: string,
    name: string,
  ): ProjectElement => {
    switch (kind) {
      case "transmit":
        return { kind, id, name, sinks: busesRef.current.map((b) => b.id), frameIds: [] };
      case "filter":
        return { kind, id, name, sources: ["*"] };
      case "rbs":
        // Path picked in the panel; Run is off by default (ADR 0028 —
        // a fresh reference never transmits unasked).
        return { kind, id, name, path: null, run: false };
      case "colormap":
        // A signal value→color map (ADR 0029): the target signal and
        // rules are filled in via its config panel; it starts inert.
        return { kind, id, name, busId: null, messageId: 0, extended: false, signalName: "", rules: [] };
      default:
        return { kind, id, name, sources: ["*"] };
    }
  };
  const create = useCallback((kind: ProjectElementKind): string => {
    diagCount("registry.create"); // DIAG
    const id = crypto.randomUUID();
    setRegistry((prev) => {
      const name = defaultElementName(kind, prev.map((e) => e.element));
      return [
        ...prev,
        { element: buildFreshElement(kind, id, name), trace: clearedTrace(countRef.current) },
      ];
    });
    return id;
  }, []);
  const ensure = useCallback((id: string, kind: ProjectElementKind) => {
    setRegistry((prev) => {
      const i = prev.findIndex((e) => e.element.id === id);
      const name = defaultElementName(kind, prev.map((e) => e.element));
      if (i < 0) {
        diagCount("registry.ensure.append"); // DIAG
        return [
          ...prev,
          { element: buildFreshElement(kind, id, name), trace: clearedTrace(countRef.current) },
        ];
      }
      if (prev[i].element.kind === kind) return prev;
      diagCount("registry.ensure.replace"); // DIAG
      const next = prev.slice();
      next[i] = { ...next[i], element: buildFreshElement(kind, id, name) };
      return next;
    });
  }, []);
  const updateTrace = useCallback((id: string, updater: (s: TraceState) => TraceState) => {
    setRegistry((prev) => {
      let changed = false;
      const next = prev.map((e) => {
        if (e.element.id !== id) return e;
        const t = updater(e.trace);
        if (t === e.trace) return e;
        changed = true;
        return { ...e, trace: t };
      });
      if (changed) diagCount("registry.updateTrace"); // DIAG
      return changed ? next : prev;
    });
  }, []);
  // Shallow patch of an element's persisted fields. Used by the
  // per-sink Sources picker (sets `sources`), the filter predicate
  // editor (sets `predicate`), the transmit panel's sinks picker
  // (sets `sinks`), the project panel's inline rename (sets `name`),
  // and the "Insert filter upstream" flow (sets multiple at once).
  // Guards are in the pure helper: kind / id mismatch and filter
  // cycles are silently refused. See `applyElementPatch`.
  //
  // Dirty-marking happens HERE, at the call site, against the last
  // rendered registry — never inside the updater. The updater must be
  // pure: React replays queued updaters (StrictMode, interrupted /
  // entangled renders), and a side effect there re-arms its own render
  // pass — under a high-rate capture this self-scheduled into a
  // permanent render loop that froze the GUI on the first rename
  // keystroke. The call-site check can mis-judge no-op-ness against a
  // one-render-stale base during a rapid edit burst; `dirty` is sticky
  // and the next real edit corrects it, while the state itself keeps
  // exact semantics through the pure updater.
  const updateElement = useCallback(
    (id: string, patch: Partial<ProjectElement>) => {
      diagCount("registry.update"); // DIAG
      if (applyElementPatch(registryRef.current, id, patch) !== registryRef.current) {
        diagCount("app.setDirty.callsite"); // DIAG
        setDirty(true);
      }
      setRegistry((prev) => applyElementPatch(prev, id, patch) as RegistryEntry[]);
    },
    [],
  );
  const removeElement = useCallback(
    (id: string) => {
      // Removing a *transmit* element (the explicit "Remove element"
      // action — not closing its panel) deletes its TX messages from
      // the host pool too, which also stops any running periodic. A
      // message still grouped by another transmit element survives
      // (the pool is shared; only this group is going away).
      const removed = registry.find((e) => e.element.id === id);
      // Removing an RBS element tears its host rows down (stopping
      // any running schedule) — the .cannet_rbs file on disk stays.
      if (removed && removed.element.kind === "rbs") {
        void invoke("rbs_unload", { elementId: id }).catch(() => {});
      }
      if (removed && removed.element.kind === "transmit") {
        const stillReferenced = new Set<string>();
        for (const e of registry) {
          if (e.element.id !== id && e.element.kind === "transmit") {
            for (const fid of e.element.frameIds) stillReferenced.add(fid);
          }
        }
        for (const fid of removed.element.frameIds) {
          if (!stillReferenced.has(fid)) {
            void invoke("remove_transmit_frame", { id: fid }).catch(() => {});
          }
        }
      }
      setRegistry((prev) => prev.filter((e) => e.element.id !== id));
      const api = dockApiRef.current;
      const panel = api?.panels.find(
        (p) => (p.params as { elementId?: unknown } | undefined)?.elementId === id,
      );
      if (api && panel) api.removePanel(panel);
    },
    [registry],
  );
  // Latest registry, mirrored into a ref so the add-panel handlers
  // can compute the new element's default name (= the tab title)
  // without taking `registry` as a dependency.
  const registryRef = useRef<readonly RegistryEntry[]>([]);
  registryRef.current = registry;

  // --- command / hotkey framework (ADR 0018) ---
  // The active dockview panel, tracked via `onDidActivePanelChange`
  // (subscribed in `handleDockReady`). Feeds the typed command
  // context's `focusedPanelKind` and routes panel-local commands
  // (the plot `f` / `l` hotkeys) to the focused panel's element.
  const [activePanel, setActivePanel] = useState<{
    id: string;
    elementId: string | null;
  } | null>(null);
  const focusedPanelKind = useMemo(() => {
    if (!activePanel) return null;
    const elementKind = activePanel.elementId
      ? registry.find((e) => e.element.id === activePanel.elementId)?.element.kind ?? null
      : null;
    return panelKindForFocus(activePanel.id, elementKind);
  }, [activePanel, registry]);
  // Which palette is open: the command palette (Mod+Shift+P) or
  // go-to-view (Mod+P).
  const [openPalette, setOpenPalette] = useState<"commands" | "goto" | null>(null);
  // The last few commands run (MRU, capped — see recentCommands.ts);
  // the command palette floats them to the top, VS Code-style.
  const [recentCommands, setRecentCommands] = useState<string[]>(() =>
    loadRecentCommands(localStorage),
  );
  // Panel-local command implementations (plot fit / follow-live).
  const [panelCommands] = useState(createPanelCommandRegistry);

  const invalidateCache = useCallback(() => {
    chunkCacheRef.current.clear();
    cacheOrderRef.current = [];
    inflightChunksRef.current.clear();
    tailFramesRef.current = [];
    tailStartRef.current = 0;
    setVersion((v) => v + 1);
  }, []);

  // (Re)starting the session buffer — opening a BLF, connecting to a
  // server, or Clear — also (re)starts every trace / plot element:
  // they all anchor at 0 and run, following the new capture from its
  // start. (A trace/plot *created* mid-session still starts stopped —
  // see `create` — so it doesn't retroactively span the buffer; this is
  // about the session-start event itself.)
  const startAllElements = useCallback(() => {
    setRegistry((prev) => prev.map((e) => ({ ...e, trace: freshTrace(0) })));
  }, []);

  const refreshChunk = useCallback(async (chunkIdx: number) => {
    if (inflightChunksRef.current.has(chunkIdx)) return;
    diagCount("invoke.fetch_trace_range"); // DIAG
    inflightChunksRef.current.add(chunkIdx);
    try {
      const start = chunkIdx * CHUNK_SIZE;
      const end = start + CHUNK_SIZE;
      const frames = await invoke<TraceFrameRecord[]>("fetch_trace_range", {
        start,
        end,
      });
      chunkCacheRef.current.set(chunkIdx, frames);
      cacheOrderRef.current = cacheOrderRef.current.filter((c) => c !== chunkIdx);
      cacheOrderRef.current.push(chunkIdx);
      while (cacheOrderRef.current.length > CACHE_CHUNKS) {
        const evict = cacheOrderRef.current.shift();
        if (evict !== undefined) chunkCacheRef.current.delete(evict);
      }
      setVersion((v) => v + 1);
    } finally {
      inflightChunksRef.current.delete(chunkIdx);
    }
  }, []);

  const fetchChunk = useCallback(
    (chunkIdx: number) => {
      if (chunkCacheRef.current.has(chunkIdx)) return;
      void refreshChunk(chunkIdx);
    },
    [refreshChunk],
  );

  // A cached chunk goes stale when more frames land in its range after
  // it was fetched. Re-fetch any such partial chunk so the chunk cache
  // stays consistent for when the user scrolls back into it. (The live
  // edge the auto-scrolling view shows is served from the `trace-grew`
  // tail overlay, not from here.)
  const refreshStalePartialChunks = useCallback(
    (newCount: number) => {
      for (const [chunkIdx, chunk] of chunkCacheRef.current) {
        const chunkStart = chunkIdx * CHUNK_SIZE;
        if (chunk.length < CHUNK_SIZE && chunkStart + chunk.length < newCount) {
          void refreshChunk(chunkIdx);
        }
      }
    },
    [refreshChunk],
  );

  // Bootstrap + live-update the system-log mirror. The
  // snapshot is the source of truth on mount; thereafter the host's
  // `system-log-appended` event delivers each new entry. The merge
  // helpers dedupe by `seq` so a snapshot/event race is harmless.
  useEffect(() => {
    let cancelled = false;
    void invoke<SystemMessage[]>("fetch_system_log").then((snap) => {
      if (cancelled) return;
      setSystemMessages((current) => reconcileSnapshot(current, snap));
    });
    const unlisten = listen<SystemMessage>("system-log-appended", (event) => {
      diagCount("event.system-log-appended"); // DIAG
      setSystemMessages((current) => mergeSystemMessage(current, event.payload));
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Bootstrap + live-update the notes mirror. The host's
  // `notes-changed` event payload is the full, chronologically
  // sorted list — there's no merge step to do.
  useEffect(() => {
    let cancelled = false;
    void invoke<Note[]>("fetch_notes").then((snap) => {
      if (cancelled) return;
      setNotes(sortNotesChronologically(snap));
    });
    const unlisten = listen<Note[]>("notes-changed", (event) => {
      setNotes(sortNotesChronologically(event.payload));
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [];

    unlistens.push(
      listen<TraceGrew>("trace-grew", (event) => {
        diagCount("event.trace-grew"); // DIAG
        const {
          count: newCount,
          frames_per_second,
          frames_per_second_by_bus,
          frames_dropped_before_session,
          session_start_seconds,
          buffer_seconds,
          tail,
        } = event.payload;
        // DIAG: log buffer size + aggregate/per-bus FPS as gauges so a
        // capture shows throughput against buffer growth, per bus.
        diagGauge("count", newCount); // DIAG
        diagGauge("fps", frames_per_second); // DIAG
        for (const b of frames_per_second_by_bus) {
          diagGauge(`fps.${b.bus_id ?? "(unassigned)"}`, b.frames_per_second); // DIAG
        }
        // DIAG: session-start drop counter (stale pipeline frames after a
        // clear/reconnect race).
        diagGauge("drop.before_session", frames_dropped_before_session); // DIAG
        setCount((prev) => {
          if (newCount < prev) {
            invalidateCache();
          }
          return newCount;
        });
        setSessionStartSeconds(
          session_start_seconds > 0 ? session_start_seconds : null,
        );
        setFramesPerSecond(frames_per_second);
        setBufferSeconds(buffer_seconds);
        tailFramesRef.current = tail;
        tailStartRef.current = tail.length > 0 ? tail[0].index : newCount;
        refreshStalePartialChunks(newCount);
      }),
    );

    unlistens.push(
      listen<LogFinished>("log-finished", (event) => {
        if (event.payload.status === "ok") {
          const total = event.payload.total;
          setState((s) => {
            if (s.kind === "loading" || s.kind === "running") {
              return { kind: "done", result: s.result, total };
            }
            return s;
          });
          // A remote pump exited cleanly. The host removed its session
          // entry, but the event doesn't carry an address, so we can't
          // know which one — leave the map alone; the user can hit
          // Disconnect (clear-all) or look at the per-server status in
          // the project panel.
        } else {
          setState({ kind: "error", message: event.payload.message });
        }
      }),
    );

    return () => {
      unlistens.forEach((p) => p.then((fn) => fn()));
    };
  }, [invalidateCache, refreshStalePartialChunks]);

  // Re-anchor every trace window when the session buffer shrinks (a new
  // connection cleared it) — a no-op on every other tick.
  useEffect(() => {
    setRegistry((prev) => {
      let changed = false;
      const next = prev.map((e) => {
        const t = reanchorToSession(e.trace, count);
        if (t === e.trace) return e;
        changed = true;
        return { ...e, trace: t };
      });
      if (changed) diagCount("registry.reanchor"); // DIAG
      return changed ? next : prev;
    });
  }, [count]);

  // Drop every trace view's per-view time-column offset when the
  // session itself restarts (`sessionStartSeconds` changes). The
  // offset is in session-relative seconds and stops meaning anything
  // sensible the moment the session it referenced is gone — left
  // alone, a stale value from the previous session shifts the next
  // session's clock and shows negative deltas. The Connect / toolbar-
  // Clear paths null `sessionStartSeconds` themselves; this effect
  // also catches the host-initiated re-anchor in BLF replay (first
  // frame becomes session start) and any other future trigger.
  useEffect(() => {
    setRegistry((prev) => {
      let changed = false;
      const next = prev.map((e) => {
        const t = clearTraceStartOffset(e.trace);
        if (t === e.trace) return e;
        changed = true;
        return { ...e, trace: t };
      });
      if (changed) diagCount("registry.clearOffset"); // DIAG
      return changed ? next : prev;
    });
  }, [sessionStartSeconds]);


  // BLF import has a channel → bus mapping step. The
  // outer pending state holds the picked BLF path + its distinct
  // channel list while the modal is open; clicking "Open" in the
  // modal commits and the host pump starts.
  const [pendingBlf, setPendingBlf] = useState<{
    blfPath: string;
    channels: number[];
  } | null>(null);

  const handleOpenLog = useCallback(
    async (presetPath?: string) => {
      const selected =
        typeof presetPath === "string" && presetPath.length > 0
          ? presetPath
          : await open({
              multiple: false,
              filters: [{ name: "Vector BLF", extensions: ["blf"] }],
            });
      if (typeof selected !== "string") return;

      try {
        const channels = await invoke<number[]>("scan_blf_channels", {
          blfPath: selected,
        });
        setPendingBlf({ blfPath: selected, channels });
      } catch (err) {
        setState({ kind: "error", message: String(err) });
        // If we tried to open a recent file and it failed (path
        // moved, file deleted), drop it from the recents list so
        // it doesn't keep being offered.
        if (presetPath) dropRecentBlf(presetPath);
      }
    },
    [dropRecentBlf],
  );

  // Confirm the BLF channel mapping and actually start the pump.
  // `choices[ch] === ""` means "skip this channel".
  const handleBlfMapConfirm = useCallback(
    async (choices: Record<number, string>) => {
      if (!pendingBlf) return;
      const { blfPath, channels } = pendingBlf;
      setPendingBlf(null);
      try {
        await invoke("clear_trace_store");
        invalidateCache();
        setSessionStartSeconds(null);
        setCount(0);
        startAllElements();
        const channelBusMapping = channels.map((ch) => ({
          channel: ch,
          busId: choices[ch] ? choices[ch] : null,
        }));
        const result = await invoke<OpenLogResult>("open_log", {
          blfPath,
          channelBusMapping,
        });
        setState({ kind: "loading", result });
        // Record on a successful open. Failures don't
        // promote a path — `handleOpenLog` drops it on the
        // recents-launch path.
        rememberRecentBlf(blfPath);
      } catch (err) {
        setState({ kind: "error", message: String(err) });
        dropRecentBlf(blfPath);
      }
    },
    [pendingBlf, invalidateCache, startAllElements, rememberRecentBlf, dropRecentBlf],
  );

  // Add one or more DBCs to the loaded set (each goes through the host's
  // `add_dbc`, which appends — or reloads in place if the path is
  // already loaded — and hands back the authoritative list).
  const handleAddDbc = useCallback(async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "DBC", extensions: ["dbc"] }],
    });
    const paths = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
    if (paths.length === 0) return;

    let list = dbcPaths;
    const errors: string[] = [];
    for (const path of paths) {
      try {
        list = (await invoke<DbcInfo[]>("add_dbc", { path })).map((d) => d.dbc_path);
      } catch (err) {
        errors.push(`${path}: ${String(err)}`);
      }
    }
    setDbcPaths(list);
    setDirty(true);
    invalidateCache();
    if (errors.length > 0) setState({ kind: "error", message: `DBC: ${errors.join("; ")}` });
  }, [dbcPaths, invalidateCache]);

  const handleRemoveDbc = useCallback(
    (path: string) => {
      void invoke<DbcInfo[]>("remove_dbc", { path })
        .then((list) => {
          setDbcPaths(list.map((d) => d.dbc_path));
          setDirty(true);
          invalidateCache();
        })
        .catch((err) => setState({ kind: "error", message: String(err) }));
    },
    [invalidateCache],
  );

  // Replace the loaded-DBC set with exactly `paths` (clear, then re-add
  // each in order). Used by "open project", "new project" (empty list),
  // and "reload all from disk". Paths that fail to read / parse are
  // dropped and reported together. `scoping` (path → bus_id[])
  // is committed to the host after each add so per-bus DBC scoping
  // survives an open-project round-trip.
  const loadDbcSet = useCallback(
    async (paths: readonly string[], scoping: Record<string, string[]> = {}) => {
      try {
        await invoke("clear_dbcs");
      } catch {
        /* unreachable in practice; the next add_dbc would surface real trouble */
      }
      let list: string[] = [];
      const errors: string[] = [];
      for (const path of paths) {
        try {
          list = (await invoke<DbcInfo[]>("add_dbc", { path })).map((d) => d.dbc_path);
          const buses = scoping[path];
          if (buses && buses.length > 0) {
            await invoke<DbcInfo[]>("set_dbc_buses", { path, buses });
          }
        } catch (err) {
          errors.push(`${path}: ${String(err)}`);
        }
      }
      setDbcPaths(list);
      invalidateCache();
      if (errors.length > 0) setState({ kind: "error", message: `DBC: ${errors.join("; ")}` });
    },
    [invalidateCache],
  );

  const handleClear = useCallback(async () => {
    try {
      await invoke("clear_trace_store");
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
    invalidateCache();
    setSessionStartSeconds(null);
    setCount(0);
    startAllElements();
  }, [invalidateCache, startAllElements]);

  // Connect to every server that has at least one binding in the
  // project. Each unique `server` in `interfaceBindings` becomes its
  // own `connect_remote_server` call; the host subscribes only to the
  // bound interfaces on that server. Bindings with the `"local"`
  // sentinel are resolved to the live sidecar address — if the
  // sidecar isn't ready yet they're dropped from this attempt with a
  // System Message rather than failing the whole connect. Bindings
  // with the `local-vbus://` scheme open an in-process session
  // against the named virtual bus (ADR 0021) — the host dispatches on
  // the binding's `kind`; the frontend treats every binding the same.
  const handleConnect = useCallback(async () => {
    if (interfaceBindings.length === 0) {
      setState({
        kind: "error",
        message: "No interface bindings — add at least one in the project panel.",
      });
      return;
    }
    if (
      interfaceBindings.some(isLocalBinding) &&
      sidecarAddress === null
    ) {
      setState({
        kind: "error",
        message:
          "Local sidecar isn't ready yet — wait for the Connection panel's Local row to go green, then Connect.",
      });
      return;
    }
    const servers = Array.from(
      new Set(
        interfaceBindings
          .map((b) => resolveServer(b.server, sidecarAddress))
          .filter((s): s is string => s !== null && s.length > 0),
      ),
    );
    if (servers.length === 0) {
      setState({
        kind: "error",
        message: "No reachable servers — check the Connection panel.",
      });
      return;
    }

    try {
      await invoke("clear_trace_store");
      invalidateCache();
      setSessionStartSeconds(null);
      setCount(0);
      startAllElements();
    } catch (err) {
      setState({ kind: "error", message: String(err) });
      return;
    }

    // Mark each target server as "connecting" so the UI shows progress.
    setRemoteSessions(() => {
      const next = new Map<string, RemoteStatus>();
      for (const s of servers) next.set(s, { kind: "connecting" });
      return next;
    });

    for (const address of servers) {
      const bindings = interfaceBindings
        .filter((b) => resolveServer(b.server, sidecarAddress) === address)
        .map((b) => {
          const bus = buses.find((bb) => bb.id === b.bus_id);
          return {
            interface: b.interface,
            busId: b.bus_id,
            speedBps: bus?.speed_bps ?? null,
            fd: bus?.fd ?? null,
            fdDataSpeedBps: bus?.fd_data_speed_bps ?? null,
          };
        });
      try {
        const result = await invoke<RemoteSessionResult>(
          "connect_remote_server",
          { address, bindings },
        );
        setRemoteSessions((prev) => {
          const next = new Map(prev);
          next.set(address, { kind: "running", result });
          return next;
        });
        // Snapshot the hardware config we just pushed so the pending-
        // change banner can spot subsequent edits.
        setBusConfigInFlight((prev) => {
          const next = new Map(prev);
          for (const b of bindings) {
            next.set(b.busId, {
              speed_bps: b.speedBps ?? null,
              fd: b.fd ?? null,
              fd_data_speed_bps: b.fdDataSpeedBps ?? null,
            });
          }
          return next;
        });
      } catch (err) {
        setRemoteSessions((prev) => {
          const next = new Map(prev);
          next.set(address, { kind: "error", message: String(err) });
          return next;
        });
      }
    }
  }, [buses, interfaceBindings, sidecarAddress, invalidateCache, startAllElements]);

  // Tear down every active session. The host drains its session map.
  const handleDisconnect = useCallback(async () => {
    try {
      await invoke("disconnect_remote_server", { address: null });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
    setRemoteSessions(new Map());
    // Disconnecting voids the pending-change comparison: there's
    // nothing in flight to compare against.
    setBusConfigInFlight(new Map());
  }, []);

  // Reset to the seed workspace: one trace element + its panel, plus
  // the project panel. Shared by first launch (no saved layout) and
  // "New project". Reads `dockApiRef.current`, so call it after
  // `onReady` has populated it.
  const seedDefaultLayout = useCallback(() => {
    const api = dockApiRef.current;
    if (!api) return;
    setRegistry([]);
    const elementId = create("trace");
    api.clear();
    api.addPanel({
      id: `trace-${elementId}`,
      component: TRACE_PANEL_COMPONENT,
      title: "Trace 1",
      params: { elementId, mode: "by-id" },
    });
    api.addPanel({
      // Fixed id — there's only ever one project panel; the toolbar's
      // "Project panel" button toggles it (show/hide).
      id: PROJECT_PANEL_ID,
      component: PROJECT_PANEL_COMPONENT,
      title: "Project",
      position: { direction: "left" },
    });
  }, [create]);

  /// Snapshot the current workspace into a `Project` (the elements, not
  /// their runtime state — that re-anchors on reload). Emits
  /// `buses`, `interface_bindings`, and `dbcs` (per-DBC bus scoping).
  const gatherProject = useCallback(
    (): Project => {
      const dbcs: DbcRef[] = dbcPaths.map((path) => ({
        path,
        buses: dbcBuses[path] ?? [],
      }));
      return {
        schema_version: PROJECT_SCHEMA_VERSION,
        layout: dockApiRef.current?.toJSON() ?? { grid: {}, panels: {} },
        elements: registry.map((e) => e.element),
        buses,
        interface_bindings: interfaceBindings,
        dbcs,
        // remote_address is no longer a project-level field — server
        // addresses now live per-binding on `interface_bindings`. Kept
        // null for v3 schema compatibility.
        remote_address: null,
        local_virtual_buses: localVirtualBuses,
      };
    },
    [registry, dbcPaths, dbcBuses, buses, interfaceBindings, localVirtualBuses],
  );

  // Record which project is "open" — both the React state and the
  // `localStorage` pointer that reopens it on the next launch. `null`
  // means an unsaved workspace.
  const rememberProject = useCallback((path: string | null) => {
    setProjectPath(path);
    try {
      if (path) localStorage.setItem(LAST_PROJECT_KEY, path);
      else localStorage.removeItem(LAST_PROJECT_KEY);
    } catch {
      /* best effort */
    }
  }, []);

  // Apply an opened project: restore the panel layout (incl. per-panel
  // config in the panel params), the remote-address field, and the
  // loaded DBC set (replaces whatever's loaded with the project's list).
  // Doesn't touch a live connection: the project's bus is configured
  // into the fields; hit Connect to switch.
  const applyProject = useCallback(
    (project: Project, projectFilePath: string) => {
      // DBC and `.cannet_rbs` references in the project may be relative
      // to the project file's own directory (ADR 0030); resolve them to
      // absolute before they reach the host commands, which read from
      // disk directly.
      const dir = projectDir(projectFilePath);
      // Restore the element registry first so the panels `fromJSON`
      // creates (which reference elements by `params.elementId`) find
      // their entries. (A panel that doesn't still self-heals.)
      // `assignDefaultNames` backfills `${Kind} ${n}` names onto
      // elements saved before display names existed (ADR 0019).
      setRegistry(
        assignDefaultNames(
          (Array.isArray(project.elements) ? project.elements : [])
            .filter(isProjectElement)
            .map(normalizeElement)
            .map((el) =>
              el.kind === "rbs" && el.path
                ? { ...el, path: resolveProjectPath(dir, el.path) }
                : el,
            ),
        ).map((el) => ({ element: el, trace: clearedTrace(countRef.current) })),
      );
      const api = dockApiRef.current;
      const layout = validateLayout(project.layout);
      if (api && layout) {
        try {
          api.fromJSON(layout);
        } catch {
          /* keep the current layout if the saved one won't load */
        }
      }
      // `project.remote_address` is ignored — addresses now live per-
      // binding (see `gatherProject`); reading a v3 file's value would
      // re-introduce the toolbar-level address we removed.
      // Pull bus / binding state, then load DBCs with their
      // bus scoping. `loadDbcSet` takes the scoping map so each DBC
      // is committed to the host with the right `buses`.
      const incomingBuses = Array.isArray(project.buses) ? project.buses : [];
      const incomingBindings = Array.isArray(project.interface_bindings)
        ? project.interface_bindings
        : [];
      const incomingDbcs: DbcRef[] = (Array.isArray(project.dbcs) ? project.dbcs : []).map(
        (d) => ({ ...d, path: resolveProjectPath(dir, d.path) }),
      );
      const incomingVbuses: LocalVirtualBusDef[] = Array.isArray(
        project.local_virtual_buses,
      )
        ? project.local_virtual_buses
        : [];
      setBuses(incomingBuses);
      setInterfaceBindings(incomingBindings);
      setLocalVirtualBuses(incomingVbuses);
      const scoping: Record<string, string[]> = {};
      for (const d of incomingDbcs) scoping[d.path] = d.buses ?? [];
      setDbcBuses(scoping);
      void loadDbcSet(
        incomingDbcs.map((d) => d.path),
        scoping,
      );
      // Rebuild host-side virtual buses from project defs
      // (ADR 0021). Per-binding session participants are opened on
      // Connect, not here.
      void invoke("replay_local_virtual_buses", {
        defs: incomingVbuses,
      }).catch((err) => {
        console.error("replay_local_virtual_buses failed", err);
      });
    },
    [loadDbcSet],
  );

  const handleNewProject = useCallback(() => {
    // Fresh workspace: seed layout, no open project, no DBCs, no
    // session — disconnect and clear the buffer too. RBS elements
    // unload first (stopping their schedules).
    for (const e of registryRef.current) {
      if (e.element.kind === "rbs") {
        void invoke("rbs_unload", { elementId: e.element.id }).catch(() => {});
      }
    }
    seedDefaultLayout();
    rememberProject(null);
    void loadDbcSet([], {});
    setDbcBuses({});
    setBuses([]);
    setInterfaceBindings([]);
    setLocalVirtualBuses([]);
    void invoke("disconnect_remote_server", { address: null }).catch(() => {});
    setRemoteSessions(new Map());
    setBusConfigInFlight(new Map());
    // Drop any host-side local virtual buses left from the
    // previous project (ADR 0021).
    void invoke("replay_local_virtual_buses", {
      defs: [],
    }).catch(() => {});
    // Drop the host TX-message pool too, so a New
    // project starts with no transmit frames.
    void invoke("clear_transmit_frames").catch(() => {});
    void invoke("clear_trace_store").catch(() => {});
    invalidateCache();
    setSessionStartSeconds(null);
    setCount(0);
    setDirty(false);
  }, [seedDefaultLayout, rememberProject, loadDbcSet, invalidateCache]);

  const handleOpenProject = useCallback(async () => {
    const selected = await open({
      multiple: false,
      // `.cannet_prj` is the convention; `.json` (the same content)
      // stays accepted for projects saved before the extension.
      filters: [{ name: "cannet project", extensions: ["cannet_prj", "json"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const project = await invoke<Project>("open_project", { path: selected });
      applyProject(project, selected);
      rememberProject(selected);
      setDirty(false);
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, [applyProject, rememberProject]);

  // Returns true if the project was written, false if it wasn't (e.g.
  // the user cancelled the file picker, or the write failed).
  const saveProjectTo = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        await invoke("save_project", { path, project: gatherProject() });
        rememberProject(path);
        setDirty(false);
        return true;
      } catch (err) {
        setState({ kind: "error", message: String(err) });
        return false;
      }
    },
    [gatherProject, rememberProject],
  );

  const handleSaveProjectAs = useCallback(async (): Promise<boolean> => {
    const path = await save({
      filters: [{ name: "cannet project", extensions: ["cannet_prj"] }],
      defaultPath: projectPath ?? "cannet-project.cannet_prj",
    });
    if (!path) return false;
    return saveProjectTo(path);
  }, [projectPath, saveProjectTo]);

  const handleSaveProject = useCallback(
    (): Promise<boolean> => (projectPath ? saveProjectTo(projectPath) : handleSaveProjectAs()),
    [projectPath, saveProjectTo, handleSaveProjectAs],
  );

  // Save All: the project plus every dirty `.cannet_rbs` (ADR 0028 —
  // Save Project saves the project only; this is the catch-all the
  // exit prompt uses too). Returns false if any step failed or was
  // cancelled.
  const handleSaveAll = useCallback(async (): Promise<boolean> => {
    const projectOk = await handleSaveProject();
    if (!projectOk) return false;
    try {
      const dirtyRbs = await invoke<RbsDirtyRecord[]>("rbs_dirty");
      for (const d of dirtyRbs) {
        if (d.path == null) {
          // Never-saved config: prompt for its first path.
          const picked = await save({
            filters: [{ name: "cannet RBS config", extensions: ["cannet_rbs"] }],
            defaultPath: "simulation.cannet_rbs",
          });
          if (typeof picked !== "string" || picked.length === 0) return false;
          await invoke("rbs_save_as", { elementId: d.elementId, path: picked });
          updateElement(d.elementId, { kind: "rbs", path: picked });
        } else {
          await invoke("rbs_save", { elementId: d.elementId });
        }
      }
      return true;
    } catch {
      return false; // failures land on the system log
    }
  }, [handleSaveProject, updateElement]);
  const handleSaveAllRef = useRef(handleSaveAll);
  handleSaveAllRef.current = handleSaveAll;

  // Save Capture: write the session buffer to a BLF.
  // System Messages handle the user-visible success / failure
  // feedback; this just routes through the host command.
  //
  // The project's ordered `buses` list IS the BLF channel order
  // (see CLAUDE.md § File formats). Frames get re-channeled by the
  // host so that bus index N → BLF channel N; on reload the channel
  // map modal seeds matching pairs.
  const handleSaveCapture = useCallback(async () => {
    if (count === 0) return;
    const path = await save({
      defaultPath: "capture.blf",
      filters: [{ name: "Vector BLF", extensions: ["blf"] }],
    });
    if (typeof path !== "string" || path.length === 0) return;
    try {
      await invoke("save_capture", {
        blfPath: path,
        buses: buses.map((b) => b.id),
      });
      // Newly-saved captures are reasonable Recent BLF candidates
      // (the user just produced this file; re-opening it is the
      // archetypal "what did I just save?" gesture).
      rememberRecentBlf(path);
    } catch {
      // Failure surfaces in the System Messages panel via the
      // host's `capture`-tagged error log; nothing more to do here.
    }
  }, [buses, count, rememberRecentBlf]);

  // The close-on-quit handler is registered once; give it refs to the
  // current values rather than re-registering on every change.
  dirtyRef.current = dirty;
  handleSaveProjectRef.current = handleSaveProject;
  // Mirror the connect preconditions + action for the once-mounted perf
  // orchestration effect (ADR 0031).
  interfaceBindingsRef.current = interfaceBindings;
  sidecarAddressRef.current = sidecarAddress;
  handleConnectRef.current = handleConnect;

  // Self-driving perf run (ADR 0031). When the host hands us an
  // automation config, connect (if asked), capture for the requested
  // span, write the report, and exit — without an operator. The project
  // has already been opened in `onReady`; everything the workload needs
  // (layout, bindings, the RBS run flag) rides in the saved project, so
  // the flags add only the two decisions a project deliberately doesn't
  // persist: touch interfaces, and record.
  useEffect(() => {
    if (!automation) return;
    let cancelled = false;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    // Poll `pred` until it holds or `timeoutMs` elapses (returns whether
    // it held) — waits out the async settle after the project applies:
    // bindings load into state, and the local sidecar comes up.
    const waitUntil = async (pred: () => boolean, timeoutMs: number) => {
      const start = performance.now();
      while (!pred()) {
        if (cancelled || performance.now() - start > timeoutMs) return false;
        await sleep(100);
      }
      return true;
    };
    void (async () => {
      try {
        if (automation.connectOnStart) {
          const ready = await waitUntil(
            () =>
              interfaceBindingsRef.current.length > 0 &&
              (!interfaceBindingsRef.current.some(isLocalBinding) ||
                sidecarAddressRef.current !== null),
            AUTOMATION_READY_TIMEOUT_MS,
          );
          if (cancelled) return;
          if (ready) await handleConnectRef.current();
        }
        if (automation.captureSecs != null) {
          await sleep(AUTOMATION_SETTLE_MS);
          if (cancelled) return;
          await beginDiagCapture(
            automation.label ?? automation.project ?? "perf",
          );
          await sleep(automation.captureSecs * 1000);
          if (cancelled) return;
          await endDiagCapture(automation.out ?? undefined);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("perf automation run failed", err);
      } finally {
        // A capture run is unattended — exit so the launching CLI
        // returns. `destroy` skips the dirty-close prompt (applying the
        // project dirties the workspace). A connect-only / project-only
        // run leaves the app open for interactive use.
        if (!cancelled && automation.captureSecs != null) {
          getCurrentWindow().destroy();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [automation]);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win
      .onCloseRequested(async (event) => {
        // Unsaved state = a dirty project workspace OR any dirty
        // `.cannet_rbs` (the exit prompt covers both — ADR 0028).
        let rbsDirty = false;
        try {
          rbsDirty = (await invoke<RbsDirtyRecord[]>("rbs_dirty")).length > 0;
        } catch {
          /* host gone — nothing to save */
        }
        if (!dirtyRef.current && !rbsDirty) return; // nothing unsaved — let it close
        event.preventDefault();
        const choice = await new Promise<CloseChoice>((resolve) =>
          setPendingClose({ resolve }),
        );
        setPendingClose(null);
        if (choice === "cancel") return;
        if (choice === "save" && !(await handleSaveAllRef.current())) return; // picker cancelled
        void win.destroy();
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  // Re-read every loaded DBC from disk (a file that's gone or no longer
  // parses drops out, with an error). No-op when none are loaded.
  // Preserve per-DBC bus scoping across the reload.
  const handleReloadDbc = useCallback(() => {
    if (dbcPaths.length > 0) void loadDbcSet(dbcPaths, dbcBuses);
  }, [dbcPaths, dbcBuses, loadDbcSet]);

  // Update a single DBC's bus scoping and push it to the host.
  const handleSetDbcBuses = useCallback(
    (path: string, scopedBuses: string[]) => {
      setDbcBuses((prev) => ({ ...prev, [path]: scopedBuses }));
      setDirty(true);
      invalidateCache(); // decoded view changes
      void invoke<DbcInfo[]>("set_dbc_buses", { path, buses: scopedBuses }).catch((err) =>
        setState({ kind: "error", message: String(err) }),
      );
    },
    [invalidateCache],
  );

  // Bus list mutations (add / rename / remove). Pure project
  // state; the host doesn't need a separate command (the buses ride
  // through the project file, and the per-DBC scoping refresh below
  // re-publishes the canonical set when a rename / remove changes ids).
  const handleAddBus = useCallback((bus: Bus) => {
    setBuses((prev) => {
      if (prev.some((b) => b.id === bus.id)) return prev;
      // Seed a graph colour if the caller didn't supply one — the
      // default palette indexed by the new bus's list position.
      const seeded: Bus =
        bus.color != null
          ? bus
          : { ...bus, color: defaultBusColor(prev.length) };
      return [...prev, seeded];
    });
    setDirty(true);
  }, []);
  const handleRemoveBus = useCallback((id: string) => {
    setBuses((prev) => prev.filter((b) => b.id !== id));
    setInterfaceBindings((prev) => prev.filter((b) => b.bus_id !== id));
    setDbcBuses((prev) => {
      const next: Record<string, string[]> = {};
      for (const [path, scoped] of Object.entries(prev)) {
        next[path] = scoped.filter((b) => b !== id);
      }
      return next;
    });
    setDirty(true);
    invalidateCache();
  }, [invalidateCache]);
  const handleRenameBus = useCallback((id: string, name: string) => {
    setBuses((prev) => prev.map((b) => (b.id === id ? { ...b, name } : b)));
    setDirty(true);
  }, []);
  const handleSetBusColor = useCallback((id: string, color: string) => {
    setBuses((prev) => prev.map((b) => (b.id === id ? { ...b, color } : b)));
    setDirty(true);
  }, []);
  const handleSetBusSpeed = useCallback((id: string, speed_bps: number | null) => {
    setBuses((prev) =>
      prev.map((b) => (b.id === id ? { ...b, speed_bps } : b)),
    );
    setDirty(true);
  }, []);
  const handleSetBusFd = useCallback((id: string, fd: boolean | null) => {
    setBuses((prev) => prev.map((b) => (b.id === id ? { ...b, fd } : b)));
    setDirty(true);
  }, []);
  const handleSetBusFdDataSpeed = useCallback(
    (id: string, fd_data_speed_bps: number | null) => {
      setBuses((prev) =>
        prev.map((b) => (b.id === id ? { ...b, fd_data_speed_bps } : b)),
      );
      setDirty(true);
    },
    [],
  );
  // Interface-binding mutations. Each project bus has at
  // most one binding (key is `bus_id`); multiple bindings may target
  // the same source — the sidecar and the
  // in-process bus both fan out to N subscribers. Binding mutations
  // are pure project state — the host-side session for the binding
  // is opened on Connect, not on bind.
  const handleAddBinding = useCallback((binding: InterfaceBinding) => {
    setInterfaceBindings((prev) => {
      const filtered = prev.filter((b) => b.bus_id !== binding.bus_id);
      return [...filtered, binding];
    });
    setDirty(true);
  }, []);
  const handleRemoveBinding = useCallback((bus_id: string) => {
    setInterfaceBindings((prev) => prev.filter((b) => b.bus_id !== bus_id));
    setDirty(true);
  }, []);

  // Virtual-bus mutations (ADR 0021).
  const handleAddVirtualBus = useCallback((def: LocalVirtualBusDef) => {
    setLocalVirtualBuses((prev) => {
      if (prev.some((v) => v.id === def.id)) return prev;
      return [...prev, def];
    });
    setDirty(true);
    void invoke("create_local_virtual_bus", {
      id: def.id,
      name: def.name,
    }).catch((err) => {
      console.error("create_local_virtual_bus failed", err);
    });
  }, []);

  const handleRemoveVirtualBus = useCallback((id: string) => {
    setLocalVirtualBuses((prev) => prev.filter((v) => v.id !== id));
    setInterfaceBindings((prev) =>
      prev.filter((b) => localVbusId(b) !== id),
    );
    setDirty(true);
    void invoke("drop_local_virtual_bus", { id }).catch((err) => {
      console.error("drop_local_virtual_bus failed", err);
    });
  }, []);

  const handleUpdateVirtualBus = useCallback(
    (id: string, patch: Partial<LocalVirtualBusDef>) => {
      setLocalVirtualBuses((prev) =>
        prev.map((v) => (v.id === id ? { ...v, ...patch } : v)),
      );
      setDirty(true);
    },
    [],
  );

  const getFrame = useCallback((index: number): TraceFrameRecord | null => {
    const chunkIdx = Math.floor(index / CHUNK_SIZE);
    const chunk = chunkCacheRef.current.get(chunkIdx);
    const fromChunk = chunk ? chunk[index - chunkIdx * CHUNK_SIZE] : undefined;
    if (fromChunk) return fromChunk;
    // Not (yet) in the chunk cache — fall back to the live tail
    // carried by the most recent `trace-grew`, which covers the newest
    // rows the auto-scroll window shows.
    const tail = tailFramesRef.current;
    const tailOffset = index - tailStartRef.current;
    if (tailOffset >= 0 && tailOffset < tail.length) return tail[tailOffset];
    return null;
  }, []);

  const ensureVisible = useCallback(
    (startIndex: number, endIndex: number) => {
      if (count === 0) return;
      const safeEnd = Math.min(endIndex, count);
      if (safeEnd <= 0) return;
      const firstChunk = Math.floor(startIndex / CHUNK_SIZE);
      const lastChunk = Math.floor((safeEnd - 1) / CHUNK_SIZE);
      // Prefetch one chunk on either side so brisk scrolling doesn't
      // bottom out into placeholders at chunk boundaries.
      const prefetchStart = Math.max(0, firstChunk - 1);
      const prefetchEnd = lastChunk + 1;
      for (let c = prefetchStart; c <= prefetchEnd; c++) {
        if (c < 0) continue;
        if (c * CHUNK_SIZE >= count) break;
        fetchChunk(c);
      }
    },
    [count, fetchChunk],
  );

  // Tab titles come from the element's model-owned name (ADR 0019):
  // the handler computes the same `${Kind} ${n}` default `create`
  // assigns (against the registry the element is joining), and the
  // title-sync effect below keeps the tab current thereafter.
  const addTracePanel = useCallback(() => {
    const api = dockApiRef.current;
    if (!api) return;
    const title = defaultElementName("trace", registryRef.current.map((e) => e.element));
    const elementId = create("trace");
    // A new trace starts in by-id mode (toggle it in the panel toolbar).
    api.addPanel({
      id: `trace-${elementId}`,
      component: TRACE_PANEL_COMPONENT,
      title,
      params: { elementId, mode: "by-id" },
    });
  }, [create]);

  const addPlotPanel = useCallback(() => {
    const api = dockApiRef.current;
    if (!api) return;
    const title = defaultElementName("plot", registryRef.current.map((e) => e.element));
    const elementId = create("plot");
    api.addPanel({
      id: `plot-${elementId}`,
      component: PLOT_PANEL_COMPONENT,
      title,
      params: { elementId },
    });
  }, [create]);

  const addTransmitPanel = useCallback(() => {
    const api = dockApiRef.current;
    if (!api) return;
    const title = defaultElementName("transmit", registryRef.current.map((e) => e.element));
    const elementId = create("transmit");
    api.addPanel({
      id: `transmit-${elementId}`,
      component: TRANSMIT_PANEL_COMPONENT,
      title,
      params: { elementId },
    });
  }, [create]);

  const addRbsPanel = useCallback(() => {
    const api = dockApiRef.current;
    if (!api) return;
    const title = defaultElementName("rbs", registryRef.current.map((e) => e.element));
    const elementId = create("rbs");
    api.addPanel({
      id: `rbs-${elementId}`,
      component: RBS_PANEL_COMPONENT,
      title,
      params: { elementId },
    });
  }, [create]);

  const addColorMapPanel = useCallback(() => {
    const api = dockApiRef.current;
    if (!api) return;
    const title = defaultElementName("colormap", registryRef.current.map((e) => e.element));
    const elementId = create("colormap");
    api.addPanel({
      id: `colormap-${elementId}`,
      component: COLORMAP_PANEL_COMPONENT,
      title,
      params: { elementId },
    });
  }, [create]);

  // --- RBS host lifecycle (ADR 0028) ---
  // The host resolves `.cannet_rbs` bus-name keys against the
  // project's logical buses; push the (id, name) map on every change.
  useEffect(() => {
    void invoke("rbs_sync_project_buses", {
      buses: buses.map((b) => [b.id, b.name]),
    }).catch(() => {});
  }, [buses]);
  // Reconcile host-loaded RBS elements with the registry: load when a
  // path appears / changes, unload when the element goes away, and
  // push the Run flag. Owned here (not by the panel) so an enabled
  // RBS resumes on project open even when its panel isn't in the
  // layout.
  const rbsHostStateRef = useRef<Map<string, { path: string | null; run: boolean }>>(
    new Map(),
  );
  // Per-element op queue: the reconciler fires across renders (a
  // layout-restored panel ensures a pathless element moments before
  // the opened project replaces it with the saved path), and the
  // rbs_* commands run concurrently on the async pool — unserialized,
  // an early rbs_init's set_run could land after the project's
  // rbs_load chain. Chaining per element keeps host ops in dispatch
  // order.
  const rbsOpsRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const queueRbsOp = useCallback((id: string, op: () => Promise<unknown>) => {
    const prev = rbsOpsRef.current.get(id) ?? Promise.resolve();
    const next = prev.then(op).catch(() => {});
    rbsOpsRef.current.set(id, next);
  }, []);
  useEffect(() => {
    const current = new Map<string, { path: string | null; run: boolean }>();
    for (const e of registry) {
      if (e.element.kind === "rbs") {
        current.set(e.element.id, { path: e.element.path, run: e.element.run });
      }
    }
    for (const [id, prev] of rbsHostStateRef.current) {
      const now = current.get(id);
      if (!now || (prev.path != null && now.path != null && now.path !== prev.path)) {
        queueRbsOp(id, () => invoke("rbs_unload", { elementId: id }));
      }
    }
    for (const [id, now] of current) {
      const prev = rbsHostStateRef.current.get(id);
      if (now.path != null && (!prev || prev.path !== now.path)) {
        // A path appearing for an element the host already has in
        // memory (first save) is a no-op host-side: rbs_load re-reads
        // the file just written.
        const path = now.path;
        queueRbsOp(id, () =>
          invoke("rbs_load", { elementId: id, path }).then(() =>
            invoke("rbs_set_run", { elementId: id, run: now.run }),
          ),
        );
      } else if (now.path == null && !prev) {
        // A fresh element needs no file: the host seeds an in-memory
        // config from the project's current buses (saving is explicit).
        queueRbsOp(id, () =>
          invoke("rbs_init", { elementId: id }).then(() =>
            invoke("rbs_set_run", { elementId: id, run: now.run }),
          ),
        );
      } else if (prev && prev.run !== now.run) {
        queueRbsOp(id, () => invoke("rbs_set_run", { elementId: id, run: now.run }));
      }
    }
    rbsHostStateRef.current = current;
  }, [registry, queueRbsOp]);
  // The global RBS kill-switch is runtime-only host state; mirror it
  // through its dedicated event so the palette toggle and the panel
  // button stay in sync.
  const rbsKillSwitchRef = useRef(false);
  useEffect(() => {
    const un = listen<boolean>("rbs-kill-switch", (event) => {
      rbsKillSwitchRef.current = event.payload;
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);
  const toggleRbsKillSwitch = useCallback(() => {
    void invoke("rbs_set_kill_switch", { on: !rbsKillSwitchRef.current }).catch(
      () => {},
    );
  }, []);

  // Keep every element-backed dockview tab title in lockstep with the
  // model-owned name (ADR 0019): covers rename from the project
  // panel, project open (layouts saved with stale titles), and the
  // self-healing `ensure` path.
  useEffect(() => {
    const api = dockApiRef.current;
    if (!api) return;
    for (const panel of api.panels) {
      const elementId = (panel.params as { elementId?: unknown } | undefined)
        ?.elementId;
      if (typeof elementId !== "string") continue;
      const entry = registry.find((e) => e.element.id === elementId);
      if (!entry) continue;
      const label = elementLabel(entry.element);
      if (panel.title !== label) {
        diagCount("dockview.setTitle"); // DIAG
        panel.api.setTitle(label);
      }
    }
  }, [registry]);


  // Show-or-focus a singleton panel keyed by its fixed id. Used by the
  // toolbar buttons for Project, Graph, and System messages — clicking
  // brings the panel forward if it's already open, otherwise adds it.
  const showSingletonPanel = useCallback((options: AddPanelOptions) => {
    const api = dockApiRef.current;
    if (!api) return;
    const existing = api.panels.find((p) => p.id === options.id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel(options);
  }, []);

  const showProjectGraphPanel = useCallback(
    () =>
      showSingletonPanel({
        id: PROJECT_GRAPH_PANEL_ID,
        component: PROJECT_GRAPH_PANEL_COMPONENT,
        title: "Graph",
      }),
    [showSingletonPanel],
  );

  const showSystemMessagesPanel = useCallback(
    () =>
      showSingletonPanel({
        id: SYSTEM_MESSAGES_PANEL_ID,
        component: SYSTEM_MESSAGES_PANEL_COMPONENT,
        title: "System messages",
      }),
    [showSingletonPanel],
  );

  // DBC discovery panel — singleton (same pattern as project /
  // graph / system-messages). The host owns the loaded-DBC set; the
  // panel is purely a viewer. Its search query + expand state survive
  // a layout save through dockview panel params.
  const showDbcPanel = useCallback(
    () =>
      showSingletonPanel({
        id: DBC_PANEL_ID,
        component: DBC_PANEL_COMPONENT,
        title: "DBC",
      }),
    [showSingletonPanel],
  );

  // System-log context: mirror + clear + markRead. `clear`
  // empties both the host's ring and the frontend's mirror; the host
  // does *not* reset its seq counter (callers rely on monotonicity),
  // so we don't reset `readHighWater` either.
  const clearSystemLog = useCallback(() => {
    void invoke("clear_system_log").catch(() => { /* best effort */ });
    setSystemMessages([]);
  }, []);
  const markSystemLogRead = useCallback(() => {
    setSystemMessages((current) => {
      if (current.length === 0) return current;
      const lastSeq = current[current.length - 1].seq;
      setReadHighWater((prev) => (lastSeq > prev ? lastSeq : prev));
      return current;
    });
  }, []);
  const unread = useMemo(
    () => unreadWarnOrError(systemMessages, readHighWater),
    [systemMessages, readHighWater],
  );
  const systemLogValue: SystemLogContextValue = useMemo(
    () => ({
      messages: systemMessages,
      unread,
      clear: clearSystemLog,
      markRead: markSystemLogRead,
    }),
    [systemMessages, unread, clearSystemLog, markSystemLogRead],
  );

  // Notes context: dispatchers forward to the host; the
  // mirror updates from the `notes-changed` event, not from
  // optimistic local state, so a panel-A add shows up on panel B
  // through the same code path.
  const addNoteRemote = useCallback(
    (id: string, timestampNs: number, label: string) => {
      void invoke("add_note", { note: { id, timestampNs, label } }).catch(() => {
        /* best effort — error surfaces in System Messages */
      });
    },
    [],
  );
  const renameNoteRemote = useCallback((id: string, label: string) => {
    void invoke("rename_note", { id, label }).catch(() => { /* best effort */ });
  }, []);
  const removeNoteRemote = useCallback((id: string) => {
    void invoke("remove_note", { id }).catch(() => { /* best effort */ });
  }, []);
  const notesValue: NotesContextValue = useMemo(
    () => ({
      notes,
      addNote: addNoteRemote,
      renameNote: renameNoteRemote,
      removeNote: removeNoteRemote,
    }),
    [notes, addNoteRemote, renameNoteRemote, removeNoteRemote],
  );

  const showProjectPanel = useCallback(
    () =>
      showSingletonPanel({
        id: PROJECT_PANEL_ID,
        component: PROJECT_PANEL_COMPONENT,
        title: "Project",
        position: { direction: "left" },
      }),
    [showSingletonPanel],
  );

  // --- command handlers + key dispatch (ADR 0018) ---
  // Commands wrap the existing toolbar handlers — same behaviour,
  // second access path. The map is rebuilt every render (cheap) and
  // read through a ref so the once-registered keydown listener and
  // the palette always see current closures.
  const activePanelRef = useRef(activePanel);
  activePanelRef.current = activePanel;
  const runFocusedPanelCommand = useCallback(
    (commandId: string) => {
      const elementId = activePanelRef.current?.elementId;
      if (elementId) panelCommands.invoke(elementId, commandId);
    },
    [panelCommands],
  );
  const commandHandlersRef = useRef<Record<string, () => void>>({});
  commandHandlersRef.current = {
    "project.open": () => void handleOpenProject(),
    "project.save": () => void handleSaveProject(),
    "project.saveAs": () => void handleSaveProjectAs(),
    "blf.open": () => void handleOpenLog(),
    "dbc.add": () => void handleAddDbc(),
    "connection.connect": () => void handleConnect(),
    "connection.disconnect": () => void handleDisconnect(),
    "capture.clear": () => void handleClear(),
    "panel.add.trace": addTracePanel,
    "panel.add.plot": addPlotPanel,
    "panel.add.transmit": addTransmitPanel,
    "panel.add.rbs": addRbsPanel,
    "panel.add.colormap": addColorMapPanel,
    "project.saveAll": () => void handleSaveAllRef.current(),
    "rbs.killSwitch": toggleRbsKillSwitch,
    "panel.show.systemMessages": showSystemMessagesPanel,
    "panel.show.projectGraph": showProjectGraphPanel,
    "panel.show.dbc": showDbcPanel,
    // Renaming happens in the project panel (the canonical edit
    // surface — ADR 0019); the command surfaces it.
    "panel.rename": showProjectPanel,
    "palette.show": () => setOpenPalette("commands"),
    "goto.view": () => setOpenPalette("goto"),
    "plot.fitXAxis": () => runFocusedPanelCommand("plot.fitXAxis"),
    "plot.followLive.enable": () => runFocusedPanelCommand("plot.followLive.enable"),
  };
  const runCommand = useCallback((id: string) => {
    const handler = commandHandlersRef.current[id];
    if (!handler) return;
    // The palette-opening commands aren't worth resurfacing at the
    // top of the palette they open; everything else is remembered.
    if (id !== "palette.show" && id !== "goto.view") {
      setRecentCommands((current) => {
        const next = recordRecentCommand(current, id);
        saveRecentCommands(localStorage, next);
        return next;
      });
    }
    handler();
  }, []);

  const commandContext: CommandContext = useMemo(
    () => ({ focusedPanelKind, hasProjectOpen: projectPath !== null }),
    [focusedPanelKind, projectPath],
  );
  const commandContextRef = useRef(commandContext);
  commandContextRef.current = commandContext;

  // The global keydown dispatcher: resolve binding → check context →
  // run, or silently no-op. Registered once, on the capture phase so
  // a focused panel's own handlers can't shadow the global chords;
  // plain-key bindings are suppressed while typing (see
  // `dispatchStroke`). Sequence prefixes expire after a beat.
  useEffect(() => {
    const isMac = isMacPlatform();
    let pending: KeyStroke[] = [];
    let timer: number | undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Control" || e.key === "Meta" || e.key === "Shift" || e.key === "Alt") {
        return;
      }
      const available = new Set(
        commandsAvailableIn(COMMANDS, commandContextRef.current).map((c) => c.id),
      );
      const result = dispatchStroke(
        pending,
        { key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey },
        PARSED_BINDINGS.filter((b) => available.has(b.commandId)),
        { isMac, inEditable: isEditableTarget(e.target) },
      );
      pending = result.pending;
      window.clearTimeout(timer);
      if (result.pending.length > 0) {
        timer = window.setTimeout(() => {
          pending = [];
        }, 1500);
      }
      if (result.handled) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (result.commandId) runCommand(result.commandId);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.clearTimeout(timer);
    };
  }, [runCommand]);

  // Palette items. Commands: everything available in the current
  // context, hinted with the key binding (or category). Go-to-view:
  // every open dockview panel by its display name — the tab titles
  // are kept in lockstep with `elementLabel` above, so this is the
  // same label everywhere (ADR 0019).
  const commandPaletteItems: PaletteItem[] = useMemo(() => {
    if (openPalette !== "commands") return [];
    const isMac = isMacPlatform();
    const items = commandsAvailableIn(COMMANDS, commandContext).map((c) => {
      const binding = PARSED_BINDINGS.find((b) => b.commandId === c.id);
      return {
        id: c.id,
        label: c.label,
        hint: binding ? formatChord(binding.chord, isMac) : c.category,
      };
    });
    // Recently-used first (the fzf ranking takes over once the user
    // types — this orders only the unfiltered list).
    return sortRecentFirst(items, recentCommands);
  }, [openPalette, commandContext, recentCommands]);
  const gotoPaletteItems: PaletteItem[] = useMemo(() => {
    if (openPalette !== "goto") return [];
    const api = dockApiRef.current;
    if (!api) return [];
    return api.panels.map((p) => ({ id: p.id, label: p.title ?? p.id }));
  }, [openPalette]);
  const focusPanelById = useCallback((panelId: string) => {
    dockApiRef.current?.panels.find((p) => p.id === panelId)?.api.setActive();
  }, []);

  const handleDockReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      dockApiRef.current = api;

      // Track the focused panel for the command context (ADR 0018).
      api.onDidActivePanelChange((panel) => {
        diagCount("app.setActivePanel"); // DIAG
        if (!panel) {
          setActivePanel(null);
          return;
        }
        const elementId = (panel.params as { elementId?: unknown } | undefined)
          ?.elementId;
        setActivePanel({
          id: panel.id,
          elementId: typeof elementId === "string" ? elementId : null,
        });
      });

      let restored = false;
      const saved = parseSavedLayout(localStorage.getItem(LAYOUT_STORAGE_KEY));
      if (saved) {
        try {
          api.fromJSON(saved);
          restored = api.panels.length > 0;
        } catch {
          restored = false;
        }
      }
      if (!restored) {
        seedDefaultLayout();
      }

      // Persist after the initial restore/seed so we never write an
      // empty or half-built layout. Best-effort: localStorage can be
      // unavailable or full. This is the "no project open" layout — a
      // reopened named project (below) overwrites it. Any layout change
      // (panels added / dragged / closed, columns resized) also marks
      // the workspace dirty.
      api.onDidLayoutChange(() => {
        diagCount("dockview.layoutChange"); // DIAG
        try {
          localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(api.toJSON()));
        } catch {
          /* layout persistence is best-effort */
        }
        setDirty(true);
      });

      // Perf self-driving flags (ADR 0031) override the last-opened
      // pointer: `--project` names the project deterministically. Fetch
      // the config first so the project it names is the one we open.
      void (async () => {
        let cfg: AutomationConfig | null = null;
        try {
          cfg = await invoke<AutomationConfig | null>("diag_autostart");
        } catch {
          /* no host / not armed — fall through to the last-opened path */
        }
        // Reopen the named project (automation) or the last one opened —
        // it replaces the layout restored above (and re-applies the
        // bus/DBC config). A stale pointer (file moved/deleted) is
        // cleared so it stops failing.
        const projectToOpen = cfg?.project ?? localStorage.getItem(LAST_PROJECT_KEY);
        if (projectToOpen) {
          try {
            const p = await invoke<Project>("open_project", { path: projectToOpen });
            applyProject(p, projectToOpen);
            rememberProject(projectToOpen);
            setDirty(false);
          } catch {
            rememberProject(null);
          }
        }
        // Hand off to the orchestration effect, which connects /
        // captures / exits per the flags once the project has applied.
        if (cfg) setAutomation(cfg);
      })();
    },
    [seedDefaultLayout, applyProject, rememberProject],
  );

  const status = useMemo(
    () => renderStatus(state, remoteSessions, dbcPaths, count, framesPerSecond, bufferSeconds),
    [state, remoteSessions, dbcPaths, count, framesPerSecond, bufferSeconds],
  );

  const traceData: TraceData = useMemo(() => {
    diagCount("memo.traceData"); // DIAG
    return { count, version, sessionStartSeconds, getFrame, ensureVisible };
  }, [count, version, sessionStartSeconds, getFrame, ensureVisible]);

  const elementRegistryValue: ElementRegistry = useMemo(
    () => ({
      entries: (diagCount("memo.elementRegistryValue"), registry), // DIAG

      get: (id) => registry.find((e) => e.element.id === id),
      create,
      ensure,
      updateTrace,
      update: updateElement,
      remove: removeElement,
    }),
    [registry, create, ensure, updateTrace, updateElement, removeElement],
  );

  const remoteConnected = Array.from(remoteSessions.values()).some(
    (s) => s.kind === "running" || s.kind === "connecting",
  );
  const connectedAddresses = useMemo(
    () =>
      Array.from(remoteSessions.entries())
        .filter(([, s]) => s.kind === "running")
        .map(([addr]) => addr),
    [remoteSessions],
  );
  // A bus is "connected" when its interface binding resolves to one
  // of the running session addresses. The transmit panel gates
  // send / start on this.
  const connectedBusIds = useMemo(() => {
    const set = new Set<string>();
    for (const b of interfaceBindings) {
      const resolved = resolveServer(b.server, sidecarAddress);
      if (resolved && connectedAddresses.includes(resolved)) {
        set.add(b.bus_id);
      }
    }
    return Array.from(set);
  }, [interfaceBindings, sidecarAddress, connectedAddresses]);

  // Buses whose live hardware config (snapshot taken at connect) no
  // longer matches the edited project. Only buses with an active
  // session contribute — there's nothing to be "pending against" for
  // a bus that isn't connected. Reconnect applies the change.
  const busesWithPendingHwConfig = useMemo(() => {
    const dirty: string[] = [];
    const connected = new Set(connectedBusIds);
    for (const bus of buses) {
      if (!connected.has(bus.id)) continue;
      const snapshot = busConfigInFlight.get(bus.id);
      if (!snapshot) continue;
      const speed = bus.speed_bps ?? null;
      const fd = bus.fd ?? null;
      const dataSpeed = bus.fd_data_speed_bps ?? null;
      if (
        snapshot.speed_bps !== speed ||
        snapshot.fd !== fd ||
        snapshot.fd_data_speed_bps !== dataSpeed
      ) {
        dirty.push(bus.id);
      }
    }
    return dirty;
  }, [buses, busConfigInFlight, connectedBusIds]);

  const blfPath =
    state.kind === "loading" || state.kind === "running" || state.kind === "done"
      ? state.result.blf_path
      : null;

  const projectContextValue: ProjectContextValue = useMemo(
    () => ({
      projectPath: (diagCount("memo.projectContextValue"), projectPath), // DIAG

      dirty,
      dbcPaths,
      dbcBuses,
      buses,
      interfaceBindings,
      connectedAddresses,
      remoteConnected,
      connectedBusIds,
      blfPath,
      onNewProject: handleNewProject,
      onOpenProject: handleOpenProject,
      onSaveProject: handleSaveProject,
      onSaveProjectAs: handleSaveProjectAs,
      onAddDbc: handleAddDbc,
      onRemoveDbc: handleRemoveDbc,
      onReloadDbc: handleReloadDbc,
      onSetDbcBuses: handleSetDbcBuses,
      onAddBus: handleAddBus,
      onRemoveBus: handleRemoveBus,
      onRenameBus: handleRenameBus,
      onSetBusColor: handleSetBusColor,
      onSetBusSpeed: handleSetBusSpeed,
      onSetBusFd: handleSetBusFd,
      onSetBusFdDataSpeed: handleSetBusFdDataSpeed,
      busesWithPendingHwConfig,
      onAddBinding: handleAddBinding,
      onRemoveBinding: handleRemoveBinding,
      onConnect: handleConnect,
      onDisconnect: handleDisconnect,
      localVirtualBuses,
      onAddVirtualBus: handleAddVirtualBus,
      onRemoveVirtualBus: handleRemoveVirtualBus,
      onUpdateVirtualBus: handleUpdateVirtualBus,
    }),
    [
      projectPath,
      dirty,
      dbcPaths,
      dbcBuses,
      buses,
      interfaceBindings,
      connectedAddresses,
      remoteConnected,
      connectedBusIds,
      blfPath,
      handleNewProject,
      handleOpenProject,
      handleSaveProject,
      handleSaveProjectAs,
      handleAddDbc,
      handleRemoveDbc,
      handleReloadDbc,
      handleSetDbcBuses,
      handleAddBus,
      handleRemoveBus,
      handleRenameBus,
      handleSetBusColor,
      handleSetBusSpeed,
      handleSetBusFd,
      handleSetBusFdDataSpeed,
      busesWithPendingHwConfig,
      handleAddBinding,
      handleRemoveBinding,
      handleConnect,
      handleDisconnect,
      localVirtualBuses,
      handleAddVirtualBus,
      handleRemoveVirtualBus,
      handleUpdateVirtualBus,
    ],
  );

  const pendingHwConfigBusNames = useMemo(
    () =>
      busesWithPendingHwConfig
        .map((id) => buses.find((b) => b.id === id)?.name)
        .filter((name): name is string => name != null),
    [busesWithPendingHwConfig, buses],
  );

  return (
    <main className="app">
      <TitleBar pendingHwConfigBusNames={pendingHwConfigBusNames} />
      <header>
        <div className="toolbar">
          <button onClick={handleOpenProject}>Open project…</button>
          <button onClick={handleSaveProject}>Save project</button>
          <span className="toolbar-separator" aria-hidden="true" />
          <button onClick={() => void handleOpenLog()}>Open BLF…</button>
          {recentBlfs.length > 0 && (
            <details className="recent-blfs">
              <summary
                role="button"
                aria-label={`Recent BLFs (${recentBlfs.length})`}
                title="Recent BLFs"
              >
                Recent
              </summary>
              <ul role="menu" className="recent-blfs-menu">
                {recentBlfs.map((p) => (
                  <li key={p} role="menuitem">
                    <button
                      onClick={(e) => {
                        // Close the <details> panel; React state
                        // drives the rest of the click.
                        const el = (e.currentTarget as HTMLElement)
                          .closest("details");
                        if (el instanceof HTMLDetailsElement) el.open = false;
                        void handleOpenLog(p);
                      }}
                      title={p}
                    >
                      {p}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button onClick={handleAddDbc}>Add DBC…</button>
          <span className="toolbar-separator" aria-hidden="true" />
          {remoteConnected ? (
            <button onClick={handleDisconnect}>Disconnect</button>
          ) : (
            <button
              onClick={handleConnect}
              disabled={interfaceBindings.length === 0}
              title={
                interfaceBindings.length === 0
                  ? "Add interface bindings in the project panel first"
                  : undefined
              }
            >
              Connect
            </button>
          )}
          <span className="toolbar-separator" aria-hidden="true" />
          <button onClick={handleClear} disabled={count === 0}>
            Clear
          </button>
          <button onClick={handleSaveCapture} disabled={count === 0}>
            Save capture…
          </button>
          <span className="toolbar-separator" aria-hidden="true" />
          <button onClick={addTracePanel}>Add trace</button>
          <button onClick={addPlotPanel}>Add plot panel</button>
          <button onClick={addTransmitPanel}>Add transmit panel</button>
          <button onClick={addRbsPanel}>Add RBS panel</button>
          <button onClick={addColorMapPanel}>Add color map</button>
          <button onClick={showDbcPanel}>DBC panel</button>
          <button onClick={showProjectGraphPanel}>Graph panel</button>
          <button onClick={showProjectPanel}>Project panel</button>
          <button
            onClick={showSystemMessagesPanel}
            className="system-messages-button"
            aria-label={
              unread > 0
                ? `System messages (${unread} unread)`
                : "System messages"
            }
          >
            System messages
            {unread > 0 && (
              <span className="system-messages-badge" aria-hidden="true">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        </div>
        <div className="status">{status}</div>
      </header>
      <ProjectContext.Provider value={projectContextValue}>
        <ElementRegistryContext.Provider value={elementRegistryValue}>
          <SystemLogContext.Provider value={systemLogValue}>
            <NotesContext.Provider value={notesValue}>
              <TraceDataContext.Provider value={traceData}>
                <PanelCommandsContext.Provider value={panelCommands}>
                  {/* dockview drags tabs with the HTML5 drag-and-drop API, which
                      Tauri's OS-level drag-drop handler breaks on WebView2 — hence
                      `dragDropEnabled: false` in tauri.conf.json. The GUI takes
                      files via the dialog plugin, not by drop, so nothing is lost. */}
                  <DockviewReact
                    className="dock-area"
                    theme={themeAbyss}
                    components={DOCK_COMPONENTS}
                    onReady={handleDockReady}
                  />
                </PanelCommandsContext.Provider>
              </TraceDataContext.Provider>
            </NotesContext.Provider>
          </SystemLogContext.Provider>
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>
      {openPalette === "commands" && (
        <PaletteModal
          placeholder="Run a command…"
          items={commandPaletteItems}
          onPick={(item) => {
            setOpenPalette(null);
            runCommand(item.id);
          }}
          onClose={() => setOpenPalette(null)}
        />
      )}
      {openPalette === "goto" && (
        <PaletteModal
          placeholder="Go to view…"
          items={gotoPaletteItems}
          onPick={(item) => {
            setOpenPalette(null);
            focusPanelById(item.id);
          }}
          onClose={() => setOpenPalette(null)}
        />
      )}
      {pendingClose && <CloseConfirmModal onChoice={pendingClose.resolve} />}
      {pendingBlf && (
        <BlfChannelMapModal
          blfPath={pendingBlf.blfPath}
          channels={pendingBlf.channels}
          buses={buses}
          onConfirm={handleBlfMapConfirm}
          onCancel={() => setPendingBlf(null)}
        />
      )}
    </main>
  );
}

function renderStatus(
  state: LogState,
  remoteSessions: ReadonlyMap<string, RemoteStatus>,
  dbcPaths: readonly string[],
  frameCount: number,
  framesPerSecond: number,
  bufferSeconds: number,
): string {
  const dbc =
    dbcPaths.length === 0
      ? "no DBC attached"
      : dbcPaths.length === 1
        ? `DBC: ${shortenPath(dbcPaths[0])}`
        : `${dbcPaths.length} DBCs`;
  const fps = framesPerSecond > 0 ? ` · ${formatRate(framesPerSecond)}` : "";
  const buf = bufferSeconds > 0 ? ` · ${formatDuration(bufferSeconds)} buffered` : "";

  // Remote sessions take priority over the BLF idle/done line — the
  // user is actively streaming. (BLF in-progress states render their
  // own line; remote and BLF rarely overlap because Connect clears
  // the trace store.)
  if (remoteSessions.size > 0) {
    const running = Array.from(remoteSessions.entries()).filter(
      ([, s]) => s.kind === "running",
    );
    const connecting = Array.from(remoteSessions.values()).filter(
      (s) => s.kind === "connecting",
    ).length;
    const errored = Array.from(remoteSessions.entries()).filter(
      ([, s]) => s.kind === "error",
    );
    const totalInterfaces = running.reduce((acc, [, s]) => {
      return s.kind === "running" ? acc + s.result.interfaces.length : acc;
    }, 0);
    const parts: string[] = [];
    if (running.length > 0) {
      parts.push(
        `Streaming from ${running.length} server${running.length === 1 ? "" : "s"} (${totalInterfaces} interface${totalInterfaces === 1 ? "" : "s"}, ${formatNumber(frameCount)} frames${fps}${buf})`,
      );
    }
    if (connecting > 0) parts.push(`${connecting} connecting`);
    if (errored.length > 0) {
      const first = errored[0];
      parts.push(
        errored[0][1].kind === "error"
          ? `${errored.length} error${errored.length === 1 ? "" : "s"} (${first[0]}: ${errored[0][1].message})`
          : `${errored.length} error${errored.length === 1 ? "" : "s"}`,
      );
    }
    return `${parts.join(" · ")}. ${dbc}.`;
  }

  switch (state.kind) {
    case "idle":
      return `Open a BLF log or connect to a server to begin. ${dbc}.`;
    case "loading":
      return `Opening ${shortenPath(state.result.blf_path)} … ${dbc}.`;
    case "running":
      return `Streaming ${shortenPath(state.result.blf_path)} (${formatNumber(frameCount)} frames${fps}${buf}). ${dbc}.`;
    case "done":
      return `Done: ${formatNumber(state.total)} frames from ${shortenPath(state.result.blf_path)}. ${dbc}.`;
    case "error":
      return `Error: ${state.message}`;
  }
}

function formatRate(fps: number): string {
  if (fps >= 10_000) return `${(fps / 1000).toFixed(1)}k fps`;
  if (fps >= 100) return `${Math.round(fps)} fps`;
  return `${fps.toFixed(1)} fps`;
}

/// Buffered-span readout as a `d:hh:mm:ss` clock, trimmed to the largest
/// non-zero segment (mm:ss minimum): `0:05`, `2:05`, `1:02:05`,
/// `3:01:02:05`. Lower segments are zero-padded once a higher one shows.
function formatDuration(seconds: number): string {
  const t = Math.floor(seconds);
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p = (n: number) => n.toString().padStart(2, "0");
  if (d > 0) return `${d}:${p(h)}:${p(m)}:${p(s)}`;
  if (h > 0) return `${h}:${p(m)}:${p(s)}`;
  return `${m}:${p(s)}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function shortenPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}
