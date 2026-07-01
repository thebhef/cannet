// Machine-local UI preferences, persisted host-side (ADR 0032).
//
// These settings (last-opened project, no-project layout snapshot,
// recent BLFs, recent commands) used to live in `localStorage`; they now
// round-trip through the host's `get_prefs` / `set_prefs` commands and
// land in a JSON file in the OS config dir. The host is authoritative.
//
// `localStorage` is synchronous but `invoke` is not, so we hydrate an
// in-memory cache once before the app renders (`hydratePrefs`, called
// from `main.tsx`) and read it synchronously thereafter. Writes update
// the cache immediately and flush the whole struct to the host
// best-effort (fire-and-forget — a failed flush is logged host-side and
// simply means the change isn't durable, never a broken UI).

import { invoke } from "@tauri-apps/api/core";

/// Mirror of the host `Prefs` struct (snake_case to match serde).
export interface Prefs {
  last_project: string | null;
  layout: unknown | null;
  recent_blfs: string[];
  recent_commands: string[];
}

function emptyPrefs(): Prefs {
  return {
    last_project: null,
    layout: null,
    recent_blfs: [],
    recent_commands: [],
  };
}

let cache: Prefs = emptyPrefs();

/// Load the persisted preferences into the in-memory cache. Call once
/// before rendering. Tolerant of a host that returns `null` / partial
/// data (and of no host at all, e.g. in unit tests) — anything missing
/// falls back to the empty default.
export async function hydratePrefs(): Promise<void> {
  try {
    const loaded = await invoke<Partial<Prefs> | null>("get_prefs");
    cache = { ...emptyPrefs(), ...(loaded ?? {}) };
  } catch {
    cache = emptyPrefs();
  }
}

/// The current cached preferences. Synchronous; reflects writes made
/// this session even before they've flushed to disk.
export function prefs(): Prefs {
  return cache;
}

/// Push the whole cache to the host. Best-effort.
function flush(): void {
  void invoke("set_prefs", { prefs: cache }).catch(() => {
    /* host logs the failure; the in-memory value still holds */
  });
}

export function setLastProject(path: string | null): void {
  cache = { ...cache, last_project: path };
  flush();
}

export function setLayout(layout: unknown): void {
  cache = { ...cache, layout };
  flush();
}

export function setRecentBlfs(list: readonly string[]): void {
  cache = { ...cache, recent_blfs: [...list] };
  flush();
}

export function setRecentCommands(list: readonly string[]): void {
  cache = { ...cache, recent_commands: [...list] };
  flush();
}
