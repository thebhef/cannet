// Signal catalog shared across every panel that lists (bus, message,
// signal) triples the attached DBCs define — the plot picker, the
// transmit row's DBC-name lookup, the color-map target picker, the
// signal view's manual-add picker. Each used to run its own
// `list_signals` fetch + refetch-on-change; this fetches once and
// every consumer reads it through `useSignalCatalog()`.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { SignalDescriptorRecord } from "./types";
import { useProjectContext } from "./projectContext";

export interface SignalCatalogContextValue {
  /// One record per (bus, message, signal) triple the attached DBCs
  /// define, expanded per project bus (`list_signals`). Empty until
  /// the first fetch resolves, or on a failed fetch.
  catalog: SignalDescriptorRecord[];
  /// Force a re-fetch. The plot picker's manual "↻ reload signal list"
  /// button is the one consumer that needs this — every other trigger
  /// (bus/DBC-set change, `dbc-changed`) is automatic.
  refresh: () => void;
}

const fallback: SignalCatalogContextValue = { catalog: [], refresh: () => {} };

export const SignalCatalogContext = createContext<SignalCatalogContextValue>(fallback);

export function useSignalCatalog(): SignalCatalogContextValue {
  return useContext(SignalCatalogContext);
}

/// Fetches the signal catalog once and shares it with every descendant
/// via `useSignalCatalog()`. Must be mounted inside a `ProjectContext`
/// provider — it reads `buses` (to scope the query, same as every
/// panel's prior independent fetch) and `dbcPaths` (to refetch when
/// the loaded DBC set changes).
export function SignalCatalogProvider({ children }: { children: ReactNode }): ReactNode {
  const { buses, dbcPaths } = useProjectContext();
  const [catalog, setCatalog] = useState<SignalDescriptorRecord[]>([]);

  const refreshCatalog = useCallback(() => {
    void invoke<SignalDescriptorRecord[]>("list_signals", {
      // The host expands unscoped DBCs to one record per project bus,
      // so every picker can offer the same signal on each bus the DBC
      // applies to.
      projectBuses: buses.map((b) => b.id),
    })
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, [buses]);

  // Refetch on a bus-list change (via refreshCatalog's own `buses`
  // dep) or the loaded DBC-path set changing — `dbcPaths` doesn't
  // otherwise enter the query, so it's called out as an explicit
  // extra dependency (mirrors PlotPanel's/SignalsPanel's prior effect).
  useEffect(refreshCatalog, [refreshCatalog, dbcPaths]);

  // Re-fetch when the host's filesystem watcher reports a loaded DBC
  // changed on disk (content edit, not an add/remove).
  useEffect(() => {
    const unlisten = listen("dbc-changed", () => {
      refreshCatalog();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshCatalog]);

  const value = useMemo(() => ({ catalog, refresh: refreshCatalog }), [catalog, refreshCatalog]);
  return <SignalCatalogContext.Provider value={value}>{children}</SignalCatalogContext.Provider>;
}
