import { describe, expect, it } from "vitest";
import {
  axisGutterWidth,
  createGutterCoordinator,
  deriveAxesForArea,
  retainedAxisIds,
} from "./plotAxisDerivation";

describe("axisGutterWidth", () => {
  const H = 12;

  it("takes the measured width on the first pass", () => {
    expect(axisGutterWidth(70, null, H)).toBe(70);
  });

  it("grows immediately so labels always fit", () => {
    expect(axisGutterWidth(90, 70, H)).toBe(90);
    expect(axisGutterWidth(71, 70, H)).toBe(71);
  });

  it("holds through ordinary label-width wobble", () => {
    // The defect: under follow-live the auto-fitted y scale re-formats
    // its ticks every frame, so the measured width jitters by a few px.
    // The gutter must not chase it — the whole plot box moves if it
    // does, shifting gridlines and enum tiles left and right.
    let w = axisGutterWidth(80, null, H);
    const widths = new Set<number>();
    for (const measured of [78, 74, 80, 71, 76, 79, 72, 77, 80, 73]) {
      w = axisGutterWidth(measured, w, H);
      widths.add(w);
    }
    expect(widths).toEqual(new Set([80]));
  });

  it("shrinks once the requirement drops clear of the band", () => {
    expect(axisGutterWidth(52, 80, H)).toBe(52);
    // Exactly at the band edge still holds — only a clear drop moves it.
    expect(axisGutterWidth(68, 80, H)).toBe(80);
    expect(axisGutterWidth(67, 80, H)).toBe(67);
  });
});
import type { SignalRef } from "./plotPanelConfig";
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

  it("per-unit mode: all enums collect onto one shared enum-lanes axis", () => {
    const sigs = [s("V1", "V"), s("State", ""), s("Mode", "")];
    const isEnum = (key: string): boolean => key.includes("State") || key.includes("Mode");
    const out = deriveAxesForArea("a", sigs, "per-unit", isEnum);
    // V1 → unit V axis; State + Mode share one enum-lanes axis.
    expect(out).toHaveLength(2);
    expect(out.find((x) => x.subtitle === "[V]")?.signals.map((y) => y.signalName)).toEqual(["V1"]);
    const enumAxis = out.find((x) => x.kind === "enum-lanes");
    expect(enumAxis?.id).toBe("a/u:enum");
    expect(enumAxis?.subtitle).toBe("(enums)");
    expect(enumAxis?.signals.map((y) => y.signalName)).toEqual(["State", "Mode"]);
  });

  it("per-unit mode: the enum-lanes axis sits at the first enum's position", () => {
    // State appears before I1, so the shared enum axis comes before the
    // [A] axis in area order (lane order = config order, top first).
    const sigs = [s("V1", "V"), s("State", ""), s("I1", "A")];
    const isEnum = (key: string): boolean => key.includes("State");
    const out = deriveAxesForArea("a", sigs, "per-unit", isEnum);
    expect(out.map((x) => x.kind)).toEqual(["numeric", "enum-lanes", "numeric"]);
    expect(out.map((x) => x.subtitle)).toEqual(["[V]", "State (enum)", "[A]"]);
  });

  it("per-unit mode: a lone enum axis is subtitled with its signal name", () => {
    const sigs = [s("V1", "V"), s("Mode", "")];
    const isEnum = (key: string): boolean => key.includes("Mode");
    const out = deriveAxesForArea("a", sigs, "per-unit", isEnum);
    expect(out.find((x) => x.kind === "enum-lanes")?.subtitle).toBe("Mode (enum)");
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
    // The two-member table breaks out onto the shared enum-lanes axis.
    expect(out.find((x) => x.kind === "enum-lanes")?.signals.map((y) => y.signalName)).toEqual(["Mode"]);
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

describe("retainedAxisIds", () => {
  it("covers every id the area's signals could mint, in any mode", () => {
    const ids = new Set(retainedAxisIds("a", [s("A", "V"), s("B", "V"), s("C", "")]));
    expect(ids).toEqual(
      new Set([
        "a",
        "a/u:enum",
        "a/u:unit:V",
        "a/u:unit:",
        "a/i:b1|s:100:A",
        "a/i:b1|s:100:B",
        "a/i:b1|s:100:C",
      ]),
    );
  });

  it("matches what every mode actually derives, so no live axis is ever pruned", () => {
    const sigs = [s("A", "V"), s("B", "A"), s("C", "V")];
    const isEnum = (k: string) => k === "b1|s:100:C";
    const retained = new Set(retainedAxisIds("a", sigs));
    for (const mode of ["unified", "per-unit", "individual"] as const) {
      for (const ax of deriveAxesForArea("a", sigs, mode, isEnum)) {
        expect(retained.has(ax.id)).toBe(true);
      }
    }
  });

  it("keeps a per-unit axis while any signal of that unit remains", () => {
    const both = [s("A", "V"), s("B", "V")];
    expect(retainedAxisIds("a", both)).toContain("a/u:unit:V");
    // One of the pair removed: the unit axis is still there.
    expect(retainedAxisIds("a", [both[1]])).toContain("a/u:unit:V");
    // The last one removed: it retires.
    expect(retainedAxisIds("a", [])).not.toContain("a/u:unit:V");
  });

  it("retires an individual axis with its own signal, and only that one", () => {
    const sigs = [s("A", "V"), s("B", "A")];
    const after = retainedAxisIds("a", [sigs[0]]);
    expect(after).toContain("a/i:b1|s:100:A");
    expect(after).not.toContain("a/i:b1|s:100:B");
  });

  it("keeps the empty area's own axis", () => {
    expect(retainedAxisIds("a", [])).toEqual(["a"]);
  });
});

describe("createGutterCoordinator", () => {
  const H = 12;

  it("widens every axis to the widest one's need", () => {
    // The whole point: the stack draws one x window, so the plot boxes
    // have to start at the same x or the shared cursor isn't collinear.
    const c = createGutterCoordinator(H);
    expect(c.report("numeric", 88)).toBe(88);
    // The enum-lanes axis wants a bare gutter; it gets the panel's.
    expect(c.report("lanes", 14)).toBe(88);
    // ...and the wide one is unaffected by the narrow one.
    expect(c.report("numeric", 88)).toBe(88);
  });

  it("takes the widest whichever order the axes report in", () => {
    const c = createGutterCoordinator(H);
    expect(c.report("lanes", 14)).toBe(14);
    expect(c.report("numeric", 88)).toBe(88);
    // The narrow axis picks the new width up on its next layout pass.
    expect(c.report("lanes", 14)).toBe(88);
  });

  it("keeps the anti-twitch hysteresis, applied panel-wide", () => {
    // Same reason as `axisGutterWidth`: an auto-fitted scale's tick
    // strings change width constantly, and the left edge must not
    // follow every wobble. Applied to the max, so all axes latch alike.
    const c = createGutterCoordinator(H);
    c.report("numeric", 88);
    expect(c.report("numeric", 80)).toBe(88); // inside the band
    expect(c.report("numeric", 70)).toBe(70); // past it
    expect(c.report("numeric", 95)).toBe(95); // growth is immediate
  });

  it("gives back the width when the widest axis goes away", () => {
    // Otherwise removing the only wide axis would strand every
    // remaining one behind a gutter nothing needs.
    const c = createGutterCoordinator(H);
    c.report("numeric", 88);
    c.report("lanes", 14);
    c.forget("numeric");
    expect(c.report("lanes", 14)).toBe(14);
  });

  it("holds its width when the last axis goes away", () => {
    // Nothing left to size from — hold, rather than resetting and
    // announcing a change nobody can act on (an empty stack has no axis
    // to re-lay-out, and the next one to mount would flash a
    // wrong-width gutter converging from scratch).
    const seen: number[] = [];
    const c = createGutterCoordinator(H, (w) => seen.push(w));
    c.report("numeric", 88);
    c.forget("numeric");
    expect(seen).toEqual([88]);
  });

  it("announces a change once, to whoever has to re-lay-out", () => {
    // A report arrives from inside one axis's layout pass; the others
    // only see the new width on their next one, so the panel needs to
    // know when to nudge them — and must not be nudged on every report.
    const seen: number[] = [];
    const c = createGutterCoordinator(H, (w) => seen.push(w));
    c.report("numeric", 88);
    c.report("lanes", 14);
    c.report("numeric", 88);
    c.report("lanes", 14);
    expect(seen).toEqual([88]);
    c.report("numeric", 40);
    expect(seen).toEqual([88, 40]);
  });
});
