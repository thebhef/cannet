import type { SerializedDockview } from "dockview";

/**
 * `localStorage` key for the persisted panel layout. The `.v1` suffix
 * is bumped if the serialized shape changes incompatibly. This is a
 * placeholder until project files land (Phase 3): a project file will
 * carry the layout, and this key becomes the "no project open" default.
 */
export const LAYOUT_STORAGE_KEY = "cannet.layout.v1";

/**
 * Name the trace-panel React component is registered under in the
 * dockview `components` map. Stored verbatim inside the serialized
 * layout, so changing it would orphan saved layouts — treat as stable.
 */
export const TRACE_PANEL_COMPONENT = "trace";

/**
 * Parse a previously-persisted dockview layout string.
 *
 * Returns `null` for missing, unparseable, or structurally
 * unrecognised input so a corrupt blob falls back to the default
 * layout instead of bricking startup. The shape check is deliberately
 * shallow — dockview's own deserializer validates the rest, and a
 * mismatched-but-plausible blob fails loudly there rather than here.
 */
export function parseSavedLayout(
  raw: string | null | undefined,
): SerializedDockview | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
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
