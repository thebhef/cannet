// The Events panel's bus-error section (ADR 0035 amended, ADR 0044): a
// paged gridview over the level-0 error series, one row per episode —
// bus, time, count and span since the previous point, rate. Modelled on
// `ProjectCachesList.tsx`: rows as plain elements over `arrayRowSpace`,
// not through the shared column framework — there is nowhere on this
// section to persist a resizable/reorderable layout, so building one
// would be a gesture that forgets itself on every reopen (ADR 0044).
//
// Authored events stay the Events panel's other, whole-list section;
// this one reads `bus_error_series` through `useBusErrorEvents`
// (`useWindowedQuery`) and never holds more than the current point
// budget's worth of rows (CLAUDE.md § GUI architecture).

import { useCallback, useMemo, useRef, type UIEvent } from "react";

import { arrayRowSpace, type GridviewAdapter, type GridviewRow } from "./gridviewRows";
import { formatDurationSeconds, formatTimestamp } from "./format";
import type { Bus } from "./types";
import { useGridview } from "./useGridview";
import { useScrollRestore } from "./useScrollRestore";
import { useBusErrorEvents } from "./useBusErrorEvents";

/// How many rows the bounded row space holds on screen — what
/// PageUp/PageDown move by (`.bus-error-events-grid`'s max-height over a
/// row).
const PAGE_ROWS = 8;

/// Fraction of the scrolled content's height, measured from the bottom,
/// that counts as "near the end" — the trigger for asking the host for
/// more resolution.
const GROW_NEAR_BOTTOM_PX = 24;

function episodeRate(count: number, spanSeconds: number): string {
  if (spanSeconds <= 0) return "—";
  const rate = count / spanSeconds;
  return `${rate.toFixed(rate >= 10 ? 0 : 1)}/s`;
}

export interface BusErrorEventsSectionProps {
  /// Every session bus (ADR 0035 amended) — the same session-wide scope
  /// the plot's own markers use (phase 2), not just buses some other
  /// view happens to be showing.
  buses: readonly Bus[];
  /// The session's zero point, for the time column (`formatTimestamp`).
  baseTimestamp: number | null;
  /// Bumped whenever this section's host panel comes back on screen
  /// (dockview detaches a hidden panel's element), so its own scroll
  /// offset can be restored (`useScrollRestore.ts`).
  shownCount: number;
}

export function BusErrorEventsSection({
  buses,
  baseTimestamp,
  shownCount,
}: BusErrorEventsSectionProps) {
  const busIds = useMemo(() => buses.map((b) => b.id), [buses]);
  // The row's own field is the bus id `bus_error_series` was asked
  // about; the project's name for it is what a reader wants on the row.
  const busName = useMemo(() => new Map(buses.map((b) => [b.id, b.name])), [buses]);
  const { rows, complete, growBudget, atFullResolution } = useBusErrorEvents(busIds);

  const gridRows = useMemo<GridviewRow[]>(
    () => rows.map((r) => ({ id: r.id, kind: "leaf" as const, expandable: false, depth: 0 })),
    [rows],
  );

  const listRef = useRef<HTMLDivElement | null>(null);
  // Read through a ref so the adapter's memo can close over the
  // gridview's row-id helper before `useGridview` has run — the same
  // forward reference `ProjectCachesList.tsx` uses, for the same reason:
  // `scrollToRow` only runs on a later interaction.
  const rowDomIdRef = useRef<(id: string) => string>((id) => id);

  const adapter = useMemo<GridviewAdapter>(() => {
    const space = arrayRowSpace(gridRows, () => false);
    return {
      ...space,
      scrollToRow(index) {
        const id = space.rowIdAt(index);
        const container = listRef.current;
        if (id == null || container == null) return;
        const el = document.getElementById(rowDomIdRef.current(id));
        if (el == null) return;
        const c = container.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.top < c.top) container.scrollTop += r.top - c.top;
        else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom;
      },
      setExpanded: () => {
        /* no branches to expand */
      },
      isSelectable: () => false,
    };
  }, [gridRows]);

  const grid = useGridview({ adapter, pageRows: PAGE_ROWS, idPrefix: "bus-error-events" });
  rowDomIdRef.current = grid.rowDomId;

  const restoreScroll = useScrollRestore(listRef, shownCount);
  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      restoreScroll(e);
      if (atFullResolution) return;
      const el = e.currentTarget;
      const nearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight <= GROW_NEAR_BOTTOM_PX;
      if (nearBottom) growBudget();
    },
    [restoreScroll, atFullResolution, growBudget],
  );

  return (
    <div className="bus-error-events">
      <div className="bus-error-events-head">
        <span className="bus-error-events-title">Bus errors</span>
        {!complete && (
          <span className="bus-error-events-pending" title="still catching up with the capture">
            catching up…
          </span>
        )}
      </div>
      {rows.length === 0 && <p className="bus-error-events-empty">No bus errors recorded.</p>}
      <div
        className="bus-error-events-grid"
        ref={listRef}
        role="tree"
        aria-label="Bus errors"
        onScroll={onScroll}
        {...grid.containerProps}
      >
        {rows.map((row) => (
          <div
            key={row.id}
            id={grid.rowDomId(row.id)}
            role="treeitem"
            className={`bus-error-event-row${grid.cursor === row.id ? " cursor" : ""}`}
            onClick={(e) => {
              grid.onRowClick(row.id, { mod: e.metaKey || e.ctrlKey, shift: e.shiftKey });
              const target = e.target as HTMLElement | null;
              if (target?.closest("button") == null) listRef.current?.focus();
            }}
          >
            <span className="bus-error-event-bus">{busName.get(row.bus) ?? row.bus}</span>
            <span className="bus-error-event-time">
              {formatTimestamp(row.timestampNs / 1e9, baseTimestamp)}
            </span>
            <span className="bus-error-event-count">
              {row.count === 1 ? "1 error" : `${row.count} errors`}
            </span>
            <span className="bus-error-event-span">{formatDurationSeconds(row.spanSeconds)}</span>
            <span className="bus-error-event-rate">{episodeRate(row.count, row.spanSeconds)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
