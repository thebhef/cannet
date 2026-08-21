/// The combined row space: a base space with every open row's
/// disclosed rows spliced in after it (ADR 0044).

import { describe, expect, it } from "vitest";

import { contentRowId, contentRowSpace } from "./gridviewContentRows";

/// The whole space read out as positions, so an ordering claim reads as
/// the order itself rather than as a pile of index arithmetic.
function readOut(space: ReturnType<typeof contentRowSpace>): string[] {
  const out: string[] = [];
  for (let g = 0; g < space.count; g += 1) {
    const p = space.at(g);
    out.push(p == null ? "?" : p.content == null ? `${p.index}` : `${p.index}.${p.content}`);
  }
  return out;
}

describe("content rows in the row space", () => {
  it("is the base space itself when nothing is open", () => {
    const space = contentRowSpace(4, []);
    expect(space.count).toBe(4);
    expect(readOut(space)).toEqual(["0", "1", "2", "3"]);
    expect(space.indexOf({ index: 3, content: null })).toBe(3);
    expect(space.at(4)).toBeNull();
    expect(space.at(-1)).toBeNull();
  });

  it("puts an open row's content directly under it", () => {
    const space = contentRowSpace(4, [{ index: 1, content: 2 }]);
    expect(space.count).toBe(6);
    expect(readOut(space)).toEqual(["0", "1", "1.0", "1.1", "2", "3"]);
  });

  it("shifts every later row by the rows disclosed above it", () => {
    const space = contentRowSpace(6, [
      { index: 1, content: 2 },
      { index: 4, content: 3 },
    ]);
    expect(space.count).toBe(11);
    expect(readOut(space)).toEqual([
      "0",
      "1",
      "1.0",
      "1.1",
      "2",
      "3",
      "4",
      "4.0",
      "4.1",
      "4.2",
      "5",
    ]);
  });

  it("round-trips every position through `indexOf`", () => {
    const space = contentRowSpace(6, [
      { index: 0, content: 1 },
      { index: 1, content: 2 },
      { index: 5, content: 4 },
    ]);
    for (let g = 0; g < space.count; g += 1) {
      const p = space.at(g);
      expect(p).not.toBeNull();
      expect(space.indexOf(p!)).toBe(g);
    }
  });

  it("counts an open row with nothing to disclose as one row", () => {
    // A row whose page hasn't landed reports no content; it is still a
    // row of the space, and it shifts nothing.
    const space = contentRowSpace(3, [{ index: 1, content: 0 }]);
    expect(readOut(space)).toEqual(["0", "1", "2"]);
    expect(space.indexOf({ index: 1, content: 0 })).toBe(-1);
  });

  it("places nothing for a content row of a shut row, or past the last line", () => {
    const space = contentRowSpace(4, [{ index: 2, content: 2 }]);
    expect(space.indexOf({ index: 1, content: 0 })).toBe(-1);
    expect(space.indexOf({ index: 2, content: 2 })).toBe(-1);
    expect(space.indexOf({ index: 2, content: -1 })).toBe(-1);
    expect(space.indexOf({ index: 9, content: null })).toBe(-1);
  });

  it("names a content row by its row and its own name", () => {
    expect(contentRowId("f:12", "EngineSpeed")).toBe("f:12/EngineSpeed");
  });
});
