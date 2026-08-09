// Undo/redo over the project's *elements* — the second stack beside the
// dockview-layout stack in `viewHistory.ts`, plus the shared ordering
// that makes the two behave as one timeline.
//
// Pure: no React, no registry, no DOM. `App.tsx` feeds it the elements
// after every registry write and applies the patches a restore returns.
//
// The mask is where ADR 0050's boundary is enforced: a snapshot carries
// the allowlisted (display / organizational) fields only, so a restore
// has nothing to say about `rbs.run`, transmit config, or anything else
// that reaches the bus — not even if the snapshot were taken while such
// a field was changing.

import { valuesEqual } from "./projectElements";
import type { ProjectElement, ProjectElementKind } from "./types";

/// Bound on the stack, matching the layout history's. Enough to matter,
/// small enough that a long-running session can't accumulate
/// unboundedly.
const HISTORY_CAP = 50;

/// Bound on the interleaving log. Two stacks, each capped at
/// [`HISTORY_CAP`], so this can only be reached by entries that outlive
/// the steps they name.
const ORDER_CAP = 2 * HISTORY_CAP;

/// The undoable fields of each element kind — ADR 0050's allowlist in
/// code. `name` is undoable for every kind (a rename is display state)
/// and is carried separately; everything not named here is out, so a
/// field added to an element kind later is outside undo until someone
/// adds it. `transmit` and `rbs` list nothing: their whole payload
/// (sinks / messages, path / run flag) is bus state.
const UNDOABLE_FIELDS: Record<ProjectElementKind, readonly string[]> = {
  trace: ["sources", "config"],
  plot: ["sources", "config"],
  signals: ["sources", "config"],
  filter: ["sources", "predicate"],
  colormap: ["busId", "messageId", "extended", "signalName", "rules"],
  generator: ["rules"],
  transmit: [],
  rbs: [],
};

/// One element reduced to its undoable fields. `id` and `kind` identify
/// it (both are immutable for the element's lifetime); the rest is
/// whatever [`UNDOABLE_FIELDS`] allows, plus `name`.
export interface MaskedElement {
  id: string;
  kind: ProjectElementKind;
  [field: string]: unknown;
}

/// The undoable state of the whole element set, in registry order.
export type ElementSnapshot = readonly MaskedElement[];

/// Bounded undo/redo over element snapshots. `present` is always the
/// latest snapshot, whether it arrived as an edit ([`recordElements`])
/// or as churn nobody claimed ([`syncElements`]).
export interface ElementHistory {
  past: readonly ElementSnapshot[];
  present: ElementSnapshot;
  future: readonly ElementSnapshot[];
}

export function maskElement(element: ProjectElement): MaskedElement {
  const source = element as unknown as Record<string, unknown>;
  const masked: MaskedElement = {
    id: element.id,
    kind: element.kind,
    name: element.name,
  };
  for (const field of UNDOABLE_FIELDS[element.kind]) masked[field] = source[field];
  return masked;
}

export function maskElements(elements: readonly ProjectElement[]): ElementSnapshot {
  return elements.map(maskElement);
}

export function initElementHistory(elements: readonly ProjectElement[]): ElementHistory {
  return { past: [], present: maskElements(elements), future: [] };
}

/// Record the elements after a *user edit*. A masked difference pushes
/// the previous present onto the undo stack (and clears redo); a change
/// confined to excluded fields, or one that only seeds a panel's first
/// config, just replaces present — so it rides along with the current
/// step instead of becoming one.
export function recordElements(
  h: ElementHistory,
  elements: readonly ProjectElement[],
): ElementHistory {
  const next = maskElements(elements);
  if (snapshotsEqual(next, h.present) || isConfigSeed(h.present, next)) {
    return { ...h, present: next };
  }
  return { past: [...h.past, h.present].slice(-HISTORY_CAP), present: next, future: [] };
}

/// Follow a registry change that was *not* a user edit — an element
/// created, a project opened, session state re-anchored. Present keeps
/// up (so the next edit steps back to what is really there) without
/// making a step or disturbing the redo future.
export function syncElements(
  h: ElementHistory,
  elements: readonly ProjectElement[],
): ElementHistory {
  const next = maskElements(elements);
  return snapshotsEqual(next, h.present) ? h : { ...h, present: next };
}

export function undoElements(
  h: ElementHistory,
): { history: ElementHistory; snapshot: ElementSnapshot } | null {
  if (h.past.length === 0) return null;
  const snapshot = h.past[h.past.length - 1];
  return {
    history: { past: h.past.slice(0, -1), present: snapshot, future: [h.present, ...h.future] },
    snapshot,
  };
}

export function redoElements(
  h: ElementHistory,
): { history: ElementHistory; snapshot: ElementSnapshot } | null {
  if (h.future.length === 0) return null;
  const snapshot = h.future[0];
  return {
    history: { past: [...h.past, h.present], present: snapshot, future: h.future.slice(1) },
    snapshot,
  };
}

/// One element's share of a restore: the registry patch that moves it
/// back to the snapshot. Only allowlisted fields appear — the second
/// enforcement of ADR 0050's boundary, after the mask itself.
export interface ElementRestore {
  id: string;
  patch: Partial<ProjectElement>;
}

