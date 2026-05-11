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

/// Number of frames per cache chunk.
const CHUNK_SIZE = 500;
/// LRU budget for the chunk cache. Sized to comfortably cover the
/// visible window plus prefetch. 120 chunks * 500 frames ≈ 60k rows;
/// at ~150 bytes/row in JS that's around 9 MB — small.
const CACHE_CHUNKS = 120;
/// Maximum rows the view's virtualizer represents at once. The full
/// trace lives in the Rust-side store; the frontend only ever holds
/// this many rows in its scrollable container. Sized well under any
/// browser's CSS dimension limit (50k * 22px ≈ 1.1M px; browsers cap
/// around 17M-33M px) — also small enough that several trace windows
/// in a future Phase-3 layout don't pile up.
const WINDOW_SIZE = 50_000;
/// How far the window slides when the user scrolls past its top or
/// bottom edge while paused. Smaller = finer control; larger = fewer
/// slides to traverse a long trace.
const SLIDE_AMOUNT = Math.floor(WINDOW_SIZE / 2);

export function App() {
  const [count, setCount] = useState(0);
  const [framesPerSecond, setFramesPerSecond] = useState(0);
  /// `null` while live-tailing — the view follows count. A number
  /// while paused — the view's upper-bound (exclusive) is anchored
  /// here, regardless of how count grows. Sliding mutates this.
  const [windowAnchor, setWindowAnchor] = useState<number | null>(null);

  const chunkCacheRef = useRef<Map<number, TraceFrameRecord[]>>(new Map());
  const cacheOrderRef = useRef<number[]>([]);
  const inflightChunksRef = useRef<Set<number>>(new Set());
  const [version, setVersion] = useState(0);

  const [state, setState] = useState<LogState>({ kind: "idle" });

  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [dbcPath, setDbcPath] = useState<string | null>(null);
  const [remoteAddress, setRemoteAddress] = useState(DEFAULT_REMOTE_ADDRESS);

  /// Captured once: the timestamp of absolute row 0. Survives sliding
  /// the view away from the start. Reset on Clear / new source.
  const [baseTimestampSeconds, setBaseTimestampSeconds] = useState<number | null>(null);

  const viewCount = windowAnchor ?? count;
  const displayedCount = Math.min(viewCount, WINDOW_SIZE);
  const displayOffset = viewCount - displayedCount;

  const invalidateCache = useCallback(() => {
    chunkCacheRef.current.clear();
    cacheOrderRef.current = [];
    inflightChunksRef.current.clear();
    setVersion((v) => v + 1);
  }, []);

  const resetWindow = useCallback(() => {
    setWindowAnchor(null);
    setPaused(false);
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

  // Re-fetch any cached chunk whose tail has grown past the cached
  // length. A chunk fetched while the store was still growing arrives
  // partial; we replace it in place when the refresh lands rather than
  // evicting first, so already-visible rows never go through a missing
  // intermediate state on the next paint.
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

  // Wire up Tauri event listeners once.
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

  // Capture the timestamp of absolute row 0 once it's available.
  useEffect(() => {
    if (baseTimestampSeconds !== null) return;
    if (count === 0) return;
    void invoke<TraceFrameRecord[]>("fetch_trace_range", { start: 0, end: 1 }).then(
      (frames) => {
        if (frames.length > 0) {
          setBaseTimestampSeconds(frames[0].timestamp_seconds);
        }
      },
    );
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
      resetWindow();
      const result = await invoke<OpenLogResult>("open_log", { blfPath: selected });
      setState({ kind: "loading", result });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, [invalidateCache, resetWindow]);

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
    resetWindow();
    setCount(0);
  }, [invalidateCache, resetWindow]);

  const handleConnect = useCallback(async () => {
    const address = remoteAddress.trim();
    if (!address) return;

    try {
      await invoke("clear_trace_store");
      invalidateCache();
      resetWindow();
      setState({ kind: "remote-connecting", address });
      const result = await invoke<RemoteSessionResult>("connect_remote_server", {
        address,
      });
      setState({ kind: "remote-running", result });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, [remoteAddress, invalidateCache, resetWindow]);

  const handleDisconnect = useCallback(async () => {
    try {
      await invoke("disconnect_remote_server");
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, []);

  const handlePauseToggle = useCallback(() => {
    setPaused((wasPaused) => {
      if (wasPaused) {
        // Resuming: rejoin the live tail.
        setWindowAnchor(null);
        return false;
      }
      // Pausing: anchor the window where it currently is.
      setWindowAnchor(count);
      return true;
    });
  }, [count]);

  /// Called by TraceView when the user wheels upward. If we're
  /// live-tailing, this is the user's intent to step out of the tail
  /// (autoscroll otherwise yanks them back, making the top edge of
  /// the visible window unreachable). Engages pause silently —
  /// equivalent to the user having clicked Pause first.
  const handleUserScrollUp = useCallback(() => {
    if (windowAnchor === null) {
      setPaused(true);
      setWindowAnchor(count);
    }
  }, [windowAnchor, count]);

  const handleSlideBack = useCallback(() => {
    // Engage pause if the user hit the edge while still live-tailing
    // (mouse-wheel users get the auto-pause via handleUserScrollUp, but
    // scrollbar-drag-to-top doesn't fire wheel events).
    setPaused(true);
    setWindowAnchor((prev) => {
      const base = prev ?? count;
      return Math.max(WINDOW_SIZE, base - SLIDE_AMOUNT);
    });
  }, [count]);

  const handleSlideForward = useCallback(() => {
    setWindowAnchor((prev) => {
      if (prev === null) return null; // already at live tail
      return Math.min(count, prev + SLIDE_AMOUNT);
    });
  }, [count]);

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
      // Prefetch one chunk past the visible end.
      const prefetchEnd = lastChunk + 1;
      for (let c = firstChunk; c <= prefetchEnd; c++) {
        if (c * CHUNK_SIZE >= count) break;
        fetchChunk(c);
      }
    },
    [count, fetchChunk],
  );

  const status = useMemo(
    () =>
      renderStatus(
        state,
        dbcPath,
        count,
        framesPerSecond,
        viewCount,
        displayOffset,
        displayedCount,
        paused,
      ),
    [state, dbcPath, count, framesPerSecond, viewCount, displayOffset, displayedCount, paused],
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
          <button onClick={handlePauseToggle} disabled={state.kind === "idle"}>
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
        displayedCount={displayedCount}
        displayOffset={displayOffset}
        version={version}
        autoScroll={autoScroll && !paused}
        baseTimestampSeconds={baseTimestampSeconds}
        getFrame={getFrame}
        ensureVisible={ensureVisible}
        canSlideBack={displayOffset > 0}
        canSlideForward={paused && viewCount < count}
        onSlideBack={handleSlideBack}
        onSlideForward={handleSlideForward}
        onUserScrollUp={handleUserScrollUp}
      />
    </main>
  );
}

function renderStatus(
  state: LogState,
  dbcPath: string | null,
  frameCount: number,
  framesPerSecond: number,
  viewCount: number,
  displayOffset: number,
  displayedCount: number,
  paused: boolean,
): string {
  const dbc = dbcPath ? `DBC: ${shortenPath(dbcPath)}` : "no DBC attached";
  const fps = framesPerSecond > 0 ? ` · ${formatRate(framesPerSecond)}` : "";
  // Show the row range only when the visible window doesn't cover
  // the whole trace — otherwise it duplicates the frame count.
  const windowing = displayOffset > 0 || viewCount < frameCount;
  const rows = windowing
    ? ` · rows ${formatNumber(displayOffset + 1)}–${formatNumber(displayOffset + displayedCount)}`
    : "";
  const pausedTag = paused ? " · paused" : "";
  switch (state.kind) {
    case "idle":
      return `Open a BLF log or connect to a server to begin. ${dbc}.`;
    case "loading":
      return `Opening ${shortenPath(state.result.blf_path)} … ${dbc}.`;
    case "running":
      return `Streaming ${shortenPath(state.result.blf_path)} (${formatNumber(frameCount)} frames${fps}${rows}${pausedTag}). ${dbc}.`;
    case "done":
      return `Done: ${formatNumber(state.total)} frames from ${shortenPath(state.result.blf_path)}${rows}. ${dbc}.`;
    case "remote-connecting":
      return `Connecting to ${state.address} … ${dbc}.`;
    case "remote-running": {
      const ifaces = state.result.interfaces.length;
      return `Streaming from ${state.result.address} (${ifaces} interface${ifaces === 1 ? "" : "s"}, ${formatNumber(frameCount)} frames${fps}${rows}${pausedTag}). ${dbc}.`;
    }
    case "remote-done":
      return `Disconnected from ${state.result.address}: ${formatNumber(state.total)} frames received${rows}. ${dbc}.`;
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
