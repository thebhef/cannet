import { useCallback, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import {
  Background,
  Controls,
  type Edge,
  type EdgeChange,
  MarkerType,
  type Node,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
} from "@xyflow/react";
import type { Connection } from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import { useProjectContext } from "./projectContext";
import { useElementRegistry } from "./projectElements";
import type { InterfaceBinding, ProjectElement } from "./types";

/// Per-panel persisted state. Lives in the panel's dockview `params`
/// so each project graph panel keeps its own viewport and layout
/// across reloads.
interface GraphParams {
  /// `nodeId` -> `{x, y}`. `nodeId` is the same id the underlying
  /// element / bus / binding uses.
  positions?: Record<string, { x: number; y: number }>;
}

const NODE_DEFAULTS = {
  binding: { x: 0, y: 0 },
  bus: { x: 320, y: 0 },
  filter: { x: 640, y: 0 },
  consumer: { x: 960, y: 0 },
} as const;

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;

/// Phase-6 project graph view: interfaces, buses, filters, and
/// consumers (`trace` / `plot` / `transmit`) as nodes, edges showing
/// data flow. Backed by `@xyflow/react`. Viewport and node positions
/// persist in the panel's `params`; the rest of the state lives in
/// the project (buses + bindings + element list + filter sources).
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
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(
    initial.positions ?? {},
  );

  const persistPositions = useCallback(
    (next: Record<string, { x: number; y: number }>) => {
      setPositions(next);
      props.api.updateParameters({ ...(props.params ?? {}), positions: next });
    },
    [props.api, props.params],
  );

  // Build the live node set from project state. Auto-layout in lanes
  // for nodes whose position isn't yet recorded.
  const nodes: Node[] = useMemo(() => {
    const list: Node[] = [];
    const counts = { binding: 0, bus: 0, filter: 0, consumer: 0 };
    const lane = (kind: keyof typeof NODE_DEFAULTS) => {
      const base = NODE_DEFAULTS[kind];
      const y = base.y + counts[kind] * (NODE_HEIGHT + 30);
      counts[kind] += 1;
      return { x: base.x, y };
    };
    const place = (id: string, kind: keyof typeof NODE_DEFAULTS) =>
      positions[id] ?? lane(kind);

    for (const b of project.interfaceBindings) {
      const id = bindingNodeId(b);
      list.push({
        id,
        type: "default",
        position: place(id, "binding"),
        data: { label: bindingLabel(b) },
        style: { width: NODE_WIDTH, background: "#1f2937", color: "#e2e8f0" },
      });
    }
    for (const bus of project.buses) {
      const id = busNodeId(bus.id);
      list.push({
        id,
        type: "default",
        position: place(id, "bus"),
        data: { label: `Bus: ${bus.name}` },
        style: { width: NODE_WIDTH, background: "#1e3a8a", color: "#e2e8f0" },
      });
    }
    for (const e of registry.entries) {
      if (e.element.kind === "filter") {
        const id = elementNodeId(e.element.id);
        list.push({
          id,
          type: "default",
          position: place(id, "filter"),
          data: { label: `Filter: ${filterLabel(e.element)}` },
          style: { width: NODE_WIDTH, background: "#3f3f46", color: "#e2e8f0" },
        });
      } else {
        const id = elementNodeId(e.element.id);
        list.push({
          id,
          type: "default",
          position: place(id, "consumer"),
          data: { label: `${capitalise(e.element.kind)}: ${e.element.id.slice(0, 6)}` },
          style: { width: NODE_WIDTH, background: "#065f46", color: "#e2e8f0" },
        });
      }
    }
    return list;
  }, [project.buses, project.interfaceBindings, registry.entries, positions]);

  // Edges encode the routing story.
  const edges: Edge[] = useMemo(() => {
    const list: Edge[] = [];
    for (const b of project.interfaceBindings) {
      list.push({
        id: `e:${bindingNodeId(b)}->${busNodeId(b.bus_id)}`,
        source: bindingNodeId(b),
        target: busNodeId(b.bus_id),
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }
    for (const e of registry.entries) {
      const src = (e.element as { source?: string | null }).source;
      if (!src) continue;
      const sourceNode = project.buses.some((b) => b.id === src)
        ? busNodeId(src)
        : elementNodeId(src);
      list.push({
        id: `e:${sourceNode}->${elementNodeId(e.element.id)}`,
        source: sourceNode,
        target: elementNodeId(e.element.id),
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }
    return list;
  }, [project.interfaceBindings, project.buses, registry.entries]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Persist position drags.
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
      // Drops the edge from the displayed list immediately; we re-derive
      // from project state on next render, so this is also a chance to
      // commit a delete to the underlying element.
      for (const c of changes) {
        if (c.type === "remove") {
          const e = edges.find((x) => x.id === c.id);
          if (e) handleEdgeRemove(e);
        }
      }
      // (xyflow expects us to call applyEdgeChanges to keep state in sync
      //  if we were storing edges as React state; here we re-derive, so
      //  no setState is needed.)
      applyEdgeChanges(changes, edges);
    },
    [edges],
  );

  // Removing an edge means clearing the underlying source pointer
  // (consumer.source = null) or removing the interface binding.
  const handleEdgeRemove = useCallback(
    (edge: Edge) => {
      // Target is either a consumer element or a bus.
      const consumer = registry.entries.find(
        (e) => elementNodeId(e.element.id) === edge.target,
      );
      if (consumer) {
        // Clearing a source is registry-only and doesn't ship in the
        // base ElementRegistry. The graph panel currently only renders
        // the source pointer; clearing it ships in a follow-up commit
        // when ElementRegistry grows a `setSource` op.
        return;
      }
    },
    [registry.entries],
  );

  const onConnect = useCallback(
    (params: Connection) => {
      // Wiring an edge: source -> target.
      // - bus -> consumer (trace/plot/filter): set consumer.source = bus_id.
      // - filter -> consumer: set consumer.source = filter_id.
      // - binding -> bus is structural; the user creates / removes
      //   bindings from the project panel, not by drag here.
      if (!params.source || !params.target) return;
      addEdge(params, edges); // shape check only; we re-derive
    },
    [edges],
  );

  if (project.buses.length === 0 && project.interfaceBindings.length === 0 &&
      registry.entries.length === 0) {
    return (
      <div className="graph-empty">
        <p>No project elements yet.</p>
        <p>
          Add a bus from the project panel and an element from the
          toolbar to start wiring.
        </p>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function bindingNodeId(b: InterfaceBinding): string {
  return `binding:${b.server}::${b.interface}`;
}

function busNodeId(busId: string): string {
  return `bus:${busId}`;
}

function elementNodeId(id: string): string {
  return `el:${id}`;
}

function bindingLabel(b: InterfaceBinding): string {
  const host = b.server.replace(/^.*[:/]/, "");
  return `If: ${b.interface} (${host || b.server})`;
}

function filterLabel(el: ProjectElement & { kind: "filter" }): string {
  return el.name && el.name.length > 0 ? el.name : el.id.slice(0, 6);
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
