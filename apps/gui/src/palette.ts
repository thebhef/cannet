/// The shared 16-color signal wheel (ADR 0026): every surface that
/// colors a signal — plot series seeds, signal-view name text, the
/// DBC panel's value renderer — draws from this one module, so the
/// palettes can't drift apart. The values live in `theme.ts` (one wheel
/// per theme, slot-matched); `palette.test.ts` holds them to WCAG-AA
/// contrast (≥ 4.5:1) against the theme's background.

import { theme } from "./theme";

/// The active theme's signal wheel.
export function signalWheel(): readonly string[] {
  return theme().signalWheel;
}

/// The wheel color at `index`, wrapping (negative-safe).
export function wheelColor(index: number): string {
  const wheel = signalWheel();
  const n = wheel.length;
  return wheel[((index % n) + n) % n];
}

/// A signal's stable-by-identity color: the wheel entry at the hash
/// of its descriptor key (`signalKey` in plotData.ts). The same signal
/// keeps the same color across sorts, views, and sessions without
/// anything being stored. This is the *last* rung of the precedence
/// rule — views call `signalColorResolver.ts`, which puts an explicit
/// pick and a generator ahead of it, not this function directly.
///
/// FNV-1a over the key string. The hash is part of the visual contract
/// — changing it silently recolors every non-overridden signal.
export function stableSignalColor(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return wheelColor(h >>> 0);
}
