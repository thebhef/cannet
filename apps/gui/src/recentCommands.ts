// Recently-used palette commands.
//
// The command palette floats the last few used commands to the top
// of its (unfiltered) list, VS Code-style — an MRU list, not a
// strict history: re-running a command moves it to the front, and
// the list is capped. Persisted host-side across app restarts
// (ADR 0032); these are the pure list helpers feeding `hostState`.

import { hostSettings } from "./hostSettings";
import { pushRecent } from "./recentMru";

/// Move `id` to the front of the MRU, dedupe, cap at the configured
/// depth (`recent_commands_limit`).
export function recordRecentCommand(current: readonly string[], id: string): string[] {
  return pushRecent(current, id, hostSettings().recent_commands_limit);
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
