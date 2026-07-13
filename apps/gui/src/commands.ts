// The command registry (ADR 0018): every palette-visible command, the
// shipped default binding map, the effective-binding resolution
// (defaults overlaid by the user's persisted customisation), and the
// boot-time binding-conflict assertion. Pure data + pure checks — the
// React wiring (handlers, dispatch, palette UI) lives in `App.tsx`;
// this module stays importable from tests and asserts its own
// consistency at import time, so a collision in the *defaults* fails
// the test suite and the app boot rather than reaching a user's
// keystroke.

import { parseChord, type ParsedBinding } from "./keybindings";

/// What kind of panel currently has dockview focus. Element-backed
/// panels report their element kind; the singletons report their
/// component name; `null` means no panel is focused.
export type FocusedPanelKind =
  | "trace"
  | "plot"
  | "transmit"
  | "rbs"
  | "project"
  | "project-graph"
  | "system-messages"
  | "dbc"
  | "settings"
  | "events"
  | "shortcuts";

/// The small, fixed context object command predicates range over
/// (ADR 0018) — deliberately not a general expression language.
export interface CommandContext {
  focusedPanelKind: FocusedPanelKind | null;
  hasProjectOpen: boolean;
  /// A view is currently maximized full-screen (dockview
  /// maximized-group). Gates the `Escape` binding so the key is only
  /// claimed while there's a full-screen state to exit.
  hasMaximizedView: boolean;
}

/// One registered command. `run` lives separately (the provider maps
/// ids to handlers) so this module stays pure data; a missing
/// `context` means always-available.
export interface CommandSpec {
  id: string;
  label: string;
  category?: string;
  context?: (ctx: CommandContext) => boolean;
}

/// One code-declared binding: chord syntax per `keybindings.ts`.
export interface BindingSpec {
  chord: string;
  commandId: string;
  /// Suppressed while a text-entry surface has focus (see
  /// `ParsedBinding.skipEditable`).
  skipEditable?: boolean;
}

const plotFocused = (ctx: CommandContext) => ctx.focusedPanelKind === "plot";

/// Every command the palette lists. Toolbar actions are lifted here
/// as a second access path — same handler, same behaviour.
export const COMMANDS: readonly CommandSpec[] = [
  { id: "project.open", label: "Open project…", category: "Project" },
  { id: "project.save", label: "Save project", category: "Project" },
  { id: "project.saveAs", label: "Save project as…", category: "Project" },
  {
    id: "project.close",
    label: "Close project",
    category: "Project",
    context: (ctx) => ctx.hasProjectOpen,
  },
  { id: "blf.open", label: "Open BLF…", category: "File" },
  { id: "dbc.add", label: "Add DBC…", category: "File" },
  { id: "connection.connect", label: "Connect", category: "Connection" },
  { id: "connection.disconnect", label: "Disconnect", category: "Connection" },
  { id: "capture.clear", label: "Clear capture", category: "Capture" },
  { id: "capture.save", label: "Save capture…", category: "Capture" },
  { id: "panel.add.trace", label: "Add trace panel", category: "Panels" },
  { id: "panel.add.plot", label: "Add plot panel", category: "Panels" },
  { id: "panel.add.transmit", label: "Add transmit panel", category: "Panels" },
  { id: "panel.add.rbs", label: "Add RBS panel", category: "Panels" },
  { id: "panel.add.colormap", label: "Add color map", category: "Panels" },
  { id: "project.saveAll", label: "Save all", category: "Project" },
  {
    id: "rbs.killSwitch",
    label: "RBS: toggle global kill-switch",
    category: "Panels",
  },
  { id: "panel.show.project", label: "Show project panel", category: "Panels" },
  { id: "panel.show.systemMessages", label: "Show system messages", category: "Panels" },
  { id: "panel.show.projectGraph", label: "Show project graph", category: "Panels" },
  { id: "panel.show.dbc", label: "Show DBC panel", category: "Panels" },
  { id: "panel.show.settings", label: "Show settings", category: "Panels" },
  { id: "panel.show.events", label: "Show events", category: "Panels" },
  { id: "panel.show.shortcuts", label: "Show keyboard shortcuts", category: "Panels" },
  { id: "panel.rename", label: "Rename panel…", category: "Panels" },
  { id: "app.exit", label: "Exit", category: "App" },
  { id: "palette.show", label: "Show command palette", category: "Palette" },
  { id: "goto.view", label: "Go to view…", category: "Palette" },
  { id: "goto.event", label: "Go to event…", category: "Palette" },
  { id: "view.back", label: "Previous view", category: "View" },
  { id: "view.forward", label: "Next view", category: "View" },
  { id: "view.close", label: "Close view", category: "View" },
  { id: "tab.next", label: "Next tab in group", category: "View" },
  { id: "tab.previous", label: "Previous tab in group", category: "View" },
  { id: "view.undo", label: "Undo view change", category: "View" },
  { id: "view.redo", label: "Redo view change", category: "View" },
  { id: "view.fullscreen", label: "Toggle full-screen view", category: "View" },
  {
    id: "view.exitFullscreen",
    label: "Exit full-screen view",
    category: "View",
    context: (ctx) => ctx.hasMaximizedView,
  },
  { id: "plot.fitXAxis", label: "Plot: fit x axis", category: "Plot", context: plotFocused },
  {
    id: "plot.followLive.enable",
    label: "Plot: follow live",
    category: "Plot",
    context: plotFocused,
  },
];

