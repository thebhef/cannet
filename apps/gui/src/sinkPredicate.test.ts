import { describe, expect, it } from "vitest";

import { buildSinkPredicate, withoutErrorFrames } from "./sinkPredicate";
import type { ProjectElement } from "./types";

function lookup(elements: ProjectElement[]) {
  const by = new Map(elements.map((e) => [e.id, e]));
  return (id: string) => by.get(id);
}

describe("buildSinkPredicate", () => {
  it("returns null when sources=['*'] and no filter sources", () => {
    const sink: ProjectElement = { kind: "trace", id: "t", sources: ["*"] };
    expect(buildSinkPredicate(sink, lookup([sink]))).toBeNull();
  });

  it("returns Any[] when sources=[] (matches nothing)", () => {
    const sink: ProjectElement = { kind: "trace", id: "t", sources: [] };
    expect(buildSinkPredicate(sink, lookup([sink]))).toEqual({ any: [] });
  });

  it("returns a single {bus} predicate for one explicit bus source", () => {
    const sink: ProjectElement = { kind: "trace", id: "t", sources: ["b1"] };
    expect(buildSinkPredicate(sink, lookup([sink]))).toEqual({ bus: "b1" });
  });

  it("returns Any[Bus(b1), Bus(b2)] for two explicit bus sources", () => {
    const sink: ProjectElement = {
      kind: "trace",
      id: "t",
      sources: ["b1", "b2"],
    };
    expect(buildSinkPredicate(sink, lookup([sink]))).toEqual({
      any: [{ bus: "b1" }, { bus: "b2" }],
    });
  });

  it("AND-composes an upstream filter's predicate with explicit bus sources", () => {
    const f: ProjectElement = {
      kind: "filter",
      id: "f1",
      sources: ["*"],
      predicate: { id_range: [0x100, 0x1ff] },
    };
    const sink: ProjectElement = {
      kind: "trace",
      id: "t",
      sources: ["b1", "f1"],
    };
    expect(buildSinkPredicate(sink, lookup([sink, f]))).toEqual({
      all: [{ bus: "b1" }, { id_range: [0x100, 0x1ff] }],
    });
  });

  it("with sources=['*', filter] returns just the filter's predicate (wildcard adds nothing)", () => {
    const f: ProjectElement = {
      kind: "filter",
      id: "f1",
      sources: ["*"],
      predicate: { id_list: [0x10, 0x20] },
    };
    const sink: ProjectElement = {
      kind: "trace",
      id: "t",
      sources: ["*", "f1"],
    };
    expect(buildSinkPredicate(sink, lookup([sink, f]))).toEqual({
      id_list: [0x10, 0x20],
    });
  });

  it("with sources=['*'] and a filter source returns null when the filter has no predicate", () => {
    const f: ProjectElement = { kind: "filter", id: "f1", sources: ["*"] };
    const sink: ProjectElement = {
      kind: "trace",
      id: "t",
      sources: ["*", "f1"],
    };
    expect(buildSinkPredicate(sink, lookup([sink, f]))).toBeNull();
  });

  it("recursively folds a filter chain's predicates", () => {
    // f2 reads from f1; sink reads from f2.
    const f1: ProjectElement = {
      kind: "filter",
      id: "f1",
      sources: ["*"],
      predicate: { id_range: [0x100, 0x1ff] },
    };
    const f2: ProjectElement = {
      kind: "filter",
      id: "f2",
      sources: ["f1"],
      predicate: { name_regex: "Engine.*" },
    };
    const sink: ProjectElement = { kind: "trace", id: "t", sources: ["f2"] };
    expect(buildSinkPredicate(sink, lookup([sink, f1, f2]))).toEqual({
      all: [
        { name_regex: "Engine.*" },
        { id_range: [0x100, 0x1ff] },
      ],
    });
  });

  it("returns null for a transmit element (it isn't a consumer of frames)", () => {
    const tx: ProjectElement = { kind: "transmit", id: "tx", sinks: ["b1"], frameIds: [] };
    expect(buildSinkPredicate(tx, lookup([tx]))).toBeNull();
  });

  it("treats an unknown source id as a bus (it will simply match no frames downstream)", () => {
    const sink: ProjectElement = {
      kind: "trace",
      id: "t",
      sources: ["deleted-bus"],
    };
    expect(buildSinkPredicate(sink, lookup([sink]))).toEqual({
      bus: "deleted-bus",
    });
  });
});

describe("withoutErrorFrames", () => {
  it("is the whole predicate when the panel had none", () => {
    // The `sources=["*"]` common case: no constraint, so excluding the
    // error frames is the only thing the host is asked to do.
    expect(withoutErrorFrames(null)).toEqual({ error_frame: false });
  });

  it("ANDs onto a panel predicate without nesting it", () => {
    // The host resolves its by-id candidate set over the tree it is
    // handed, so the narrowable leaves stay at the top level.
    expect(withoutErrorFrames({ bus: "b1" })).toEqual({
      all: [{ bus: "b1" }, { error_frame: false }],
    });
    expect(withoutErrorFrames({ all: [{ bus: "b1" }, { id_list: [1] }] })).toEqual({
      all: [{ bus: "b1" }, { id_list: [1] }, { error_frame: false }],
    });
  });

  it("does not disturb an any-predicate's meaning", () => {
    // An `any` is one leaf as far as the AND is concerned; flattening
    // it would turn "b1 or b2" into "b1 and b2".
    expect(withoutErrorFrames({ any: [{ bus: "b1" }, { bus: "b2" }] })).toEqual({
      all: [{ any: [{ bus: "b1" }, { bus: "b2" }] }, { error_frame: false }],
    });
  });
});
