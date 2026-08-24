// Session-scoped notes (event annotations the user places on the
// timeline). The host owns the canonical list
// (`apps/gui/src-tauri/src/notes.rs`); this module is the pure-TS
// helpers + types every consumer (the PlotPanel hook, App.tsx, the
// unit tests) shares.

import { wheelColor } from "./palette";

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
  /// Name for this kind on its own — a tooltip, a diagnostic. The filter
  /// labels {@link EVENT_KIND_GROUPS}, not kinds.
  label: string;
  category: EventCategory;
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
    editable: true,
    blfRecord: "GLOBAL_MARKER",
  },
  messageBound: {
    label: "Comments",
    category: "userAuthored",
    editable: true,
    blfRecord: "EVENT_COMMENT",
  },
  busError: {
    label: "Bus Errors",
    category: "hostDerived",
    editable: false,
    blfRecord: null,
  },
  truncation: {
    label: "Truncation",
    category: "frontendDerived",
    editable: false,
    blfRecord: null,
  },
};

/// How the kind filter is offered to a reader: one row per **group**,
/// not one per kind.
///
/// A kind is a model distinction — what an event is for, and which record
/// it round-trips as. A filter row is a reader distinction, and the two
/// are not the same list. Two kinds differ only in the file record they
/// are written as (`note` / `messageBound`), and nothing in the
/// application can author the second; two others are things the tool
/// found rather than things anyone wrote (`busError` / `truncation`). A
/// row apiece asked the reader to hold a taxonomy they never chose.
///
/// Every kind belongs to exactly one group — a kind left out would be
/// unreachable from the filter and stuck at its default.
export interface EventKindGroup {
  /// The row's label.
  label: string;
  /// What the row is, for its tooltip.
  title: string;
  /// The kinds this row shows and hides together.
  kinds: readonly EventKind[];
}

export const EVENT_KIND_GROUPS: readonly EventKindGroup[] = [
  {
    label: "Notes",
    title: "annotations you placed, and comments read from a capture file",
    kinds: ["note", "messageBound"],
  },
  {
    label: "Diagnostics",
    title: "what the tool found: bus error runs, and where history was truncated",
    kinds: ["busError", "truncation"],
  },
];

/// The kinds a view shows before the user says otherwise — the seed for
/// each view's own (view-local) override.
///
/// Everything, now that the filter is grouped. Bus errors were once
/// filtered out by default as noise; the host coalesces a run of error
/// frames into a single summary event (`bus_health.rs`), so a fault that
/// produces a hundred thousand error frames produces one row — and a
/// fault is the thing a reader most wants surfaced without going looking
/// for it.
export function defaultVisibleKinds(): Set<EventKind> {
  return new Set(EVENT_KINDS);
}

/// Drop the events whose kind this view is not showing. Applied *after*
/// `timelineEvents` so a filter control can still count what it is hiding.
export function visibleEvents(
  events: readonly TimelineEvent[],
  visible: ReadonlySet<EventKind>,
): TimelineEvent[] {
  return events.filter((e) => visible.has(e.kind));
}

/// What an event is about — a structural reference, never a rendered name
/// (ADR 0056). A message reference is the arbitration id; a signal
/// reference adds the field name; an event reference is another event's id.
/// Message identity in this app is `(messageId, extended)`, so both
/// message-bearing kinds carry the flag.
///
/// Nothing here names a bus or a database: a reference resolves against
/// whatever databases are assigned at render time, and it remains when it
/// resolves to nothing.
export type EventSubject =
  | { kind: "message"; messageId: number; extended: boolean }
  | { kind: "signal"; messageId: number; extended: boolean; signalName: string }
  | { kind: "event"; id: string };

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
  /** What the event is about (ADR 0056); absent on an event with none. */
  subjects?: EventSubject[];
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
  /** What the event is about (ADR 0056) — empty when it names nothing. */
  subjects: EventSubject[];
}

/// Synthetic id of the derived truncation marker — stable so the views
/// can key it and the rename/remove paths can reject it (it isn't a note).
export const TRUNCATION_EVENT_ID = "__truncation";

/// Mint a new user-authored event at `timestampNs`, about `subjects`
/// (ADR 0056) — **the one constructor every authoring gesture uses**.
///
/// That is the point of it, not a convenience. An event carries nothing
/// that says how it was made: the gesture that dropped it on a plot with
/// signals selected and the one that raised it from a trace row produce
/// the same shape, and after the fact neither the model nor any view can
/// tell them apart. Routing both through one function is how that stays
/// true as gestures are added — a second constructor is where a
/// provenance tell would creep in.
///
/// `existingCount` is how many events the session already holds: it
/// numbers the label and picks the color off the shared signal wheel
/// (ADR 0026), the way plot series seed by area signal count, so
/// successive events are distinguishable without anyone picking.
export function authorEvent(
  timestampNs: number,
  subjects: readonly EventSubject[],
  existingCount: number,
): Note {
  return {
    id: crypto.randomUUID(),
    timestampNs,
    label: `note ${existingCount + 1}`,
    color: wheelColor(existingCount),
    subjects: [...subjects],
  };
}

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
    subjects: n.subjects ?? [],
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
    subjects: [],
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

/// Every event `id` is linked to, read in **both** directions (ADR 0056):
/// a link is stored once, on whichever event the authoring gesture touched,
/// and both ends see it. Ids come out in list order — the event's own
/// subjects first, then the events that name it — with duplicates
/// collapsed.
///
/// A reference to an event this list does not hold is unresolved, not
/// broken: it is absent from the result and stays in the subject list.
export function linkedEventIds(events: readonly TimelineEvent[], id: string): string[] {
  const out: string[] = [];
  const push = (candidate: string) => {
    if (candidate === id || out.includes(candidate)) return;
    if (events.some((e) => e.id === candidate)) out.push(candidate);
  };
  const own = events.find((e) => e.id === id);
  for (const s of own?.subjects ?? []) if (s.kind === "event") push(s.id);
  for (const e of events) {
    if (e.subjects.some((s) => s.kind === "event" && s.id === id)) push(e.id);
  }
  return out;
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
