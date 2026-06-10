// Phase 9 — Recent BLFs (localStorage).
//
// The N most-recently-opened BLF paths, offered in the Open BLF flow
// and the project panel's BLF import affordance. Persisted across
// app restarts in `localStorage`. Pure helpers + a thin storage
// adapter so the unit tests don't reach for the real `localStorage`.

/// Maximum number of recents to remember. Eight is roughly "every
/// BLF you opened this week"; anything older is in the file picker.
export const RECENT_BLFS_LIMIT = 8;

/// `localStorage` key. Versioned so a future schema change can
/// retire the old entry rather than silently misreading it.
export const RECENT_BLFS_KEY = "cannet.recentBlfs.v1";

/// Pure helper: prepend `path` to `current`, dedupe against the
/// previous list, cap at [`RECENT_BLFS_LIMIT`]. Empty strings are
/// dropped (defensive against an accidental empty path).
export function recordRecentBlf(current: readonly string[], path: string): string[] {
  if (!path) return [...current];
  const out: string[] = [path];
  for (const p of current) {
    if (p === path) continue;
    if (out.length >= RECENT_BLFS_LIMIT) break;
    out.push(p);
  }
  return out;
}

/// Pure helper: remove `path` from the list. Used when the host
/// reports an Open BLF failed (e.g. the file moved) so the next
/// session doesn't keep offering a path that can't open.
export function forgetRecentBlf(current: readonly string[], path: string): string[] {
  return current.filter((p) => p !== path);
}

/// Tolerant parser for the persisted form. Skips non-string
/// entries; clamps to the limit; returns `[]` for any junk shape.
export function parseRecentBlfs(raw: string | null): string[] {
  if (raw == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const v of parsed) {
    if (typeof v === "string" && v.length > 0) out.push(v);
    if (out.length >= RECENT_BLFS_LIMIT) break;
  }
  return out;
}

/// Minimal `localStorage`-shaped surface, so tests can pass an
/// in-memory object.
export interface RecentBlfsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/// Read the persisted list; tolerates a missing / malformed entry.
export function loadRecentBlfs(storage: RecentBlfsStorage): string[] {
  return parseRecentBlfs(storage.getItem(RECENT_BLFS_KEY));
}

/// Persist `list` back under [`RECENT_BLFS_KEY`].
export function saveRecentBlfs(storage: RecentBlfsStorage, list: readonly string[]): void {
  storage.setItem(RECENT_BLFS_KEY, JSON.stringify([...list]));
}
