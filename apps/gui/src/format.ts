import type { TraceFrameRecord } from "./types";

export function formatId(frame: TraceFrameRecord): string {
  const width = frame.extended ? 8 : 3;
  const hex = frame.id.toString(16).toUpperCase().padStart(width, "0");
  return `${frame.extended ? "x" : "s"}:${hex}`;
}

export function formatKind(frame: TraceFrameRecord): string {
  switch (frame.kind.kind) {
    case "classic":
      return "CAN";
    case "fd": {
      const flags = [
        frame.kind.brs ? "BRS" : null,
        frame.kind.esi ? "ESI" : null,
      ].filter(Boolean);
      return flags.length > 0 ? `CAN-FD ${flags.join("|")}` : "CAN-FD";
    }
    case "remote":
      return `RTR (DLC ${frame.kind.dlc})`;
    case "error":
      return "ERR";
  }
}

export function formatData(frame: TraceFrameRecord): string {
  return frame.data
    .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}

export function formatTimestamp(seconds: number, base: number | null): string {
  const t = base === null ? seconds : seconds - base;
  return t.toFixed(6);
}

/// A per-id message rate (frames/second) for the by-id "msg/s" column.
/// Zero — an id seen only once, so no inter-arrival yet — shows blank;
/// otherwise one decimal below 100/s, whole numbers above.
export function formatMsgRate(rate: number): string {
  if (rate <= 0) return "";
  return rate < 100 ? rate.toFixed(1) : Math.round(rate).toString();
}

export function formatSignalValue(value: number, unit: string): string {
  // Trim insignificant trailing zeros and avoid noise like "60.000000".
  const formatted = Math.abs(value) >= 1e6 || Math.abs(value) < 1e-3 && value !== 0
    ? value.toExponential(3)
    : value.toFixed(3).replace(/\.?0+$/, "");
  return unit ? `${formatted} ${unit}` : formatted;
}
