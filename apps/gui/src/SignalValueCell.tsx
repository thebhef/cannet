/// The one signal-value renderer (Task-20 shared cell): physical value
/// + optional enum label, tinted by the project's colormaps
/// (ADR 0029). The signal view's value column and the DBC panel's live
/// value column both render through this, so the two surfaces cannot
/// drift. The unit is a parameter because the signal view shows it in
/// its own column (pass `""`) while the DBC panel shows it beside the
/// value — as its own element, never glued onto the value string
/// (`SignalValueText`).

import { SignalValueText } from "./SignalValueText";
import { colorMapTint, type ColorResolver, type ColorTarget } from "./colorMap";

interface SignalValueCellProps {
  /// Physical value, or null/undefined for a blank cell (descriptor
  /// not seen in the window).
  value: number | null | undefined;
  /// Unit suffix; pass `""` when a separate column carries it.
  unit: string;
  /// `VAL_` label for the decoded raw value, if any.
  label?: string | null;
  /// The host's `raw_field` verdict: the signal is an opaque bit
  /// pattern, so its value renders in hex. Never re-derived here — the
  /// classification is a DBC fact the model owns.
  rawField?: boolean;
  /// The signal's identity for colormap resolution; with `resolveColor`
  /// null (no colormaps) the cell renders untinted.
  target: ColorTarget;
  resolveColor: ColorResolver | null;
}

export function SignalValueCell({
  value,
  unit,
  label,
  rawField,
  target,
  resolveColor,
}: SignalValueCellProps) {
  if (value == null) return <span className="signal-value-cell blank" />;
  const tint = resolveColor?.(target, value);
  return (
    <span
      className="signal-value-cell"
      style={tint ? { background: colorMapTint(tint) } : undefined}
    >
      <SignalValueText value={value} unit={unit} label={label} hex={rawField} />
    </span>
  );
}
