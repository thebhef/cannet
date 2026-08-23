// Recent projects.
//
// The N project files most recently opened or saved-as, offered by the
// toolbar's Recent-projects menu and by one palette entry each.
// Persisted host-side (ADR 0032) as *user*-scope state (ADR 0042 §3):
// the sibling of `last_project`, because a list of projects is how you
// get back to the one you are not in, and a project-scoped copy could
// never name the project you want. It is state rather than a setting
// (ADR 0034) — a memo about particular files, not a behavioural choice;
// the *bound* is the choice, and lives in `settings.json` as
// `recent_projects_limit`.
//
// These are the pure list helpers that shape the MRU before it is
// handed to `hostState`.

import { hostSettings } from "./hostSettings";
import { pushRecent } from "./recentMru";

/// Prepend `path` to the MRU, dedupe, cap at the configured depth
/// (`recent_projects_limit`). Re-opening a project therefore moves it
/// back to the front rather than leaving it where it was: the list is
/// ordered by when you last worked in a project, which is the only
/// ordering that stays useful as it fills.
export function recordRecentProject(current: readonly string[], path: string): string[] {
  return pushRecent(current, path, hostSettings().recent_projects_limit);
}

/// Pure helper: remove `path` from the list. Used when an open fails —
/// the project was moved, renamed or deleted — so the next session
/// stops offering a path that cannot open. Nothing probes the
/// filesystem to prune the list ahead of time: an entry on a
/// disconnected network share or an unmounted drive is still the
/// project the user wants, and statting every entry to draw a menu
/// would stall the bar on exactly those paths.
export function forgetRecentProject(current: readonly string[], path: string): string[] {
  return current.filter((p) => p !== path);
}
