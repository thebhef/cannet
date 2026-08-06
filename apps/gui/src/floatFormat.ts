/**
 * How a float reads, everywhere it is read.
 *
 * One rule, one module: the plot's value readouts (signal panel, cursor
 * readouts, measurement strip) and its y-axis tick labels all format
 * through {@link formatFloat}, so a value cannot read `0.0001` in the
 * signal panel and `1.0e-4` on the axis beside it.
 *
 * **The rule is pure magnitude.** A value reads exponentially when
 * `|v|` is below the small threshold or at/above the large one, and
 * plainly otherwise — at the *view's* significant-figure budget, with
 * no padding. Nothing about how many decimals the plain form would
 * need enters into it: a six-figure mantissa just above the small
 * threshold writes out nine decimals (`0.000123456`) rather than
 * switching, because a reading that switches on its mantissa's length
 * switches on nothing a user can predict.
 *
 * Zero is the one exception in the other direction: it is below every
 * small threshold, and `0.00000e+0` is not a reading anyone wants.
 *
 * **The mantissa width is the rule's, the sig figs are the view's.**
 * The exponential form always carries the same number of mantissa
 * decimals with the trailing zeros kept (`1.00000e-6`, not `1e-6`), so
 * two readings of the same magnitude are the same width. The sig-fig
 * budget differs per view — {@link READOUT_SIG_FIGS} against
 * {@link TICK_SIG_FIGS} — because a tick label has to fit the axis
 * gutter and a readout does not.
 *
 * All three numbers are settings (ADR 0034), read live from the shared
 * host-settings cache, so a change reaches a formatter on the next
 * render rather than on the next launch.
 */

import { hostSettings, useSetting } from "./hostSettings";

/** The three numbers that decide how a float reads. */
export interface FloatFormatRule {
  /** `|v|` below this reads exponentially. `0` never switches. */
  exponentialBelow: number;
  /** `|v|` at or above this reads exponentially. */
  exponentialFrom: number;
  /** Decimals the mantissa carries in exponential form, trailing zeros
   * kept. */
  mantissaDecimals: number;
}

/** The rule as it ships — the same three numbers `Settings::default`
 * writes into `settings.json`. */
export const DEFAULT_FLOAT_FORMAT_RULE: FloatFormatRule = {
  exponentialBelow: 1e-4,
  exponentialFrom: 1e6,
  mantissaDecimals: 5,
};

/** Sig figs a value readout renders a float at — the signal panel, the
 * cursor readouts, the measurement strip. */
export const READOUT_SIG_FIGS = 6;

/** Sig figs a y-axis tick label renders at. Narrower than the readouts'
 * six because tick labels have to fit the axis gutter, which starts at
 * 52 px. */
export const TICK_SIG_FIGS = 3;

/** Widest mantissa `Number.prototype.toExponential` is asked for. The
 * host refuses anything above this on the way in; the clamp here is
 * because `toExponential` *throws* rather than degrading, and it runs
 * inside a uPlot axis formatter. */
const MAX_MANTISSA_DECIMALS = 20;

/** The rule as `settings.json` currently has it. Read at call time, so
 * a formatter picks up a settings change on its next render. */
export function floatFormatRule(): FloatFormatRule {
  const s = hostSettings();
  return {
    exponentialBelow: s.float_exponential_below,
    exponentialFrom: s.float_exponential_from,
    mantissaDecimals: Math.min(Math.max(0, Math.trunc(s.float_mantissa_decimals)), MAX_MANTISSA_DECIMALS),
  };
}

/** {@link floatFormatRule}, re-rendering the caller when any of the
 * three settings changes.
 *
 * For a formatter whose output is *cached* rather than recomputed each
 * render — a uPlot axis callback installed at construction — the
 * returned rule belongs in the deps that rebuild it. A component that
 * simply formats during render can call it and drop the result: the
 * re-render is the point. */
export function useFloatFormatRule(): FloatFormatRule {
  const exponentialBelow = useSetting("float_exponential_below");
  const exponentialFrom = useSetting("float_exponential_from");
  const mantissaDecimals = useSetting("float_mantissa_decimals");
  // Not `useMemo`: the identity has to change exactly when one of the
  // three does, which is what a plain object over three primitives
  // already gives a dep array compared by value.
  return {
    exponentialBelow,
    exponentialFrom,
    mantissaDecimals: Math.min(Math.max(0, Math.trunc(mantissaDecimals)), MAX_MANTISSA_DECIMALS),
  };
}

/** Render `v` at `sigFigs` significant figures under the float rule.
 *
 * `rule` defaults to the live settings; pass one to format under
 * something else (a test, or a caller that already read it reactively).
 * `alwaysExponential` is the log-axis case: a log scale's ticks are
 * decade boundaries, and mixing plain and exponential labels on one
 * axis reads as two different quantities. */
export function formatFloat(
  v: number,
  sigFigs: number,
  opts?: { rule?: FloatFormatRule; alwaysExponential?: boolean },
): string {
  if (!Number.isFinite(v)) return "—";
  const rule = opts?.rule ?? floatFormatRule();
  const exponential = () => v.toExponential(rule.mantissaDecimals);
  // Zero first: it is below every small threshold, and `0.00000e+0` is
  // not a reading. That holds on a log axis too, which cannot plot zero
  // in the first place.
  if (v === 0) return "0";
  if (opts?.alwaysExponential) return exponential();
  const magnitude = Math.abs(v);
  if (magnitude < rule.exponentialBelow || magnitude >= rule.exponentialFrom) return exponential();
  // `String` of the rounded value is its shortest exact rendering, so
  // it neither pads nor drops a digit the rounding kept. Below 1e-6 it
  // goes exponential itself, in JS's own trimmed notation — only
  // reachable under a threshold set lower than that, and the rule's
  // exponential form beats leaking JS's.
  const plain = String(Number(v.toPrecision(sigFigs)));
  return plain.includes("e") ? exponential() : plain;
}
