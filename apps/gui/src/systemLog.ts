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
///
/// The *minimum level* is deliberately not here: "how verbose do I want
/// my log view" is a preference that outlives a panel, so it lives in
/// `settings.json` as `system_log_min_level` (ADR 0034). The source
/// filter is genuinely view-local and stays.
export interface SystemMessagesPanelParams {
  filterSource?: string;
}

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

/// Entries the frontend mirror holds. Matches the host ring's
/// `RING_CAPACITY` (`src-tauri/src/system_log.rs`), which is the most a
/// snapshot can ever deliver — mirroring more would hold entries the
/// panel can never be shown again, and would grow the mirror with
/// session time, which the paging rule in CLAUDE.md forbids outright.
export const SYSTEM_LOG_MIRROR_CAPACITY = 4096;

/// The frontend's bounded mirror of the host ring, plus the badge
/// bookkeeping. One value rather than three pieces of state so the tally
/// can be maintained *incrementally* — every transition that changes the
/// message list updates it in the same step, instead of the toolbar
/// re-scanning the whole mirror whenever a message arrives.
export interface SystemLogMirror {
  /// Chronological view of the buffer, newest last, at most
  /// [`SYSTEM_LOG_MIRROR_CAPACITY`] entries.
  messages: SystemMessage[];
  /// Highest `seq` the user has seen. `-1` = nothing read yet. Survives
  /// a clear: the host keeps counting `seq` across one.
  readSeq: number;
  /// Entries at or above `warn` with `seq > readSeq` — the toolbar badge.
  unread: number;
}

export const EMPTY_SYSTEM_LOG_MIRROR: SystemLogMirror = {
  messages: [],
  readSeq: -1,
  unread: 0,
};

/// Drop the oldest entries so `messages` fits the cap.
function capped(messages: SystemMessage[]): SystemMessage[] {
  return messages.length > SYSTEM_LOG_MIRROR_CAPACITY
    ? messages.slice(messages.length - SYSTEM_LOG_MIRROR_CAPACITY)
    : messages;
}

function isWarnOrError(m: SystemMessage): boolean {
  return SYSTEM_LOG_LEVEL_RANK[m.level] >= SYSTEM_LOG_LEVEL_RANK.warn;
}

/// Merge an incremental message into the mirror. The host emits `seq`
/// monotonically, so the snapshot/event race is deduplicated against the
/// tail alone — no scan of the mirror per appended message. Returns the
/// same mirror when there is nothing to add.
export function mergeSystemMessage(
  mirror: SystemLogMirror,
  incoming: SystemMessage,
): SystemLogMirror {
  const last = mirror.messages[mirror.messages.length - 1];
  if (last != null && incoming.seq <= last.seq) return mirror;
  return {
    messages: capped([...mirror.messages, incoming]),
    readSeq: mirror.readSeq,
    unread:
      mirror.unread + (incoming.seq > mirror.readSeq && isWarnOrError(incoming) ? 1 : 0),
  };
}

/// Replace the mirror's list with a fresh host snapshot, preserving any
/// in-flight tail entries with `seq` past the snapshot's last (the
/// snapshot might race a recent push). This is the one place the unread
/// tally is recomputed in bulk — it runs once, on the boot snapshot, so
/// the append path never has to.
export function reconcileSnapshot(
  mirror: SystemLogMirror,
  snapshot: readonly SystemMessage[],
): SystemLogMirror {
  const messages =
    snapshot.length === 0
      ? mirror.messages.slice()
      : [
          ...snapshot,
          ...mirror.messages.filter((m) => m.seq > snapshot[snapshot.length - 1].seq),
        ];
  return {
    messages: capped(messages),
    readSeq: mirror.readSeq,
    unread: unreadWarnOrError(messages, mirror.readSeq),
  };
}

/// Mark everything currently held as read — the badge clears and stays
/// clear until a *new* warn or error arrives.
export function markSystemLogRead(mirror: SystemLogMirror): SystemLogMirror {
  const last = mirror.messages[mirror.messages.length - 1];
  return {
    messages: mirror.messages,
    readSeq: last != null ? Math.max(mirror.readSeq, last.seq) : mirror.readSeq,
    unread: 0,
  };
}

/// Empty the mirror (the host's ring is cleared alongside). The read
/// mark is kept: the host does *not* reset its `seq` counter, so
/// resetting it here would re-arm the badge on the next message.
export function clearSystemLogMirror(mirror: SystemLogMirror): SystemLogMirror {
  return { messages: [], readSeq: mirror.readSeq, unread: 0 };
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

/// Count entries at or above `warn` past `sinceSeq`. The bulk recount
/// behind [`reconcileSnapshot`]; the live path maintains the tally
/// incrementally instead of calling this per message.
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
