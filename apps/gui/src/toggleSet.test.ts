import { describe, expect, it } from "vitest";

import { toggleInSet } from "./toggleSet";

describe("toggleInSet", () => {
  it("adds a key that isn't present", () => {
    const result = toggleInSet(new Set(["a"]), "b");
    expect([...result]).toEqual(["a", "b"]);
  });

  it("removes a key that is present", () => {
    const result = toggleInSet(new Set(["a", "b"]), "a");
    expect([...result]).toEqual(["b"]);
  });

  it("does not mutate the input set", () => {
    const input = new Set(["a"]);
    toggleInSet(input, "b");
    expect([...input]).toEqual(["a"]);
  });

  it("toggling twice is a no-op", () => {
    const input = new Set(["a"]);
    const result = toggleInSet(toggleInSet(input, "b"), "b");
    expect([...result]).toEqual(["a"]);
  });
});
