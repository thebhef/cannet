// Undo/redo over the Signal and RBS panels' host-owned edits — the
// fourth stack beside layout, elements and event links, interleaved
// with them by the same order log in `elementHistory.ts`.
//
// Pure: no React, no host, no DOM. A panel records a step (with the
// inverse it read *before* the write) and `App.tsx` applies the ops a
// restore hands back through the same Tauri commands that made them.
//
// **Steps, not snapshots** — the event-link stack's reasoning
// (`eventLinkHistory.ts`) holds here verbatim: each edit has an exact,
// tiny inverse (the previous decoder, the previous enable, the previous
// override), and a snapshot of host state the frontend doesn't own
// would be strictly more to hold and put back.

/// Bound on the stack, matching the other histories'.
export const PANEL_EDIT_HISTORY_CAP = 50;

/// One host write a panel can make, as the invoke it maps to. Fields
/// mirror the command args exactly, so applying an op is a dispatch and
/// nothing more.
export type PanelEditOp =
  /// `set_signal_dbc_pick` — the mapping panel's ambiguity pick
  /// (ADR 0054). The inverse is a pick of the previously-decoding
  /// database; `null` drops the recorded pick outright (the remap's
  /// cleanup of the name nothing references any more).
  | { kind: "pick"; signal: string; dbcPath: string | null }
  /// `rbs_set_enabled` — the RBS tree's enable at bus / ECU / message
  /// level (also how a bus is added). The inverse is the opposite flag.
  | {
      kind: "rbsEnable";
      elementId: string;
      bus: string;
      ecu: string | null;
      message: string | null;
      enabled: boolean;
    }
  // No op for `rbs_set_signal`, none: values are outside undo with no
  // exceptions (ADR 0058; owner ruling 2026-08-30). The chord is
  // global — an absent-minded Mod+Z must never be able to write an
  // override, so not even the dead-entry Drop records one.
  /// `rbs_set_period` — a message's period override (`periodMs`) or its
  /// clear (`null`, back to `GenMsgCycleTime`).
  | {
      kind: "rbsPeriod";
      elementId: string;
      target: { bus: string; ecu: string; message: string };
      periodMs: number | null;
    }
  /// The remap's one reach into the transmit pool: rename which signal
  /// the matching frames' calculated fields (counter / CRC) follow.
  /// Deliberately a *rename instruction*, never a frame snapshot — the
  /// restore reads the pool as it is then and rewrites only the calc
  /// target names, so no chord can carry payload bytes, modes or
  /// periods (ADR 0058: undo never writes what goes on the wire).
  | {
      kind: "transmitCalcRetarget";
      busId: string | null;
      messageId: number;
      extended: boolean;
      from: string;
      to: string;
    }
  /// The project-level signal-colour override (`null` clears) — the
  /// remap moves a colour with the rename, so its undo moves it back.
  | { kind: "signalColor"; key: string; color: string | null };

/// One user gesture's worth of edits: the ops that made it (`redo`) and
/// the ops that reverse it (`undo`), each applied in order as one unit —
/// a remap touches several stores but costs one chord.
export interface PanelEditStep {
  undo: readonly PanelEditOp[];
  redo: readonly PanelEditOp[];
}

export interface PanelEditHistory {
  past: readonly PanelEditStep[];
  future: readonly PanelEditStep[];
}

export const EMPTY_PANEL_EDIT_HISTORY: PanelEditHistory = { past: [], future: [] };

/// Note that a panel edit just happened. Like any undo record, a new
/// step clears the redo side.
export function recordPanelEdit(
  history: PanelEditHistory,
  step: PanelEditStep,
): PanelEditHistory {
  return { past: [...history.past, step].slice(-PANEL_EDIT_HISTORY_CAP), future: [] };
}

/// Step back: the ops to apply, and the history after it.
export function undoPanelEdit(
  history: PanelEditHistory,
): { history: PanelEditHistory; apply: readonly PanelEditOp[] } | null {
  const last = history.past[history.past.length - 1];
  if (last === undefined) return null;
  return {
    history: { past: history.past.slice(0, -1), future: [last, ...history.future] },
    apply: last.undo,
  };
}

/// Step forward: re-apply the edit exactly as it was made.
export function redoPanelEdit(
  history: PanelEditHistory,
): { history: PanelEditHistory; apply: readonly PanelEditOp[] } | null {
  const next = history.future[0];
  if (next === undefined) return null;
  return {
    history: { past: [...history.past, next], future: history.future.slice(1) },
    apply: next.redo,
  };
}
