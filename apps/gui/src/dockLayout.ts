import type { SerializedDockview } from "dockview";

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
export const TRANSMIT_PANEL_COMPONENT = "transmit";
/// Spatial / wiring view onto the project state. Distinct
/// from the list-oriented `PROJECT_PANEL_COMPONENT`.
export const PROJECT_GRAPH_PANEL_COMPONENT = "project-graph";
/// Host-side log bus surface. Multiple are allowed (each
/// carries its own source / min-level filter in `params`).
export const SYSTEM_MESSAGES_PANEL_COMPONENT = "system-messages";
/// DBC discovery panel (tree-with-fuzzy-search over every
/// loaded DBC's messages → signals). Singleton (same pattern as the
/// project, graph, and system-messages panels) — the loaded-DBC set
/// lives on the host and there's no per-panel differentiation worth
/// having. Search query + expand state still live in panel `params`
/// so a layout save / restore preserves them.
export const DBC_PANEL_COMPONENT = "dbc";
/// Rest-of-bus-simulation panel (ADR 0028). Element-backed —
/// multiple named RBS elements per project are allowed, each
/// referencing its own `.cannet_rbs` file.
export const RBS_PANEL_COMPONENT = "rbs";
/// Signal value→color map config panel (ADR 0029). Element-backed,
/// like RBS — each colormap element opens into its own editor panel.
export const COLORMAP_PANEL_COMPONENT = "colormap";
/// User-settings editor over the host's `settings.json` (ADR 0034).
/// Singleton (same pattern as the project / graph / system-messages /
/// DBC panels) — settings are app-global, so one instance suffices.
export const SETTINGS_PANEL_COMPONENT = "settings";
/// The timeline-events view (ADR 0035) — a singleton panel.
export const EVENTS_PANEL_COMPONENT = "events";
/// Singleton id — toolbar's "DBC panel" button uses this to
/// show-or-focus a single instance.
export const DBC_PANEL_ID = "dbc";

/// The project graph is a singleton panel — one per workspace — so it
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

/// The timeline-events panel (ADR 0035) is a singleton — one app-global
/// instance, opened from the command palette.
export const EVENTS_PANEL_ID = "events";

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
  if (
    elementKind === "trace" ||
    elementKind === "plot" ||
    elementKind === "transmit" ||
    elementKind === "rbs"
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
    case SETTINGS_PANEL_ID:
      return "settings";
    case EVENTS_PANEL_ID:
      return "events";
    default:
      return null;
  }
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
    case "transmit":
      return TRANSMIT_PANEL_COMPONENT;
    case "rbs":
      return RBS_PANEL_COMPONENT;
    case "colormap":
      return COLORMAP_PANEL_COMPONENT;
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
 * in `SerializedDockview`), which would make the workspace state, a
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
