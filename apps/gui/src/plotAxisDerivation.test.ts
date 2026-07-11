import { describe, expect, it } from "vitest";
import { deriveAxesForArea } from "./plotAxisDerivation";
import type { SignalRef } from "./PlotPanel";
import { isEnumValueTable } from "./types";

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

  it("per-unit mode: a single-member value table is not an enum — the signal stays on its numeric unit axis", () => {
    // A one-row VAL_ table (an SNA sentinel) must not make a signal an
    // enum: `isEnumValueTable` requires >= 2 members, so the signal
    // lands on the ordinary per-unit axis with its unit kept.
    const tables = new Map<string, { raw: number; label: string }[]>([
      ["b1|s:100:Counter", [{ raw: 65535, label: "SNA" }]],
      ["b1|s:100:Mode", [{ raw: 0, label: "Off" }, { raw: 1, label: "On" }]],
    ]);
    const isEnum = (key: string): boolean => isEnumValueTable(tables.get(key));
    const sigs = [s("C1", "count"), s("Counter", "count"), s("Mode", "")];
    const out = deriveAxesForArea("a", sigs, "per-unit", isEnum);
    expect(out).toHaveLength(2);
    // Counter shares the numeric [count] axis — unit kept, no enum axis.
    expect(out.find((x) => x.subtitle === "[count]")?.signals.map((y) => y.signalName)).toEqual([
      "C1",
      "Counter",
    ]);
    // The two-member table still breaks out onto its own enum axis.
    expect(out.find((x) => x.subtitle === "Mode (enum)")?.signals).toHaveLength(1);
  });

  it("isEnumValueTable requires at least two members", () => {
    expect(isEnumValueTable(undefined)).toBe(false);
    expect(isEnumValueTable(null)).toBe(false);
    expect(isEnumValueTable([])).toBe(false);
    expect(isEnumValueTable([{ raw: 65535, label: "SNA" }])).toBe(false);
    expect(isEnumValueTable([{ raw: 0, label: "Off" }, { raw: 1, label: "On" }])).toBe(true);
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
