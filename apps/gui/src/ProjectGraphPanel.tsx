import { useCallback, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
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

import { useProjectContext } from "./projectContext";
import { useElementRegistry } from "./projectElements";
import {
  type GraphEdge,
  type GraphNode,
  type GraphNodeKind,
  deriveGraph,
} from "./projectGraph";

/// Per-panel persisted state. Lives in the panel's dockview `params`
/// so each project graph panel keeps its own viewport and layout
/// across reloads.
interface GraphParams {
  /// `nodeId` -> `{x, y}`. `nodeId` is the same id the underlying
  /// element / bus / gateway uses.
  positions?: Record<string, { x: number; y: number }>;
}

// Default lane x-positions for nodes that haven't been dragged yet.
// Buses sit in the middle as a horizontal spine; gateways feed in from
// the left, sinks fan out to the right.
const LANE_X: Record<GraphNodeKind, number> = {
  gateway: 0,
  transmit: 0,
  bus: 360,
  filter: 760,
  plot: 1080,
  trace: 1080,
};
const LANE_Y_OFFSET: Record<GraphNodeKind, number> = {
  gateway: 0, // top-left lane
  transmit: 400, // bottom-left lane, below the gateways
  bus: 80,
  filter: 80,
  plot: 0, // sinks stack from the top of the right lane
  trace: 0,
};
const ROW_HEIGHT = 110;

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
  const initial = (props.params as GraphParams | undefined) ?? {};
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >(initial.positions ?? {});

  const persistPositions = useCallback(
    (next: Record<string, { x: number; y: number }>) => {
      setPositions(next);
      props.api.updateParameters({ ...(props.params ?? {}), positions: next });
    },
    [props.api, props.params],
  );

  const graph = useMemo(
    () =>
      deriveGraph(
        project.buses,
        project.interfaceBindings,
        registry.entries.map((e) => e.element),
      ),
    [project.buses, project.interfaceBindings, registry.entries],
  );

  // Build xyflow nodes from the pure derivation, overlaying persisted
  // positions and auto-lane placement for fresh nodes.
  const nodes: Node[] = useMemo(() => {
    const counts: Record<GraphNodeKind, number> = {
      gateway: 0,
      bus: 0,
      filter: 0,
      transmit: 0,
      trace: 0,
      plot: 0,
    };
    const place = (id: string, kind: GraphNodeKind) => {
      if (positions[id]) return positions[id];
      const row = counts[kind];
      counts[kind] += 1;
      return { x: LANE_X[kind], y: LANE_Y_OFFSET[kind] + row * ROW_HEIGHT };
    };
    return graph.nodes.map((n) => ({
      id: n.id,
      type: n.kind,
      position: place(n.id, n.kind),
      data: { graph: n } as Record<string, unknown>,
    }));
  }, [graph.nodes, positions]);

  const edges: Edge[] = useMemo(
    () => graph.edges.map((e) => toXyflowEdge(e)),
    [graph.edges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const updated = applyNodeChanges(changes, nodes);
      const nextPos: Record<string, { x: number; y: number }> = { ...positions };
      let changed = false;
      for (const n of updated) {
        const prev = nextPos[n.id];
        if (!prev || prev.x !== n.position.x || prev.y !== n.position.y) {
          nextPos[n.id] = { x: n.position.x, y: n.position.y };
          changed = true;
        }
      }
      if (changed) persistPositions(nextPos);
    },
    [nodes, positions, persistPositions],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // We re-derive edges from project state every render, so edge
      // changes from xyflow are advisory — applying them just keeps
      // xyflow's internal mirror in sync for the current frame.
      applyEdgeChanges(changes, edges);
    },
    [edges],
  );

  if (
    project.buses.length === 0 &&
    project.interfaceBindings.length === 0 &&
    registry.entries.length === 0
  ) {
    return (
      <div className="graph-empty">
        <p>No project elements yet.</p>
        <p>
          Add a bus and an interface binding from the project panel to
          start wiring.
        </p>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function toXyflowEdge(e: GraphEdge): Edge {
  // gateway↔bus is logically bidirectional (a gateway both injects and
  // consumes); render with arrowheads on both ends so the user reads it
  // as a two-way wire.
  if (e.kind === "gateway-bus") {
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      markerStart: { type: MarkerType.ArrowClosed },
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "#94a3b8", strokeWidth: 2 },
    };
  }
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "#94a3b8" },
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
  if (node.kind !== "bus") return null;
  return (
    <div className="graph-node graph-node-bus" style={{ width: BUS_WIDTH }}>
      <Handle type="target" position={Position.Left} id="bus-in" />
      <Handle type="source" position={Position.Right} id="bus-out" />
      <Handle type="target" position={Position.Top} id="bus-top" />
      <Handle type="source" position={Position.Bottom} id="bus-bot" />
      <div className="graph-bus-bar" aria-hidden="true" />
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
  if (node.kind !== "trace") return null;
  return (
    <div className="graph-node graph-node-trace" style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} />
      <TraceGlyph />
      <div className="graph-node-label">
        <span className="graph-node-kind">Trace (sink)</span>
        <span className="graph-node-title">{node.label}</span>
      </div>
    </div>
  );
}

function PlotNode({ data }: NodeProps) {
  const node = unwrap(data);
  if (node.kind !== "plot") return null;
  return (
    <div className="graph-node graph-node-plot" style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Left} />
      <PlotGlyph />
      <div className="graph-node-label">
        <span className="graph-node-kind">Plot (sink)</span>
        <span className="graph-node-title">{node.label}</span>
      </div>
    </div>
  );
}

function FilterNode({ data }: NodeProps) {
  const node = unwrap(data);
  if (node.kind !== "filter") return null;
  return (
    <div
      className="graph-node graph-node-filter"
      style={{ width: NODE_WIDTH }}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <FilterGlyph />
      <div className="graph-node-label">
        <span className="graph-node-kind">Filter</span>
        <span className="graph-node-title">{node.label}</span>
      </div>
    </div>
  );
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
