import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  CanFrameBatch,
  CanFrameRecord,
  LogFinished,
  OpenLogResult,
} from "./types";
import { TitleBar } from "./TitleBar";
import { TraceView } from "./TraceView";

type LogState =
  | { kind: "idle" }
  | { kind: "loading"; result: OpenLogResult }
  | { kind: "running"; result: OpenLogResult; received: number }
  | { kind: "done"; result: OpenLogResult; total: number }
  | { kind: "error"; message: string };

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
        setState((s) =>
          s.kind === "loading"
            ? { kind: "running", result: s.result, received: incoming.length }
            : s.kind === "running"
              ? { ...s, received: s.received + incoming.length }
              : s,
        );
      }),
    );

    unlistens.push(
      listen<LogFinished>("log-finished", (event) => {
        if (event.payload.status === "ok") {
          setState((s) =>
            s.kind === "running" || s.kind === "loading"
              ? {
                  kind: "done",
                  result: s.kind === "loading" ? s.result : s.result,
                  total: event.payload.status === "ok" ? event.payload.total : 0,
                }
              : s,
          );
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
        dbcPath,
      });
      setState({ kind: "loading", result });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, [dbcPath]);

  const handleAttachDbc = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "DBC", extensions: ["dbc"] }],
    });
    if (typeof selected !== "string") return;
    setDbcPath(selected);
  }, []);

  const handleClear = useCallback(() => {
    framesRef.current = [];
    pauseBufferRef.current = [];
    setVersion((v) => v + 1);
  }, []);

  const frameCount = framesRef.current.length;
  const status = renderStatus(state, dbcPath, frameCount);

  return (
    <main className="app">
      <TitleBar />
      <header>
        <div className="toolbar">
          <button onClick={handleOpenLog}>Open BLF…</button>
          <button onClick={handleAttachDbc}>
            {dbcPath ? "Replace DBC…" : "Attach DBC…"}
          </button>
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
      return `Open a BLF log to begin. ${dbc}.`;
    case "loading":
      return `Opening ${shortenPath(state.result.blf_path)} … ${dbc}.`;
    case "running":
      return `Streaming ${shortenPath(state.result.blf_path)} (${frameCount} frames). ${dbc}.`;
    case "done":
      return `Done: ${state.total} frames from ${shortenPath(state.result.blf_path)}. ${dbc}.`;
    case "error":
      return `Error: ${state.message}`;
  }
}

function shortenPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}
