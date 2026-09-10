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
/// **Bus names travel with the call.** A set's patterns are evaluated
/// against the canonical signal path (ADR 0038), whose first segment is
/// the bus *name*, and the host keeps no standing record of what a
/// project's buses are called — so the map rides on every math command,
/// exactly as it does on `fetch_signal_page`.

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
  /// The `(id, name)` pairs every math command has to carry. Held here
  /// so a caller that writes a definition sends the same map the
  /// listing was resolved against.
  mathBusNames: [string, string][];
  /// Re-read the listing now. The host emits `math-signals-changed` on
  /// every write, so this is only for a caller that wants its own write
  /// reflected without waiting for the round trip.
  refreshMath: () => void;
}

const fallback: MathSignalsContextValue = {
  mathSignals: [],
  mathBusNames: [],
  refreshMath: () => {},
};

export const MathSignalsContext = createContext<MathSignalsContextValue>(fallback);

export function useMathSignals(): MathSignalsContextValue {
  return useContext(MathSignalsContext);
}

/// Fetches the math listing and shares it with every descendant. Must
/// be mounted inside a `ProjectContext` provider — it reads `buses` for
/// the name map every math command carries.
export function MathSignalsProvider({ children }: { children: ReactNode }): ReactNode {
  const { buses } = useProjectContext();
  const [mathSignals, setMathSignals] = useState<MathSignalRecord[]>([]);

  const mathBusNames = useMemo(
    () => buses.map((b) => [b.id, b.name] as [string, string]),
    [buses],
  );

  const refreshMath = useCallback(() => {
    void invoke<MathSignalRecord[]>("list_math_signals", { busNames: mathBusNames })
      .then((next) => setMathSignals(Array.isArray(next) ? next : []))
      .catch(() => setMathSignals([]));
  }, [mathBusNames]);

  // The catalog's own triggers, plus the registry's: a definition's
  // resolved half is derived from the live signal catalog, so it moves
  // when a database loads or a capture brings file-backed signals in,
  // and `math-signals-changed` covers every write to the registry
  // itself — including one this session did not make.
  const dbcGeneration = useDbcGeneration();
  useEffect(refreshMath, [refreshMath, dbcGeneration]);
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
    () => ({ mathSignals, mathBusNames, refreshMath }),
    [mathSignals, mathBusNames, refreshMath],
  );
  return <MathSignalsContext.Provider value={value}>{children}</MathSignalsContext.Provider>;
}
