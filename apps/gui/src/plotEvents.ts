// Project the timeline-event model (ADR 0035) onto a plot panel's
// display-relative x axis. Pure, so the per-kind visibility rule is testable
// without mounting a plot: the panel only has to supply its origin, the
// kinds it is showing, and the theme colors.

import type { EventExtent } from "./eventHighlight";
import { formatDurationSeconds } from "./format";
import { timelineEvents, type EventKind, type EventSubject, type Note, type TimelineEvent } from "./notes";
import { signalRefKey, type NoteEvent, type SignalRef } from "./plotPanelConfig";

/// Event cursors for the plot, in display-relative seconds against
/// `baseSeconds` (the panel's x-axis origin in absolute seconds).
///
/// Empty until the cache has anchored — with no origin there is nowhere to
/// put a cursor. `kindColor` returns the color for an event of that kind
/// that carries none of its own; `undefined` leaves the plot's default
/// event color in place.
export function plotTimelineEvents(
  notes: readonly Note[],
  truncationTsNs: number | null,
  baseSeconds: number | null,
  visible: ReadonlySet<EventKind>,
  kindColor: (kind: EventKind) => string | undefined,
): NoteEvent[] {
  return plotEventsFromTimeline(timelineEvents(notes, truncationTsNs), baseSeconds, visible, kindColor);
}

/// The general form {@link plotTimelineEvents} specializes for the notes
/// store's `Note[]` wire shape: project an already-built
/// {@link TimelineEvent} list (host-derived events included) onto the
/// plot's display-relative x axis. Bus-error markers (ADR 0035 amended)
/// are built straight as `TimelineEvent`s — there is no `Note` to derive
/// them from — so they come in through here rather than through
/// `plotTimelineEvents`.
export function plotEventsFromTimeline(
  events: readonly TimelineEvent[],
  baseSeconds: number | null,
  visible: ReadonlySet<EventKind>,
  kindColor: (kind: EventKind) => string | undefined,
): NoteEvent[] {
  if (baseSeconds == null || !Number.isFinite(baseSeconds)) return [];
  return events
    .filter((e) => visible.has(e.kind))
    .map((e) => ({
      id: e.id,
      t: e.timestampNs / 1e9 - baseSeconds,
      label: e.label,
      color: e.color ?? kindColor(e.kind),
    }));
}

/// One bus's error series over a served window (`bus_error_series`,
/// `sampling.rs`), decoded off the wire: `t[i]` absolute seconds, `v[i]`
/// the running error count on `bus` at that instant — the same shape as
/// `BusErrorPoints`, with the bus id carried alongside since the host
/// answers positionally.
export interface BusErrorSeries {
  bus: string;
  t: readonly number[];
  v: readonly number[];
}

/// The label a bus-error marker carries: the episode a delta between two
/// served points describes (ADR 0035 amended) — count, span and rate.
/// `spanSeconds` is `0` only when two errors land at the same instant, in
/// which case rate has nothing to divide by.
export function busErrorMarkerLabel(count: number, spanSeconds: number): string {
  const countText = count === 1 ? "1 bus error" : `${count} bus errors`;
  const rate = count / spanSeconds;
  const rateText = spanSeconds > 0 ? `${rate.toFixed(rate >= 10 ? 0 : 1)}/s` : "—";
  return `${countText} over ${formatDurationSeconds(spanSeconds)} (${rateText})`;
}

/// One `TimelineEvent` per delta between consecutive points of a bus's
/// served error series — the walk starts at index 1, so the served
/// window's boundary sample before it (index 0) supplies the first
/// delta and draws no marker of its own. `id` is `bus-error:{bus}:{n}`,
/// `n` the point's own running-count value: stable across zoom and
/// restore, since every served point at every pyramid level is a real
/// level-0 sample (ADR 0035 amended).
///
/// Any two consecutive served points are an exact episode regardless of
/// the pyramid level the window was read off, so this never merges or
/// re-derives a count — it only reads the deltas the host already gave it
/// (CLAUDE.md § GUI architecture: domain computation belongs in the
/// model).
export function busErrorTimelineEvents(series: readonly BusErrorSeries[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const s of series) {
    for (let i = 1; i < s.t.length; i++) {
      const count = s.v[i] - s.v[i - 1];
      const span = s.t[i] - s.t[i - 1];
      out.push({
        id: `bus-error:${s.bus}:${s.v[i]}`,
        timestampNs: Math.round(s.t[i] * 1e9),
        label: busErrorMarkerLabel(count, span),
        kind: "busError",
        color: null,
        description: null,
        tag: null,
        editable: false,
        subjects: [],
      });
    }
  }
  return out;
}