/// The patches that move `current` back to `target`. Elements the
/// snapshot doesn't know about are left alone, and so are ones it knows
/// about that no longer exist — re-creating a removed element is not
/// this stack's job (it needs the element's panel and runtime state
/// back too).
export function restorePatches(
  target: ElementSnapshot,
  current: readonly ProjectElement[],
): ElementRestore[] {
  const out: ElementRestore[] = [];
  for (const want of target) {
    const live = current.find((e) => e.id === want.id);
    if (!live || live.kind !== want.kind) continue;
    const have = maskElement(live);
    const patch: Record<string, unknown> = {};
    for (const field of Object.keys(want)) {
      if (field === "id" || field === "kind") continue;
      if (!valuesEqual(have[field], want[field])) patch[field] = want[field];
    }
    if (Object.keys(patch).length > 0) {
      out.push({ id: want.id, patch: patch as Partial<ProjectElement> });
    }
  }
  return out;
}

function snapshotsEqual(a: ElementSnapshot, b: ElementSnapshot): boolean {
  return a.length === b.length && a.every((el, i) => valuesEqual(el, b[i]));
}

/// True when the only difference is one or more elements acquiring their
/// *first* `config` blob. Every element-backed panel persists its view
/// config the moment it mounts, so a freshly added panel writes a config
/// where the element had none; that write is the panel seeding itself,
/// not something the user asked for, and it must not cost an undo step
/// of its own. A later config change is a real edit — the element has a
/// config by then.
function isConfigSeed(prev: ElementSnapshot, next: ElementSnapshot): boolean {
  if (prev.length !== next.length) return false;
  let seeded = false;
  for (let i = 0; i < prev.length; i++) {
    const before = prev[i];
    const after = next[i];
    if (before.id !== after.id) return false;
    if (valuesEqual(before, after)) continue;
    if (before.config !== undefined || after.config === undefined) return false;
    if (!equalExceptConfig(before, after)) return false;
    seeded = true;
  }
  return seeded;
}

function equalExceptConfig(a: MaskedElement, b: MaskedElement): boolean {
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  fields.delete("config");
  return [...fields].every((f) => valuesEqual(a[f], b[f]));
}

// --- interleaving the two stacks ---

/// Which stack a step lives on. The two are recorded and replayed
/// through one log so a chord always reverses the most recent change,
/// whichever kind it was.
export type UndoStack = "layout" | "element";

/// One entry in the order log: the stacks a single user gesture stepped,
/// in the order they stepped. Most gestures touch one stack; the ones
/// that span both (removing an element closes its panel too) are tagged
/// with a `gesture` id at record time and land here as one entry, so a
/// chord reverses the whole gesture.
export interface UndoEntry {
  stacks: readonly UndoStack[];
  gesture?: number;
}

/// The order steps were taken in, with the undone ones on the `future`
/// side. Holds no snapshots — each stack keeps its own.
export interface UndoOrder {
  past: readonly UndoEntry[];
  future: readonly UndoEntry[];
}

export const EMPTY_UNDO_ORDER: UndoOrder = { past: [], future: [] };

/// Note that `stack` just took a step. `gesture` (when given) joins it
/// to the entry the same gesture already opened, so a gesture spanning
/// both stacks costs one chord rather than two. Like any undo record, a
/// new step clears the redo side.
export function recordStep(
  order: UndoOrder,
  stack: UndoStack,
  gesture?: number,
): UndoOrder {
  const last = order.past[order.past.length - 1];
  if (gesture !== undefined && last?.gesture === gesture) {
    // Only the newest entry can still be open: an older one has a step
    // in between, and one already undone is on the redo side.
    const stacks = last.stacks.includes(stack) ? last.stacks : [...last.stacks, stack];
    return { past: [...order.past.slice(0, -1), { stacks, gesture }], future: [] };
  }
  return { past: [...order.past, { stacks: [stack], gesture }].slice(-ORDER_CAP), future: [] };
}

/// The entry to undo next: the most recent one with a stack that still
/// has something to undo. `canUndo` is what skips an entry whose steps
/// have since been dropped at their stack's cap — such an entry is left
/// in place (it can never become undoable again, and removing it would
/// reorder the log for no gain).
export function popUndo(
  order: UndoOrder,
  canUndo: (stack: UndoStack) => boolean,
): { order: UndoOrder; stacks: readonly UndoStack[] } | null {
  for (let i = order.past.length - 1; i >= 0; i--) {
    const entry = order.past[i];
    if (!entry.stacks.some(canUndo)) continue;
    return {
      order: {
        past: [...order.past.slice(0, i), ...order.past.slice(i + 1)],
        future: [entry, ...order.future],
      },
      stacks: entry.stacks,
    };
  }
  return null;
}

/// The mirror of [`popUndo`]: the oldest-undone entry whose stacks can
/// still redo.
export function popRedo(
  order: UndoOrder,
  canRedo: (stack: UndoStack) => boolean,
): { order: UndoOrder; stacks: readonly UndoStack[] } | null {
  for (let i = 0; i < order.future.length; i++) {
    const entry = order.future[i];
    if (!entry.stacks.some(canRedo)) continue;
    return {
      order: {
        past: [...order.past, entry],
        future: [...order.future.slice(0, i), ...order.future.slice(i + 1)],
      },
      stacks: entry.stacks,
    };
  }
  return null;
}
