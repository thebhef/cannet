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

/// One project directory's row, as the host serves it.
export interface ProjectCacheRow {
  /// The project directory itself. Neither action touches it.
  root: string;
  /// The cannet-managed cache directory Clear empties and Delete removes.
  cache: string;
  project_file: string | null;
  /// Bytes the cache currently holds, measured when the list was asked
  /// for.
  bytes: number;
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

/// What the row's badge reads.
export function badgeLabel(state: ProjectCacheState): string {
  switch (state) {
    case "active":
      return "active";
    case "missing":
      return "project gone";
    case "auto-located":
      return "auto-located";
    case "orphaned":
      return "no project file";
    case "known":
      return "known";
  }
}

/// Clear is offered wherever there is something to empty — and means the
/// same thing on every row, which is why a missing project's row stays
/// listed at zero bytes rather than vanishing.
export function canClear(row: ProjectCacheRow): boolean {
  return row.bytes > 0;
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
/// between them.
export function cacheSummary(rows: readonly ProjectCacheRow[]): string {
  const total = rows.reduce((sum, r) => sum + r.bytes, 0);
  return `${rows.length} project${rows.length === 1 ? "" : "s"} · ${formatBytes(total)} cached`;
}
