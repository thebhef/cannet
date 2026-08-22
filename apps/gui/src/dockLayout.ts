import type { DockviewApi, SerializedDockview } from "dockview";

import type { ProjectElementKind } from "./types";
import type { FocusedPanelKind } from "./commands";

/**
 * Names the panel React components are registered under in the dockview
 * `components` map. Stored verbatim inside the serialized layout, so
 * changing them would orphan saved layouts — treat as stable.
 */
export const TRACE_PANEL_COMPONENT = "trace";
export const BY_ID_PANEL_COMPONENT = "by-id";
export const PROJECT_PANEL_COMPONENT = "project";
export const PLOT_PANEL_COMPONENT = "plot";
/// The signal view panel (latest-per-signal snapshot). Element-backed,
/// like trace/plot.
export const SIGNALS_PANEL_COMPONENT = "signals";
export const TRANSMIT_PANEL_COMPONENT = "transmit";
/// Spatial / wiring view onto the project state. Distinct
/// from the list-oriented `PROJECT_PANEL_COMPONENT`.
export const PROJECT_GRAPH_PANEL_COMPONENT = "project-graph";
/// Host-side log bus surface. Multiple are allowed (each
/// carries its own source / min-level filter in `params`).
export const SYSTEM_MESSAGES_PANEL_COMPONENT = "system-messages";
/// Database panel: tree-with-fuzzy-search over every signal-defining
/// artifact the session holds — each loaded DBC's messages → signals,
/// and each capture file's own signal channel groups (ADR 0052).
/// Singleton (same pattern as the project, graph, and system-messages
/// panels) — both catalogs live on the host and there's no per-panel
/// differentiation worth having. Search query + expand state still
/// live in panel `params` so a layout save / restore preserves them.
export const DBC_PANEL_COMPONENT = "dbc";
/// View-signals panel: every signal the open views reference, live,
/// and what currently decodes it. Singleton, same pattern as the
/// Database panel — the model is project-wide, so a
/// second instance would carry no differentiation.
export const VIEW_SIGNALS_PANEL_COMPONENT = "view-signals";
/// Rest-of-bus-simulation panel (ADR 0028). Element-backed —
/// multiple named RBS elements per project are allowed, each
/// referencing its own `.cannet_rbs` file.
export const RBS_PANEL_COMPONENT = "rbs";
/// The RBS signals grid: every field one `.cannet_rbs` config
/// transmits, scoped to a single RBS element — the opposite scoping
/// rule from `VIEW_SIGNALS_PANEL_COMPONENT`
/// (which combines every view). Not the element's *own* panel the way
/// `RBS_PANEL_COMPONENT` is: it's a second panel referencing the same
/// element id, opened from a button inside the RBS panel rather than
/// through `elementPanelComponent`, and more than one may exist per
/// element (opened, closed, reopened) — see `rbsSignalsPanelId`.
export const RBS_SIGNALS_PANEL_COMPONENT = "rbs-signals";
/// The dockview panel id prefix for an RBS signals panel — see
/// `rbsSignalsPanelId`.
const RBS_SIGNALS_PANEL_ID_PREFIX = "rbs-signals-";
/// Signal value→color map config panel (ADR 0029). Element-backed,
/// like RBS — each colormap element opens into its own editor panel.
export const COLORMAP_PANEL_COMPONENT = "colormap";
/// Signal-name generator rules editor (ADR 0026). Element-backed, like
/// the colormap — each generator element opens into its own editor.
export const GENERATOR_PANEL_COMPONENT = "generator";
/// User-settings editor over the host's `settings.json` (ADR 0034).
/// Singleton (same pattern as the project / graph / system-messages /
/// Database panels) — settings are app-global, so one instance suffices.
export const SETTINGS_PANEL_COMPONENT = "settings";
/// Read-only About view — a singleton panel holding the build version
/// and the bundled third-party license notices (ADR 0036).
export const ABOUT_PANEL_COMPONENT = "about";
/// The timeline-events view (ADR 0035) — a singleton panel.
export const EVENTS_PANEL_COMPONENT = "events";
/// The bus health view — a singleton panel holding the low-level
/// state of every logical bus. Opened from the status bar's health
/// launcher (ADR 0055) as well as the command palette.
export const BUS_HEALTH_PANEL_COMPONENT = "bus-health";
/// The keyboard-shortcuts editor (ADR 0018) — a singleton panel that
/// lists and rebinds every command.
export const SHORTCUTS_PANEL_COMPONENT = "shortcuts";
/// The server list (ADR 0041) — a singleton panel holding this
/// machine's trust decisions and what is advertising on the network.
export const SERVERS_PANEL_COMPONENT = "servers";
/// Singleton id — toolbar's "Database panel" button uses this to
/// show-or-focus a single instance.
export const DBC_PANEL_ID = "dbc";

