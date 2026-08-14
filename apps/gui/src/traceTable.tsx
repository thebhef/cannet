import { useState } from "react";
import type { ReactNode } from "react";

import type { TraceFrameRecord } from "./types";
import { type BusLookup, type ColumnKey, busDisplayName } from "./traceColumns";
import {
  formatData,
  formatId,
  formatKind,
  formatLocalTimestamp,
  formatMsgRate,
  formatTimestamp,
  hasWallClockAnchor,
  type CanIdFormat,
} from "./format";

/// The content for one trace cell, given the column. The `#` column is
/// the row's 1-based index in the chronological view, and the total
/// frame count for the id in the by-id view (passed as `count`); it's
/// shown even for a not-yet-loaded row. Every other column is blank
/// until the frame arrives. `rate` and `count` are only meaningful in
/// by-id mode (the "msg/s" column and the per-id frame total);
/// elsewhere they're omitted. `busLookup` resolves a frame's `bus_id`
/// to the project's bus name for the "bus" column, and `idFormat` (the
/// `can_id_format` setting) says how the "id" column renders. Shared by
/// the chronological rows (`TraceView`) and the by-id rows
/// (`ByIdTable`); both read the setting themselves and pass it down to
/// their memoised rows, so a change to it actually repaints.
export function cellContent(
  key: ColumnKey,
  frame: TraceFrameRecord | null,
  absoluteIndex: number,
  baseTimestamp: number | null,
  idFormat: CanIdFormat,
  isExpanded: boolean,
  busLookup: BusLookup,
  rate?: number,
  count?: number,
): ReactNode {
  if (key === "idx") {
    return (count ?? absoluteIndex + 1).toLocaleString();
  }
  if (key === "rate") return rate != null ? formatMsgRate(rate) : null;
  if (!frame) return null;
  switch (key) {
    case "time":
      return formatTimestamp(frame.timestamp_seconds, baseTimestamp);
    case "bus":
      return busDisplayName(frame.bus_id, busLookup);
    case "ecu":
      // Blank for undecoded rows and the `Vector__XXX` "no sender"
      // placeholder — unlike bus, there's no meaningful fallback name.
      return frame.decoded?.transmitter ?? "";
    case "dir":
      return frame.direction;
    case "id":
      return formatId(frame, idFormat);
    case "kind":
      return formatKind(frame);
    case "len":
      return frame.data.length;
    case "data":
      return formatData(frame);
    case "msg":
      return (
        <>
          {frame.decoded ? frame.decoded.name : ""}
          {frame.decoded ? (
            // Decoration, not a control (unlike ByIdTable, this row
            // carries no `aria-expanded`/tabIndex of its own to hang a
            // no-glyph reading on — ADR 0044's "no separate expander
            // control" applies to the *control*, not to this ink).
            // Only the glyph rendering is shared with DisclosureToggle
            // (task 63 item 1); the row's own click stays untouched.
            <span className="hint disclosure-toggle-glyph" aria-hidden="true">
              {" "}
              {isExpanded ? "▾" : "▸"}
            </span>
          ) : null}
        </>
      );
  }
}

/// The `time` cell of a trace-style row: the elapsed-time text ADR 0024
/// specifies, plus — while the pointer is on it — a native `title` with
/// the same instant read as a local date and time. A session with no
/// wall-clock origin (a log with no start time) has no absolute instant
/// to name, so it gets no tooltip and no hover state at all.
///
/// The tooltip string is derived from hover state during render rather
/// than written to the node on the pointer event, for two reasons. The
/// tables are virtualized and repaint continuously, so formatting a date
/// for every row on every pass would put that work on the scroll path;
/// and a row slot is reused for a different frame as the view scrolls or
/// the live tail advances, which a title written on `mouseenter` would
/// survive as a stale reading of some other message.
export function TraceTimeCell({
  className,
  seconds,
  base,
  children,
}: {
  className: string;
  /// The row's own timestamp in Unix-epoch seconds, or `null` for a row
  /// whose frame hasn't loaded yet.
  seconds: number | null;
  /// The session origin (`TraceHandle.baseTimestampSeconds`).
  base: number | null;
  /// The cell's rendered text — `cellContent`'s `time` output, so the
  /// column keeps one renderer.
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const anchored = seconds !== null && hasWallClockAnchor(base);
  return (
    <span
      className={className}
      title={(hovered && seconds !== null ? formatLocalTimestamp(seconds, base) : null) ?? undefined}
      onMouseEnter={anchored ? () => setHovered(true) : undefined}
      onMouseLeave={anchored ? () => setHovered(false) : undefined}
    >
      {children}
    </span>
  );
}
