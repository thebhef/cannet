import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IDockviewPanelProps } from "dockview";

import { FilterPredicateEditor } from "./FilterPredicateEditor";
import { insertFilterUpstream } from "./insertFilterUpstream";
import {
  Background,
  Controls,
  type Edge,
  type EdgeChange,
  Handle,
  MarkerType,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import { useProjectContext, type ProjectContextValue } from "./projectContext";
import { useElementRegistry } from "./projectElements";
import {
  type GraphEdge,
  type GraphNode,
  type GraphNodeKind,
  deriveGraph,
} from "./projectGraph";
import type { FilterPredicate } from "./types";
import { effectiveBusColor } from "./busColor";
import { assignLanePositions, reconcileGraphNodes } from "./graphNodeLayout";

/// Per-panel persisted state. Lives in the panel's dockview `params`
/// so each project graph panel keeps its own viewport and layout
/// across reloads.
interface GraphParams {
  /// `nodeId` -> `{x, y}`. `nodeId` is the same id the underlying
  /// element / bus / gateway uses.
  positions?: Record<string, { x: number; y: number }>;
}

const BUS_WIDTH = 320;
const NODE_WIDTH = 220;

/// Phase-6 project graph view: gateways (interface bindings), buses,
/// filters, transmit sources, and trace/plot sinks rendered with
/// kind-specific shapes. Backed by `@xyflow/react`. Viewport and node
/// positions persist in the panel's `params`; the rest comes from the
/// project state.
export function ProjectGraphPanel(props: IDockviewPanelProps) {
  return (
    <ReactFlowProvider>
      <ProjectGraphPanelInner {...props} />
    </ReactFlowProvider>
  );
}

function ProjectGraphPanelInner(props: IDockviewPanelProps) {
  const project = useProjectContext();
  const registry = useElementRegistry();

  const graph = useMemo(
    () =>
      deriveGraph(
        project.buses,
        project.interfaceBindings,
        registry.entries.map((e) => e.element),
      ),
    [project.buses, project.interfaceBindings, registry.entries],
  );

  // xyflow nodes live in React state — *not* re-derived each render —
  // so xyflow's per-node `measured` size and any in-flight drag
  // position survive re-renders. Handing xyflow a node without
  // `measured` makes it treat the node as unmeasured: it resets the
  // handle bounds and routes edges through fallback `0×0` geometry,
  // which is what broke dragging and edge/node right-click hit-testing.
  // `nodesRef` mirrors the state and is the authoritative copy the
  // mutation sites read/write; `setRfNodes` only drives rendering.
  const [rfNodes, setRfNodes] = useState<Node[]>(() =>
    reconcileGraphNodes(
      graph.nodes,
      [],
      (props.params as GraphParams | undefined)?.positions ?? {},
    ),
  );
  const nodesRef = useRef(rfNodes);
  const reconcileMounted = useRef(false);

  // Persist node positions into the panel's dockview params so the
  // layout survives reload. Called on drag-end only.
  const persistPositions = useCallback(
    (nodes: readonly Node[]) => {
      const positions: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) {
        positions[n.id] = { x: n.position.x, y: n.position.y };
      }
      props.api.updateParameters({ ...(props.params ?? {}), positions });
    },
    [props.api, props.params],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Apply *every* change — crucially xyflow's `dimensions`
      // measurements, which carry each node's measured size. Dropping
      // those (an earlier bug) left every node permanently
      // "unmeasured" and corrupted edge geometry + drag hit-testing.
      const next = applyNodeChanges(changes, nodesRef.current);
      nodesRef.current = next;
      setRfNodes(next);
      // A `position` change with `dragging === false` is a drag end —
      // the only point worth writing the layout back to params.
      if (changes.some((c) => c.type === "position" && c.dragging === false)) {
        persistPositions(next);
      }
    },
    [persistPositions],
  );

  // Reconcile the live node state whenever the derived graph changes
  // (a bus / element added or removed, a filter renamed, …). Existing
  // nodes keep their dragged position + measured size; new nodes are
  // lane-placed; removed nodes drop out. The mount run is skipped —
  // the `useState` initializer already seeded from this derivation.
  useEffect(() => {
    if (!reconcileMounted.current) {
      reconcileMounted.current = true;
      return;
    }
    const next = reconcileGraphNodes(graph.nodes, nodesRef.current, {});
    nodesRef.current = next;
    setRfNodes(next);
  }, [graph.nodes]);

  // Reset layout: re-lane every node and clear the persisted
  // positions so a future open re-lays-out from scratch too.
  const resetLayout = useCallback(() => {
    const lane = assignLanePositions(
      nodesRef.current.map((n) => ({
        id: n.id,
        kind: n.type as GraphNodeKind,
      })),
    );
    const next = nodesRef.current.map((n) => ({
      ...n,
      position: lane[n.id] ?? n.position,
    }));
    nodesRef.current = next;
    setRfNodes(next);
    props.api.updateParameters({ ...(props.params ?? {}), positions: {} });
  }, [props.api, props.params]);

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        // Colour a wire by the bus it carries. The bus endpoint
        // differs by edge kind: `bus-consumer` has the bus as its
        // source, `gateway-bus` and `transmit-bus` as their target.
        // `filter-consumer` carries no single bus → neutral grey.
        let color = NEUTRAL_EDGE;
        if (e.kind === "bus-consumer") {
          color = effectiveBusColor(stripBusPrefix(e.source), project.buses);
        } else if (e.kind === "gateway-bus" || e.kind === "transmit-bus") {
          color = effectiveBusColor(stripBusPrefix(e.target), project.buses);
        }
        return toXyflowEdge(e, color);
      }),
    [graph.edges, project.buses],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // Edges are re-derived from project state every render, so
      // xyflow edge changes are advisory — applying them just keeps
      // xyflow's internal mirror in sync for the current frame.
      // Removals route through the right-click menu.
      applyEdgeChanges(changes, edges);
    },
    [edges],
  );

  // Right-click context menu. xyflow's own `onEdgeContextMenu` /
  // `onNodeContextMenu` callbacks proved unreliable here, so we
  // catch the bubbled `contextmenu` event at the panel level and
  // resolve the target by walking the DOM: xyflow tags each edge
  // group and node wrapper with a `data-id` attribute
  // (`.react-flow__edge[data-id]`, `.react-flow__node[data-id]`).
  const [graphMenu, setGraphMenu] = useState<GraphMenu | null>(null);
  const handlePanelContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as Element | null;
    const edgeEl = target?.closest(".react-flow__edge");
    const edgeId = edgeEl?.getAttribute("data-id");
    if (edgeId) {
      e.preventDefault();
      setGraphMenu({ kind: "edge", x: e.clientX, y: e.clientY, edgeId });
      return;
    }
    // Node ids are the xyflow node id: `el:<uuid>` for project
    // elements, `bus:<id>` / `gateway:…` for the rest. Only element
    // nodes get a remove action (buses/gateways are project-panel
    // configuration).
    const nodeEl = target?.closest(".react-flow__node");
    const nodeId = nodeEl?.getAttribute("data-id");
    if (nodeId?.startsWith("el:")) {
      e.preventDefault();
      setGraphMenu({
        kind: "node",
        x: e.clientX,
        y: e.clientY,
        elementId: nodeId.slice(3),
      });
    }
  }, []);
  useEffect(() => {
    if (graphMenu == null) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest(".graph-edge-menu") == null) {
        setGraphMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGraphMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [graphMenu]);

  // Drag-to-connect: xyflow fires `onConnect` when the user drops a
  // drag from one handle onto another. Translate the connection into
  // the matching `sources`/`sinks` addition.
  const onConnect = useCallback(
    (conn: { source: string | null; target: string | null }) => {
      if (!conn.source || !conn.target) return;
      addEdgeToRegistry(conn.source, conn.target, registry, project.buses);
    },
    [project.buses, registry],
  );

  const empty =
    project.buses.length === 0 &&
    project.interfaceBindings.length === 0 &&
    registry.entries.length === 0;

  return (
    <div className="graph-panel">
      <div className="graph-panel-toolbar">
        <button
          type="button"
          onClick={() => registry.create("filter")}
          title="Create a new filter element; it'll fan in from every bus by default and dangle (no downstream) until a trace or plot is wired to it"
        >
          + filter
        </button>
        <button
          type="button"
          onClick={resetLayout}
          title="Clear saved node positions and re-lay-out the graph from scratch"
        >
          Reset layout
        </button>
      </div>
      <div className="graph-panel-canvas" onContextMenu={handlePanelContextMenu}>
        {empty ? (
          <div className="graph-empty">
            <p>No project elements yet.</p>
            <p>
              Add a bus and an interface binding from the project panel to
              start wiring. "+ filter" above creates a filter element that
              fans in from every bus.
            </p>
          </div>
        ) : (
          <ReactFlow
            nodes={rfNodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        )}
        {graphMenu &&
          // Portal to <body> so the menu escapes any transformed
          // ancestor (dockview's panel container applies CSS
          // transforms, which would otherwise re-anchor a
          // `position: fixed` menu off-screen).
          createPortal(
            <div
              className="graph-edge-menu"
              role="menu"
              style={{ left: graphMenu.x, top: graphMenu.y }}
            >
              {graphMenu.kind === "edge" ? (
                <button
                  type="button"
                  onClick={() => {
                    removeEdgeFromRegistry(
                      graphMenu.edgeId,
                      registry,
                      graph,
                      project.buses,
                    );
                    setGraphMenu(null);
                  }}
                >
                  Delete edge
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    registry.remove(graphMenu.elementId);
                    setGraphMenu(null);
                  }}
                >
                  Remove element
                </button>
              )}
            </div>,
            document.body,
          )}
      </div>
    </div>
  );
}