/// The shipped default binding map (ADR 0018). This is the seed: the
/// *effective* bindings the dispatcher runs are these overlaid by the
/// user's customisation (`resolveBindings`), which persists in
/// `settings.json`. Reset-to-default returns to exactly this list.
export const DEFAULT_BINDINGS: readonly BindingSpec[] = [
  { chord: "Mod+Shift+P", commandId: "palette.show" },
  { chord: "Mod+P", commandId: "goto.view" },
  { chord: "f", commandId: "plot.fitXAxis" },
  { chord: "l", commandId: "plot.followLive.enable" },
  // View navigation and layout undo/redo. The browser back/forward
  // chords skip editables (Alt+arrow is word-nav in mac text fields),
  // and undo/redo skips them so a focused input keeps its native
  // text undo. `view.redo` deliberately carries both conventional
  // chords.
  { chord: "Alt+ArrowLeft", commandId: "view.back", skipEditable: true },
  { chord: "Alt+ArrowRight", commandId: "view.forward", skipEditable: true },
  { chord: "Mod+w", commandId: "view.close" },
  { chord: "Ctrl+Tab", commandId: "tab.next" },
  { chord: "Ctrl+Shift+Tab", commandId: "tab.previous" },
  { chord: "Mod+z", commandId: "view.undo", skipEditable: true },
  { chord: "Mod+y", commandId: "view.redo", skipEditable: true },
  { chord: "Mod+Shift+Z", commandId: "view.redo", skipEditable: true },
  { chord: "Mod+Enter", commandId: "view.fullscreen" },
  // Plain Escape, but context-gated to `hasMaximizedView` — while
  // nothing is maximized the key passes through untouched (modals,
  // in-panel handlers), and the palette's own input suppresses
  // plain-key bindings anyway.
  { chord: "Escape", commandId: "view.exitFullscreen" },
];

/// Parse a binding list for the dispatcher / palette hints. Throws if
/// any chord is malformed — callers that accept untrusted (persisted /
/// user-entered) bindings must `sanitizeBindings` first.
export function parseBindings(bindings: readonly BindingSpec[]): ParsedBinding[] {
  return bindings.map((b) => ({
    chord: parseChord(b.chord),
    commandId: b.commandId,
    skipEditable: b.skipEditable,
  }));
}

/// Drop bindings that can't be trusted (ADR 0018): unknown command ids,
/// unparseable chords, and any that would collide with a
/// previously-accepted binding. Order-preserving and greedy — the first
/// binding to claim a chord/context keeps it. Used on load so a
/// hand-edited or stale `settings.json` can never brick dispatch or
/// smuggle in the keystroke ambiguity the framework forbids.
export function sanitizeBindings(
  bindings: readonly BindingSpec[],
  commands: readonly CommandSpec[],
): BindingSpec[] {
  const known = new Set(commands.map((c) => c.id));
  const accepted: BindingSpec[] = [];
  for (const b of bindings) {
    if (!known.has(b.commandId)) continue;
    try {
      parseChord(b.chord);
    } catch {
      continue;
    }
    if (findBindingConflicts(commands, [...accepted, b]).length > 0) continue;
    accepted.push(b);
  }
  return accepted;
}

/// The effective binding set: the user's customisation if present
/// (sanitised), else the shipped defaults. `null` — the default — means
/// "use `DEFAULT_BINDINGS`" (ADR 0018's whole-list storage: reset writes
/// `null`).
export function resolveBindings(
  user: readonly BindingSpec[] | null,
): readonly BindingSpec[] {
  if (user == null) return DEFAULT_BINDINGS;
  return sanitizeBindings(user, COMMANDS);
}

