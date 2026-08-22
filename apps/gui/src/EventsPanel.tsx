import { useCallback, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { emit } from "@tauri-apps/api/event";

import { TraceView, type EventActions } from "./TraceView";
import { GOTO_EVENT } from "./gotoEvent";
import { useTraceModel } from "./traceData";
import { useNotes } from "./notesContext";
import { matchesTagQuery, tagsInUse, timelineEvents, visibleEvents } from "./notes";
import { countByKind, EventKindFilter, useEventKindFilter } from "./EventKindFilter";
import type { TraceRow } from "./trace";
import { busLookup, type ColumnState } from "./traceColumns";
import { diagCount } from "./diag"; // DIAG

/// The column set this view declares to TraceView: empty. One shared
/// reference so the memoised rows aren't handed a fresh array per render.
const NO_COLUMNS: readonly ColumnState[] = [];

/// The singleton timeline-events view (ADR 0035): one panel, opened from the
/// command palette like Project / System Messages, that *is* the trace view
/// rendering only events — the host notes merged with the derived truncation
/// marker, chronological. It reuses TraceView's event-row renderer (one base
/// type, `TraceRow`), with the frame header hidden. Each editable row carries
/// inline rename / recolor / remove controls (derived events aren't editable).
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
  const { notes, renameNote, recolorNote, describeNote, retagNote, removeNote } = useNotes();
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
  const events = useMemo(
    () =>
      visibleEvents(allEvents, kindFilter.visible).filter((e) => matchesTagQuery(e, tagQuery)),
    [allEvents, kindFilter.visible, tagQuery],
  );
  const counts = useMemo(() => countByKind(allEvents), [allEvents]);
  const tags = useMemo(() => tagsInUse(allEvents), [allEvents]);

  const getRow = useCallback(
    (i: number): TraceRow | null => {
      const e = events[i];
      return e ? { row: "event", event: e } : null;
    },
    [events],
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
    }),
    [renameNote, recolorNote, describeNote, retagNote, removeNote],
  );

  return (
    <div className="trace-panel events-panel">
      <div className="events-panel-toolbar">
        <EventKindFilter state={kindFilter} counts={counts} />
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
      </div>
      <TraceView
        count={events.length}
        version={events.length}
        autoScroll={false}
        baseTimestampSeconds={model.sessionStartSeconds}
        columns={NO_COLUMNS}
        onColumnResize={noop}
        onColumnToggle={noop}
        onColumnReorder={noop}
        resolveColor={null}
        busLookup={lookup}
        getRow={getRow}
        ensureVisible={noop}
        onAutoScrollDisabled={noop}
        eventActions={eventActions}
        showHeader={false}
      />
    </div>
  );
}
