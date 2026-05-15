// Pure project → graph derivation, split out of `ProjectGraphPanel.tsx`
// so the wiring logic is testable without React or `@xyflow/react`.

import type { Bus, InterfaceBinding, ProjectElement } from "./types";

export type GraphNodeKind =
  | "bus"
  | "gateway"
  | "transmit"
  | "trace"
  | "plot"
  | "filter";

export interface GraphNodeBase {
  id: string;
  kind: GraphNodeKind;
  label: string;
}

export interface BusGraphNode extends GraphNodeBase {
  kind: "bus";
  bus: Bus;
}

export interface GatewayGraphNode extends GraphNodeBase {
  kind: "gateway";
  binding: InterfaceBinding;
}

export interface ElementGraphNode extends GraphNodeBase {
  kind: "transmit" | "trace" | "plot" | "filter";
  element: ProjectElement;
}

export type GraphNode = BusGraphNode | GatewayGraphNode | ElementGraphNode;

export type GraphEdgeKind =
  | "gateway-bus" // interface binding ↔ bus (bidirectional)
  | "bus-sink" // bus → trace / plot
  | "bus-filter" // bus → filter
  | "filter-out"; // filter → downstream (trace / plot / another filter)

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

export function busNodeId(busId: string): string {
  return `bus:${busId}`;
}

export function gatewayNodeId(b: InterfaceBinding): string {
  return `gateway:${b.server}::${b.interface}`;
}

export function elementNodeId(id: string): string {
  return `el:${id}`;
}

/// Build the graph view from project state. Pure: same inputs always
/// produce the same nodes and edges (independent of positions). Element
/// order in inputs is preserved in outputs so callers can rely on stable
/// row order when laying out.
export function deriveGraph(
  buses: readonly Bus[],
  bindings: readonly InterfaceBinding[],
  elements: readonly ProjectElement[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const bus of buses) {
    nodes.push({ id: busNodeId(bus.id), kind: "bus", label: bus.name, bus });
  }

  for (const b of bindings) {
    nodes.push({
      id: gatewayNodeId(b),
      kind: "gateway",
      label: gatewayLabel(b),
      binding: b,
    });
    // Gateway nodes wire to the bus they're bound to. Bidirectional —
    // a gateway both injects (frames arriving on the wire) and
    // consumes (transmits going out) — but we draw it as one edge here
    // and let the renderer pick how to mark it.
    if (buses.some((bus) => bus.id === b.bus_id)) {
      edges.push({
        id: `e:gateway-bus:${gatewayNodeId(b)}->${busNodeId(b.bus_id)}`,
        source: gatewayNodeId(b),
        target: busNodeId(b.bus_id),
        kind: "gateway-bus",
      });
    }
  }

  const busIds = new Set(buses.map((b) => b.id));
  const filterIds = new Set(
    elements.filter((e) => e.kind === "filter").map((e) => e.id),
  );

  for (const el of elements) {
    if (el.kind === "filter") {
      nodes.push({
        id: elementNodeId(el.id),
        kind: "filter",
        label: filterLabel(el),
        element: el,
      });
    } else if (el.kind === "transmit") {
      nodes.push({
        id: elementNodeId(el.id),
        kind: "transmit",
        label: `Transmit ${shortId(el.id)}`,
        element: el,
      });
      // Transmit elements don't yet carry a target bus on the element
      // (frames inside the panel each pick a channel that the active
      // session maps to an interface). No edge until that's modeled —
      // see backlog.
    } else {
      // trace | plot
      nodes.push({
        id: elementNodeId(el.id),
        kind: el.kind,
        label: `${capitalise(el.kind)} ${shortId(el.id)}`,
        element: el,
      });
    }
  }

  for (const el of elements) {
    if (el.kind === "transmit") continue;
    const src = el.source ?? null;
    if (!src) continue;
    if (busIds.has(src)) {
      edges.push({
        id: `e:bus->${el.kind}:${busNodeId(src)}->${elementNodeId(el.id)}`,
        source: busNodeId(src),
        target: elementNodeId(el.id),
        kind: el.kind === "filter" ? "bus-filter" : "bus-sink",
      });
    } else if (filterIds.has(src)) {
      edges.push({
        id: `e:filter-out:${elementNodeId(src)}->${elementNodeId(el.id)}`,
        source: elementNodeId(src),
        target: elementNodeId(el.id),
        kind: "filter-out",
      });
    }
    // Sources that match nothing (a stale id from a deleted bus /
    // filter) are silently dropped — the graph just shows the consumer
    // dangling, which is the truth of the data.
  }

  return { nodes, edges };
}

function gatewayLabel(b: InterfaceBinding): string {
  const host = b.server.replace(/^.*[:/]/, "");
  return `${b.interface}\n@ ${host || b.server}`;
}

function filterLabel(el: ProjectElement & { kind: "filter" }): string {
  return el.name && el.name.length > 0 ? el.name : `Filter ${shortId(el.id)}`;
}

function shortId(id: string): string {
  return id.length > 6 ? id.slice(0, 6) : id;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
