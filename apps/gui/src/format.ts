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
/// span the magnitude, with `fracDigits` fractional digits (default 4,
/// i.e. 0.1 ms — what the trace shows; the plot widens it per
/// `fracDigitsForSpan` when zoomed in). The leading segment carries no
/// padding (`5.8710`, `1:05.0000`); lower segments are two-digit
/// zero-padded once a higher one is present (`1:05.0000`,
/// `2:00:03.5000`). Negative inputs (a frame stamped before the origin —
/// a bug, but render defensively) get a leading `-`.
export function formatElapsed(seconds: number, fracDigits = 4): string {
  const sign = seconds < 0 ? "-" : "";
  // Work in integer units of 10^-fracDigits so the fractional rounding
  // can't carry a 59.99996 up to a bare "60" seconds segment. Safe in a
  // double even at 9 digits: a day is 8.64e13 units, well under 2^53.
  const scale = 10 ** fracDigits;
  let rem = Math.round(Math.abs(seconds) * scale);
  const perDay = 86_400 * scale;
  const perHour = 3_600 * scale;
  const perMin = 60 * scale;
  const days = Math.floor(rem / perDay);
  rem -= days * perDay;
  const hours = Math.floor(rem / perHour);
  rem -= hours * perHour;
  const mins = Math.floor(rem / perMin);
  rem -= mins * perMin;
  const secs = Math.floor(rem / scale);
  const frac = String(rem - secs * scale).padStart(fracDigits, "0");
  const p2 = (n: number) => String(n).padStart(2, "0");
  let body: string;
  if (days > 0) body = `${days}:${p2(hours)}:${p2(mins)}:${p2(secs)}`;
  else if (hours > 0) body = `${hours}:${p2(mins)}:${p2(secs)}`;
  else if (mins > 0) body = `${mins}:${p2(secs)}`;
  else body = `${secs}`;
  return `${sign}${body}.${frac}`;
}

/// Fractional digits for a timeline-position label when the visible
/// x-window spans `spanSeconds`: the trace's 4-digit default for spans of
/// 1 s or more, plus one digit per decade of zoom below that (so adjacent
/// labels stay distinguishable down to pixel granularity), capped at 9
/// (nanosecond — the capture's native resolution). Degenerate spans
/// (zero, negative, non-finite) fall back to the default.
export function fracDigitsForSpan(spanSeconds: number): number {
  if (!Number.isFinite(spanSeconds) || spanSeconds <= 0) return 4;
  return Math.min(9, Math.max(4, 4 - Math.floor(Math.log10(spanSeconds))));
}

/// A *duration* (cursor Δt, a period) in plain seconds: fixed unit `s`,
/// never SI-rescaled to ms/µs, so durations read on one scale everywhere.
/// Rounded at nanosecond resolution, trailing zeros trimmed
/// (`0.05 s`, `0.00003 s`, `2 s`). Missing / non-finite values render as
/// an em dash.
export function formatDurationSeconds(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  return `${seconds.toFixed(9).replace(/\.?0+$/, "")} s`;
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
