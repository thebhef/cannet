/// One row of a frame's disclosed decoded signals — a row of the
/// gridview's space like any other (ADR 0044): it carries the DOM id the
/// cursor names it by, shows the selection, and **its click is its own**,
/// so clicking a signal selects that signal instead of acting on the
/// message that disclosed it. Sized to `SIGNAL_LINE_HEIGHT` and placed by
/// the view's stacking arithmetic, so the lines can't drift from it.
///
/// It is also a drag source — dragging onto a plot area adds the signal
/// as a series. Dragging is initiated by the browser only when the mouse
/// actually leaves the source, so plain clicks aren't hijacked.
///
/// Shared by `TraceView` (chronological) and `ByIdTable` (per-message-id):
/// both disclose a frame's decoded signals the same way, so the row — and
/// what clicking it means — lives here once instead of twice.

import { memo, type MouseEvent } from "react";

import type { SignalRecord, TraceFrameRecord } from "./types";
import { SignalValueText } from "./SignalValueText";
import { type ColorResolver, colorMapTint } from "./colorMap";
import { setSignalDragData } from "./dragSignals";
import { SIGNAL_LINE_HEIGHT } from "./traceViewport";
import { NameText } from "./NameText";

export interface DecodedSignalCellProps {
  frame: TraceFrameRecord;
  messageName: string;
  sig: SignalRecord;
  resolveColor: ColorResolver | null;
  /// Where this row sits inside the view's sticky viewport, in px.
  top: number;
  /// This row's id in the gridview's row space.
  rowId: string;
  /// The DOM id `aria-activedescendant` names this row by.
  domId: string;
  selected: boolean;
  onSelect: (rowId: string, e: MouseEvent) => void;
  /// Right-click, when the disclosing view offers a frame menu: the
  /// signal line belongs to its message, so it presents the message's
  /// menu — never the panel-scoped one a bubbled click would reach.
  onContextMenu?: (e: MouseEvent) => void;
}

export const DecodedSignalCell = memo(function DecodedSignalCell({
  frame,
  messageName,
  sig,
  resolveColor,
  top,
  rowId,
  domId,
  selected,
  onSelect,
  onContextMenu,
}: DecodedSignalCellProps) {
  const tint = resolveColor?.(
    {
      messageId: frame.id,
      extended: frame.extended,
      signalName: sig.name,
      busId: frame.bus_id,
    },
    sig.value,
  );
  return (
    <div
      className={selected ? "signal trace-content-row selected" : "signal trace-content-row"}
      id={domId}
      // A row of the tree the container declares, one level down from
      // the message that disclosed it (ADR 0044).
      role="treeitem"
      aria-level={2}
      aria-selected={selected}
      style={{ position: "absolute", top, left: 0, right: 0, height: SIGNAL_LINE_HEIGHT }}
      draggable
      onClick={(e) => onSelect(rowId, e)}
      onContextMenu={onContextMenu}
      onDragStart={(e) => {
        // The drag payload is a single ref; the bus comes from the
        // frame's own routing decision (the host's `bus_id`) so a frame
        // on bus A drops as a signal bound to bus A.
        e.stopPropagation();
        setSignalDragData(e, [
          {
            busId: frame.bus_id,
            messageId: frame.id,
            extended: frame.extended,
            signalName: sig.name,
            messageName,
            unit: sig.unit,
          },
        ]);
      }}
    >
      <span className="signal-name">
        <NameText name={sig.name} />
      </span>
      <span
        className="signal-value"
        style={tint ? { background: colorMapTint(tint) } : undefined}
      >
        <SignalValueText
          value={sig.value}
          unit={sig.unit}
          label={sig.label}
          hex={sig.display_hex}
        />
      </span>
    </div>
  );
});