/// Right-click context-menu target in the project graph view —
/// either an edge (offers "Delete edge") or a project-element node
/// (offers "Remove element"). Bus / gateway nodes don't get a menu.
type GraphMenu =
  | { kind: "edge"; x: number; y: number; edgeId: string }
  | { kind: "node"; x: number; y: number; elementId: string };

/// Translate an edge-removal from the graph view into the matching
/// registry update. Edge ids encode the relationship in the
/// `kind:source->target` form set up by `projectGraph::deriveGraph`,
/// so we just look them up and patch the consumer's `sources` or
/// the transmit's `sinks`. Gateway↔bus edges are *not* removable
/// here — those are project-panel bindings, removed via the
/// binding-list UI.
function removeEdgeFromRegistry(
  edgeId: string,
  registry: ReturnType<typeof useElementRegistry>,
  graph: ReturnType<typeof deriveGraph>,
  buses: readonly { id: string }[],
): void {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return;
  const stripBus = (s: string) => s.replace(/^bus:/, "");
  const stripEl = (s: string) => s.replace(/^el:/, "");
  switch (edge.kind) {
    case "gateway-bus":
      // Binding deletion lives in the project panel — silently
      // ignore here so backspace on a wire doesn't drop the user's
      // configured remote binding.
      return;
    case "bus-consumer":
    case "filter-consumer": {
      const consumerId = stripEl(edge.target);
      const upstreamId =
        edge.kind === "bus-consumer" ? stripBus(edge.source) : stripEl(edge.source);
      const el = registry.get(consumerId)?.element;
      if (!el || el.kind === "transmit") return;
      const current = el.sources;
      // Three paths depending on the current shape:
      // - sources=["*"]: the deleted bus expands into "every bus
      //   except this one"; filter-consumer removal of a never-
      //   listed filter is a no-op.
      // - explicit list containing the upstream id: drop it.
      // - anything else: no-op.
      if (current.includes("*") && edge.kind === "bus-consumer") {
        const expanded = buses.map((b) => b.id).filter((id) => id !== upstreamId);
        registry.update(consumerId, { sources: expanded });
        return;
      }
      if (current.includes(upstreamId)) {
        registry.update(consumerId, {
          sources: current.filter((s) => s !== upstreamId),
        });
      }
      return;
    }
    case "transmit-bus": {
      const transmitId = stripEl(edge.source);
      const busId = stripBus(edge.target);
      const el = registry.get(transmitId)?.element;
      if (!el || el.kind !== "transmit") return;
      // Empty sinks is the "fan out to all" default; expand it
      // before pruning so the user's intent (drop *this* bus) is
      // preserved.
      const current =
        el.sinks.length > 0 ? el.sinks : buses.map((b) => b.id);
      const next = current.filter((id) => id !== busId);
      registry.update(transmitId, { sinks: next });
      return;
    }
  }
}

