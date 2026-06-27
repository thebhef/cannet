import { describe, expect, it } from "vitest";

import {
  RECENT_BLFS_LIMIT,
  forgetRecentBlf,
  recordRecentBlf,
} from "./recentBlfs";

describe("recentBlfs", () => {
  it("recordRecentBlf prepends, dedupes, and caps", () => {
    const a = recordRecentBlf([], "/a.blf");
    expect(a).toEqual(["/a.blf"]);
    const b = recordRecentBlf(a, "/b.blf");
    expect(b).toEqual(["/b.blf", "/a.blf"]);
    // Re-touching `/a.blf` lifts it back to the front.
    const c = recordRecentBlf(b, "/a.blf");
    expect(c).toEqual(["/a.blf", "/b.blf"]);
    // Cap at LIMIT — fill past it, oldest drop off.
    let list: string[] = [];
    for (let i = 0; i < RECENT_BLFS_LIMIT + 4; i++) {
      list = recordRecentBlf(list, `/p${i}.blf`);
    }
    expect(list.length).toBe(RECENT_BLFS_LIMIT);
    expect(list[0]).toBe(`/p${RECENT_BLFS_LIMIT + 3}.blf`);
  });

  it("recordRecentBlf ignores empty paths", () => {
    expect(recordRecentBlf(["/a.blf"], "")).toEqual(["/a.blf"]);
  });

  it("forgetRecentBlf removes a path", () => {
    expect(forgetRecentBlf(["/a.blf", "/b.blf"], "/a.blf")).toEqual(["/b.blf"]);
    // Missing path is a no-op (returns identity).
    expect(forgetRecentBlf(["/a.blf"], "/missing")).toEqual(["/a.blf"]);
  });
});
