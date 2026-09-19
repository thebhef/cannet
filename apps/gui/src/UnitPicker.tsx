/// The **base × prefix** unit picker: one popover, three callers.
///
/// A unit's identity is a base unit and an SI prefix, so the picker is
/// two columns — the base on the left, the scale on the right — and
/// never a flat list of pre-composed spellings. The scale column is the
/// full exponent-ordered ladder, each row carrying its `×10ⁿ` and the
/// spelling the pair reads as; it opens scrolled to the current
/// selection so the neighbours are one step away and the extremes are a
/// scroll (design ruling).
///
/// **Kind-locking is the caller's**, and it says which operation this
/// is. Everywhere a unit is *applied* — a math definition's target, a
/// plot series' display unit — the picker is locked to one dimension
/// and choosing is a real conversion. The View-signals chip passes no
/// kind: reassigning a unit there is *reinterpretation*, the database's
/// label was wrong about what the signal measures, and a like-kind
/// picker could not express that repair.
///
/// Nothing here composes a unit string or decides what converts: the
/// rows, their spellings and their groupings are the host's
/// (`units::list_unit_picker`, ADR 0025).

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useUnitPickerModel } from "./unitLibrary";
import {
  formatScaleFactor,
  pickerEntries,
  rebase,
  sameUnit,
  selectedEntryId,
  type PickerRow,
  type UnitPickerComposition,
} from "./unitSelection";
import { useDismissableMenu } from "./useDismissableMenu";
import type { UnitId } from "./types";

export interface UnitPickerProps {
  /// Viewport coordinates to open at — the anchor's bottom-left. Fixed
  /// positioning on `<body>`, like the editor's other popovers: a
  /// dockview container's GPU-layer styles make it the containing block
  /// for fixed descendants, so a popover rendered in place lands offset.
  at: { x: number; y: number };
  /// The unit currently in force, or `null` for none — which selects the
  /// composition row where the caller offers one.
  value: UnitId | null;
  /// The dimension to lock to, or `null` to offer everything.
  kind: string | null;
  /// The derivation to offer beside the library, where the caller has
  /// one (the math editor).
  composition?: UnitPickerComposition;
  /// An override is in force, so the picker must carry a way back to
  /// the derivation even where there is no composition to offer.
  clearable?: boolean;
  ariaLabel: string;
  /// A choice. `null` is the composition row's own rung — the caller's
  /// "derive it".
  onPick: (unit: UnitId | null) => void;
  onClose: () => void;
}

export function UnitPicker({
  at,
  value,
  kind,
  composition,
  clearable,
  ariaLabel,
  onPick,
  onClose,
}: UnitPickerProps) {
  const model = useUnitPickerModel();
  const ref = useDismissableMenu<HTMLDivElement>(true, onClose);
  const rows = pickerEntries(model, kind, composition, clearable);
  const selectedId = selectedEntryId(rows, value);
  // With nothing selected the scale column would be empty and the
  // picker would read as broken, so it shows the first row's ladder.
  const active: PickerRow | undefined = rows.find((r) => r.id === selectedId) ?? rows[0];

  const basesRef = useRef<HTMLDivElement>(null);
  const scalesRef = useRef<HTMLDivElement>(null);
  // Opened centered on the current selection (design ruling). Runs on
  // every selection change, so stepping the base re-centers the ladder.
  useEffect(() => {
    for (const column of [basesRef.current, scalesRef.current]) {
      const chosen = column?.querySelector<HTMLElement>("[aria-selected='true']");
      if (!column || !chosen) continue;
      column.scrollTop = chosen.offsetTop - column.clientHeight / 2 + chosen.offsetHeight / 2;
    }
  }, [selectedId, value]);

  let lastGroup: string | null = null;
  return createPortal(
    <div
      ref={ref}
      className="unit-picker"
      role="group"
      aria-label={ariaLabel}
      style={{ left: at.x, top: at.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="unit-picker-column" ref={basesRef} role="listbox" aria-label="unit">
        <div className="unit-picker-head">{kind === null ? "unit" : `unit · ${kind}`}</div>
        {rows.length === 0 && <div className="unit-picker-empty">no unit of this kind</div>}
        {rows.map((row) => {
          // Group headings only where the list spans dimensions — a
          // kind-locked picker is one dimension by construction.
          const heading =
            kind === null && row.dimensionLabel !== lastGroup ? row.dimensionLabel : null;
          lastGroup = row.dimensionLabel;
          return (
            <div key={row.id} className="unit-picker-groupwrap">
              {heading && <div className="unit-picker-group">{heading}</div>}
              <div
                role="option"
                tabIndex={-1}
                aria-selected={row.id === selectedId}
                className="unit-picker-item"
                title={row.id === selectedId ? undefined : `read this as ${row.display}`}
                onClick={() => {
                  const entry = model.find((e) => e.id === row.id);
                  onPick(entry ? rebase(entry, value) : null);
                }}
              >
                <span className="unit-picker-symbol">{row.display}</span>
                <span className="unit-picker-name">{row.id.trim()}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="unit-picker-column" ref={scalesRef} role="listbox" aria-label="scale">
        <div className="unit-picker-head">scale</div>
        {(active?.scales ?? []).map((scale) => (
          <div
            key={scale.display}
            role="option"
            tabIndex={-1}
            aria-selected={sameUnit(scale.unit, value)}
            className="unit-picker-item"
            onClick={() => onPick(scale.unit)}
          >
            <span className="unit-picker-symbol">{scale.label || "—"}</span>
            <span className="unit-picker-factor">{formatScaleFactor(scale.exponent)}</span>
            <span className="unit-picker-spelling">{scale.display}</span>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
