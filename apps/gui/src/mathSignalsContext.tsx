/// The **math signal** listing shared across every panel that shows one
/// (`docs/CONTEXT.md`): the Database panel's Computed branch, a plot's
/// side list, a signal panel's rows.
///
/// One fetch, one refresh policy. The listing is the host's answer about
/// the registry — membership resolved against the live catalog, the
/// derived unit, the contributing buses, the reason a definition is not
/// usable yet (ADR 0025) — so it moves whenever the catalog does, and
/// three panels each running their own poller would show three
/// different answers on the tick a database loads.
///
/// **The project's bus list is standing host state**, installed on open
/// and refreshed on every bus add / rename / remove, so a math command
/// carries no name map: a set's patterns are evaluated against the
/// canonical signal path (ADR 0038), whose first segment is the bus
/// *name*, and the host already knows what the buses are called. The
/// project's buses are still a refetch *trigger* here — a rename moves
/// what a name-anchored pattern selects, and the host's push of the new
/// list emits no `math-signals-changed`.

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

import type { MathSignalRecord } from "./types";
import { useProjectContext } from "./projectContext";
import { useDbcGeneration } from "./dbcChanged";

export interface MathSignalsContextValue {
  /// Every definition the registry holds, in creation order, with its
  /// membership resolved. Empty until the first fetch lands, and on a
  /// failed one.
  mathSignals: MathSignalRecord[];
  /// Re-read the listing now. The host emits `math-signals-changed` on
  /// every write, so this is only for a caller that wants its own write
  /// reflected without waiting for the round trip.
  refreshMath: () => void;
}

const fallback: MathSignalsContextValue = {
  mathSignals: [],
  refreshMath: () => {},
};

export const MathSignalsContext = createContext<MathSignalsContextValue>(fallback);

export function useMathSignals(): MathSignalsContextValue {
  return useContext(MathSignalsContext);
}

/// Fetches the math listing and shares it with every descendant. Must
/// be mounted inside a `ProjectContext` provider — it reads `buses` as
/// a refetch trigger (see the module doc).
export function MathSignalsProvider({ children }: { children: ReactNode }): ReactNode {
  const { buses } = useProjectContext();
  const [mathSignals, setMathSignals] = useState<MathSignalRecord[]>([]);

  const refreshMath = useCallback(() => {
    void invoke<MathSignalRecord[]>("list_math_signals")
      .then((next) => setMathSignals(Array.isArray(next) ? next : []))
      .catch(() => setMathSignals([]));
  }, []);

  // The catalog's own triggers, plus the registry's: a definition's
  // resolved half is derived from the live signal catalog, so it moves
  // when a database loads or a capture brings file-backed signals in,
  // and `math-signals-changed` covers every write to the registry
  // itself — including one this session did not make. `buses` is a
  // trigger of its own: a pattern is evaluated against the canonical
  // path (ADR 0038), whose first segment is the bus *name*, so a rename
  // moves what a pattern selects — and the host's project-bus sync
  // emits no event of its own.
  const dbcGeneration = useDbcGeneration();
  useEffect(refreshMath, [buses, refreshMath, dbcGeneration]);
  useEffect(() => {
    const subs = [
      listen("math-signals-changed", () => refreshMath()),
      listen("file-signals-changed", () => refreshMath()),
      listen("log-finished", () => refreshMath()),
    ];
    return () => {
      for (const sub of subs) void sub.then((fn) => fn());
    };
  }, [refreshMath]);

  const value = useMemo(
    () => ({ mathSignals, refreshMath }),
    [mathSignals, refreshMath],
  );
  return <MathSignalsContext.Provider value={value}>{children}</MathSignalsContext.Provider>;
}
