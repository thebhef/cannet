// Project the timeline-event model (ADR 0035) onto a plot panel's
// display-relative x axis. Pure, so the per-kind visibility rule is testable
// without mounting a plot: the panel only has to supply its origin, the
// kinds it is showing, and the theme colors.

import type { EventExtent } from "./eventHighlight";
import { timelineEvents, type EventKind, type EventSubject, type Note } from "./notes";
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
  if (baseSeconds == null || !Number.isFinite(baseSeconds)) return [];
  return timelineEvents(notes, truncationTsNs)
    .filter((e) => visible.has(e.kind))
    .map((e) => ({
      id: e.id,
      t: e.timestampNs / 1e9 - baseSeconds,
      label: e.label,
      color: e.color ?? kindColor(e.kind),
    }));
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
