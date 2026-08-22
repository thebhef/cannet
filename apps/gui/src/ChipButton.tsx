/// The command chip: **it does something, and it looks exactly like
/// the chip that reports something** (ADR 0055).
///
/// One silhouette for every control in the app's chrome. This is the
/// shipped {@link StatusChip}'s shape rather than a second chip
/// component — literally so: the element carries `.status-chip`, so the
/// hairline, the 2px radius, the dot, the badge and every state tint
/// are the declarations the status chip already ships, and `.chip-button`
/// only adds what a *command* needs on top: the chrome's 22px density,
/// an icon from the registry, a pressed state and a focus ring.
///
/// The status chip's invariant carries over unchanged: **state tints
/// the 1px border and the dot, and nothing moves**. A chip does not
/// resize when it is pressed, when it goes busy, or as the thing it
/// reports progresses — a toolbar whose controls shuffle sideways as
/// the session changes is unusable at speed. `ChipButton.dom.test.tsx`
/// holds that by comparing the chip's resolved geometry across every
/// state.

import { Icon, type IconName } from "./Icon";
import { statusChipBadgeText, type StatusChipState } from "./StatusChip";

export interface ChipButtonProps {
  /// The registry icon, drawn left of the label. Omit for a chip that
  /// is words alone.
  icon?: IconName;
  /// The chip's words, Title Case. Omit for the icon-only form, which
  /// is for icons unambiguous enough to stand alone — and which then
  /// needs a `title` or an `ariaLabel` to be nameable.
  label?: string;
  /// What the chip reports, for a command that also carries a state.
  /// Providing it — `idle` included — is what gives the chip its dot;
  /// a plain command has nothing to report and grows none. The dot is
  /// then present in *every* state, so settling into one cannot resize
  /// the chip.
  state?: StatusChipState;
  /// A toggle's position. Omitted entirely for a chip that is not a
  /// toggle, so nothing announces a pressed state that does not exist.
  pressed?: boolean;
  /// Whether the menu this chip opens is showing. Providing it at all
  /// is what makes the chip a menu trigger — it then announces
  /// `haspopup` as well — so a chip that opens nothing says nothing,
  /// the same rule {@link ChipButtonProps.pressed} follows. A trigger
  /// is not a toggle: what it announces is "a menu, currently open",
  /// not "on".
  menuOpen?: boolean;
  /// A needs-attention count. Absent or zero renders nothing: a badge
  /// that says "0" is noise.
  badge?: number;
  /// The chip's own work is running (an import, a rebuild). Tints the
  /// hairline and pulses it; changes no dimension.
  busy?: boolean;
  /// Native tooltip — the long form of what pressing it does. Sentence
  /// case, unlike the label.
  title?: string;
  /// Accessible name, when neither the label nor the title is the right
  /// one to read out.
  ariaLabel?: string;
  disabled?: boolean;
  onPress: () => void;
  /// The caller's own class — a width modifier, or a query hook for its
  /// own tests.
  className?: string;
}

export function ChipButton({
  icon,
  label,
  state,
  pressed,
  menuOpen,
  badge,
  busy,
  title,
  ariaLabel,
  disabled,
  onPress,
  className,
}: ChipButtonProps) {
  const classes = ["status-chip", "chip-button"];
  if (label === undefined) classes.push("chip-button--icon-only");
  if (className) classes.push(className);
  return (
    <button
      type="button"
      className={classes.join(" ")}
      data-state={state}
      aria-pressed={pressed}
      aria-haspopup={menuOpen === undefined ? undefined : "menu"}
      aria-expanded={menuOpen}
      aria-busy={busy || undefined}
      title={title}
      aria-label={ariaLabel ?? label ?? title}
      disabled={disabled}
      onClick={onPress}
    >
      {state !== undefined && <span className="status-chip-dot" aria-hidden="true" />}
      {icon !== undefined && <Icon name={icon} />}
      {label !== undefined && <span className="status-chip-label">{label}</span>}
      {badge != null && badge > 0 && (
        <span className="status-chip-badge" aria-hidden="true">
          {statusChipBadgeText(badge)}
        </span>
      )}
    </button>
  );
}
