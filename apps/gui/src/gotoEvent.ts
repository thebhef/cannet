// Cross-panel "goto" bus (ADR 0035): the events view broadcasts a timeline
// jump and every trace / plot panel re-centres on it. It is ephemeral view
// state — a panel telling its siblings where to look — so it rides a
// frontend-only Tauri event rather than the host note store. The payload is
// the event's absolute frame timestamp in nanoseconds; each listener resolves
// it against its own timing model, all sharing the one origin (ADR 0024).

import { defaultVisibleKinds, timelineEvents, visibleEvents, type Note } from "./notes";

/// The frontend event name carrying a goto request.
export const GOTO_EVENT = "goto-event";

/// The goto payload: the target's absolute timestamp, nanoseconds.
export type GotoPayload = number;

/// One go-to-event palette row. `id` is the event's absolute timestamp in
/// ns as a string, so the palette's `onPick` can broadcast it verbatim on
/// the goto bus (ADR 0018 / 0035).
export interface GotoEventItem {
  id: string;
  label: string;
  hint: string;
}

/// Build the go-to-event palette rows from the timeline events, hinting
/// each with its time relative to the session start. The same model the
/// events view renders (`timelineEvents`), less the kinds that are hidden
/// by default — "not shown anywhere by default" (ADR 0035) covers the
/// palette too. The events view lists those kinds and offers a goto on
/// each row, so they stay reachable.
export function gotoEventItems(
  notes: readonly Note[],
  truncationTsNs: number | null,
  sessionStartSeconds: number | null,
): GotoEventItem[] {
  const base = sessionStartSeconds ?? 0;
  return visibleEvents(timelineEvents(notes, truncationTsNs), defaultVisibleKinds()).map((e) => ({
    id: String(e.timestampNs),
    label: e.label,
    hint: `${(e.timestampNs / 1e9 - base).toFixed(3)} s`,
  }));
}
