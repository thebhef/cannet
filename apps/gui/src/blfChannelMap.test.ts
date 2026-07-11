import { describe, expect, it } from "vitest";

import {
  recordBlfChannelMap,
  savedBlfChannelMap,
  type BlfChannelMaps,
} from "./blfChannelMap";

const PID = "5f2d7c1e-9a41-4a5e-8b1c-2e6f0d3a9b70";
const BLF = "/captures/drive.blf";

describe("savedBlfChannelMap", () => {
  const maps: BlfChannelMaps = {
    [PID]: {
      by_path: { [BLF]: { "0": "bus-pt", "1": "bus-ch", "2": "" } },
      by_channel_count: { "2": { "0": "bus-ch", "1": "" } },
    },
  };
  const busIds = new Set(["bus-pt", "bus-ch"]);

  it("returns the stored path mapping with numeric channel keys", () => {
    expect(savedBlfChannelMap(maps, PID, BLF, 3, busIds)).toEqual({
      0: "bus-pt",
      1: "bus-ch",
      2: "",
    });
  });

  it("falls back to the same-channel-count mapping for an unknown path", () => {
    expect(savedBlfChannelMap(maps, PID, "/new.blf", 2, busIds)).toEqual({
      0: "bus-ch",
      1: "",
    });
  });

  it("returns undefined when neither path nor channel count is known", () => {
    expect(savedBlfChannelMap(maps, PID, "/new.blf", 5, busIds)).toBeUndefined();
  });

  it("prefers the exact path over the channel-count fallback", () => {
    // BLF is stored with 3 channels; a same-named open with count 2 must
    // still use the path entry, not the count entry.
    expect(savedBlfChannelMap(maps, PID, BLF, 2, busIds)).toEqual({
      0: "bus-pt",
      1: "bus-ch",
      2: "",
    });
  });

  it("degrades a bus id no longer in the project to unmapped", () => {
    expect(savedBlfChannelMap(maps, PID, BLF, 3, new Set(["bus-pt"]))).toEqual({
      0: "bus-pt",
      1: "",
      2: "",
    });
  });

  it("returns undefined without a project id", () => {
    expect(savedBlfChannelMap(maps, null, BLF, 3, busIds)).toBeUndefined();
  });

  it("returns undefined for an unknown project", () => {
    expect(savedBlfChannelMap(maps, "other", BLF, 3, busIds)).toBeUndefined();
  });
});

describe("recordBlfChannelMap", () => {
  it("stores the accepted choices under both path and channel count", () => {
    const next = recordBlfChannelMap({}, PID, BLF, { 0: "bus-pt", 1: "" });
    expect(next).toEqual({
      [PID]: {
        by_path: { [BLF]: { "0": "bus-pt", "1": "" } },
        by_channel_count: { "2": { "0": "bus-pt", "1": "" } },
      },
    });
  });

  it("replaces prior entries for the same key and keeps others", () => {
    const prior: BlfChannelMaps = {
      [PID]: {
        by_path: {
          [BLF]: { "0": "old" },
          "/other.blf": { "0": "bus-ch" },
        },
        by_channel_count: { "2": { "0": "old", "1": "old" } },
      },
    };
    const next = recordBlfChannelMap(prior, PID, BLF, { 0: "bus-pt" });
    expect(next[PID].by_path[BLF]).toEqual({ "0": "bus-pt" });
    expect(next[PID].by_path["/other.blf"]).toEqual({ "0": "bus-ch" });
    expect(next[PID].by_channel_count).toEqual({
      "1": { "0": "bus-pt" },
      "2": { "0": "old", "1": "old" },
    });
    // Pure: the input is not mutated.
    expect(prior[PID].by_path[BLF]).toEqual({ "0": "old" });
  });

  it("is a no-op without a project id", () => {
    const prior: BlfChannelMaps = {};
    expect(recordBlfChannelMap(prior, null, BLF, { 0: "bus-pt" })).toBe(prior);
  });
});
