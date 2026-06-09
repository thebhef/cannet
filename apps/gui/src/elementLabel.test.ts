import { describe, expect, it } from "vitest";

import {
  assignDefaultNames,
  defaultElementName,
  elementKindLabel,
  elementLabel,
} from "./elementLabel";
import type { ProjectElement } from "./types";

function trace(id: string, name: string): ProjectElement {
  return { kind: "trace", id, name, sources: ["*"] };
}

function plot(id: string, name: string): ProjectElement {
  return { kind: "plot", id, name, sources: ["*"] };
}

describe("elementKindLabel", () => {
  it("capitalises each kind", () => {
    expect(elementKindLabel("trace")).toBe("Trace");
    expect(elementKindLabel("plot")).toBe("Plot");
    expect(elementKindLabel("transmit")).toBe("Transmit");
    expect(elementKindLabel("filter")).toBe("Filter");
  });
});

describe("elementLabel", () => {
  it("returns the model-owned name when set", () => {
    expect(elementLabel(trace("abc123", "Powertrain log"))).toBe("Powertrain log");
  });

  it("falls back to kind + short id for an empty name", () => {
    // Safety net for an element that slipped past normalisation —
    // never the steady state, but the resolver must not return "".
    expect(elementLabel(trace("abcdef1234", ""))).toBe("Trace abcdef");
    expect(elementLabel(trace("ab", "   "))).toBe("Trace ab");
  });
});

describe("defaultElementName", () => {
  it("numbers from 1 when no same-kind element exists", () => {
    expect(defaultElementName("trace", [])).toBe("Trace 1");
    expect(defaultElementName("plot", [trace("a", "Trace 1")])).toBe("Plot 1");
  });

  it("continues past the highest default-style index of its kind", () => {
    const existing = [trace("a", "Trace 1"), trace("b", "Trace 3"), plot("c", "Plot 2")];
    expect(defaultElementName("trace", existing)).toBe("Trace 4");
    expect(defaultElementName("plot", existing)).toBe("Plot 3");
  });

  it("ignores renamed elements when picking the next index", () => {
    const existing = [trace("a", "My capture"), trace("b", "Trace 2")];
    expect(defaultElementName("trace", existing)).toBe("Trace 3");
  });
});

describe("assignDefaultNames", () => {
  it("fills empty names in order, per kind", () => {
    const named = assignDefaultNames([
      trace("a", ""),
      plot("b", ""),
      trace("c", ""),
    ]);
    expect(named.map((e) => e.name)).toEqual(["Trace 1", "Plot 1", "Trace 2"]);
  });

  it("leaves existing names alone and numbers around them", () => {
    const named = assignDefaultNames([
      trace("a", "Trace 2"),
      trace("b", ""),
      trace("c", "Custom"),
    ]);
    expect(named.map((e) => e.name)).toEqual(["Trace 2", "Trace 3", "Custom"]);
  });

  it("returns the same array when nothing needs a name", () => {
    const elements = [trace("a", "Trace 1")];
    expect(assignDefaultNames(elements)).toBe(elements);
  });
});
