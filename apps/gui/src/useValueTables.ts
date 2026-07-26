/**
 * Shared value-table (`VAL_`) fetch for signal-carrying panels.
 *
 * Several panels need a signal's enum labels — the plot panel (enum
 * detection + the side-panel `<label> (<raw>)` readout), the colormap
 * panel, the transmit panel, the RBS panel. This hook is the one
 * fetcher they share: give it the signals you care about and it
 * returns a map from the canonical `signalKey` to that signal's value
 * table, omitting signals the host has no table for. It re-fetches
 * when the signal-list identity changes; callers that build the list
 * inline should `useMemo` it so the effect doesn't re-run every render.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { signalKey } from "./plotData";
import type { ValueTableEntryRecord } from "./types";
import { diagCount } from "./diag"; // DIAG

/** The minimal signal identity `useValueTables` needs — a subset of
 * the panels' richer signal refs. */
export interface ValueTableSignal {
  busId: string | null;
  messageId: number;
  extended: boolean;
  signalName: string;
}

/** Fetch each signal's `VAL_` table, keyed by canonical `signalKey`.
 * Signals with no table (or a failed lookup) are simply absent. */
export function useValueTables(
  signals: readonly ValueTableSignal[],
): Map<string, ValueTableEntryRecord[]> {
  const [tables, setTables] = useState<Map<string, ValueTableEntryRecord[]>>(new Map());
  // Key the fetch on the signal *set* (their canonical keys), not the
  // array's identity: callers routinely rebuild the list every render
  // (memoized derived state), and an identity-keyed effect would then
  // refetch → setState → re-render forever. `signalsRef` gives the
  // effect the live list without widening its dependency.
  const signalsKey = useMemo(
    () => signals.map((s) => signalKey(s.busId, s.messageId, s.extended, s.signalName)).join("|"),
    [signals],
  );
  const signalsRef = useRef(signals);
  signalsRef.current = signals;
  useEffect(() => {
    let cancelled = false;
    const accum = new Map<string, ValueTableEntryRecord[]>();
    Promise.all(
      signalsRef.current.map(async (s) => {
        try {
          diagCount("invoke.list_value_tables"); // DIAG
          const rows = await invoke<ValueTableEntryRecord[]>("list_value_tables", {
            messageId: s.messageId,
            extended: s.extended,
            signalName: s.signalName,
          });
          if (rows.length > 0) {
            accum.set(signalKey(s.busId, s.messageId, s.extended, s.signalName), rows);
          }
        } catch {
          /* signal stays numeric */
        }
      }),
    ).then(() => {
      if (!cancelled) setTables(accum);
    });
    return () => {
      cancelled = true;
    };
  }, [signalsKey]);
  return tables;
}
