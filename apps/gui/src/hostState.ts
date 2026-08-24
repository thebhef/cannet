// Machine-local UI state, persisted host-side (ADR 0032, ADR 0034).
//
// These values (last-opened project, recent projects, the open project's
// layout snapshot, recent captures, recent commands) used to live in
// `localStorage`; they now
// round-trip through the host's `get_state` / `set_state` commands. The
// host is authoritative — and it also decides *where* each value lands:
// `state.json` in the OS config dir for what follows the person, the
// project's own `.cannet/state.json` for what belongs to the project
// (ADR 0042). This side just reads and writes the resolved struct.
// This is *state* the app records as the user works — not user *settings*
// (those live in `settings.json`, see `hostSettings`); ADR 0034 splits the
// two and renamed this file from `preferences.json`.
//
// `localStorage` is synchronous but `invoke` is not, so we hydrate an
// in-memory cache once before the app renders (`hydrateState`, called
// from `main.tsx`) and read it synchronously thereafter. Writes update
// the cache immediately and flush the whole struct to the host
// best-effort (fire-and-forget — a failed flush is logged host-side and
// simply means the change isn't durable, never a broken UI).

import { invoke } from "@tauri-apps/api/core";

import { emptyBlfChannelMaps, type BlfChannelMaps } from "./blfChannelMap";

/// Mirror of the host `UiState` struct (snake_case to match serde).
export interface UiState {
  last_project: string | null;
  recent_projects: string[];
  layout: unknown | null;
  recent_blfs: string[];
  recent_commands: string[];
  blf_channel_maps: BlfChannelMaps;
}

function emptyState(): UiState {
  return {
    last_project: null,
    recent_projects: [],
    layout: null,
    recent_blfs: [],
    recent_commands: [],
    blf_channel_maps: emptyBlfChannelMaps(),
  };
}

let cache: UiState = emptyState();

/// Load the persisted UI state into the in-memory cache. Call once before
/// rendering. Tolerant of a host that returns `null` / partial data (and
/// of no host at all, e.g. in unit tests) — anything missing falls back to
/// the empty default.
export async function hydrateState(): Promise<void> {
  try {
    const loaded = await invoke<Partial<UiState> | null>("get_state");
    cache = { ...emptyState(), ...(loaded ?? {}) };
  } catch {
    cache = emptyState();
  }
}

/// The current cached UI state. Synchronous; reflects writes made this
/// session even before they've flushed to disk.
export function hostState(): UiState {
  return cache;
}

/// Push the whole cache to the host. Best-effort.
function flush(): void {
  void invoke("set_state", { state: cache }).catch(() => {
    /* host logs the failure; the in-memory value still holds */
  });
}

export function setLastProject(path: string | null): void {
  cache = { ...cache, last_project: path };
  flush();
}

/// Persist the Recent-projects MRU. User-scope state (ADR 0042 §3): it
/// is how you get back to a project you are *not* in, so it follows the
/// person rather than any one project directory.
export function setRecentProjects(list: readonly string[]): void {
  cache = { ...cache, recent_projects: [...list] };
  flush();
}

export function setLayout(layout: unknown): void {
  cache = { ...cache, layout };
  flush();
}

/// Persist the Recent-captures MRU. Named for the display name
/// ("Recent captures" — the list records BLF and MDF imports alike),
/// not the wire field it writes (`recent_blfs`, kept as-is; see
/// `recentCaptures.ts`).
export function setRecentCaptures(list: readonly string[]): void {
  cache = { ...cache, recent_blfs: [...list] };
  flush();
}

export function setRecentCommands(list: readonly string[]): void {
  cache = { ...cache, recent_commands: [...list] };
  flush();
}

export function setBlfChannelMaps(maps: BlfChannelMaps): void {
  cache = { ...cache, blf_channel_maps: maps };
  flush();
}
