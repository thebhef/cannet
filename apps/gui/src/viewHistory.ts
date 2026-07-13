// View navigation history and layout undo/redo (ADR 0018's command
// framework provides the keys; this module provides the state).
// Pure: no DOM, no dockview — `App.tsx` feeds it panel-focus events
// and serialized layouts and applies what it returns.
//
// Two independent stacks by design: moving focus between views is
// *navigation* (back/forward, like a browser), not a change to undo;
// closing / adding / moving panels is a *mutation* (undo/redo).

/// Bound on both stacks. Enough to matter, small enough that a
/// long-running session can't accumulate unboundedly.
const HISTORY_CAP = 50;

// --- focus navigation (previous / next view) ---

/// The sequence of focused panel ids with a cursor. `index` points at
/// the current panel; entries above it are the "forward" side.
export interface FocusHistory {
  stack: readonly string[];
  index: number;
}

export const EMPTY_FOCUS_HISTORY: FocusHistory = { stack: [], index: -1 };

/// Record a panel gaining focus. A re-focus of the current entry is a
/// no-op — this is what keeps programmatic back/forward jumps (whose
/// focus events echo back here) from re-recording themselves.
export function recordFocus(h: FocusHistory, panelId: string): FocusHistory {
  if (h.stack[h.index] === panelId) return h;
  const stack = [...h.stack.slice(0, h.index + 1), panelId].slice(-HISTORY_CAP);
  return { stack, index: stack.length - 1 };
}

/// Step the cursor backward (`dir` -1) or forward (+1) to the nearest
/// entry whose panel is still open, skipping since-closed ones.
/// Returns the moved history plus the panel to focus, or `null` when
/// there's nothing to navigate to.
export function navigateFocus(
  h: FocusHistory,
  dir: -1 | 1,
  isOpen: (panelId: string) => boolean,
): { history: FocusHistory; panelId: string } | null {
  for (let i = h.index + dir; i >= 0 && i < h.stack.length; i += dir) {
    if (isOpen(h.stack[i])) {
      return { history: { stack: h.stack, index: i }, panelId: h.stack[i] };
    }
  }
  return null;
}

// --- layout undo/redo ---

/// Bounded undo/redo over serialized dockview layouts (JSON text).
/// `present` is always the latest layout as saved by the host.
export interface LayoutHistory {
  past: readonly string[];
  present: string;
  future: readonly string[];
}

export function initLayoutHistory(layout: string): LayoutHistory {
  return { past: [], present: layout, future: [] };
}

/// Keys scrubbed before comparing two layouts: focus (`activeView` /
/// `activeGroup`), geometry (`size` / `width` / `height` / floating
/// `position`), the transient full-screen marker (`maximizedNode`),
/// per-panel view state (`params`), and display names (`title`).
/// What's left — the tree of groups and their panel ids — changes
/// exactly when a panel is added, closed, or moved, so only those
/// become undo steps; focus flips, sash drags, window resizes,
/// maximizing, and in-panel state (a search box) never do.
const SCRUBBED_KEYS = new Set([
  "activeView",
  "activeGroup",
  "size",
  "width",
  "height",
  "position",
  "maximizedNode",
  "params",
  "title",
]);

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // Sorted keys: after `fromJSON` dockview re-serializes records
    // (e.g. `panels`) in rebuilt-group order, so key order varies for
    // the same layout. Array order stays — tab and grid-tree order is
    // real structure.
    for (const k of Object.keys(record).sort()) {
      if (SCRUBBED_KEYS.has(k)) continue;
      out[k] = scrub(record[k]);
    }
    return out;
  }
  return value;
}

/// The structural fingerprint two layouts are compared by.
export function structuralKey(layoutJson: string): string {
  return JSON.stringify(scrub(JSON.parse(layoutJson)));
}

/// Record the layout after a change. A structural change pushes the
/// previous present onto the undo stack (and clears redo); anything
/// else just replaces present, so the newest focus / geometry / params
/// ride along with the current step instead of becoming steps.
export function recordLayout(h: LayoutHistory, layout: string): LayoutHistory {
  if (structuralKey(layout) === structuralKey(h.present)) {
    return { ...h, present: layout };
  }
  return {
    past: [...h.past, h.present].slice(-HISTORY_CAP),
    present: layout,
    future: [],
  };
}

export function undoLayout(
  h: LayoutHistory,
): { history: LayoutHistory; layout: string } | null {
  if (h.past.length === 0) return null;
  const layout = h.past[h.past.length - 1];
  return {
    history: {
      past: h.past.slice(0, -1),
      present: layout,
      future: [h.present, ...h.future],
    },
    layout,
  };
}

export function redoLayout(
  h: LayoutHistory,
): { history: LayoutHistory; layout: string } | null {
  if (h.future.length === 0) return null;
  const layout = h.future[0];
  return {
    history: {
      past: [...h.past, h.present],
      present: layout,
      future: h.future.slice(1),
    },
    layout,
  };
}
