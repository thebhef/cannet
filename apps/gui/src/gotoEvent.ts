// Cross-panel "goto" bus (ADR 0035): the events view broadcasts a timeline
// jump and every trace / plot panel re-centres on it. It is ephemeral view
// state — a panel telling its siblings where to look — so it rides a
// frontend-only Tauri event rather than the host note store. The payload is
// the event's absolute frame timestamp in nanoseconds; each listener resolves
// it against its own timing model, all sharing the one origin (ADR 0024).

/// The frontend event name carrying a goto request.
export const GOTO_EVENT = "goto-event";

/// The goto payload: the target's absolute timestamp, nanoseconds.
export type GotoPayload = number;
