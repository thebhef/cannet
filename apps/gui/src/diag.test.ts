import { describe, expect, it } from "vitest";

import { diagTime } from "./diag";

describe("diagTime", () => {
  it("passes the resolved value straight through", async () => {
    const value = await diagTime("test.ok", Promise.resolve(42));
    expect(value).toBe(42);
  });

  it("propagates rejection rather than swallowing it", async () => {
    await expect(
      diagTime("test.err", Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
  });
});
