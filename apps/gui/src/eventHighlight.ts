/// Acting on an event lights up what it is about — transiently (ADR 0056).
///
/// Two halves, and the split is the point:
///
/// - **A session-wide channel** for *which* events are being acted on.
///   Hovering an event row or selecting one is view-local state, but the
///   surfaces that answer are other panels — the plot draws the wash, the
///   trace lights the frames — so the one thing that crosses is the id.
///   Nothing here reaches the host, the project file or any persisted
///   config; a reload starts at rest.
/// - **A pure derivation** from that id and the event list: the messages
///   and fields the event names, and the extent of every pair it is an end
///   of. Renderers ask it and draw; they never re-derive the model.
///
/// **Nothing draws at rest.** {@link eventHighlight} answers `null` when
/// no event is being acted on, which is the cheap check every renderer
/// makes before it draws a single conditional pixel.
///
/// The channel is a module-level store rather than React state on purpose:
/// hover moves on every pointer sample, and lifting it into the App tree
/// would re-render every panel to light one. Same idiom as `theme.ts` —
/// subscribe where it is read.

import { useSyncExternalStore } from "react";

import { linkedEventIds, type EventKind, type TimelineEvent } from "./notes";

// ---------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------

/// Shared empty, so a snapshot at rest keeps its identity and
/// `useSyncExternalStore` does not see a change on every read.
const NONE: readonly string[] = [];

let hovered: string | null = null;
let selected: readonly string[] = NONE;
let active: readonly string[] = NONE;
const listeners = new Set<() => void>();

function republish(): void {
  const next = hovered !== null ? [hovered] : selected;
  if (next.length === active.length && next.every((id, i) => active[i] === id)) return;
  active = next.length === 0 ? NONE : next;
  for (const fn of [...listeners]) fn();
}

/// The pointer came to rest on an event row, or left one (`null`).
/// A hover **replaces** the selection for as long as it lasts: pointing at
/// something is the more immediate act, and it is what the reader is
/// asking about.
export function hoverEvent(id: string | null): void {
  hovered = id;
  republish();
}

/// The events view's selection changed. Unlike a hover this survives the
/// pointer leaving, which is what lets a reader select a pair and then go
/// look at the plot.
export function selectEvents(ids: readonly string[]): void {
  selected = ids.length === 0 ? NONE : [...ids];
  republish();
}

/// The events being acted on right now, in no particular order. Empty at
/// rest — the state the app is in unless a pointer or a selection says
/// otherwise.
export function activeEventIds(): readonly string[] {
  return active;
}

