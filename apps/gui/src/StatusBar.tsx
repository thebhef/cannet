/// The header's status bar (ADR 0055): the connection control, the
/// bus-health launcher, whatever is happening, the numbers, and the
/// chips that report a condition.
///
/// It replaces the prose status line, whose numbers could not align
/// because the prose in front of them changed length with the session.
///
/// **The bar is one row and never wraps.** A header that grows a second
/// line reflows every panel beneath it, so running out of room is
/// handled by removing things rather than by taking more space. What
/// gives way, and in what order, is {@link planToolbarFit} — the
/// planner every bar in the app shares — and the measuring that feeds
/// it is {@link useToolbarFit}, the plumbing every bar in the app
/// shares. This component only says what its runs are and renders the
/// answer.
///
/// **The bar must not clip.** `overflow: hidden` looks like the
/// belt-and-braces companion to `nowrap` and it breaks the overflow
/// menu, which is an absolutely-positioned child: a clipping bar
/// swallows its own dropdown. Fit is guaranteed by dropping items, not
/// by clipping them. If a future layout genuinely needs the bar to
/// clip, the menu has to be portaled out of it first.

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { BusHealthLauncher, type BusHealthLauncherProps } from "./BusHealthLauncher";
import { StatusChip, statusChipBadgeText } from "./StatusChip";
import { useDismissableMenu } from "./useDismissableMenu";
import { useToolbarFit, TOOLBAR_FIT_OVERFLOW_KEY } from "./useToolbarFit";
import type { ConnectionSummary } from "./connectionStates";
import type { StatusMetric } from "./statusLine";

/// One pinned chip. They are pinned left to right in the order given
/// and pushed into the overflow menu from the right, so the last one
/// standing is the first in the list.
export interface StatusBarChip {
  id: string;
  label: string;
  /// Needs-attention count. The overflow control is badged with the
  /// sum of the counts inside it.
  badge?: number;
  title?: string;
  disabled?: boolean;
  onPress: () => void;
}

export interface StatusBarProps {
  connection: ConnectionSummary;
  /// Runs the connection summary's own action. Never called when the
  /// summary has no action.
  onConnectionPress: () => void;
  /// The bus-health launcher, when there is bus health to report.
  busHealth?: BusHealthLauncherProps;
  /// Whatever is in flight and the response to it — a load's progress
  /// and its Cancel, a rebuild and its Discard, a changed-on-disk
  /// notice and its two buttons. The bar is a readout that also carries
  /// the response to what it reports.
  notices?: ReactNode;
  /// The resting or transient status text.
  statusText: string;
  /// The metrics, already in the ruled left-to-right order.
  metrics: readonly StatusMetric[];
  /// The whole readout, for the tooltip every metric label carries.
  metricsTooltip: string;
  chips: readonly StatusBarChip[];
}

/// How much room the notice region is guaranteed before metrics start
/// dropping for it, in px. Below its own natural width the notice
/// ellipsises rather than pushing the numbers out; above this it takes
/// whatever the metrics and chips leave.
const NOTICE_RESERVE_PX = 180;

/// Fallback width for the overflow control before it has ever been
/// rendered — it is charged for as soon as the first chip collapses,
/// which is before there is one on screen to measure.
const OVERFLOW_ESTIMATE_PX = 46;

export function StatusBar({
  connection,
  onConnectionPress,
  busHealth,
  notices,
  statusText,
  metrics,
  metricsTooltip,
  chips,
}: StatusBarProps) {
  const leadRef = useRef<HTMLDivElement | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useDismissableMenu<HTMLDivElement>(menuOpen, () => setMenuOpen(false));

  // The metrics drop; the pinned chips collapse into the menu.
  const runs = useMemo(
    () => [
      { id: "metrics", items: metrics.map((m) => ({ key: `metric:${m.id}` })) },
      {
        id: "chips",
        items: chips.map((c) => ({ key: `chip:${c.id}` })),
        overflow: true,
      },
    ],
    [chips, metrics],
  );
  // The lead never gives way, and the notice ellipsises rather than
  // pushing the numbers out — but it is never squeezed below its own
  // natural width for nothing. Neither is a run: both are width the
  // runs never had.
  const reserve = useCallback(
    () =>
      (leadRef.current?.offsetWidth ?? 0) +
      Math.min(noticeRef.current?.scrollWidth ?? 0, NOTICE_RESERVE_PX),
    [],
  );
  const { barRef, fit } = useToolbarFit<HTMLDivElement>({
    runs,
    overflowFallback: OVERFLOW_ESTIMATE_PX,
    reserve,
  });

  const shownMetrics = metrics.slice(0, fit.metrics);
  const shownChips = chips.slice(0, fit.chips);
  const collapsedChips = chips.slice(fit.chips);
  const collapsedBadge = collapsedChips.reduce((sum, c) => sum + (c.badge ?? 0), 0);

  const renderChip = (chip: StatusBarChip) => (
    <StatusChip
      key={chip.id}
      label={chip.label}
      badge={chip.badge}
      title={chip.title}
      disabled={chip.disabled}
      onPress={chip.onPress}
    />
  );

  return (
    <div className="status-bar" ref={barRef}>
      {/* The connection control lives here rather than in the toolbar:
          the chip shows the state and pressing it connects or
          disconnects, so nothing reports connection from two places. */}
      <div className="status-bar-lead" ref={leadRef}>
        <StatusChip
          className="status-chip--connection"
          state={connection.state}
          label={connection.label}
          count={connection.count ?? undefined}
          title={connection.detail}
          ariaLabel={`${connection.label}${connection.count ? ` ${connection.count}` : ""} — ${connection.actionLabel}`}
          disabled={connection.action === null}
          onPress={onConnectionPress}
        />
        {busHealth && <BusHealthLauncher {...busHealth} />}
        <span className="status-bar-separator" aria-hidden="true" />
      </div>
      <div className="status" ref={noticeRef}>
        {notices}
        {statusText}
      </div>
      {shownMetrics.map((m) => (
        <span
          key={m.id}
          data-toolbar-fit={`metric:${m.id}`}
          className={m.live ? "status-metric live" : "status-metric"}
        >
          <b>{m.value}</b>
          {/* The whole readout, dropped metrics included, so a narrow
              window costs a hover rather than the number. */}
          <span title={metricsTooltip}>{m.label}</span>
        </span>
      ))}
      <span className="status-bar-spacer" />
      {shownChips.map((chip) => (
        <span key={chip.id} data-toolbar-fit={`chip:${chip.id}`} className="status-bar-pinned">
          {renderChip(chip)}
        </span>
      ))}
      {collapsedChips.length > 0 && (
        <div
          className="status-bar-overflow"
          data-toolbar-fit={TOOLBAR_FIT_OVERFLOW_KEY}
          ref={menuRef}
        >
          {/* The pinned chips never drop; they collapse. Something
              demanding attention can only become one click away, never
              invisible, so the control carries the sum of the counts
              inside it. */}
          <button
            type="button"
            className="status-bar-overflow-button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={
              collapsedBadge > 0
                ? `More status chips (${collapsedBadge} need attention)`
                : "More status chips"
            }
            title={collapsedChips.map((c) => c.label).join(", ")}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span aria-hidden="true">…</span>
            {collapsedBadge > 0 && (
              <span className="status-chip-badge" aria-hidden="true">
                {statusChipBadgeText(collapsedBadge)}
              </span>
            )}
          </button>
          {menuOpen && (
            <ul role="menu" className="status-bar-menu">
              {collapsedChips.map((chip) => (
                <li key={chip.id} role="menuitem">
                  {renderChip(chip)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
