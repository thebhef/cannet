// User settings, persisted host-side (ADR 0034).
//
// Unlike `hostState` (machine state the app records as you work), these
// are choices the user deliberately sets — a disk-spill scratch-size cap
// and a clear-on-exit toggle. They round-trip through the host's
// `get_settings` / `set_settings` commands and land in a hand-editable
// `settings.json` in the OS config dir; the host is authoritative and the
// settings panel is sugar over the file.
//
// Settings are read only by the settings panel (the host reads the cap
// from `settings.json` directly when it enforces it), so — unlike
// `hostState` — there's no boot-time hydrate or synchronous cache: the
// panel loads on mount and writes the whole struct back on each edit.

import { invoke } from "@tauri-apps/api/core";

import type { BindingSpec } from "./commands";

/// Mirror of the host `Settings` struct (snake_case to match serde).
export interface Settings {
  /// Max bytes the disk-spill scratch may grow to before oldest history
  /// is dropped; `null` = unbounded.
  scratch_cap_bytes: number | null;
  /// Wipe the scratch on a clean exit.
  clear_scratch_on_exit: boolean;
  /// User keybinding customisation (ADR 0018). `null` = use the app's
  /// built-in defaults; a list is the whole effective binding set that
  /// replaces the defaults. Resolve to the effective bindings with
  /// `resolveBindings` from `commands.ts`.
  keybindings: BindingSpec[] | null;
}

export function defaultSettings(): Settings {
  return { scratch_cap_bytes: null, clear_scratch_on_exit: false, keybindings: null };
}

/// Load the persisted settings. Tolerant of a host that returns `null` /
/// partial data (and of no host at all, e.g. in unit tests) — anything
/// missing falls back to the documented default.
export async function loadSettings(): Promise<Settings> {
  try {
    const loaded = await invoke<Partial<Settings> | null>("get_settings");
    return { ...defaultSettings(), ...(loaded ?? {}) };
  } catch {
    return defaultSettings();
  }
}

/// Persist the whole settings struct. Best-effort: a failed write is
/// logged host-side and surfaced to the caller as a rejected promise.
export async function saveSettings(settings: Settings): Promise<void> {
  await invoke("set_settings", { settings });
}
