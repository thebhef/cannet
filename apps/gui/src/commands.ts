// The command registry (ADR 0018): every palette-visible command,
// the code-declared binding map, and the boot-time binding-conflict
// assertion. Pure data + pure checks — the React wiring (handlers,
// dispatch, palette UI) lives in `CommandsProvider.tsx`; this module
// stays importable from tests and asserts its own consistency at
// import time, so a binding collision fails the test suite and the
// app boot rather than reaching a user's keystroke.

import { parseChord } from "./keybindings";

/// What kind of panel currently has dockview focus. Element-backed
/// panels report their element kind; the singletons report their
/// component name; `null` means no panel is focused.
export type FocusedPanelKind =
  | "trace"
  | "plot"
  | "transmit"
  | "project"
  | "project-graph"
  | "system-messages"
  | "dbc";

/// The small, fixed context object command predicates range over
/// (ADR 0018) — deliberately not a general expression language.
export interface CommandContext {
  focusedPanelKind: FocusedPanelKind | null;
  hasProjectOpen: boolean;
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
}

const plotFocused = (ctx: CommandContext) => ctx.focusedPanelKind === "plot";

/// Every command the palette lists. Toolbar actions are lifted here
/// as a second access path — same handler, same behaviour.
export const COMMANDS: readonly CommandSpec[] = [
  { id: "project.open", label: "Open project…", category: "Project" },
  { id: "project.save", label: "Save project", category: "Project" },
  { id: "project.saveAs", label: "Save project as…", category: "Project" },
  { id: "project.close", label: "Close project", category: "Project" },
  { id: "blf.open", label: "Open BLF…", category: "File" },
  { id: "dbc.add", label: "Add DBC…", category: "File" },
  { id: "connection.connect", label: "Connect", category: "Connection" },
  { id: "connection.disconnect", label: "Disconnect", category: "Connection" },
  { id: "panel.add.trace", label: "Add trace panel", category: "Panels" },
  { id: "panel.add.plot", label: "Add plot panel", category: "Panels" },
  { id: "panel.add.transmit", label: "Add transmit panel", category: "Panels" },
  { id: "panel.show.systemMessages", label: "Show system messages", category: "Panels" },
  { id: "panel.show.projectGraph", label: "Show project graph", category: "Panels" },
  { id: "panel.show.dbc", label: "Show DBC panel", category: "Panels" },
  { id: "panel.rename", label: "Rename panel…", category: "Panels" },
  { id: "palette.show", label: "Show command palette", category: "Palette" },
  { id: "goto.view", label: "Go to view…", category: "Palette" },
  { id: "plot.fitXAxis", label: "Plot: fit x axis", category: "Plot", context: plotFocused },
  {
    id: "plot.followLive.enable",
    label: "Plot: follow live",
    category: "Plot",
    context: plotFocused,
  },
];

/// The binding map. Code-declared only — user customisation is an
/// explicit non-goal here (ADR 0018).
export const BINDINGS: readonly BindingSpec[] = [
  { chord: "Mod+Shift+P", commandId: "palette.show" },
  { chord: "Mod+P", commandId: "goto.view" },
  { chord: "f", commandId: "plot.fitXAxis" },
  { chord: "l", commandId: "plot.followLive.enable" },
];

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
/// than by restricting predicates to a declarative subset.
function enumerateContexts(): CommandContext[] {
  const kinds: (FocusedPanelKind | null)[] = [
    null,
    "trace",
    "plot",
    "transmit",
    "project",
    "project-graph",
    "system-messages",
    "dbc",
  ];
  const out: CommandContext[] = [];
  for (const focusedPanelKind of kinds) {
    for (const hasProjectOpen of [false, true]) {
      out.push({ focusedPanelKind, hasProjectOpen });
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
        return (
          step.key === other.key &&
          step.mod === other.mod &&
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

// Boot-time conflict assertion (ADR 0018): importing this module
// with a colliding binding map throws, so the collision fails the
// test suite and the app boot, never a user's keystroke.
{
  const conflicts = findBindingConflicts(COMMANDS, BINDINGS);
  if (conflicts.length > 0) {
    throw new Error(`key-binding conflicts:\n${conflicts.join("\n")}`);
  }
}
