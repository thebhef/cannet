// Signal value→color maps (ADR 0029). A `colormap` project element is
// ambient: it targets one signal and any view rendering that signal
// tints its value cell by the first matching rule. This module holds the
// pure resolution logic — compiled once per render into a lookup the row
// renderers call, never a per-row DBC re-derivation.

import type { ColorRule, ProjectElement } from "./types";

export type ColorMapElement = Extract<ProjectElement, { kind: "colormap" }>;

/// The identity a view supplies when asking for a signal's tint.
export interface ColorTarget {
  messageId: number;
  extended: boolean;
  signalName: string;
  busId: string | null;
}

/// Given a decoded signal's identity and its current raw value, the tint
/// color or `null` for no tint.
export type ColorResolver = (target: ColorTarget, value: number) => string | null;

/// Compile the project's colormap elements into a resolver. Resolution
/// is global and first-match: the first colormap whose target matches
/// the signal (and whose `busId` is null/absent or equals the signal's
/// bus), then that map's first rule whose inclusive `[min, max]` covers
/// the value. See ADR 0029.
export function buildColorResolver(elements: readonly ProjectElement[]): ColorResolver {
  const maps = elements.filter((e): e is ColorMapElement => e.kind === "colormap");
  return (t, value) => {
    for (const m of maps) {
      if (
        m.messageId !== t.messageId ||
        m.extended !== t.extended ||
        m.signalName !== t.signalName
      ) {
        continue;
      }
      if (m.busId != null && m.busId !== t.busId) continue;
      for (const r of m.rules) {
        if (value >= r.min && value <= r.max) return r.color;
      }
    }
    return null;
  };
}

/// CSS `background` that tints a cell with `color` at low opacity, so the
/// text on top stays legible (ADR 0029). Emits `rgba()` so the alpha is
/// explicit and portable; a non-hex `color` is passed through unchanged.
export function colorMapTint(color: string): string {
  const rgb = hexToRgb(color);
  return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)` : color;
}

/// Fill for an enum logic-analyzer lane box (ADR 0026/0029): a *darkened*
/// shade of the value's color at 0.65 opacity — dim enough that the
/// stepped line shows through the lane (the box's border and label carry
/// the full color). Non-hex passes through.
export function colorMapLaneFill(color: string): string {
  const rgb = hexToRgb(color);
  if (!rgb) return color;
  const k = 0.4; // darken
  return `rgba(${Math.round(rgb.r * k)}, ${Math.round(rgb.g * k)}, ${Math.round(rgb.b * k)}, 0.65)`;
}

/// Parse a `#rgb` / `#rrggbb` hex string to its 0–255 components, or null
/// if it isn't a hex color.
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/(.)/g, "$1$1") : m[1];
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/// Palette cycled when seeding rules from a DBC value table, so a freshly
/// created colormap starts with distinct, legible colors the user can
/// then tweak.
const ENUM_PALETTE: readonly string[] = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#a855f7", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
  "#eab308", // yellow
];

/// Seed one degenerate-range rule per DBC value-table entry (`raw` →
/// `[raw, raw]`), cycling {@link ENUM_PALETTE} for the colors. Accepts
/// the DBC `ValueTableEntryRecord` shape (extra fields like `label` are
/// ignored) so a config panel can pass value tables straight through.
export function rulesFromValueTable(entries: readonly { raw: number; label?: string }[]): ColorRule[] {
  return entries.map((e, i) => ({
    min: e.raw,
    max: e.raw,
    color: ENUM_PALETTE[i % ENUM_PALETTE.length],
  }));
}
