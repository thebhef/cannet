import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { DockviewReact, themeAbyss } from "dockview";
import type { DockviewApi, DockviewReadyEvent } from "dockview";

import type {
  Bus,
  DbcInfo,
  DbcRef,
  InterfaceBinding,
  LogFinished,
  OpenLogResult,
  Project,
  ProjectElementKind,
  RemoteSessionResult,
  TraceFrameRecord,
  TraceGrew,
} from "./types";
import { PROJECT_SCHEMA_VERSION } from "./types";
import { TitleBar } from "./TitleBar";
import { TracePanel } from "./TracePanel";
import { ProjectPanel } from "./ProjectPanel";
import { PlotPanel } from "./PlotPanel";
import { TransmitPanel } from "./TransmitPanel";
import { TraceDataContext, type TraceData } from "./traceData";
import { ProjectContext, type ProjectContextValue } from "./projectContext";
import { CloseConfirmModal, type CloseChoice } from "./CloseConfirmModal";
import { BlfChannelMapModal } from "./BlfChannelMapModal";
import {
  ElementRegistryContext,
  type ElementRegistry,
  type RegistryEntry,
  isProjectElement,
} from "./projectElements";
import { type TraceState, clearedTrace, freshTrace, reanchorToSession } from "./trace";
import {
  BY_ID_PANEL_COMPONENT,
  LAST_PROJECT_KEY,
  LAYOUT_STORAGE_KEY,
  PLOT_PANEL_COMPONENT,
  PROJECT_PANEL_COMPONENT,
  TRACE_PANEL_COMPONENT,
  TRANSMIT_PANEL_COMPONENT,
  parseSavedLayout,
  validateLayout,
} from "./dockLayout";

type LogState =
  | { kind: "idle" }
  | { kind: "loading"; result: OpenLogResult }
  | { kind: "running"; result: OpenLogResult }
  | { kind: "done"; result: OpenLogResult; total: number }
  | { kind: "remote-connecting"; address: string }
  | { kind: "remote-running"; result: RemoteSessionResult }
  | { kind: "remote-done"; result: RemoteSessionResult; total: number }
  | { kind: "error"; message: string };

const DEFAULT_REMOTE_ADDRESS = "127.0.0.1:50051";

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
};

/// The project panel is a show/hide singleton — a fixed dockview id so
/// there's structurally only one.
const PROJECT_PANEL_ID = "project";