/// The view-signals panel is a singleton too — one project-wide
/// instance, opened from the toolbar and the command palette.
export const VIEW_SIGNALS_PANEL_ID = "view-signals";

/// The project graph is a singleton panel — one per project — so it
/// gets a fixed id rather than one keyed on an element.
export const PROJECT_GRAPH_PANEL_ID = "project-graph";

/// The project / system-messages panels are singletons too — fixed
/// dockview ids so the toolbar button can find the one instance,
/// focus it, or add it on first click.
export const PROJECT_PANEL_ID = "project";
export const SYSTEM_MESSAGES_PANEL_ID = "system-messages";

/// The settings panel is a singleton too — one app-global instance,
/// opened from the command palette.
export const SETTINGS_PANEL_ID = "settings";

/// The About panel is a singleton too — one app-global instance,
/// opened from the command palette.
export const ABOUT_PANEL_ID = "about";

/// The timeline-events panel (ADR 0035) is a singleton — one app-global
/// instance, opened from the command palette.
export const EVENTS_PANEL_ID = "events";

/// The bus health panel is a singleton: bus health is a property of
/// the session, not of any one view, and the status bar's launcher
/// has exactly one panel to open (ADR 0055).
export const BUS_HEALTH_PANEL_ID = "bus-health";

/// The keyboard-shortcuts editor (ADR 0018) is a singleton — one
/// app-global instance, opened from the command palette.
export const SHORTCUTS_PANEL_ID = "shortcuts";

/// The server list is a singleton too: trusting a server is a decision
/// this machine makes once (ADR 0041), not a per-project one, so there
/// is one instance and it is opened from the command palette.
export const SERVERS_PANEL_ID = "servers";

/// The tab title of every singleton panel, keyed by its fixed dockview
/// id. A singleton's title is code-defined — it carries no model-owned
/// name the way an element-backed panel does (ADR 0019) and cannot be
/// renamed — so this table is the only place any of them is spelled,
/// and it is what a restored layout is normalized against
/// (see [`normalizeSingletonTitles`]).
export const SINGLETON_PANEL_TITLES: Readonly<Record<string, string>> = {
  [PROJECT_PANEL_ID]: "Project",
  [PROJECT_GRAPH_PANEL_ID]: "Graph",
  [SYSTEM_MESSAGES_PANEL_ID]: "System messages",
  [DBC_PANEL_ID]: "Database",
  [VIEW_SIGNALS_PANEL_ID]: "View signals",
  [SETTINGS_PANEL_ID]: "Settings",
  [ABOUT_PANEL_ID]: "About",
  [EVENTS_PANEL_ID]: "Events",
  [BUS_HEALTH_PANEL_ID]: "Bus health",
  [SHORTCUTS_PANEL_ID]: "Keyboard shortcuts",
  [SERVERS_PANEL_ID]: "Servers",
};

