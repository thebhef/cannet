// Phase 9 — session-scoped notes (event annotations placed by the
// plot panel's `+ note` cursor). The host owns the canonical list
// (`apps/gui/src-tauri/src/notes.rs`); this module is the pure-TS
// helpers + types every consumer (the PlotPanel hook, App.tsx, the
// unit tests) shares.

/// One note as the host serialises it. `timestampNs` is the
/// absolute trace timestamp (`RawTraceFrame::timestamp_ns`); the
/// plot panel converts to/from display-relative seconds against
/// the trace's window start.
export interface Note {
  id: string;
  /** Absolute ns on the trace timeline. Camel-cased on the wire
   *  per Tauri's default rename. */
  timestampNs: number;
  label: string;
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
