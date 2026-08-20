/**
 * Plot-panel measurement UI: the toolbar's measurement-selection menu
 * and the bottom measurement strip (cursor A/B times, Δt/1/Δt, and the
 * per-trace value@A / value@B / Δ / min / max / mean over [A, B]). Split
 * out of PlotPanel.tsx; the panel owns the cursor + series state and
 * passes it in.
 */
import { useState } from "react";

import { ColorChip } from "./ColorChip";
import { DisclosureToggle } from "./DisclosureToggle";
import { useDismissableMenu } from "./useDismissableMenu";
import { useFloatFormatRule } from "./floatFormat";
import {
  MEASUREMENT_QUANTITIES,
  type MeasurementKey,
  type Series,
  statsOver,
  valueAt,
} from "./plotCursors";
import { fmtFreq, fmtVal, type SignalRef, type SignalValueFormat, type XCursors } from "./plotPanelConfig";
import { formatDurationSeconds } from "./format";

/** One labelled cell of the measurement strip. */
function MeasCell({ k, v, cls, swatch }: { k: string; v: string; cls?: string; swatch?: string }) {
  return (
    <div className="plot-meas-cell">
      <div className="plot-meas-k">
        {swatch && <ColorChip color={swatch} size="dot" />}
        {k}
      </div>
      <div className={`plot-meas-v${cls ? ` ${cls}` : ""}`}>{v}</div>
    </div>
  );
}

/** The toolbar's "measurements ▾" popover: toggles which measurement
 * quantities the strip shows. */
export function MeasurementMenu({
  measKeys,
  onChange,
}: {
  measKeys: MeasurementKey[];
  onChange: (k: MeasurementKey[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false));
  const toggle = (k: MeasurementKey) => onChange(measKeys.includes(k) ? measKeys.filter((x) => x !== k) : [...measKeys, k]);
  return (
    <div className="plot-meas-menu" ref={wrapRef}>
      <DisclosureToggle expanded={open} onToggle={() => setOpen((v) => !v)}>
        measurements
      </DisclosureToggle>
      {open && (
        <div className="plot-meas-menu-pop" role="menu">
          {MEASUREMENT_QUANTITIES.map((q) => (
            <label key={q.key} className="checkbox">
              <input type="checkbox" checked={measKeys.includes(q.key)} onChange={() => toggle(q.key)} />
              {q.label}
              {q.perTrace ? " (per trace)" : ""}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** One entry of the panel's flattened list of plotted signals — the
 * derived-axis identity the measurement strip reads its series by. */
export interface PlottedSignal {
  key: string;
  ref: SignalRef;
  color: string;
  areaId: string;
  /** How this signal's values read (fixed decimals / float / hex),
   * from the catalog. Absent for a signal the catalog no longer
   * describes, which falls back to the float rule. */
  fmt?: SignalValueFormat;
}

/** The bottom measurement strip. Cursor-position cells (A/B/Δt/1÷Δt)
 * plus, for every plotted signal, the per-trace value@A / value@B / Δ /
 * min / max / mean over [A, B]. `fmtPos` formats a cursor time in the
 * panel's current elapsed-time precision. */
export function PlotMeasurementStrip({
  measKeys,
  cursorX,
  plottedSignals,
  seriesFor,
  fmtPos,
}: {
  measKeys: MeasurementKey[];
  cursorX: XCursors;
  plottedSignals: readonly PlottedSignal[];
  seriesFor: (areaId: string, key: string) => Series | undefined;
  fmtPos: (t: number | null) => string;
}) {
  // The strip re-renders when the cursors move, which is not when the
  // float-format settings change — and `fmtVal` reads them at call
  // time. Subscribing here is what re-labels the cells on a settings
  // change instead of at the next cursor placement.
  useFloatFormatRule();
  const dt = cursorX.a != null && cursorX.b != null ? cursorX.b - cursorX.a : null;
  return (
    <div className="plot-meas-strip">
      {measKeys.includes("a") && <MeasCell k="A (t)" v={fmtPos(cursorX.a)} cls="gold" />}
      {measKeys.includes("b") && <MeasCell k="B (t)" v={fmtPos(cursorX.b)} cls="pink" />}
      {measKeys.includes("dt") && <MeasCell k="Δt" v={formatDurationSeconds(dt)} />}
      {measKeys.includes("freq") && <MeasCell k="1/Δt" v={dt ? fmtFreq(1 / dt) : "—"} />}
      {plottedSignals.map(({ key, ref, color, areaId, fmt }) => {
        const s = seriesFor(areaId, key) ?? { t: [], v: [] };
        const va = cursorX.a != null ? valueAt(s, cursorX.a) : null;
        const vb = cursorX.b != null ? valueAt(s, cursorX.b) : null;
        const span = cursorX.a != null && cursorX.b != null ? statsOver(s, cursorX.a, cursorX.b) : null;
        const name = `${ref.messageName}.${ref.signalName}`;
        return (
          <span key={key} style={{ display: "contents" }}>
            {measKeys.includes("valA") && <MeasCell k={`${name} @A`} v={fmtVal(va, fmt)} swatch={color} />}
            {measKeys.includes("valB") && <MeasCell k={`${name} @B`} v={fmtVal(vb, fmt)} swatch={color} />}
            {/* Δ and the mean are *derived* from the samples, not
              * samples: a mean of 0.25-quantised readings need not land
              * on that grid, and a difference of two bit patterns is
              * not itself a bit pattern. Both read by the plain float
              * rule; @A / @B / min / max are real readings and take the
              * signal's own precision and radix. */}
            {measKeys.includes("delta") && (
              <MeasCell k={`${name} Δ`} v={va != null && vb != null ? fmtVal(vb - va) : "—"} swatch={color} />
            )}
            {measKeys.includes("min") && <MeasCell k={`${name} min`} v={fmtVal(span?.min ?? null, fmt)} swatch={color} />}
            {measKeys.includes("max") && <MeasCell k={`${name} max`} v={fmtVal(span?.max ?? null, fmt)} swatch={color} />}
            {measKeys.includes("mean") && <MeasCell k={`${name} mean`} v={fmtVal(span?.mean ?? null)} swatch={color} />}
          </span>
        );
      })}
    </div>
  );
}
