import {
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
import { listen } from "@tauri-apps/api/event";

import type {
  Bus,
  CalcFieldsSpec,
  DecodedFrameRecord,
  EncodeFrameResponse,
  EncodeFrameSignal,
  MessageDescriptorRecord,
  SignalDescriptorRecord,
  SignalDescriptorRichRecord,
  SignalRecord,
  TransmitFrameRecord,
  TransmitMode,
  TransmitRequestRecord,
  ValueTableEntryRecord,
} from "./types";
import { useElementRegistry } from "./projectElements";
import { CalcFieldEditor } from "./CalcFieldEditor";
import { useProjectContext } from "./projectContext";
import { effectiveBusColor } from "./busColor";
import { SIGNAL_DND_MIME, parseSignalDragData } from "./dragSignals";

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
  const { api } = props;
  const params = props.params as { elementId?: unknown } | undefined;
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

  // Persist just the elementId in panel params — the frame model is
  // host-owned now (no `frames` blob).
  useEffect(() => {
    api.updateParameters({ elementId });
  }, [api, elementId]);

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
  // change. This panel renders only the entries in its `frameIds`
  // group, in that order.
  const [pool, setPool] = useState<TransmitFrameRecord[]>([]);
  const refreshPool = useCallback(() => {
    void invoke<TransmitFrameRecord[]>("list_transmit_frames")
      .then(setPool)
      .catch(() => setPool([]));
  }, []);
  useEffect(() => {
    refreshPool();
    const unlisten = listen("transmit-frames-changed", refreshPool);
    return () => {
      void unlisten.then((off) => off());
    };
  }, [refreshPool]);

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
            value={frame.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="description"
            aria-label="frame description"
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

/// Calculated-fields row (ADR 0027): shows the message's effective
/// counter / CRC designation (the per-message override, else the
/// DBC's CannetCounter / CannetCrc defaults) and opens the shared
/// editor. One mechanism with the RBS panel.
function CalcFieldsStrip({
  frame,
  descriptor,
  onChange,
}: {
  frame: TransmitFrameConfig;
  descriptor: MessageDescriptorRecord | null;
  onChange: (mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const dbcDefaults = descriptor?.calcFields ?? null;
  const counter = frame.calc?.counter ?? dbcDefaults?.counter ?? null;
  const crc = frame.calc?.crc ?? dbcDefaults?.crc ?? null;
  const summary = [
    counter ? `counter: ${counter.signal}` : null,
    crc ? `crc: ${crc.signal}${crc.algorithm ? ` (${crc.algorithm})` : ""}` : null,
  ]
    .filter(Boolean)
    .join("  ·  ");
  return (
    <div className="tx-calc-strip">
      <span className="tx-calc-label">calculated fields</span>
      <span className="tx-calc-summary">
        {summary || "none"}
        {frame.calc && <em> (override)</em>}
      </span>
      <button type="button" onClick={() => setOpen(true)}>
        fields…
      </button>
      {frame.calc && (
        <button
          type="button"
          className="rbs-clear"
          title="clear override (track the DBC's declared defaults)"
          onClick={() => onChange((f) => ({ ...f, calc: null }))}
        >
          ×
        </button>
      )}
      {open && (
        <CalcFieldEditor
          messageLabel={descriptor?.name ?? `0x${frame.canId.toString(16).toUpperCase()}`}
          signalNames={descriptor?.signals.map((s) => s.name) ?? []}
          dbcDefaults={dbcDefaults}
          current={frame.calc}
          onSave={(spec) => {
            onChange((f) => ({ ...f, calc: spec }));
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  );
}

interface FrameShapeStripProps {
  frame: TransmitFrameConfig;
  descriptor: MessageDescriptorRecord | null;
  onChange: (mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => void;
}

/// Frame-shape strip — kind, BRS (FD only), DLC (remote only). The
/// standard/extended toggle lives on the identity line next to the
/// CAN id (see `CanIdInput`), not here. `kind` and `brs` come from the
/// DBC when the id binds to a message; the controls are read-only in
/// that case ("from DBC"). For unbound frames the user picks both
/// directly.
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
    // edit the raw bytes above. See ADR 0017 for the
    // deferred signal-level-edit follow-ups.
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
    // `multiplexor_and_multiplexed` (sub-mux): not handled here —
    // these signals are hidden for now.
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
          <PeriodInput
            cycleMs={frame.cycleMs}
            onCommit={(ms) => onChange((f) => ({ ...f, cycleMs: ms }))}
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

/// Period (ms) input with revert-on-blur. The user can type freely
/// (including a transient empty / invalid value); blurring commits a
/// positive integer, but a non-positive / empty value reverts to the
/// last valid `cycleMs` **without dispatching** — so clearing the
/// field mid-edit never sends `cycle_ms = 0` to the host (which would
/// stop a running periodic). The committed value flows through
/// `set_transmit_frame`; a running periodic re-pitches on its next
/// host-side tick.
function PeriodInput({
  cycleMs,
  onCommit,
}: {
  cycleMs: number;
  onCommit: (ms: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      className="tx-period"
      min={1}
      value={draft ?? String(cycleMs)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const ms = Math.floor(Number(draft));
        setDraft(null);
        if (Number.isFinite(ms) && ms > 0) onCommit(ms);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      }}
      aria-label="cycle period (ms)"
      title="period in milliseconds"
    />
  );
}

interface CanIdInputProps {
  canId: number;
  extended: boolean;
  onChange: (canId: number) => void;
  onExtendedChange: (extended: boolean) => void;
}

/// Hex CAN id input with an inline standard/extended toggle. The
/// `s:`/`x:` prefix is a button that flips the addressing mode in
/// place — the toggle lives right next to the id (top level) rather
/// than buried in the expanded frame-shape strip. Editing the field
/// accepts only hex digits; invalid input is rejected at the keypress
/// level.
function CanIdInput({ canId, extended, onChange, onExtendedChange }: CanIdInputProps) {
  const width = extended ? 8 : 3;
  const text = canId.toString(16).toUpperCase().padStart(width, "0");
  return (
    <div className="tx-canid">
      <button
        type="button"
        className="tx-canid-prefix"
        onClick={() => onExtendedChange(!extended)}
        title={extended ? "extended (29-bit) id — click for standard" : "standard (11-bit) id — click for extended"}
        aria-label={extended ? "extended id (click to switch to standard)" : "standard id (click to switch to extended)"}
      >
        {extended ? "x" : "s"}:0x
      </button>
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

/// The panel's per-row working shape — a UI-friendly view of one host
/// [`TransmitFrameRecord`](./types). `dataHex` is the editable bytes
/// string (the host model carries `request.data` as a byte array);
/// `cycleMode` mirrors the host `mode`. `description` is the optional
/// user annotation — the displayed *name* is the DBC message name
/// resolved from `canId`, not a field here.
///
/// The destination bus is **per-frame** (`busId`); the panel auto-syncs
/// the transmit element's `sinks` to the union of its frames' bus picks
/// so the graph view shows which buses this panel is wired to.
export interface TransmitFrameConfig {
  id: string;
  description: string;
  /// Logical bus this frame transmits onto. `null` only on a freshly
  /// added frame in a project with no buses yet — the panel surfaces
  /// a warning until the user picks one. Maps to the host's
  /// `request.busId` (empty string when null).
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
  /// Calculated-field override spec (ADR 0027): `null` means the
  /// DBC's declared defaults apply per field. Persisted with the
  /// message (`TransmitFrame.calc`).
  calc: CalcFieldsSpec | null;
}

/// Field-wise equality of two working configs (all fields are
/// primitives — `dataHex` carries the payload as a string), used to
/// drop no-op `set_transmit_frame` writes.
function configsEqual(a: TransmitFrameConfig, b: TransmitFrameConfig): boolean {
  return (
    a.id === b.id &&
    a.description === b.description &&
    a.busId === b.busId &&
    a.canId === b.canId &&
    a.extended === b.extended &&
    a.kind === b.kind &&
    a.dataHex === b.dataHex &&
    a.cycleMs === b.cycleMs &&
    a.cycleMode === b.cycleMode &&
    a.brs === b.brs &&
    a.dlc === b.dlc &&
    // The calc spec is a small plain-data tree; structural equality
    // by serialisation keeps `configsEqual` total without a
    // hand-written deep compare.
    JSON.stringify(a.calc) === JSON.stringify(b.calc)
  );
}

/// Map a host TX-message record into the panel's working shape.
function recordToConfig(r: TransmitFrameRecord): TransmitFrameConfig {
  return {
    id: r.id,
    description: r.description,
    busId: r.request.busId === "" ? null : r.request.busId,
    canId: r.request.id,
    extended: r.request.extended,
    kind: r.request.kind,
    dataHex: bytesToHexString(r.request.data),
    cycleMs: r.cycleMs,
    cycleMode: r.mode === "periodic" ? "periodic" : "manual",
    brs: r.request.brs,
    dlc: r.request.dlc,
    calc: r.calc ?? null,
  };
}

/// Map the panel's working shape back to the host `set_transmit_frame`
/// payload. Carries `id` (the host re-stamps it from the command arg)
/// so the registry round-trips the same entry.
function configToFrame(c: TransmitFrameConfig): {
  id: string;
  description: string;
  request: TransmitRequestRecord;
  cycleMs: number;
  mode: TransmitMode;
  calc: CalcFieldsSpec | null;
} {
  const max = c.kind === "classic" ? 8 : 64;
  const data =
    c.kind === "remote" || c.kind === "error"
      ? []
      : parseHexBytes(c.dataHex, max);
  return {
    id: c.id,
    description: c.description,
    request: {
      busId: c.busId ?? "",
      id: c.canId,
      extended: c.extended,
      kind: c.kind,
      data,
      brs: c.brs,
      // ESI is dropped from the UI; host still accepts the field for
      // wire compatibility.
      esi: false,
      dlc: c.dlc,
    },
    cycleMs: c.cycleMs,
    mode: c.cycleMode === "periodic" ? "periodic" : "manual",
    calc: c.calc,
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

/// Maximum payload bytes a frame of this kind can carry: 8 for classic,
/// 64 for FD, 0 for remote / error (no payload). Used to size a fresh
/// frame's default payload when no DBC message constrains the length.
export function maxDataBytesForKind(kind: TransmitFrameConfig["kind"]): number {
  return kind === "classic" ? 8 : kind === "fd" ? 64 : 0;
}

/// A zero-filled payload of `len` bytes as a hex string — the default
/// payload for a freshly-created frame so it decodes (and plots)
/// immediately instead of being silently dropped for being too short.
export function zeroDataHex(len: number): string {
  return bytesToHexString(new Array(Math.max(0, len)).fill(0));
}

/// Resize `hex` to exactly `len` bytes, preserving the leading bytes
/// the user already set: pad with `0x00` when growing, drop trailing
/// bytes when shrinking. Used to re-fit a frame's payload to its DBC
/// message's declared length on an id match without clobbering the
/// meaningful bytes.
export function resizeDataHexPreserving(hex: string, len: number): string {
  const bytes = parseHexBytes(hex, 64).slice(0, Math.max(0, len));
  while (bytes.length < len) bytes.push(0);
  return bytesToHexString(bytes);
}

