/// One decoded signal sub-row inside an expanded trace row, sized to
/// `SIGNAL_LINE_HEIGHT` so the line stack matches the placement
/// arithmetic (`expandedRowHeight`). It is
/// a drag source — dragging onto a plot area adds the
/// signal as a series. Click events still fall through to the row
/// (`stopPropagation` would prevent the expand-collapse toggle from
/// retracting); dragging is initiated by the browser only when the
/// mouse actually leaves the source, so plain clicks aren't
/// hijacked.
///
/// Shared by `TraceView` (chronological) and `ByIdTable` (per-message-id):
/// both expand a frame's decoded signals the same way, so the row body
/// lives here once instead of twice.

import type { SignalRecord, TraceFrameRecord } from "./types";
import { formatSignalValueWithLabel } from "./format";
import { type ColorResolver, colorMapTint } from "./colorMap";
import { setSignalDragData } from "./dragSignals";
import { SIGNAL_LINE_HEIGHT } from "./traceViewport";

export function DecodedSignalCell({
  frame,
  messageName,
  sig,
  resolveColor,
}: {
  frame: TraceFrameRecord;
  messageName: string;
  sig: SignalRecord;
  resolveColor: ColorResolver | null;
}) {
  const tint = resolveColor?.(
    {
      messageId: frame.id,
      extended: frame.extended,
      signalName: sig.name,
      busId: frame.bus_id ?? null,
    },
    sig.value,
  );
  return (
    <div
      className="signal"
      style={{ height: SIGNAL_LINE_HEIGHT }}
      draggable
      onDragStart={(e) => {
        // Stop the parent row's drag from also firing — there isn't
        // a row-level drag today, but the convention pre-empts a
        // surprising one. The drag payload is a single ref; the
        // bus comes from the frame's own routing decision (the
        // host's `bus_id`) so a frame on bus A drops as a signal
        // bound to bus A.
        e.stopPropagation();
        setSignalDragData(e, [
          {
            busId: frame.bus_id ?? null,
            messageId: frame.id,
            extended: frame.extended,
            signalName: sig.name,
            messageName,
            unit: sig.unit,
          },
        ]);
      }}
    >
      <span className="signal-name">{sig.name}</span>
      <span
        className="signal-value"
        style={tint ? { background: colorMapTint(tint) } : undefined}
      >
        {formatSignalValueWithLabel(sig.value, sig.unit, sig.label)}
      </span>
    </div>
  );
}