/**
 * Retitle every singleton panel in a serialized layout to its current
 * code-defined title, leaving every other panel untouched.
 *
 * Dockview titles a restored panel from the blob, so a workspace saved
 * before a panel was renamed keeps showing the old name on its tab
 * forever. A singleton's title is not state — it is a constant of the
 * build — so restoring one from persisted data is wrong on its face;
 * every restore path runs the saved layout through here and existing
 * workspaces heal on their next open. Element-backed titles are the
 * opposite case (a model-owned name, ADR 0019) and are left alone.
 */
export function normalizeSingletonTitles(layout: SerializedDockview): SerializedDockview {
  let changed = false;
  const panels: SerializedDockview["panels"] = {};
  for (const [id, panel] of Object.entries(layout.panels ?? {})) {
    const title = SINGLETON_PANEL_TITLES[id];
    if (title !== undefined && panel.title !== title) {
      panels[id] = { ...panel, title };
      changed = true;
    } else {
      panels[id] = panel;
    }
  }
  return changed ? { ...layout, panels } : layout;
}

/// Show-or-focus the Servers panel: bring the one instance forward if
/// it is open, otherwise add it. One implementation for both ways in —
/// the `panel.show.servers` command and the bus row's "Manage
/// servers…" — so a bus row cannot open a second copy of a singleton.
export function showServersPanel(api: DockviewApi): void {
  const existing = api.panels.find((p) => p.id === SERVERS_PANEL_ID);
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id: SERVERS_PANEL_ID,
    component: SERVERS_PANEL_COMPONENT,
    title: "Servers",
  });
}

/// The RBS signals panel's dockview id for one element — one instance
/// per element, same "no second copy" reasoning a singleton uses, just
/// keyed by element instead of fixed.
function rbsSignalsPanelId(elementId: string): string {
  return `${RBS_SIGNALS_PANEL_ID_PREFIX}${elementId}`;
}

/// The tab title for an element-backed panel — the model-owned name
/// (ADR 0019) verbatim, except an RBS signals panel names *what it is*
/// too ("the config is named in the panel title"): the app's internal
/// word "element" never appears, so this reads
/// "‹config name› — Signals" rather than repeating the RBS panel's own
/// bare title.
export function elementPanelTitle(panelId: string, elementLabel: string): string {
  return panelId.startsWith(RBS_SIGNALS_PANEL_ID_PREFIX) ? `${elementLabel} — Signals` : elementLabel;
}

/// Show-or-focus one element's RBS signals panel.
export function showRbsSignalsPanel(api: DockviewApi, elementId: string, elementLabel: string): void {
  const id = rbsSignalsPanelId(elementId);
  const existing = api.panels.find((p) => p.id === id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id,
    component: RBS_SIGNALS_PANEL_COMPONENT,
    title: elementPanelTitle(id, elementLabel),
    params: { elementId },
  });
}

/// What `CommandContext.focusedPanelKind` should report for the
/// active dockview panel: element-backed panels report their element
/// kind (resolved by the caller from `params.elementId`), the
/// singletons report their fixed id, anything else is `null`. A
/// `filter` has no panel of its own, so it can never be the focused
/// kind.
export function panelKindForFocus(
  panelId: string,
  elementKind: ProjectElementKind | null,
): FocusedPanelKind | null {
  // Checked before the `elementKind` branch below: an RBS signals
  // panel's params carry the *same* elementId as the RBS element's own
  // panel (it's a second panel over one element, not a second element),
  // so `elementKind` alone can't tell the two apart — only the panel id
  // can. Reporting "rbs" here would make `panel.find` / `panel.rename`
  // available while this panel is focused and route them at the *other*
  // panel's registration (`panelCommands.ts` keys by elementId).
  if (panelId.startsWith(RBS_SIGNALS_PANEL_ID_PREFIX)) return "rbs-signals";
  if (
    elementKind === "trace" ||
    elementKind === "plot" ||
    elementKind === "signals" ||
    elementKind === "transmit" ||
    elementKind === "rbs" ||
    elementKind === "colormap" ||
    elementKind === "generator"
  ) {
    return elementKind;
  }
  if (elementKind != null) return null;
  switch (panelId) {
    case PROJECT_PANEL_ID:
      return "project";
    case SYSTEM_MESSAGES_PANEL_ID:
      return "system-messages";
    case PROJECT_GRAPH_PANEL_ID:
      return "project-graph";
    case DBC_PANEL_ID:
      return "dbc";
    case VIEW_SIGNALS_PANEL_ID:
      return "view-signals";
    case SETTINGS_PANEL_ID:
      return "settings";
    case ABOUT_PANEL_ID:
      return "about";
    case EVENTS_PANEL_ID:
      return "events";
    case BUS_HEALTH_PANEL_ID:
      return "bus-health";
    case SHORTCUTS_PANEL_ID:
      return "shortcuts";
    case SERVERS_PANEL_ID:
      return "servers";
    default:
      return null;
  }
}

