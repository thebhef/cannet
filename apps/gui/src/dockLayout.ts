import type { SerializedDockview } from "dockview";

import type { ProjectElementKind } from "./types";
import type { FocusedPanelKind } from "./commands";

/**
 * `localStorage` key for the persisted panel layout. The `.v1` suffix
 * is bumped if the serialized shape changes incompatibly. This is a
 * placeholder for the case where no project file is open: a project
 * file carries the layout, and this key is the "no project open" default.
 */
export const LAYOUT_STORAGE_KEY = "cannet.layout.v1";

/**
 * `localStorage` key holding the path of the last project that was
 * opened or saved-as, so it's reopened on launch. Absent / cleared
 * means "no named project" — fall back to the [`LAYOUT_STORAGE_KEY`]
 * layout.
 */
export const LAST_PROJECT_KEY = "cannet.lastProject.v1";

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
    case "filter":
      return null;
  }
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

/** Parse a previously-persisted dockview layout *string* (e.g. from
 * `localStorage`); see {@link validateLayout}. */
export function parseSavedLayout(
  raw: string | null | undefined,
): SerializedDockview | null {
  if (!raw) return null;
  try {
    return validateLayout(JSON.parse(raw));
  } catch {
    return null;
  }
}
