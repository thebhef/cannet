import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";

import { assignLanePositions, reconcileGraphNodes } from "./graphNodeLayout";
import type { GraphNode } from "./projectGraph";

function busNode(id: string, name = id): GraphNode {
  return { id: `bus:${id}`, kind: "bus", label: name, bus: { id, name } };
}

function graphOf(n: Node): GraphNode {
  return (n.data as { graph: GraphNode }).graph;
}

describe("assignLanePositions", () => {
  it("stacks same-kind nodes one row apart", () => {
    const pos = assignLanePositions([
      { id: "bus:a", kind: "bus" },
      { id: "bus:b", kind: "bus" },
      { id: "bus:c", kind: "bus" },
    ]);
    expect(pos["bus:a"].x).toBe(pos["bus:b"].x);
    expect(pos["bus:b"].y - pos["bus:a"].y).toBe(110);
    expect(pos["bus:c"].y - pos["bus:b"].y).toBe(110);
  });

  it("shares one row counter between plot and trace so they never collide", () => {
    const pos = assignLanePositions([
      { id: "el:p", kind: "plot" },
      { id: "el:t", kind: "trace" },
    ]);
    expect(pos["el:p"].x).toBe(pos["el:t"].x); // same lane
    expect(pos["el:p"].y).not.toBe(pos["el:t"].y); // distinct rows
  });

  it("puts gateway, bus and filter lanes at increasing x", () => {
    const pos = assignLanePositions([
      { id: "g", kind: "gateway" },
      { id: "bus:a", kind: "bus" },
      { id: "el:f", kind: "filter" },
    ]);
    expect(pos["g"].x).toBeLessThan(pos["bus:a"].x);
    expect(pos["bus:a"].x).toBeLessThan(pos["el:f"].x);
  });
});

describe("reconcileGraphNodes", () => {
  it("seeds fresh nodes from the derivation, saved positions winning", () => {
    const a = busNode("a");
    const out = reconcileGraphNodes([a], [], { "bus:a": { x: 12, y: 34 } });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("bus:a");
    expect(out[0].position).toEqual({ x: 12, y: 34 });
    expect(graphOf(out[0])).toBe(a);
  });

  it("lane-places a fresh node that has no saved position", () => {
    const out = reconcileGraphNodes([busNode("a")], [], {});
    expect(Number.isFinite(out[0].position.x)).toBe(true);
    expect(Number.isFinite(out[0].position.y)).toBe(true);
  });

  it("preserves a node's live position and measured size across re-derivation", () => {
    // The regression guard: xyflow accumulates `measured` and the
    // dragged `position` on each node. A reconcile must carry them
    // forward, or xyflow re-measures every node every render and the
    // graph's drag / hit-testing breaks.
    const old = busNode("a", "Old name");
    const prev: Node[] = [
      {
        id: "bus:a",
        type: "bus",
        position: { x: 777, y: 555 },
        measured: { width: 320, height: 66 },
        data: { graph: old },
      },
    ];
    const fresh = busNode("a", "New name");
    const out = reconcileGraphNodes([fresh], prev, {});
    expect(out[0].position).toEqual({ x: 777, y: 555 });
    expect(out[0].measured).toEqual({ width: 320, height: 66 });
    expect(graphOf(out[0])).toBe(fresh); // data refreshed
  });

  it("adds new nodes and drops removed ones", () => {
    const prev = reconcileGraphNodes([busNode("a")], [], {});
    const out = reconcileGraphNodes([busNode("b")], prev, {});
    expect(out.map((n) => n.id)).toEqual(["bus:b"]);
  });
});
