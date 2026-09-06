import { describe, expect, it } from "vitest";

import {
  findLogNode,
  flattenLogTree,
  formatLogDuration,
  formatLogModified,
  formatLogSize,
  formatLogTimestamp,
  isSelectableLogNode,
  logPathSeparator,
  type LogFileNode,
} from "./logFileGrid";

const FILE_A: LogFileNode = {
  kind: "file",
  id: "/logs/a.blf",
  name: "a.blf",
  sizeBytes: 1_048_576,
  startNs: 1_700_000_000_000_000_000,
  endNs: 1_700_000_010_000_000_000,
  messageCount: 100,
  modifiedMs: 1_700_000_010_000,
  writing: false,
};

const WRITING: LogFileNode = {
  kind: "file",
  id: "/logs/open.blf",
  name: "open.blf",
  sizeBytes: 512,
  startNs: null,
  endNs: null,
  messageCount: 3,
  modifiedMs: 1_700_000_020_000,
  writing: true,
};

const SUB: LogFileNode = {
  kind: "dir",
  id: "/logs/sub",
  name: "sub",
  children: [FILE_A],
};

describe("flattenLogTree", () => {
  it("lists top-level rows without descending into a collapsed branch", () => {
    const rows = flattenLogTree([SUB, WRITING], new Set());
    expect(rows.map((r) => r.node.id)).toEqual(["/logs/sub", "/logs/open.blf"]);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });

  it("splices an expanded branch's children in at depth + 1", () => {
    const rows = flattenLogTree([SUB, WRITING], new Set(["/logs/sub"]));
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([
      ["/logs/sub", 0],
      ["/logs/a.blf", 1],
      ["/logs/open.blf", 0],
    ]);
  });

  it("recurses through nested branches", () => {
    const nested: LogFileNode = { kind: "dir", id: "/logs/x", name: "x", children: [SUB] };
    const rows = flattenLogTree([nested], new Set(["/logs/x", "/logs/sub"]));
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([
      ["/logs/x", 0],
      ["/logs/sub", 1],
      ["/logs/a.blf", 2],
    ]);
  });
});

describe("findLogNode", () => {
  it("finds a top-level node", () => {
    expect(findLogNode([SUB, WRITING], "/logs/open.blf")).toBe(WRITING);
  });

  it("finds a node nested inside a directory", () => {
    expect(findLogNode([SUB], "/logs/a.blf")).toBe(FILE_A);
  });

  it("returns null for an id the tree does not hold", () => {
    expect(findLogNode([SUB], "/logs/nope.blf")).toBeNull();
  });
});

describe("isSelectableLogNode", () => {
  it("a finished file is selectable", () => {
    expect(isSelectableLogNode(FILE_A)).toBe(true);
  });

  it("the writing row is not selectable", () => {
    expect(isSelectableLogNode(WRITING)).toBe(false);
  });

  it("a directory is not selectable", () => {
    expect(isSelectableLogNode(SUB)).toBe(false);
  });
});

describe("formatLogTimestamp", () => {
  it("renders a UTC ISO 8601 string at second resolution", () => {
    // 1_700_000_000 s since epoch = 2023-11-14T22:13:20Z.
    expect(formatLogTimestamp(1_700_000_000_000_000_000)).toBe("2023-11-14T22:13:20Z");
  });

  it("renders empty for an unknown timestamp (the writing row)", () => {
    expect(formatLogTimestamp(null)).toBe("");
  });
});

describe("formatLogDuration", () => {
  it("renders whole seconds under a minute", () => {
    expect(formatLogDuration(0, 5_000_000_000)).toBe("5.0 s");
  });

  it("renders rounded minutes at or above 60 s", () => {
    expect(formatLogDuration(0, 125_000_000_000)).toBe("2 min");
  });

  it("renders one decimal of hours at or above 90 minutes", () => {
    expect(formatLogDuration(0, 5_400_000_000_000)).toBe("1.5 h");
  });

  it("renders empty when either end is unknown", () => {
    expect(formatLogDuration(null, 1)).toBe("");
    expect(formatLogDuration(0, null)).toBe("");
  });
});

describe("formatLogSize", () => {
  it("renders one decimal of megabytes", () => {
    expect(formatLogSize(1_572_864)).toBe("1.5 MB");
  });
});

describe("formatLogModified", () => {
  it("renders a local date and minute", () => {
    const d = new Date(2026, 8, 4, 17, 22);
    expect(formatLogModified(d.getTime())).toBe("2026-09-04 17:22");
  });
});

describe("logPathSeparator", () => {
  it("is the separator of the folder the host resolved, not always Windows'", () => {
    expect(logPathSeparator("C:\\proj\\logs\\bench")).toBe("\\");
    expect(logPathSeparator("/Users/dev/proj/logs/bench")).toBe("/");
  });
});
