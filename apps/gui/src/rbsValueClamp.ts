/// The RBS signal value clamp (task 89 phase 6, grooming resolution
/// "Out of Range is a frontend concern, and clamping is shared code").
///
/// Truncation to a signal's bit width is correct on transmit — it's
/// what the bus would see — so `reconstruct_payload` (the host encoder)
/// never checks a physical value against the signal's declared range.
/// The frontend is where an out-of-range value is caught and clamped
/// *before* it is ever sent, and it has to be exactly one
/// implementation: the RBS panel's own value cells
/// (`RbsValueCell`/`RbsPanel.tsx`) and the RBS signals grid
/// (`RbsSignalsPanel.tsx`) edit the same override through the same
/// `rbs_set_signal` command, and they must agree at the boundary.
///
/// Only plain numeric overrides are clamped. A `0x…` override is raw
/// bits, already exact by construction; a `VAL_` enum label carries no
/// numeric range to be out of.

/// The inputs a signal's physical range is derived from — the fields
/// `RbsSignalView` / `RbsSignalRow` both already carry.
export interface SignalRangeInputs {
  min: number;
  max: number;
  factor: number;
  offset: number;
  size: number;
  signed: boolean;
}

/// A signal's physical range: its declared `min`/`max` verbatim, unless
/// they're equal — DBCs frequently declare `[0|0]` to mean "no
/// constraint" (`cannet_dbc::view_builders::DbcSignalContent::min`'s own
/// doc comment) — in which case the range is derived from the raw bit
/// width and the factor/offset instead of leaving the signal
/// unconstrained. (A signal genuinely spanning nothing but `0` would
/// declare `min == max == 0` too, indistinguishable from "not declared"
/// — the DBC format doesn't carry that distinction, so the fallback
/// treats both alike, matching the convention.)
export function signalPhysicalRange(sig: SignalRangeInputs): { min: number; max: number } {
  if (sig.min !== sig.max) return { min: sig.min, max: sig.max };
  const size = Math.max(1, Math.min(64, Math.trunc(sig.size) || 1));
  const rawLo = sig.signed ? -(2 ** (size - 1)) : 0;
  const rawHi = sig.signed ? 2 ** (size - 1) - 1 : 2 ** size - 1;
  const a = rawLo * sig.factor + sig.offset;
  const b = rawHi * sig.factor + sig.offset;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/// Is `value` outside the signal's physical range? Non-finite values
/// are never "out of range" here — they're a different problem
/// (`parseSignalText` already rejects them before a value reaches
/// this far).
export function isOutOfSignalRange(value: number, sig: SignalRangeInputs): boolean {
  if (!Number.isFinite(value)) return false;
  const { min, max } = signalPhysicalRange(sig);
  return value < min || value > max;
}

/// Clamp `value` into the signal's physical range — the one place both
/// panels call to keep a value in range *on entry*, before it ever
/// reaches `rbs_set_signal`.
export function clampToSignalRange(value: number, sig: SignalRangeInputs): number {
  if (!Number.isFinite(value)) return value;
  const { min, max } = signalPhysicalRange(sig);
  return Math.min(max, Math.max(min, value));
}
