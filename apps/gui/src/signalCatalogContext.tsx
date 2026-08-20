// Signal catalog shared across every panel that lists (bus, message,
// signal) triples the attached DBCs define — the plot picker, the
// transmit row's DBC-name lookup, the color-map target picker, the
// signal view's regex-pattern matching. Each used to run its own
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
import { useDbcGeneration } from "./dbcChanged";

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
/// provider — it reads `buses` (to refetch when the project's bus list
/// moves) and `dbcPaths` (to refetch when the loaded DBC set changes).
export function SignalCatalogProvider({ children }: { children: ReactNode }): ReactNode {
  const { buses, dbcPaths } = useProjectContext();
  const [catalog, setCatalog] = useState<SignalDescriptorRecord[]>([]);

  const refreshCatalog = useCallback(() => {
    // The host expands each database across the buses it is *assigned*
    // to, so the catalog is a function of the loaded set and its
    // assignments alone — the project's bus list is not an input.
    void invoke<SignalDescriptorRecord[]>("list_signals")
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, [buses]);

  // Refetch on a bus-list change (via refreshCatalog's own `buses`
  // dep), on the loaded DBC-path set changing — `dbcPaths` doesn't
  // otherwise enter the query, so it's called out as an explicit
  // extra dependency (mirrors PlotPanel's/SignalsPanel's prior effect)
  // — and on the host's DBC-change carrier, which is what covers a
  // change the frontend did not make: a file edited on disk, a
  // capture's embedded databases (ADR 0053 §3). The catalog reads that
  // carrier through the shared subscription rather than listening for
  // `dbc-changed` itself.
  const dbcGeneration = useDbcGeneration();
  useEffect(refreshCatalog, [refreshCatalog, dbcPaths, dbcGeneration]);

  // Re-fetch when a capture import finishes. The catalog is not purely
  // a function of the DBC set any more: a capture file can carry
  // file-backed signals (`docs/CONTEXT.md`), which exist only once the
  // import that read them has run.
  useEffect(() => {
    const unlisten = listen("log-finished", () => {
      refreshCatalog();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshCatalog]);

  // Re-fetch on `file-signals-changed` — the host emits this whenever
  // the file-backed signal set moves outside an import (a Clear, or
  // restoring a scratch capture), which `log-finished` doesn't cover.
  useEffect(() => {
    const unlisten = listen("file-signals-changed", () => {
      refreshCatalog();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshCatalog]);

  const value = useMemo(() => ({ catalog, refresh: refreshCatalog }), [catalog, refreshCatalog]);
  return <SignalCatalogContext.Provider value={value}>{children}</SignalCatalogContext.Provider>;
}
