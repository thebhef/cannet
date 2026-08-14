import { beforeEach, describe, expect, it, vi } from "vitest";

// The cap is the `recent_blfs_limit` setting (kept as-is post-rename —
// see `recentCaptures.ts`), so these tests need a host to hydrate it from.
let stored: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...stored } : null)),
}));

const { forgetRecentCapture, recordRecentCapture } = await import("./recentCaptures");
const { defaultSettings, hydrateSettings } = await import("./hostSettings");

const RECENT_CAPTURES_LIMIT = defaultSettings().recent_blfs_limit;

beforeEach(async () => {
  stored = {};
  await hydrateSettings();
});

describe("recentCaptures", () => {
  it("recordRecentCapture prepends, dedupes, and caps", () => {
    const a = recordRecentCapture([], "/a.blf");
    expect(a).toEqual(["/a.blf"]);
    const b = recordRecentCapture(a, "/b.blf");
    expect(b).toEqual(["/b.blf", "/a.blf"]);
    // Re-touching `/a.blf` lifts it back to the front.
    const c = recordRecentCapture(b, "/a.blf");
    expect(c).toEqual(["/a.blf", "/b.blf"]);
    // Cap at LIMIT — fill past it, oldest drop off.
    let list: string[] = [];
    for (let i = 0; i < RECENT_CAPTURES_LIMIT + 4; i++) {
      list = recordRecentCapture(list, `/p${i}.blf`);
    }
    expect(list.length).toBe(RECENT_CAPTURES_LIMIT);
    expect(list[0]).toBe(`/p${RECENT_CAPTURES_LIMIT + 3}.blf`);
  });

  it("caps at the configured depth, not a hard-coded one", async () => {
    // The promotion's whole point: the number comes from
    // `settings.json`. Two is not the default, so a cap that ignored
    // the setting would keep eight here.
    stored = { recent_blfs_limit: 2 };
    await hydrateSettings();
    let list: string[] = [];
    for (let i = 0; i < 5; i++) list = recordRecentCapture(list, `/p${i}.blf`);
    expect(list).toEqual(["/p4.blf", "/p3.blf"]);
  });

  it("recordRecentCapture ignores empty paths", () => {
    expect(recordRecentCapture(["/a.blf"], "")).toEqual(["/a.blf"]);
  });

  it("forgetRecentCapture removes a path", () => {
    expect(forgetRecentCapture(["/a.blf", "/b.blf"], "/a.blf")).toEqual(["/b.blf"]);
    // Missing path is a no-op (returns identity).
    expect(forgetRecentCapture(["/a.blf"], "/missing")).toEqual(["/a.blf"]);
  });

  it("mixes BLF and MDF paths in one list — the storage shape is format-agnostic", () => {
    let list: string[] = [];
    list = recordRecentCapture(list, "/a.blf");
    list = recordRecentCapture(list, "/b.mf4");
    expect(list).toEqual(["/b.mf4", "/a.blf"]);
  });
});
