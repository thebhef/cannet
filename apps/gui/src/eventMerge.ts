// Interleave timeline events into the chronological frame stream (ADR 0035).
//
// The chronological trace view is index-paged over frames; events are
// time-positioned. The host anchors each event to a frame index (the first
// frame at/after the event's timestamp — `frame_indices_at_ns`); this pure
// helper merges those anchors with the window's frame rows into one row
// stream the single TraceView renderer draws. Events outside the window are
// dropped. Kept pure so it's unit-tested without React.

import type { TimelineEvent } from "./notes";

export type MergedRow =
  | { row: "event"; event: TimelineEvent }
  | { row: "frame"; localIndex: number };

export interface EventMerge {
  /// Total rows = frame rows + interleaved event rows.
  displayCount: number;
  /// Resolve a display row to an event or a frame (its window-local index).
  rowAt: (displayIndex: number) => MergedRow;
  /// The window-local frame range a display range spans — for prefetch
  /// (`ensureVisible`), which is frame-indexed underneath.
  frameRange: (d0: number, d1: number) => [number, number];
  /// The display row a window-local frame sits at — the inverse of `rowAt`'s
  /// frame branch. Used to scroll to a frame (e.g. a cross-panel "goto") in
  /// the merged display space the view actually renders.
  frameToDisplay: (localFrame: number) => number;
}

/// First index `i` with `arr[i] >= x` — i.e. the count of elements `< x`.
function lowerBound(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/// Build the interleave of `frameCount` frame rows with `events` placed at
/// `anchorsAbs[i]` (absolute frame index, host-computed). `events` and
/// `anchorsAbs` are parallel and in timestamp order, so anchors are
/// non-decreasing. Events whose anchor falls outside the window
/// `[offset, offset + frameCount]` are dropped (handled by another window /
/// not shown). Pass `events: []` to get an identity merge over the frames.
export function buildEventMerge(
  events: readonly TimelineEvent[],
  anchorsAbs: readonly number[],
  offset: number,
  frameCount: number,
): EventMerge {
  // Each placed event sits at display position `localAnchor + rank`: every
  // event before it adds one row, so display positions stay strictly
  // ascending (anchors non-decreasing, rank strictly increasing) — a sorted
  // array we binary-search.
  const placedEvents: TimelineEvent[] = [];
  const displayPos: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const localAnchor = anchorsAbs[i] - offset;
    if (localAnchor < 0 || localAnchor > frameCount) continue;
    displayPos.push(localAnchor + placedEvents.length);
    placedEvents.push(events[i]);
  }

  const displayCount = frameCount + placedEvents.length;

  const rowAt = (d: number): MergedRow => {
    const k = lowerBound(displayPos, d);
    if (k < displayPos.length && displayPos[k] === d) {
      return { row: "event", event: placedEvents[k] };
    }
    // Frames shift down by one per event placed before this display row.
    return { row: "frame", localIndex: d - k };
  };

  const frameRange = (d0: number, d1: number): [number, number] => {
    const f0 = Math.max(0, d0 - lowerBound(displayPos, d0));
    const f1 = Math.max(f0, d1 - lowerBound(displayPos, d1));
    return [f0, Math.min(f1, frameCount)];
  };

  // A frame at window-local index `fi` is pushed down one display row per
  // event placed before-or-at it. An event's display position is
  // `displayPos[k] = localAnchor_k + k`, so its local anchor is
  // `displayPos[k] - k` (non-decreasing in k); count those `<= fi`.
  const frameToDisplay = (localFrame: number): number => {
    const fi = Math.max(0, Math.min(localFrame, frameCount));
    let lo = 0;
    let hi = displayPos.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (displayPos[mid] - mid <= fi) lo = mid + 1;
      else hi = mid;
    }
    return fi + lo;
  };

  return { displayCount, rowAt, frameRange, frameToDisplay };
}
