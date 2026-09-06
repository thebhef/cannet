import { describe, expect, it } from "vitest";

import {
  DEFAULT_SAVE_CAPTURE_NAME,
  SAVE_CAPTURE_FILTERS,
  exportFolderOf,
  joinExportPath,
  saveCaptureExtension,
  saveCaptureFilters,
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

describe("saveCaptureFilters", () => {
  it("puts the last-used format's filter first", () => {
    // An OS save dialog pre-selects the first filter it is given, and
    // that is the only handle on which one it opens with — so the
    // sticky format is expressed as filter order.
    expect(saveCaptureFilters("mdf").map((f) => f.extensions[0])).toEqual([
      "mf4",
      "blf",
    ]);
    expect(saveCaptureFilters("blf").map((f) => f.extensions[0])).toEqual([
      "blf",
      "mf4",
    ]);
  });

  it("still offers both formats whichever was last used", () => {
    expect(saveCaptureFilters("mdf")).toHaveLength(SAVE_CAPTURE_FILTERS.length);
  });
});

describe("saveCaptureExtension", () => {
  it("names the extension a format's file carries", () => {
    expect(saveCaptureExtension("blf")).toBe(".blf");
    expect(saveCaptureExtension("mdf")).toBe(".mf4");
  });
});

describe("picker seeding", () => {
  it("joins a remembered folder to a file name with the folder's own separator", () => {
    expect(joinExportPath("C:\\logs\\bench", "run.blf")).toBe("C:\\logs\\bench\\run.blf");
    expect(joinExportPath("/var/logs", "run.blf")).toBe("/var/logs/run.blf");
  });

  it("does not double a separator the folder already ends with", () => {
    expect(joinExportPath("C:\\logs\\", "run.blf")).toBe("C:\\logs\\run.blf");
    expect(joinExportPath("/var/logs/", "run.blf")).toBe("/var/logs/run.blf");
  });

  it("takes the folder back off a path the picker returned", () => {
    expect(exportFolderOf("C:\\logs\\bench\\run.blf")).toBe("C:\\logs\\bench");
    expect(exportFolderOf("/var/logs/run.blf")).toBe("/var/logs");
  });

  it("remembers no folder for a bare file name", () => {
    // Nothing to remember beats remembering the empty string, which
    // would seed the next picker with an unopenable folder.
    expect(exportFolderOf("run.blf")).toBeNull();
  });
});
