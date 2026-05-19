import { describe, expect, it } from "vitest";

import { variantOf } from "./FilterPredicateEditor";
import type { FilterPredicate } from "./types";

describe("variantOf", () => {
  it("reports 'none' for null/undefined (pass-through filter)", () => {
    expect(variantOf(null)).toBe("none");
    expect(variantOf(undefined)).toBe("none");
  });

  it("identifies each leaf variant by its discriminator key", () => {
    expect(variantOf({ bus: "p" })).toBe("bus");
    expect(variantOf({ id_range: [0, 0xff] })).toBe("id_range");
    expect(variantOf({ id_list: [0x10, 0x20] })).toBe("id_list");
    expect(variantOf({ name_regex: "Engine.*" })).toBe("name_regex");
    expect(
      variantOf({ signal_equals: { name: "RPM", value: 0 } }),
    ).toBe("signal_equals");
  });

  it("reports 'none' for composition shapes (no inline editor for nesting)", () => {
    // `all` / `any` exist in the predicate schema but the inline
    // editor renders them as the pass-through state — users edit
    // composed predicates via the project JSON for now.
    const nested: FilterPredicate = { all: [{ bus: "p" }, { id_range: [0, 1] }] };
    expect(variantOf(nested)).toBe("none");
  });
});
