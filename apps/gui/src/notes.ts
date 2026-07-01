// Session-scoped notes (event annotations placed by the
// plot panel's `+ note` cursor). The host owns the canonical list
// (`apps/gui/src-tauri/src/notes.rs`); this module is the pure-TS
// helpers + types every consumer (the PlotPanel hook, App.tsx, the
// unit tests) shares.

/// The kind of a timeline event (ADR 0035). `note` is the user-placed
/// marker the host stores; `truncation` is the derived disk-spill marker
/// synthesised in the frontend (never sent by the host).
export type EventKind = "note" | "truncation";

/// One note as the host serialises it. `timestampNs` is the
/// absolute trace timestamp (`RawTraceFrame::timestamp_ns`); the
/// plot panel converts to/from display-relative seconds against
/// the trace's window start.
export interface Note {
  id: string;
  /** Absolute ns on the trace timeline. The host's `Note` struct
   *  opts in to camelCase serde so this is the on-wire shape. */
  timestampNs: number;
  label: string;
  /** Event kind (ADR 0035); the host sends `"note"`. Optional because
   *  the `add_note` dispatch omits it — the host defaults it. */
  kind?: EventKind;
  /** `#RRGGBB`, or `null`/absent for the view's default colour. */
  color?: string | null;
}

/// A rendered timeline event (ADR 0035): the common shape every view —
/// the plot cursor, the trace event row, the events mode — draws from one
/// model. A host note maps to one (`editable`); the derived truncation
/// marker is another (`editable: false`).
export interface TimelineEvent {
  id: string;
  timestampNs: number;
  label: string;
  kind: EventKind;
  /** `#RRGGBB` or `null` (render the kind's default colour). */
  color: string | null;
  /** Derived events (truncation) are not user-editable; notes are. */
  editable: boolean;
}

/// Synthetic id of the derived truncation marker — stable so the views
/// can key it and the rename/remove paths can reject it (it isn't a note).
export const TRUNCATION_EVENT_ID = "__truncation";

/// Map a host note to a [`TimelineEvent`]; defaults a pre-kind / add-path
/// note to the `note` kind and no colour.
export function noteToEvent(n: Note): TimelineEvent {
  return {
    id: n.id,
    timestampNs: n.timestampNs,
    label: n.label,
    kind: n.kind ?? "note",
    color: n.color ?? null,
    editable: true,
  };
}

/// The derived disk-spill truncation marker (ADR 0035) at `timestampNs`
/// (the oldest retained frame). Not persisted, not exported, not editable.
export function truncationEvent(timestampNs: number): TimelineEvent {
  return {
    id: TRUNCATION_EVENT_ID,
    timestampNs,
    label: "history truncated here",
    kind: "truncation",
    color: null,
    editable: false,
  };
}

/// Merge the host notes with the optional derived truncation marker into
/// one chronological event list — the single model the plot and the trace
/// both render (ADR 0035). `truncationTsNs` is `null` until eviction has
/// truncated the oldest history (`first_index > 0`).
export function timelineEvents(
  notes: readonly Note[],
  truncationTsNs: number | null,
): TimelineEvent[] {
  const events = notes.map(noteToEvent);
  if (truncationTsNs != null) events.push(truncationEvent(truncationTsNs));
  return events.sort((a, b) => a.timestampNs - b.timestampNs);
}

/// Keep a snapshot in chronological order. Pure helper so the
/// callers don't accidentally re-sort each render. Useful when the
/// host's `notes-changed` event payload is already sorted but a
/// future host change might forget that invariant.
export function sortNotesChronologically(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => a.timestampNs - b.timestampNs);
}

/// Convert an absolute trace ns timestamp to display-relative
/// seconds: `(ns - windowStartNs) / 1e9`. `null` returned when the
/// inputs aren't finite, so callers can render "—" rather than a
/// `NaN` x-position.
export function noteSecondsFromWindow(
  timestampNs: number,
  windowStartNs: number,
): number | null {
  if (!Number.isFinite(timestampNs) || !Number.isFinite(windowStartNs)) {
    return null;
  }
  return (timestampNs - windowStartNs) / 1e9;
}

/// Inverse of `noteSecondsFromWindow`: convert display-relative
/// seconds back to an absolute ns timestamp (`add_note` carries
/// `timestampNs` on the wire). Rounds to the nearest ns so the
/// host's ns store doesn't see fractional values. `null` when
/// inputs aren't finite.
export function noteNsFromDisplay(
  displaySeconds: number,
  windowStartNs: number,
): number | null {
  if (
    !Number.isFinite(displaySeconds) ||
    !Number.isFinite(windowStartNs)
  ) {
    return null;
  }
  return Math.round(windowStartNs + displaySeconds * 1e9);
}
