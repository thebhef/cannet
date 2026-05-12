import type { SerializedDockview } from "dockview";

/**
 * `localStorage` key for the persisted panel layout. The `.v1` suffix
 * is bumped if the serialized shape changes incompatibly. This is a
 * placeholder until project files land (Phase 3): a project file will
 * carry the layout, and this key becomes the "no project open" default.
 */
export const LAYOUT_STORAGE_KEY = "cannet.layout.v1";

/**
 * Names the panel React components are registered under in the dockview
 * `components` map. Stored verbatim inside the serialized layout, so
 * changing them would orphan saved layouts — treat as stable.
 */
export const TRACE_PANEL_COMPONENT = "trace";
export const BY_ID_PANEL_COMPONENT = "by-id";
export const PROJECT_PANEL_COMPONENT = "project";

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
