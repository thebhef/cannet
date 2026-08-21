/// The view-signals launcher badge's live count (task 89 phase 3): the
/// same `attentionCount` `list_view_signals` gives `ViewSignalsPanel`,
/// read independently of whether the panel is mounted — the whole
/// reason phase 1 put the count host-side
/// (`view_signals::list_view_signals_inner`, `attention_count`) is that
/// it stays live with the panel closed, and this hook is the one place
/// that reads it for the toolbar button.
///
/// Refetches on the same two triggers `ViewSignalsPanel` itself
/// refetches on, so the badge and the panel can never disagree about
/// *when* to ask, on top of already sharing *what* they ask
/// (`list_view_signals`'s one `attentionCount` field): the
/// `view-signals-changed` event (a view's pushed references changed)
/// and the DBC-change generation (ADR 0053 §2/§3, which already covers
/// assignment changes since task 88). The `view-signals-changed` half
/// reuses the shared host-mirror pattern (`useHostMirror.ts`) for its
/// fetch/listen/launch-race machinery; the generation half is folded on
/// top the same way `ViewSignalsPanel` folds it onto its own fetch
/// effect.
///
/// **Cost note.** There is no count-only host command, so a badge
/// refresh calls the same `list_view_signals` the panel does and pulls
/// the full row set even though this hook renders none of it. That is a
/// real cost, not a free one — but it is bounded by how many signals
/// the open views reference (typically small), and it fires only on the
/// two events above, never on a timer, so it does not compound with
/// capture length or session time the way a poll would. A count-only
/// command would remove the row payload; not built here because the
/// event-gated cost was not judged obviously real (task 89 phase 3's
/// status log).

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { ViewSignalPage } from "./types";
import { useDbcGeneration } from "./dbcChanged";
import { useHostMirror } from "./useHostMirror";

async function fetchAttentionCount(): Promise<number> {
  const page = await invoke<ViewSignalPage>("list_view_signals", {
    sortKey: null,
    sortDir: null,
    busNames: [],
  });
  return page.attentionCount;
}

export function useViewSignalsAttentionCount(): number {
  const { value, refresh } = useHostMirror({
    fetch: fetchAttentionCount,
    fallback: 0,
    event: "view-signals-changed",
  });
  // `useHostMirror` already pays mount's fetch and its own post-listener
  // race-closing refetch; folding the DBC generation straight into its
  // dependency array would fire a *third* fetch on mount, since a fresh
  // effect's first run always "changes" from nothing. `App`'s own
  // `seenDbcGenerationRef` guards the identical case for the trace-model
  // epoch — seed the ref with the generation already in hand so only a
  // genuine change past mount triggers a refetch.
  const dbcGeneration = useDbcGeneration();
  const seenDbcGenerationRef = useRef(dbcGeneration);
  useEffect(() => {
    if (seenDbcGenerationRef.current === dbcGeneration) return;
    seenDbcGenerationRef.current = dbcGeneration;
    refresh();
  }, [dbcGeneration, refresh]);
  return value;
}
