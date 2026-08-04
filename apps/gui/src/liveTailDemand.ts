/// Live-tail demand: which views want the newest frames shipped with
/// every `trace-grew`, and how many.
///
/// The host emits `trace-grew` ~10 Hz while a capture runs, and used to
/// collect and decode 256 trailing frames on every one of them whether or
/// not anything read them. Only an *auto-scrolling chronological* view
/// does: it overlays the tail so the live edge never shows a placeholder
/// between throttled re-pages (ADR 0025). With no trace panel open, or
/// all of them by-id / filtered / parked, that was ~2560 decoded records
/// a second for nobody.
///
/// So demand is declared rather than assumed. Each interested view
/// registers the size it wants; the largest live demand is pushed to the
/// host, and the host ships nothing (and skips the decode) while the
/// aggregate is zero — which is also its startup state.

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/// Rows an auto-scrolling chronological view asks for. Matches the host's
/// own ceiling: comfortably more than any plausible visible-row count, so
/// the overlay covers the whole viewport on a big display.
export const LIVE_TAIL_ROWS = 256;

const demands = new Map<string, number>();
/// The size last pushed to the host, so an unchanged aggregate makes no
/// round-trip. `null` before the first push.
let declared: number | null = null;

function publish(): void {
  let want = 0;
  for (const n of demands.values()) if (n > want) want = n;
  if (want === declared) return;
  declared = want;
  void invoke("set_live_tail_rows", { rows: want }).catch(() => {
    /* best effort — a missed declaration costs a tail, not correctness */
  });
}

/// Declare this view's live-tail demand under `id` for as long as it is
/// mounted. `rows: 0` withdraws it (parked, stopped, or a mode that
/// doesn't read the tail) without unmounting.
export function useLiveTailDemand(id: string, rows: number): void {
  useEffect(() => {
    demands.set(id, rows);
    publish();
    return () => {
      demands.delete(id);
      publish();
    };
  }, [id, rows]);
}

/// Drop every registered demand and forget what was last pushed. For
/// tests, which share one module instance across the cases in a file.
export function resetLiveTailDemand(): void {
  demands.clear();
  declared = null;
}
