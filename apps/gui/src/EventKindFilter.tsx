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
  EVENT_KIND_GROUPS,
  type EventKind,
  type EventKindGroup,
  type TimelineEvent,
} from "./notes";

export interface EventKindFilterState {
  /// The kinds this view is currently showing.
  visible: ReadonlySet<EventKind>;
  /// Show or hide a filter row's kinds in this view. Takes the whole
  /// group: the row is the unit the reader acts on, and the kinds under
  /// it have no separate control to disagree with.
  toggle: (kinds: readonly EventKind[], on: boolean) => void;
}

/// View-local visibility, seeded from {@link defaultVisibleKinds}.
export function useEventKindFilter(): EventKindFilterState {
  const [visible, setVisible] = useState<ReadonlySet<EventKind>>(() => defaultVisibleKinds());
  const toggle = useCallback((kinds: readonly EventKind[], on: boolean) => {
    setVisible((prev) => {
      const next = new Set(prev);
      for (const kind of kinds) {
        if (on) next.add(kind);
        else next.delete(kind);
      }
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

/// Every event in `group`'s kinds, added up — the number beside its row.
function groupCount(group: EventKindGroup, counts: Record<string, number>): number {
  return group.kinds.reduce((n, k) => n + (counts[k] ?? 0), 0);
}

/// The checklist itself: one row per {@link EVENT_KIND_GROUPS} group, its
/// count beside it. A group with nothing to show is still listed — the
/// list is the answer to "what is there", not just "what is here now".
export function EventKindFilter({
  state,
  counts,
}: {
  state: EventKindFilterState;
  counts: Record<string, number>;
}) {
  return (
    <div className="event-kind-filter" role="group" aria-label="event kinds">
      {EVENT_KIND_GROUPS.map((group) => (
        <label key={group.label} className="event-kind-filter-row" title={`${group.label} — ${group.title}`}>
          <input
            type="checkbox"
            aria-label={group.label}
            // A row is on when everything under it is. The kinds in a
            // group only ever move together from here, so the partial
            // state is unreachable through the UI — but a `some` test
            // would render a checked box over a hidden kind if one ever
            // arrived another way.
            checked={group.kinds.every((k) => state.visible.has(k))}
            onChange={(e) => state.toggle(group.kinds, e.target.checked)}
          />
          <span
            className={`event-kind-filter-swatch event-kind-swatch-${group.kinds[0]}`}
            aria-hidden="true"
          />
          <span className="event-kind-filter-label">{group.label}</span>
          <span className="event-kind-filter-count">{groupCount(group, counts)}</span>
        </label>
      ))}
    </div>
  );
}