/// The outcome of an editor attempt to add a binding (ADR 0018).
export type BindingEditResult =
  | { ok: true; bindings: BindingSpec[] }
  | { ok: false; conflict: string };

/// Add `candidate` to `bindings`, refusing it if it would introduce a
/// keystroke collision (equal chord or prefix overlap) in an *overlapping*
/// context. This is the shortcuts editor's guard and the enforcement point
/// of the context-aware chord-reuse invariant (ADR 0037): a chord reused in
/// a disjoint context is accepted, an overlapping one is rejected with the
/// colliding binding named. Never persists an ambiguous map.
export function addBinding(
  bindings: readonly BindingSpec[],
  candidate: BindingSpec,
  commands: readonly CommandSpec[],
): BindingEditResult {
  const next = [...bindings, candidate];
  const conflicts = findBindingConflicts(commands, next);
  if (conflicts.length > 0) return { ok: false, conflict: conflicts[0] };
  return { ok: true, bindings: next };
}

/// The commands whose context predicate passes in `ctx` (the palette
/// listing and the dispatcher's gate share this).
export function commandsAvailableIn(
  commands: readonly CommandSpec[],
  ctx: CommandContext,
): CommandSpec[] {
  return commands.filter((c) => c.context == null || c.context(ctx));
}

/// Every value the context can take. The space is small and finite,
/// so "do two predicates overlap?" is decided by enumeration rather
/// than by restricting predicates to a declarative subset. This list
/// must stay complete — every `FocusedPanelKind` and context dimension —
/// or a genuinely-overlapping binding pair can look disjoint and slip
/// past the conflict check (ADR 0037, invariant 3).
function enumerateContexts(): CommandContext[] {
  const kinds: (FocusedPanelKind | null)[] = [
    null,
    "trace",
    "plot",
    "transmit",
    "rbs",
    "project",
    "project-graph",
    "system-messages",
    "dbc",
    "settings",
    "events",
    "shortcuts",
  ];
  const out: CommandContext[] = [];
  for (const focusedPanelKind of kinds) {
    for (const hasProjectOpen of [false, true]) {
      for (const hasMaximizedView of [false, true]) {
        out.push({ focusedPanelKind, hasProjectOpen, hasMaximizedView });
      }
    }
  }
  return out;
}

/// Find binding collisions: two commands reachable by the same
/// keystrokes (equal chords, or one chord a prefix of another) whose
/// context predicates overlap somewhere in the finite context space.
/// Returns human-readable descriptions; empty means conflict-free.
export function findBindingConflicts(
  commands: readonly CommandSpec[],
  bindings: readonly BindingSpec[],
): string[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const parsed = bindings.map((b) => ({ ...b, steps: parseChord(b.chord) }));
  const contexts = enumerateContexts();
  const conflicts: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i];
      const b = parsed[j];
      const [shorter, longer] = a.steps.length <= b.steps.length ? [a, b] : [b, a];
      const prefixes = shorter.steps.every((step, k) => {
        const other = longer.steps[k];
        // `Mod` and `Ctrl` are the same physical key on non-mac, so
        // `Mod+X` vs `Ctrl+X` is a collision there — compare the
        // merged control-ish set, which also covers exact equality.
        return (
          step.key === other.key &&
          (step.mod || step.ctrl) === (other.mod || other.ctrl) &&
          step.shift === other.shift &&
          step.alt === other.alt
        );
      });
      if (!prefixes) continue;
      const ca = byId.get(a.commandId)?.context;
      const cb = byId.get(b.commandId)?.context;
      const overlap = contexts.some(
        (ctx) => (ca == null || ca(ctx)) && (cb == null || cb(ctx)),
      );
      if (overlap) {
        conflicts.push(
          `"${a.chord}" (${a.commandId}) collides with "${b.chord}" (${b.commandId}) in overlapping contexts`,
        );
      }
    }
  }
  return conflicts;
}

// Boot-time conflict assertion (ADR 0018): importing this module with a
// colliding *default* binding map throws, so a collision in the shipped
// defaults fails the test suite and the app boot. User customisations are
// validated separately (at edit time and on load via `sanitizeBindings`),
// never at import.
{
  const conflicts = findBindingConflicts(COMMANDS, DEFAULT_BINDINGS);
  if (conflicts.length > 0) {
    throw new Error(`key-binding conflicts:\n${conflicts.join("\n")}`);
  }
}
