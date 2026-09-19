/// A control that opens the base × prefix unit picker
/// (`UnitPicker.tsx`) at itself.
///
/// Three surfaces need the same gesture on differently-shaped controls —
/// the math editor's Units row, the View-signals resolved-unit chip and
/// the plot side list's readout chip — so the button's *look* is the
/// caller's (`className`, `children`) and everything else is here: the
/// viewport-fixed anchor the popover needs, the open/close toggle, and
/// dismissal.
///
/// The picker is portalled to `<body>` (a dockview container's GPU-layer
/// styles make it the containing block for fixed descendants, so a
/// popover rendered in place lands offset), which is why the anchor is
/// measured rather than positioned relatively.

import { useState } from "react";

import { UnitPicker } from "./UnitPicker";
import type { UnitPickerComposition } from "./unitSelection";
import type { UnitId } from "./types";

export interface UnitButtonProps {
  /// The unit in force, or `null` — which selects the composition row
  /// where the caller offers one.
  value: UnitId | null;
  /// The dimension to lock the picker to; `null` offers everything,
  /// which is reinterpretation rather than conversion.
  kind: string | null;
  composition?: UnitPickerComposition;
  /// An override is in force, so the picker carries a row back to the
  /// derivation even where no composition names one.
  clearable?: boolean;
  ariaLabel: string;
  title?: string;
  className?: string;
  children: React.ReactNode;
  /// Whether picking closes the popover. The chips do (one gesture, one
  /// choice); the math editor's Units row does not, so a base and its
  /// prefix are two clicks in one opening.
  closeOnPick?: boolean;
  onPick: (unit: UnitId | null) => void;
}

export function UnitButton({
  value,
  kind,
  composition,
  clearable,
  ariaLabel,
  title,
  className,
  children,
  closeOnPick,
  onPick,
}: UnitButtonProps) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        type="button"
        className={className ?? "unit-button"}
        aria-label={ariaLabel}
        aria-expanded={at !== null}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          if (at) {
            setAt(null);
            return;
          }
          const r = e.currentTarget.getBoundingClientRect();
          setAt({
            x: Math.max(4, Math.min(r.left, window.innerWidth - 340)),
            y: r.bottom + 3,
          });
        }}
      >
        {children}
      </button>
      {at && (
        <UnitPicker
          at={at}
          value={value}
          kind={kind}
          composition={composition}
          clearable={clearable}
          ariaLabel={ariaLabel}
          onPick={(unit) => {
            onPick(unit);
            if (closeOnPick) setAt(null);
          }}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}
