import { describe, expect, it } from "vitest";

import {
  applyElementPatch,
  isProjectElement,
  normalizeElement,
} from "./projectElements";
import type { RegistryEntry } from "./projectElements";
import type { ProjectElement } from "./types";
import { freshTrace } from "./trace";

describe("isProjectElement", () => {
  it("accepts each known kind with an id", () => {
    expect(isProjectElement({ kind: "trace", id: "t" })).toBe(true);
    expect(isProjectElement({ kind: "plot", id: "p" })).toBe(true);
    expect(isProjectElement({ kind: "filter", id: "f" })).toBe(true);
    expect(isProjectElement({ kind: "transmit", id: "x" })).toBe(true);
  });

  it("rejects unknown kinds, non-strings, and primitives", () => {
    expect(isProjectElement({ kind: "wat", id: "x" })).toBe(false);
    expect(isProjectElement({ kind: "trace" })).toBe(false);
    expect(isProjectElement({ kind: "trace", id: 9 })).toBe(false);
    expect(isProjectElement(null)).toBe(false);
    expect(isProjectElement("nope")).toBe(false);
  });
});

describe("normalizeElement", () => {
  it("defaults `sources` to ['*'] for a consumer loaded without one (old project)", () => {
    // Cast through unknown to simulate the pre-Phase-6 shape that
    // saved projects on disk still have.
    const stored = { kind: "trace", id: "t", source: "p" } as unknown as ProjectElement;
    const out = normalizeElement(stored);
    expect(out).toMatchObject({ kind: "trace", id: "t", sources: ["*"] });
  });

  it("preserves an explicit `sources` array verbatim", () => {
    const el: ProjectElement = {
      kind: "trace",
      id: "t",
      sources: ["b1", "b2", "filter-3"],
    };
    const out = normalizeElement(el);
    expect(out.kind === "trace" ? out.sources : null).toEqual([
      "b1",
      "b2",
      "filter-3",
    ]);
  });

  it("preserves an empty `sources` (the 'matches nothing' shape)", () => {
    const el: ProjectElement = { kind: "trace", id: "t", sources: [] };
    const out = normalizeElement(el);
    expect(out.kind === "trace" ? out.sources : null).toEqual([]);
  });

  it("falls back to ['*'] when `sources` is malformed", () => {
    // A non-string-array `sources` — corrupt or future-shape — gets
    // the wildcard default rather than crashing the load.
    const stored = { kind: "plot", id: "p", sources: [1, 2] } as unknown as ProjectElement;
    const out = normalizeElement(stored);
    expect(out.kind === "plot" ? out.sources : null).toEqual(["*"]);
  });

  it("defaults transmit `sinks` to [] on a project lacking the field", () => {
    const tx = { kind: "transmit", id: "x" } as unknown as ProjectElement;
    const out = normalizeElement(tx);
    expect(out.kind === "transmit" ? out.sinks : null).toEqual([]);
  });

  it("preserves a transmit's explicit `sinks` list verbatim", () => {
    const tx: ProjectElement = { kind: "transmit", id: "x", sinks: ["p", "c"] };
    const out = normalizeElement(tx);
    expect(out.kind === "transmit" ? out.sinks : null).toEqual(["p", "c"]);
  });

  it("normalises a filter, preserving its name + predicate", () => {
    const f: ProjectElement = {
      kind: "filter",
      id: "f1",
      name: "powertrain",
      sources: ["b1"],
      predicate: { bus: "b1" },
    };
    const out = normalizeElement(f);
    expect(out).toMatchObject({ kind: "filter", id: "f1", sources: ["b1"] });
    expect((out as { name?: string }).name).toBe("powertrain");
  });
});

describe("applyElementPatch", () => {
  const trace = (
    id: string,
    sources: string[] = ["*"],
  ): RegistryEntry => ({
    element: { kind: "trace", id, sources },
    trace: freshTrace(0),
  });
  const filter = (
    id: string,
    sources: string[] = ["*"],
  ): RegistryEntry => ({
    element: { kind: "filter", id, sources },
    trace: freshTrace(0),
  });

  it("merges patch into the matching element", () => {
    const before = [trace("t1")];
    const after = applyElementPatch(before, "t1", { sources: ["b1"] });
    expect(after).not.toBe(before);
    expect(
      after[0].element.kind === "trace" ? after[0].element.sources : null,
    ).toEqual(["b1"]);
  });

  it("is a no-op on unknown id", () => {
    const before = [trace("t1")];
    expect(applyElementPatch(before, "nope", { sources: [] })).toBe(before);
  });

  it("refuses a kind/id mismatch (stale closure protection)", () => {
    const before = [trace("t1")];
    expect(
      applyElementPatch(before, "t1", { kind: "plot", sources: [] }),
    ).toBe(before);
    expect(applyElementPatch(before, "t1", { id: "other" })).toBe(before);
  });

  it("refuses a filter→filter source patch that would create a self-loop", () => {
    const before = [filter("f1")];
    const after = applyElementPatch(before, "f1", { sources: ["f1"] });
    expect(after).toBe(before);
  });

  it("refuses a filter source patch that closes a longer cycle", () => {
    // Data flow A → B → C (each consumer reads from the previous).
    // Patching A.sources=[C] would make A read from C; walking
    // A→C→B→A closes the loop.
    const before = [filter("A", ["*"]), filter("B", ["A"]), filter("C", ["B"])];
    const after = applyElementPatch(before, "A", { sources: ["C"] });
    expect(after).toBe(before);
  });

  it("accepts a filter chain that doesn't cycle", () => {
    // A reads buses; B reads A. Patching B.sources=[A] is fine.
    const before = [filter("A"), filter("B")];
    const after = applyElementPatch(before, "B", { sources: ["A"] });
    expect(
      after[1].element.kind === "filter" ? after[1].element.sources : null,
    ).toEqual(["A"]);
  });
});
