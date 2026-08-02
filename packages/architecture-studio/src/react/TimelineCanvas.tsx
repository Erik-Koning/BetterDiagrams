/**
 * TimelineCanvas.tsx — the read-only scrubbed view.
 *
 * Renders IN PLACE of the editor's <ReactFlow> element, with its own React
 * Flow instance, for the same reason DiffCanvas does: the editor DERIVES its
 * document from its canvas (`fromReactFlow(…, {base})`), so a canvas missing
 * everything dated after the scrub cursor would read as "the user deleted
 * them" and destroy half the diagram on the next commit. Keeping the scrubbed
 * view in a separate instance makes that impossible rather than merely
 * unlikely — the editor's nodes, refs, and history keep running untouched
 * behind it, and exiting timeline mode restores the diagram exactly.
 *
 * Provider visibility stays ON here, unlike compare mode: scrubbing a date
 * asks "what does this deployment look like in June", and the answer has to
 * respect which deployment is selected.
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
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  fromZoneNodeId,
  isZoneNodeId,
  templateBounds,
  toReactFlow,
  type DiagramTemplate,
} from "../contract/schema";
import { timelineView, type DiagramDate, type TimelineFutureMode } from "../contract/timeline";
import type { ResolvedRegistry } from "./registry-types";
import { NODE_TYPES } from "./nodes";
import { EDGE_TYPES } from "./edges";

export const TimelineCanvas = memo(function TimelineCanvas({
  template,
  at,
  mode,
  registry,
}: {
  template: DiagramTemplate;
  /** The scrub cursor. Everything dated after it is future. */
  at: DiagramDate | null;
  mode: TimelineFutureMode;
  registry: ResolvedRegistry;
}) {
  const { nodes, edges } = useMemo(() => {
    const view = timelineView(template, at, mode);
    const rf = toReactFlow(view.template, {
      containerKinds: registry.containerKinds,
      annotationKinds: registry.annotationKinds,
    });

    // Zones share the node array under a prefixed id, so the future sets —
    // keyed by DOCUMENT id — are consulted through the same prefix.
    const isFutureNode = (id: string) =>
      isZoneNodeId(id) ? view.future.zones.has(fromZoneNodeId(id)) : view.future.nodes.has(id);

    return {
      nodes: rf.nodes.map((n) =>
        isFutureNode(n.id) ? { ...n, className: "as-future" } : n,
      ) as unknown as Node[],
      edges: rf.edges.map((e) =>
        view.future.edges.has(e.id) ? { ...e, className: "as-future" } : e,
      ) as unknown as Edge[],
    };
  }, [template, at, mode, registry]);

  /**
   * Frame the WHOLE document once, on mount — not the current slice.
   *
   * `fitView` would frame whatever the first scrub position happens to show,
   * and everything revealed later would appear off-screen; re-fitting on each
   * step would pan the diagram under the cursor and destroy the comparison
   * between two dates. Fitting the full extent once means a box that appears
   * in June appears exactly where it will sit in September.
   */
  const bounds = useMemo(() => {
    const b = templateBounds(template);
    return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
  }, [template]);

  return (
    <div className="as-timelinecanvas">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          // Every handle is declared as a source (see ConnectHandles), so in
          // the default STRICT mode React Flow finds no target handle to
          // resolve an edge against and renders no connections at all.
          connectionMode={ConnectionMode.Loose}
          onInit={(instance: ReactFlowInstance) =>
            void instance.fitBounds(bounds, { padding: 0.15 })
          }
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
    </div>
  );
});
