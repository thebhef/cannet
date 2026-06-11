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
    expect(isProjectElement({ kind: "rbs", id: "r" })).toBe(true);
    expect(isProjectElement({ kind: "colormap", id: "c" })).toBe(true);
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
  it("normalises an rbs element: path string-or-null, run strictly boolean", () => {
    // A bare element (hand-edited project / older save) gets the
    // safe defaults: no file, Run off (ADR 0028 — a malformed flag
    // must never auto-transmit).
    const bare = { kind: "rbs", id: "r" } as unknown as ProjectElement;
    expect(normalizeElement(bare)).toMatchObject({
      kind: "rbs",
      path: null,
      run: false,
    });
    const full = {
      kind: "rbs",
      id: "r",
      path: "/sims/rig-a.cannet_rbs",
      run: true,
    } as unknown as ProjectElement;
    expect(normalizeElement(full)).toMatchObject({
      path: "/sims/rig-a.cannet_rbs",
      run: true,
    });
    // Non-boolean run / non-string path are dropped, not coerced.
    const mangled = {
      kind: "rbs",
      id: "r",
      path: 7,
      run: "yes",
    } as unknown as ProjectElement;
    expect(normalizeElement(mangled)).toMatchObject({ path: null, run: false });
  });

  it("defaults `sources` to ['*'] for a consumer loaded without one (old project)", () => {
    // Cast through unknown to simulate the legacy shape that
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
    const tx: ProjectElement = { kind: "transmit", id: "x", sinks: ["p", "c"], frameIds: [] };
    const out = normalizeElement(tx);
    expect(out.kind === "transmit" ? out.sinks : null).toEqual(["p", "c"]);
  });

  it("defaults transmit `frameIds` to [] and preserves an explicit list", () => {
    const bare = { kind: "transmit", id: "x", sinks: [] } as unknown as ProjectElement;
    const out = normalizeElement(bare);
    expect(out.kind === "transmit" ? out.frameIds : null).toEqual([]);
    const withIds = {
      kind: "transmit",
      id: "y",
      sinks: [],
      frameIds: ["f1", "f2"],
    } as ProjectElement;
    const out2 = normalizeElement(withIds);
    expect(out2.kind === "transmit" ? out2.frameIds : null).toEqual(["f1", "f2"]);
  });

  it("preserves a string `name` and drops a malformed one", () => {
    const named = { kind: "trace", id: "t", sources: ["*"], name: "My trace" } as ProjectElement;
    expect((normalizeElement(named) as { name?: string }).name).toBe("My trace");
    const malformed = { kind: "trace", id: "t", sources: ["*"], name: 42 } as unknown as ProjectElement;
    expect((normalizeElement(malformed) as { name?: string }).name).toBeUndefined();
  });

  it("normalises a colormap: coerces target fields and drops malformed rules", () => {
    // A bare / hand-edited colormap loads inert and editable.
    const bare = { kind: "colormap", id: "c" } as unknown as ProjectElement;
    expect(normalizeElement(bare)).toMatchObject({
      kind: "colormap",
      busId: null,
      messageId: 0,
      extended: false,
      signalName: "",
      rules: [],
    });
    // Well-formed fields survive; junk rules are dropped, good ones kept.
    const full = {
      kind: "colormap",
      id: "c",
      busId: "chassis",
      messageId: 0x120,
      extended: true,
      signalName: "Gear",
      rules: [
        { min: 0, max: 0, color: "#111" },
        { min: 1, color: "#222" }, // missing max → dropped
        { min: 2, max: 2, color: 3 }, // non-string color → dropped
        { min: 3, max: 5, color: "#333" },
      ],
    } as unknown as ProjectElement;
    expect(normalizeElement(full)).toMatchObject({
      busId: "chassis",
      messageId: 0x120,
      extended: true,
      signalName: "Gear",
      rules: [
        { min: 0, max: 0, color: "#111" },
        { min: 3, max: 5, color: "#333" },
      ],
    });
    // A colormap never gains a `sources` field (it's not a consumer).
    expect((normalizeElement(bare) as { sources?: unknown }).sources).toBeUndefined();
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

  it("returns the same entries ref when the patch changes nothing", () => {
    // A patch whose values equal the element's current values must not
    // allocate a new entries array — otherwise a caller that derives the
    // patch in a render effect and depends on the registry identity (the
    // transmit panel's sinks-sync effect) re-fires forever: update → new
    // entries → new registry value → effect re-runs → update → …
    // Arrays are compared by content because the deriving effect builds a
    // fresh array every render, so reference equality alone never holds.
    const before = [trace("t1", ["b1", "b2"])];
    expect(applyElementPatch(before, "t1", { sources: ["b1", "b2"] })).toBe(before);
  });

  it("returns the same entries ref for a no-op transmit sinks patch", () => {
    const tx: RegistryEntry = {
      element: { kind: "transmit", id: "x", sinks: ["b1"], frameIds: [] },
      trace: freshTrace(0),
    };
    const before = [tx];
    expect(applyElementPatch(before, "x", { sinks: ["b1"] })).toBe(before);
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
