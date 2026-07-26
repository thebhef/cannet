import {
  type DragEvent,
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
  MessageDescriptorRecord,
  TransmitFrameRecord,
} from "./types";
import { Combobox } from "./Combobox";
import { useProjectContext } from "./projectContext";
import { useSignalCatalog } from "./signalCatalogContext";
import { effectiveBusColor } from "./busColor";
import { SIGNAL_DND_MIME, parseSignalDragData } from "./dragSignals";
import { useElementPanel } from "./useElementPanel";
import { useHostMirror } from "./useHostMirror";
import { BytesEditor } from "./TransmitBytesEditor";
import { SignalsTable } from "./TransmitSignalsTable";
import {
  CalcFieldsStrip,
  CanIdInput,
  CycleControls,
  FrameShapeStrip,
} from "./TransmitFrameControls";
import {
  type TransmitFrameConfig,
  configToFrame,
  configsEqual,
  maxDataBytesForKind,
  recordToConfig,
  resizeDataHexPreserving,
  zeroDataHex,
} from "./transmitFrameConfig";

/**
 * Transmit panel (thin view over the host model).
 *
 * Single-column list of collapsible frame-tiles. Each tile carries its
 * own send / cyclic controls, identity (description, bus, id, DBC
 * message name), and byte editor in the collapsed face; expanding
 * reveals the frame-shape strip and a DBC signals table.
 *
 * The TX messages are **not** owned here. The host
 * (`transmit_frames::TransmitFrameRegistry`) holds the pool; this panel
 * lists it (`list_transmit_frames`), renders the subset named by its
 * element's `frameIds` group (in that order), and routes every edit /
 * send / start / stop through the matching Tauri command. The host
 * emits `transmit-frames-changed` on every mutation, which re-fetches
 * the pool. Periodic schedules run on host threads — there is no
 * client-side `setInterval`. See ADR 0003.
 *
 * Reorderable: drag the bus-tinted handle on the left of a row to
 * insert that frame before another (rewrites the element's `frameIds`).
 */
