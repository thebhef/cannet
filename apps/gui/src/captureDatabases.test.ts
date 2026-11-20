import { describe, expect, it } from "vitest";

import { captureDatabaseName, captureOf, projectDbcRefs } from "./captureDatabases";

describe("captureDatabaseName", () => {
  it("is the attachment's own name, after the capture it came from", () => {
    expect(captureDatabaseName("C:\\captures\\run.mf4#powertrain.dbc")).toBe("powertrain.dbc");
  });

  it("splits at the last separator, since a capture's path may hold one", () => {
    expect(captureDatabaseName("/logs/run #3.mf4#body.dbc")).toBe("body.dbc");
  });
});

describe("captureOf", () => {
  it("is the capture's path, before the attachment's name", () => {
    expect(captureOf("C:\\captures\\run.mf4#powertrain.dbc")).toBe("C:\\captures\\run.mf4");
    expect(captureOf("/logs/run #3.mf4#body.dbc")).toBe("/logs/run #3.mf4");
  });
});

describe("projectDbcRefs", () => {
  it("writes the project's own databases with their buses, in order", () => {
    expect(
      projectDbcRefs(["a.dbc", "b.dbc"], { "a.dbc": ["p"] }, new Set()),
    ).toEqual([
      { path: "a.dbc", buses: ["p"] },
      { path: "b.dbc", buses: [] },
    ]);
  });

  it("leaves a capture's databases out — they are no part of a saved project", () => {
    const capture = "C:\\captures\\run.mf4#body.dbc";
    expect(
      projectDbcRefs(["a.dbc", capture], { "a.dbc": ["p"], [capture]: ["c"] }, new Set([capture])),
    ).toEqual([{ path: "a.dbc", buses: ["p"] }]);
  });
});
