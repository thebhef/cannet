import { describe, expect, it } from "vitest";

import {
  RECENT_COMMANDS_LIMIT,
  recordRecentCommand,
  sortRecentFirst,
} from "./recentCommands";

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
