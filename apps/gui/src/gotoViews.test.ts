import { describe, expect, it } from "vitest";

import { elementViewEntries } from "./gotoViews";
import type { ProjectElement } from "./types";

const colormap = (id: string, name: string): ProjectElement => ({
  kind: "colormap",
  id,
  name,
  busId: null,
  messageId: 0,
  extended: false,
  signalName: "",
  rules: [],
});
const trace = (id: string, name: string): ProjectElement => ({
  kind: "trace",
  id,
  name,
  sources: ["*"],
});
const filter = (id: string, name: string): ProjectElement => ({
  kind: "filter",
  id,
  name,
  sources: ["*"],
});

describe("elementViewEntries", () => {
  it("lists an element view by its panel id and kind-prefixed label", () => {
    // The color-map case the go-to-view fix exists for: a closed colour map
    // must still be reachable, so it appears regardless of open state. The
    // label is `"Kind: name"` — the same string the palette displays and
    // fuzzy-filters on.
    expect(elementViewEntries([colormap("abc", "Temp map")])).toEqual([
      { id: "colormap-abc", label: "Color Map: Temp map" },
    ]);
  });

  it("uses the same panel-id convention the openers key on", () => {
    expect(elementViewEntries([trace("t1", "Log")])).toEqual([
      { id: "trace-t1", label: "Trace: Log" },
    ]);
  });

  it("omits filters (they have no panel of their own)", () => {
    expect(elementViewEntries([filter("f1", "only powertrain")])).toEqual([]);
  });

  it("keeps element order and includes every panel-backed kind", () => {
    const entries = elementViewEntries([
      colormap("c", "M"),
      filter("f", "F"),
      trace("t", "T"),
    ]);
    expect(entries.map((e) => e.id)).toEqual(["colormap-c", "trace-t"]);
  });
});
