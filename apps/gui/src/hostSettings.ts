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

/// Mirror of the host `SettingsBounds` struct: the validation limits the
/// host enforces on ingress. Deliberately *not* re-declared as constants
/// here — the host is the single source of truth for a limit derived from
/// the store's segment geometry (ADR 0002 DS-8), and the UI reads it so the
/// two cannot drift.
export interface SettingsBounds {
  /// Smallest legal `scratch_cap_bytes`; a smaller value is refused.
  minScratchCapBytes: number;
}

/// Load the settings validation bounds. Rejects (rather than inventing a
/// fallback) when there is no host or the answer is unusable, so a caller
/// renders the bound only once it actually knows it.
export async function loadSettingsBounds(): Promise<SettingsBounds> {
  const bounds = await invoke<Partial<SettingsBounds> | null>("get_settings_bounds");
  if (typeof bounds?.minScratchCapBytes !== "number") {
    throw new Error("settings bounds unavailable");
  }
  return { minScratchCapBytes: bounds.minScratchCapBytes };
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

/// Persist the whole settings struct, resolving to what the host actually
/// stored — it refuses out-of-range values (reporting them on the system
/// log), so the accepted settings can differ from what was sent. A failed
/// write is logged host-side and surfaced as a rejected promise.
export async function saveSettings(settings: Settings): Promise<Settings> {
  const accepted = await invoke<Partial<Settings> | null>("set_settings", { settings });
  return accepted == null ? settings : { ...defaultSettings(), ...accepted };
}
