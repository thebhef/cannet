import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

import type {
  Bus,
  SignalDescriptorRecord,
  ValueTableEntryRecord,
} from "./types";
import { useElementRegistry } from "./projectElements";
import { useProjectContext } from "./projectContext";

/**
 * Phase-5 transmit panel: compose a CAN / CAN FD frame, optionally
 * cycle it at a fixed cadence, and fire it through the host's
 * `transmit_frame` command — which appends a Tx-direction tx-confirm
 * row to the trace and (if a remote session is open) forwards onto the
 * wire. The configured frames are per-panel state and round-trip
 * through the dockview panel params (and so through the project file).
 *
 * Two entry modes:
 *
 * - **raw bytes** — always available. Type space-separated hex bytes;
 *   the payload is parsed and validated against the chosen frame
 *   kind's max length.
 * - **signals** — available once a DBC is loaded *and* the panel's
 *   chosen `(message_id, extended)` matches a defined message. The
 *   panel lists the message's signals with a numeric entry per
 *   plain signal, and a `<select>` of `<value> "label"` options per
 *   enum signal (the host's `list_value_tables` supplies the table).
 *   Encoding raw bytes from per-signal values is **not** in this
 *   panel yet — the GUI host doesn't expose a `dbc::encode` command
 *   yet. For now picking "signals" mode shows the table for
 *   reference + lets the user click a label to copy its raw value
 *   into the hex field. Tracked in plans/backlog.md as a follow-up.
 *
 * Cyclic transmit is a **client-side scheduler**: a `setInterval` on
 * the frame's "cycle ms" entry fires `transmit_frame` repeatedly while
 * the toggle is on. Stopping the toggle clears the interval.
 *
 * The wire status of the most recent send is shown inline — including
 * the `Error::TX_REJECTED` surfaced by the BLF replay server (which
 * the host translates into a `failed { message }` here).
 */
