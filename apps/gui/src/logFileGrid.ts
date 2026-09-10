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

/// UTC ISO 8601, seconds resolution (`2026-09-04T23:11:22Z`) — the
/// gridview's "trace start" / "trace end" columns. Unambiguous across
/// readers in different zones, which a table column that outlives its
/// capture session needs and a wall-clock label next to "now" does not
/// (the export dialog's informational start/end labels render local
/// time instead, for exactly that reason).
export function formatLogTimestamp(ns: number | null): string {
  if (ns == null) return "";
  return new Date(Math.round(ns / 1e6)).toISOString().replace(/\.\d+Z$/, "Z");
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

/// Filesystem modified time, local — a file property read off disk, not
/// a capture-relative instant, so it reads the way a file manager's
/// "Date modified" column does.
export function formatLogModified(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/// A message count includes both directions (the capture holds rx and
/// tx alike, and a logger writes the whole thing) — roughly twice the
/// rx rate on a project with an RBS running, which is worth a tooltip
/// note rather than a silent surprise.
export const MESSAGE_COUNT_HINT = "Frame count includes both received and transmitted messages.";
