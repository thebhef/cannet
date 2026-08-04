import { describe, expect, it } from "vitest";

import {
  emptyBlfChannelMaps,
  recordBlfChannelMap,
  savedBlfChannelMap,
  type BlfChannelMaps,
} from "./blfChannelMap";

const BLF = "/captures/drive.blf";

describe("savedBlfChannelMap", () => {
  const maps: BlfChannelMaps = {
    by_path: { [BLF]: { "0": "bus-pt", "1": "bus-ch", "2": "" } },
    by_channel_count: { "2": { "0": "bus-ch", "1": "" } },
  };
  const busIds = new Set(["bus-pt", "bus-ch"]);

  it("returns the stored path mapping with numeric channel keys", () => {
    expect(savedBlfChannelMap(maps, BLF, 3, busIds)).toEqual({
      0: "bus-pt",
      1: "bus-ch",
      2: "",
    });
  });

  it("falls back to the same-channel-count mapping for an unknown path", () => {
    expect(savedBlfChannelMap(maps, "/new.blf", 2, busIds)).toEqual({
      0: "bus-ch",
      1: "",
    });
  });

  it("returns undefined when neither path nor channel count is known", () => {
    expect(savedBlfChannelMap(maps, "/new.blf", 5, busIds)).toBeUndefined();
  });

  it("prefers the exact path over the channel-count fallback", () => {
    // BLF is stored with 3 channels; a same-named open with count 2 must
    // still use the path entry, not the count entry.
    expect(savedBlfChannelMap(maps, BLF, 2, busIds)).toEqual({
      0: "bus-pt",
      1: "bus-ch",
      2: "",
    });
  });

  it("degrades a bus id no longer in the project to unmapped", () => {
    expect(savedBlfChannelMap(maps, BLF, 3, new Set(["bus-pt"]))).toEqual({
      0: "bus-pt",
      1: "",
      2: "",
    });
  });

  it("returns undefined for a project that has mapped nothing", () => {
    expect(
      savedBlfChannelMap(emptyBlfChannelMaps(), BLF, 3, busIds),
    ).toBeUndefined();
  });
});

describe("recordBlfChannelMap", () => {
  it("stores the accepted choices under both path and channel count", () => {
    const next = recordBlfChannelMap(emptyBlfChannelMaps(), BLF, {
      0: "bus-pt",
      1: "",
    });
    expect(next).toEqual({
      by_path: { [BLF]: { "0": "bus-pt", "1": "" } },
      by_channel_count: { "2": { "0": "bus-pt", "1": "" } },
    });
  });

  it("replaces prior entries for the same key and keeps others", () => {
    const prior: BlfChannelMaps = {
      by_path: {
        [BLF]: { "0": "old" },
        "/other.blf": { "0": "bus-ch" },
      },
      by_channel_count: { "2": { "0": "old", "1": "old" } },
    };
    const next = recordBlfChannelMap(prior, BLF, { 0: "bus-pt" });
    expect(next.by_path[BLF]).toEqual({ "0": "bus-pt" });
    expect(next.by_path["/other.blf"]).toEqual({ "0": "bus-ch" });
    expect(next.by_channel_count).toEqual({
      "1": { "0": "bus-pt" },
      "2": { "0": "old", "1": "old" },
    });
    // Pure: the input is not mutated.
    expect(prior.by_path[BLF]).toEqual({ "0": "old" });
  });

  it("records a mapping without needing a project id", () => {
    // The project directory is the scoping (ADR 0042), so there is no
    // "nothing durable to bind this to" case left: an unsaved project
    // remembers its mappings exactly like a named one.
    const next = recordBlfChannelMap(emptyBlfChannelMaps(), BLF, {
      0: "bus-pt",
    });
    expect(next.by_path[BLF]).toEqual({ "0": "bus-pt" });
  });
});
