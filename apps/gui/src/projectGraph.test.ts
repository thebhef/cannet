import { describe, expect, it } from "vitest";

import {
  busNodeId,
  deriveGraph,
  elementNodeId,
  gatewayNodeId,
} from "./projectGraph";
import type { Bus, InterfaceBinding, ProjectElement } from "./types";

const bus = (id: string, name = id): Bus => ({ id, name });
const binding = (
  server: string,
  iface: string,
  bus_id: string,
): InterfaceBinding => ({ server, interface: iface, bus_id });

describe("deriveGraph", () => {
  it("empty project produces no nodes or edges", () => {
    const g = deriveGraph([], [], []);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it("a bus alone is a node with no edges", () => {
    const g = deriveGraph([bus("p", "Powertrain")], [], []);
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]).toMatchObject({
      id: busNodeId("p"),
      kind: "bus",
      label: "Powertrain",
    });
    expect(g.edges).toEqual([]);
  });

  it("a gateway bound to a bus draws a gateway↔bus edge", () => {
    const b = binding("127.0.0.1:50051", "can0", "p");
    const g = deriveGraph([bus("p")], [b], []);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([
      {
        id: `e:gateway-bus:${gatewayNodeId(b)}->${busNodeId("p")}`,
        source: gatewayNodeId(b),
        target: busNodeId("p"),
        kind: "gateway-bus",
      },
    ]);
  });

  it("a gateway bound to a non-existent bus produces the node but no edge", () => {
    const b = binding("127.0.0.1:50051", "can0", "missing");
    const g = deriveGraph([bus("p")], [b], []);
    // Two nodes (bus + gateway), no edge — the gateway hangs free until
    // the bus exists.
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([]);
  });

  it("a trace whose source points at a bus draws bus→trace", () => {
    const trace: ProjectElement = { kind: "trace", id: "t1", source: "p" };
    const g = deriveGraph([bus("p")], [], [trace]);
    expect(g.edges).toEqual([
      {
        id: `e:bus->trace:${busNodeId("p")}->${elementNodeId("t1")}`,
        source: busNodeId("p"),
        target: elementNodeId("t1"),
        kind: "bus-sink",
      },
    ]);
  });

  it("a plot whose source points at a bus draws bus→plot", () => {
    const plot: ProjectElement = { kind: "plot", id: "pl1", source: "p" };
    const g = deriveGraph([bus("p")], [], [plot]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ kind: "bus-sink" });
  });

  it("a filter with a bus source draws bus→filter", () => {
    const filter: ProjectElement = { kind: "filter", id: "f1", source: "p" };
    const g = deriveGraph([bus("p")], [], [filter]);
    expect(g.edges).toEqual([
      {
        id: `e:bus->filter:${busNodeId("p")}->${elementNodeId("f1")}`,
        source: busNodeId("p"),
        target: elementNodeId("f1"),
        kind: "bus-filter",
      },
    ]);
  });

  it("a filter feeding two sinks renders 1-in / 2-out as the user expects", () => {
    const filter: ProjectElement = { kind: "filter", id: "f1", source: "p" };
    const traceA: ProjectElement = { kind: "trace", id: "tA", source: "f1" };
    const traceB: ProjectElement = { kind: "trace", id: "tB", source: "f1" };
    const g = deriveGraph([bus("p")], [], [filter, traceA, traceB]);
    expect(g.edges).toHaveLength(3);
    // bus → filter, filter → traceA, filter → traceB
    expect(g.edges.filter((e) => e.kind === "bus-filter")).toHaveLength(1);
    expect(g.edges.filter((e) => e.kind === "filter-out")).toHaveLength(2);
  });

  it("a transmit element renders as a node with no auto-edge to any bus", () => {
    const tx: ProjectElement = { kind: "transmit", id: "tx1" };
    const g = deriveGraph([bus("p")], [], [tx]);
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes.find((n) => n.id === elementNodeId("tx1"))?.kind).toBe(
      "transmit",
    );
    expect(g.edges).toEqual([]);
  });

  it("a consumer whose source points at a deleted bus dangles silently", () => {
    const trace: ProjectElement = { kind: "trace", id: "t1", source: "gone" };
    const g = deriveGraph([bus("p")], [], [trace]);
    // Trace renders; no edge to a phantom bus.
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([]);
  });
});