/// Every dockview panel whose params name `elementId` — usually one,
/// but an RBS element can have two (its own panel and its signals
/// grid): a caller closing an element's panels must iterate every
/// match, not stop at the first (the bug this function was extracted
/// to fix — `removeElement` in `App.tsx` used to `.find` and leaked
/// the second panel).
export function panelsForElementId<P extends { params?: unknown }>(
  panels: readonly P[],
  elementId: string,
): P[] {
  return panels.filter(
    (p) => (p.params as { elementId?: unknown } | undefined)?.elementId === elementId,
  );
}

/// The dockview component a project element opens into as its own
/// panel, or `null` for a kind that has no panel of its own.
///
/// A `filter` is edited inline on its node in the project graph; it
/// must return `null` here. Returning a trace/plot component would let
/// "Open" mount a panel whose `ensure(id, kind)` then retypes — and
/// destroys — the filter element.
export function elementPanelComponent(kind: ProjectElementKind): string | null {
  switch (kind) {
    case "trace":
      return TRACE_PANEL_COMPONENT;
    case "plot":
      return PLOT_PANEL_COMPONENT;
    case "signals":
      return SIGNALS_PANEL_COMPONENT;
    case "transmit":
      return TRANSMIT_PANEL_COMPONENT;
    case "rbs":
      return RBS_PANEL_COMPONENT;
    case "colormap":
      return COLORMAP_PANEL_COMPONENT;
    case "generator":
      return GENERATOR_PANEL_COMPONENT;
    case "filter":
      return null;
  }
}

/**
 * Is this press a middle-button press on a dockview tab (`.dv-tab`)?
 * Middle-clicking a tab closes the view (dockview default-tab
 * behaviour, on pointer-up) — but middle-button autoscroll is the
 * browser's `mousedown` default action and engages first, so the
 * app cancels the default exactly for these presses.
 */
export function isTabMiddlePress(button: number, target: EventTarget | null): boolean {
  return button === 1 && target instanceof Element && target.closest(".dv-tab") !== null;
}

/**
 * Drop the maximized-view marker from a serialized layout. Dockview's
 * `toJSON` records a maximized group as `grid.maximizedNode` (untyped
 * in `SerializedDockview`), which would make the persisted layout, a
 * saved project, or an undo snapshot reopen full-screen. Full-screen
 * is a transient view mode, so every persistence path strips it.
 */
export function stripMaximizedNode(layout: SerializedDockview): SerializedDockview {
  if (!("maximizedNode" in layout.grid)) return layout;
  const grid = { ...layout.grid } as SerializedDockview["grid"] & {
    maximizedNode?: unknown;
  };
  delete grid.maximizedNode;
  return { ...layout, grid };
}

/**
 * Sanity-check an already-parsed value as a dockview layout. Returns
 * `null` for anything structurally unrecognised so a corrupt blob
 * falls back to the default layout instead of bricking startup. The
 * check is deliberately shallow — dockview's own deserializer validates
 * the rest, and a mismatched-but-plausible blob fails loudly there.
 */
export function validateLayout(parsed: unknown): SerializedDockview | null {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("grid" in parsed) ||
    !("panels" in parsed)
  ) {
    return null;
  }
  return parsed as SerializedDockview;
}
