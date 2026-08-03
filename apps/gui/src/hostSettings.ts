// User settings, persisted host-side (ADR 0034).
//
// Unlike `hostState` (machine state the app records as you work), these
// are choices the user deliberately sets. They round-trip through the
// host's `get_settings` / `set_settings` commands and land in a
// hand-editable `settings.json` in the OS config dir; the host is
// authoritative and the settings panel is sugar over the file.
//
// This module is the *values*. Everything a view needs to render them —
// label, help text, control shape, tags, scope, default — comes from the
// host's descriptor table via `settingDescriptors.ts`, so a new setting
// is a host-side change and this interface is the only thing that grows
// here.
//
// Several independent consumers read settings (the settings panel, the
// keybinding layer, and the host itself, which reads `settings.json`
// directly when it enforces the scratch cap), so — as with `hostState` —
// the frontend hydrates an in-memory cache once before first render
// (`hydrateSettings`, called from `main.tsx`) and reads it synchronously
// thereafter.
//
// The cache is a *read* convenience and never the base of a write:
// `updateSettings` merges its patch over a fresh read of the file, because
// the file is hand-editable and another consumer may have written since the
// last hydrate. It then caches what the host says it stored (the host
// refuses out-of-range values) and notifies subscribers, so one consumer's
// edit — or a re-hydrate after a hand-edit — reaches all of them without a
// restart.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { BindingSpec } from "./commands";
import type { SystemLogLevel } from "./types";

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
  /// Whether the settings panel reveals the `developer`-tagged knobs.
  /// An ordinary setting rather than panel chrome, so the panel grows no
  /// controls of its own.
  show_developer_settings: boolean;
  /// Lowest severity the System Messages panel lists. A preference
  /// rather than panel state, so it survives closing the panel; the
  /// panel's source filter stays view-local.
  system_log_min_level: SystemLogLevel;
  /// How long a transient status notice dwells in the header before the
  /// bar reverts to its resting line.
  notice_dwell_ms: number;
  /// How often an open plot asks the host for a resampled window while
  /// a capture runs. Redraw stays pinned to rAF; this is the fetch.
  plot_fetch_interval_ms: number;
  /// How often a paged view re-reads the tail while a capture runs —
  /// the trace, by-id, signal and transmit/RBS views.
  view_refresh_interval_ms: number;
  /// Width of a plot's follow-live x-window before the user has set one
  /// by zooming or panning. Milliseconds on the wire, seconds in the
  /// settings view.
  follow_window_ms: number;
  /// How many recently-opened BLFs the File menu lists.
  recent_blfs_limit: number;
  /// How many recently-run commands the palette floats to the top.
  recent_commands_limit: number;
}

export function defaultSettings(): Settings {
  return {
    scratch_cap_bytes: null,
    clear_scratch_on_exit: false,
    keybindings: null,
    show_developer_settings: false,
    system_log_min_level: "info",
    notice_dwell_ms: 3000,
    plot_fetch_interval_ms: 67,
    view_refresh_interval_ms: 250,
    follow_window_ms: 10_000,
    recent_blfs_limit: 8,
    recent_commands_limit: 10,
  };
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

let cache: Settings = defaultSettings();
const listeners = new Set<(settings: Settings) => void>();

function publish(next: Settings): void {
  cache = next;
  for (const fn of [...listeners]) fn(cache);
}

/// Load the persisted settings into the in-memory cache and notify
/// subscribers. Called once before rendering; calling it again re-reads the
/// file, which is how a hand-edit made while the app runs reaches the app
/// without a restart.
export async function hydrateSettings(): Promise<void> {
  publish(await loadSettings());
}

/// The current cached settings. Synchronous; reflects writes made this
/// session even before they've flushed to disk.
export function hostSettings(): Settings {
  return cache;
}

/// One setting's current value, re-rendering the caller when it
/// changes. For a value a component *reacts* to — a poll interval whose
/// effect must be rebuilt, a width the next render uses. Code that only
/// needs the value at the moment it acts (a callback, an event handler)
/// should read `hostSettings()` directly instead and skip the render.
export function useSetting<K extends keyof Settings>(key: K): Settings[K] {
  return useSyncExternalStore(subscribeSettings, () => hostSettings()[key]);
}

/// Subscribe to settings changes. Returns the unsubscribe function.
export function subscribeSettings(fn: (settings: Settings) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/// Apply a settings patch: merge it over a *fresh read* of the file — not
/// over the cache — so a concurrent write or a hand-edit isn't clobbered,
/// persist the whole struct, then cache and publish what the host actually
/// accepted. Rejects if the write failed (the host logs it).
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const accepted = await saveSettings({ ...current, ...patch });
  publish(accepted);
  return accepted;
}