export function App() {
  const [count, setCount] = useState(0);
  const [framesPerSecond, setFramesPerSecond] = useState(0);

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
  // Phase 6: per-DBC bus scoping (path → bus ids). Empty list = unscoped.
  // Mirrors the host's `LoadedDbc.buses`; the project file carries the
  // canonical `dbcs: DbcRef[]` shape.
  const [dbcBuses, setDbcBuses] = useState<Record<string, string[]>>({});
  // Phase 6: logical buses + interface bindings. Project-owned state.
  const [buses, setBuses] = useState<Bus[]>([]);
  const [interfaceBindings, setInterfaceBindings] = useState<InterfaceBinding[]>([]);
  const [remoteAddress, setRemoteAddress] = useState(DEFAULT_REMOTE_ADDRESS);
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

  // Captured once: timestamp of absolute row 0. Survives the user
  // scrolling anywhere in the trace; reset on Clear / new source.
  const [baseTimestampSeconds, setBaseTimestampSeconds] = useState<number | null>(
    null,
  );

  // The dockview layout API, populated once `onReady` fires.
  const dockApiRef = useRef<DockviewApi | null>(null);
  // Monotonic counters for "Trace N" / "Plot N" panel titles.
  const panelCounterRef = useRef(0);
  // Current `dirty` / `handleSaveProject`, read by the (once-registered)
  // close-on-quit handler. Updated on every render below.
  const dirtyRef = useRef(false);
  const handleSaveProjectRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  // Current session frame count, mirrored into a ref so `create` /
  // `ensure` can anchor a new (empty, stopped) trace at *now*
  // without taking `count` as a dependency (it changes every tick).
  const countRef = useRef(0);
  countRef.current = count;

  // --- element registry ops ---
  const create = useCallback((kind: ProjectElementKind): string => {
    const id = crypto.randomUUID();
    setRegistry((prev) => [
      ...prev,
      { element: { kind, id }, trace: clearedTrace(countRef.current) },
    ]);
    return id;
  }, []);
  const ensure = useCallback((id: string, kind: ProjectElementKind) => {
    setRegistry((prev) => {
      const i = prev.findIndex((e) => e.element.id === id);
      if (i < 0) return [...prev, { element: { kind, id }, trace: clearedTrace(countRef.current) }];
      if (prev[i].element.kind === kind) return prev;
      const next = prev.slice();
      next[i] = { ...next[i], element: { kind, id } };
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
      return changed ? next : prev;
    });
  }, []);
  const removeElement = useCallback((id: string) => {
    setRegistry((prev) => prev.filter((e) => e.element.id !== id));
    const api = dockApiRef.current;
    const panel = api?.panels.find(
      (p) => (p.params as { elementId?: unknown } | undefined)?.elementId === id,
    );
    if (api && panel) api.removePanel(panel);
  }, []);
  const plotCounterRef = useRef(0);

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

  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [];

    unlistens.push(
      listen<TraceGrew>("trace-grew", (event) => {
        const { count: newCount, frames_per_second, tail } = event.payload;
        setCount((prev) => {
          if (newCount < prev) {
            invalidateCache();
            setBaseTimestampSeconds(null);
          }
          return newCount;
        });
        setFramesPerSecond(frames_per_second);
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
            if (s.kind === "remote-connecting") {
              return { kind: "idle" };
            }
            if (s.kind === "remote-running") {
              return { kind: "remote-done", result: s.result, total };
            }
            return s;
          });
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
      return changed ? next : prev;
    });
  }, [count]);

  // Once row 0 is available, capture its timestamp as the zero-point
  // for the time column.
  useEffect(() => {
    if (baseTimestampSeconds !== null) return;
    if (count === 0) return;
    void invoke<TraceFrameRecord[]>("fetch_trace_range", {
      start: 0,
      end: 1,
    }).then((frames) => {
      if (frames.length > 0) {
        setBaseTimestampSeconds(frames[0].timestamp_seconds);
      }
    });
  }, [count, baseTimestampSeconds]);

  // Phase 6: BLF import gained a channel → bus mapping step. The
  // outer pending state holds the picked BLF path + its distinct
  // channel list while the modal is open; clicking "Open" in the
  // modal commits and the host pump starts.
  const [pendingBlf, setPendingBlf] = useState<{
    blfPath: string;
    channels: number[];
  } | null>(null);

  const handleOpenLog = useCallback(async () => {
    const selected = await open({
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
    }
  }, []);

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
        setBaseTimestampSeconds(null);
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
      } catch (err) {
        setState({ kind: "error", message: String(err) });
      }
    },
    [pendingBlf, invalidateCache, startAllElements],
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
  // dropped and reported together. Phase 6: `scoping` (path → bus_id[])
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
    setBaseTimestampSeconds(null);
    setCount(0);
    startAllElements();
  }, [invalidateCache, startAllElements]);

  const handleConnect = useCallback(async () => {
    const address = remoteAddress.trim();
    if (!address) return;

    try {
      await invoke("clear_trace_store");
      invalidateCache();
      setBaseTimestampSeconds(null);
      setCount(0);
      startAllElements();
      setState({ kind: "remote-connecting", address });
      // Phase 6: send the project's interface bindings for this
      // server so the pump can tag each subscribed frame with its
      // logical bus_id. Interfaces without a binding stream through
      // unassigned.
      const bindings = interfaceBindings
        .filter((b) => b.server === address)
        .map((b) => ({ interface: b.interface, busId: b.bus_id }));
      const result = await invoke<RemoteSessionResult>("connect_remote_server", {
        address,
        bindings,
      });
      setState({ kind: "remote-running", result });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, [remoteAddress, invalidateCache, startAllElements, interfaceBindings]);

  const handleDisconnect = useCallback(async () => {
    try {
      await invoke("disconnect_remote_server");
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
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
    panelCounterRef.current = 1;
  }, [create]);

  /// Snapshot the current workspace into a `Project` (the elements, not
  /// their runtime state — that re-anchors on reload). Phase 6 emits
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
        remote_address: remoteAddress.trim() || null,
      };
    },
    [registry, dbcPaths, dbcBuses, buses, interfaceBindings, remoteAddress],
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
    (project: Project) => {
      // Restore the element registry first so the panels `fromJSON`
      // creates (which reference elements by `params.elementId`) find
      // their entries. (A panel that doesn't still self-heals.)
      setRegistry(
        (Array.isArray(project.elements) ? project.elements : [])
          .filter(isProjectElement)
          .map((el) => ({ element: el, trace: clearedTrace(countRef.current) })),
      );
      const api = dockApiRef.current;
      const layout = validateLayout(project.layout);
      if (api && layout) {
        try {
          api.fromJSON(layout);
          panelCounterRef.current = api.panels.length;
        } catch {
          /* keep the current layout if the saved one won't load */
        }
      }
      setRemoteAddress(project.remote_address ?? DEFAULT_REMOTE_ADDRESS);
      // Phase 6: pull bus / binding state, then load DBCs with their
      // bus scoping. `loadDbcSet` takes the scoping map so each DBC
      // is committed to the host with the right `buses`.
      const incomingBuses = Array.isArray(project.buses) ? project.buses : [];
      const incomingBindings = Array.isArray(project.interface_bindings)
        ? project.interface_bindings
        : [];
      const incomingDbcs: DbcRef[] = Array.isArray(project.dbcs) ? project.dbcs : [];
      setBuses(incomingBuses);
      setInterfaceBindings(incomingBindings);
      const scoping: Record<string, string[]> = {};
      for (const d of incomingDbcs) scoping[d.path] = d.buses ?? [];
      setDbcBuses(scoping);
      void loadDbcSet(
        incomingDbcs.map((d) => d.path),
        scoping,
      );
    },
    [loadDbcSet],
  );

  const handleNewProject = useCallback(() => {
    // Fresh workspace: seed layout, no open project, no DBCs, no
    // session — disconnect and clear the buffer too.
    seedDefaultLayout();
    rememberProject(null);
    void loadDbcSet([], {});
    setDbcBuses({});
    setBuses([]);
    setInterfaceBindings([]);
    void invoke("disconnect_remote_server").catch(() => {});
    void invoke("clear_trace_store").catch(() => {});
    invalidateCache();
    setBaseTimestampSeconds(null);
    setCount(0);
    setDirty(false);
  }, [seedDefaultLayout, rememberProject, loadDbcSet, invalidateCache]);

  const handleOpenProject = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "cannet project", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const project = await invoke<Project>("open_project", { path: selected });
      applyProject(project);
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
      filters: [{ name: "cannet project", extensions: ["json"] }],
      defaultPath: projectPath ?? "cannet-project.json",
    });
    if (!path) return false;
    return saveProjectTo(path);
  }, [projectPath, saveProjectTo]);

  const handleSaveProject = useCallback(
    (): Promise<boolean> => (projectPath ? saveProjectTo(projectPath) : handleSaveProjectAs()),
    [projectPath, saveProjectTo, handleSaveProjectAs],
  );

  // The close-on-quit handler is registered once; give it refs to the
  // current values rather than re-registering on every change.
  dirtyRef.current = dirty;
  handleSaveProjectRef.current = handleSaveProject;
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win
      .onCloseRequested(async (event) => {
        if (!dirtyRef.current) return; // no unsaved changes — let it close
        event.preventDefault();
        const choice = await new Promise<CloseChoice>((resolve) =>
          setPendingClose({ resolve }),
        );
        setPendingClose(null);
        if (choice === "cancel") return;
        if (choice === "save" && !(await handleSaveProjectRef.current())) return; // picker cancelled
        void win.destroy();
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  // Re-read every loaded DBC from disk (a file that's gone or no longer
  // parses drops out, with an error). No-op when none are loaded.
  // Phase 6: preserve per-DBC bus scoping across the reload.
  const handleReloadDbc = useCallback(() => {
    if (dbcPaths.length > 0) void loadDbcSet(dbcPaths, dbcBuses);
  }, [dbcPaths, dbcBuses, loadDbcSet]);

  // Phase 6: update a single DBC's bus scoping and push it to the host.
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

  // Phase 6: bus list mutations (add / rename / remove). Pure project
  // state; the host doesn't need a separate command (the buses ride
  // through the project file, and the per-DBC scoping refresh below
  // re-publishes the canonical set when a rename / remove changes ids).
  const handleAddBus = useCallback((bus: Bus) => {
    setBuses((prev) => (prev.some((b) => b.id === bus.id) ? prev : [...prev, bus]));
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
  // Phase 6: interface-binding mutations.
  const handleAddBinding = useCallback((binding: InterfaceBinding) => {
    setInterfaceBindings((prev) => {
      // Last-write-wins on (server, interface).
      const filtered = prev.filter(
        (b) => !(b.server === binding.server && b.interface === binding.interface),
      );
      return [...filtered, binding];
    });
    setDirty(true);
  }, []);
  const handleRemoveBinding = useCallback((server: string, iface: string) => {
    setInterfaceBindings((prev) =>
      prev.filter((b) => !(b.server === server && b.interface === iface)),
    );
    setDirty(true);
  }, []);

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

  const addTracePanel = useCallback(() => {
    const api = dockApiRef.current;
    if (!api) return;
    const elementId = create("trace");
    panelCounterRef.current += 1;
    // A new trace starts in by-id mode (toggle it in the panel toolbar).
    api.addPanel({
      id: `trace-${elementId}`,
      component: TRACE_PANEL_COMPONENT,
      title: `Trace ${panelCounterRef.current}`,
      params: { elementId, mode: "by-id" },
    });
  }, [create]);

  const addPlotPanel = useCallback(() => {
    const api = dockApiRef.current;
    if (!api) return;
    const elementId = create("plot");
    plotCounterRef.current += 1;
    api.addPanel({
      id: `plot-${elementId}`,
      component: PLOT_PANEL_COMPONENT,
      title: `Plot ${plotCounterRef.current}`,
      params: { elementId },
    });
  }, [create]);

  const transmitCounterRef = useRef(0);
  const addTransmitPanel = useCallback(() => {
    const api = dockApiRef.current;
    if (!api) return;
    const elementId = create("transmit");
    transmitCounterRef.current += 1;
    api.addPanel({
      id: `transmit-${elementId}`,
      component: TRANSMIT_PANEL_COMPONENT,
      title: `Transmit ${transmitCounterRef.current}`,
      params: { elementId, frames: [] },
    });
  }, [create]);

  const toggleProjectPanel = useCallback(() => {
    const api = dockApiRef.current;
    if (!api) return;
    const existing = api.panels.find((p) => p.id === PROJECT_PANEL_ID);
    if (existing) {
      api.removePanel(existing);
    } else {
      api.addPanel({
        id: PROJECT_PANEL_ID,
        component: PROJECT_PANEL_COMPONENT,
        title: "Project",
        position: { direction: "left" },
      });
    }
  }, []);

  const handleDockReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      dockApiRef.current = api;

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
      if (restored) {
        // Keep numbering past whatever the restored layout already shows.
        panelCounterRef.current = api.panels.length;
      } else {
        seedDefaultLayout();
      }

      // Persist after the initial restore/seed so we never write an
      // empty or half-built layout. Best-effort: localStorage can be
      // unavailable or full. This is the "no project open" layout — a
      // reopened named project (below) overwrites it. Any layout change
      // (panels added / dragged / closed, columns resized) also marks
      // the workspace dirty.
      api.onDidLayoutChange(() => {
        try {
          localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(api.toJSON()));
        } catch {
          /* layout persistence is best-effort */
        }
        setDirty(true);
      });

      // Reopen the last named project, if any — it replaces the layout
      // restored above (and re-applies the bus/DBC config). A stale
      // pointer (file moved/deleted) is cleared so it stops failing.
      const lastProject = localStorage.getItem(LAST_PROJECT_KEY);
      if (lastProject) {
        void invoke<Project>("open_project", { path: lastProject })
          .then((p) => {
            applyProject(p);
            rememberProject(lastProject);
            setDirty(false);
          })
          .catch(() => rememberProject(null));
      }
    },
    [seedDefaultLayout, applyProject, rememberProject],
  );

  const status = useMemo(
    () => renderStatus(state, dbcPaths, count, framesPerSecond),
    [state, dbcPaths, count, framesPerSecond],
  );

  const traceData: TraceData = useMemo(
    () => ({ count, version, baseTimestampSeconds, getFrame, ensureVisible }),
    [count, version, baseTimestampSeconds, getFrame, ensureVisible],
  );

  const elementRegistryValue: ElementRegistry = useMemo(
    () => ({
      entries: registry,
      get: (id) => registry.find((e) => e.element.id === id),
      create,
      ensure,
      updateTrace,
      remove: removeElement,
    }),
    [registry, create, ensure, updateTrace, removeElement],
  );

  const remoteConnected =
    state.kind === "remote-connecting" || state.kind === "remote-running";

  const blfPath =
    state.kind === "loading" || state.kind === "running" || state.kind === "done"
      ? state.result.blf_path
      : null;

  const projectContextValue: ProjectContextValue = useMemo(
    () => ({
      projectPath,
      dirty,
      dbcPaths,
      dbcBuses,
      buses,
      interfaceBindings,
      remoteAddress,
      remoteConnected,
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
      onAddBinding: handleAddBinding,
      onRemoveBinding: handleRemoveBinding,
      onConnect: handleConnect,
      onDisconnect: handleDisconnect,
    }),
    [
      projectPath,
      dirty,
      dbcPaths,
      dbcBuses,
      buses,
      interfaceBindings,
      remoteAddress,
      remoteConnected,
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
      handleAddBinding,
      handleRemoveBinding,
      handleConnect,
      handleDisconnect,
    ],
  );

  return (
    <main className="app">
      <TitleBar />
      <header>
        <div className="toolbar">
          <button onClick={handleOpenProject}>Open project…</button>
          <button onClick={handleSaveProject}>Save project</button>
          <span className="toolbar-separator" aria-hidden="true" />
          <button onClick={handleOpenLog}>Open BLF…</button>
          <button onClick={handleAddDbc}>Add DBC…</button>
          <span className="toolbar-separator" aria-hidden="true" />
          <input
            className="remote-address"
            type="text"
            value={remoteAddress}
            onChange={(e) => {
              setRemoteAddress(e.target.value);
              setDirty(true);
            }}
            placeholder="host:port"
            disabled={remoteConnected}
            aria-label="remote server address"
          />
          {remoteConnected ? (
            <button onClick={handleDisconnect}>Disconnect</button>
          ) : (
            <button onClick={handleConnect} disabled={!remoteAddress.trim()}>
              Connect
            </button>
          )}
          <span className="toolbar-separator" aria-hidden="true" />
          <button onClick={handleClear} disabled={count === 0}>
            Clear
          </button>
          <span className="toolbar-separator" aria-hidden="true" />
          <button onClick={addTracePanel}>Add trace</button>
          <button onClick={addPlotPanel}>Add plot panel</button>
          <button onClick={addTransmitPanel}>Add transmit panel</button>
          <button onClick={toggleProjectPanel}>Project panel</button>
        </div>
        <div className="status">{status}</div>
      </header>
      <ProjectContext.Provider value={projectContextValue}>
        <ElementRegistryContext.Provider value={elementRegistryValue}>
          <TraceDataContext.Provider value={traceData}>
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
          </TraceDataContext.Provider>
        </ElementRegistryContext.Provider>
      </ProjectContext.Provider>
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
  dbcPaths: readonly string[],
  frameCount: number,
  framesPerSecond: number,
): string {
  const dbc =
    dbcPaths.length === 0
      ? "no DBC attached"
      : dbcPaths.length === 1
        ? `DBC: ${shortenPath(dbcPaths[0])}`
        : `${dbcPaths.length} DBCs`;
  const fps = framesPerSecond > 0 ? ` · ${formatRate(framesPerSecond)}` : "";
  switch (state.kind) {
    case "idle":
      return `Open a BLF log or connect to a server to begin. ${dbc}.`;
    case "loading":
      return `Opening ${shortenPath(state.result.blf_path)} … ${dbc}.`;
    case "running":
      return `Streaming ${shortenPath(state.result.blf_path)} (${formatNumber(frameCount)} frames${fps}). ${dbc}.`;
    case "done":
      return `Done: ${formatNumber(state.total)} frames from ${shortenPath(state.result.blf_path)}. ${dbc}.`;
    case "remote-connecting":
      return `Connecting to ${state.address} … ${dbc}.`;
    case "remote-running": {
      const ifaces = state.result.interfaces.length;
      return `Streaming from ${state.result.address} (${ifaces} interface${ifaces === 1 ? "" : "s"}, ${formatNumber(frameCount)} frames${fps}). ${dbc}.`;
    }
    case "remote-done":
      return `Disconnected from ${state.result.address}: ${formatNumber(state.total)} frames received. ${dbc}.`;
    case "error":
      return `Error: ${state.message}`;
  }
}

function formatRate(fps: number): string {
  if (fps >= 10_000) return `${(fps / 1000).toFixed(1)}k fps`;
  if (fps >= 100) return `${Math.round(fps)} fps`;
  return `${fps.toFixed(1)} fps`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function shortenPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}
