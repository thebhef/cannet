import {
  type DragEvent,
  type MouseEvent,
  useEffect,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";

import type { Bus, MessageDescriptorRecord } from "./types";
import { Combobox } from "./Combobox";
import { effectiveBusColor } from "./busColor";
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
  maxDataBytesForKind,
  resizeDataHexPreserving,
} from "./transmitFrameConfig";

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

export function TransmitFrameRow({
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
export function FrameDropZone({ onDropFrame }: { onDropFrame: (id: string) => void }) {
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
