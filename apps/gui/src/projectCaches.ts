// The project cache list: what the host knows about every project
// directory it holds cached data for, and the two actions over it
// (ADR 0042 §5).
//
// The host owns the model — the registry, the sizes, and the rules about
// what may be done to a row. This module types that answer and adds the
// small amount of view logic the renderer needs: a badge label, a
// summary line, and the enable/disable rules, each of which is a
// statement about the ADR's table rather than a re-derivation of host
// state.
//
// **Sizes are asked for, never polled.** Each row's figure comes from a
// directory walk, which is far too expensive to put on a timer
// (ADR 0002 DS-8), so the list loads when the panel opens, when the open
// project changes, and after an action changes something.
//
// **And the list never waits for one** (ADR 0049). The host answers with
// the rows and `bytes: null` for any cache it has not measured, runs one
// background walk, and announces it with `PROJECT_CACHES_MEASURED_EVENT`;
// the view renders those rows with a pending size and asks again when
// the event lands.

import { invoke } from "@tauri-apps/api/core";

import { formatBytes } from "./statusLine";

/// The one badge a row wears. `active` outranks the rest — the open
/// project's directory exists by construction — `missing` is a project
/// directory deleted outside the app, and `orphaned` one whose project
/// file moved away and left the `.cannet/` un-paired.
export type ProjectCacheState =
  | "active"
  | "missing"
  | "auto-located"
  | "orphaned"
  | "known";

/// Host event: a background measurement of the registered caches has
/// finished, so the pending sizes have numbers now. Must match
/// `project_registry::PROJECT_CACHES_MEASURED_EVENT`.
export const PROJECT_CACHES_MEASURED_EVENT = "project-caches-measured";

/// One project directory's row, as the host serves it.
export interface ProjectCacheRow {
  /// The project directory itself. Neither action touches it.
  root: string;
  /// The cannet-managed cache directory Clear empties and Delete removes.
  cache: string;
  project_file: string | null;
  /// Bytes the cache held when it was last measured, or `null` while
  /// that measurement is still pending — a cache never walked, or one a
  /// Clear or Delete has invalidated. Pending is not zero: zero is a
  /// measured empty cache.
  bytes: number | null;
  state: ProjectCacheState;
  /// Whether cannet chose the location. Distinct from `state`, because
  /// the open project may be auto-located too — and that is the row the
  /// `Save as…` offer belongs on.
  auto_located: boolean;
  last_used_seconds: number;
}

/// Load the list, sizes and all. Tolerant of no host (unit tests, a
/// failed command): an empty list renders an empty group rather than
/// throwing — a stale or unreadable registry must never stop the panel
/// opening.
export async function loadProjectCaches(): Promise<ProjectCacheRow[]> {
  try {
    return (await invoke<ProjectCacheRow[] | null>("list_project_caches")) ?? [];
  } catch {
    return [];
  }
}

/// **Clear** one project's cached data. The cache directory, the registry
/// entry, and the project directory all stay; for the open project this
/// is the existing Clear — "discard this session".
export async function clearProjectCache(root: string): Promise<void> {
  await invoke("clear_project_cache", { root });
}

/// **Delete** one project's cache directory and forget the project. The
/// project directory itself is not touched. Refused for the open project.
export async function deleteProjectCache(root: string): Promise<void> {
  await invoke("delete_project_cache", { root });
}

/// **Clear all**: empty every cache, remove nothing.
export async function clearAllProjectCaches(): Promise<void> {
  await invoke("clear_all_project_caches");
}

/// What the row's badge reads. `auto-located` reads as `known`: the
/// location chip beside the badge (`locationLabel`) is what now says a
/// row is auto-located, so the badge saying it too would put
/// "auto-located · auto-located" on the same row for no added
/// information — the badge's job is the state, not the location.
export function badgeLabel(state: ProjectCacheState): string {
  switch (state) {
    case "active":
      return "active";
    case "missing":
      return "project gone";
    case "auto-located":
      return "known";
    case "orphaned":
      return "no project file";
    case "known":
      return "known";
  }
}

/// What the row's location chip reads, beside the state badge
/// (owner review, 2026-09-22): `auto-located` for cache space,
/// `project dir` for a directory the user made. Distinct from
/// `badgeLabel`, which is about the row's *state* (active, missing, …)
/// and no longer repeats the location.
export function locationLabel(row: ProjectCacheRow): string {
  return row.auto_located ? "auto-located" : "project dir";
}

/// Clear is offered wherever there is something to empty — and means the
/// same thing on every row, which is why a missing project's row stays
/// listed at zero bytes rather than vanishing. A row whose size is still
/// being measured keeps the offer: Clear on an empty cache is a no-op,
/// and a button that appears a second later is worse than one that does
/// nothing.
export function canClear(row: ProjectCacheRow): boolean {
  return row.bytes == null || row.bytes > 0;
}

/// Delete is unavailable for the open project: its store is mapped, so
/// its cache directory cannot be removed underneath it. Clear is what
/// that project takes.
export function canDelete(row: ProjectCacheRow): boolean {
  return row.state !== "active";
}

/// `Save as…` is offered on the rows living in cache space — this list is
/// the one place a user sees that — and can only be taken on the project
/// that is open, since Save As moves the *session's* project.
export function offersSaveAs(row: ProjectCacheRow): boolean {
  return row.auto_located;
}

export function canSaveAs(row: ProjectCacheRow): boolean {
  return row.auto_located && row.state === "active";
}

/// The header line: how many projects, and how much disk they hold
/// between them. While any row's size is still being measured the total
/// would be a sum of an incomplete set, so the line says it is measuring
/// rather than quoting a figure that is about to change.
export function cacheSummary(rows: readonly ProjectCacheRow[]): string {
  const count = `${rows.length} project${rows.length === 1 ? "" : "s"}`;
  if (rows.some((r) => r.bytes == null)) return `${count} · measuring…`;
  const total = rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  return `${count} · ${formatBytes(total)} cached`;
}