/// Drag-to-connect: when the user drags an edge from one node's
/// handle onto another node and releases, xyflow gives us the
/// source/target node ids. Translate that into the matching
/// registry update — adding to the consumer's `sources` or the
/// transmit's `sinks` so the next derivation picks the edge up.
/// Invalid drags (gateway from bus, sink into transmit, etc.) are
/// silently ignored.
function addEdgeToRegistry(
  sourceNodeId: string,
  targetNodeId: string,
  registry: ReturnType<typeof useElementRegistry>,
  buses: readonly { id: string }[],
): void {
  const stripBus = (s: string) =>
    s.startsWith("bus:") ? s.slice(4) : null;
  const stripEl = (s: string) =>
    s.startsWith("el:") ? s.slice(3) : null;

  // Producer side: a bus, a filter, or a transmit (as a producer).
  // Consumer side: a trace/plot/filter, or — for transmit→bus — a bus.
  const sourceBusId = stripBus(sourceNodeId);
  const sourceElId = stripEl(sourceNodeId);
  const targetBusId = stripBus(targetNodeId);
  const targetElId = stripEl(targetNodeId);

  // Case 1: producer → consumer (bus or filter → trace/plot/filter)
  if (targetElId) {
    const consumer = registry.get(targetElId)?.element;
    if (!consumer || consumer.kind === "transmit") return;
    // Sub-case: filter→consumer (sourceElId is a filter id)
    let producerId: string | null = null;
    if (sourceBusId && buses.some((b) => b.id === sourceBusId)) {
      producerId = sourceBusId;
    } else if (sourceElId) {
      const src = registry.get(sourceElId)?.element;
      if (src?.kind === "filter") producerId = sourceElId;
    }
    if (!producerId) return;
    const current = consumer.sources;
    // If the producer is already covered (explicit or via "*" for a
    // bus), no-op.
    if (current.includes(producerId)) return;
    if (current.includes("*") && buses.some((b) => b.id === producerId)) {
      // Already implicitly included.
      return;
    }
    registry.update(consumer.id, { sources: [...current, producerId] });
    return;
  }

  // Case 2: transmit → bus
  if (sourceElId && targetBusId && buses.some((b) => b.id === targetBusId)) {
    const tx = registry.get(sourceElId)?.element;
    if (!tx || tx.kind !== "transmit") return;
    // Empty sinks is the implicit fan-out — already includes every
    // bus, so adding the dragged-to bus is a no-op (don't materialise
    // the full list here; let the panel/derivation continue treating
    // empty as default).
    if (tx.sinks.length === 0) return;
    if (tx.sinks.includes(targetBusId)) return;
    registry.update(tx.id, { sinks: [...tx.sinks, targetBusId] });
  }
}

