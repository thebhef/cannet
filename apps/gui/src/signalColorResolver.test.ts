import { describe, expect, it } from "vitest";

import {
  buildSignalColorResolver,
  resolveSignalColor,
  type SignalColorGenerator,
} from "./signalColorResolver";
import { stableSignalColor, wheelColor } from "./palette";
import { signalKey } from "./plotData";

/// The empty generator slot — what every signal sees until a project
/// element declares a generator rule.
const NO_GENERATOR: SignalColorGenerator = () => null;

const KEY = signalKey("bus-a", 256, false, "Cell5");

describe("resolveSignalColor", () => {
  it("returns the explicit pick over both the generator and the hash", () => {
    expect(resolveSignalColor(KEY, "#abcdef", () => 3)).toBe("#abcdef");
  });

  it("falls through an empty generator slot to the identity hash", () => {
    expect(resolveSignalColor(KEY, null, NO_GENERATOR)).toBe(stableSignalColor(KEY));
    expect(resolveSignalColor(KEY, undefined, NO_GENERATOR)).toBe(stableSignalColor(KEY));
  });

  it("takes the generator's wheel index when one claims the signal", () => {
    expect(resolveSignalColor(KEY, null, () => 5)).toBe(wheelColor(5));
  });

  it("honours wheel index 0 rather than reading it as no answer", () => {
    expect(resolveSignalColor(KEY, null, () => 0)).toBe(wheelColor(0));
  });

  it("asks the generator with the same canonical key it hashes", () => {
    const seen: string[] = [];
    resolveSignalColor(KEY, null, (k) => {
      seen.push(k);
      return null;
    });
    expect(seen).toEqual([KEY]);
  });

  it("gives two signals of one message their own colors", () => {
    const a = signalKey("bus-a", 256, false, "Cell1");
    const b = signalKey("bus-a", 256, false, "Cell2");
    expect(resolveSignalColor(a, null, NO_GENERATOR)).not.toBe(
      resolveSignalColor(b, null, NO_GENERATOR),
    );
  });
});

describe("buildSignalColorResolver", () => {
  it("resolves through the empty slot: no project element declares a generator yet", () => {
    const resolve = buildSignalColorResolver([]);
    expect(resolve(KEY)).toBe(stableSignalColor(KEY));
    expect(resolve(KEY, "#123456")).toBe("#123456");
  });
});
