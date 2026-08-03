import { beforeEach, describe, expect, it, vi } from "vitest";

// The cap is the `recent_blfs_limit` setting, so these tests need a
// host to hydrate it from.
let stored: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...stored } : null)),
}));

const { forgetRecentBlf, recordRecentBlf } = await import("./recentBlfs");
const { defaultSettings, hydrateSettings } = await import("./hostSettings");

const RECENT_BLFS_LIMIT = defaultSettings().recent_blfs_limit;

beforeEach(async () => {
  stored = {};
  await hydrateSettings();
});

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

  it("caps at the configured depth, not a hard-coded one", async () => {
    // The promotion's whole point: the number comes from
    // `settings.json`. Two is not the default, so a cap that ignored
    // the setting would keep eight here.
    stored = { recent_blfs_limit: 2 };
    await hydrateSettings();
    let list: string[] = [];
    for (let i = 0; i < 5; i++) list = recordRecentBlf(list, `/p${i}.blf`);
    expect(list).toEqual(["/p4.blf", "/p3.blf"]);
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
