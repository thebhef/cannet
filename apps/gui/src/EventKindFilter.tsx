// Per-kind visibility for timeline events (ADR 0035), shared by every
// surface that renders them.
//
// A kind declares whether it shows by default (`EVENT_KIND_META`); the
// user's override is view-local, like every other view toggle, so this is a
// hook over `useState` rather than anything persisted. One control shape for
// all three surfaces so "show me bus errors" reads the same wherever it is
// asked.

import { useCallback, useMemo, useState } from "react";

import {
  defaultVisibleKinds,
  EVENT_KINDS,
  EVENT_KIND_META,
  type EventKind,
  type TimelineEvent,
} from "./notes";

export interface EventKindFilterState {
  /// The kinds this view is currently showing.
  visible: ReadonlySet<EventKind>;
  /// Show or hide one kind in this view.
  toggle: (kind: EventKind, on: boolean) => void;
}

/// View-local per-kind visibility, seeded from each kind's own declaration.
export function useEventKindFilter(): EventKindFilterState {
  const [visible, setVisible] = useState<ReadonlySet<EventKind>>(() => defaultVisibleKinds());
  const toggle = useCallback((kind: EventKind, on: boolean) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }, []);
  return useMemo(() => ({ visible, toggle }), [visible, toggle]);
}

/// How many events of each kind the unfiltered set holds — so a kind that is
/// hidden by default still announces that it has something to show. Hidden
/// must not mean unfindable.
export function countByKind(events: readonly TimelineEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return counts;
}

/// The checklist itself: one row per kind, its count beside it. A kind with
/// nothing to show is still listed — the list is the answer to "what kinds
/// are there", not just "what is here now".
export function EventKindFilter({
  state,
  counts,
}: {
  state: EventKindFilterState;
  counts: Record<string, number>;
}) {
  return (
    <div className="event-kind-filter" role="group" aria-label="event kinds">
      {EVENT_KINDS.map((kind) => (
        <label
          key={kind}
          className="event-kind-filter-row"
          // The BLF record a kind round-trips as is a property of the kind,
          // so this checklist is also the record-type filter, and says so.
          title={`${EVENT_KIND_META[kind].label} — ${
            EVENT_KIND_META[kind].blfRecord ?? "not written to a capture file"
          }`}
        >
          <input
            type="checkbox"
            aria-label={EVENT_KIND_META[kind].label}
            checked={state.visible.has(kind)}
            onChange={(e) => state.toggle(kind, e.target.checked)}
          />
          <span className={`event-kind-filter-swatch event-kind-swatch-${kind}`} aria-hidden="true" />
          <span className="event-kind-filter-label">{EVENT_KIND_META[kind].label}</span>
          <span className="event-kind-filter-count">{counts[kind] ?? 0}</span>
        </label>
      ))}
    </div>
  );
}
