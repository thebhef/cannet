// Recent BLFs.
//
// The N most-recently-opened BLF paths, offered in the Open BLF flow
// and the project panel's BLF import affordance. Persisted host-side
// across app restarts (ADR 0032); these are the pure list helpers that
// shape the MRU before it's handed to `hostState`.

import { pushRecent } from "./recentMru";

/// Maximum number of recents to remember. Eight is roughly "every
/// BLF you opened this week"; anything older is in the file picker.
export const RECENT_BLFS_LIMIT = 8;

/// Prepend `path` to the MRU, dedupe, cap at [`RECENT_BLFS_LIMIT`].
export function recordRecentBlf(current: readonly string[], path: string): string[] {
  return pushRecent(current, path, RECENT_BLFS_LIMIT);
}

/// Pure helper: remove `path` from the list. Used when the host
/// reports an Open BLF failed (e.g. the file moved) so the next
/// session doesn't keep offering a path that can't open.
export function forgetRecentBlf(current: readonly string[], path: string): string[] {
  return current.filter((p) => p !== path);
}
