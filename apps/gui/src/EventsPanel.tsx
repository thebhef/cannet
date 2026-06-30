import { useCallback, useMemo } from "react";
import type { IDockviewPanelProps } from "dockview";
import { emit } from "@tauri-apps/api/event";

import { TraceView, type EventActions } from "./TraceView";
import { GOTO_EVENT } from "./gotoEvent";
import { useTraceData } from "./traceData";
import { useNotes } from "./notesContext";
import { timelineEvents } from "./notes";
import type { TraceRow } from "./trace";
import { busLookup, columnsFromParams } from "./traceColumns";

/// The singleton timeline-events view (ADR 0035): one panel, opened from the
/// command palette like Project / System Messages, that *is* the trace view
/// rendering only events — the host notes merged with the derived truncation
/// marker, chronological. It reuses TraceView's event-row renderer (one base
/// type, `TraceRow`), with the frame header hidden. Each editable row carries
/// inline rename / recolour / remove controls (derived events aren't editable).
export function EventsPanel(_props: IDockviewPanelProps) {
  const data = useTraceData();
  const { notes, renameNote, recolorNote, removeNote } = useNotes();
  const events = useMemo(
    () => timelineEvents(notes, data.truncationTsNs),
    [notes, data.truncationTsNs],
  );

  const getRow = useCallback(
    (i: number): TraceRow | null => {
      const e = events[i];
      return e ? { row: "event", event: e } : null;
    },
    [events],
  );

  // TraceView is built for frame data; an events-only view supplies inert
  // column state (the rows ignore it, the header is hidden) and no-op
  // frame-side callbacks.
  const noop = useCallback(() => {}, []);
  const columns = useMemo(() => columnsFromParams(undefined), []);
  const lookup = useMemo(() => busLookup([]), []);

  const eventActions = useMemo<EventActions>(
    () => ({
      onRename: renameNote,
      onRecolor: recolorNote,
      onRemove: removeNote,
      onGoto: (timestampNs) => void emit(GOTO_EVENT, timestampNs),
    }),
    [renameNote, recolorNote, removeNote],
  );

  return (
    <div className="trace-panel events-panel">
      <TraceView
        count={events.length}
        version={events.length}
        autoScroll={false}
        baseTimestampSeconds={data.sessionStartSeconds}
        columns={columns}
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
