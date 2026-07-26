import { describe, expect, it } from "vitest";

import { pushRecent } from "./recentMru";

describe("pushRecent", () => {
  it("prepends a new value", () => {
    expect(pushRecent(["b", "c"], "a", 8)).toEqual(["a", "b", "c"]);
  });

  it("moves an existing value to the front (dedupe)", () => {
    expect(pushRecent(["a", "b", "c"], "c", 8)).toEqual(["c", "a", "b"]);
  });

  it("caps the list at the limit, dropping the oldest", () => {
    expect(pushRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });

  it("drops an empty value, returning a copy", () => {
    const current = ["a", "b"];
    const out = pushRecent(current, "", 8);
    expect(out).toEqual(["a", "b"]);
    expect(out).not.toBe(current);
  });
});
