import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { DockviewReact, themeAbyss } from "dockview";
import type { DockviewApi, DockviewReadyEvent } from "dockview";

import type {
  DbcInfo,
  LogFinished,
  OpenLogResult,
  Project,
  RemoteSessionResult,
  TraceFrameRecord,
  TraceGrew,
} from "./types";
import { PROJECT_SCHEMA_VERSION } from "./types";
import { TitleBar } from "./TitleBar";
import { TracePanel } from "./TracePanel";
import { ByIdPanel } from "./ByIdPanel";
import { TraceDataContext, type TraceData } from "./traceData";
import {
  BY_ID_PANEL_COMPONENT,
  LAYOUT_STORAGE_KEY,
  TRACE_PANEL_COMPONENT,
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
/// dockview never sees a fresh object and re-registers.
const DOCK_COMPONENTS = {
  [TRACE_PANEL_COMPONENT]: TracePanel,
  [BY_ID_PANEL_COMPONENT]: ByIdPanel,
};

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
  const [dbcPath, setDbcPath] = useState<string | null>(null);
  const [remoteAddress, setRemoteAddress] = useState(DEFAULT_REMOTE_ADDRESS);

  // Captured once: timestamp of absolute row 0. Survives the user
  // scrolling anywhere in the trace; reset on Clear / new source.
  const [baseTimestampSeconds, setBaseTimestampSeconds] = useState<number | null>(
    null,
  );

  // The dockview layout API, populated once `onReady` fires.
  const dockApiRef = useRef<DockviewApi | null>(null);
  // Monotonic counters for "Trace N" / "By ID N" panel titles.
  const panelCounterRef = useRef(0);
  const byIdCounterRef = useRef(0);

  const invalidateCache = useCallback(() => {
    chunkCacheRef.current.clear();
    cacheOrderRef.current = [];
    inflightChunksRef.current.clear();
    tailFramesRef.current = [];
    tailStartRef.current = 0;
    setVersion((v) => v + 1);
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

  const handleOpenLog = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Vector BLF", extensions: ["blf"] }],
    });
    if (typeof selected !== "string") return;

    try {
      await invoke("clear_trace_store");
      invalidateCache();
      setBaseTimestampSeconds(null);
      const result = await invoke<OpenLogResult>("open_log", {
        blfPath: selected,
      });
      setState({ kind: "loading", result });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, [invalidateCache]);

  const handleAttachDbc = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "DBC", extensions: ["dbc"] }],
    });
    if (typeof selected !== "string") return;

    try {
      const info = await invoke<DbcInfo>("attach_dbc", { path: selected });
      setDbcPath(info.dbc_path);
    } catch (err) {
      setState({ kind: "error", message: String(err) });
      return;
    }
    invalidateCache();
  }, [invalidateCache]);

  const handleClear = useCallback(async () => {
    try {
      await invoke("clear_trace_store");
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
    invalidateCache();
    setBaseTimestampSeconds(null);
    setCount(0);
  }, [invalidateCache]);

  const handleConnect = useCallback(async () => {
    const address = remoteAddress.trim();
    if (!address) return;

    try {
      await invoke("clear_trace_store");
      invalidateCache();
      setBaseTimestampSeconds(null);
      setState({ kind: "remote-connecting", address });
      const result = await invoke<RemoteSessionResult>("connect_remote_server", {
        address,
      });
      setState({ kind: "remote-running", result });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, [remoteAddress, invalidateCache]);

  const handleDisconnect = useCallback(async () => {
    try {
      await invoke("disconnect_remote_server");
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, []);

  // Apply an opened project: restore the panel layout, the remote
  // address field, and (re-)attach the referenced DBC. Doesn't touch a
  // live connection — the project's bus is configured into the fields;
  // hit Connect to switch. (Per-panel config — column layouts, the
  // panels' trace windows — isn't carried yet, so panels come back at
  // their defaults; that's a later project-file step.)
  const applyProject = useCallback(
    (project: Project) => {
      const api = dockApiRef.current;
      const layout = validateLayout(project.layout);
      if (api && layout) {
        try {
          api.fromJSON(layout);
          panelCounterRef.current = api.panels.length;
          byIdCounterRef.current = api.panels.length;
        } catch {
          /* keep the current layout if the saved one won't load */
        }
      }
      setRemoteAddress(project.remote_address ?? DEFAULT_REMOTE_ADDRESS);
      if (project.dbc_path) {
        const path = project.dbc_path;
        void invoke<DbcInfo>("attach_dbc", { path })
          .then((info) => {
            setDbcPath(info.dbc_path);
            invalidateCache();
          })
          .catch((err) =>
            setState({ kind: "error", message: `project DBC (${path}): ${String(err)}` }),
          );
      }
    },
    [invalidateCache],
  );

  const handleOpenProject = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "cannet project", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return;
    try {
      const project = await invoke<Project>("open_project", { path: selected });
      applyProject(project);
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, [applyProject]);

  const handleSaveProjectAs = useCallback(async () => {
    const path = await save({
      filters: [{ name: "cannet project", extensions: ["json"] }],
      defaultPath: "cannet-project.json",
    });
    if (!path) return;
    const project: Project = {
      schema_version: PROJECT_SCHEMA_VERSION,
      layout: dockApiRef.current?.toJSON() ?? { grid: {}, panels: {} },
      dbc_path: dbcPath,
      remote_address: remoteAddress.trim() || null,
    };
    try {
      await invoke("save_project", { path, project });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, [dbcPath, remoteAddress]);

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
    panelCounterRef.current += 1;
    api.addPanel({
      id: `trace-${crypto.randomUUID()}`,
      component: TRACE_PANEL_COMPONENT,
      title: `Trace ${panelCounterRef.current}`,
    });
  }, []);

  const addByIdPanel = useCallback(() => {
    const api = dockApiRef.current;
    if (!api) return;
    byIdCounterRef.current += 1;
    api.addPanel({
      id: `by-id-${crypto.randomUUID()}`,
      component: BY_ID_PANEL_COMPONENT,
      title: `By ID ${byIdCounterRef.current}`,
    });
  }, []);

  const handleDockReady = useCallback((event: DockviewReadyEvent) => {
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
      api.clear();
      panelCounterRef.current = 1;
      api.addPanel({
        id: `trace-${crypto.randomUUID()}`,
        component: TRACE_PANEL_COMPONENT,
        title: "Trace 1",
      });
    }

    // Persist only after the initial restore/seed so we never write an
    // empty or half-built layout. Best-effort: localStorage can be
    // unavailable or full, and this is a placeholder until project
    // files own the layout.
    api.onDidLayoutChange(() => {
      try {
        localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(api.toJSON()));
      } catch {
        /* layout persistence is best-effort */
      }
    });
  }, []);

  const status = useMemo(
    () => renderStatus(state, dbcPath, count, framesPerSecond),
    [state, dbcPath, count, framesPerSecond],
  );

  const traceData: TraceData = useMemo(
    () => ({ count, version, baseTimestampSeconds, getFrame, ensureVisible }),
    [count, version, baseTimestampSeconds, getFrame, ensureVisible],
  );

  const remoteConnected =
    state.kind === "remote-connecting" || state.kind === "remote-running";

  return (
    <main className="app">
      <TitleBar />
      <header>
        <div className="toolbar">
          <button onClick={handleOpenProject}>Open project…</button>
          <button onClick={handleSaveProjectAs}>Save project as…</button>
          <span className="toolbar-separator" aria-hidden="true" />
          <button onClick={handleOpenLog}>Open BLF…</button>
          <button onClick={handleAttachDbc}>
            {dbcPath ? "Replace DBC…" : "Attach DBC…"}
          </button>
          <span className="toolbar-separator" aria-hidden="true" />
          <input
            className="remote-address"
            type="text"
            value={remoteAddress}
            onChange={(e) => setRemoteAddress(e.target.value)}
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
          <button onClick={addTracePanel}>Add trace panel</button>
          <button onClick={addByIdPanel}>Add by-ID panel</button>
        </div>
        <div className="status">{status}</div>
      </header>
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
    </main>
  );
}

function renderStatus(
  state: LogState,
  dbcPath: string | null,
  frameCount: number,
  framesPerSecond: number,
): string {
  const dbc = dbcPath ? `DBC: ${shortenPath(dbcPath)}` : "no DBC attached";
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
