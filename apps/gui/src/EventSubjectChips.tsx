/// The subject chips on an event row (ADR 0056), and what happens when
/// they do not fit.
///
/// **The row never grows with the subject count.** An event with a
/// dozen subjects has to occupy exactly the row an event with one does,
/// because the trace virtualizes these rows on a fixed height and a bar
/// that wraps eats the view it sits over. So the chips give way the way
/// every other bar in the app gives way — {@link useToolbarFit} measures
/// them and {@link planToolbarFit} says how many stay — and the ones
/// that do not fit collapse into a `…` control that carries their count.
///
/// **The `…` discloses the row rather than dropping a menu.** The status
/// bar's overflow opens an absolutely-positioned list, which cannot work
/// here: the scroll area these rows live in is `contain: strict` and the
/// row stack inside it is `overflow: hidden`, so a dropdown from a row
/// is clipped by construction. The row already has an expansion — the
/// body that discloses the tag and the description — and the collapsed
/// subjects are listed there. Same promise as the status bar's: nothing
/// is ever more than one click away.

import { useMemo, type MouseEvent } from "react";

import { Icon } from "./Icon";
import { useToolbarFit, TOOLBAR_FIT_OVERFLOW_KEY } from "./useToolbarFit";
import type { SubjectChip } from "./eventSubjects";

/// Width to assume for the `…` control before it has ever been
/// rendered — it is charged as soon as the first chip collapses, which
/// is before there is one on screen to measure.
const OVERFLOW_ESTIMATE_PX = 40;

/// One chip. A signal and a message differ by their ink, not by an
/// icon — a message id is drawn in the same colour the trace's id
/// column uses, so the row reads the same way the table above it does.
/// A link carries the registry's `link` glyph, because "the other end
/// of a pair" is not something an id or a name can say.
function Chip({ chip }: { chip: SubjectChip }) {
  const classes = ["event-subject-chip", `event-subject-chip--${chip.kind}`];
  if (!chip.resolved) classes.push("event-subject-chip--unresolved");
  return (
    <span className={classes.join(" ")} data-toolbar-fit={chip.key} title={chip.title}>
      {chip.kind === "event" && <Icon name="link" />}
      <span className="event-subject-chip-label">{chip.label}</span>
    </span>
  );
}

export interface EventSubjectChipsProps {
  /// Already resolved against the assigned databases and the event set
  /// (`subjectChips`), in the order they are drawn.
  chips: readonly SubjectChip[];
  /// The row's body is open, so the collapsed chips are already listed
  /// below. The `…` control reports it, because pressing it is what
  /// opens the body.
  expanded: boolean;
  /// Open (or shut) the row's body — the `…` control's whole action.
  onExpand: () => void;
}

export function EventSubjectChips({ chips, expanded, onExpand }: EventSubjectChipsProps) {
  const runs = useMemo(
    () => [{ id: "chips", items: chips.map((c) => ({ key: c.key })), overflow: true }],
    [chips],
  );
  const { barRef, fit } = useToolbarFit<HTMLSpanElement>({
    runs,
    overflowFallback: OVERFLOW_ESTIMATE_PX,
  });
  const kept = chips.slice(0, fit.chips ?? chips.length);
  const collapsed = chips.slice(kept.length);

  return (
    <span className="event-subject-chips" ref={barRef}>
      {kept.map((chip) => (
        <Chip key={chip.key} chip={chip} />
      ))}
      {collapsed.length > 0 && (
        <button
          type="button"
          // The status bar's overflow control, in a row's density — one
          // appearance for "there is more, one click away" (ADR 0055).
          className="status-bar-overflow-button event-subject-more"
          data-toolbar-fit={TOOLBAR_FIT_OVERFLOW_KEY}
          // Out of the tab order, like the row's own disclosure caret:
          // what it does is the caret's, and Tab into the row must land
          // on a control the keyboard does not otherwise have.
          tabIndex={-1}
          aria-expanded={expanded}
          aria-label={`show ${collapsed.length} more subject${collapsed.length === 1 ? "" : "s"}`}
          title={collapsed.map((c) => c.title).join("\n")}
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            // The row's click puts the grid's cursor on it; this button
            // has its own job.
            e.stopPropagation();
            onExpand();
          }}
        >
          <span aria-hidden="true">{`… +${collapsed.length}`}</span>
        </button>
      )}
    </span>
  );
}
