import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  DbcInfo,
  LogFinished,
  OpenLogResult,
  RemoteSessionResult,
  TraceFrameRecord,
  TraceGrew,
} from "./types";
import { TitleBar } from "./TitleBar";
import { TraceView } from "./TraceView";

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

export function App() {
  const [count, setCount] = useState(0);
  const [framesPerSecond, setFramesPerSecond] = useState(0);

  // Scroll mode. While `autoScroll` is true the trace view pins to
  // the live tail; while false the view stays anchored at
  // `anchorRow` even as count grows.
  const [autoScroll, setAutoScroll] = useState(true);
  const [anchorRow, setAnchorRow] = useState(0);

  // Chunked cache of fetched trace rows, keyed by chunk index.
  const chunkCacheRef = useRef<Map<number, TraceFrameRecord[]>>(new Map());
  const cacheOrderRef = useRef<number[]>([]);
  const inflightChunksRef = useRef<Set<number>>(new Set());
  const [version, setVersion] = useState(0);

  const [state, setState] = useState<LogState>({ kind: "idle" });
  const [dbcPath, setDbcPath] = useState<string | null>(null);
  const [remoteAddress, setRemoteAddress] = useState(DEFAULT_REMOTE_ADDRESS);

  // Captured once: timestamp of absolute row 0. Survives the user
  // scrolling anywhere in the trace; reset on Clear / new source.
  const [baseTimestampSeconds, setBaseTimestampSeconds] = useState<number | null>(
    null,
  );

  const invalidateCache = useCallback(() => {
    chunkCacheRef.current.clear();
    cacheOrderRef.current = [];
    inflightChunksRef.current.clear();
    setVersion((v) => v + 1);
  }, []);

  const resetView = useCallback(() => {
    setAutoScroll(true);
    setAnchorRow(0);
    setBaseTimestampSeconds(null);
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

  // Replace partial chunks (cached length < CHUNK_SIZE) in place when
  // their tail grows so already-visible rows don't go through a
  // missing intermediate state on the next paint.
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
        const { count: newCount, frames_per_second } = event.payload;
        setCount((prev) => {
          if (newCount < prev) {
            invalidateCache();
            setBaseTimestampSeconds(null);
          }
          return newCount;
        });
        setFramesPerSecond(frames_per_second);
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
      resetView();
      const result = await invoke<OpenLogResult>("open_log", {
        blfPath: selected,
      });
      setState({ kind: "loading", result });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, [invalidateCache, resetView]);

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
    resetView();
    setCount(0);
  }, [invalidateCache, resetView]);

  const handleConnect = useCallback(async () => {
    const address = remoteAddress.trim();
    if (!address) return;

    try {
      await invoke("clear_trace_store");
      invalidateCache();
      resetView();
      setState({ kind: "remote-connecting", address });
      const result = await invoke<RemoteSessionResult>("connect_remote_server", {
        address,
      });
      setState({ kind: "remote-running", result });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, [remoteAddress, invalidateCache, resetView]);

  const handleDisconnect = useCallback(async () => {
    try {
      await invoke("disconnect_remote_server");
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, []);

  // The trace view calls this when the user moves the scroll bar
  // themselves. Turn off live-tailing and remember where they
  // anchored so subsequent count growth doesn't drag them along.
  const handleUserScroll = useCallback((newAnchorRow: number) => {
    setAutoScroll(false);
    setAnchorRow(newAnchorRow);
  }, []);

  const handleToggleAutoScroll = useCallback((next: boolean) => {
    setAutoScroll(next);
  }, []);

  const getFrame = useCallback((index: number): TraceFrameRecord | null => {
    const chunkIdx = Math.floor(index / CHUNK_SIZE);
    const chunk = chunkCacheRef.current.get(chunkIdx);
    if (!chunk) return null;
    return chunk[index - chunkIdx * CHUNK_SIZE] ?? null;
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

  const status = useMemo(
    () => renderStatus(state, dbcPath, count, framesPerSecond),
    [state, dbcPath, count, framesPerSecond],
  );

  const remoteConnected =
    state.kind === "remote-connecting" || state.kind === "remote-running";

  return (
    <main className="app">
      <TitleBar />
      <header>
        <div className="toolbar">
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
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => handleToggleAutoScroll(e.target.checked)}
            />
            auto-scroll
          </label>
        </div>
        <div className="status">{status}</div>
      </header>
      <TraceView
        count={count}
        version={version}
        autoScroll={autoScroll}
        anchorRow={anchorRow}
        baseTimestampSeconds={baseTimestampSeconds}
        getFrame={getFrame}
        ensureVisible={ensureVisible}
        onUserScroll={handleUserScroll}
      />
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
