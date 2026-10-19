import {
  formatDatePattern,
  parseDatePattern,
  roundInstant,
  type DatePattern,
  type Instant,
} from "./datePattern";
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
  return formatArbitrationId(frame.id, frame.extended, format);
}

/// The same string from a raw `(id, extended)` pair, for a surface that
/// names a message without holding a frame — an event's subject chip
/// names one structurally (ADR 0056). Same prefix rule, same reason: the
/// two id widths overlap numerically.
export function formatArbitrationId(
  id: number,
  extended: boolean,
  format: CanIdFormat,
): string {
  const text = format === "decimal" ? id.toString(10) : formatCanIdHex(id, extended);
  return `${extended ? "x" : "s"}:${text}`;
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
export function formatElapsed(seconds: number, fracDigits = ELAPSED_FRAC_DIGITS): string {
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
  // No fractional digits at all (a zoomed-out span) means no trailing
  // dot either — `2:00:03`, not `2:00:03.`.
  return fracDigits > 0 ? `${sign}${body}.${frac}` : `${sign}${body}`;
}

/// The fraction digits a table's elapsed time cell shows (`1:05.0000`);
/// the calendar reading of that cell (`formatCalendarCell`) keeps them.
export const ELAPSED_FRAC_DIGITS = 4;

/// Fractional digits for a timeline-position label when the visible
/// x-window spans `spanSeconds`: 4 digits at a 1 s span, one fewer per
/// decade zoomed out (down to 0 — whole seconds are plenty at an hour
/// scale), one more per decade zoomed in (up to 9, the capture's native
/// resolution — nanoseconds). Degenerate spans (zero, negative,
/// non-finite) fall back to the 1 s-span default.
export function fracDigitsForSpan(spanSeconds: number): number {
  if (!Number.isFinite(spanSeconds) || spanSeconds <= 0) return 4;
  return Math.min(9, Math.max(0, 4 - Math.floor(Math.log10(spanSeconds))));
}

/// A *duration* (cursor Δt, a period) in plain seconds: fixed unit `s`,
/// never SI-rescaled to ms/µs, so durations read on one scale everywhere.
/// With no `fracDigits`, rounded at nanosecond resolution; given one,
/// rounded to it instead — so a Δt chip can match the precision the
/// x-axis ticks are showing (ADR 0024). Either way, trailing zeros are
/// trimmed (`0.05 s`, `0.00003 s`, `2 s`). Missing / non-finite values
/// render as an em dash.
export function formatDurationSeconds(
  seconds: number | null | undefined,
  fracDigits = 9,
): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const fixed = seconds.toFixed(fracDigits);
  // Only trim when `toFixed` actually produced a fractional part — at
  // `fracDigits` 0 there is no dot, and trailing zeros are then the
  // integer's own, not padding to strip (`20 s`, not `2 s`).
  return `${fracDigits > 0 ? fixed.replace(/\.?0+$/, "") : fixed} s`;
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

/// The absolute instant a frame happened, rendered per the user's
/// `date_time_pattern` setting (ADR 0062) — the second reading of the
/// timestamp `formatTimestamp` renders as elapsed time (ADR 0024 rule
/// 4). The one calendar-time formatter every display site shares: the
/// trace, By-ID and event time-cell hovers, the plot's A/B chips and
/// x-tick hovers, the export extent labels, the logger grid's start /
/// end / modified columns, the System Messages column, and the BLF
/// channel-map modal's capture start.
///
/// `seconds` is the instant to render (Unix-epoch seconds) and `base`
/// the session origin that says whether there is a wall clock to name
/// at all (`hasWallClockAnchor`); `null` when there is not, because
/// reading capture-relative seconds as an epoch would invent an
/// instant. A caller with no session concept of its own — a file's own
/// timestamp, which is always a real instant — passes `seconds` for
/// both.
///
/// `pattern` is rendered at the local offset *of that instant*
/// (`getTimezoneOffset`'s negation), not of "now" — a historical
/// timestamp keeps its own DST rule. `pure`: callers read the setting
/// themselves (`useSetting("date_time_pattern")`, or `hostSettings()`
/// outside render) so tests stay pure.
export function formatCalendarTime(
  seconds: number,
  base: number | null,
  pattern: string,
): string | null {
  if (!hasWallClockAnchor(base)) return null;
  // Via milliseconds, not a direct `(seconds - whole) * 1e9`: at a
  // ~1.7e9 epoch magnitude, float64 only carries the fractional second
  // to about a microsecond, and subtracting first amplifies that into
  // the low nanosecond digits (122999907 instead of 123000000 for
  // ".123"). Rounding the millisecond product first is what the old
  // `toLocaleString`-based formatter did too, and matches every
  // caller's own precision: a trace frame's `timestamp_seconds` is
  // this same kind of float.
  const ms = Math.round(seconds * 1000);
  const whole = Math.floor(ms / 1000);
  const instant: Instant = { seconds: whole, nanos: (ms - whole * 1000) * 1e6 };
  const offsetMinutes = -new Date(seconds * 1000).getTimezoneOffset();
  const parsed = parseDatePattern(pattern);
  // The host validates `date_time_pattern` on write (ADR 0062), so a
  // stored pattern never fails to parse here; defensive only.
  if ("error" in parsed) return null;
  return formatDatePattern(parsed, instant, offsetMinutes);
}

/// An instant as the calendar formatters below read it: whole epoch
/// seconds plus nanoseconds, and the local offset (minutes east of UTC)
/// in force at that instant. Rounded to the microsecond first — at a
/// ~1.7e9 epoch magnitude a float64 carries the fractional second to
/// about 0.2 µs, so finer digits are float noise, and truncating noise
/// would turn `.1235` into `.1234999…` (the fraction is rounded after). Whole seconds and fraction come
/// from the same rounded integer, so they can never disagree.
function localInstant(seconds: number): { instant: Instant; offsetMinutes: number } {
  const micros = Math.round(seconds * 1e6);
  const whole = Math.floor(micros / 1e6);
  return {
    instant: { seconds: whole, nanos: (micros - whole * 1e6) * 1e3 },
    offsetMinutes: -new Date(whole * 1000).getTimezoneOffset(),
  };
}

const hasField = (pattern: DatePattern, letters: string) =>
  pattern.items.some((item) => "letter" in item && letters.includes(item.letter));

/// A table time cell under `time_display = calendar` (ADR 0024 rule 2):
/// the user's whole `date_time_pattern` (ADR 0062), then `.` and the
/// fraction to `fracDigits` digits — the digits the elapsed column
/// shows, so switching readings neither gains nor loses precision.
/// `2023-11-14 22:13:20.1234` for the default pattern at 4 digits.
///
/// The instant is **rounded** to `fracDigits` before any field is split,
/// like the pattern's own `S` field (ADR 0062 § 1), so the last digit
/// agrees with the elapsed column and a carry reaches the seconds,
/// minutes and beyond. A pattern that already carries an `S…` field
/// renders its own fraction and is given no second one — the user chose
/// that precision. `fracDigits` 0 appends nothing. The fraction is
/// appended after the *whole* pattern, wherever its seconds field sits.
///
/// `null` without a wall-clock anchor (`hasWallClockAnchor`), like
/// `formatCalendarTime`: a relative timeline names no instant, and the
/// cell shows elapsed time instead. Also renders a plot tick: pass
/// `calendarWindow`'s `tickPattern` (which has its own `S` field) and 0.
export function formatCalendarCell(
  seconds: number,
  base: number | null,
  pattern: string,
  fracDigits: number,
): string | null {
  if (!hasWallClockAnchor(base)) return null;
  const parsed = parseDatePattern(pattern);
  // The host validates `date_time_pattern` on write (ADR 0062); defensive.
  if ("error" in parsed) return null;
  const local = localInstant(seconds);
  const { offsetMinutes } = local;
  const appends = fracDigits > 0 && !hasField(parsed, "S");
  const instant = appends ? roundInstant(local.instant, fracDigits) : local.instant;
  const text = formatDatePattern(parsed, instant, offsetMinutes);
  if (!appends) return text;
  return `${text}.${String(instant.nanos).padStart(9, "0").slice(0, fracDigits)}`;
}

/// What a plot's x axis shows for the window `[fromSeconds, toSeconds]`
/// under `time_display = calendar` (ADR 0024 rule 2): a TR35 pattern for
/// its tick labels, and the axis title that carries the date.
///
/// `tickPattern` is time of day, 24-hour, and drops the leading fields
/// the whole window shares:
///
/// - the window starts and ends in the same local hour → `mm:ss`;
/// - otherwise → `HH:mm:ss` — across days too, since the title names
///   the dates.
///
/// Minutes and seconds always stay: a bare `ss` would read as elapsed
/// seconds. Then `.` and `S` × `fracDigitsForSpan(to − from)` — the same
/// digit count the elapsed ticks use at that zoom — none when that is 0.
///
/// `title` names the local calendar dates the window touches:
/// `Time on <date>` for one, `Time on <d1> and <d2>` for two, and
/// `Time between <first>, <last>` for more. A date renders through the
/// **date part** of the user's `date_time_pattern` (ADR 0062): its
/// `y` / `M` / `d` / `E` fields, from the first to the last of them, with
/// the literal text between two of them kept and any time field inside
/// that run read as a single space (`EEE dd MMM yyyy, HH:mm:ss` gives
/// `Tue 14 Nov 2023`). A pattern with no date field at all uses
/// `yyyy-MM-dd`.
///
/// Both read the machine's own zone, at each end's own offset. `null`
/// without a wall-clock anchor (`hasWallClockAnchor`), like
/// `formatCalendarTime` — the axis stays elapsed.
export function calendarWindow(
  fromSeconds: number,
  toSeconds: number,
  base: number | null,
  pattern: string,
): { tickPattern: string; title: string } | null {
  if (!hasWallClockAnchor(base)) return null;
  const parsed = parseDatePattern(pattern);
  // The host validates `date_time_pattern` on write (ADR 0062); defensive.
  if ("error" in parsed) return null;
  const from = localInstant(Math.min(fromSeconds, toSeconds));
  const to = localInstant(Math.max(fromSeconds, toSeconds));
  // Wall-clock seconds at each end, read as if they were UTC.
  const fromLocal = from.instant.seconds + from.offsetMinutes * 60;
  const toLocal = to.instant.seconds + to.offsetMinutes * 60;

  // A DST fall-back repeats an hour, so one hour also needs one offset.
  const oneHour =
    Math.floor(fromLocal / 3_600) === Math.floor(toLocal / 3_600) &&
    from.offsetMinutes === to.offsetMinutes;
  const digits = fracDigitsForSpan(Math.abs(toSeconds - fromSeconds));
  const tickPattern = `${oneHour ? "mm:ss" : "HH:mm:ss"}${digits > 0 ? `.${"S".repeat(digits)}` : ""}`;

  const datePart = datePartOf(parsed);
  const date = ({ instant, offsetMinutes }: ReturnType<typeof localInstant>) =>
    formatDatePattern(datePart, instant, offsetMinutes);
  const days = Math.floor(toLocal / 86_400) - Math.floor(fromLocal / 86_400) + 1;
  const title =
    days <= 1
      ? `Time on ${date(from)}`
      : days === 2
        ? `Time on ${date(from)} and ${date(to)}`
        : `Time between ${date(from)}, ${date(to)}`;
  return { tickPattern, title };
}

/// The date part of `pattern`, per `calendarWindow`'s rule; `yyyy-MM-dd`
/// when it has no date field.
function datePartOf(pattern: DatePattern): DatePattern {
  const isDate = (item: DatePattern["items"][number] | undefined) =>
    item !== undefined && "letter" in item && "yMdE".includes(item.letter);
  const first = pattern.items.findIndex(isDate);
  if (first < 0) {
    const fallback = parseDatePattern("yyyy-MM-dd");
    if ("error" in fallback) throw new Error(fallback.error);
    return fallback;
  }
  let last = first;
  pattern.items.forEach((item, i) => {
    if (isDate(item)) last = i;
  });
  const items: DatePattern["items"][number][] = [];
  for (let i = first; i <= last; i++) {
    const item = pattern.items[i];
    if (isDate(item)) items.push(item);
    else if ("literal" in item) {
      if (isDate(pattern.items[i - 1]) && isDate(pattern.items[i + 1])) items.push(item);
    } else if (!("literal" in items[items.length - 1])) {
      items.push({ literal: " " });
    }
  }
  return { items };
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
/// number — pass the host's `display_hex` flag, which marks the raw bit
/// fields whose DBC asked for hex (`CannetDisplay "radix=hex"`, ADR
/// 0043). Everything else, raw fields included, reads base 10. The
/// verdict is the host's; this only renders it.
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
