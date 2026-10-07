// A test double of the host's `events_page` (`events_page.rs`) for the
// DOM tests that mount the Events panel: the same merge — authored events,
// the truncation marker, then each asked-for bus's episodes, by time, ties
// in that order — the same filters and the same paging, over plain arrays.
// The host's own tests pin the real merge; this lets a panel test say what
// the model holds and read what the panel draws of it.

import type { Note } from "./notes";
import type { BusErrorEpisodeWire } from "./useBusErrorMarkers";
import type { EventsPageRowWire, EventsPageWire } from "./useEventsPage";

export interface FakeEventsHost {
  /// The authored events, as the notes store holds them.
  notes: readonly Note[];
  /// The oldest retained frame's time when history was truncated.
  truncationTsNs: number | null;
  /// Every bus's episodes, oldest first per bus. Large fixtures may
  /// generate them instead (see `episodesOf`).
  episodes: readonly BusErrorEpisodeWire[];
  /// Overrides `episodes` for a fixture too big to hold.
  episodesOf?: (bus: string) => readonly BusErrorEpisodeWire[];
  complete: boolean;
  version: number;
}

export function fakeEventsHost(): FakeEventsHost {
  return { notes: [], truncationTsNs: null, episodes: [], complete: true, version: 0 };
}

/// Answer one `events_page` call the way the host would.
export function answerEventsPage(
  host: FakeEventsHost,
  args: Record<string, unknown> | undefined,
): EventsPageWire {
  const buses = (args?.buses as string[] | undefined) ?? [];
  const kinds = new Set((args?.kinds as string[] | undefined) ?? []);
  const tag = String(args?.tagQuery ?? "").trim().toLowerCase();
  const offset = Number(args?.offset ?? 0);
  const limit = Number(args?.limit ?? 0);
  const fromEnd = Boolean(args?.fromEnd);

  const rows: { t: number; list: number; row: EventsPageRowWire }[] = [];
  for (const n of host.notes) {
    if (!kinds.has(n.kind ?? "note")) continue;
    if (tag !== "" && !(n.tag ?? "").toLowerCase().includes(tag)) continue;
    rows.push({ t: n.timestampNs / 1e9, list: 0, row: { row: "note", ...n } });
  }
  if (tag === "" && kinds.has("truncation") && host.truncationTsNs != null) {
    rows.push({
      t: host.truncationTsNs / 1e9,
      list: 1,
      row: { row: "truncation", timestampNs: host.truncationTsNs },
    });
  }
  if (tag === "" && kinds.has("busError")) {
    buses.forEach((bus, i) => {
      const list = host.episodesOf?.(bus) ?? host.episodes.filter((e) => e.bus === bus);
      for (const e of list) rows.push({ t: e.firstT, list: 2 + i, row: { row: "busError", ...e } });
    });
  }
  // Stable: within a list, its own order holds.
  rows.sort((a, b) => a.t - b.t || a.list - b.list);
  const count = rows.length;
  const start = fromEnd ? Math.max(0, count - limit) : Math.min(offset, count);
  return {
    count,
    start,
    rows: rows.slice(start, start + limit).map((r) => r.row),
    complete: host.complete,
    version: host.version,
  };
}
