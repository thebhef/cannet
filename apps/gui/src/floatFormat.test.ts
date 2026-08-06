import { beforeEach, describe, expect, it, vi } from "vitest";

// The rule reads `settings.json` through the shared host-settings cache,
// so these tests need a host to hydrate it from.
let storedSettings: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...storedSettings } : null)),
}));

const {
  DEFAULT_FLOAT_FORMAT_RULE,
  READOUT_SIG_FIGS,
  TICK_SIG_FIGS,
  floatFormatRule,
  formatFloat,
} = await import("./floatFormat");
const { hydrateSettings } = await import("./hostSettings");

beforeEach(async () => {
  storedSettings = {};
  await hydrateSettings();
});

/** The readouts' budget — six significant figures. */
const readout = (v: number) => formatFloat(v, READOUT_SIG_FIGS);
/** The y-axis tick labels' narrower budget — three. */
const tick = (v: number) => formatFloat(v, TICK_SIG_FIGS);

describe("formatFloat", () => {
  it("switches at the small threshold and not before", () => {
    // The edge, exactly: 1e-4 is the smallest value still written out
    // in full, and the next decade down is the largest that switches.
    expect(readout(0.0001)).toBe("0.0001");
    expect(readout(0.00001)).toBe("1.00000e-5");
    expect(tick(0.0001)).toBe("0.0001");
    expect(tick(0.00001)).toBe("1.00000e-5");
  });

  it("switches at the large threshold and not before", () => {
    expect(readout(999999.4)).toBe("999999");
    expect(readout(1e6)).toBe("1.00000e+6");
    expect(tick(999999.4)).toBe("1000000");
    expect(tick(1e6)).toBe("1.00000e+6");
  });

  it("renders zero plainly, never as a mantissa of zeroes", () => {
    // Zero is below every small threshold, so the magnitude rule alone
    // would send it exponential — `0.00000e+0` is not a reading anyone
    // wants.
    expect(readout(0)).toBe("0");
    expect(tick(0)).toBe("0");
    expect(readout(-0)).toBe("0");
    // Even on a log axis, which otherwise always labels exponentially.
    expect(formatFloat(0, TICK_SIG_FIGS, { alwaysExponential: true })).toBe("0");
  });

  it("takes the thresholds on the magnitude, so negatives switch with their positives", () => {
    expect(readout(-0.0001)).toBe("-0.0001");
    expect(readout(-0.00001)).toBe("-1.00000e-5");
    expect(readout(-999999.4)).toBe("-999999");
    expect(readout(-1e6)).toBe("-1.00000e+6");
  });

  it("gives the mantissa exactly five decimals, trailing zeros kept", () => {
    // The whole point of the width: `1e-6` reads as a rounded value at
    // the precision every other exponential reading carries.
    expect(readout(0.000001)).toBe("1.00000e-6");
    expect(readout(0.0000123456789)).toBe("1.23457e-5");
    expect(readout(-0.0000123456789)).toBe("-1.23457e-5");
    expect(readout(1.5e9)).toBe("1.50000e+9");
    // The mantissa width is the rule's, not the view's: a tick label
    // carries the same five decimals the readouts do.
    expect(tick(1234567)).toBe("1.23457e+6");
  });

  it("renders nine decimals rather than switch, at the worst plain case", () => {
    // A six-significant-figure mantissa sitting just above the small
    // threshold. This is the widest a plain reading gets, and it is the
    // case the old "more than five decimals" rule sent exponential.
    expect(readout(0.000123456)).toBe("0.000123456");
    expect(readout(0.123456)).toBe("0.123456");
  });

  it("rounds plainly to the view's own sig-fig budget, with no padding", () => {
    expect(readout(1.23456789)).toBe("1.23457");
    expect(readout(0.5)).toBe("0.5");
    expect(readout(12)).toBe("12");
    expect(tick(1.23456789)).toBe("1.23");
    expect(tick(1234)).toBe("1230");
    expect(tick(0.5)).toBe("0.5");
  });

  it("always labels exponentially on a log axis, whatever the magnitude", () => {
    // A log axis's ticks are decade boundaries; reading `1`, `10`,
    // `100` plainly and `1.00000e+6` beyond the threshold would make one
    // axis carry two notations.
    expect(formatFloat(1, TICK_SIG_FIGS, { alwaysExponential: true })).toBe("1.00000e+0");
    expect(formatFloat(100, TICK_SIG_FIGS, { alwaysExponential: true })).toBe("1.00000e+2");
    expect(formatFloat(0.001, TICK_SIG_FIGS, { alwaysExponential: true })).toBe("1.00000e-3");
  });

  it("answers an em-dash for a value that is not a number", () => {
    expect(readout(Number.NaN)).toBe("—");
    expect(readout(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("floatFormatRule", () => {
  it("is the documented rule when nothing is set", () => {
    expect(floatFormatRule()).toEqual(DEFAULT_FLOAT_FORMAT_RULE);
    expect(DEFAULT_FLOAT_FORMAT_RULE).toEqual({
      exponentialBelow: 1e-4,
      exponentialFrom: 1e6,
      mantissaDecimals: 5,
    });
  });

  it("follows the settings, and so does every formatter reading it", async () => {
    storedSettings = {
      float_exponential_below: 1e-2,
      float_exponential_from: 1e3,
      float_mantissa_decimals: 2,
    };
    await hydrateSettings();

    expect(floatFormatRule()).toEqual({
      exponentialBelow: 1e-2,
      exponentialFrom: 1e3,
      mantissaDecimals: 2,
    });
    // Values that read plainly under the defaults now switch, at the
    // narrower mantissa the settings ask for.
    expect(readout(0.005)).toBe("5.00e-3");
    expect(readout(1234)).toBe("1.23e+3");
    // …and the ones inside the widened plain band stay plain.
    expect(readout(0.05)).toBe("0.05");
    expect(readout(999)).toBe("999");
  });

  it("takes an explicit rule over the settings, for a caller that has one", () => {
    const rule = { exponentialBelow: 0, exponentialFrom: 10, mantissaDecimals: 1 };
    // `exponentialBelow: 0` is "never switch at the small end".
    expect(formatFloat(0.00001, READOUT_SIG_FIGS, { rule })).toBe("0.00001");
    expect(formatFloat(10, READOUT_SIG_FIGS, { rule })).toBe("1.0e+1");
  });

  it("switches anyway below what a plain rendering can express", () => {
    // JavaScript writes its own numbers exponentially below 1e-6, so a
    // threshold under that has nothing plain to fall back to. Rendering
    // the rule's exponential form beats leaking JS's trimmed one.
    const never = { exponentialBelow: 0, exponentialFrom: 1e6, mantissaDecimals: 5 };
    expect(formatFloat(1e-7, READOUT_SIG_FIGS, { rule: never })).toBe("1.00000e-7");
  });

  it("clamps a mantissa width the renderer would refuse", async () => {
    // The host bounds this on ingress, so the clamp only ever catches a
    // value that reached the cache another way — but `toExponential`
    // throws rather than degrading, and it runs inside an axis
    // formatter.
    storedSettings = { float_mantissa_decimals: 5000 };
    await hydrateSettings();
    expect(() => readout(1e-9)).not.toThrow();
  });
});
