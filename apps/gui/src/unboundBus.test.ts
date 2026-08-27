// Connect must refuse a project with no buses, or with any bus that
// carries no interface binding, and name what's actually missing — a
// bus, not a binding, since an empty project has no binding to point
// at either way.

import { describe, expect, it } from "vitest";

import { unboundBusError } from "./connectionStates";
import type { Bus, InterfaceBinding } from "./types";

const CHASSIS: Bus = { id: "b1", name: "Chassis" };
const BODY: Bus = { id: "b2", name: "Body" };

function binding(busId: string): InterfaceBinding {
  return { server: "127.0.0.1:9", interface: "can0", bus_id: busId };
}

describe("unboundBusError", () => {
  it("names the missing bus, not a binding, when the project has none", () => {
    const message = unboundBusError([], []);
    expect(message).not.toBeNull();
    expect(message).toMatch(/bus/i);
    expect(message).not.toMatch(/binding/i);
  });

  it("passes when every bus carries a binding", () => {
    expect(unboundBusError([CHASSIS, BODY], [binding("b1"), binding("b2")])).toBeNull();
  });

  it("names the one unbound bus among several, leaving the bound one out of it", () => {
    const message = unboundBusError([CHASSIS, BODY], [binding("b1")]);
    expect(message).toContain("Body");
    expect(message).not.toContain("Chassis");
  });

  it("names every unbound bus when none are bound", () => {
    const message = unboundBusError([CHASSIS, BODY], []);
    expect(message).toContain("Chassis");
    expect(message).toContain("Body");
  });
});
