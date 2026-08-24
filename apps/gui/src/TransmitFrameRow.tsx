import {
  type DragEvent,
  type MouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";

import type { Bus, MessageDescriptorRecord } from "./types";
import { Combobox } from "./Combobox";
import { DisclosureToggle } from "./DisclosureToggle";
import { effectiveBusColor } from "./busColor";
import { theme, useThemeName } from "./theme";
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
import { NameText } from "./NameText";

interface FrameRowProps {
  frame: TransmitFrameConfig;
  buses: readonly Bus[];
  /// True when the frame's `busId` has a currently-running remote
  /// session. False also when `busId` is `null` (no bus picked yet).
  /// Drives the disabled-state of `send` / `start` / `stop` and the
  /// cyclic scheduler skips ticks while it's false.
  busConnected: boolean;
  /// The gridview's DOM id for this row, what `aria-activedescendant`
  /// names; whether the cursor is on it; whether it is in the selection.
  domId: string;
  active: boolean;
  selected: boolean;
  /// Feed a click on the tile to the gridview.
  onRowClick: (e: MouseEvent<HTMLDivElement>) => void;
  /// Expansion is the panel's now, keyed by frame id (ADR 0044) — a
  /// per-component boolean carried an open face onto whatever frame the
  /// list reorder moved into the slot.
  expanded: boolean;
  onSetExpanded: (expanded: boolean) => void;
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
  domId,
  active,
  selected,
  onRowClick: onGridRowClick,
  expanded,
  onSetExpanded,
  messageName,
  onChange,
  onRemove,
  onReorder,
  onSend,
  onStartCyclic,
  onStopCyclic,
  cyclicActive,
}: FrameRowProps) {
  const [pendingRemove, setPendingRemove] = useState(false);
  const set = <K extends keyof TransmitFrameConfig>(
    key: K,
    value: TransmitFrameConfig[K],
  ) => onChange((f) => ({ ...f, [key]: value }));
  // The bus tint is theme-derived unless the bus carries a stored color.
  useThemeName();
  const busColor = frame.busId ? effectiveBusColor(frame.busId, buses) : theme().busUnset;

  // The rich message descriptor lives at the row level — both the
  // frame-shape strip (which gets `kind` / `brs` from the DBC) and
  // the signals table need it, so one fetch covers both.
  const [descriptor, setDescriptor] = useState<MessageDescriptorRecord | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Scoped to the row's bus: only a database assigned to that bus
    // may describe the message, the same set that decodes it on the
    // wire. A row with no bus picked yet describes nothing.
    void invoke<MessageDescriptorRecord | null>("describe_message", {
      busId: frame.busId,
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
  }, [frame.busId, frame.canId, frame.extended]);

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

  // Toggle expansion when the user clicks the tile's own line and it
  // isn't an interactive element. `closest(...)` catches clicks
  // inside the bus picker, byte cells, value-cells, send button, etc.
  // so those keep their own behaviour.
  //
  // What the tile disclosed is not part of its toggle (ADR 0044): a
  // click on a signal name in the expanded face is a click on that
  // content, not on the row above it, and shutting the face the user
  // is reading out from under them is the defect that rule exists to
  // stop.
  //
  // The containment check is what keeps the row's floating layers
  // alive: a combobox dropdown (and the calculated-fields modal) render
  // through a portal, and React bubbles a portal's events up the
  // *component* tree, so picking an option would otherwise land here as
  // a background click — collapsing the row and unmounting the editor
  // the user was in the middle of. Only clicks inside the row's own box
  // are row clicks.
  const rowRef = useRef<HTMLDivElement | null>(null);
  const onRowClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!rowRef.current?.contains(target)) return;
    // Every click on the tile moves the gridview's cursor here…
    onGridRowClick(e);
    // …but only a click on the tile's own background toggles it.
    if (target.closest(".tx-expanded")) return;
    if (
      target.closest(
        "input, button, textarea, label, [contenteditable], [draggable=true]",
      )
    ) {
      return;
    }
    onSetExpanded(!expanded);
  };

  return (
    <div
      ref={rowRef}
      id={domId}
      className={selected ? "tx-frame-row tx-frame-row-selected" : "tx-frame-row"}
      data-active={active || undefined}
      aria-selected={selected}
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
              <NameText name={messageName} />
            </span>
          )}
          <DisclosureToggle
            className="tx-expand"
            compact
            expanded={expanded}
            title={expanded ? "collapse" : "expand"}
            ariaLabel={expanded ? "collapse" : "expand"}
            onToggle={() => onSetExpanded(!expanded)}
          />
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
