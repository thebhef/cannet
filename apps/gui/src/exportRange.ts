// The export dialog's range arithmetic.
//
// A bound is one of three things, and telling them apart is the whole
// job here:
//
//   - **the default** — an empty field, which means "the capture's
//     start" on the left and "the last message captured" on the right.
//     It stays the default rather than resolving to a number, so a
//     trailing selection keeps following the live edge and an unbounded
//     export reaches the host with no filter at all.
//   - **a wall clock** (`[Nd ]HH:MM[:SS]`) — only on a capture that has
//     an anchor. An unanchored one names no instants (ADR 0024), so the
//     field takes and shows seconds-from-start there instead. `Nd` is
//     the calendar day, counted from the capture's start date: without
//     it a clock can only name an instant in the capture's first 24
//     hours, which a capture that runs for days cannot live with.
//   - **an offset** — bare seconds from the capture's start.
//
// Everything in here works in seconds *from the session origin*, the one
// timescale every renderer shares (ADR 0024). Absolute nanoseconds are
// produced once, at the wire, by `exportRangeNs`.

import { formatElapsed } from "./format";

/// A bound in seconds from the session origin, or `null` for the bound's
/// own default (the capture's start / the live edge).
export type RangeBound = number | null;

/// The selected export range.
export interface ExportRangeSelection {
  from: RangeBound;
  to: RangeBound;
}

/// Both bounds default: the whole capture, up to wherever the live edge
/// is when the write finishes.
export const WHOLE_CAPTURE: ExportRangeSelection = { from: null, to: null };

/// One of the capture's timeline events (ADR 0035) offered as a bound —
/// `seconds` is its time on the shared timescale.
export interface RangeEvent {
  id: string;
  label: string;
  seconds: number;
}

/// What the capture's timeline is, for reading and writing bounds
/// against it.
export interface RangeContext {
  /// Whether the capture's origin is a wall clock (`hasWallClockAnchor`).
  /// `false` disables wall-clock bounds entirely — ruled 2026-09-06.
  anchored: boolean;
  /// The session origin, Unix-epoch seconds.
  sessionStartSeconds: number;
  /// The capture's span, for the trailing presets.
  durationSeconds: number;
}

/// A bound is "on" an event when it is within this many seconds of it —
/// the tolerance that lets a bound set by clicking a tick, or dragged
/// close to one, read back as the event rather than as a bare time.
const EVENT_TOLERANCE_SECONDS = 1;

