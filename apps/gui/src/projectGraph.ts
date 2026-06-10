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
  | "bus-consumer" // bus → any consumer (trace / plot / filter)
  | "filter-consumer" // filter → any downstream consumer
  | "transmit-bus"; // transmit element → bus (one per `sinks` entry)

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
///
/// Edge model (Phase 6.5): every consumer (`trace` / `plot` / `filter`)
/// carries a `sources: string[]` list of producer ids — bus ids,
/// filter ids, or the wildcard `"*"` meaning "every bus in the project,
/// including buses added later" (see `types.ts`). For each id in
/// `sources`, an edge is drawn from the resolved producer to the
/// consumer; ids that match nothing are silently dropped, letting the
/// consumer dangle in the graph (the truth of the data). A consumer
/// with `sources=[]` matches nothing at all and gets no incoming
/// edges.
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
    if (el.kind === "transmit") {
      // Producer-side wiring: one edge per explicit bus in `sinks`.
      // No wildcard support — `sinks` is always a literal list
      // (see types.ts). An *empty* sinks list is treated as "every
      // bus in the project", matching the transmit-panel default —
      // the user shouldn't see a disconnected transmit node just
      // because they haven't pruned the destination list.
      const source = elementNodeId(el.id);
      const effective: readonly string[] =
        el.sinks.length > 0 ? el.sinks : buses.map((b) => b.id);
      const seen = new Set<string>();
      for (const busId of effective) {
        if (!busIds.has(busId) || seen.has(busId)) continue;
        seen.add(busId);
        edges.push({
          id: `e:transmit-bus:${source}->${busNodeId(busId)}`,
          source,
          target: busNodeId(busId),
          kind: "transmit-bus",
        });
      }
      continue;
    }
    const sources = el.sources ?? [];
    const target = elementNodeId(el.id);
    // Track buses already wired (the `"*"` wildcard + an explicit bus
    // id pointing at the same bus shouldn't draw a duplicate edge).
    const seenBuses = new Set<string>();
    for (const src of sources) {
      if (src === "*") {
        for (const bus of buses) {
          if (seenBuses.has(bus.id)) continue;
          seenBuses.add(bus.id);
          edges.push({
            id: `e:bus-consumer:${busNodeId(bus.id)}->${target}`,
            source: busNodeId(bus.id),
            target,
            kind: "bus-consumer",
          });
        }
      } else if (busIds.has(src)) {
        if (seenBuses.has(src)) continue;
        seenBuses.add(src);
        edges.push({
          id: `e:bus-consumer:${busNodeId(src)}->${target}`,
          source: busNodeId(src),
          target,
          kind: "bus-consumer",
        });
      } else if (filterIds.has(src)) {
        edges.push({
          id: `e:filter-consumer:${elementNodeId(src)}->${target}`,
          source: elementNodeId(src),
          target,
          kind: "filter-consumer",
        });
      }
      // Anything else (stale id pointing at a deleted bus or filter,
      // unknown future kind) is silently dropped — the consumer's
      // node renders, but the edge doesn't.
    }
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
