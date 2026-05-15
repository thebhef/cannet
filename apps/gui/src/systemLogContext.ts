// Session-scoped React context holding the live system-log buffer and
// the unread-badge bookkeeping (Phase 7). One instance per App tree,
// initialised in App.tsx; consumed by the panel and the toolbar badge.

import { createContext, useContext } from "react";

import type { SystemMessage } from "./types";

export interface SystemLogContextValue {
  /// Current chronological view of the buffer — host snapshot merged
  /// with incremental `system-log-appended` events.
  messages: SystemMessage[];
  /// Number of unread warn+error entries since the panel last
  /// gained focus. Drives the toolbar badge.
  unread: number;
  /// Clear the buffer (host + frontend mirror).
  clear: () => void;
  /// Mark every current warn/error as read — the toolbar badge clears
  /// and stays clear until a *new* warn/error arrives.
  markRead: () => void;
}

const fallback: SystemLogContextValue = {
  messages: [],
  unread: 0,
  clear: () => {},
  markRead: () => {},
};

export const SystemLogContext = createContext<SystemLogContextValue>(fallback);

export function useSystemLog(): SystemLogContextValue {
  return useContext(SystemLogContext);
}
