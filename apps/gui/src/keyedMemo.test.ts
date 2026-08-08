import { describe, expect, it } from "vitest";

import { createKeyedMemo } from "./keyedMemo";

describe("createKeyedMemo", () => {
  it("recomputes only the keys whose dependencies moved", () => {
    const memo = createKeyedMemo<string, string[]>();
    const made: string[] = [];
    const a1 = { id: "a" };
    const b1 = { id: "b" };
    const pass = (a: object, b: object) => {
      const out = [
        memo.get("a", [a], () => {
          made.push("a");
          return ["a"];
        }),
        memo.get("b", [b], () => {
          made.push("b");
          return ["b"];
        }),
      ];
      memo.commit();
      return out;
    };

    const first = pass(a1, b1);
    expect(made).toEqual(["a", "b"]);
    // Only `b`'s input moved: `a` keeps the very object it had.
    const second = pass(a1, { id: "b" });
    expect(made).toEqual(["a", "b", "b"]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
  });

  it("compares every dependency, by identity", () => {
    const memo = createKeyedMemo<string, number>();
    let calls = 0;
    const get = (deps: readonly unknown[]) => {
      const v = memo.get("k", deps, () => ++calls);
      memo.commit();
      return v;
    };
    const shared = {};
    expect(get([shared, 1])).toBe(1);
    expect(get([shared, 1])).toBe(1);
    // A value-equal but distinct object is a change, as it is for React.
    expect(get([{}, 1])).toBe(2);
    expect(get([shared, 2])).toBe(3);
    // A shorter or longer list is a change too.
    expect(get([shared])).toBe(4);
  });

  it("retires keys a pass did not ask for", () => {
    const memo = createKeyedMemo<string, number>();
    let calls = 0;
    const make = () => ++calls;
    memo.get("a", [1], make);
    memo.get("b", [1], make);
    memo.commit();
    expect(calls).toBe(2);

    // A pass without `b` drops it, so its next appearance recomputes
    // rather than resurrecting a value derived from a stale input.
    memo.get("a", [1], make);
    memo.commit();
    expect(calls).toBe(2);
    memo.get("a", [1], make);
    memo.get("b", [1], make);
    memo.commit();
    expect(calls).toBe(3);
  });

  it("survives a repeated pass, as StrictMode's double invocation makes", () => {
    const memo = createKeyedMemo<string, number>();
    let calls = 0;
    const twice = () => {
      const a = memo.get("a", [1], () => ++calls);
      memo.commit();
      const b = memo.get("a", [1], () => ++calls);
      memo.commit();
      return [a, b];
    };
    expect(twice()).toEqual([1, 1]);
    expect(calls).toBe(1);
  });
});
