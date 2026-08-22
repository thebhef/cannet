// Project the timeline-event model (ADR 0035) onto a plot panel's
// display-relative x axis. Pure, so the per-kind visibility rule is testable
// without mounting a plot: the panel only has to supply its origin, the
// kinds it is showing, and the theme colors.

import { timelineEvents, type EventKind, type Note } from "./notes";
import type { NoteEvent } from "./plotPanelConfig";

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
