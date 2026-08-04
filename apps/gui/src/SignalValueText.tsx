/// A decoded signal's value, unit and `VAL_` label as three elements.
///
/// The unit is its own element — glued onto the value string it reads as
/// part of the number, so a row shows one token instead of a value and
/// its unit. The value stays the prominent one; the unit recedes (CSS
/// `.signal-value-unit`) and the spacing between the parts comes from
/// that styling, so a caller that carries the unit in a separate column
/// (passing `""`) renders exactly the value and nothing else.
///
/// The label mirrors what a typical CAN analyzer shows for enum signals:
/// the numeric value stays visible beside the symbolic name, so a user
/// can see "this raw value happens to be 3" while reading "Drive".
///
/// Both signal-value renderers go through this — `SignalValueCell` (the
/// signal view and the DBC panel's live value column) and
/// `DecodedSignalCell` (expanded trace rows) — so the surfaces cannot
/// drift.

import { formatSignalValue } from "./format";

export function SignalValueText({
  value,
  unit,
  label,
  hex,
}: {
  value: number;
  /// Unit suffix; `""` when a separate column carries it.
  unit: string;
  label?: string | null;
  /// The host's `raw_field` verdict — render the value in hex.
  hex?: boolean;
}) {
  return (
    <>
      <span className="signal-value-number">{formatSignalValue(value, hex)}</span>
      {unit ? <span className="signal-value-unit">{unit}</span> : null}
      {label ? <span className="signal-value-label">{`"${label}"`}</span> : null}
    </>
  );
}
