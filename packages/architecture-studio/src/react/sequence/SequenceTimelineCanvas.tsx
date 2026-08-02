/**
 * SequenceTimelineCanvas.tsx — the scrubbed sequence view.
 *
 * The architecture editor needs its own React Flow instance for scrubbing
 * because a missing node reads as a deletion. The sequence editor's inverse
 * adapter is TOTAL, which makes the danger worse rather than better: a
 * filtered canvas would derive a document with those participants and messages
 * simply gone. So the same isolation applies here — a separate, read-only
 * instance the commit path never sees.
 *
 * In "hide" mode the rows genuinely renumber, because a sequence diagram has
 * no coordinates: time is array order, so a flow with two of its five steps
 * not yet built is a three-step flow, drawn as one.
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
  sequenceTimelineView,
  type DiagramDate,
  type TimelineFutureMode,
} from "../../contract/timeline";
import {
  ACT_ID_PREFIX,
  FRAG_ID_PREFIX,
  NOTE_ID_PREFIX,
  toSequenceFlow,
  type SeqRFEdge,
  type SeqRFNode,
  type SequenceTemplate,
} from "../../contract/sequence";
import { SequenceContext, type SequenceContextValue } from "./context";
import { SEQUENCE_NODE_TYPES } from "./SequenceNodes";
import { SEQUENCE_EDGE_TYPES } from "./MessageEdge";

/** Read-only, and the gesture callbacks can never fire from this canvas. */
const SCRUB_CONTEXT_BASE = {
  readOnly: true as const,
  requestCommit: () => {},
  commitSpanGeometry: () => {},
};

export const SequenceTimelineCanvas = memo(function SequenceTimelineCanvas({
  template,
  at,
  mode,
}: {
  template: SequenceTemplate;
  at: DiagramDate | null;
  mode: TimelineFutureMode;
}) {
  const { nodes, edges } = useMemo(() => {
    const view = sequenceTimelineView(template, at, mode);
    const rf = toSequenceFlow(view.template);

    // Each family lives in the same node array under its own id prefix, so the
    // future sets — keyed by DOCUMENT id — are consulted through that prefix.
    // Bars, frames, and notes matter as much as the participants here: they
    // are what a message row is wrapped in, and one of them left bright over a
    // faded message reads as "this part is happening" when it is not.
    const futureNode = (n: SeqRFNode) => {
      switch (n.type) {
        case "participant":
          return view.future.participants.has(n.id);
        case "activation":
          return view.future.activations.has(n.id.slice(ACT_ID_PREFIX.length));
        case "fragment":
          return view.future.fragments.has(n.id.slice(FRAG_ID_PREFIX.length));
        case "seqnote":
          return view.future.notes.has(n.id.slice(NOTE_ID_PREFIX.length));
        default:
          return false;
      }
    };

    return {
      nodes: rf.nodes.map((n) =>
        futureNode(n) ? { ...n, className: "as-future" } : n,
      ) as unknown as Node[],
      edges: rf.edges.map((e: SeqRFEdge) =>
        view.future.messages.has(e.id)
          ? // The label renders through a portal, so the wrapper class alone
            // would leave it bright — see SeqRFEdge.data.future.
            { ...e, className: "as-future", data: { ...e.data, future: true } }
          : e,
      ) as unknown as Edge[],
    };
  }, [template, at, mode]);

  const context = useMemo<SequenceContextValue>(
    () => ({ ...SCRUB_CONTEXT_BASE, autonumber: template.meta?.autonumber === true }),
    [template.meta?.autonumber],
  );

  return (
    <div className="as-timelinecanvas">
      <SequenceContext.Provider value={context}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={SEQUENCE_NODE_TYPES}
            edgeTypes={SEQUENCE_EDGE_TYPES}
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
      </SequenceContext.Provider>
    </div>
  );
});
