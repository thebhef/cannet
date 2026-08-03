import { beforeEach, describe, expect, it, vi } from "vitest";

// The cap is the `recent_commands_limit` setting, so these tests need a
// host to hydrate it from.
let stored: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_settings" ? { ...stored } : null)),
}));

const { recordRecentCommand, sortRecentFirst } = await import("./recentCommands");
const { defaultSettings, hydrateSettings } = await import("./hostSettings");

const RECENT_COMMANDS_LIMIT = defaultSettings().recent_commands_limit;

beforeEach(async () => {
  stored = {};
  await hydrateSettings();
});

describe("recordRecentCommand", () => {
  it("prepends the newest command", () => {
    expect(recordRecentCommand([], "a")).toEqual(["a"]);
    expect(recordRecentCommand(["a"], "b")).toEqual(["b", "a"]);
  });

  it("re-running a command moves it to the front (no duplicates)", () => {
    expect(recordRecentCommand(["b", "a"], "a")).toEqual(["a", "b"]);
  });

  it("caps at the limit, dropping the oldest", () => {
    let list: string[] = [];
    for (let i = 0; i < RECENT_COMMANDS_LIMIT + 3; i++) {
      list = recordRecentCommand(list, `cmd-${i}`);
    }
    expect(list).toHaveLength(RECENT_COMMANDS_LIMIT);
    expect(list[0]).toBe(`cmd-${RECENT_COMMANDS_LIMIT + 2}`);
    expect(list).not.toContain("cmd-0");
  });

  it("caps at the configured depth, not a hard-coded one", async () => {
    stored = { recent_commands_limit: 3 };
    await hydrateSettings();
    let list: string[] = [];
    for (let i = 0; i < 6; i++) list = recordRecentCommand(list, `cmd-${i}`);
    expect(list).toEqual(["cmd-5", "cmd-4", "cmd-3"]);
  });

  it("ignores an empty id", () => {
    expect(recordRecentCommand(["a"], "")).toEqual(["a"]);
  });
});

describe("sortRecentFirst", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("floats recents to the top in recency order, rest in original order", () => {
    expect(sortRecentFirst(items, ["c", "a"]).map((i) => i.id)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("ignores recents that aren't in the item list", () => {
    expect(sortRecentFirst(items, ["zz", "b"]).map((i) => i.id)).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
  });

  it("no recents → original order", () => {
    expect(sortRecentFirst(items, []).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });
});
