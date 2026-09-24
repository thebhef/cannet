// The Events panel's bus-error section (ADR 0035 amended, ADR 0044): a
// paged gridview over the host's bus-error **episodes** at the configured
// gap (`bus_error_episode_gap_s`), newest first — bus, first time, count,
// span, rate. The row space is the host's whole episode list, paged by
// offset through `useBusErrorEvents` (`useWindowedQuery`), so scrolling
// reaches the oldest single episode while the section holds one page
// (CLAUDE.md § GUI architecture). Rows are fixed-height and virtualized
// over the trace views' scroll geometry (`traceViewport.ts`), in a
// bounded row space of `PAGE_ROWS`.
//
// Plain rows rather than the shared column framework: there is nowhere on
// this section to persist a resizable layout, so building one would be a
// gesture that forgets itself on every reopen (ADR 0044).

import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from "react";

import type { GridviewAdapter, GridviewRow } from "./gridviewRows";
import { formatDurationSeconds, formatTimestamp } from "./format";
import { useSetting } from "./hostSettings";
import {
  anchorFromScroll,
  maxAnchorRow,
  maxScrollTop,
  ROW_HEIGHT,
  scaledHeight,
  scrollForAnchor,
} from "./traceViewport";
import type { Bus } from "./types";
import { useGridview } from "./useGridview";
import { useScrollRestore } from "./useScrollRestore";
import { useBusErrorEvents, type BusErrorEpisodeRow } from "./useBusErrorEvents";
import { PAGE_ROWS as FETCH_PAGE_ROWS } from "./useWindowedQuery";

/// Rows the bounded row space shows at once — its height, and what
/// PageUp/PageDown move by.
const PAGE_ROWS = 8;

function episodeRate(rate: number | null): string {
  if (rate == null) return "—";
  return `${rate.toFixed(rate >= 10 ? 0 : 1)}/s`;
}

function leaf(id: string): GridviewRow {
  return { id, kind: "leaf", expandable: false, depth: 0 };
}

export interface BusErrorEventsSectionProps {
  /// Every session bus (ADR 0035 amended) — the same session-wide scope
  /// the plot's own markers use, not just buses some other view happens
  /// to be showing.
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
  // The row's own field is the bus id the host was asked about; the
  // project's name for it is what a reader wants on the row.
  const busName = useMemo(() => new Map(buses.map((b) => [b.id, b.name])), [buses]);
  const gapSeconds = useSetting("bus_error_episode_gap_s");
  const { count, version, getRow, ensureVisible, complete } = useBusErrorEvents(
    busIds,
    gapSeconds,
  );

  // The row at the top of the viewport — the single source of truth for
  // what is drawn, as in the trace views.
  const [anchoredRow, setAnchoredRow] = useState(0);
  // The viewport: up to `PAGE_ROWS` fixed-height rows, so the
  // virtualization needs no measuring.
  const viewportPx = Math.min(Math.max(count, 1), PAGE_ROWS) * ROW_HEIGHT;
  const anchorMax = maxAnchorRow(count, viewportPx);
  const firstVisibleRow = Math.min(anchorMax, anchoredRow);
  // Rows sit on the anchor, never part-scrolled, so a viewport is exactly
  // `PAGE_ROWS` of them.
  const lastVisibleRow = Math.min(count, firstVisibleRow + PAGE_ROWS);
  const scrollRange = maxScrollTop(count, viewportPx);

  useEffect(() => {
    if (count > 0) ensureVisible(firstVisibleRow, lastVisibleRow);
  }, [firstVisibleRow, lastVisibleRow, count, ensureVisible]);

