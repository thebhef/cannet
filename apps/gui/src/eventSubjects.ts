/// Turning an event's subjects into the chips a row draws (ADR 0056).
///
/// A subject is a **structural reference** — a message id, or a message
/// id plus a field name, or another event's id. It stores no bus and no
/// database identity, so the name on a chip is resolved *here*, at
/// render time, against whatever databases are assigned right now.
///
/// Two things follow, and both are the point rather than an edge case:
///
/// - **Unresolved is a first-class state.** A reference no assigned
///   database can name still shows what it points at — the id, the field
///   name — muted, with the reason in its tooltip. Nothing is dropped and
///   nothing is repaired; the same annotation read against next year's
///   database resolves again.
/// - **A link is read from both ends.** The reference is stored once, on
///   whichever event the authoring gesture touched, so the chips for
///   event links come from {@link linkedEventIds} over the whole event
///   set — never from the event's own subject list alone, which would
///   find half of them.
///
/// Pure, and independent of React: the row component only draws what
/// this returns.

import { formatArbitrationId, type CanIdFormat } from "./format";
import { linkedEventIds, type EventSubject, type TimelineEvent } from "./notes";
import type { SignalDescriptorRecord } from "./types";

/// One chip on an event row.
export interface SubjectChip {
  /// Stable across renders, distinct within one event's chips.
  key: string;
  kind: "message" | "signal" | "event";
  /// The words on the chip. For a signal that is the field name; for a
  /// message the id and, when a database names it, the message name.
  label: string;
  /// The long form, for the chip's tooltip — and, when the reference
  /// resolves to nothing, the reason it does not.
  title: string;
  /// Whether an assigned database names it (an event link: whether the
  /// event set holds the other end).
  resolved: boolean;
  /// `#RRGGBB` to ink the chip with, or `null` for its kind's default.
  ///
  /// Only a link chip carries one, and it is the *linked event's* own
  /// color — the chip and the marker it points at are then the same
  /// thing said twice, which is the whole use of a link chip. A
  /// structural reference has no color to borrow: a message id is not
  /// an event.
  color: string | null;
  /// What the chip's remove control drops.
  remove: ChipRemoval;
}

/// What removing a chip does. A structural reference comes off the
/// event's own subject list; a link is a pair, and dropping it is the
/// same act from either end (ADR 0056) — so the descriptor names the
/// *other* event, not a position in a list this event may not even hold
/// the reference in.
export type ChipRemoval =
  | { kind: "subject"; subject: EventSubject }
  | { kind: "unlink"; otherId: string };

/// `subjects` without the first structurally-equal match — what a
/// chip's remove control hands to `set_note_subjects`.
///
/// Matched by value rather than by index: a subject *is* its structure
/// (ADR 0056), it carries no identity of its own, and two identical
/// entries on one event are indistinguishable by construction. Value
/// matching also survives a click landing on a render whose subject
/// order has since changed.
export function withoutSubject(
  subjects: readonly EventSubject[],
  subject: EventSubject,
): EventSubject[] {
  const at = subjects.findIndex((s) => sameSubject(s, subject));
  if (at < 0) return [...subjects];
  return [...subjects.slice(0, at), ...subjects.slice(at + 1)];
}

function sameSubject(a: EventSubject, b: EventSubject): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "event") return a.id === (b as { id: string }).id;
  const o = b as { messageId: number; extended: boolean; signalName?: string };
  if (a.messageId !== o.messageId || a.extended !== o.extended) return false;
  return a.kind !== "signal" || a.signalName === o.signalName;
}

/// What the assigned databases can name right now, in the two shapes a
/// subject asks about. Built from the signal catalog — the host's
/// expansion of the assigned databases — and shared by every row.
export interface SubjectIndex {
  /// The message's name, or `null` when no assigned database defines it.
  messageName: (messageId: number, extended: boolean) => string | null;
  /// Whether some assigned database defines this field on that message.
  hasSignal: (messageId: number, extended: boolean, signalName: string) => boolean;
}

