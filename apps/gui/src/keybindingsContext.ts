// The live keybinding state shared between the dispatcher (App.tsx) and
// the shortcuts editor (ADR 0018). App owns the state — it loads the
// user's customisation from `settings.json`, resolves it to the effective
// binding set the dispatcher runs, and persists edits — and exposes it
// here so the shortcuts panel (any dockview instance) can read and change
// it without threading props through dockview.

import { createContext, useContext } from "react";

import type { BindingSpec } from "./commands";

export interface KeybindingsController {
  /// The user's customisation as persisted: `null` means no customisation
  /// (the built-in defaults are in effect).
  user: readonly BindingSpec[] | null;
  /// The effective, sanitised binding list currently being dispatched
  /// (`resolveBindings(user)`). This is what the editor renders as
  /// "current".
  effective: readonly BindingSpec[];
  /// Replace the whole customisation. `null` resets to the built-in
  /// defaults. App sanitises, re-resolves, and persists.
  setUser(next: readonly BindingSpec[] | null): void;
}

export const KeybindingsContext = createContext<KeybindingsController | null>(null);

/// Read the keybindings controller. Throws outside a provider so a
/// missing wire-up fails loudly rather than silently no-op'ing.
export function useKeybindings(): KeybindingsController {
  const ctx = useContext(KeybindingsContext);
  if (!ctx) throw new Error("useKeybindings: no KeybindingsContext provider");
  return ctx;
}
