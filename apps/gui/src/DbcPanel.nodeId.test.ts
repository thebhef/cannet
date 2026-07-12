import { describe, expect, it } from "vitest";

import type { DbcContentRecord } from "./types";
import {
  groupByBus,
  buildSearchIndex,
  dbcKey,
  dbcNodeId,
  expandedFromParams,
} from "./DbcPanel";

// Minimal but fully-typed content records. Two DBCs deliberately share a
// filename (from different directories) to exercise the duplicate-basename
// disambiguation. Paths carry a directory segment (the `/`) so that if a
// builder ever embedded the raw path in a node id, the "no separator"
// assertions below would catch it.
const SIGNAL_DEFAULTS = {
  startBit: 0,
  length: 8,
  byteOrder: "little" as const,
  signed: false,
  factor: 1,
  offset: 0,
  min: 0,
  max: 0,
  mux: { kind: "plain" as const },
  floatKind: "integer" as const,
};
const MESSAGE_DEFAULTS = {
  expectedLen: 8,
  isFd: false,
  brs: false,
  usesExtendedMux: false,
  transmitter: null as string | null,
};

function makeDbc(dbcPath: string): DbcContentRecord {
  return {
    dbcPath,
    messages: [
      {
        ...MESSAGE_DEFAULTS,
        messageId: 256,
        extended: false,
        name: "Msg",
        transmitter: "EcuA",
        comment: "",
        attributes: [],
        signals: [
          { ...SIGNAL_DEFAULTS, name: "Sig", unit: "", comment: "", attributes: [], valueTable: [] },
        ],
      },
    ],
  };
}

const CONTENT: DbcContentRecord[] = [
  makeDbc("dbc/pack.dbc"),
  makeDbc("vendor/pack.dbc"), // same filename, different directory
  makeDbc("dbc/zonal.dbc"),
];

describe("dbcKey", () => {
  it("is index + filename, dropping the directory", () => {
    expect(dbcKey(0, "dbc/pack.dbc")).toBe("0:pack.dbc");
    expect(dbcKey(2, "some/nested/dir/zonal.dbc")).toBe("2:zonal.dbc");
    expect(dbcKey(1, "some\\win\\pack.dbc")).toBe("1:pack.dbc"); // Windows separators too
  });

  it("carries no path separator", () => {
    expect(dbcKey(0, "dbc/pack.dbc")).not.toMatch(/[/\\]/);
  });

  it("disambiguates two DBCs that share a filename", () => {
    expect(dbcKey(0, "a/pack.dbc")).not.toBe(dbcKey(1, "b/pack.dbc"));
  });
});

describe("expandedFromParams", () => {
  it("drops legacy path-bearing ids so a load→save can't reintroduce a leak", () => {
    const restored = expandedFromParams([
      "bus:pack",
      "dbc:pack::dbc/pack.dbc", // legacy id embedded a path (has a separator)
      "ecu:pack::dbc/pack.dbc::BMS",
      "dbc:pack::0:pack.dbc", // current scheme
    ]);
    expect([...restored]).toEqual(["bus:pack", "dbc:pack::0:pack.dbc"]);
  });
});

describe("DBC tree node ids", () => {
  it("never embed the DBC's path, so nothing path-shaped reaches the saved layout", () => {
    const groups = groupByBus(CONTENT, [], {});
    const ids = buildSearchIndex(groups).flatMap((e) => [e.id, ...e.ancestors]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).not.toMatch(/[/\\]/); // no path separators
    }
  });

  it("keys DBC rows by index + filename, distinct even when filenames collide", () => {
    const groups = groupByBus(CONTENT, [], {});
    const keys = groups[0].dbcs.map((d) => d.key);
    expect(keys).toEqual(["0:pack.dbc", "1:pack.dbc", "2:zonal.dbc"]);
    expect(dbcNodeId(groups[0].busId, keys[0])).toBe("dbc::::all::0:pack.dbc");
  });
});
