/**
 * DiffCanvas.tsx — the read-only Compare view.
 *
 * Renders IN PLACE of the editor's <ReactFlow> element only, with its own
 * React Flow instance, and never writes to the editor's state. That isolation
 * is the whole design: the editor derives its document from ITS canvas via
 * `fromReactFlow(…, {base})`, so injecting removed elements into the editor's
 * canvas would re-derive them as *newly added* nodes and corrupt the document
 * without a single commit. Here the overlay lives and dies in this component;
 * the editor's nodes, refs, and history keep running untouched behind it.
 *
 * The overlay is `current` plus everything `base` had that `current` no
 * longer does, so removals render ghosted in place. Provider visibility is
 * deliberately OFF (`applyVisibility: false`): compare mode diffs documents,
 * not provider views. Collapse flags are stripped for the same reason —
 * nothing may hide.
 */
import { memo, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
} from "@xyflow/react";
import {
  EDGE_Z_INDEX,
  toReactFlow,
  toZoneNodeId,
  type DiagramNode,
  type DiagramTemplate,
} from "../contract/schema";
import type { DiffState, TemplateDiff } from "../contract/diff";
import { NODE_TYPES } from "./nodes";
import { EDGE_TYPES } from "./edges";
import { StudioContext, useStudio } from "./context";

// Stable identity — React Flow stores this object. Same layering as the
// editor's canvas: edges under every node (see EDGE_Z_INDEX).
const DEFAULT_EDGE_OPTIONS = { zIndex: EDGE_Z_INDEX };

/** Overlay = current document + base's removed elements, renderable as one. */
function buildOverlay(
  base: DiagramTemplate,
  current: DiagramTemplate,
  diff: TemplateDiff,
): DiagramTemplate {
  const removedNodeIds = new Set(diff.nodes.removed);
  const overlayNodeIds = new Set([...current.nodes.map((n) => n.id), ...removedNodeIds]);
  const baseById = new Map(base.nodes.map((n) => [n.id, n]));

  // Positions are parent-relative. A removed node whose parent is ALSO gone
  // from the overlay must be re-anchored at its absolute spot (validation
  // nulls a dangling parentId but does not convert the coordinates).
  const absolute = (n: DiagramNode) => {
    let x = n.x;
    let y = n.y;
    let parentId = n.parentId;
    while (parentId) {
      const parent = baseById.get(parentId);
      if (!parent) break;
      x += parent.x;
      y += parent.y;
      parentId = parent.parentId;
    }
    return { x, y };
  };

  const stripCollapse = ({ collapsed: _collapsed, ...rest }: DiagramNode) => rest;

  const removedNodes = base.nodes
    .filter((n) => removedNodeIds.has(n.id))
    .map((n) => {
      const clean = stripCollapse(n);
      if (n.parentId && !overlayNodeIds.has(n.parentId)) {
        return { ...clean, parentId: null, ...absolute(n) };
      }
      return clean;
    });

  const removedEdges = base.edges
    .filter((e) => diff.edges.removed.includes(e.id))
    .filter((e) => overlayNodeIds.has(e.source) && overlayNodeIds.has(e.target));
  const removedZones = (base.zones ?? []).filter((z) => diff.zones.removed.includes(z.id));

  return {
    ...current,
    nodes: [...current.nodes.map(stripCollapse), ...removedNodes],
    edges: [...current.edges, ...removedEdges],
    zones: [...(current.zones ?? []), ...removedZones],
  };
}

export const DiffCanvas = memo(function DiffCanvas({
  base,
  current,
  diff,
}: {
  base: DiagramTemplate;
  current: DiagramTemplate;
  diff: TemplateDiff;
}) {
  // The studio's context, re-provided read-only. `elementsSelectable={false}`
  // already hides the selection affordances, but the edge's shaping gestures
  // (drag-to-bend, double-click) don't require selection — without this they
  // would inherit the EDITOR's readOnly and let a compare overlay be bent.
  const studio = useStudio();
  const readOnlyStudio = useMemo(() => ({ ...studio, readOnly: true }), [studio]);

  const { nodes, edges } = useMemo(() => {
    const overlay = buildOverlay(base, current, diff);
    const rf = toReactFlow(overlay, { applyVisibility: false });

    const nodeState = new Map<string, DiffState>();
    for (const id of diff.nodes.added) nodeState.set(id, "added");
    for (const id of diff.nodes.removed) nodeState.set(id, "removed");
    for (const c of diff.nodes.changed) nodeState.set(c.id, "changed");
    for (const id of diff.zones.added) nodeState.set(toZoneNodeId(id), "added");
    for (const id of diff.zones.removed) nodeState.set(toZoneNodeId(id), "removed");
    for (const c of diff.zones.changed) nodeState.set(toZoneNodeId(c.id), "changed");

    const edgeState = new Map<string, DiffState>();
    for (const id of diff.edges.added) edgeState.set(id, "added");
    for (const id of diff.edges.removed) edgeState.set(id, "removed");
    for (const c of diff.edges.changed) edgeState.set(c.id, "changed");

    return {
      nodes: rf.nodes.map((n) => {
        const state = nodeState.get(n.id);
        return state ? { ...n, className: `as-diff--${state}` } : n;
      }) as unknown as Node[],
      edges: rf.edges.map((e) => {
        const state = edgeState.get(e.id);
        return state ? { ...e, data: { ...e.data, diffState: state } } : e;
      }) as unknown as Edge[],
    };
  }, [base, current, diff]);

  return (
    <div className="as-diffcanvas">
      <StudioContext.Provider value={readOnlyStudio}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          // Same z policy as the editor: honour per-element zIndex so edges
          // stay in their own band under the nodes (see EDGE_Z_INDEX).
          zIndexMode="manual"
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          // Every handle is declared as a source (see ConnectHandles), so in the
          // default STRICT mode React Flow finds no target handle to resolve an
          // edge against and renders no connections at all.
          connectionMode={ConnectionMode.Loose}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.1}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--as-grid-dot)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
      </StudioContext.Provider>
    </div>
  );
});