const SECONDS_PER_DAY = 86_400;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/// Local midnight of the day `ms` falls on. Calendar days, not
/// 86400-second blocks, so a DST transition inside the capture does not
/// shift every later day's index by an hour.
function localMidnight(ms: number): Date {
  const at = new Date(ms);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

/// Which calendar day of the capture an instant falls on: 0 for the
/// day it started, 1 for the next, and so on.
function dayIndex(ctx: RangeContext, atMs: number): number {
  const from = localMidnight(ctx.sessionStartSeconds * 1000).getTime();
  return Math.round((localMidnight(atMs).getTime() - from) / (SECONDS_PER_DAY * 1000));
}

/// A typed wall clock: `HH:MM[:SS]`, optionally prefixed by the capture
/// day it belongs to (`3d 12:30:00`, `3d12:30`).
const CLOCK = /^(?:(\d+)\s*d\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/// Parse one typed bound. Returns the bound (`null` for an empty field,
/// i.e. the default) or `undefined` when the text is neither a wall
/// clock nor an offset — which is what puts the field in its error
/// state rather than silently keeping the old value.
export function parseRangeBound(text: string, ctx: RangeContext): RangeBound | undefined {
  const s = text.trim();
  if (s === "") return null;
  const clock = CLOCK.exec(s);
  if (clock) {
    if (!ctx.anchored) return undefined;
    const day = clock[1] === undefined ? null : Number(clock[1]);
    const h = Number(clock[2]);
    const m = Number(clock[3]);
    const sec = clock[4] === undefined ? 0 : Number(clock[4]);
    if (h > 23 || m > 59 || sec > 59) return undefined;
    const startMs = ctx.sessionStartSeconds * 1000;
    const midnight = localMidnight(startMs);
    const at = new Date(
      midnight.getFullYear(),
      midnight.getMonth(),
      midnight.getDate() + (day ?? 0),
      h,
      m,
      sec,
    );
    let offset = (at.getTime() - startMs) / 1000;
    // A capture that runs past midnight: a bare clock earlier than the
    // start is the following day, not fifteen hours before the capture
    // began. An explicit day says which day it is, so it never rolls —
    // and a day that lands before the start names no part of the
    // capture at all.
    if (offset < 0) {
      if (day !== null) return undefined;
      offset += SECONDS_PER_DAY;
    }
    return offset;
  }
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return undefined;
}

/// A bound as the field shows it: wall clock when the capture has an
/// anchor, seconds from the start when it does not.
///
/// A bound past the capture's first midnight carries its day (`3d
/// 12:30:00`). Without it two instants three days apart render as the
/// same string, and reading one back moves the bound three days — so
/// the prefix is what makes the field round-trip on a capture that runs
/// longer than a day.
export function formatRangeBound(seconds: number, ctx: RangeContext): string {
  if (!ctx.anchored) return `${Math.round(seconds)} s`;
  const atMs = (ctx.sessionStartSeconds + seconds) * 1000;
  const at = new Date(atMs);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  const day = dayIndex(ctx, atMs);
  return day === 0 ? clock : `${day}d ${clock}`;
}

/// The event a bound sits on, or `null`.
export function eventAtBound(
  bound: RangeBound,
  events: readonly RangeEvent[],
): RangeEvent | null {
  if (bound === null) return null;
  return (
    events.find((e) => Math.abs(e.seconds - bound) < EVENT_TOLERANCE_SECONDS) ?? null
  );
}

/// How a bound reads in the combobox and the summary: its default's
/// wording when unset, the event's label when it sits on one (the event
/// is why the bound is there — ruled 2026-09-06), the time otherwise.
export function boundText(
  bound: RangeBound,
  fallback: string,
  events: readonly RangeEvent[],
  ctx: RangeContext,
): string {
  if (bound === null) return fallback;
  const event = eventAtBound(bound, events);
  const time = formatRangeBound(bound, ctx);
  return event ? `${event.label} (${time})` : time;
}

/// The range presets, in offer order.
export const RANGE_PRESETS = [
  { value: "all", label: "Whole capture" },
  { value: "1m", label: "Last 1 min" },
  { value: "5m", label: "Last 5 min" },
  { value: "30m", label: "Last 30 min" },
  { value: "plot", label: "Plot window" },
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number]["value"];

const TRAILING_SECONDS: Record<string, number> = { "1m": 60, "5m": 300, "30m": 1800 };

/// The selection a preset produces, or `null` when it has nothing to
/// offer (the plot preset with no plot open).
export function applyRangePreset(
  preset: RangePreset,
  durationSeconds: number,
  plotWindow: { from: number; to: number } | null,
): ExportRangeSelection | null {
  if (preset === "all") return WHOLE_CAPTURE;
  if (preset === "plot") {
    return plotWindow === null ? null : { from: plotWindow.from, to: plotWindow.to };
  }
  const span = TRAILING_SECONDS[preset];
  // The end stays the *default*, not the current live edge: "last 5
  // minutes" of a running capture must keep following the edge while
  // the dialog is open, and the export must reach it.
  const from = durationSeconds - span;
  return { from: from > 0 ? from : null, to: null };
}

/// How long the selection spans, for the summary line. Never negative —
/// crossed bounds span nothing.
export function rangeSpanSeconds(
  selection: ExportRangeSelection,
  durationSeconds: number,
): number {
  const from = selection.from ?? 0;
  const to = selection.to ?? durationSeconds;
  return to > from ? to - from : 0;
}

/// A duration as the summary reads it — hours, minutes or seconds,
/// whichever the magnitude asks for.
export function formatRangeSpan(seconds: number): string {
  if (seconds >= 5400) return `${(seconds / 3600).toFixed(1)} h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return formatElapsed(seconds, 0);
}

/// The selection as `save_capture`'s `range` argument, or `null` when
/// neither bound is set — the host then applies no filter at all, rather
/// than one that happens to match the full span.
export function exportRangeNs(
  selection: ExportRangeSelection,
  sessionStartSeconds: number,
): { startNs: number | null; endNs: number | null } | null {
  if (selection.from === null && selection.to === null) return null;
  const abs = (s: RangeBound) =>
    s === null ? null : Math.round((sessionStartSeconds + s) * 1e9);
  return { startNs: abs(selection.from), endNs: abs(selection.to) };
}