/// What a plot area's current signal selection is *about*, as event
/// subjects (ADR 0056) — the list an event authored from that selection
/// carries.
///
/// Two things the structural reference forces, both deliberate:
///
/// - **The bus is dropped**, because a subject stores none. Selecting the
///   same signal on two buses therefore yields one subject, not two
///   identical ones.
/// - **A file-backed series contributes nothing.** Its `messageId` is a
///   signal channel group index rather than an arbitration id, so writing
///   it as a message reference would name a message that does not exist.
///   A selection of nothing but file-backed rows names no subject at all.
///
/// Order follows the area's own signal list, so the chips read down the
/// side panel rather than in click order.
export function subjectsForSelection(
  signals: readonly SignalRef[],
  selectedKeys: ReadonlySet<string>,
): EventSubject[] {
  const out: EventSubject[] = [];
  const seen = new Set<string>();
  for (const s of signals) {
    if (s.fileBacked || !selectedKeys.has(signalRefKey(s))) continue;
    const key = `${s.extended ? "x" : "s"}:${s.messageId}:${s.signalName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: "signal",
      messageId: s.messageId,
      extended: s.extended,
      signalName: s.signalName,
    });
  }
  return out;
}

/// A linked pair's extent, projected onto the plot's display-relative x
/// axis the way {@link plotTimelineEvents} projects its marker lines.
export interface PlotExtent {
  /// Stable per pair (`EventExtent.key`), so the draw can key on it.
  key: string;
  /// Display-relative seconds, `t0 <= t1`.
  t0: number;
  t1: number;
  /// `undefined` leaves the plot's default event color in place, exactly
  /// as a marker line's does.
  color: string | undefined;
}

/// The bands a plot draws while an event is being acted on — nothing at
/// rest, because {@link eventHighlight} hands back nothing at rest.
///
/// Same origin and the same color resolution as the marker lines, so a
/// band and the two lines that bound it agree by construction.
export function plotEventExtents(
  extents: readonly EventExtent[],
  baseSeconds: number | null,
  kindColor: (kind: EventKind) => string | undefined,
): PlotExtent[] {
  if (baseSeconds == null || !Number.isFinite(baseSeconds)) return [];
  return extents.map((e) => ({
    key: e.key,
    t0: e.startNs / 1e9 - baseSeconds,
    t1: e.endNs / 1e9 - baseSeconds,
    color: e.color ?? kindColor(e.kind),
  }));
}

/// Lay a marker's label out as at most `maxLines` lines, none wider
/// than `maxWidth`, ellipsising the last one when the label does not
/// fit. `measure` reports the rendered width of a string in the
/// caller's font.
///
/// An event label is free text, and a long one drawn as a single chip
/// runs off the plot and over its neighbours' markers. Wrapping keeps
/// it inside the area; the line cap keeps a paragraph-length note from
/// covering the series it annotates.
///
/// Returns `[]` for a blank label — a chip with nothing in it is worse
/// than no chip.
export function wrapMarkerLabel(
  label: string,
  measure: (text: string) => number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = label.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0 || maxLines < 1) return [];

  /// Longest prefix of `word` that fits, never empty — a width too
  /// small for even one character still has to yield a chip, or a
  /// degenerate plot size silently erases the marker's name.
  const fitPrefix = (word: string): string => {
    let cut = word.length;
    while (cut > 1 && measure(word.slice(0, cut)) > maxWidth) cut--;
    return word.slice(0, cut);
  };

  const lines: string[] = [];
  let line = "";
  // Words still to place. A word wider than a line is split here and
  // its tail pushed back on, so wrapping and hard-breaking share one
  // loop.
  const pending = [...words];
  let truncated = false;
  while (pending.length > 0) {
    const word = pending[0];
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (measure(candidate) <= maxWidth) {
      line = candidate;
      pending.shift();
      continue;
    }
    if (line.length > 0) {
      // Wrap at the space before this word.
      lines.push(line);
      line = "";
    } else {
      // No space to wrap at: break the word itself.
      const head = fitPrefix(word);
      pending[0] = word.slice(head.length);
      if (pending[0].length === 0) pending.shift();
      lines.push(head);
    }
    if (lines.length >= maxLines) {
      truncated = line.length > 0 || pending.length > 0;
      break;
    }
  }
  if (lines.length < maxLines && line.length > 0) lines.push(line);

  if (truncated) {
    // Mark the last line as continuing, trimming it back until the
    // ellipsis itself fits.
    const idx = lines.length - 1;
    let last = `${lines[idx]}…`;
    while (measure(last) > maxWidth && last.length > 1) last = `${last.slice(0, -2)}…`;
    lines[idx] = last;
  }
  return lines;
}

/// `events`, reordered so the ones being acted on draw last.
///
/// Marker lines and their label chips are painted in list order, so
/// whichever comes later covers what came before. The event a reader is
/// pointing at is the one they need to read, and it was as likely as not
/// to be buried under a neighbour's chip. Lighting it and then drawing
/// something else over it says two different things at once.
///
/// Stable within each group: the relative order of the quiet markers,
/// and of a lit pair, is the one the list already had. Returns the same
/// order at rest, when nothing is lit.
export function litLast<T extends { id: string }>(
  events: readonly T[],
  litIds: ReadonlySet<string>,
): readonly T[] {
  if (litIds.size === 0) return events;
  const quiet: T[] = [];
  const lit: T[] = [];
  for (const e of events) (litIds.has(e.id) ? lit : quiet).push(e);
  if (lit.length === 0) return events;
  return [...quiet, ...lit];
}
