// Node layout + reconciliation for the project-graph view, split out of
// `ProjectGraphPanel.tsx` so it's testable without React or a real
// `@xyflow/react` canvas.
//
// Why this exists: the panel holds its xyflow `nodes` in React state and
// must (a) lay fresh nodes into kind-specific lanes and (b) reconcile
// that state against the re-derived project graph *without discarding*
// the live `position` (drag) and `measured` (xyflow's measured size)
// each node accumulates. A node handed to xyflow without `measured` is
// treated as unmeasured — xyflow resets its handle bounds and routes
// edges through fallback `0×0` geometry, which breaks dragging and
// right-click hit-testing until an async re-measure lands.

import type { Node } from "@xyflow/react";

import type { GraphNode, GraphNodeKind } from "./projectGraph";

// Default lane x-positions for nodes that haven't been dragged yet.
// Buses sit in the middle as a horizontal spine; gateways feed in from
// the left, filters middle-right, sinks fan out further right. Plot and
// trace share the right lane.
const LANE_X: Record<GraphNodeKind, number> = {
  gateway: 0,
  transmit: 0,
  rbs: 0,
  bus: 360,
  filter: 760,
  plot: 1080,
  trace: 1080,
  signals: 1080,
};
const LANE_Y_OFFSET: Record<GraphNodeKind, number> = {
  gateway: 0, // top-left lane
  transmit: 400, // bottom-left lane, below the gateways
  rbs: 400, // transmit-side: it produces traffic too
  bus: 80,
  filter: 80,
  plot: 0, // sinks stack from the top of the right lane
  trace: 0,
  signals: 0,
};

/// Which lane-counter slot a node kind shares. Kinds reusing the same
/// `(LANE_X, LANE_Y_OFFSET)` must share a slot, or they'd both start
/// placing rows at index 0 and stack on top of one another (the bug
/// that first appeared once both trace and plot panels existed).
const LANE_SLOT: Record<GraphNodeKind, string> = {
  gateway: "left-top",
  transmit: "left-bottom",
  rbs: "left-bottom",
  bus: "middle",
  filter: "middle-right",
  plot: "right",
  trace: "right",
  signals: "right",
};

export const GRAPH_ROW_HEIGHT = 110;

/// Lay a set of graph nodes into their kind-specific lanes. Nodes
/// sharing a `LANE_SLOT` share a row counter so they stack instead of
/// colliding; `items` order decides row order within a lane.
export function assignLanePositions(
  items: readonly { id: string; kind: GraphNodeKind }[],
): Record<string, { x: number; y: number }> {
  const counts: Record<string, number> = {};
  const out: Record<string, { x: number; y: number }> = {};
  for (const item of items) {
    const slot = LANE_SLOT[item.kind];
    const row = counts[slot] ?? 0;
    counts[slot] = row + 1;
    out[item.id] = {
      x: LANE_X[item.kind],
      y: LANE_Y_OFFSET[item.kind] + row * GRAPH_ROW_HEIGHT,
    };
  }
  return out;
}

/// Reconcile the panel's live xyflow node state against a freshly
/// derived project graph.
///
/// - A node already present in `prev` keeps its live `position` (user
///   drags) and `measured` (xyflow's measured size); only its `data` /
///   `type` are refreshed from the new derivation. Preserving
///   `measured` is essential — see the module header.
/// - A node new to the derivation is lane-placed, or dropped at its
///   `savedPositions` entry if one was persisted for it.
/// - A node no longer in the derivation is dropped.
export function reconcileGraphNodes(
  derived: readonly GraphNode[],
  prev: readonly Node[],
  savedPositions: Record<string, { x: number; y: number }>,
): Node[] {
  const prevById = new Map(prev.map((n) => [n.id, n]));
  const lane = assignLanePositions(
    derived.map((n) => ({ id: n.id, kind: n.kind })),
  );
  return derived.map((n) => {
    const existing = prevById.get(n.id);
    if (existing) {
      return { ...existing, type: n.kind, data: { graph: n } };
    }
    return {
      id: n.id,
      type: n.kind,
      position: savedPositions[n.id] ?? lane[n.id],
      data: { graph: n },
    };
  });
}
