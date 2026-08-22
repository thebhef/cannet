/// The shared status chip: **it shows a state, and pressing it goes to
/// where that state is managed.**
///
/// One implementation, not a per-panel copy — the same rule that
/// governs the shared colour chip. Its shape *is* the colour chip's
/// (`.color-chip`): a 2px radius over a 1px `--border-wash` hairline,
/// with a rounded-square indicator rather than a circle, so the two
/// read as one family. What it adds is **tinting that edge to carry
/// state**: an idle chip is the plain hairline, and every other state
/// recolours the same 1px edge — no weight change and no movement, so
/// a chip never resizes as the thing it reports progresses.
///
/// Width uniformity is *within* one chip's state set, not across
/// different chips, and it is expressed by the caller's own modifier
/// class (`.status-chip--connection`) sized to that chip's longest
/// state — forcing every chip in the app to one width would spend the
/// bar on short labels.

/// The state vocabulary. `idle` is "nothing to report" and is the
/// colour chip's own neutral hairline; the other four tint it.
/// `attention` covers the needs-looking-at case that is not a fault
/// (bus health's error-passive), `failed` the fault.
export const STATUS_CHIP_STATES = [
  "idle",
  "connecting",
  "connected",
  "degraded",
  "failed",
] as const;

export type StatusChipState = (typeof STATUS_CHIP_STATES)[number];

export interface StatusChipProps {
  /// What the chip reports. Defaults to `idle` — the neutral hairline.
  state?: StatusChipState;
  /// The chip's word. Kept short: the chip is sized to its longest
  /// state.
  label: string;
  /// A right-aligned, tabular-numeric readout — `4 / 5`. Tabular so the
  /// digits change without the layout moving.
  count?: string;
  /// A needs-attention count. Absent or zero renders nothing: a badge
  /// that says "0" is noise.
  badge?: number;
  /// Native tooltip — the long-form detail behind the chip's word.
  title?: string;
  /// Accessible name. Defaults to the label plus the count.
  ariaLabel?: string;
  /// A chip whose destination cannot be reached right now. Still shows
  /// its state — reporting is the point — but does not pretend to be
  /// pressable.
  disabled?: boolean;
  /// Where pressing it goes.
  onPress: () => void;
  /// The caller's own class — a width modifier, or a query hook for its
  /// own tests. Carries no styling of its own beyond what the caller
  /// declares.
  className?: string;
}

/// A badge count as it is written: capped, the way the toolbar's
/// launcher badges already cap theirs, so a runaway count cannot widen
/// the chip.
export function statusChipBadgeText(badge: number): string {
  return badge > 99 ? "99+" : String(badge);
}

export function StatusChip({
  state = "idle",
  label,
  count,
  badge,
  title,
  ariaLabel,
  disabled,
  onPress,
  className,
}: StatusChipProps) {
  const classes = ["status-chip"];
  if (className) classes.push(className);
  return (
    <button
      type="button"
      className={classes.join(" ")}
      data-state={state}
      title={title}
      aria-label={ariaLabel ?? (count ? `${label} ${count}` : label)}
      disabled={disabled}
      onClick={onPress}
    >
      <span className="status-chip-dot" aria-hidden="true" />
      <span className="status-chip-label">{label}</span>
      {count != null && <span className="status-chip-count">{count}</span>}
      {badge != null && badge > 0 && (
        <span className="status-chip-badge" aria-hidden="true">
          {statusChipBadgeText(badge)}
        </span>
      )}
    </button>
  );
}