  const visibleRows = useMemo(() => {
    const out: { index: number; row: BusErrorEpisodeRow | null }[] = [];
    for (let i = firstVisibleRow; i < lastVisibleRow; i++) out.push({ index: i, row: getRow(i) });
    return out;
    // `version` stands for what `getRow` answers changing behind it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstVisibleRow, lastVisibleRow, getRow, version]);

  const listRef = useRef<HTMLDivElement | null>(null);
  // The live geometry, read by the adapter's callbacks without making the
  // adapter a fresh object on every scroll.
  const geometry = useRef({ firstVisibleRow, anchorMax, scrollRange, getRow });
  geometry.current = { firstVisibleRow, anchorMax, scrollRange, getRow };

  const adapter = useMemo<GridviewAdapter>(() => {
    // Only the loaded page can name its rows; a row outside it is found
    // by the page around the viewport, which is the page loaded.
    const indexOf = (id: string) => {
      const g = geometry.current;
      const from = Math.max(0, g.firstVisibleRow - FETCH_PAGE_ROWS);
      const to = Math.min(count, g.firstVisibleRow + FETCH_PAGE_ROWS);
      for (let i = from; i < to; i++) if (g.getRow(i)?.id === id) return i;
      return -1;
    };
    return {
      count,
      rowIdAt: (index) => geometry.current.getRow(index)?.id ?? null,
      indexOf,
      rowAt: (id) => (indexOf(id) < 0 ? null : leaf(id)),
      isExpanded: () => false,
      scrollToRow(index) {
        const g = geometry.current;
        const next =
          index < g.firstVisibleRow
            ? index
            : index > g.firstVisibleRow + PAGE_ROWS - 1
              ? index - PAGE_ROWS + 1
              : null;
        if (next == null) return;
        const anchor = Math.max(0, Math.min(g.anchorMax, next));
        setAnchoredRow(anchor);
        if (listRef.current) {
          listRef.current.scrollTop = scrollForAnchor(anchor, g.anchorMax, g.scrollRange);
        }
      },
      setExpanded: () => {
        /* no branches to expand */
      },
      isSelectable: () => false,
      // Nothing is selectable, so there is no order to walk the whole
      // (host-paged) space for.
      selectionOrder: () => [],
    };
    // `version`: the page behind `getRow` changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, version]);

  const grid = useGridview({ adapter, pageRows: PAGE_ROWS, idPrefix: "bus-error-events" });

  const restoreScroll = useScrollRestore(listRef, shownCount);
  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      restoreScroll(e);
      setAnchoredRow(anchorFromScroll(e.currentTarget.scrollTop, anchorMax, scrollRange));
    },
    [restoreScroll, anchorMax, scrollRange],
  );

  return (
    <div className="bus-error-events">
      <div className="bus-error-events-head">
        <span className="bus-error-events-title">Bus errors</span>
        <span className="bus-error-events-gap" title="bus_error_episode_gap_s">
          episodes at {gapSeconds} s
        </span>
        {!complete && (
          <span className="bus-error-events-pending" title="still catching up with the capture">
            catching up…
          </span>
        )}
      </div>
      {count === 0 && <p className="bus-error-events-empty">No bus errors recorded.</p>}
      <div
        className="bus-error-events-grid"
        ref={listRef}
        role="tree"
        aria-label="Bus errors"
        style={{ height: count === 0 ? 0 : viewportPx }}
        onScroll={onScroll}
        {...grid.containerProps}
      >
        <div
          role="presentation"
          style={{ height: scaledHeight(count, viewportPx), position: "relative" }}
        >
          {/* Sticky viewport: the rows stay put while the spacer scrolls,
              and only their content changes. */}
          <div
            role="presentation"
            style={{ position: "sticky", top: 0, height: viewportPx, overflow: "hidden" }}
          >
            {visibleRows.map(({ index, row }) => (
              <div
                key={row?.id ?? `pending-${index}`}
                id={row ? grid.rowDomId(row.id) : undefined}
                role="treeitem"
                className={`bus-error-event-row${row != null && grid.cursor === row.id ? " cursor" : ""}`}
                style={{
                  position: "absolute",
                  top: (index - firstVisibleRow) * ROW_HEIGHT,
                  height: ROW_HEIGHT,
                  left: 0,
                  right: 0,
                }}
                onClick={(e) => {
                  if (row == null) return;
                  grid.onRowClick(row.id, { mod: e.metaKey || e.ctrlKey, shift: e.shiftKey });
                  listRef.current?.focus();
                }}
              >
                {row && (
                  <>
                    <span className="bus-error-event-bus">{busName.get(row.bus) ?? row.bus}</span>
                    <span className="bus-error-event-time">
                      {formatTimestamp(row.firstSeconds, baseTimestamp)}
                    </span>
                    <span className="bus-error-event-count">
                      {row.count === 1 ? "1 error" : `${row.count} errors`}
                    </span>
                    <span className="bus-error-event-span">
                      {formatDurationSeconds(row.spanSeconds)}
                    </span>
                    <span className="bus-error-event-rate">{episodeRate(row.rate)}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
