import { type KeyboardEvent, useMemo, useState } from "react";

import {
  type TransmitFrameConfig,
  bytesToHexString,
  parseHexBytes,
} from "./transmitFrameConfig";

interface BytesEditorProps {
  frame: TransmitFrameConfig;
  onChange: (mut: (f: TransmitFrameConfig) => TransmitFrameConfig) => void;
}

/// Per-byte hex cells. Classic frames show 8 cells; FD up to 64
/// (wrapping). Each cell is a 2-char hex input. Tab / Shift+Tab
/// traverse cells (browser default; cells are siblings in DOM
/// order). Empty cells decode as 0x00.
export function BytesEditor({ frame, onChange }: BytesEditorProps) {
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
