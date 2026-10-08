import { describe, expect, it } from "vitest";

import { formatDatePattern, parseDatePattern, type DatePattern } from "./datePattern";
import VECTORS from "./datePattern.vectors.json?raw";

// The vector file the host's `date_pattern.rs` is held to as well
// (ADR 0062): one subset, two implementations, one set of answers.
interface FormatCase {
  pattern: string;
  seconds: number;
  nanos: number;
  offsetMinutes: number;
  timeZone?: string;
  expected: string;
}

const vectors = JSON.parse(VECTORS) as {
  format: FormatCase[];
  errors: { pattern: string; error: string }[];
  displayOnly: FormatCase[];
};

function parsed(pattern: string): DatePattern {
  const r = parseDatePattern(pattern);
  if ("error" in r) throw new Error(`${JSON.stringify(pattern)} failed to parse: ${r.error}`);
  return r;
}

const render = (c: FormatCase) =>
  formatDatePattern(parsed(c.pattern), { seconds: c.seconds, nanos: c.nanos }, c.offsetMinutes, c.timeZone);

describe("date pattern — shared vectors", () => {
  it.each(vectors.format.map((c) => [c.pattern, c.offsetMinutes, c] as const))(
    "%j at offset %d",
    (_p, _o, c) => {
      expect(render(c)).toBe(c.expected);
    },
  );

  it.each(vectors.errors.map((c) => [c.pattern, c.error] as const))("%j is refused", (pattern, error) => {
    expect(parseDatePattern(pattern)).toEqual({ error });
  });

  it.each(vectors.displayOnly.map((c) => [c.pattern, c.timeZone, c] as const))(
    "%j in %s renders the zone name (display only)",
    (_p, _z, c) => {
      expect(render(c)).toBe(c.expected);
    },
  );

  it("exercises every letter of the subset", () => {
    const all = [...vectors.format, ...vectors.displayOnly].map((c) => c.pattern).join("");
    for (const letter of "yMdEHhamsSxXz") expect(all).toContain(letter);
  });
});
