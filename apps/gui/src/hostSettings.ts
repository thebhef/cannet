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
  /// How often the host tells the views a running capture has grown.
  live_update_interval_ms: number;
  /// How often the capture is flushed to disk (ADR 0002 DS-2/DS-7).
  trace_flush_interval_ms: number;
  /// Size at which `cannet.log` rotates to `cannet.log.1`.
  log_rotation_bytes: number;
  /// Entries the system-log ring holds, host-side and in the frontend
  /// mirror, before the oldest is dropped.
  system_log_ring_capacity: number;
  /// Identical messages one source may log per second; `0` = no limit.
  system_log_rate_limit: number;
  /// Health-sample cadence; `0` = sampling off.
  health_sample_interval_ms: number;
  /// Auto-restarts allowed per session for a crashed sidecar.
  sidecar_restart_budget: number;
  /// Wait before reconnecting to a `cannet-server` after a drop.
  reconnect_backoff_ms: number;
  /// Directory to launch the python-can sidecar from; `""` = the one
  /// the app ships with. Host-consumed; `CANNET_SIDECAR_DIR` in the
  /// environment overrides it for one run.
  sidecar_dir: string;
  /// Python module the sidecar loads its driver from; `""` = the
  /// bundled python-can driver. Host-consumed; `CANNET_DRIVER_MODULE`
  /// in the environment overrides it for one run.
  driver_module: string;
  /// Lowest severity written to the rolling `cannet.log`. A separate
  /// filter over a separate sink from `system_log_min_level`, which
  /// narrows only the System Messages view.
  log_file_min_level: SystemLogLevel;
  /// Log level the python-can sidecar runs at — Python's ladder, whose
  /// third rung is `warning`, not `warn`.
  sidecar_log_level: string;
  /// Which view a *freshly created* trace panel opens in. Read once,
  /// when the panel seeds its state; the panel's own buttons still win
  /// afterwards, and changing this never rewrites an open panel.
  trace_mode: string;
  /// Whether a *freshly created* chronological trace starts pinned to
  /// the live tail. Read once at panel creation.
  trace_auto_scroll: boolean;
  /// Whether a *freshly created* chronological trace interleaves
  /// timeline events among its rows. Read once at panel creation.
  trace_show_events: boolean;
  /// How a *newly created* plot area spreads its series over y-axes
  /// (ADR 0026). Read once, when the area is created; an area that
  /// already exists keeps the layout it was drawn with.
  plot_y_axis_mode: string;
  /// Whether a loaded DBC is re-read when the file changes on disk.
  /// Host-consumed (`dbc_watcher`); listed here because the mirror
  /// carries every field of `settings.json`.
  dbc_auto_reload: boolean;
  /// How a trace-style table's `id` column spells an arbitration id —
  /// the frontend's `CanIdFormat`. App-wide: the trace and by-ID tables
  /// read it and pass it to their rows.
  can_id_format: string;
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
    live_update_interval_ms: 100,
    trace_flush_interval_ms: 2000,
    log_rotation_bytes: 5 * 1024 * 1024,
    system_log_ring_capacity: 4096,
    system_log_rate_limit: 5,
    health_sample_interval_ms: 20_000,
    sidecar_restart_budget: 3,
    reconnect_backoff_ms: 2000,
    sidecar_dir: "",
    driver_module: "",
    log_file_min_level: "debug",
    sidecar_log_level: "info",
    trace_mode: "by-id",
    trace_auto_scroll: true,
    trace_show_events: true,
    plot_y_axis_mode: "unified",
    dbc_auto_reload: true,
    can_id_format: "hex",
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
