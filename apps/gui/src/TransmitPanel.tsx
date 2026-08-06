import { useCallback, useEffect, useMemo, useRef } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

import type {
  MessageDescriptorRecord,
  TransmitFrameRecord,
} from "./types";
import { useProjectContext } from "./projectContext";
import { useSignalCatalog } from "./signalCatalogContext";
import { SIGNAL_DND_MIME, dragHasSignals, parseSignalDragData } from "./dragSignals";
import { useElementPanel } from "./useElementPanel";
import { useHostMirror } from "./useHostMirror";
import { FrameDropZone, TransmitFrameRow } from "./TransmitFrameRow";
import {
  type TransmitFrameConfig,
  configToFrame,
  configsEqual,
  maxDataBytesForKind,
  recordToConfig,
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
        // Accept a payload carrying concrete signals: the TX panel
        // turns each dropped signal's parent message into a new
        // transmit frame (deduped by message). A pattern payload is
        // refused here — a rule names no message set to build frames
        // from (ADR 0045) — and refusing during `dragover` is the only
        // feedback the gesture can give. Other DnD mimes (the panel's
        // own frame-reorder) bubble through to the row-level handlers
        // below.
        if (dragHasSignals(e.dataTransfer.types)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        if (!dragHasSignals(e.dataTransfer.types)) return;
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