/// Edge colour for wires that don't carry a single identifiable bus
/// (filter→consumer).
const NEUTRAL_EDGE = "#94a3b8";

const EDGE_STROKE_WIDTH = 8;

/// Invisible hit-area width around each edge for pointer events
/// (right-click to delete). Much wider than the visible stroke so
/// the edge is easy to land a right-click on.
const EDGE_INTERACTION_WIDTH = 48;

/// Strip the `bus:` prefix `busNodeId` adds, recovering the raw bus
/// id. Returns the input unchanged if it isn't a bus node id.
function stripBusPrefix(nodeId: string): string {
  return nodeId.startsWith("bus:") ? nodeId.slice(4) : nodeId;
}

function toXyflowEdge(e: GraphEdge, color: string): Edge {
  // gateway↔bus is logically bidirectional (a gateway both injects and
  // consumes); render with arrowheads on both ends so the user reads it
  // as a two-way wire.
  if (e.kind === "gateway-bus") {
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      markerStart: { type: MarkerType.ArrowClosed, color },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: EDGE_STROKE_WIDTH },
      interactionWidth: EDGE_INTERACTION_WIDTH,
    };
  }
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    markerEnd: { type: MarkerType.ArrowClosed, color },
    style: { stroke: color, strokeWidth: EDGE_STROKE_WIDTH },
    interactionWidth: EDGE_INTERACTION_WIDTH,
  };
}

