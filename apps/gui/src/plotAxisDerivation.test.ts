import { describe, expect, it } from "vitest";
import { deriveAxesForArea } from "./plotAxisDerivation";
import type { SignalRef } from "./PlotPanel";

function s(name: string, unit: string, color = "#fff"): SignalRef {
  return {
    busId: "b1",
    messageId: 100,
    extended: false,
    signalName: name,
    messageName: "Msg",
    unit,
    color,
  };
}

describe("deriveAxesForArea", () => {
  it("empty area: one axis with no signals", () => {
    const out = deriveAxesForArea("a", [], "per-unit");
    expect(out).toHaveLength(1);
    expect(out[0].signals).toHaveLength(0);
    expect(out[0].subtitle).toBeNull();
  });

  it("unified mode: one axis containing all signals", () => {
    const sigs = [s("A", "V"), s("B", "A"), s("C", "")];
    const out = deriveAxesForArea("a", sigs, "unified");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("a");
    expect(out[0].signals).toEqual(sigs);
    expect(out[0].subtitle).toBeNull();
  });

  it("individual mode: one axis per signal, subtitled with the signal name", () => {
    const sigs = [s("EngineSpeed", "rpm"), s("EngineTemp", "degC")];
    const out = deriveAxesForArea("a", sigs, "individual");
    expect(out).toHaveLength(2);
    expect(out[0].subtitle).toBe("EngineSpeed");
    expect(out[1].subtitle).toBe("EngineTemp");
    expect(out[0].signals).toEqual([sigs[0]]);
    expect(out[1].signals).toEqual([sigs[1]]);
    expect(out[0].id).not.toBe(out[1].id);
  });

  it("per-unit mode: groups signals sharing a unit onto one axis", () => {
    const sigs = [s("V1", "V"), s("V2", "V"), s("I1", "A"), s("V3", "V")];
    const out = deriveAxesForArea("a", sigs, "per-unit");
    expect(out).toHaveLength(2);
    expect(out[0].subtitle).toBe("[V]");
    expect(out[0].signals.map((x) => x.signalName)).toEqual(["V1", "V2", "V3"]);
    expect(out[1].subtitle).toBe("[A]");
    expect(out[1].signals.map((x) => x.signalName)).toEqual(["I1"]);
  });

  it("per-unit mode: unitless signals share a (unitless) axis", () => {
    const sigs = [s("X", ""), s("Y", "")];
    const out = deriveAxesForArea("a", sigs, "per-unit");
    expect(out).toHaveLength(1);
    expect(out[0].subtitle).toBe("(unitless)");
    expect(out[0].signals).toHaveLength(2);
  });

  it("per-unit mode: each enum signal gets its own axis", () => {
    const sigs = [s("V1", "V"), s("State", ""), s("Mode", "")];
    const isEnum = (key: string): boolean => key.includes("State") || key.includes("Mode");
    const out = deriveAxesForArea("a", sigs, "per-unit", isEnum);
    // V1 → unit V axis; State + Mode each get their own enum axis.
    expect(out).toHaveLength(3);
    expect(out.find((x) => x.subtitle === "[V]")?.signals.map((y) => y.signalName)).toEqual(["V1"]);
    expect(out.find((x) => x.subtitle === "State (enum)")?.signals).toHaveLength(1);
    expect(out.find((x) => x.subtitle === "Mode (enum)")?.signals).toHaveLength(1);
  });

  it("a standard and an extended signal with the same id and name get distinct axes", () => {
    // The axis-id key must include the extended flag (the canonical
    // signalKey's `x:`/`s:` discriminator) — otherwise the two would
    // collide into one axis id.
    const std = s("Status", "");
    const ext: SignalRef = { ...s("Status", ""), extended: true };
    const out = deriveAxesForArea("a", [std, ext], "individual");
    expect(out).toHaveLength(2);
    expect(out[0].id).not.toBe(out[1].id);
  });

  it("axis ids are stable and unique", () => {
    const sigs = [s("V1", "V"), s("V2", "V")];
    const out = deriveAxesForArea("area-7", sigs, "per-unit");
    expect(out[0].id).toContain("area-7");
    // Re-running gives the same ids.
    const again = deriveAxesForArea("area-7", sigs, "per-unit");
    expect(again[0].id).toBe(out[0].id);
  });
});