export function TransmitPanel(props: IDockviewPanelProps) {
  const { api } = props;
  const params = props.params as
    | { elementId?: unknown; frames?: unknown }
    | undefined;
  const registry = useElementRegistry();
  const project = useProjectContext();
  const [elementId] = useState(() =>
    typeof params?.elementId === "string" ? params.elementId : crypto.randomUUID(),
  );
  useEffect(() => {
    registry.ensure(elementId, "transmit");
  }, [registry, elementId]);
  const [frames, setFrames] = useState<TransmitFrameConfig[]>(() =>
    parseFramesParam(params?.frames),
  );
  const [activeId, setActiveId] = useState<string | null>(
    () => (parseFramesParam(params?.frames)[0]?.id ?? null),
  );

  // Persist back to dockview panel params so it round-trips through
  // the project file. The host doesn't interpret `frames`.
  useEffect(() => {
    api.updateParameters({ elementId, frames });
  }, [api, elementId, frames]);

  // Keep the transmit *element's* `sinks` in sync with the union of
  // its frames' bus picks. The graph view reads `sinks` to draw
  // transmit→bus edges; the panel's UI is per-frame so we derive
  // sinks from the frames rather than letting it drift on its own.
  useEffect(() => {
    const union = Array.from(
      new Set(frames.map((f) => f.busId).filter((b): b is string => !!b)),
    );
    // Preserve project bus order so the edges read consistently.
    const ordered = project.buses
      .map((b) => b.id)
      .filter((id) => union.includes(id));
    registry.update(elementId, { sinks: ordered });
  }, [frames, project.buses, registry, elementId]);

  // The DBC's `(message, signal)` list — used to populate the
  // signals-mode picker, the per-frame message picker, and enum
  // detection. Per-bus list_signals returns one record per bus;
  // we dedupe by `(message_id, extended)` so the message picker
  // shows one entry per DBC message regardless of how many buses
  // a DBC is scoped to.
  const [signals, setSignals] = useState<SignalDescriptorRecord[]>([]);
  const refreshSignals = useCallback(() => {
    void invoke<SignalDescriptorRecord[]>("list_signals", {
      projectBuses: project.buses.map((b) => b.id),
    })
      .then(setSignals)
      .catch(() => setSignals([]));
  }, [project.buses]);
  useEffect(() => {
    refreshSignals();
  }, [refreshSignals]);

  const active = frames.find((f) => f.id === activeId) ?? null;
  const updateActive = useCallback(
    (mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => {
      if (!active) return;
      setFrames((prev) =>
        prev.map((f) => (f.id === active.id ? mut(f) : f)),
      );
    },
    [active],
  );

  const addFrame = useCallback(() => {
    const id = crypto.randomUUID();
    const next: TransmitFrameConfig = {
      id,
      name: `Frame ${frames.length + 1}`,
      // Default the new frame's destination to the project's first
      // bus — same intent as today's "transmits fan out by default"
      // but now per-frame (and explicit, since `sinks` doesn't
      // support a wildcard).
      busId: project.buses[0]?.id ?? null,
      canId: 0x100,
      extended: false,
      kind: "classic",
      dataHex: "00",
      cycleMs: 0,
      brs: false,
      esi: false,
      dlc: 0,
    };
    setFrames((prev) => [...prev, next]);
    setActiveId(id);
  }, [frames.length, project.buses]);

  const removeFrame = useCallback(
    (id: string) => {
      setFrames((prev) => prev.filter((f) => f.id !== id));
      setActiveId((cur) => (cur === id ? null : cur));
    },
    [],
  );

  // Last send result for the active frame.
  const [lastStatus, setLastStatus] = useState<string | null>(null);

  // Client-side cyclic scheduler. One handle per frame id while its
  // "send cyclically" toggle is on. Cleared on unmount, panel close,
  // or a frame removal / cycle-ms change.
  const cyclicTimersRef = useRef<Map<string, number>>(new Map());
  const cyclicTickRef = useRef(0);
  const [cyclicTick, setCyclicTick] = useState(0);
  cyclicTickRef.current = cyclicTick;
  const stopCyclic = useCallback((id: string) => {
    const timers = cyclicTimersRef.current;
    const handle = timers.get(id);
    if (handle !== undefined) {
      window.clearInterval(handle);
      timers.delete(id);
      setCyclicTick((t) => t + 1);
    }
  }, []);
  // Mirror the project bus list into a ref so the cyclic scheduler's
  // captured closure sees the current names when it builds status
  // text. (`frame` itself is also passed in fresh per tick — see
  // `startCyclic`.)
  const busesRef = useRef<readonly Bus[]>(project.buses);
  busesRef.current = project.buses;
  const sendOnce = useCallback(async (frame: TransmitFrameConfig) => {
    if (!frame.busId) {
      setLastStatus(`${frame.name}: no destination bus`);
      return;
    }
    const parsed = parseFrame(frame);
    if (parsed.kind === "err") {
      setLastStatus(`${frame.name}: ${parsed.message}`);
      return;
    }
    try {
      const result = await invoke<TransmitResult>("transmit_frame", {
        request: { bus_id: frame.busId, ...parsed.request },
      });
      const wire = result.wire_status;
      const busName =
        busesRef.current.find((b) => b.id === frame.busId)?.name ?? frame.busId;
      setLastStatus(
        wire.kind === "sent"
          ? `${frame.name}: ${busName} → ${wire.interface_id} (Tx-confirm @ #${result.tx_confirm_index + 1})`
          : wire.kind === "not_connected"
            ? `${frame.name}: ${busName} not connected (Tx-confirm @ #${result.tx_confirm_index + 1})`
            : `${frame.name}: ${busName}: ${wire.message} (Tx-confirm @ #${result.tx_confirm_index + 1})`,
      );
    } catch (err) {
      setLastStatus(`${frame.name}: ${String(err)}`);
    }
  }, []);
  const startCyclic = useCallback(
    (frame: TransmitFrameConfig) => {
      stopCyclic(frame.id);
      if (frame.cycleMs <= 0) return;
      const handle = window.setInterval(() => {
        void sendOnce(frame);
      }, frame.cycleMs);
      cyclicTimersRef.current.set(frame.id, handle);
      // Fire one immediately so the first tick isn't a full period away.
      void sendOnce(frame);
      setCyclicTick((t) => t + 1);
    },
    [sendOnce, stopCyclic],
  );
  // Stop all schedules on unmount.
  useEffect(() => {
    return () => {
      for (const handle of cyclicTimersRef.current.values()) {
        window.clearInterval(handle);
      }
      cyclicTimersRef.current.clear();
    };
  }, []);
  // If a frame is removed mid-schedule, kill its timer.
  useEffect(() => {
    const live = new Set(frames.map((f) => f.id));
    for (const [id, handle] of cyclicTimersRef.current) {
      if (!live.has(id)) {
        window.clearInterval(handle);
        cyclicTimersRef.current.delete(id);
      }
    }
  }, [frames]);

  const message = useMemo(() => {
    if (!active) return null;
    return signals.find(
      (s) => s.message_id === active.canId && s.extended === active.extended,
    );
  }, [active, signals]);
  const messageSignals = useMemo(() => {
    if (!message) return [];
    return signals.filter(
      (s) =>
        s.message_id === message.message_id &&
        s.extended === message.extended &&
        s.message_name === message.message_name,
    );
  }, [message, signals]);

  // Distinct messages defined by any loaded DBC, for the per-frame
  // "pick a message" dropdown. `list_signals` returns one record per
  // (bus, signal) pair; dedupe to `(message_id, extended, name)` so
  // each DBC message shows once regardless of how many buses it
  // applies to and how many signals it has.
  const messageCatalog: MessageCatalogEntry[] = useMemo(() => {
    const seen = new Map<string, MessageCatalogEntry>();
    for (const s of signals) {
      const key = `${s.extended ? "x" : "s"}:${s.message_id}:${s.message_name}`;
      if (!seen.has(key)) {
        seen.set(key, {
          messageId: s.message_id,
          extended: s.extended,
          messageName: s.message_name,
        });
      }
    }
    return [...seen.values()].sort((a, b) =>
      a.messageId === b.messageId
        ? a.messageName.localeCompare(b.messageName)
        : a.messageId - b.messageId,
    );
  }, [signals]);

  return (
    <div className="transmit-panel">
      <div className="transmit-panel-toolbar">
        <button type="button" onClick={addFrame}>
          + frame
        </button>
        {lastStatus && (
          <span className="transmit-status">{lastStatus}</span>
        )}
      </div>
      <div className="transmit-panel-body">
        <aside className="transmit-frame-list">
          {frames.length === 0 && (
            <div className="empty">
              No frames yet. Click "+ frame" to add one.
            </div>
          )}
          {frames.map((f) => {
            const cycling = cyclicTimersRef.current.has(f.id);
            return (
              <div
                key={f.id}
                className={`transmit-frame-row ${f.id === activeId ? "active" : ""}`}
                onClick={() => setActiveId(f.id)}
              >
                <span className="transmit-frame-row-name">
                  {cycling ? "⟳ " : ""}
                  {f.name}
                </span>
                <span className="transmit-frame-row-id">
                  {formatHexId(f.canId, f.extended)}
                </span>
                <button
                  type="button"
                  className="transmit-frame-row-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFrame(f.id);
                  }}
                  aria-label={`remove ${f.name}`}
                >
                  ×
                </button>
              </div>
            );
          })}
        </aside>
        <section className="transmit-frame-editor">
          {active && (
            <TransmitFrameEditor
              frame={active}
              buses={project.buses}
              messageCatalog={messageCatalog}
              messageSignals={messageSignals}
              messageName={message?.message_name ?? null}
              onChange={updateActive}
              onSend={() => sendOnce(active)}
              onStartCyclic={() => startCyclic(active)}
              onStopCyclic={() => stopCyclic(active.id)}
              cyclicActive={cyclicTimersRef.current.has(active.id)}
              cyclicTick={cyclicTick}
            />
          )}
          {!active && <div className="empty">Pick a frame to edit.</div>}
        </section>
      </div>
    </div>
  );
}

