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

  it("element nodes resolve their label through the model-owned name", () => {
    // ADR 0019: every view goes through `elementLabel` — a named
    // element shows its name; an unnamed one falls back to
    // `${Kind} ${shortId}`.
    const named: ProjectElement = {
      kind: "trace",
      id: "abcdef123",
      name: "Powertrain log",
      sources: [],
    };
    const unnamed: ProjectElement = { kind: "plot", id: "fedcba987", sources: [] };
    const g = deriveGraph([], [], [named, unnamed]);
    expect(g.nodes.find((n) => n.id === elementNodeId("abcdef123"))?.label).toBe(
      "Powertrain log",
    );
    expect(g.nodes.find((n) => n.id === elementNodeId("fedcba987"))?.label).toBe(
      "Plot fedcba",
    );
  });

  it("a gateway bound to a non-existent bus produces the node but no edge", () => {
    const b = binding("127.0.0.1:50051", "can0", "missing");
    const g = deriveGraph([bus("p")], [b], []);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([]);
  });

  it("a local-virtual-bus binding does not produce a gateway node (the bus is the source)", () => {
    const b: InterfaceBinding = {
      kind: "local-virtual-bus",
      server: "local-vbus://vbus1",
      interface: "bus",
      bus_id: "v",
    };
    const g = deriveGraph([bus("v", "Test virtual")], [b], []);
    // Only the bus node, no gateway node.
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].kind).toBe("bus");
    expect(g.edges).toEqual([]);
  });

  it("a remote-virtual-bus binding renders as a gateway with a vbus label", () => {
    const b: InterfaceBinding = {
      kind: "remote-virtual-bus",
      server: "10.0.0.5:50051",
      interface: "",
      bus_id: "p",
    };
    const g = deriveGraph([bus("p")], [b], []);
    expect(g.nodes).toHaveLength(2);
    const gateway = g.nodes.find((n) => n.kind === "gateway");
    expect(gateway?.label).toContain("vbus factory");
  });

  it("a sink with sources=['*'] draws an edge from every bus", () => {
    const trace: ProjectElement = { kind: "trace", id: "t1", sources: ["*"] };
    const g = deriveGraph([bus("p"), bus("c"), bus("b")], [], [trace]);
    const targets = g.edges
      .filter((e) => e.target === elementNodeId("t1"))
      .map((e) => e.source)
      .sort();
    expect(targets).toEqual(
      [busNodeId("b"), busNodeId("c"), busNodeId("p")].sort(),
    );
    expect(g.edges.every((e) => e.kind === "bus-consumer")).toBe(true);
  });

  it("a sink with an explicit bus list draws one edge per listed bus", () => {
    const trace: ProjectElement = {
      kind: "trace",
      id: "t1",
      sources: ["p", "c"],
    };
    const g = deriveGraph([bus("p"), bus("c"), bus("b")], [], [trace]);
    const fromB = g.edges.filter((e) => e.source === busNodeId("b"));
    expect(fromB).toEqual([]); // unlisted bus doesn't feed the sink
    const targeted = g.edges
      .filter((e) => e.target === elementNodeId("t1"))
      .map((e) => e.source)
      .sort();
    expect(targeted).toEqual([busNodeId("c"), busNodeId("p")].sort());
  });

  it("sources=['*', filter] draws every-bus edges plus the filter edge", () => {
    const filter: ProjectElement = {
      kind: "filter",
      id: "f1",
      sources: ["*"],
    };
    const trace: ProjectElement = {
      kind: "trace",
      id: "t1",
      sources: ["*", "f1"],
    };
    const g = deriveGraph([bus("p"), bus("c")], [], [filter, trace]);
    const intoTrace = g.edges
      .filter((e) => e.target === elementNodeId("t1"))
      .map((e) => ({ src: e.source, kind: e.kind }))
      .sort((a, b) => a.src.localeCompare(b.src));
    expect(intoTrace).toEqual(
      [
        { src: busNodeId("c"), kind: "bus-consumer" as const },
        { src: busNodeId("p"), kind: "bus-consumer" as const },
        { src: elementNodeId("f1"), kind: "filter-consumer" as const },
      ].sort((a, b) => a.src.localeCompare(b.src)),
    );
  });

  it("a sink with sources=[] (the 'matches nothing' shape) draws no edges", () => {
    const trace: ProjectElement = { kind: "trace", id: "t1", sources: [] };
    const g = deriveGraph([bus("p")], [], [trace]);
    expect(g.edges.filter((e) => e.target === elementNodeId("t1"))).toEqual([]);
  });

  it("a sink whose source id matches nothing dangles silently", () => {
    const trace: ProjectElement = {
      kind: "trace",
      id: "t1",
      sources: ["deleted-bus"],
    };
    const g = deriveGraph([bus("p")], [], [trace]);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([]);
  });

  it("a filter feeding two sinks renders 1-in / 2-out as the user expects", () => {
    // Filter F absorbs all buses; two traces each consume only F.
    const filter: ProjectElement = {
      kind: "filter",
      id: "f1",
      sources: ["*"],
    };
    const traceA: ProjectElement = { kind: "trace", id: "tA", sources: ["f1"] };
    const traceB: ProjectElement = { kind: "trace", id: "tB", sources: ["f1"] };
    const g = deriveGraph([bus("p"), bus("c")], [], [filter, traceA, traceB]);
    expect(
      g.edges.filter((e) => e.kind === "bus-consumer" && e.target === elementNodeId("f1")),
    ).toHaveLength(2);
    expect(
      g.edges.filter(
        (e) => e.kind === "filter-consumer" && e.source === elementNodeId("f1"),
      ),
    ).toHaveLength(2);
  });

  it("a transmit with sinks=[] (unset / default) fans out to every project bus", () => {
    // Empty sinks is the "I haven't picked anything yet" state — the
    // transmit panel treats it as "every bus" and so does the
    // graph, so a newly created transmit element doesn't render as
    // a disconnected node.
    const tx: ProjectElement = { kind: "transmit", id: "tx1", sinks: [], frameIds: [] };
    const g = deriveGraph([bus("p"), bus("c")], [], [tx]);
    const outgoing = g.edges.filter((e) => e.source === elementNodeId("tx1"));
    expect(outgoing.map((e) => e.target).sort()).toEqual(
      [busNodeId("c"), busNodeId("p")].sort(),
    );
  });

  it("a transmit with explicit sinks draws one transmit→bus edge per listed bus", () => {
    const tx: ProjectElement = {
      kind: "transmit",
      id: "tx1",
      sinks: ["p", "c"],
      frameIds: [],
    };
    const g = deriveGraph([bus("p"), bus("c"), bus("b")], [], [tx]);
    const outgoing = g.edges.filter((e) => e.source === elementNodeId("tx1"));
    expect(outgoing.map((e) => e.target).sort()).toEqual(
      [busNodeId("c"), busNodeId("p")].sort(),
    );
    expect(outgoing.every((e) => e.kind === "transmit-bus")).toBe(true);
    // Bus "b" wasn't in sinks — no edge.
    expect(
      g.edges.find((e) => e.target === busNodeId("b") && e.source === elementNodeId("tx1")),
    ).toBeUndefined();
  });

  it("a transmit pointing at a deleted bus dangles silently", () => {
    const tx: ProjectElement = {
      kind: "transmit",
      id: "tx1",
      sinks: ["gone"],
      frameIds: [],
    };
    const g = deriveGraph([bus("p")], [], [tx]);
    expect(g.edges).toEqual([]);
  });
});
