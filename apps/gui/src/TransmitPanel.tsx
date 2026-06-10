import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
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
  DecodedFrameRecord,
  EncodeFrameResponse,
  EncodeFrameSignal,
  MessageDescriptorRecord,
  SignalDescriptorRecord,
  SignalDescriptorRichRecord,
  SignalRecord,
  ValueTableEntryRecord,
} from "./types";
import { useElementRegistry } from "./projectElements";
import { useProjectContext } from "./projectContext";
import { effectiveBusColor } from "./busColor";
import { SIGNAL_DND_MIME, parseSignalDragData } from "./dragSignals";

/**
 * Phase 10 Track 2 transmit panel. Single-column list of collapsible
 * frame-tiles. Each tile carries its own send / cyclic controls,
 * identity (name, bus, id, DBC message name), and byte editor — all
 * visible in the collapsed face. Expanding a tile reveals the frame-
 * shape strip and (when the id binds to a DBC message) a signals
 * table; until that lands, expanded is empty.
 *
 * Reorderable: drag the bus-tinted handle on the left of a row to
 * insert that frame before another. Persisted state per frame stays
 * `dataHex` (bytes are the source of truth — see ADR 0017).
 */
export function TransmitPanel(props: IDockviewPanelProps) {
  const { api } = props;
  const params = props.params as
    | { elementId?: unknown; frames?: unknown }
    | undefined;
  const registry = useElementRegistry();
  const project = useProjectContext();
  const [elementId] = useState(() =>
    typeof params?.elementId === "string"
      ? params.elementId
      : crypto.randomUUID(),
  );
  useEffect(() => {
    registry.ensure(elementId, "transmit");
  }, [registry, elementId]);

  const [frames, setFrames] = useState<TransmitFrameConfig[]>(() =>
    parseFramesParam(params?.frames),
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
    const ordered = project.buses
      .map((b) => b.id)
      .filter((id) => union.includes(id));
    registry.update(elementId, { sinks: ordered });
  }, [frames, project.buses, registry, elementId]);

  // The DBC's `(message, signal)` list — used to look up the DBC
  // message name on a collapsed row and (later) to populate the
  // signals table. One record per (bus, signal); we filter by frame's
  // (bus_id, message_id, extended) at the row level.
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

  const updateFrame = useCallback(
    (id: string, mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => {
      setFrames((prev) => prev.map((f) => (f.id === id ? mut(f) : f)));
    },
    [],
  );

  const addFrame = useCallback(() => {
    const id = crypto.randomUUID();
    setFrames((prev) => {
      const next: TransmitFrameConfig = {
        id,
        name: `Frame ${prev.length + 1}`,
        busId: project.buses[0]?.id ?? null,
        canId: 0x100,
        extended: false,
        kind: "classic",
        dataHex: "00",
        cycleMs: 100,
        cycleMode: "manual",
        brs: false,
        dlc: 0,
      };
      return [...prev, next];
    });
  }, [project.buses]);

  /// Drop handler for the Phase 12 DBC-to-TX gesture. The drag
  /// payload is the shared `application/x-cannet-plot-signal` shape
  /// (one or more signal refs). A transmit frame is per-message,
  /// not per-signal — so we group by `(canId, extended)` and
  /// produce one new frame per distinct message. The DBC signals
  /// inside each frame populate via the existing `describe_message`
  /// pathway once the row mounts (kind = "classic" is the safe
  /// default; the panel auto-promotes to `fd` from the DBC's
  /// `VFrameFormat` attribute when it loads).
  ///
  /// The dropped ref's `busId` flows directly onto the new frame:
  /// scoped-DBC drags set it; an unscoped-DBC drag (busId = null)
  /// falls back to the project's first bus so the frame has *some*
  /// destination — the user can re-pick it from the row's bus
  /// selector if that's wrong.
  const handleDropSignals = useCallback(
    (raw: string) => {
      const { signals: dropped } = parseSignalDragData(raw);
      if (dropped.length === 0) return;
      // De-dupe by message; each unique (canId, extended) makes one
      // frame. First-seen ref's `busId` / `messageName` carry over.
      const byMessage = new Map<
        string,
        { busId: string | null; canId: number; extended: boolean; messageName: string }
      >();
      for (const r of dropped) {
        const k = `${r.extended ? "x" : "s"}:${r.messageId}`;
        if (byMessage.has(k)) continue;
        byMessage.set(k, {
          busId: r.busId,
          canId: r.messageId,
          extended: r.extended,
          messageName: r.messageName,
        });
      }
      const fallbackBus = project.buses[0]?.id ?? null;
      setFrames((prev) => {
        const next: TransmitFrameConfig[] = [...prev];
        let n = prev.length;
        for (const m of byMessage.values()) {
          n += 1;
          next.push({
            id: crypto.randomUUID(),
            name: m.messageName || `Frame ${n}`,
            busId: m.busId ?? fallbackBus,
            canId: m.canId,
            extended: m.extended,
            kind: "classic",
            dataHex: "00",
            cycleMs: 100,
            cycleMode: "manual",
            brs: false,
            dlc: 0,
          });
        }
        return next;
      });
    },
    [project.buses],
  );

  const removeFrame = useCallback((id: string) => {
    setFrames((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const reorderFrames = useCallback((draggedId: string, beforeId: string | null) => {
    setFrames((prev) => {
      const dragged = prev.find((f) => f.id === draggedId);
      if (!dragged) return prev;
      const without = prev.filter((f) => f.id !== draggedId);
      if (beforeId === null) {
        return [...without, dragged];
      }
      const idx = without.findIndex((f) => f.id === beforeId);
      if (idx < 0) return [...without, dragged];
      return [...without.slice(0, idx), dragged, ...without.slice(idx)];
    });
  }, []);

  // Client-side cyclic scheduler. One handle per frame id while its
  // periodic mode is "started." Cleared on unmount, panel close,
  // frame removal, period change, or mode flip back to manual.
  const cyclicTimersRef = useRef<Map<string, number>>(new Map());
  const [cyclicTick, setCyclicTick] = useState(0);

  const stopCyclic = useCallback((id: string) => {
    const handle = cyclicTimersRef.current.get(id);
    if (handle !== undefined) {
      window.clearInterval(handle);
      cyclicTimersRef.current.delete(id);
      setCyclicTick((t) => t + 1);
    }
  }, []);

  // Mirror the project bus list into a ref so the cyclic scheduler's
  // captured closure sees the current names when it builds status
  // text. Frame itself is passed fresh per tick by `startCyclic`.
  const busesRef = useRef<readonly Bus[]>(project.buses);
  busesRef.current = project.buses;

  // Track the latest "connected bus ids" in a ref so the cyclic
  // scheduler's captured closure can skip ticks against a bus whose
  // session goes down mid-cycle, without restarting the interval.
  const connectedBusIdsRef = useRef<readonly string[]>(project.connectedBusIds);
  connectedBusIdsRef.current = project.connectedBusIds;

  const sendOnce = useCallback(async (frame: TransmitFrameConfig) => {
    if (!frame.busId) return;
    // No-op when the bus's session isn't up. Per-frame "is this bus
    // connected" is the projectContext's job; the transmit panel just
    // gates on the answer.
    if (!connectedBusIdsRef.current.includes(frame.busId)) return;
    const parsed = parseFrameForTransmit(frame);
    if (parsed.kind === "err") return;
    try {
      await invoke("transmit_frame", {
        request: { busId: frame.busId, ...parsed.request },
      });
    } catch {
      // Errors land in the system log via the host; nothing to surface
      // here. (Frontend-only validation errors are caught up-front in
      // `parseFrameForTransmit` and the input cells refuse bad chars.)
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

  // If a frame is removed or its period changed mid-schedule, kill its
  // timer so the running closure can't keep firing against stale data.
  useEffect(() => {
    const live = new Set(frames.map((f) => f.id));
    for (const id of [...cyclicTimersRef.current.keys()]) {
      if (!live.has(id)) {
        window.clearInterval(cyclicTimersRef.current.get(id)!);
        cyclicTimersRef.current.delete(id);
      }
    }
  }, [frames]);

  // Build the unique-by-(message_id, extended) catalog of DBC message
  // names so each row can resolve its id → message name.
  const messageNameByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of signals) {
      const key = `${s.extended ? "x" : "s"}:${s.message_id}`;
      if (!m.has(key)) m.set(key, s.message_name);
    }
    return m;
  }, [signals]);

  return (
    <div
      className="tx-panel"
      onDragOver={(e) => {
        // Accept the Phase-12 signal mime as a drop target. The TX
        // panel turns each dropped signal's parent message into a
        // new transmit frame (deduped by message). Other DnD mimes
        // (the panel's own frame-reorder) bubble through to the
        // row-level handlers below.
        if (e.dataTransfer.types.includes(SIGNAL_DND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(SIGNAL_DND_MIME)) return;
        e.preventDefault();
        handleDropSignals(e.dataTransfer.getData(SIGNAL_DND_MIME));
      }}
    >
      <div className="tx-panel-toolbar">
        <button type="button" onClick={addFrame}>
          + frame
        </button>
      </div>
      <div className="tx-panel-list">
        {frames.length === 0 && (
          <div className="tx-empty">
            No frames yet. Click "+ frame" to add one.
          </div>
        )}
        {frames.map((f) => (
          <TransmitFrameRow
            key={f.id}
            frame={f}
            buses={project.buses}
            busConnected={
              f.busId !== null && project.connectedBusIds.includes(f.busId)
            }
            messageName={
              messageNameByKey.get(`${f.extended ? "x" : "s"}:${f.canId}`) ?? null
            }
            onChange={(mut) => updateFrame(f.id, mut)}
            onRemove={() => removeFrame(f.id)}
            onReorder={reorderFrames}
            onSend={() => sendOnce(f)}
            onStartCyclic={() => startCyclic(f)}
            onStopCyclic={() => stopCyclic(f.id)}
            cyclicActive={cyclicTimersRef.current.has(f.id)}
            // Reading `cyclicTick` here in the parent keeps the child
            // re-rendering each time the timers map mutates without
            // having to thread the ref deeper.
            cyclicTick={cyclicTick}
          />
        ))}
        {frames.length > 0 && (
          <FrameDropZone onDropFrame={(id) => reorderFrames(id, null)} />
        )}
      </div>
    </div>
  );
}

interface FrameRowProps {
  frame: TransmitFrameConfig;
  buses: readonly Bus[];
  /// True when the frame's `busId` has a currently-running remote
  /// session. False also when `busId` is `null` (no bus picked yet).
  /// Drives the disabled-state of `send` / `start` / `stop` and the
  /// cyclic scheduler skips ticks while it's false.
  busConnected: boolean;
  messageName: string | null;
  onChange: (mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => void;
  onRemove: () => void;
  onReorder: (draggedId: string, beforeId: string | null) => void;
  onSend: () => void;
  onStartCyclic: () => void;
  onStopCyclic: () => void;
  cyclicActive: boolean;
  cyclicTick: number;
}

function TransmitFrameRow({
  frame,
  buses,
  busConnected,
  messageName,
  onChange,
  onRemove,
  onReorder,
  onSend,
  onStartCyclic,
  onStopCyclic,
  cyclicActive,
}: FrameRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [pendingRemove, setPendingRemove] = useState(false);
  const set = <K extends keyof TransmitFrameConfig>(
    key: K,
    value: TransmitFrameConfig[K],
  ) => onChange((f) => ({ ...f, [key]: value }));
  const busColor = frame.busId ? effectiveBusColor(frame.busId, buses) : "#475569";

  // The rich message descriptor lives at the row level — both the
  // frame-shape strip (which gets `kind` / `brs` from the DBC) and
  // the signals table need it, so one fetch covers both.
  const [descriptor, setDescriptor] = useState<MessageDescriptorRecord | null>(null);
  useEffect(() => {
    let cancelled = false;
    void invoke<MessageDescriptorRecord | null>("describe_message", {
      messageId: frame.canId,
      extended: frame.extended,
    })
      .then((d) => {
        if (!cancelled) setDescriptor(d);
      })
      .catch(() => {
        if (!cancelled) setDescriptor(null);
      });
    return () => {
      cancelled = true;
    };
  }, [frame.canId, frame.extended]);

  // DBC drives FD / BRS. When the id binds to a DBC message, mirror
  // the DBC's `isFd` onto the frame's `kind` and `brs`. If the DBC
  // ever updates the answer for the same id, the next descriptor
  // fetch reapplies. Unbinding (changing id away from a DBC message)
  // leaves the most recent DBC-derived values in place — the user
  // can then change them manually.
  useEffect(() => {
    if (!descriptor) return;
    const target: TransmitFrameConfig["kind"] = descriptor.isFd
      ? "fd"
      : "classic";
    const targetBrs = descriptor.brs;
    onChange((f) => {
      if (f.kind === "remote" || f.kind === "error") {
        // Don't yank a deliberately remote/error frame into a regular
        // one just because the DBC has a same-id signal-carrying
        // entry. (Remote / error frames share the arbitration id
        // space; if the user picked one of these kinds, they meant it.)
        return f;
      }
      if (f.kind === target && f.brs === targetBrs) return f;
      return { ...f, kind: target, brs: targetBrs };
    });
  }, [descriptor, onChange]);

  // Confirm-on-click for the remove button: first click arms it (the
  // button paints red + "remove?"), a second click within 3s removes.
  // A click elsewhere cancels.
  useEffect(() => {
    if (!pendingRemove) return;
    const t = window.setTimeout(() => setPendingRemove(false), 3000);
    return () => window.clearTimeout(t);
  }, [pendingRemove]);

  // Toggle expansion when the user clicks anywhere on the row that
  // isn't an interactive element. `closest(...)` catches clicks
  // inside the bus picker, byte cells, value-cells, send button, etc.
  // so those keep their own behaviour.
  const onRowClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (
      target.closest(
        "input, select, button, textarea, label, [contenteditable], [draggable=true]",
      )
    ) {
      return;
    }
    setExpanded((v) => !v);
  };

  return (
    <div
      className="tx-frame-row"
      onDragOver={onFrameRowDragOver}
      onDrop={(e) => onFrameRowDrop(e, frame.id, onReorder)}
      onClick={onRowClick}
    >
      <div
        className="tx-drag-handle"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(TX_FRAME_DND_MIME, frame.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        style={{ background: busColor }}
        title="drag to reorder · click row to expand"
        aria-label="reorder handle"
      />
      <div className="tx-frame-body">
        <div className="tx-row-line tx-row-identity">
          <CycleControls
            frame={frame}
            busConnected={busConnected}
            onChange={onChange}
            onSend={onSend}
            onStartCyclic={onStartCyclic}
            onStopCyclic={onStopCyclic}
            cyclicActive={cyclicActive}
          />
          <input
            className="tx-name"
            type="text"
            value={frame.name}
            onChange={(e) => set("name", e.target.value)}
            aria-label="frame name"
          />
          <select
            className={`tx-bus ${frame.busId ? "" : "tx-warn"}`}
            value={frame.busId ?? ""}
            onChange={(e) => set("busId", e.target.value || null)}
            aria-label="destination bus"
          >
            {!frame.busId && (
              <option value="">
                {buses.length === 0 ? "(no buses)" : "(pick a bus)"}
              </option>
            )}
            {buses.map((b) => (
              <option value={b.id} key={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <CanIdInput
            canId={frame.canId}
            extended={frame.extended}
            onChange={(canId) => set("canId", canId)}
          />
          {messageName && (
            <span className="tx-dbc-name" title="DBC message name">
              {messageName}
            </span>
          )}
          <button
            type="button"
            className="tx-expand"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            title={expanded ? "collapse" : "expand"}
          >
            {expanded ? "▾" : "▸"}
          </button>
          <button
            type="button"
            className={`tx-remove ${pendingRemove ? "tx-remove-armed" : ""}`}
            onClick={() => {
              if (pendingRemove) {
                onRemove();
              } else {
                setPendingRemove(true);
              }
            }}
            aria-label={pendingRemove ? "click again to confirm" : "remove frame"}
            title={pendingRemove ? "click again to confirm" : "remove frame"}
          >
            ×
          </button>
        </div>
        <BytesEditor frame={frame} onChange={onChange} />
        {expanded && (
          <div className="tx-expanded">
            <FrameShapeStrip
              frame={frame}
              descriptor={descriptor}
              onChange={onChange}
            />
            <SignalsTable
              frame={frame}
              descriptor={descriptor}
              onChange={onChange}
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface FrameShapeStripProps {
  frame: TransmitFrameConfig;
  descriptor: MessageDescriptorRecord | null;
  onChange: (mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => void;
}

/// Frame-shape strip — kind, extended, BRS (FD only), DLC (remote only).
/// `kind` and `brs` come from the DBC when the id binds to a message;
/// the controls are read-only in that case ("from DBC"). For
/// unbound frames the user picks both directly.
function FrameShapeStrip({ frame, descriptor, onChange }: FrameShapeStripProps) {
  const set = <K extends keyof TransmitFrameConfig>(
    key: K,
    value: TransmitFrameConfig[K],
  ) => onChange((f) => ({ ...f, [key]: value }));
  // When DBC-bound to a frame-shaped message (FD or classic), the
  // panel mirrors `isFd`/`brs` onto the frame state via TransmitFrameRow,
  // and the controls below switch to read-only. Remote / error
  // kinds aren't DBC-derivable, so the user can still pick them.
  const dbcOverridesKind =
    descriptor !== null && (frame.kind === "fd" || frame.kind === "classic");
  return (
    <div className="tx-shape-strip">
      <label className="tx-shape-field">
        <span>kind</span>
        <select
          value={frame.kind}
          onChange={(e) =>
            set("kind", e.target.value as TransmitFrameConfig["kind"])
          }
          disabled={dbcOverridesKind}
          title={
            dbcOverridesKind
              ? "DBC determines this (FD vs. classic via VFrameFormat / message size)"
              : undefined
          }
        >
          <option value="classic">classic</option>
          <option value="fd">FD</option>
          <option value="remote">remote</option>
          <option value="error">error</option>
        </select>
      </label>
      <label className="tx-shape-field tx-shape-checkbox">
        <input
          type="checkbox"
          checked={frame.extended}
          onChange={(e) => set("extended", e.target.checked)}
        />
        <span>extended id</span>
      </label>
      {frame.kind === "fd" && (
        <label className="tx-shape-field tx-shape-checkbox">
          <input
            type="checkbox"
            checked={frame.brs}
            onChange={(e) => set("brs", e.target.checked)}
            disabled={descriptor !== null}
            title={
              descriptor !== null
                ? "DBC determines this (GenMsgCANFDBRS attribute)"
                : undefined
            }
          />
          <span>BRS</span>
        </label>
      )}
      {frame.kind === "remote" && (
        <label className="tx-shape-field">
          <span>DLC</span>
          <input
            type="number"
            min={0}
            max={15}
            value={frame.dlc}
            onChange={(e) =>
              set(
                "dlc",
                Math.max(0, Math.min(15, Math.floor(e.target.valueAsNumber || 0))),
              )
            }
          />
        </label>
      )}
      {dbcOverridesKind && (
        <span className="tx-shape-hint">kind &amp; BRS from DBC</span>
      )}
    </div>
  );
}

interface SignalsTableProps {
  frame: TransmitFrameConfig;
  descriptor: MessageDescriptorRecord | null;
  onChange: (mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => void;
}

/// Signals table for the active mux arm. The rich message
/// descriptor (factor / offset / range / mux indicator / FD + BRS)
/// is loaded once at the [`TransmitFrameRow`] level and threaded
/// here as a prop; the decoded signal values come from `decode_frame`
/// on every `dataHex` change. Editing a value cell partial-encodes
/// that signal's bits via the host's `encode_frame` command.
function SignalsTable({ frame, descriptor, onChange }: SignalsTableProps) {
  const [decoded, setDecoded] = useState<DecodedFrameRecord | null>(null);

  // Re-decode the bytes on every change. The Tauri call is cheap and
  // we want the signals table to track byte-cell edits live.
  const bytes = useMemo(() => parseHexBytes(frame.dataHex, 64), [frame.dataHex]);
  useEffect(() => {
    let cancelled = false;
    void invoke<DecodedFrameRecord | null>("decode_frame", {
      messageId: frame.canId,
      extended: frame.extended,
      data: bytes,
    })
      .then((d) => {
        if (!cancelled) setDecoded(d);
      })
      .catch(() => {
        if (!cancelled) setDecoded(null);
      });
    return () => {
      cancelled = true;
    };
  }, [frame.canId, frame.extended, bytes]);

  const commitEdits = useCallback(
    async (edits: EncodeFrameSignal[]) => {
      // Pad the bytes to the message's declared length so signals
      // toward the high end of a partly-edited payload have somewhere
      // to land. Round up to a known frame size if expectedLen is 0
      // (defensive default — should never be the case for a well-
      // formed DBC).
      const expected = descriptor?.expectedLen ?? 0;
      const padded = bytes.slice();
      while (padded.length < expected) padded.push(0);
      try {
        const resp = await invoke<EncodeFrameResponse>("encode_frame", {
          messageId: frame.canId,
          extended: frame.extended,
          signals: edits,
          base: padded,
        });
        onChange((f) => ({ ...f, dataHex: bytesToHexString(resp.bytes) }));
      } catch {
        // Surface in system log; nothing to do here.
      }
    },
    [bytes, descriptor, frame.canId, frame.extended, onChange],
  );

  // Edit one signal, accounting for mux semantics: when the user
  // edits the switch (multiplexor) signal, zero out every sub-signal
  // of the *new* arm in the same encode call so the new arm starts
  // fresh (no leakage from the previous arm's bit pattern).
  const commitOneSignal = useCallback(
    (sig: SignalDescriptorRichRecord, physical: number) => {
      if (sig.mux.kind === "multiplexor" && descriptor) {
        const newSelector = Math.round(physical);
        const newArm = descriptor.signals
          .filter(
            (s) =>
              s.mux.kind === "multiplexed" && s.mux.selector === newSelector,
          )
          .map((s) => ({ name: s.name, physical: 0 }));
        void commitEdits([{ name: sig.name, physical }, ...newArm]);
        return;
      }
      void commitEdits([{ name: sig.name, physical }]);
    },
    [commitEdits, descriptor],
  );

  if (frame.kind !== "classic" && frame.kind !== "fd") {
    return null;
  }
  if (!descriptor) {
    return (
      <div className="tx-signals tx-signals-empty">
        <span>no DBC message matches this id</span>
      </div>
    );
  }
  if (descriptor.usesExtendedMux) {
    // Nested / extended multiplexing (`m<N>M` indicators). Not
    // supported for signal-level editing yet — the user can still
    // edit the raw bytes above. See plans/phased-implementation.md
    // Track 2 deferred follow-ups and ADR 0017.
    return (
      <div className="tx-signals tx-signals-extmux">
        <span>
          {descriptor.name} uses extended multiplexing — signal-level
          editing isn't supported here. Edit raw bytes above.
        </span>
      </div>
    );
  }
  const valuesByName = new Map<string, SignalRecord>();
  if (decoded) {
    for (const s of decoded.signals) valuesByName.set(s.name, s);
  }
  // Resolve the current switch value (if the message has a
  // multiplexor) so we can filter rows to the active arm. `decoded`
  // always carries the switch when one exists.
  const switchSig = descriptor.signals.find((s) => s.mux.kind === "multiplexor");
  const activeSelector =
    switchSig && valuesByName.has(switchSig.name)
      ? Math.round(valuesByName.get(switchSig.name)!.value)
      : null;
  // Active arm only — sub-signals for inactive arms are hidden, not
  // dimmed. Switching the switch zeroes the new arm's bits, so the
  // newly visible rows show 0 by default.
  const rows = descriptor.signals.filter((s) => {
    if (s.mux.kind === "plain" || s.mux.kind === "multiplexor") return true;
    if (s.mux.kind === "multiplexed") {
      return activeSelector !== null && s.mux.selector === activeSelector;
    }
    // `multiplexor_and_multiplexed` (sub-mux): not handled here.
    // Step 8 swaps the table out for a note when the message has any
    // of these; until then they're hidden.
    return false;
  });
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className="tx-signals">
      <div className="tx-signals-header">
        <span className="tx-col-name">name</span>
        <span className="tx-col-value">value</span>
        <span className="tx-col-unit">unit</span>
        <span className="tx-col-range">range</span>
      </div>
      {rows.map((sig) => (
        <SignalRow
          key={sig.name}
          messageId={frame.canId}
          extended={frame.extended}
          sig={sig}
          decoded={valuesByName.get(sig.name) ?? null}
          onCommit={(physical) => commitOneSignal(sig, physical)}
        />
      ))}
    </div>
  );
}

interface SignalRowProps {
  messageId: number;
  extended: boolean;
  sig: SignalDescriptorRichRecord;
  decoded: SignalRecord | null;
  onCommit: (physical: number) => void;
}

/// One row in the signals table — name · value · unit · range. Picks
/// between a plain numeric input and an enum combobox based on the
/// signal's `hasValueTable` flag.
function SignalRow({ messageId, extended, sig, decoded, onCommit }: SignalRowProps) {
  return (
    <div className="tx-signal-row" role="row">
      <span className="tx-col-name" title={sig.name}>
        {sig.name}
      </span>
      {sig.hasValueTable ? (
        <EnumValueCell
          messageId={messageId}
          extended={extended}
          sig={sig}
          decoded={decoded}
          onCommit={onCommit}
        />
      ) : (
        <NumericValueCell sig={sig} decoded={decoded} onCommit={onCommit} />
      )}
      <span className="tx-col-unit">{sig.unit}</span>
      <span className="tx-col-range">{formatRange(sig)}</span>
    </div>
  );
}

interface NumericValueCellProps {
  sig: SignalDescriptorRichRecord;
  decoded: SignalRecord | null;
  onCommit: (physical: number) => void;
}

function NumericValueCell({ sig, decoded, onCommit }: NumericValueCellProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? (decoded ? formatPhysical(decoded.value) : "");
  return (
    <input
      className="tx-col-value tx-signal-input"
      type="text"
      inputMode="decimal"
      value={display}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const n = Number(draft);
        if (Number.isFinite(n)) onCommit(n);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      }}
      aria-label={`${sig.name} value`}
    />
  );
}

interface EnumValueCellProps {
  messageId: number;
  extended: boolean;
  sig: SignalDescriptorRichRecord;
  decoded: SignalRecord | null;
  onCommit: (physical: number) => void;
}

/// Enum signal value cell. Combobox: an `<input>` linked to a
/// per-signal `<datalist>` of labels — the user types to filter the
/// label list, or types a raw number for the (rare) out-of-table
/// value. On commit:
///   1. exact label match → that row's raw value
///   2. numeric → that number directly
///   3. neither → cancel the edit (keep the current value)
///
/// The label table is loaded once per `(messageId, extended,
/// signal_name)` and cached on the component.
function EnumValueCell({
  messageId,
  extended,
  sig,
  decoded,
  onCommit,
}: EnumValueCellProps) {
  const [rows, setRows] = useState<ValueTableEntryRecord[]>([]);
  useEffect(() => {
    let cancelled = false;
    void invoke<ValueTableEntryRecord[]>("list_value_tables", {
      messageId,
      extended,
      signalName: sig.name,
    })
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [messageId, extended, sig.name]);

  const [draft, setDraft] = useState<string | null>(null);
  // Display: if decoded carries a label use it; else show the raw
  // physical (which for enum signals is typically raw=physical since
  // factor=1, offset=0).
  const currentLabel = decoded?.label ?? null;
  const currentRaw = decoded ? decoded.value : null;
  const display =
    draft ??
    (currentLabel
      ? currentLabel
      : currentRaw != null
        ? formatPhysical(currentRaw)
        : "");
  const datalistId = `tx-enum-${messageId}-${extended ? "x" : "s"}-${sig.name}`;
  return (
    <>
      <input
        className="tx-col-value tx-signal-input"
        type="text"
        list={datalistId}
        value={display}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === null) return;
          const text = draft.trim();
          setDraft(null);
          if (text === "") return;
          // Exact label match first — typing "Park" picks raw=0
          // regardless of how many "Park"-prefixed labels existed in
          // the datalist suggestions.
          const labelMatch = rows.find((r) => r.label === text);
          if (labelMatch) {
            onCommit(labelMatch.raw);
            return;
          }
          // Else parse as a number (raw value). For enum signals the
          // physical-vs-raw distinction collapses since factor/offset
          // are typically 1/0; if they aren't, this still sends the
          // physical value the user typed through `encode_frame` and
          // the encoder maps it back to bits.
          const n = Number(text);
          if (Number.isFinite(n)) onCommit(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        }}
        aria-label={`${sig.name} value (enum)`}
      />
      <datalist id={datalistId}>
        {rows.map((r) => (
          <option key={r.raw} value={r.label}>
            {r.raw}
          </option>
        ))}
      </datalist>
    </>
  );
}

/// Format a physical value for a single-cell display: compact
/// representation, trimmed trailing zeros, finite-precision so the
/// cell doesn't blow up on `0.1 + 0.2`-style noise.
function formatPhysical(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  // 6 significant digits is enough to distinguish factor=0.25 / 0.392…
  // signals at typical magnitudes; trim trailing zeros for compactness.
  const s = v.toPrecision(6);
  return Number(s).toString();
}

/// `[min, max]` if the DBC declared a real range, else derive from
/// `factor / offset / size / signed`. IEEE-float signals get an
/// open-ended placeholder (no integer range applies).
function formatRange(sig: SignalDescriptorRichRecord): string {
  if (sig.floatKind !== "integer") return "—";
  const haveDbcRange = sig.min !== sig.max;
  if (haveDbcRange) return `[${formatPhysical(sig.min)}, ${formatPhysical(sig.max)}]`;
  const size = sig.size;
  if (size <= 0 || size > 64) return "—";
  let rawMin: number;
  let rawMax: number;
  if (sig.signed) {
    rawMin = -(2 ** (size - 1));
    rawMax = 2 ** (size - 1) - 1;
  } else {
    rawMin = 0;
    rawMax = 2 ** size - 1;
  }
  const lo = rawMin * sig.factor + sig.offset;
  const hi = rawMax * sig.factor + sig.offset;
  const realLo = Math.min(lo, hi);
  const realHi = Math.max(lo, hi);
  return `[${formatPhysical(realLo)}, ${formatPhysical(realHi)}]`;
}

interface CycleControlsProps {
  frame: TransmitFrameConfig;
  /// True when the frame's bus has a live session. The send / start
  /// buttons are disabled and the cyclic scheduler skips ticks when
  /// this is false.
  busConnected: boolean;
  onChange: (mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => void;
  onSend: () => void;
  onStartCyclic: () => void;
  onStopCyclic: () => void;
  cyclicActive: boolean;
}

/// Manual / periodic toggle + the corresponding action(s):
///   - manual:  [send]
///   - periodic: [period-ms] [start] / [stop]
function CycleControls({
  frame,
  busConnected,
  onChange,
  onSend,
  onStartCyclic,
  onStopCyclic,
  cyclicActive,
}: CycleControlsProps) {
  const setMode = (mode: TransmitFrameConfig["cycleMode"]) => {
    // Flipping to manual stops any running cyclic for this frame.
    if (mode === "manual" && cyclicActive) onStopCyclic();
    onChange((f) => ({ ...f, cycleMode: mode }));
  };
  // Tooltip + disabled-state explanation. "Not connected" trumps
  // "no bus picked"; both lock the action.
  const sendDisabled = !frame.busId || !busConnected;
  const sendTitle = !frame.busId
    ? "pick a bus first"
    : !busConnected
      ? "bus not connected"
      : "send once";
  const startDisabled = !frame.busId || !busConnected || frame.cycleMs <= 0;
  const startTitle = !frame.busId
    ? "pick a bus first"
    : !busConnected
      ? "bus not connected"
      : frame.cycleMs <= 0
        ? "set a period first"
        : "start cyclic";
  return (
    <div className="tx-cycle">
      <div
        className="tx-cycle-toggle"
        role="tablist"
        aria-label="send mode"
      >
        <button
          type="button"
          role="tab"
          className={frame.cycleMode === "manual" ? "active" : undefined}
          onClick={() => setMode("manual")}
          aria-selected={frame.cycleMode === "manual"}
        >
          manual
        </button>
        <button
          type="button"
          role="tab"
          className={frame.cycleMode === "periodic" ? "active" : undefined}
          onClick={() => setMode("periodic")}
          aria-selected={frame.cycleMode === "periodic"}
        >
          periodic
        </button>
      </div>
      {frame.cycleMode === "manual" ? (
        <button
          type="button"
          className="tx-send"
          onClick={onSend}
          disabled={sendDisabled}
          title={sendTitle}
        >
          send
        </button>
      ) : (
        <>
          <input
            type="number"
            className="tx-period"
            min={1}
            value={frame.cycleMs}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const ms = Math.max(0, e.target.valueAsNumber || 0);
              onChange((f) => ({ ...f, cycleMs: ms }));
              if (cyclicActive) {
                // Period change while running: restart so the new
                // interval takes effect immediately.
                onStopCyclic();
              }
            }}
            aria-label="cycle period (ms)"
            title="period in milliseconds"
          />
          <span className="tx-period-unit">ms</span>
          {cyclicActive ? (
            <button type="button" className="tx-stop" onClick={onStopCyclic}>
              stop
            </button>
          ) : (
            <button
              type="button"
              className="tx-start"
              onClick={onStartCyclic}
              disabled={startDisabled}
              title={startTitle}
            >
              start
            </button>
          )}
        </>
      )}
    </div>
  );
}

interface CanIdInputProps {
  canId: number;
  extended: boolean;
  onChange: (canId: number) => void;
}

/// Hex CAN id input. Editing the field accepts only hex digits;
/// invalid input is rejected at the keypress level.
function CanIdInput({ canId, extended, onChange }: CanIdInputProps) {
  const width = extended ? 8 : 3;
  const text = canId.toString(16).toUpperCase().padStart(width, "0");
  return (
    <div className="tx-canid">
      <span className="tx-canid-prefix">{extended ? "x" : "s"}:0x</span>
      <input
        type="text"
        className="tx-canid-input"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          const cleaned = e.target.value.replace(/[^0-9a-fA-F]/g, "");
          if (cleaned.length === 0) {
            onChange(0);
            return;
          }
          const n = parseInt(cleaned, 16);
          if (Number.isFinite(n)) onChange(n);
        }}
        aria-label="CAN id (hex)"
      />
    </div>
  );
}

interface BytesEditorProps {
  frame: TransmitFrameConfig;
  onChange: (mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => void;
}

/// Per-byte hex cells. Classic frames show 8 cells; FD up to 64
/// (wrapping). Each cell is a 2-char hex input. Tab / Shift+Tab
/// traverse cells (browser default; cells are siblings in DOM
/// order). Empty cells decode as 0x00.
function BytesEditor({ frame, onChange }: BytesEditorProps) {
  const maxBytes = frame.kind === "classic" ? 8 : frame.kind === "fd" ? 64 : 0;
  const bytes = useMemo(() => parseHexBytes(frame.dataHex, maxBytes), [frame.dataHex, maxBytes]);

  if (frame.kind === "remote" || frame.kind === "error") {
    return (
      <div className="tx-bytes tx-bytes-none">
        <span className="tx-bytes-note">
          {frame.kind === "remote"
            ? `remote frame — no payload (DLC ${frame.dlc})`
            : "error frame — no payload"}
        </span>
      </div>
    );
  }

  const setByte = (index: number, value: number) => {
    const padded = bytes.slice();
    while (padded.length <= index) padded.push(0);
    padded[index] = value & 0xff;
    // Trim trailing zeros? No — we want to preserve the bytes the user
    // explicitly set. Keep the length at max(currentLen, index+1).
    onChange((f) => ({ ...f, dataHex: bytesToHexString(padded) }));
  };

  // Render `maxBytes` cells, defaulting unfilled cells to 0x00 so the
  // user can address any byte position by tabbing into it directly.
  const cells: number[] = [];
  for (let i = 0; i < maxBytes; i++) cells.push(bytes[i] ?? 0);

  return (
    <div className={`tx-bytes tx-bytes-${frame.kind}`} role="grid" aria-label="payload bytes">
      {cells.map((b, i) => (
        <ByteCell
          key={i}
          index={i}
          value={b}
          onChange={(v) => setByte(i, v)}
        />
      ))}
    </div>
  );
}

interface ByteCellProps {
  index: number;
  value: number;
  onChange: (v: number) => void;
}

function ByteCell({ index, value, onChange }: ByteCellProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? value.toString(16).toUpperCase().padStart(2, "0");

  return (
    <label className="tx-byte-cell" title={`byte ${index}`}>
      <span className="tx-byte-index">{index}</span>
      <input
        type="text"
        inputMode="numeric"
        maxLength={2}
        value={display}
        spellCheck={false}
        onChange={(e) => {
          const cleaned = e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 2);
          setDraft(cleaned);
        }}
        onBlur={() => {
          const n = draft === null || draft === "" ? 0 : parseInt(draft, 16);
          if (Number.isFinite(n)) onChange(n & 0xff);
          setDraft(null);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") {
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

/// Drop target after the last row — lets the user drop a dragged
/// frame at the end of the list.
function FrameDropZone({ onDropFrame }: { onDropFrame: (id: string) => void }) {
  return (
    <div
      className="tx-frame-dropzone"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TX_FRAME_DND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(TX_FRAME_DND_MIME);
        if (id) {
          e.preventDefault();
          onDropFrame(id);
        }
      }}
    />
  );
}

const TX_FRAME_DND_MIME = "application/x-cannet-tx-frame";

function onFrameRowDragOver(e: DragEvent<HTMLDivElement>) {
  if (e.dataTransfer.types.includes(TX_FRAME_DND_MIME)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }
}

function onFrameRowDrop(
  e: DragEvent<HTMLDivElement>,
  rowFrameId: string,
  onReorder: (draggedId: string, beforeId: string | null) => void,
) {
  const draggedId = e.dataTransfer.getData(TX_FRAME_DND_MIME);
  if (!draggedId || draggedId === rowFrameId) return;
  e.preventDefault();
  onReorder(draggedId, rowFrameId);
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
  /// added frame in a project with no buses yet — the panel surfaces
  /// a warning until the user picks one.
  busId: string | null;
  canId: number;
  extended: boolean;
  kind: "classic" | "fd" | "remote" | "error";
  dataHex: string;
  /// Cycle time in milliseconds. Used when `cycleMode === "periodic"`.
  cycleMs: number;
  /// `manual` shows a single `send` button. `periodic` shows the
  /// period input + start/stop.
  cycleMode: "manual" | "periodic";
  brs: boolean;
  dlc: number;
}

type ParseResult =
  | {
      kind: "ok";
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

function parseFrameForTransmit(frame: TransmitFrameConfig): ParseResult {
  const max = frame.kind === "classic" ? 8 : 64;
  const data = parseHexBytes(frame.dataHex, max);
  return {
    kind: "ok",
    request: {
      id: frame.canId,
      extended: frame.extended,
      kind: frame.kind,
      data,
      brs: frame.brs,
      // ESI is dropped from the UI; host still accepts the field for
      // wire compatibility.
      esi: false,
      dlc: frame.dlc,
    },
  };
}

function parseHexBytes(hex: string, max: number): number[] {
  const cleaned = hex.replace(/[^0-9a-fA-F]/g, "");
  const out: number[] = [];
  for (let i = 0; i + 1 < cleaned.length && out.length < max; i += 2) {
    const byte = parseInt(cleaned.slice(i, i + 2), 16);
    if (Number.isFinite(byte)) out.push(byte);
  }
  return out;
}

function bytesToHexString(bytes: number[]): string {
  return bytes
    .map((b) => (b & 0xff).toString(16).padStart(2, "0").toUpperCase())
    .join("");
}

function parseFramesParam(value: unknown): TransmitFrameConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isTransmitFrameConfig).map((f) => ({ ...f }));
}

function isTransmitFrameConfig(v: unknown): v is TransmitFrameConfig {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.id !== "string" ||
    typeof o.name !== "string" ||
    (o.busId != null && typeof o.busId !== "string") ||
    typeof o.canId !== "number" ||
    typeof o.extended !== "boolean" ||
    !(o.kind === "classic" || o.kind === "fd" || o.kind === "remote" || o.kind === "error") ||
    typeof o.dataHex !== "string" ||
    typeof o.cycleMs !== "number" ||
    typeof o.brs !== "boolean" ||
    typeof o.dlc !== "number"
  ) {
    return false;
  }
  // `cycleMode` was added with the panel rewrite; old saved frames
  // are coerced to "manual" so the user explicitly opts back in to
  // periodic transmit on first edit.
  if (
    o.cycleMode !== undefined &&
    o.cycleMode !== "manual" &&
    o.cycleMode !== "periodic"
  ) {
    return false;
  }
  // Pre-rewrite frames carry `esi: boolean` — ignored, not required.
  (o as { cycleMode?: TransmitFrameConfig["cycleMode"] }).cycleMode ??= "manual";
  return true;
}
