/// The RBS mapping chip's badge: how many signal rows across **every**
/// RBS configuration in the project need attention.
///
/// The chip is not RBS run status — it is the RBS counterpart of the
/// signal mapping chip: a field the resolved DBC does not define, an
/// override naming a signal that no longer exists, a value that will
/// not encode. Combining across configurations is fine for *reporting*
/// and forbidden for *editing*: two RBS configs are meant to carry
/// different values, so their values are never merged, but their
/// faults are independent of that and a project-wide count is the only
/// honest one.
///
/// **Why the count is summed here rather than by the host.** The
/// grid's display status is deliberately a frontend decision — Out of
/// Range is decided by `rbsSignalsFilter`, not by the host, because
/// truncation on transmit is correct and the encoder has nothing to
/// flag. A host-side count would therefore be a *different* number
/// from the one the panel shows, and a badge that disagrees with the
/// panel it opens is worse than one that costs a per-config fetch.
/// So this reuses the same rule the grid uses, over the same host
/// rows.
///
/// **Cost note.** A refresh calls `rbs_signal_rows` once per config.
/// Each answer is bounded by that config's own row set, and the
/// refresh is event-gated (`rbs-changed`, plus the DBC-change
/// generation) rather than polled, so it does not compound with
/// capture length or session time.

import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { RbsSignalRow } from "./types";
import { RBS_SIGNAL_PROBLEM_STATUSES, rbsSignalDisplayStatus } from "./rbsSignalsFilter";
import { useDbcGeneration } from "./dbcChanged";
import { useHostMirror } from "./useHostMirror";

/// Separator for the memo key over the element id list — an id cannot
/// contain a NUL, so the join is unambiguous.
const KEY_SEP = "\u0000";

function problemsIn(rows: readonly RbsSignalRow[] | null): number {
  if (rows === null) return 0;
  return rows.filter((r) => RBS_SIGNAL_PROBLEM_STATUSES.includes(rbsSignalDisplayStatus(r))).length;
}

export function useRbsAttentionCount(elementIds: readonly string[]): number {
  // The ids are a fresh array every render at the call site; key off
  // their contents so the fetch identity — which gates `useHostMirror`'s
  // listener effect — only changes when the set actually does.
  const key = elementIds.join(KEY_SEP);
  const fetch = useCallback(async () => {
    const ids = key === "" ? [] : key.split(KEY_SEP);
    const perConfig = await Promise.all(
      ids.map((elementId) => invoke<RbsSignalRow[] | null>("rbs_signal_rows", { elementId })),
    );
    return perConfig.reduce((sum, rows) => sum + problemsIn(rows), 0);
  }, [key]);
  const { value, refresh } = useHostMirror({ fetch, fallback: 0, event: "rbs-changed" });
  // The DBC-change generation half, folded on the same way the view
  // signals badge folds it: seed the ref with the generation already in
  // hand so only a genuine change past mount triggers a refetch, rather
  // than a third fetch on top of the mirror's own mount pair.
  const dbcGeneration = useDbcGeneration();
  const seenDbcGenerationRef = useRef(dbcGeneration);
  useEffect(() => {
    if (seenDbcGenerationRef.current === dbcGeneration) return;
    seenDbcGenerationRef.current = dbcGeneration;
    refresh();
  }, [dbcGeneration, refresh]);
  return value;
}