// --- custom node shapes -----------------------------------------------

// xyflow's node `data` must be a `Record<string, unknown>`; we tunnel
// our typed `GraphNode` through under the `graph` key and unwrap in
// each renderer.
function unwrap(data: NodeProps["data"]): GraphNode {
  return (data as { graph: GraphNode }).graph;
}

function BusNode({ data }: NodeProps) {
  const node = unwrap(data);
  const project = useProjectContext();
  if (node.kind !== "bus") return null;
  // The bus's colour drives the whole node: a dark tinted body
  // (the bus colour blended into the panel-dark base), a solid
  // border, and the rail bar — so the node reads as the same colour
  // as every wire it carries. Overrides the hardcoded blue in the
  // `.graph-node-bus` CSS rule.
  const color = effectiveBusColor(node.bus.id, project.buses);
  return (
    <div
      className="graph-node graph-node-bus"
      style={{
        width: BUS_WIDTH,
        background: `color-mix(in srgb, ${color} 22%, #11161f)`,
        borderColor: color,
      }}
    >
      <Handle type="target" position={Position.Left} id="bus-in" />
      <Handle type="source" position={Position.Right} id="bus-out" />
      <Handle type="target" position={Position.Top} id="bus-top" />
      <Handle type="source" position={Position.Bottom} id="bus-bot" />
      <div
        className="graph-bus-bar"
        aria-hidden="true"
        style={{ background: color, boxShadow: `0 0 6px ${color}73` }}
      />
      <div className="graph-node-label">
        <span className="graph-node-kind">Bus</span>
        <span className="graph-node-title">{node.label}</span>
        <span className="graph-node-sub">id: {node.bus.id}</span>
      </div>
    </div>
  );
}

function GatewayNode({ data }: NodeProps) {
  const node = unwrap(data);
  if (node.kind !== "gateway") return null;
  const b = node.binding;
  return (
    <div className="graph-node graph-node-gateway" style={{ width: NODE_WIDTH }}>
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Right} />
      <GatewayGlyph />
      <div className="graph-node-label">
        <span className="graph-node-kind">Interface</span>
        <span className="graph-node-title">{b.interface}</span>
        <span className="graph-node-sub">@ {b.server}</span>
      </div>
    </div>
  );
}

function TransmitNode({ data }: NodeProps) {
  const node = unwrap(data);
  if (node.kind !== "transmit") return null;
  return (
    <div
      className="graph-node graph-node-transmit"
      style={{ width: NODE_WIDTH }}
    >
      <Handle type="source" position={Position.Right} />
      <TransmitGlyph />
      <div className="graph-node-label">
        <span className="graph-node-kind">Transmit (source)</span>
        <span className="graph-node-title">{node.label}</span>
      </div>
    </div>
  );
}

function TraceNode({ data }: NodeProps) {
  const node = unwrap(data);
  const registry = useElementRegistry();
  if (node.kind !== "trace") return null;
  return (
    <div className="graph-node graph-node-trace" style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} />
      <TraceGlyph />
      <div className="graph-node-label">
        <span className="graph-node-kind">Trace (sink)</span>
        <span className="graph-node-title">{node.label}</span>
        <InsertFilterButton
          onClick={() => insertFilterUpstream(registry, node.element.id)}
        />
      </div>
    </div>
  );
}

