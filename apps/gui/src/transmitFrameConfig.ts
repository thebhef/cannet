import type {
  CalcFieldsSpec,
  TransmitFrameRecord,
  TransmitMode,
  TransmitRequestRecord,
} from "./types";

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
export function configsEqual(a: TransmitFrameConfig, b: TransmitFrameConfig): boolean {
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
export function recordToConfig(r: TransmitFrameRecord): TransmitFrameConfig {
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
export function configToFrame(c: TransmitFrameConfig): {
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

export function parseHexBytes(hex: string, max: number): number[] {
  const cleaned = hex.replace(/[^0-9a-fA-F]/g, "");
  const out: number[] = [];
  for (let i = 0; i + 1 < cleaned.length && out.length < max; i += 2) {
    const byte = parseInt(cleaned.slice(i, i + 2), 16);
    if (Number.isFinite(byte)) out.push(byte);
  }
  return out;
}

export function bytesToHexString(bytes: number[]): string {
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
