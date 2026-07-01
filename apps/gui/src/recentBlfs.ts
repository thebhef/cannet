// Recent BLFs.
//
// The N most-recently-opened BLF paths, offered in the Open BLF flow
// and the project panel's BLF import affordance. Persisted host-side
// across app restarts (ADR 0032); these are the pure list helpers that
// shape the MRU before it's handed to `hostState`.

/// Maximum number of recents to remember. Eight is roughly "every
/// BLF you opened this week"; anything older is in the file picker.
export const RECENT_BLFS_LIMIT = 8;

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