/// Shaped for `useSyncExternalStore` alongside {@link activeEventIds}.
export function subscribeEventHighlight(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/// Back to rest — nothing hovered, nothing selected. A session reset has
/// no need to call this (a stale id names no event, so it highlights
/// nothing), but a test that set the channel must.
export function resetEventHighlight(): void {
  hovered = null;
  selected = NONE;
  republish();
}

/// The events being acted on, re-rendering the caller when that moves.
export function useActiveEventIds(): readonly string[] {
  return useSyncExternalStore(subscribeEventHighlight, activeEventIds, activeEventIds);
}

// ---------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------

/// The span a linked pair covers, in absolute ns. Derived from the link at
/// render time — span-ness is a relationship, never a field on an event
/// (ADR 0056 § 3).
export interface EventExtent {
  /// The pair, chronologically. `startNs === endNs` for two events at the
  /// same instant: a zero-width band, which is honest.
  startNs: number;
  endNs: number;
  /// The **earlier** event's own color, or `null` for its kind's default.
  /// Taken from one fixed end so the band looks the same whichever end the
  /// reader is pointing at — the band belongs to the pair, not to the act.
  color: string | null;
  /// That event's kind, so a renderer with no color can resolve the same
  /// default its marker line uses.
  kind: EventKind;
  /// The two ids, sorted, joined by a space — stable across renders and
  /// distinct per pair, so a renderer can key on it.
  key: string;
}

/// Everything one act of highlighting lights up.
export interface EventHighlight {
  /// The events being acted on.
  active: ReadonlySet<string>;
  /// Those plus every event they are linked to — the event rows and
  /// marker lines that stay lit while the rest go quiet.
  events: ReadonlySet<string>;
  /// Messages named as subjects in their own right, by
  /// {@link messageSubjectKey}. A whole message lights every series
  /// decoded from it.
  messages: ReadonlySet<string>;
  /// Individual fields named as subjects, by {@link signalSubjectKey}.
  signals: ReadonlySet<string>;
  /// Every message either kind of reference touches — a message subject,
  /// and the message a signal subject lives on. This is what a *trace row*
  /// asks: a frame is where a field is carried, so an event about
  /// `0x180.PackCurrent` is about `0x180`'s frames.
  touchedMessages: ReadonlySet<string>;
  /// The extent of every pair an active event is an end of.
  extents: readonly EventExtent[];
}

/// A message's identity in a highlight — `(messageId, extended)`, the
/// pair this app treats as one identity everywhere.
export function messageSubjectKey(messageId: number, extended: boolean): string {
  return `${extended ? "x" : "s"}:${messageId}`;
}

/// A field's identity in a highlight: its message, then its name.
export function signalSubjectKey(
  messageId: number,
  extended: boolean,
  signalName: string,
): string {
  return `${messageSubjectKey(messageId, extended)}:${signalName}`;
}

/// What `activeIds` lights up over `events`, or **`null` when nothing
/// does** — no active id, or none of them names an event this view holds.
///
/// Several ids union: selecting a pair for linking lights both, and the
/// extent between them draws once.
export function eventHighlight(
  events: readonly TimelineEvent[],
  activeIds: readonly string[],
): EventHighlight | null {
  const act = new Set<string>();
  for (const id of activeIds) if (events.some((e) => e.id === id)) act.add(id);
  if (act.size === 0) return null;

  const lit = new Set<string>(act);
  const messages = new Set<string>();
  const signals = new Set<string>();
  const touchedMessages = new Set<string>();
  const extents: EventExtent[] = [];
  const pairs = new Set<string>();

  for (const id of act) {
    const event = events.find((e) => e.id === id);
    if (event === undefined) continue;
    for (const s of event.subjects) {
      if (s.kind === "message") {
        messages.add(messageSubjectKey(s.messageId, s.extended));
        touchedMessages.add(messageSubjectKey(s.messageId, s.extended));
      } else if (s.kind === "signal") {
        signals.add(signalSubjectKey(s.messageId, s.extended, s.signalName));
        touchedMessages.add(messageSubjectKey(s.messageId, s.extended));
      }
    }
    // Links are read from both ends (ADR 0056 § 4), so the event that was
    // merely *named* draws the same band as the one that stores the
    // reference.
    for (const otherId of linkedEventIds(events, id)) {
      lit.add(otherId);
      const key = [id, otherId].sort().join(" ");
      if (pairs.has(key)) continue;
      pairs.add(key);
      const other = events.find((e) => e.id === otherId);
      if (other === undefined) continue;
      const [first, second] =
        event.timestampNs <= other.timestampNs ? [event, other] : [other, event];
      extents.push({
        startNs: first.timestampNs,
        endNs: second.timestampNs,
        color: first.color,
        kind: first.kind,
        key,
      });
    }
  }

  return { active: act, events: lit, messages, signals, touchedMessages, extents };
}

/// Does the highlight name this message's frames? True for a message
/// subject and for a field subject carried on it — see
/// {@link EventHighlight.touchedMessages}.
export function highlightsMessage(
  highlight: EventHighlight | null,
  messageId: number,
  extended: boolean,
): boolean {
  return highlight !== null && highlight.touchedMessages.has(messageSubjectKey(messageId, extended));
}

/// Does the highlight name this series? Its own field, or the whole
/// message it belongs to.
export function highlightsSeries(
  highlight: EventHighlight | null,
  messageId: number,
  extended: boolean,
  signalName: string,
): boolean {
  if (highlight === null) return false;
  return (
    highlight.messages.has(messageSubjectKey(messageId, extended)) ||
    highlight.signals.has(signalSubjectKey(messageId, extended, signalName))
  );
}
