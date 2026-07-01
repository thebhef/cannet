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

/// The status-line frame-count phrase. Under windowed-ring eviction
/// (ADR 0002 DS-8) the live window holds only `[firstIndex, total)`, so
/// once the floor has advanced show "<retained> of <total> frames" — the
/// total keeps climbing while the retained count plateaus at the cap.
/// Before any eviction (floor at 0) it's just "<total> frames". The
/// retained count is clamped to zero so a stale floor (left for a tick by
/// a Clear) never renders negative.
export function formatFrameCount(total: number, firstIndex: number): string {
  if (firstIndex <= 0) return `${total.toLocaleString()} frames`;
  const retained = Math.max(0, total - firstIndex);
  return `${retained.toLocaleString()} of ${total.toLocaleString()} frames`;
}

/// Elapsed time as `[d:][hh:][mm:]ss.ffff` — only the segments needed to
/// span the magnitude, with a fixed four fractional digits (0.1 ms). The
/// leading segment carries no padding (`5.8710`, `1:05.0000`); lower
/// segments are two-digit zero-padded once a higher one is present
/// (`1:05.0000`, `2:00:03.5000`). Negative inputs (a frame stamped before
/// the origin — a bug, but render defensively) get a leading `-`.
export function formatElapsed(seconds: number): string {
  const sign = seconds < 0 ? "-" : "";
  // Work in integer ten-thousandths so the fractional rounding can't carry
  // a 59.99996 up to a bare "60" seconds segment.
  let rem = Math.round(Math.abs(seconds) * 1e4);
  const TTS_PER_DAY = 864_000_000;
  const TTS_PER_HOUR = 36_000_000;
  const TTS_PER_MIN = 600_000;
  const TTS_PER_SEC = 10_000;
  const days = Math.floor(rem / TTS_PER_DAY);
  rem -= days * TTS_PER_DAY;
  const hours = Math.floor(rem / TTS_PER_HOUR);
  rem -= hours * TTS_PER_HOUR;
  const mins = Math.floor(rem / TTS_PER_MIN);
  rem -= mins * TTS_PER_MIN;
  const secs = Math.floor(rem / TTS_PER_SEC);
  const frac = String(rem - secs * TTS_PER_SEC).padStart(4, "0");
  const p2 = (n: number) => String(n).padStart(2, "0");
  let body: string;
  if (days > 0) body = `${days}:${p2(hours)}:${p2(mins)}:${p2(secs)}`;
  else if (hours > 0) body = `${hours}:${p2(mins)}:${p2(secs)}`;
  else if (mins > 0) body = `${mins}:${p2(secs)}`;
  else body = `${secs}`;
  return `${sign}${body}.${frac}`;
}

/// Render a frame/event timestamp for a trace-style view: elapsed time since
/// the application-level trace start (ADR 0024). `base` is that single origin
/// (Unix-epoch seconds); `null` falls back to the raw timestamp.
export function formatTimestamp(seconds: number, base: number | null): string {
  return formatElapsed(base === null ? seconds : seconds - base);
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

/// Render a decoded signal with its `VAL_` label suffix when one is
/// present: `<value> "<label>"`. Mirrors what a typical CAN analyzer
/// shows for enum signals, leaving the numeric value visible alongside
/// the symbolic name so a user can still see "this raw value happens
/// to be 3" while reading "Drive".
export function formatSignalValueWithLabel(
  value: number,
  unit: string,
  label: string | null | undefined,
): string {
  const numeric = formatSignalValue(value, unit);
  return label ? `${numeric} "${label}"` : numeric;
}
