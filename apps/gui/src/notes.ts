// Session-scoped notes (event annotations placed by the
// plot panel's `+ note` cursor). The host owns the canonical list
// (`apps/gui/src-tauri/src/notes.rs`); this module is the pure-TS
// helpers + types every consumer (the PlotPanel hook, App.tsx, the
// unit tests) shares.

/// The kind of a timeline event (ADR 0035). `note` is the user-placed
/// marker the host stores; `messageBound` is a comment attached to the
/// message it sits beside (BLF's own `EVENT_COMMENT`); `busError` is a run
/// of CAN bus errors the host coalesced into one event; `truncation` is the
/// disk-spill marker synthesised here in the frontend (never sent by the
/// host).
export type EventKind = "note" | "messageBound" | "busError" | "truncation";

/// Where an event came from (ADR 0035). The category, not the individual
/// kind, decides the lifecycle: only a user-authored event is editable,
/// persisted and exported.
export type EventCategory = "userAuthored" | "hostDerived" | "frontendDerived";

/// What a kind declares about itself — one global truth, so no view has to
/// know a particular kind's habits.
export interface EventKindMeta {
  /// Name shown in a filter control.
  label: string;
  category: EventCategory;
  /// Does it render without being asked for? A kind that is noise until you
  /// go looking for it declares `false`; a view starts with it filtered out
  /// and the user turns it on there (the override is view-local).
  visibleByDefault: boolean;
  /// Whether the user can rename / recolor / remove it. Follows the
  /// category — only the author of an event may edit it.
  editable: boolean;
  /// The BLF record type this kind round-trips as, or `null` when it is not
  /// written out at all. The record type is a property of the kind, so
  /// filtering by kind *is* filtering by record type.
  blfRecord: "GLOBAL_MARKER" | "EVENT_COMMENT" | null;
}

/// Every kind, in the order a filter control lists them.
export const EVENT_KINDS: readonly EventKind[] = [
  "note",
  "messageBound",
  "busError",
  "truncation",
];

/// The per-kind declarations (ADR 0035).
export const EVENT_KIND_META: Record<EventKind, EventKindMeta> = {
  note: {
    label: "Notes",
    category: "userAuthored",
    visibleByDefault: true,
    editable: true,
    blfRecord: "GLOBAL_MARKER",
  },
  messageBound: {
    label: "Comments",
    category: "userAuthored",
    visibleByDefault: true,
    editable: true,
    blfRecord: "EVENT_COMMENT",
  },
  busError: {
    label: "Bus Errors",
    category: "hostDerived",
    // A bus error is noise until you ask for it — true of every project,
    // which is why it belongs next to the kind and not in project state.
    visibleByDefault: false,
    editable: false,
    blfRecord: null,
  },
  truncation: {
    label: "Truncation",
    category: "frontendDerived",
    visibleByDefault: true,
    editable: false,
    blfRecord: null,
  },
};

/// The kinds a view shows before the user says otherwise — the seed for
/// each view's own (view-local) override.
export function defaultVisibleKinds(): Set<EventKind> {
  return new Set(EVENT_KINDS.filter((k) => EVENT_KIND_META[k].visibleByDefault));
}

/// Drop the events whose kind this view is not showing. Applied *after*
/// `timelineEvents` so a filter control can still count what it is hiding.
export function visibleEvents(
  events: readonly TimelineEvent[],
  visible: ReadonlySet<EventKind>,
): TimelineEvent[] {
  return events.filter((e) => visible.has(e.kind));
}

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
  /** `#RRGGBB`, or `null`/absent for the view's default color. */
  color?: string | null;
  /** Free-text body the event view discloses under the label. */
  description?: string | null;
  /** User-defined tag, the event view's second filter axis. */
  tag?: string | null;
}

/// A rendered timeline event (ADR 0035): the common shape every view —
/// the plot cursor, the trace event row, the events view — draws from one
/// model, whichever of the three categories produced it.
export interface TimelineEvent {
  id: string;
  timestampNs: number;
  label: string;
  kind: EventKind;
  /** `#RRGGBB` or `null` (render the kind's default color). */
  color: string | null;
  /** The disclosed body, or `null` when the event has none. */
  description: string | null;
  /** The user-defined tag, or `null`. */
  tag: string | null;
  /** Whether the user may edit it — a property of the kind, not the caller. */
  editable: boolean;
}

/// Synthetic id of the derived truncation marker — stable so the views
/// can key it and the rename/remove paths can reject it (it isn't a note).
export const TRUNCATION_EVENT_ID = "__truncation";

/// Map a host event to a [`TimelineEvent`]; defaults a pre-kind / add-path
/// note to the `note` kind and no color. Editability comes from the kind's
/// declaration, not from the caller — a host-derived event arrives on the
/// same wire as a note and must not become editable by sharing it.
export function noteToEvent(n: Note): TimelineEvent {
  const kind = n.kind ?? "note";
  return {
    id: n.id,
    timestampNs: n.timestampNs,
    label: n.label,
    kind,
    color: n.color ?? null,
    description: n.description ?? null,
    tag: n.tag ?? null,
    editable: EVENT_KIND_META[kind]?.editable ?? false,
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
    description: null,
    tag: null,
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

/// Does this event match a free-text tag query? An empty query matches
/// everything; otherwise the event's tag must contain it, case-insensitively.
/// Untagged events drop out of a non-empty query — that is the point of
/// asking for a tag.
export function matchesTagQuery(e: TimelineEvent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (e.tag ?? "").toLowerCase().includes(q);
}

/// Every tag in use, sorted — what a filter control offers as suggestions.
export function tagsInUse(events: readonly TimelineEvent[]): string[] {
  return [...new Set(events.map((e) => e.tag).filter((t): t is string => !!t))].sort();
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
