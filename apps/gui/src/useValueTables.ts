/**
 * Shared value-table fetch for signal-carrying panels.
 *
 * Several panels need a signal's enum labels — the plot panel (enum
 * detection + the side-panel `<label> (<raw>)` readout), the colormap
 * panel, the transmit panel, the RBS panel. This hook is the one
 * fetcher they share: give it the signals you care about and it
 * returns a map from the canonical `signalKey` to that signal's value
 * table, omitting signals the host has no table for. It re-fetches
 * when the signal-list identity changes; callers that build the list
 * inline should `useMemo` it so the effect doesn't re-run every render.
 *
 * A DBC-backed signal's table is its `VAL_` rows; a file-backed one's
 * is the value-to-text conversion its channel carried into the capture.
 * Both come back through this one fetch, in the same shape, so a panel
 * labels either kind without knowing which it has.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { signalKey } from "./plotData";
import { useDbcGeneration } from "./dbcChanged";
import type { ValueTableEntryRecord } from "./types";
import type { ComboboxOption } from "./Combobox";
import { diagCount } from "./diag"; // DIAG

/** The minimal signal identity `useValueTables` needs — a subset of
 * the panels' richer signal refs. */
export interface ValueTableSignal {
  busId: string | null;
  messageId: number;
  extended: boolean;
  signalName: string;
  /// Which namespace `messageId` is in: a CAN id for a DBC-backed
  /// signal, the source file's signal channel group index for a
  /// file-backed one. The host needs it to know which table to look
  /// up — a coded MDF channel's labels come from its own conversion,
  /// not from any DBC.
  fileBacked?: boolean;
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
  //
  // Sorted, so the key is the set and not the sequence: the result is a
  // map from signal key to table, so reordering the request cannot
  // change the answer — and refetching would replace that map, which for
  // a caller deriving state from it reads as "every signal's table
  // changed".
  const signalsKey = useMemo(
    () =>
      signals
        .map((s) => signalKey(s.busId, s.messageId, s.extended, s.signalName, s.fileBacked))
        .sort()
        .join("|"),
    [signals],
  );
  const signalsRef = useRef(signals);
  signalsRef.current = signals;
  // The other half of the fetch's identity: which labels the host has
  // to give is a function of the loaded DBC set as much as of the
  // signals asked about (ADR 0053 §4). Without it a panel that asked
  // before its project's DBCs were installed caches "no table" for the
  // session and recovers only on a remount.
  const dbcGeneration = useDbcGeneration();
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
            fileBacked: s.fileBacked ?? false,
            busId: s.busId,
          });
          if (rows.length > 0) {
            accum.set(
              signalKey(s.busId, s.messageId, s.extended, s.signalName, s.fileBacked),
              rows,
            );
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
  }, [signalsKey, dbcGeneration]);
  return tables;
}

/**
 * One `Combobox` option per `VAL_` row — the shared shape every enum
 * value picker renders, so they cannot drift apart.
 *
 * The row text is a single line, `<label> (<raw>)`: the same enum
 * readout the plot's side panel uses (`formatValueFor` in
 * `PlotArea.tsx`), which is why it carries the space the app's other
 * parenthesised readouts do. The submitted value is the **label** —
 * the RBS file stores labels (`RbsValue::Text`), and a cell that needs
 * the raw maps back through the same table it built these from.
 */
export function valueTableOptions(
  rows: readonly ValueTableEntryRecord[],
): ComboboxOption[] {
  return rows.map((r) => ({ value: r.label, label: `${r.label} (${r.raw})` }));
}
