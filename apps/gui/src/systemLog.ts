// Frontend mirror + filter helpers for the host-side system log.
// The host owns the bounded ring of messages
// (`src-tauri/src/system_log.rs`); the panel renders a filtered view
// over it. This module is the pure logic — sorting / filtering —
// that the panel and unit tests share.

import type { SystemMessage, SystemLogLevel } from "./types";

/// Severity ordering for the panel's minimum-level filter. Must agree
/// with `system_log::LogLevel::rank` on the Rust side.
export const SYSTEM_LOG_LEVEL_RANK: Record<SystemLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/// Filter parameters held in a panel's dockview `params`. `"" |
/// undefined` for `source` is "all sources". Per-panel state, not
/// persisted in the project file.
export interface SystemMessagesPanelParams {
  filterSource?: string;
  minLevel?: SystemLogLevel;
}

/// The default minimum level. `info` is now what the user's own
/// actions produced — a handful of entries per session, not a stream —
/// so it reads as a history of what was done rather than burying the
/// errors. Drop the filter to `debug` for the app's internal
/// breadcrumbs (health samples, sidecar `exec:` / `cwd:` lines,
/// connection plumbing). Everything at every level is already in the
/// rolling log file regardless of this filter.
export const DEFAULT_MIN_LEVEL: SystemLogLevel = "info";

/// Apply the per-panel filter to a chronological message list. Pure
/// function — kept here so it can be unit-tested without rendering.
export function applySystemLogFilter(
  messages: readonly SystemMessage[],
  filterSource: string | undefined,
  minLevel: SystemLogLevel,
): SystemMessage[] {
  const minRank = SYSTEM_LOG_LEVEL_RANK[minLevel];
  const wantSource = filterSource && filterSource.length > 0 ? filterSource : null;
  return messages.filter((m) => {
    if (SYSTEM_LOG_LEVEL_RANK[m.level] < minRank) return false;
    if (wantSource && m.source !== wantSource) return false;
    return true;
  });
}

/// Distinct sources currently in the buffer, sorted ascending. Drives
/// the panel's source-filter dropdown.
export function distinctSources(messages: readonly SystemMessage[]): string[] {
  const seen = new Set<string>();
  for (const m of messages) seen.add(m.source);
  return Array.from(seen).sort();
}

/// Merge an incremental message into the running list, deduplicating
/// against entries already present (matched by `seq`). New messages
/// are appended in chronological order — the host emits `seq`
/// monotonically.
export function mergeSystemMessage(
  current: readonly SystemMessage[],
  incoming: SystemMessage,
): SystemMessage[] {
  if (current.some((m) => m.seq === incoming.seq)) return current.slice();
  return [...current, incoming];
}

/// Replace the running list with a fresh host snapshot, preserving
/// any in-flight tail entries with `seq` past the snapshot's last
/// (the snapshot might race a recent push). Returns the new array.
export function reconcileSnapshot(
  current: readonly SystemMessage[],
  snapshot: readonly SystemMessage[],
): SystemMessage[] {
  if (snapshot.length === 0) return current.slice();
  const last = snapshot[snapshot.length - 1].seq;
  const tail = current.filter((m) => m.seq > last);
  return [...snapshot, ...tail];
}

/// Format a Unix-epoch ms timestamp for display in the panel's
/// timestamp column. Uses 24-hour local time with millisecond
/// precision — the panel's font is monospace so the columns align.
export function formatLogTimestamp(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
    d.getMilliseconds(),
    3,
  )}`;
}

/// Render one message as plain text for copy-entry / copy-all.
export function formatLogLine(m: SystemMessage): string {
  return `${formatLogTimestamp(m.ts_ms)} [${m.level.toUpperCase()}] ${m.source}: ${m.message}`;
}

/// Count entries at or above `warn` past `sinceSeq`. Drives the
/// unread-error badge in the toolbar.
export function unreadWarnOrError(
  messages: readonly SystemMessage[],
  sinceSeq: number,
): number {
  let n = 0;
  for (const m of messages) {
    if (m.seq <= sinceSeq) continue;
    if (SYSTEM_LOG_LEVEL_RANK[m.level] >= SYSTEM_LOG_LEVEL_RANK.warn) n += 1;
  }
  return n;
}