export function TransmitPanel(props: IDockviewPanelProps) {
  const project = useProjectContext();
  const { elementId, registry, persist } = useElementPanel(props, "transmit");

  // Persist just the elementId in panel params — the frame model is
  // host-owned now (no `frames` blob, so no `config` to write onto
  // the element).
  useEffect(() => {
    persist();
  }, [persist]);

  // This panel's group + display order: the transmit element's
  // `frameIds`. Mirrored into a ref so event-driven handlers read the
  // latest without re-binding.
  const element = registry.get(elementId)?.element;
  const frameIds = useMemo<readonly string[]>(
    () => (element && element.kind === "transmit" ? element.frameIds : []),
    [element],
  );
  const frameIdsRef = useRef<readonly string[]>(frameIds);
  frameIdsRef.current = frameIds;

  // The host TX-message pool, re-fetched whenever the host signals a
  // change (`transmit-frames-changed`) — plus, while anything in the
  // pool is running, a 500ms poll: the fire path rewrites a running
  // message's payload buffer (counter step, CRC) on every emission
  // without emitting the change-event (that at frame rate would storm
  // the IPC), so polling is what keeps the byte cells and decoded
  // signal values tracking the live buffer. Draft-in-progress cell
  // edits are unaffected (cells render `draft ?? committed`). This
  // panel renders only the entries in its `frameIds` group, in order.
  const fetchPool = useCallback(() => invoke<TransmitFrameRecord[]>("list_transmit_frames"), []);
  const { value: pool } = useHostMirror<TransmitFrameRecord[]>({
    fetch: fetchPool,
    fallback: [],
    event: "transmit-frames-changed",
    pollWhile: (p) => p.some((r) => r.running),
  });

  const poolById = useMemo(() => {
    const m = new Map<string, TransmitFrameRecord>();
    for (const r of pool) m.set(r.id, r);
    return m;
  }, [pool]);

  const frames = useMemo<TransmitFrameConfig[]>(
    () =>
      frameIds
        .map((id) => poolById.get(id))
        .filter((r): r is TransmitFrameRecord => r !== undefined)
        .map(recordToConfig),
    [frameIds, poolById],
  );
  const framesRef = useRef<readonly TransmitFrameConfig[]>(frames);
  framesRef.current = frames;

  // Keep the transmit *element's* `sinks` in sync with the union of
  // its frames' bus picks. The graph view reads `sinks` to draw
  // transmit→bus edges.
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
  // message name on a collapsed row. One record per (bus, signal); we
  // filter by frame's (bus_id, message_id, extended) at the row level.
  const { catalog: signals } = useSignalCatalog();

  // Persist one message to the host. Every cell edit lands here; the
  // host's `transmit-frames-changed` event re-fetches the pool, which
  // re-renders the row. For a running periodic, the host's schedule
  // thread picks up the edit on its next tick (no stop/start).
  const writeFrame = useCallback((cfg: TransmitFrameConfig) => {
    void invoke("set_transmit_frame", {
      id: cfg.id,
      frame: configToFrame(cfg),
    }).catch(() => {});
  }, []);

  const updateFrame = useCallback(
    (id: string, mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => {
      const current = framesRef.current.find((f) => f.id === id);
      if (!current) return;
      const next = mut(current);
      // Skip no-op writes. The row's DBC-derived effect re-invokes
      // `onChange` on every render (its `onChange` dep is a fresh
      // closure each time) but returns the frame unchanged once `kind`
      // / `brs` already match the DBC. Without this guard each such
      // call round-trips `set_transmit_frame` → `transmit-frames-
      // changed` → re-fetch → re-render → … a feedback loop that
      // storms the host and clobbers in-flight edits (e.g. the period
      // field) with the stale snapshot it captured.
      if (configsEqual(next, current)) return;
      writeFrame(next);
    },
    [writeFrame],
  );

  const addFrame = useCallback(() => {
    const id = crypto.randomUUID();
    const cfg: TransmitFrameConfig = {
      id,
      description: "",
      busId: project.buses[0]?.id ?? null,
      canId: 0x100,
      extended: false,
      kind: "classic",
      // Default to a full-length zero payload for the kind. If the id
      // happens to bind a DBC message, the row's descriptor effect
      // re-fits it to that message's declared length.
      dataHex: zeroDataHex(maxDataBytesForKind("classic")),
      cycleMs: 100,
      cycleMode: "manual",
      brs: false,
      dlc: 0,
      calc: null,
    };
    void invoke("set_transmit_frame", { id, frame: configToFrame(cfg) })
      .then(() =>
        registry.update(elementId, { frameIds: [...frameIdsRef.current, id] }),
      )
      .catch(() => {});
  }, [project.buses, registry, elementId]);

  /// Drop handler for the DBC-to-TX gesture. The drag
  /// payload is the shared `application/x-cannet-plot-signal` shape
  /// (one or more signal refs). A transmit frame is per-message, not
  /// per-signal — so we group by `(canId, extended)` and produce one
  /// new frame per distinct message. The dropped ref's `busId` flows
  /// onto the new frame; an unscoped drag (busId = null) falls back to
  /// the project's first bus.
  const handleDropSignals = useCallback(
    async (raw: string) => {
      const { signals: dropped } = parseSignalDragData(raw);
      if (dropped.length === 0) return;
      const byMessage = new Map<
        string,
        { busId: string | null; canId: number; extended: boolean }
      >();
      for (const r of dropped) {
        const k = `${r.extended ? "x" : "s"}:${r.messageId}`;
        if (byMessage.has(k)) continue;
        byMessage.set(k, {
          busId: r.busId,
          canId: r.messageId,
          extended: r.extended,
        });
      }
      const fallbackBus = project.buses[0]?.id ?? null;
      const newIds: string[] = [];
      for (const m of byMessage.values()) {
        const id = crypto.randomUUID();
        newIds.push(id);
        // Adding from the DBC: derive kind / BRS / payload length from
        // the message, and pre-fill the cycle period from its
        // GenMsgCycleTime attribute when present. (Hand-editing an id
        // to match a message does NOT touch the period — see the row's
        // descriptor effect.)
        const desc = await invoke<MessageDescriptorRecord | null>(
          "describe_message",
          { messageId: m.canId, extended: m.extended },
        ).catch(() => null);
        const kind: TransmitFrameConfig["kind"] = desc?.isFd ? "fd" : "classic";
        const len = desc ? desc.expectedLen : maxDataBytesForKind(kind);
        const cfg: TransmitFrameConfig = {
          id,
          description: "",
          busId: m.busId ?? fallbackBus,
          canId: m.canId,
          extended: m.extended,
          kind,
          dataHex: zeroDataHex(Math.min(len, maxDataBytesForKind(kind))),
          cycleMs:
            desc?.genMsgCycleTimeMs && desc.genMsgCycleTimeMs > 0
              ? desc.genMsgCycleTimeMs
              : 100,
          cycleMode: "manual",
          brs: desc?.brs ?? false,
          dlc: 0,
          calc: null,
        };
        void invoke("set_transmit_frame", { id, frame: configToFrame(cfg) }).catch(
          () => {},
        );
      }
      if (newIds.length > 0) {
        registry.update(elementId, {
          frameIds: [...frameIdsRef.current, ...newIds],
        });
      }
    },
    [project.buses, registry, elementId],
  );

  const removeFrame = useCallback(
    (id: string) => {
      void invoke("remove_transmit_frame", { id }).catch(() => {});
      registry.update(elementId, {
        frameIds: frameIdsRef.current.filter((x) => x !== id),
      });
    },
    [registry, elementId],
  );

  const reorderFrames = useCallback(
    (draggedId: string, beforeId: string | null) => {
      const ids = frameIdsRef.current;
      if (!ids.includes(draggedId)) return;
      const without = ids.filter((x) => x !== draggedId);
      let next: string[];
      if (beforeId === null) {
        next = [...without, draggedId];
      } else {
        const idx = without.indexOf(beforeId);
        next =
          idx < 0
            ? [...without, draggedId]
            : [...without.slice(0, idx), draggedId, ...without.slice(idx)];
      }
      registry.update(elementId, { frameIds: next });
      // Keep the host pool order aligned with the displayed group order
      // (single-panel common case); other panels' display order is
      // still governed by their own `frameIds`.
      void invoke("reorder_transmit_frames", { ids: next }).catch(() => {});
    },
    [registry, elementId],
  );

  // Running state per id comes from the host (a live periodic thread),
  // not a client timer map.
  const runningById = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const r of pool) m.set(r.id, r.running);
    return m;
  }, [pool]);

  const sendOnce = useCallback((id: string) => {
    void invoke("transmit_frame_once", { id }).catch(() => {});
  }, []);
  const startCyclic = useCallback((id: string) => {
    void invoke("start_periodic_transmit", { id }).catch(() => {});
  }, []);
  const stopCyclic = useCallback((id: string) => {
    void invoke("stop_periodic_transmit", { id }).catch(() => {});
  }, []);

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
        // Accept the signal mime as a drop target. The TX
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
            onSend={() => sendOnce(f.id)}
            onStartCyclic={() => startCyclic(f.id)}
            onStopCyclic={() => stopCyclic(f.id)}
            cyclicActive={runningById.get(f.id) ?? false}
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

  // DBC drives FD / BRS / payload length. When the id binds to a DBC
  // message, mirror the DBC's `isFd` onto the frame's `kind` / `brs`
  // and re-fit the payload to the message's declared byte length
  // (preserving the bytes the user already set — see
  // `resizeDataHexPreserving`). This is what makes a frame decodable
  // (and plottable) as soon as its id matches a message, instead of
  // staying truncated until a value is hand-edited. The cycle period
  // and manual/periodic mode are deliberately left untouched here —
  // those are only seeded when a frame is first added from the DBC. If
  // the DBC updates the answer for the same id, the next descriptor
  // fetch reapplies. Unbinding (changing id away from a DBC message)
  // leaves the most recent DBC-derived values in place.
  useEffect(() => {
    if (!descriptor) return;
    const target: TransmitFrameConfig["kind"] = descriptor.isFd
      ? "fd"
      : "classic";
    const targetBrs = descriptor.brs;
    const targetLen = Math.min(descriptor.expectedLen, maxDataBytesForKind(target));
    onChange((f) => {
      if (f.kind === "remote" || f.kind === "error") {
        // Don't yank a deliberately remote/error frame into a regular
        // one just because the DBC has a same-id signal-carrying
        // entry. (Remote / error frames share the arbitration id
        // space; if the user picked one of these kinds, they meant it.)
        return f;
      }
      const targetDataHex = resizeDataHexPreserving(f.dataHex, targetLen);
      if (f.kind === target && f.brs === targetBrs && f.dataHex === targetDataHex) {
        return f;
      }
      return { ...f, kind: target, brs: targetBrs, dataHex: targetDataHex };
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
        "input, button, textarea, label, [contenteditable], [draggable=true]",
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
            value={frame.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="description"
            aria-label="frame description"
          />
          <Combobox
            className={`tx-bus ${frame.busId ? "" : "tx-warn"}`}
            options={buses.map((b) => ({ value: b.id, label: b.name }))}
            value={frame.busId ?? ""}
            onChange={(v) => set("busId", v || null)}
            placeholder={buses.length === 0 ? "(no buses)" : "(pick a bus)"}
            ariaLabel="destination bus"
          />
          <CanIdInput
            canId={frame.canId}
            extended={frame.extended}
            onChange={(canId) => set("canId", canId)}
            onExtendedChange={(ext) => set("extended", ext)}
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
            <CalcFieldsStrip
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


