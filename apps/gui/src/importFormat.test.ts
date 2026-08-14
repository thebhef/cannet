import { describe, expect, it } from "vitest";

import { IMPORT_TRACE_FILTERS, importFormatFor } from "./importFormat";

describe("importFormatFor", () => {
  it("routes a .blf path to blf", () => {
    expect(importFormatFor("/logs/one.blf")).toBe("blf");
  });

  it("routes a .mf4 path to mdf", () => {
    expect(importFormatFor("/logs/one.mf4")).toBe("mdf");
  });

  it("is case-insensitive on the extension", () => {
    expect(importFormatFor("C:\\logs\\ONE.MF4")).toBe("mdf");
    expect(importFormatFor("C:\\logs\\ONE.BLF")).toBe("blf");
  });

  it("falls back to blf for an unrecognized or missing extension", () => {
    expect(importFormatFor("/logs/no-extension")).toBe("blf");
    expect(importFormatFor("/logs/one.log")).toBe("blf");
  });
});

describe("IMPORT_TRACE_FILTERS", () => {
  it("offers all-supported, BLF-only, and MDF-only filters, in that order", () => {
    expect(IMPORT_TRACE_FILTERS.map((f) => f.name)).toEqual([
      "All supported traces",
      "Vector BLF",
      "ASAM MDF",
    ]);
  });

  it("the all-supported filter covers both formats' extensions", () => {
    expect(IMPORT_TRACE_FILTERS[0].extensions).toEqual(["blf", "mf4"]);
  });
});
