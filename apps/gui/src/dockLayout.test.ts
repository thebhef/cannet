import { describe, expect, it } from "vitest";

import { parseSavedLayout } from "./dockLayout";

describe("parseSavedLayout", () => {
  it("returns null for missing input", () => {
    expect(parseSavedLayout(null)).toBeNull();
    expect(parseSavedLayout(undefined)).toBeNull();
    expect(parseSavedLayout("")).toBeNull();
  });

  it("returns null for non-JSON input", () => {
    expect(parseSavedLayout("{not json")).toBeNull();
    expect(parseSavedLayout("undefined")).toBeNull();
  });

  it("returns null for JSON that isn't a layout object", () => {
    expect(parseSavedLayout("42")).toBeNull();
    expect(parseSavedLayout("null")).toBeNull();
    expect(parseSavedLayout('"a string"')).toBeNull();
    expect(parseSavedLayout("[1, 2, 3]")).toBeNull();
    expect(parseSavedLayout('{"grid": {}}')).toBeNull();
    expect(parseSavedLayout('{"panels": {}}')).toBeNull();
  });

  it("returns the parsed object when it has the dockview layout shape", () => {
    const layout = { grid: { root: {}, width: 800, height: 600 }, panels: {} };
    expect(parseSavedLayout(JSON.stringify(layout))).toEqual(layout);
  });
});
