/// The logger folder's file gridview (ADR 0044): the host's recursive
/// `.blf` tree (`list_logger_files`) flattened into gridview rows, and
/// the formatting the columns render. Pure — no DOM, no React —
/// `LoggerFileGrid.tsx` binds this to `useGridview`.
///
/// The tree, the per-file header metadata (start/end/message count) and
/// the writing row's live numbers are all the host's (`log_files.rs`):
/// this module shapes already-served data for the gridview, the same
/// division `gridviewRows.ts` documents for every other panel (CLAUDE.md
/// § GUI architecture).

import { formatCalendarTime } from "./format";

/// One file, mirroring `log_files::LogFileNode::File`. `startNs` /
/// `endNs` are `null` for a file with no frames, or for the file
/// currently being written — its header is not finished, so the host
/// never scans it (see `writing`).
export interface LogFileEntry {
  kind: "file";
  id: string;
  name: string;
  sizeBytes: number;
  startNs: number | null;
  endNs: number | null;
  messageCount: number;
  modifiedMs: number;
  /// The host has not read this file's header yet — a background scan is
  /// queued or running for it, and `startNs` / `endNs` / `messageCount`
  /// carry no information. Those columns render as pending
  /// (`PENDING_CELL`) until the scan announces itself
  /// (`LOG_FILES_SCANNED_EVENT`) and the grid re-asks.
  scanPending: boolean;
  /// This is the file a logger is writing right now: `sizeBytes` and
  /// `messageCount` are live (`get_logger_statuses`), not header-scanned,
  /// and it renders as the gridview's live status row (ruling: no
  /// separate logging status line).
  writing: boolean;
}

/// One directory, mirroring `log_files::LogFileNode::Dir`. Only ever
/// present when it holds a `.blf` somewhere below — the host drops an
/// empty branch rather than listing it.
export interface LogDirEntry {
  kind: "dir";
  id: string;
  name: string;
  children: LogFileNode[];
}

export type LogFileNode = LogFileEntry | LogDirEntry;

/// One row of the flattened space: the node plus its nesting depth
/// (`gridviewRows.ts`'s `GridviewRow.depth`).
export interface FlatLogRow {
  node: LogFileNode;
  depth: number;
}

/// Flatten the tree into display order, honouring which directories are
/// expanded: a branch's children appear in the space only while it is
/// open (ADR 0044) — the same contract `arrayRowSpace` wants.
export function flattenLogTree(
  nodes: readonly LogFileNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
  out: FlatLogRow[] = [],
): FlatLogRow[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.kind === "dir" && expanded.has(node.id)) {
      flattenLogTree(node.children, expanded, depth + 1, out);
    }
  }
  return out;
}

/// The node named `id` anywhere in the tree, or `null`. Used to resolve
/// the cursor's row into the file the import/reveal actions act on.
export function findLogNode(nodes: readonly LogFileNode[], id: string): LogFileNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === "dir") {
      const found = findLogNode(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

/// A file's absolute path on disk, given the folder it was listed under
/// and its dotted position in the tree — reconstructed from the node ids
/// (each one already the absolute path the host walked; see
/// `log_files::path_id`), so this is just "return the id".
export function logNodePath(node: LogFileNode): string {
  return node.id;
}

/// The path separator the host writes with, read off the absolute
/// folder it resolved. The frontend has no other way to know which OS
/// it is drawing for, and the folder is one of that OS's own paths — so
/// a directory row is marked `logs\` on Windows and `logs/` on a mac,
/// rather than everyone getting Windows'.
export function logPathSeparator(folder: string): string {
  return folder.includes("\\") ? "\\" : "/";
}

/// Whether a row may be selected / imported: leaf files that are not the
/// live-writing one. A directory has nothing to import; the writing row
/// is mid-write and has no finished slice to select a range from.
export function isSelectableLogNode(node: LogFileNode): boolean {
  return node.kind === "file" && !node.writing;
}

/// The gridview's "trace start" / "trace end" columns, rendered per the
/// user's `date_time_pattern` setting (ADR 0062) like every other
/// calendar time in the app. `null` for a file with no frames, or for
/// the writing row (its header is not finished). `seconds` is passed as
/// its own anchor — a scanned header's start/end is always a real
/// instant, never a capture-relative one — so `formatCalendarTime`'s
/// wall-clock check is trivially satisfied.
export function formatLogTimestamp(ns: number | null, pattern: string): string {
  if (ns == null) return "";
  const seconds = ns / 1e9;
  return formatCalendarTime(seconds, seconds, pattern) ?? "";
}

/// A file's span as `h` / `min` / `s`, the coarsest unit that keeps the
/// number readable — matching the behavioural prototype's duration
/// column. `null` when either end is unknown (the writing row, or a file
/// with no frames).
export function formatLogDuration(startNs: number | null, endNs: number | null): string {
  if (startNs == null || endNs == null) return "";
  const seconds = Math.max(0, (endNs - startNs) / 1e9);
  if (seconds >= 5400) return `${(seconds / 3600).toFixed(1)} h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${seconds.toFixed(1)} s`;
}

export function formatLogSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/// Filesystem modified time — a file property read off disk, not a
/// capture-relative instant, rendered through the same `date_time_pattern`
/// setting as every other calendar time. `seconds` is passed as its own
/// anchor, like `formatLogTimestamp`.
export function formatLogModified(ms: number, pattern: string): string {
  const seconds = ms / 1000;
  return formatCalendarTime(seconds, seconds, pattern) ?? "";
}

/// What a trace column shows while its file's header scan is still
/// queued or running. An ellipsis rather than a blank: blank is what a
/// file with no frames shows, and the two are different answers.
export const PENDING_CELL = "\u2026";

/// Why a row's trace columns are empty right now. On the cell's title so
/// a user who wonders need not guess whether the file is unreadable.
export const PENDING_CELL_HINT = "Reading this file's header…";

/// A message count includes both directions (the capture holds rx and
/// tx alike, and a logger writes the whole thing) — roughly twice the
/// rx rate on a project with an RBS running, which is worth a tooltip
/// note rather than a silent surprise.
export const MESSAGE_COUNT_HINT = "Frame count includes both received and transmitted messages.";

/// The row context menu's reveal entry, named for the platform's own
/// file manager rather than one fixed word — `reveal.rs`'s
/// `reveal_command` is what actually runs. Windows and mac each select
/// the file in a named application; the generic Unix fallback opens the
/// containing folder with whatever the desktop registers, which has no
/// one name across file managers, hence the neutral phrasing.
export function revealLabel(isMac: boolean, isWindows: boolean): string {
  if (isMac) return "Show in Finder";
  if (isWindows) return "Show in Explorer";
  return "Show in file manager";
}
