// Recent captures.
//
// The N most-recently-imported trace paths — BLF and MDF alike (Task
// 66 unified the two Recent-BLFs and would-be Recent-MDFs lists into
// one), offered in the Import-trace flow. Persisted host-side across
// app restarts (ADR 0032); these are the pure list helpers that shape
// the MRU before it's handed to `hostState`.
//
// The storage shape and its setting name (`recent_blfs` / the
// `recent_blfs_limit` cap) predate the merge and are kept as-is — a
// plain path list neither knows nor needs to know which format each
// entry is; that's read off the extension at open time
// (`importFormat.ts`). Renaming the wire names would need a migration
// for no behavioral gain, so only the display name changed ("Recent
// captures" in the toolbar; the setting's label in `settings_descriptor.rs`).

import { hostSettings } from "./hostSettings";
import { pushRecent } from "./recentMru";

/// Prepend `path` to the MRU, dedupe, cap at the configured depth
/// (`recent_blfs_limit`; the default is roughly "every capture you
/// opened this week", and anything older is in the file picker).
export function recordRecentCapture(current: readonly string[], path: string): string[] {
  return pushRecent(current, path, hostSettings().recent_blfs_limit);
}

/// Pure helper: remove `path` from the list. Used when the host
/// reports an import failed (e.g. the file moved) so the next session
/// doesn't keep offering a path that can't open.
export function forgetRecentCapture(current: readonly string[], path: string): string[] {
  return current.filter((p) => p !== path);
}
