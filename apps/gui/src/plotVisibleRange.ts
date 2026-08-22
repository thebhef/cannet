// Argument parsing for `plot.setVisibleRange`. The palette prompt
// collects free text in one of two forms: two numbers — separated by a
// space, a comma, or `..` — name an explicit min/max range in the units
// the x-axis shows; a single number names a new window *width*, keeping
// the panel's current centre. Pure, so the prompt's inline-error
// validator and the panel's apply step can each be tested without a
// live PlotPanel.

/// The parsed value of `plot.setVisibleRange`'s prompt text, or an
/// inline error to show the user.
export type ParsedVisibleRange =
  | { ok: true; kind: "range"; min: number; max: number }
  | { ok: true; kind: "width"; width: number }
  | { ok: false; error: string };

/// Split `raw` on whichever of the three separators it uses. `..` and
/// `,` are checked first since either could otherwise be swallowed by
/// a permissive whitespace split; a bare run of digits with internal
/// spaces falls through to the plain-whitespace split.
function splitRangeInput(trimmed: string): string[] {
  if (trimmed.includes("..")) return trimmed.split(/\s*\.\.\s*/);
  if (trimmed.includes(",")) return trimmed.split(/\s*,\s*/);
  return trimmed.split(/\s+/);
}

export function parseVisibleRangeInput(raw: string): ParsedVisibleRange {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: "Enter a width, or a min,max range." };
  const parts = splitRangeInput(trimmed);
  if (parts.length === 1) {
    const width = Number(parts[0]);
    if (!Number.isFinite(width)) return { ok: false, error: "Enter a number." };
    if (width <= 0) return { ok: false, error: "Width must be greater than zero." };
    return { ok: true, kind: "width", width };
  }
  if (parts.length === 2) {
    const min = Number(parts[0]);
    const max = Number(parts[1]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { ok: false, error: "Enter numbers." };
    }
    if (min >= max) return { ok: false, error: "Min must be less than max." };
    return { ok: true, kind: "range", min, max };
  }
  return { ok: false, error: "Enter a width, or a min,max range." };
}

/// Turn a parsed input into the concrete `[min, max]` window
/// `applyXAll` wants: an explicit range passes through verbatim; a
/// width keeps the current window's centre. `null` for a parse
/// failure — callers only reach this after the prompt's validator has
/// already accepted the text, so this is a defensive fallback, not the
/// primary error path.
export function resolveVisibleRange(
  parsed: ParsedVisibleRange,
  current: { min: number; max: number },
): [number, number] | null {
  if (!parsed.ok) return null;
  if (parsed.kind === "range") return [parsed.min, parsed.max];
  const center = (current.min + current.max) / 2;
  return [center - parsed.width / 2, center + parsed.width / 2];
}
