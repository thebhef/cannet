import { beforeEach, describe, expect, it, vi } from "vitest";

// The cap is the `recent_projects_limit` setting, so these tests need a
// host to hydrate it from.
let stored: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...stored } : null)),
}));

const { forgetRecentProject, recordRecentProject } = await import("./recentProjects");
const { defaultSettings, hydrateSettings } = await import("./hostSettings");

const LIMIT = defaultSettings().recent_projects_limit;

beforeEach(async () => {
  stored = {};
  await hydrateSettings();
});

describe("recentProjects", () => {
  it("recordRecentProject prepends, dedupes, and caps", () => {
    const a = recordRecentProject([], "/jobs/a.cannet_prj");
    expect(a).toEqual(["/jobs/a.cannet_prj"]);
    const b = recordRecentProject(a, "/jobs/b.cannet_prj");
    expect(b).toEqual(["/jobs/b.cannet_prj", "/jobs/a.cannet_prj"]);
    // Re-opening a project lifts it back to the front rather than
    // leaving it where it sat: the list is ordered by when you last
    // worked in one.
    expect(recordRecentProject(b, "/jobs/a.cannet_prj")).toEqual([
      "/jobs/a.cannet_prj",
      "/jobs/b.cannet_prj",
    ]);

    let list: string[] = [];
    for (let i = 0; i < LIMIT + 4; i++) list = recordRecentProject(list, `/jobs/p${i}.cannet_prj`);
    expect(list.length).toBe(LIMIT);
    expect(list[0]).toBe(`/jobs/p${LIMIT + 3}.cannet_prj`);
  });

  it("caps at the configured depth, not a hard-coded one", async () => {
    stored = { recent_projects_limit: 2 };
    await hydrateSettings();
    let list: string[] = [];
    for (let i = 0; i < 5; i++) list = recordRecentProject(list, `/jobs/p${i}.cannet_prj`);
    expect(list).toEqual(["/jobs/p4.cannet_prj", "/jobs/p3.cannet_prj"]);
  });

  it("remembers none at all when the bound is zero", async () => {
    stored = { recent_projects_limit: 0 };
    await hydrateSettings();
    expect(recordRecentProject([], "/jobs/a.cannet_prj")).toEqual([]);
  });

  it("recordRecentProject ignores empty paths", () => {
    expect(recordRecentProject(["/jobs/a.cannet_prj"], "")).toEqual(["/jobs/a.cannet_prj"]);
  });

  it("forgetRecentProject removes a path, and is a no-op for one it doesn't hold", () => {
    expect(forgetRecentProject(["/a.cannet_prj", "/b.cannet_prj"], "/a.cannet_prj")).toEqual([
      "/b.cannet_prj",
    ]);
    expect(forgetRecentProject(["/a.cannet_prj"], "/missing.cannet_prj")).toEqual([
      "/a.cannet_prj",
    ]);
  });
});
