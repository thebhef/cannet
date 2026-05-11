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

/// Number of frames per cache chunk. The trace view's virtualizer asks
/// for individual rows; we serve them out of a per-chunk cache, so
/// fetching a missing row pulls its whole chunk in one IPC round-trip.
const CHUNK_SIZE = 500;
/// LRU budget for the chunk cache. With 500-frame chunks this is 5 000
/// frames, enough to cover a deep viewport plus generous prefetch
/// without creeping back toward the original "everything in memory"
/// problem.
const CACHE_CHUNKS = 10;

export function App() {
  const [count, setCount] = useState(0);
  const [framesPerSecond, setFramesPerSecond] = useState(0);

  // Chunked cache of fetched trace rows. Keyed by chunk index
  // (= floor(absoluteIndex / CHUNK_SIZE)).
  const chunkCacheRef = useRef<Map<number, TraceFrameRecord[]>>(new Map());
  const cacheOrderRef = useRef<number[]>([]); // LRU, oldest first
  const inflightChunksRef = useRef<Set<number>>(new Set());
  const [version, setVersion] = useState(0);

  const [state, setState] = useState<LogState>({ kind: "idle" });

  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [dbcPath, setDbcPath] = useState<string | null>(null);
  const [remoteAddress, setRemoteAddress] = useState(DEFAULT_REMOTE_ADDRESS);

  const invalidateCache = useCallback(() => {
    chunkCacheRef.current.clear();
    cacheOrderRef.current = [];
    inflightChunksRef.current.clear();
    setVersion((v) => v + 1);
  }, []);

  // Drop any cached chunk whose tail has grown past the cached length.
  // A chunk fetched while the store was still growing arrives partial
  // (cached length < CHUNK_SIZE); without this, those rows would
  // render as placeholders forever because ensureVisible treats
  // "in cache" as "complete".
  const evictStalePartialChunks = useCallback((newCount: number) => {
    const toEvict: number[] = [];
    for (const [chunkIdx, chunk] of chunkCacheRef.current) {
      const chunkStart = chunkIdx * CHUNK_SIZE;
      if (chunk.length < CHUNK_SIZE && chunkStart + chunk.length < newCount) {
        toEvict.push(chunkIdx);
      }
    }
    if (toEvict.length === 0) return;
    for (const c of toEvict) chunkCacheRef.current.delete(c);
    cacheOrderRef.current = cacheOrderRef.current.filter(
      (c) => !toEvict.includes(c),
    );
    setVersion((v) => v + 1);
  }, []);

  // Wire up Tauri event listeners once.
  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [];

    unlistens.push(
      listen<TraceGrew>("trace-grew", (event) => {
        const { count: newCount, frames_per_second } = event.payload;
        setCount((prev) => {
          // Count went down → store was cleared; drop the cache.
          if (newCount < prev) invalidateCache();
          return newCount;
        });
        setFramesPerSecond(frames_per_second);
        evictStalePartialChunks(newCount);
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
              // Server hung up before any frames arrived (rare).
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
  }, [invalidateCache, evictStalePartialChunks]);

  const handleOpenLog = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Vector BLF", extensions: ["blf"] }],
    });
    if (typeof selected !== "string") return;

    try {
      await invoke("clear_trace_store");
      invalidateCache();
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

    // The store's frames are unchanged but their decoded view just did,
    // so cached chunks are stale. Drop them; the next render refetches.
    invalidateCache();
  }, [invalidateCache]);

  const handleClear = useCallback(async () => {
    try {
      await invoke("clear_trace_store");
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
    // The trace-grew listener will fire shortly with count=0 and
    // invalidate the cache; do it eagerly here too so the UI reflects
    // immediately.
    invalidateCache();
    setCount(0);
  }, [invalidateCache]);

  const handleConnect = useCallback(async () => {
    const address = remoteAddress.trim();
    if (!address) return;

    try {
      await invoke("clear_trace_store");
      invalidateCache();
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

  const fetchChunk = useCallback(async (chunkIdx: number) => {
    if (chunkCacheRef.current.has(chunkIdx)) return;
    if (inflightChunksRef.current.has(chunkIdx)) return;
    inflightChunksRef.current.add(chunkIdx);
    try {
      const start = chunkIdx * CHUNK_SIZE;
      const end = start + CHUNK_SIZE;
      const frames = await invoke<TraceFrameRecord[]>("fetch_trace_range", {
        start,
        end,
      });
      // The store may have been cleared between request and response.
      // Cache the chunk regardless — out-of-range rows just won't be
      // looked up by getFrame, and the LRU drops them soon enough.
      chunkCacheRef.current.set(chunkIdx, frames);
      cacheOrderRef.current = cacheOrderRef.current.filter(
        (c) => c !== chunkIdx,
      );
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

  // Synchronous lookup for the trace view. Returns null if the
  // covering chunk hasn't been fetched yet; the trace view renders a
  // placeholder and calls ensureVisible. The closure reads from refs,
  // so it stays correct without re-binding.
  const getFrame = useCallback(
    (index: number): TraceFrameRecord | null => {
      const chunkIdx = Math.floor(index / CHUNK_SIZE);
      const chunk = chunkCacheRef.current.get(chunkIdx);
      if (!chunk) return null;
      return chunk[index - chunkIdx * CHUNK_SIZE] ?? null;
    },
    [],
  );

  const ensureVisible = useCallback(
    (startIndex: number, endIndex: number) => {
      if (count === 0) return;
      const safeEnd = Math.min(endIndex, count);
      if (safeEnd <= 0) return;
      const firstChunk = Math.floor(startIndex / CHUNK_SIZE);
      const lastChunk = Math.floor((safeEnd - 1) / CHUNK_SIZE);
      for (let c = firstChunk; c <= lastChunk; c++) {
        if (chunkCacheRef.current.has(c)) continue;
        if (inflightChunksRef.current.has(c)) continue;
        void fetchChunk(c);
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
          <button
            onClick={() => setPaused((p) => !p)}
            disabled={state.kind === "idle"}
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button onClick={handleClear} disabled={count === 0}>
            Clear
          </button>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            auto-scroll
          </label>
        </div>
        <div className="status">{status}</div>
      </header>
      <TraceView
        count={count}
        version={version}
        autoScroll={autoScroll && !paused}
        getFrame={getFrame}
        ensureVisible={ensureVisible}
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
  const dbc = dbcPath
    ? `DBC: ${shortenPath(dbcPath)}`
    : "no DBC attached";
  const fps = framesPerSecond > 0 ? ` · ${formatRate(framesPerSecond)}` : "";
  switch (state.kind) {
    case "idle":
      return `Open a BLF log or connect to a server to begin. ${dbc}.`;
    case "loading":
      return `Opening ${shortenPath(state.result.blf_path)} … ${dbc}.`;
    case "running":
      return `Streaming ${shortenPath(state.result.blf_path)} (${frameCount} frames${fps}). ${dbc}.`;
    case "done":
      return `Done: ${state.total} frames from ${shortenPath(state.result.blf_path)}. ${dbc}.`;
    case "remote-connecting":
      return `Connecting to ${state.address} … ${dbc}.`;
    case "remote-running": {
      const ifaces = state.result.interfaces.length;
      return `Streaming from ${state.result.address} (${ifaces} interface${ifaces === 1 ? "" : "s"}, ${frameCount} frames${fps}). ${dbc}.`;
    }
    case "remote-done":
      return `Disconnected from ${state.result.address}: ${state.total} frames received. ${dbc}.`;
    case "error":
      return `Error: ${state.message}`;
  }
}

function formatRate(fps: number): string {
  if (fps >= 10_000) return `${(fps / 1000).toFixed(1)}k fps`;
  if (fps >= 100) return `${Math.round(fps)} fps`;
  return `${fps.toFixed(1)} fps`;
}

function shortenPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}