interface MessageCatalogEntry {
  messageId: number;
  extended: boolean;
  messageName: string;
}

interface FrameEditorProps {
  frame: TransmitFrameConfig;
  buses: readonly Bus[];
  messageCatalog: readonly MessageCatalogEntry[];
  messageSignals: SignalDescriptorRecord[];
  messageName: string | null;
  onChange: (mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => void;
  onSend: () => void;
  onStartCyclic: () => void;
  onStopCyclic: () => void;
  cyclicActive: boolean;
  // Tick to force a re-render when the cyclic timers map changes.
  cyclicTick: number;
}

function TransmitFrameEditor({
  frame,
  buses,
  messageCatalog,
  messageSignals,
  messageName,
  onChange,
  onSend,
  onStartCyclic,
  onStopCyclic,
  cyclicActive,
}: FrameEditorProps) {
  const [mode, setMode] = useState<"raw" | "signals">("raw");
  const set = <K extends keyof TransmitFrameConfig>(key: K, value: TransmitFrameConfig[K]) =>
    onChange((f) => ({ ...f, [key]: value }));

  // Catalog key the message <select> uses. The empty option means
  // "no DBC message picked" — the user can still hand-type a hex id.
  const messageKey = (m: MessageCatalogEntry) =>
    `${m.extended ? "x" : "s"}:${m.messageId}`;
  const currentMessageKey = `${frame.extended ? "x" : "s"}:${frame.canId}`;

  return (
    <div className="transmit-editor">
      <div className="transmit-editor-row">
        <label>
          name
          <input
            type="text"
            value={frame.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </label>
        <label>
          bus
          <select
            value={frame.busId ?? ""}
            onChange={(e) => set("busId", e.target.value || null)}
            aria-label="destination bus"
            // Highlight the unset state — until the user picks a
            // bus, `sendOnce` refuses to fire.
            className={frame.busId ? undefined : "transmit-editor-warning"}
          >
            {!frame.busId && (
              <option value="">{buses.length === 0 ? "(no buses configured)" : "(pick a bus)"}</option>
            )}
            {buses.map((b) => (
              <option value={b.id} key={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="transmit-editor-row">
        <label className="grow">
          message (from DBC)
          <select
            value={
              messageCatalog.some((m) => messageKey(m) === currentMessageKey)
                ? currentMessageKey
                : ""
            }
            onChange={(e) => {
              const picked = messageCatalog.find(
                (m) => messageKey(m) === e.target.value,
              );
              if (!picked) return;
              onChange((f) => ({
                ...f,
                canId: picked.messageId,
                extended: picked.extended,
              }));
            }}
            aria-label="pick DBC message"
            disabled={messageCatalog.length === 0}
          >
            <option value="">
              {messageCatalog.length === 0
                ? "(no DBC attached)"
                : "(pick a message…)"}
            </option>
            {messageCatalog.map((m) => (
              <option key={messageKey(m)} value={messageKey(m)}>
                {m.messageName} — {m.extended ? "x" : "s"}:0x{m.messageId.toString(16).toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="transmit-editor-row">
        <label>
          id (hex)
          <input
            type="text"
            value={frame.canId.toString(16).toUpperCase()}
            onChange={(e) => {
              const n = parseInt(e.target.value, 16);
              if (Number.isFinite(n)) set("canId", n);
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={frame.extended}
            onChange={(e) => set("extended", e.target.checked)}
          />
          extended
        </label>
        <label>
          kind
          <select
            value={frame.kind}
            onChange={(e) =>
              set("kind", e.target.value as TransmitFrameConfig["kind"])
            }
          >
            <option value="classic">classic</option>
            <option value="fd">FD</option>
            <option value="remote">remote</option>
            <option value="error">error</option>
          </select>
        </label>
        {frame.kind === "fd" && (
          <>
            <label>
              <input
                type="checkbox"
                checked={frame.brs}
                onChange={(e) => set("brs", e.target.checked)}
              />
              BRS
            </label>
            <label>
              <input
                type="checkbox"
                checked={frame.esi}
                onChange={(e) => set("esi", e.target.checked)}
              />
              ESI
            </label>
          </>
        )}
        {frame.kind === "remote" && (
          <label>
            DLC
            <input
              type="number"
              min={0}
              max={15}
              value={frame.dlc}
              onChange={(e) =>
                set("dlc", clampUInt(e.target.valueAsNumber, 15, 0))
              }
            />
          </label>
        )}
      </div>
      <div className="transmit-editor-row">
        <span className="mode-toggle">
          <button
            type="button"
            className={mode === "raw" ? "active" : undefined}
            onClick={() => setMode("raw")}
          >
            raw bytes
          </button>
          <button
            type="button"
            className={mode === "signals" ? "active" : undefined}
            onClick={() => setMode("signals")}
            disabled={messageSignals.length === 0}
            title={
              messageSignals.length === 0
                ? "no DBC message matches this id"
                : undefined
            }
          >
            signals{messageName ? ` (${messageName})` : ""}
          </button>
        </span>
      </div>
      {mode === "raw" && (
        <div className="transmit-editor-row">
          <label className="grow">
            payload (hex)
            <input
              type="text"
              value={frame.dataHex}
              onChange={(e) => set("dataHex", e.target.value)}
              spellCheck={false}
            />
          </label>
        </div>
      )}
      {mode === "signals" && (
        <SignalsByMessage
          signals={messageSignals}
          onPickLabel={(rawHex) => set("dataHex", rawHex)}
        />
      )}
      <div className="transmit-editor-row">
        <button type="button" onClick={onSend}>
          send once
        </button>
        <label>
          cycle (ms)
          <input
            type="number"
            min={0}
            value={frame.cycleMs}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              set("cycleMs", Math.max(0, e.target.valueAsNumber || 0))
            }
          />
        </label>
        {cyclicActive ? (
          <button type="button" onClick={onStopCyclic}>
            stop
          </button>
        ) : (
          <button
            type="button"
            onClick={onStartCyclic}
            disabled={frame.cycleMs <= 0}
            title={frame.cycleMs <= 0 ? "set a cycle (ms) first" : undefined}
          >
            start cyclic
          </button>
        )}
      </div>
    </div>
  );
}

interface SignalsByMessageProps {
  signals: SignalDescriptorRecord[];
  // Replace the data-hex with a one-byte representation of `raw` (so
  // an enum pick is visible in the payload field). Coarse but
  // informative until proper signal-to-bytes encoding lands.
  onPickLabel: (rawHex: string) => void;
}

function SignalsByMessage({ signals, onPickLabel }: SignalsByMessageProps) {
  // For each enum signal we lazy-load its value table on first
  // expansion. Cached per signal-name so the dropdown re-renders without
  // a round-trip.
  const [tables, setTables] = useState<Map<string, ValueTableEntryRecord[]>>(
    () => new Map(),
  );
  const ensureTable = useCallback(
    async (sig: SignalDescriptorRecord) => {
      if (!sig.has_value_table || tables.has(sig.signal_name)) return;
      try {
        const rows = await invoke<ValueTableEntryRecord[]>(
          "list_value_tables",
          {
            messageId: sig.message_id,
            extended: sig.extended,
            signalName: sig.signal_name,
          },
        );
        setTables((prev) => {
          const next = new Map(prev);
          next.set(sig.signal_name, rows);
          return next;
        });
      } catch {
        /* table fetch failure leaves the row in numeric mode */
      }
    },
    [tables],
  );

  return (
    <div className="transmit-signals">
      {signals.map((sig) => {
        const rows = sig.has_value_table ? tables.get(sig.signal_name) : null;
        if (sig.has_value_table && !rows) {
          // Kick off the fetch on first render of this enum signal.
          void ensureTable(sig);
        }
        return (
          <div key={sig.signal_name} className="transmit-signal">
            <span className="signal-name">{sig.signal_name}</span>
            <span className="signal-unit">{sig.unit}</span>
            {sig.has_value_table ? (
              <select
                onChange={(e) => {
                  // Stash the picked raw value into the payload as a
                  // single byte (the value tables we surface are
                  // bounded by `i64`, but enum values in real DBCs
                  // almost universally fit in a byte). Proper
                  // signal-to-bytes encoding is a follow-up — tracked
                  // in plans/backlog.md.
                  const raw = parseInt(e.target.value, 10);
                  if (Number.isFinite(raw)) {
                    onPickLabel(
                      (raw & 0xff).toString(16).padStart(2, "0").toUpperCase(),
                    );
                  }
                }}
                defaultValue=""
              >
                <option value="" disabled>
                  pick a value…
                </option>
                {(rows ?? []).map((row) => (
                  <option key={row.raw} value={row.raw}>
                    {row.raw} "{row.label}"
                  </option>
                ))}
              </select>
            ) : (
              <span className="signal-hint">numeric</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/// Persisted shape for one transmit frame. Lives in the dockview
/// panel `params.frames` array; the host doesn't interpret it.
///
/// The destination bus is **per-frame** (`busId`) — the panel
/// auto-syncs the transmit element's `sinks` to the union of its
/// frames' bus picks so the graph view still shows which buses this
/// panel is wired to.
export interface TransmitFrameConfig {
  id: string;
  name: string;
  /// Logical bus this frame transmits onto. `null` only on a freshly
  /// added frame in a project with no buses yet — the panel
  /// surfaces a warning until the user picks one.
  busId: string | null;
  canId: number;
  extended: boolean;
  kind: "classic" | "fd" | "remote" | "error";
  dataHex: string;
  /// Cycle time in milliseconds. `0` means "send once on demand".
  cycleMs: number;
  brs: boolean;
  esi: boolean;
  dlc: number;
}

interface TransmitResult {
  tx_confirm_index: number;
  wire_status:
    | { kind: "not_connected" }
    | { kind: "sent"; interface_id: string }
    | { kind: "failed"; message: string };
}

type ParseResult =
  | {
      kind: "ok";
      /// Frame fields shared across every destination bus. The
      /// caller folds each `bus_id` in on the way out the door so
      /// the host gets one `TransmitRequest` per bus.
      request: {
        id: number;
        extended: boolean;
        kind: TransmitFrameConfig["kind"];
        data: number[];
        brs: boolean;
        esi: boolean;
        dlc: number;
      };
    }
  | { kind: "err"; message: string };

function parseFrame(frame: TransmitFrameConfig): ParseResult {
  const data: number[] = [];
  if (frame.kind === "classic" || frame.kind === "fd") {
    const cleaned = frame.dataHex.replace(/\s+/g, "");
    if (cleaned.length % 2 !== 0) {
      return { kind: "err", message: "payload must have an even number of hex digits" };
    }
    for (let i = 0; i < cleaned.length; i += 2) {
      const byte = parseInt(cleaned.slice(i, i + 2), 16);
      if (!Number.isFinite(byte) || byte < 0 || byte > 0xff) {
        return { kind: "err", message: `invalid byte at offset ${i / 2}` };
      }
      data.push(byte);
    }
    const max = frame.kind === "classic" ? 8 : 64;
    if (data.length > max) {
      return {
        kind: "err",
        message: `${frame.kind === "classic" ? "classic" : "FD"} payload is at most ${max} bytes`,
      };
    }
  }
  return {
    kind: "ok",
    request: {
      id: frame.canId,
      extended: frame.extended,
      kind: frame.kind,
      data,
      brs: frame.brs,
      esi: frame.esi,
      dlc: frame.dlc,
    },
  };
}

function parseFramesParam(value: unknown): TransmitFrameConfig[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isTransmitFrameConfig)
    .map((f) => ({ ...f })); // defensive copy
}

function isTransmitFrameConfig(v: unknown): v is TransmitFrameConfig {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  // `busId` is the new per-frame field. Old saved frames (pre-bus
  // model) load with `busId: null` and the panel surfaces a warning
  // until the user picks a bus.
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    (o.busId == null || typeof o.busId === "string") &&
    typeof o.canId === "number" &&
    typeof o.extended === "boolean" &&
    (o.kind === "classic" || o.kind === "fd" || o.kind === "remote" || o.kind === "error") &&
    typeof o.dataHex === "string" &&
    typeof o.cycleMs === "number" &&
    typeof o.brs === "boolean" &&
    typeof o.esi === "boolean" &&
    typeof o.dlc === "number"
  );
}

function formatHexId(canId: number, extended: boolean): string {
  const width = extended ? 8 : 3;
  const hex = canId.toString(16).toUpperCase().padStart(width, "0");
  return `${extended ? "x" : "s"}:${hex}`;
}

function clampUInt(n: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(n)));
}

