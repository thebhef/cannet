// The one place a signal's color is decided (ADR 0026). Every surface
// that draws a signal in its own color — the signal view's name text,
// a plot series' stroke and swatch — asks this module, so one wheel and
// one precedence rule serve them all:
//
//   explicit user pick → generator → stable-by-identity hash
//
// The pick is whatever the calling surface persists (the project's
// `signal_colors` map for the signal view, a series' `colorPick` for
// the plot); the generator derives a wheel index from the signal's
// identity; the hash is the always-available fallback. Nothing is
// stored to render an unpicked signal, so a generator change recolors
// it live.
//
// This is *signal identity* coloring. A value→color map (ADR 0029,
// `colorMap.ts`) tints a signal's *value* and is a separate question
// with a separate resolver.

import { stableSignalColor, wheelColor } from "./palette";
import type { ProjectElement } from "./types";

/// A generator's answer for one signal: the color-wheel index its rule
/// derives from the signal's identity, or `null` when no rule claims
/// the signal.
export type SignalColorGenerator = (key: string) => number | null;

/// What a view calls: a signal's canonical key (`signalKey` in
/// `plotData.ts`) plus that view's explicit pick, if the user made one.
export type SignalColorResolver = (key: string, pick?: string | null) => string;

/// Resolve one signal's color — the precedence rule itself, pure and
/// independent of where the pick or the generator came from.
export function resolveSignalColor(
  key: string,
  pick: string | null | undefined,
  generator: SignalColorGenerator,
): string {
  if (pick) return pick;
  const index = generator(key);
  if (index != null) return wheelColor(index);
  return stableSignalColor(key);
}

/// Compile the project's generator rules into the generator slot. No
/// project element declares one yet, so every signal falls through to
/// the hash; the slot is the seam that gives them somewhere to land.
function buildSignalColorGenerator(_elements: readonly ProjectElement[]): SignalColorGenerator {
  return () => null;
}

/// Bind the project's generators once per render into the resolver the
/// views call — the same compile-ambient-rules-once shape
/// `buildColorResolver` uses for value color maps.
export function buildSignalColorResolver(
  elements: readonly ProjectElement[],
): SignalColorResolver {
  const generator = buildSignalColorGenerator(elements);
  return (key, pick) => resolveSignalColor(key, pick, generator);
}
