// Recently-used palette commands (localStorage).
//
// The command palette floats the last few used commands to the top
// of its (unfiltered) list, VS Code-style — an MRU list, not a
// strict history: re-running a command moves it to the front, and
// the list is capped. Persisted across app restarts. Same shape as
// `recentBlfs.ts`: pure helpers + a thin storage adapter so the
// unit tests don't reach for the real `localStorage`.

/// Maximum number of recently-used commands to remember.
export const RECENT_COMMANDS_LIMIT = 10;

/// `localStorage` key. Versioned so a future schema change can
/// retire the old entry rather than silently misreading it.
export const RECENT_COMMANDS_KEY = "cannet.recentCommands.v1";

/// Pure helper: move `id` to the front of `current`, dedupe, cap at
/// [`RECENT_COMMANDS_LIMIT`]. Empty ids are dropped.
export function recordRecentCommand(current: readonly string[], id: string): string[] {
  if (!id) return [...current];
  const out: string[] = [id];
  for (const c of current) {
    if (c === id) continue;
    if (out.length >= RECENT_COMMANDS_LIMIT) break;
    out.push(c);
  }
  return out;
}

/// Order `items` so the ones named in `recents` come first (in
/// recency order), with everything else keeping its original order.
/// Recents that don't match an item are skipped (a stale id for a
/// command that no longer exists, or one filtered out of the current
/// context).
export function sortRecentFirst<T extends { id: string }>(
  items: readonly T[],
  recents: readonly string[],
): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const head: T[] = [];
  for (const id of recents) {
    const item = byId.get(id);
    if (item) {
      head.push(item);
      byId.delete(id);
    }
  }
  return [...head, ...items.filter((i) => byId.has(i.id))];
}

/// Minimal `localStorage`-shaped surface, so tests can pass an
/// in-memory object.
export interface RecentCommandsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/// Read the persisted list; tolerates a missing / malformed entry
/// (skips non-string entries, clamps to the limit).
export function loadRecentCommands(storage: RecentCommandsStorage): string[] {
  const raw = storage.getItem(RECENT_COMMANDS_KEY);
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
    if (out.length >= RECENT_COMMANDS_LIMIT) break;
  }
  return out;
}

/// Persist `list` back under [`RECENT_COMMANDS_KEY`].
export function saveRecentCommands(
  storage: RecentCommandsStorage,
  list: readonly string[],
): void {
  storage.setItem(RECENT_COMMANDS_KEY, JSON.stringify([...list]));
}