function PlotNode({ data }: NodeProps) {
  const node = unwrap(data);
  const registry = useElementRegistry();
  if (node.kind !== "plot") return null;
  return (
    <div className="graph-node graph-node-plot" style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} />
      <PlotGlyph />
      <div className="graph-node-label">
        <span className="graph-node-kind">Plot (sink)</span>
        <span className="graph-node-title">{node.label}</span>
        <InsertFilterButton
          onClick={() => insertFilterUpstream(registry, node.element.id)}
        />
      </div>
    </div>
  );
}

/// Small "+ filter" button rendered on each consumer node in the
/// graph. Clicking it creates a fresh filter, transfers the
/// consumer's input streams onto the filter, then re-routes the
/// consumer through the new filter — same orchestration as the
/// `insertFilterUpstream` helper.
function InsertFilterButton(props: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="graph-node-insert-filter nodrag"
      title="Create a new filter upstream of this view (inherits the view's current sources)"
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    >
      + filter
    </button>
  );
}

function FilterNode({ data }: NodeProps) {
  const node = unwrap(data);
  const registry = useElementRegistry();
  const project = useProjectContext();
  const [expanded, setExpanded] = useState(false);
  if (node.kind !== "filter") return null;
  if (node.element.kind !== "filter") return null;
  const el = node.element;
  const predicate = el.predicate ?? null;
  const handleChange = (patch: { predicate?: FilterPredicate | null; name?: string }) => {
    registry.update(el.id, patch);
  };
  return (
    <div
      className={`graph-node graph-node-filter${expanded ? " expanded" : ""}`}
      style={{ width: NODE_WIDTH }}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <FilterGlyph />
      <div className="graph-node-label">
        <span className="graph-node-kind">Filter</span>
        <span className="graph-node-title">{node.label}</span>
        <button
          type="button"
          className="graph-node-expand nodrag"
          aria-label={expanded ? "collapse predicate editor" : "expand predicate editor"}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? "▾" : "▸"}
        </button>
      </div>
      {expanded && (
        <FilterPredicateEditor
          predicate={predicate}
          name={el.name}
          busIds={busIds(project)}
          onChange={handleChange}
        />
      )}
    </div>
  );
}

function busIds(project: ProjectContextValue): string[] {
  return project.buses.map((b) => b.id);
}

const NODE_TYPES = {
  bus: BusNode,
  gateway: GatewayNode,
  transmit: TransmitNode,
  trace: TraceNode,
  plot: PlotNode,
  filter: FilterNode,
};

// --- glyphs -----------------------------------------------------------
// Small inline SVGs so each kind reads at a glance. Kept tiny (24×24) so
// they sit beside the text label without dominating the node.

function GatewayGlyph() {
  return (
    <svg
      className="graph-node-glyph"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <line x1="7" y1="6" x2="7" y2="18" stroke="currentColor" strokeWidth="1.5" />
      <line x1="11" y1="6" x2="11" y2="18" stroke="currentColor" strokeWidth="1.5" />
      <line x1="15" y1="6" x2="15" y2="18" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function TransmitGlyph() {
  return (
    <svg
      className="graph-node-glyph"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M4 12 L18 12 M14 7 L18 12 L14 17"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TraceGlyph() {
  return (
    <svg
      className="graph-node-glyph"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <line x1="4" y1="6" x2="20" y2="6" stroke="currentColor" strokeWidth="1.5" />
      <line x1="4" y1="10" x2="20" y2="10" stroke="currentColor" strokeWidth="1.5" />
      <line x1="4" y1="14" x2="20" y2="14" stroke="currentColor" strokeWidth="1.5" />
      <line x1="4" y1="18" x2="20" y2="18" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function PlotGlyph() {
  return (
    <svg
      className="graph-node-glyph"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <polyline
        points="3,18 7,12 11,15 15,7 21,11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FilterGlyph() {
  return (
    <svg
      className="graph-node-glyph"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M3 5 L21 5 L14 13 L14 20 L10 18 L10 13 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
