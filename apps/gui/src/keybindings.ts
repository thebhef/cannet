// Key-chord parsing and dispatch for the command framework
// (ADR 0018). Pure: no DOM, no React — `useCommandDispatch` in the
// provider feeds real `keydown` events through `dispatchStroke`.
//
// Chord syntax (code-declared, see `commands.ts`):
// - a bare key: `"f"`
// - modifiers joined by `+`: `"Mod+Shift+P"` — `Mod` is Cmd on mac
//   and Ctrl elsewhere; only `Mod` / `Shift` / `Alt` are accepted
// - sequence steps separated by spaces: `"g r"`

/// One step of a chord, normalised (lowercase key).
export interface ChordStep {
  key: string;
  /// Platform primary modifier: Cmd on mac, Ctrl elsewhere.
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

/// A parsed chord: one or more steps pressed in sequence.
export type KeyChord = ChordStep[];

/// The bits of a `keydown` event the dispatcher needs.
export interface KeyStroke {
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/// Parse a chord declaration. Throws on malformed input — bindings
/// are code-declared, so a parse failure is a programming error that
/// should fail loudly at boot, not be tolerated at runtime.
export function parseChord(chord: string): KeyChord {
  const steps = chord.split(" ").filter((s) => s.length > 0);
  if (steps.length === 0) throw new Error(`empty key chord: ${JSON.stringify(chord)}`);
  return steps.map((step) => {
    const tokens = step.split("+");
    const key = tokens[tokens.length - 1];
    if (key.length === 0) throw new Error(`malformed chord step: ${JSON.stringify(step)}`);
    const out: ChordStep = { key: key.toLowerCase(), mod: false, shift: false, alt: false };
    for (const token of tokens.slice(0, -1)) {
      if (token === "Mod") out.mod = true;
      else if (token === "Shift") out.shift = true;
      else if (token === "Alt") out.alt = true;
      else throw new Error(`unknown modifier ${JSON.stringify(token)} in ${JSON.stringify(step)}`);
    }
    return out;
  });
}

/// Does a keystroke match one chord step? Modifiers must match
/// exactly — `f` does not fire on `Ctrl+f`, and a `Mod` binding only
/// fires on the platform's primary modifier (the other one pressed
/// disqualifies the stroke).
export function strokeMatchesStep(stroke: KeyStroke, step: ChordStep, isMac: boolean): boolean {
  const primary = isMac ? stroke.meta : stroke.ctrl;
  const secondary = isMac ? stroke.ctrl : stroke.meta;
  return (
    stroke.key.toLowerCase() === step.key &&
    primary === step.mod &&
    secondary === false &&
    stroke.shift === step.shift &&
    stroke.alt === step.alt
  );
}

/// Render a chord for display (palette hints): `⇧⌘P` on mac,
/// `Ctrl+Shift+P` elsewhere; sequence steps joined by a space.
export function formatChord(chord: KeyChord, isMac: boolean): string {
  return chord
    .map((step) => {
      const modified = step.mod || step.shift || step.alt;
      const key = step.key.length === 1 && modified ? step.key.toUpperCase() : step.key;
      if (isMac) {
        return `${step.alt ? "⌥" : ""}${step.shift ? "⇧" : ""}${step.mod ? "⌘" : ""}${key}`;
      }
      const parts: string[] = [];
      if (step.mod) parts.push("Ctrl");
      if (step.shift) parts.push("Shift");
      if (step.alt) parts.push("Alt");
      parts.push(key);
      return parts.join("+");
    })
    .join(" ");
}

/// A parsed binding: the chord plus the command it triggers.
export interface ParsedBinding {
  chord: KeyChord;
  commandId: string;
}

export interface DispatchResult {
  /// The strokes buffered so far toward a multi-step sequence
  /// (empty when nothing is pending). Feed back into the next call.
  pending: KeyStroke[];
  /// The command to run, when a chord completed.
  commandId: string | null;
  /// True when the stroke was consumed (a command fired or a
  /// sequence prefix matched) — the caller should preventDefault.
  handled: boolean;
}

/// Advance the dispatcher by one keystroke. `pending` is the buffer
/// returned by the previous call (sequence prefixes in flight).
/// While the target is editable (text input / textarea /
/// contentEditable) plain-key bindings are suppressed so typing
/// doesn't trigger hotkeys; chords with `Mod` or `Alt` still fire.
export function dispatchStroke(
  pending: readonly KeyStroke[],
  stroke: KeyStroke,
  bindings: readonly ParsedBinding[],
  opts: { isMac: boolean; inEditable: boolean },
): DispatchResult {
  if (opts.inEditable && !stroke.ctrl && !stroke.meta && !stroke.alt) {
    return { pending: [], commandId: null, handled: false };
  }
  const strokes = [...pending, stroke];
  const matches = bindings.filter(
    (b) =>
      b.chord.length >= strokes.length &&
      strokes.every((s, i) => strokeMatchesStep(s, b.chord[i], opts.isMac)),
  );
  const complete = matches.find((b) => b.chord.length === strokes.length);
  if (complete) {
    return { pending: [], commandId: complete.commandId, handled: true };
  }
  if (matches.length > 0) {
    // Prefix of a longer sequence — buffer and wait for the next key.
    return { pending: strokes, commandId: null, handled: true };
  }
  // No match. If we were buffering, the sequence broke; either way
  // the stroke wasn't ours.
  return { pending: [], commandId: null, handled: false };
}

/// Is the keydown target a text-entry surface? Plain-key bindings
/// are suppressed there (see `dispatchStroke`'s `inEditable`).
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

/// Cmd-as-Mod platform detection for the dispatcher and the palette's
/// binding hints.
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}
