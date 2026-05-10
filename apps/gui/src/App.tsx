import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  CanFrameBatch,
  CanFrameRecord,
  DbcInfo,
  DecodeRequest,
  DecodedRecord,
  LogFinished,
  OpenLogResult,
  RemoteSessionResult,
} from "./types";
import { TitleBar } from "./TitleBar";
import { TraceView } from "./TraceView";

type LogState =
  | { kind: "idle" }
  | { kind: "loading"; result: OpenLogResult }
  | { kind: "running"; result: OpenLogResult; received: number }
  | { kind: "done"; result: OpenLogResult; total: number }
  | { kind: "remote-connecting"; address: string }
  | { kind: "remote-running"; result: RemoteSessionResult; received: number }
  | { kind: "remote-done"; result: RemoteSessionResult; total: number }
  | { kind: "error"; message: string };

const DEFAULT_REMOTE_ADDRESS = "127.0.0.1:50051";

export function App() {
  // Frames live in a ref so appending a batch doesn't deep-copy the array
  // back to React. `version` is bumped on each mutation to wake the
  // virtualizer's measurement.
  const framesRef = useRef<CanFrameRecord[]>([]);
  const [version, setVersion] = useState(0);

  const [state, setState] = useState<LogState>({ kind: "idle" });
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const pauseBufferRef = useRef<CanFrameRecord[]>([]);
  useEffect(() => {
    pausedRef.current = paused;
    if (!paused && pauseBufferRef.current.length > 0) {
      framesRef.current.push(...pauseBufferRef.current);
      pauseBufferRef.current = [];
      setVersion((v) => v + 1);
    }
  }, [paused]);

  const [autoScroll, setAutoScroll] = useState(true);
  const [dbcPath, setDbcPath] = useState<string | null>(null);
  const [remoteAddress, setRemoteAddress] = useState(DEFAULT_REMOTE_ADDRESS);

  // Wire up Tauri event listeners once.
  useEffect(() => {
    const unlistens: Array<Promise<() => void>> = [];

    unlistens.push(
      listen<CanFrameBatch>("can-frame-batch", (event) => {
        const incoming = event.payload.frames;
        if (pausedRef.current) {
          pauseBufferRef.current.push(...incoming);
        } else {
          framesRef.current.push(...incoming);
        }
        setVersion((v) => v + 1);
        setState((s) => {
          if (s.kind === "loading") {
            return { kind: "running", result: s.result, received: incoming.length };
          }
          if (s.kind === "running") {
            return { ...s, received: s.received + incoming.length };
          }
          if (s.kind === "remote-connecting") {
            // Frames started flowing before connect_remote_server resolved.
            // The result will be filled in by handleConnect on success;
            // for now stay in remote-connecting to keep the UI consistent.
            return s;
          }
          if (s.kind === "remote-running") {
            return { ...s, received: s.received + incoming.length };
          }
          return s;
        });
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
  }, []);

  const handleOpenLog = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Vector BLF", extensions: ["blf"] }],
    });
    if (typeof selected !== "string") return;

    framesRef.current = [];
    pauseBufferRef.current = [];
    setVersion((v) => v + 1);

    try {
      const result = await invoke<OpenLogResult>("open_log", {
        blfPath: selected,
      });
      setState({ kind: "loading", result });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, []);

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

    // Retro-decode any frames that arrived before the DBC was attached
    // (or that were decoded against the previous DBC). New frames keep
    // arriving with the new DBC's decoded info via the pump, so we only
    // touch the snapshot of `framesRef.current` taken at this moment.
    if (framesRef.current.length > 0) {
      await retroDecode(framesRef.current);
      setVersion((v) => v + 1);
    }
  }, []);

  const handleClear = useCallback(() => {
    framesRef.current = [];
    pauseBufferRef.current = [];
    setVersion((v) => v + 1);
  }, []);

  const handleConnect = useCallback(async () => {
    const address = remoteAddress.trim();
    if (!address) return;

    framesRef.current = [];
    pauseBufferRef.current = [];
    setVersion((v) => v + 1);
    setState({ kind: "remote-connecting", address });

    try {
      const result = await invoke<RemoteSessionResult>("connect_remote_server", {
        address,
      });
      setState({ kind: "remote-running", result, received: 0 });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, [remoteAddress]);

  const handleDisconnect = useCallback(async () => {
    try {
      await invoke("disconnect_remote_server");
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, []);

  const frameCount = framesRef.current.length;
  const status = renderStatus(state, dbcPath, frameCount);
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
          <button onClick={handleClear} disabled={frameCount === 0}>
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
        frames={framesRef.current}
        version={version}
        autoScroll={autoScroll && !paused}
      />
    </main>
  );
}

function renderStatus(
  state: LogState,
  dbcPath: string | null,
  frameCount: number,
): string {
  const dbc = dbcPath
    ? `DBC: ${shortenPath(dbcPath)}`
    : "no DBC attached";
  switch (state.kind) {
    case "idle":
      return `Open a BLF log or connect to a server to begin. ${dbc}.`;
    case "loading":
      return `Opening ${shortenPath(state.result.blf_path)} … ${dbc}.`;
    case "running":
      return `Streaming ${shortenPath(state.result.blf_path)} (${frameCount} frames). ${dbc}.`;
    case "done":
      return `Done: ${state.total} frames from ${shortenPath(state.result.blf_path)}. ${dbc}.`;
    case "remote-connecting":
      return `Connecting to ${state.address} … ${dbc}.`;
    case "remote-running": {
      const ifaces = state.result.interfaces.length;
      return `Streaming from ${state.result.address} (${ifaces} interface${ifaces === 1 ? "" : "s"}, ${frameCount} frames). ${dbc}.`;
    }
    case "remote-done":
      return `Disconnected from ${state.result.address}: ${state.total} frames received. ${dbc}.`;
    case "error":
      return `Error: ${state.message}`;
  }
}

function shortenPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

const RETRO_DECODE_BATCH = 1000;

/// Re-decode existing trace rows against the currently-attached DBC.
/// Mutates the frames in place — they're plain objects shared with React
/// state via framesRef, so updating .decoded is visible after the next
/// version bump.
async function retroDecode(frames: CanFrameRecord[]): Promise<void> {
  for (let i = 0; i < frames.length; i += RETRO_DECODE_BATCH) {
    const slice = frames.slice(i, i + RETRO_DECODE_BATCH);
    const requests: DecodeRequest[] = slice.map((f) => ({
      channel: f.channel,
      id: f.id,
      extended: f.extended,
      data: f.data,
    }));
    const decoded = await invoke<(DecodedRecord | null)[]>("decode_frames", {
      frames: requests,
    });
    for (let j = 0; j < slice.length; j++) {
      slice[j].decoded = decoded[j];
    }
  }
}
