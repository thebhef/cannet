/// A segmented group of command chips: **several chips, one hairline**
/// (ADR 0055).
///
/// Where a handful of chips are one decision — the cursor placement
/// mode, a run control's start / pause / stop — drawing each of them
/// its own outline says they are unrelated. The segment draws the
/// outline once, around the lot, and the chips inside it drop theirs
/// and keep a divider instead.
///
/// **It wraps {@link ChipButton}; it does not replace it.** Everything
/// inside is a chip with all of a chip's behaviour — pressed state,
/// icon, tooltip, disabled — and the segment adds only the shared
/// edge. Nothing here is a second chip implementation, and a segment
/// that needs something a chip lacks grows the chip.
///
/// The group is announced as one: `role="group"` with a name, so what a
/// screen reader reads before the three cursor icons is "Cursor mode",
/// not three unrelated buttons.

import type { ReactNode } from "react";

export interface ChipSegmentProps {
  /// What the group as a whole is — Title Case, the same register as a
  /// chip's label. It is the group's accessible name.
  label: string;
  /// Native tooltip for the group, sentence case, when the chips'
  /// own tooltips leave something out (the cursor segment's "press
  /// again for off").
  title?: string;
  /// The caller's own class — a query hook, or a width modifier.
  className?: string;
  /// The chips. {@link ChipButton}s, always.
  children: ReactNode;
}

export function ChipSegment({ label, title, className, children }: ChipSegmentProps) {
  const classes = ["chip-seg"];
  if (className) classes.push(className);
  return (
    <span className={classes.join(" ")} role="group" aria-label={label} title={title}>
      {children}
    </span>
  );
}