function messageKey(messageId: number, extended: boolean): string {
  return `${extended ? "x" : "s"}:${messageId}`;
}

function buildSubjectIndex(catalog: readonly SignalDescriptorRecord[]): SubjectIndex {
  const messages = new Map<string, string>();
  const signals = new Set<string>();
  for (const r of catalog) {
    const key = messageKey(r.message_id, r.extended);
    if (!messages.has(key)) messages.set(key, r.message_name);
    signals.add(`${key}:${r.signal_name}`);
  }
  return {
    messageName: (id, extended) => messages.get(messageKey(id, extended)) ?? null,
    hasSignal: (id, extended, name) => signals.has(`${messageKey(id, extended)}:${name}`),
  };
}

/// One index per catalog, keyed by the catalog array itself. Every event
/// row asks, and the catalog runs to thousands of entries — rebuilding
/// the maps per row would make the index cost scale with the viewport.
const indexes = new WeakMap<readonly SignalDescriptorRecord[], SubjectIndex>();

/// The shared {@link SubjectIndex} for a catalog. The same array gives
/// back the same index, so a `useMemo` on the catalog is enough for a
/// whole viewport of rows.
export function subjectIndexFor(catalog: readonly SignalDescriptorRecord[]): SubjectIndex {
  const hit = indexes.get(catalog);
  if (hit) return hit;
  const built = buildSubjectIndex(catalog);
  indexes.set(catalog, built);
  return built;
}

/// Why a chip is muted, said the same way everywhere.
const UNRESOLVED = "no assigned database defines it right now";

/// The chips for one event: its message and signal subjects in the order
/// it stores them, then the events it is linked to — read from both ends
/// (ADR 0056), so the event that was *named* shows the link too.
///
/// `events` is the set the links resolve against (the view's whole event
/// list, not the filtered one); `index` is what the assigned databases
/// can name; `idFormat` is the view's own arbitration-id format.
export function subjectChips(
  event: TimelineEvent,
  events: readonly TimelineEvent[],
  index: SubjectIndex,
  idFormat: CanIdFormat,
): SubjectChip[] {
  const chips: SubjectChip[] = [];
  for (const s of event.subjects) {
    if (s.kind === "event") continue;
    const id = formatArbitrationId(s.messageId, s.extended, idFormat);
    const name = index.messageName(s.messageId, s.extended);
    if (s.kind === "message") {
      chips.push({
        key: `message:${id}`,
        kind: "message",
        label: name === null ? id : `${id} ${name}`,
        title: name === null ? `message ${id} — ${UNRESOLVED}` : `message ${id} ${name}`,
        resolved: name !== null,
        color: null,
        remove: { kind: "subject", subject: s },
      });
      continue;
    }
    const resolved = index.hasSignal(s.messageId, s.extended, s.signalName);
    const where = name === null ? id : `${id} ${name}`;
    chips.push({
      key: `signal:${id}:${s.signalName}`,
      kind: "signal",
      label: s.signalName,
      title: resolved
        ? `signal ${where}.${s.signalName}`
        : `signal ${where}.${s.signalName} — ${UNRESOLVED}`,
      resolved,
      color: null,
      remove: { kind: "subject", subject: s },
    });
  }
  // Links last, and from both directions. An id the set does not hold is
  // absent from `linkedEventIds` — unresolved, not broken — so a link
  // chip is only ever drawn for an event there is a label for.
  for (const id of linkedEventIds(events, event.id)) {
    const other = events.find((e) => e.id === id);
    if (other === undefined) continue;
    chips.push({
      key: `event:${id}`,
      kind: "event",
      label: other.label,
      title: `linked event — ${other.label}`,
      resolved: true,
      color: other.color,
      remove: { kind: "unlink", otherId: id },
    });
  }
  return chips;
}
