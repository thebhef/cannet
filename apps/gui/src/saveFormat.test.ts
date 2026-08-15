import { describe, expect, it } from "vitest";

import {
  DEFAULT_SAVE_CAPTURE_NAME,
  SAVE_CAPTURE_FILTERS,
  saveFormatFor,
} from "./saveFormat";

describe("save dialog filters", () => {
  it("offers BLF and MDF, in that order", () => {
    expect(SAVE_CAPTURE_FILTERS.map((f) => f.extensions[0])).toEqual([
      "blf",
      "mf4",
    ]);
  });

  it("defaults to the first filter's extension", () => {
    expect(DEFAULT_SAVE_CAPTURE_NAME.endsWith(".blf")).toBe(true);
  });
});

describe("saveFormatFor", () => {
  it("reads MDF off the extension the dialog stamped", () => {
    expect(saveFormatFor("/tmp/run.mf4")).toBe("mdf");
    expect(saveFormatFor("C:\\logs\\run.MF4")).toBe("mdf");
    expect(saveFormatFor("/tmp/run.mdf")).toBe("mdf");
  });

  it("reads BLF off a BLF extension", () => {
    expect(saveFormatFor("/tmp/run.blf")).toBe("blf");
    expect(saveFormatFor("/tmp/run.BLF")).toBe("blf");
  });

  it("falls back to BLF for a path with no extension we know", () => {
    expect(saveFormatFor("/tmp/run")).toBe("blf");
    expect(saveFormatFor("/tmp/run.txt")).toBe("blf");
    expect(saveFormatFor("")).toBe("blf");
  });

  it("is not fooled by an extension in the middle of the path", () => {
    expect(saveFormatFor("/tmp/mf4-archive/run.blf")).toBe("blf");
    expect(saveFormatFor("/tmp/blf/run.mf4")).toBe("mdf");
  });
});
