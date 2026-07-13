/// The shared 16-colour signal wheel (ADR 0026): every surface that
/// colours a signal — plot series seeds, signal-view name text, the
/// DBC panel's value renderer — draws from this one module, so the
/// palettes can't drift apart. All entries must hold WCAG-AA contrast
/// (≥ 4.5:1) against the app background (`index.css` `#0e1116`);
/// `palette.test.ts` enforces it.

export const SIGNAL_WHEEL: readonly string[] = [
  "#c6f24e",
  "#4ecbff",
  "#ffaa3d",
  "#b48cff",
  "#ff7e5a",
  "#ffd93d",
  "#5ddb7c",
  "#e15dcf",
  "#8ce0d4",
  "#ff9bd2",
  "#a0bfff",
  "#d0ff7a",
  "#ff6b6b",
  "#7be3ff",
  "#ffcf85",
  "#c39bff",
];

/// The wheel colour at `index`, wrapping (negative-safe).
export function wheelColor(index: number): string {
  const n = SIGNAL_WHEEL.length;
  return SIGNAL_WHEEL[((index % n) + n) % n];
}

/// A signal's stable-by-identity colour: the wheel entry at the hash
/// of its descriptor key (`signalKey` in plotData.ts). The same signal
/// keeps the same colour across sorts, views, and sessions without
/// anything being stored; a per-signal project-persisted override
/// (looked up by the caller) wins over this base.
///
/// FNV-1a over the key string. The hash is part of the visual contract
/// — changing it silently recolours every non-overridden signal.
export function stableSignalColor(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return wheelColor(h >>> 0);
}
