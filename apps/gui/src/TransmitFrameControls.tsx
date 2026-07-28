import { useState } from "react";

import type { MessageDescriptorRecord } from "./types";
import { CalcFieldEditor } from "./CalcFieldEditor";
import { Combobox, type ComboboxOption } from "./Combobox";
import { formatCanIdHex } from "./format";
import type { TransmitFrameConfig } from "./transmitFrameConfig";

/// Calculated-fields row (ADR 0027): shows the message's effective
/// counter / CRC designation (the per-message override, else the
/// DBC's CannetCounter / CannetCrc defaults) and opens the shared
/// editor. One mechanism with the RBS panel.
export function CalcFieldsStrip({
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

const FRAME_KIND_OPTIONS: ComboboxOption[] = [
  { value: "classic", label: "classic" },
  { value: "fd", label: "FD" },
  { value: "remote", label: "remote" },
  { value: "error", label: "error" },
];

/// Frame-shape strip — kind, BRS (FD only), DLC (remote only). The
/// standard/extended toggle lives on the identity line next to the
/// CAN id (see `CanIdInput`), not here. `kind` and `brs` come from the
/// DBC when the id binds to a message; the controls are read-only in
/// that case ("from DBC"). For unbound frames the user picks both
/// directly.
export function FrameShapeStrip({ frame, descriptor, onChange }: FrameShapeStripProps) {
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
        <Combobox
          options={FRAME_KIND_OPTIONS}
          value={frame.kind}
          onChange={(v) => set("kind", v as TransmitFrameConfig["kind"])}
          disabled={dbcOverridesKind}
          title={
            dbcOverridesKind
              ? "DBC determines this (FD vs. classic via VFrameFormat / message size)"
              : undefined
          }
        />
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
export function CycleControls({
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
export function CanIdInput({ canId, extended, onChange, onExtendedChange }: CanIdInputProps) {
  const text = formatCanIdHex(canId, extended);
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
