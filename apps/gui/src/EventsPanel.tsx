import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { emit } from "@tauri-apps/api/event";

import { useBusHealth } from "./busHealth";
import { ChipButton } from "./ChipButton";
import { TraceView, type EventActions } from "./TraceView";
import { GOTO_EVENT } from "./gotoEvent";
import { useSetting } from "./hostSettings";
import { useProjectContext } from "./projectContext";
import { useTraceModel } from "./traceData";
import { useNotes, useRemoveChip } from "./notesContext";
import { linkedEventIds, tagsInUse, timelineEvents } from "./notes";
import { resetEventHighlight, selectEvents } from "./eventHighlight";
import { countByKind, EventKindFilter, useEventKindFilter } from "./EventKindFilter";
import type { TraceRow } from "./trace";
import { busLookup, type ColumnState } from "./traceColumns";
import { useEventsPage } from "./useEventsPage";
import { diagCount } from "./diag"; // DIAG

/// The column set this view declares to TraceView: empty. One shared
/// reference so the memoised rows aren't handed a fresh array per render.
const NO_COLUMNS: readonly ColumnState[] = [];

/// The singleton timeline-events view (ADR 0035): one panel, opened from the
/// command palette like Project / System Messages, that *is* the trace view
/// rendering only events — **one list**, oldest first: the authored events,
/// the derived truncation marker and every bus's bus-error episodes at the
/// configured gap, merged by time. The host merges, filters, counts and
/// pages it (`events_page`); this view holds one page (`useEventsPage`). It
/// reuses TraceView's event-row renderer (one base type, `TraceRow`), with
/// the frame header hidden. Each editable row carries inline rename /
/// recolor / remove controls; derived events — the truncation marker, an
/// episode — aren't editable, but every row is selectable.
///
/// **How much of the gridview (ADR 0044) these rows are on.** They are on its
/// *interaction* base — the cursor, the row DOM ids, the click policy that
/// makes an event focusable but not selectable — and off its *row template*:
/// `EventRow` draws its own flex row rather than a `GridviewRow` of column
/// cells. The layer's column model still reaches them, though, through the
/// width the view publishes for its scrolled content: the rows are absolutely
/// positioned against it, so a declared column set sizes every row, drawn
/// cells or not. That is why this view declares **none** — a column set is not
/// inert here, and the default frame layout (1144 px of tracks) laid the ✎ / ×
/// controls out ~900 px beyond a narrow panel's right edge.
export function EventsPanel(_props: IDockviewPanelProps) {
  diagCount("render.EventsPanel"); // DIAG
  const model = useTraceModel();
  const {
    notes,
    renameNote,
    recolorNote,
    describeNote,
    retagNote,
    removeNote,
    linkEvents,
    unlinkEvents,
  } = useNotes();
  const removeChip = useRemoveChip();
  // The authored events, whole (ADR 0035: bounded by what the user wrote)
  // — what the counts, the tag suggestions and the Link control read. The
  // rows themselves are the host's page below.
  const allEvents = useMemo(
    () => timelineEvents(notes, model.truncationTsNs),
    [notes, model.truncationTsNs],
  );
  // The kind filter is what makes a hidden-by-default kind findable: this
  // view lists every kind with its count, whether or not it is showing.
  const kindFilter = useEventKindFilter();
  // The second filter axis: the user's own tag, matched as a substring so a
  // partial word narrows the list without the user having to know the whole
  // vocabulary. The datalist offers what is actually in use.
  const [tagQuery, setTagQuery] = useState("");
  // Bus errors are episodes the host derives per bus (ADR 0035 amended),
  // never in the notes store, so `allEvents` never carries one. The
  // checklist's count for them is a model fact read off `get_bus_health`'s
  // per-bus totals: a fault is exactly what a reader most wants surfaced,
  // including on the row that says how many there are.
  const { buses: sessionBuses } = useProjectContext();
  const busHealth = useBusHealth();
  const busErrorCount = useMemo(
    () => sessionBuses.reduce((n, b) => n + (busHealth[b.id]?.errorCount ?? 0), 0),
    [sessionBuses, busHealth],
  );
  const counts = useMemo(
    () => ({ ...countByKind(allEvents), busError: busErrorCount }),
    [allEvents, busErrorCount],
  );
  const tags = useMemo(() => tagsInUse(allEvents), [allEvents]);
  const gapSeconds = useSetting("bus_error_episode_gap_s");

  // What the list is made of moved outside this view: an authored edit (a
  // new `notes` snapshot), a bus fault (the error total), the truncation
  // point. Counted — a plain "latest value" ref, mutated in render — so the
  // loaded page is re-fetched in place on the next refresh tick.
  const changes = useRef({ notes, busErrorCount, truncation: model.truncationTsNs, n: 0 });
  const seen = changes.current;
  if (
    seen.notes !== notes ||
    seen.busErrorCount !== busErrorCount ||
    seen.truncation !== model.truncationTsNs
  ) {
    changes.current = { notes, busErrorCount, truncation: model.truncationTsNs, n: seen.n + 1 };
  }
  const page = useEventsPage({
    buses: sessionBuses,
    gapSeconds,
    kinds: kindFilter.visible,
    tagQuery,
    changeSignal: changes.current.n,
  });

  // The linking gesture is multi-select plus one control (owner ruling):
  // the selection lives in the gridview, which this view declares its
  // event rows selectable in, and the view keeps only the ids it reports.
  const [selected, setSelected] = useState<readonly string[]>([]);
  // Selecting an event is acting on it (ADR 0056): its subjects light up
  // in the plot and the trace, and a selected end of a linked pair — or a
  // selected bus-error episode — draws its extent. Transient — the channel
  // is view-local, and this view closing puts it back to rest.
  useEffect(() => {
    selectEvents(selected);
  }, [selected]);
  useEffect(() => resetEventHighlight, []);
  // A link is stored on an authored event (ADR 0056), and the store links
  // two authored events: a pair with an episode in it offers no link.
  const pair = useMemo(() => {
    if (selected.length !== 2) return null;
    const two = allEvents.filter((e) => selected.includes(e.id));
    if (two.length !== 2) return null;
    // Chronological, so the reference is stored on the later event and
    // points back — the way a reader describes a pair ("this fault, after
    // this contactor open"). Link direction is invisible to every reader
    // (ADR 0056 § 4); this only makes the stored form predictable.
    const [first, second] = [...two].sort((a, b) => a.timestampNs - b.timestampNs);
    return { first, second, linked: linkedEventIds(allEvents, first.id).includes(second.id) };
  }, [allEvents, selected]);

  const pageRow = page.getRow;
  const getRow = useCallback(
    (i: number): TraceRow | null => {
      const e = pageRow(i);
      return e ? { row: "event", event: e } : null;
    },
    [pageRow],
  );

  // TraceView is built for frame data; an events-only view supplies no
  // columns at all and no-op frame-side callbacks.
  const noop = useCallback(() => {}, []);
  const lookup = useMemo(() => busLookup([]), []);

  const eventActions = useMemo<EventActions>(
    () => ({
      onRename: renameNote,
      onRecolor: recolorNote,
      onDescribe: describeNote,
      onRetag: retagNote,
      onRemove: removeNote,
      onGoto: (timestampNs) => void emit(GOTO_EVENT, timestampNs),
      onRemoveChip: removeChip,
    }),
    [renameNote, recolorNote, describeNote, retagNote, removeNote, removeChip],
  );

  return (
    <div className="trace-panel events-panel">
      <div className="events-panel-toolbar">
        <EventKindFilter
          state={kindFilter}
          counts={counts}
          // The gap the bus errors are grouped at — a setting
          // (`bus_error_episode_gap_s`) — said where the kind is.
          titles={{
            Diagnostics: `Diagnostics — what the tool found: bus errors, as episodes at ${gapSeconds} s, and where history was truncated`,
          }}
        />
        <label className="events-panel-tag-filter">
          tag
          <input
            type="search"
            list="events-panel-tags"
            aria-label="filter by tag"
            placeholder="any"
            value={tagQuery}
            onChange={(e) => setTagQuery(e.target.value)}
          />
          <datalist id="events-panel-tags">
            {tags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        {!page.complete && (
          <span className="events-panel-pending" title="still catching up with the capture">
            catching up…
          </span>
        )}
        <span className="events-panel-toolbar-spacer" />
        {/* One control, two faces: with two events selected it links
            them, and with two already-linked events selected it takes
            the link away — otherwise a link could be made and never
            unmade. A link is untyped, so there is nothing else to say
            about it (ADR 0056). */}
        <ChipButton
          icon="link"
          label={pair?.linked ? "Unlink Events" : "Link Events"}
          title={
            pair?.linked
              ? "drop the link between the two selected events"
              : "link the two selected events — a linked pair draws its extent while either is selected"
          }
          disabled={pair === null}
          onPress={() => {
            if (pair === null) return;
            const { first, second, linked } = pair;
            if (linked) unlinkEvents(second.id, first.id);
            else linkEvents(second.id, first.id);
          }}
        />
      </div>
      <TraceView
        count={page.count}
        version={page.version}
        autoScroll={false}
        baseTimestampSeconds={model.sessionStartSeconds}
        columns={NO_COLUMNS}
        onColumnResize={noop}
        onColumnToggle={noop}
        onColumnReorder={noop}
        resolveColor={null}
        busLookup={lookup}
        getRow={getRow}
        ensureVisible={page.ensureVisible}
        onAutoScrollDisabled={noop}
        eventActions={eventActions}
        showHeader={false}
        events={allEvents}
        selectableEvents
        onEventSelectionChange={setSelected}
      />
    </div>
  );
}
