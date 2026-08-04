import type { TraceFrameRecord } from "./types";

/// Zero-padded hex digits for a CAN id — 8 digits for an extended
/// (29-bit) id, 3 for standard (11-bit). The width rule `formatId`
/// wraps in its `x:`/`s:`-prefixed string; also used bare wherever an
/// editable id field seeds its own text from a raw `(id, extended)`
/// pair (the prefix is its own control there, e.g. TransmitPanel's
/// `CanIdInput`).
export function formatCanIdHex(id: number, extended: boolean): string {
  const width = extended ? 8 : 3;
  return id.toString(16).toUpperCase().padStart(width, "0");
}

/// How a trace-style table renders an arbitration id — the
/// `can_id_format` setting, mirrored as a type so a call site cannot
/// pass a name the host would refuse.
export type CanIdFormat = "hex" | "decimal";

/// A frame's arbitration id for a trace-style table's `id` column.
///
/// The `s:` / `x:` prefix is not a formatting choice and stays in both
/// modes: 11-bit and 29-bit ids overlap numerically, so the width alone
/// cannot say which frame you are looking at. `format` is required
/// rather than defaulted — a caller that forgot it is how "hex only"
/// happened in the first place.
export function formatId(frame: TraceFrameRecord, format: CanIdFormat): string {
  const id =
    format === "decimal"
      ? frame.id.toString(10)
      : formatCanIdHex(frame.id, frame.extended);
  return `${frame.extended ? "x" : "s"}:${id}`;
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

/// Space-separated uppercase hex bytes (`"AA BB CC"`). The shared body
/// behind `formatData` (a trace frame's payload); also used directly
/// wherever the raw byte array is already in hand without a
/// `TraceFrameRecord` to wrap it (e.g. RBS's message payload).
export function formatBytes(data: readonly number[]): string {
  return data.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

export function formatData(frame: TraceFrameRecord): string {
  return formatBytes(frame.data);
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

/// The earliest session origin that can be a wall clock
/// (2000-01-01T00:00:00Z). ADR 0024 defines the origin as Unix-epoch
/// seconds, but a replayed log that carries no start time of its own has
/// no epoch to offer: the session is then anchored on the file's first
/// frame, whose timestamps are measured from the file's own zero — a few
/// seconds or hours, never the ~1.7e9 of a real instant. Nothing this
/// tool captures predates 2000, and no capture-relative timeline runs for
/// a quarter-century, so the magnitude separates the two cleanly.
const WALL_CLOCK_FLOOR_SECONDS = 946_684_800;

/// Whether the session origin `base` anchors the capture to a wall clock,
/// i.e. whether a frame's timestamp names an absolute instant at all.
/// `false` for a capture with no origin yet and for one replayed from a
/// log with no start time.
export function hasWallClockAnchor(base: number | null): boolean {
  return base !== null && base >= WALL_CLOCK_FLOOR_SECONDS;
}

/// `fractionalSecondDigits` is an ES2021 Intl option (supported by every
/// engine this app runs in); the project's TypeScript lib is ES2020, so
/// it is spelled out here rather than widening the lib for one call.
const LOCAL_TIMESTAMP_OPTIONS: Intl.DateTimeFormatOptions & {
  fractionalSecondDigits?: 1 | 2 | 3;
} = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  timeZoneName: "short",
};

/// The absolute instant a frame happened, as local date and time —
/// the second reading of the timestamp `formatTimestamp` renders as
/// elapsed time. Locale-aware, with the zone named so the reading is
/// unambiguous, and milliseconds kept (the instant of a single message
/// is the point of asking).
///
/// `seconds` is the frame's own timestamp and `base` the session origin;
/// `null` when the origin is not a wall clock (`hasWallClockAnchor`),
/// because there is then no absolute instant to name and reading the
/// capture-relative seconds as an epoch would invent one.
export function formatLocalTimestamp(seconds: number, base: number | null): string | null {
  if (!hasWallClockAnchor(base)) return null;
  return new Date(Math.round(seconds * 1000)).toLocaleString(undefined, LOCAL_TIMESTAMP_OPTIONS);
}

/// A per-id message rate (frames/second) for the by-id "msg/s" column.
/// Zero — an id seen only once, so no inter-arrival yet — shows blank;
/// otherwise one decimal below 100/s, whole numbers above.
export function formatMsgRate(rate: number): string {
  if (rate <= 0) return "";
  return rate < 100 ? rate.toFixed(1) : Math.round(rate).toString();
}

/// A decoded signal's numeric value — the magnitude alone. The unit and
/// any `VAL_` label are rendered as their own elements beside it
/// (`SignalValueText`), never concatenated in, so a row reads as a value
/// and its unit rather than one token.
///
/// `hex` renders the value as a bit pattern (`0xDEADBEEF`) instead of a
/// number — pass the host's `raw_field` flag, which marks the unscaled,
/// unitless, non-enum signals whose value is an id / serial / bit
/// pattern. The classification is the host's; this only renders it.
export function formatSignalValue(value: number, hex = false): string {
  return hex ? formatHex(value) : formatDecimal(value);
}

/// `0x`-prefixed uppercase hex, sign outside the digits (`-0x5`) so a
/// signed raw field stays readable.
function formatHex(value: number): string {
  return `${value < 0 ? "-" : ""}0x${Math.abs(value).toString(16).toUpperCase()}`;
}

function formatDecimal(value: number): string {
  // An exact integer always renders in full digits, however large: it is
  // a value the user needs digit-exact (a count, an id), and
  // `toExponential` drops the low digits.
  if (Number.isInteger(value)) return value.toFixed(0);
  // Otherwise trim insignificant trailing zeros and avoid noise like
  // "60.000000", falling back to exponential at the extremes.
  return Math.abs(value) >= 1e6 || (Math.abs(value) < 1e-3 && value !== 0)
    ? value.toExponential(3)
    : value.toFixed(3).replace(/\.?0+$/, "");
}
