/**
 * MessageEdge.tsx — a horizontal message arrow at a time row.
 *
 * The path ignores React Flow's handle geometry entirely: it runs between the
 * two participants' lifeline x positions at `data.y` (the LabeledEdge
 * approach). Vertical dragging reorders time: a transparent strip rendered
 * through EdgeLabelRenderer (ABOVE the node layer, so nothing steals the
 * gesture) patches `data.y` live; releasing commits, and the commit path
 * sorts messages by y and renormalizes the rows.
 */
import { memo, useCallback } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  useInternalNode,
  useReactFlow,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useSequence } from "./context";
import type { SeqMessage } from "../../contract/sequence";
import { formatDiagramDate } from "../../contract/timeline";
import { BAR_W, HEADER_W, SELF_LOOP_W } from "../../contract/sequence-layout";

export type MessageEdgeType = Edge<
  { message: SeqMessage; index: number; y: number; future?: boolean },
  "message"
>;

/** How far a lost/found stub extends from its one known lifeline. */
const STUB = 90;

export const MessageEdge = memo(function MessageEdge({
  id,
  source,
  target,
  selected,
  data,
}: EdgeProps<MessageEdgeType>) {
  const { readOnly, autonumber, requestCommit } = useSequence();
  const { setEdges, screenToFlowPosition } = useReactFlow();
  const s = useInternalNode(source);
  const t = useInternalNode(target);

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (readOnly) return;
      event.stopPropagation();
      const strip = event.currentTarget;
      strip.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent) => {
        const y = screenToFlowPosition({ x: e.clientX, y: e.clientY }).y;
        setEdges((edges) =>
          edges.map((edge) =>
            edge.id === id ? { ...edge, data: { ...edge.data, y } } : edge,
          ),
        );
      };
      const up = () => {
        strip.releasePointerCapture(event.pointerId);
        strip.removeEventListener("pointermove", move as EventListener);
        strip.removeEventListener("pointerup", up);
        requestCommit();
      };
      strip.addEventListener("pointermove", move as EventListener);
      strip.addEventListener("pointerup", up);
    },
    [readOnly, id, setEdges, screenToFlowPosition, requestCommit],
  );

  if (!s || !t || !data) return null;
  const m = data.message;
  const y = data.y;
  const sx = s.internals.positionAbsolute.x + HEADER_W / 2;
  const tx = t.internals.positionAbsolute.x + HEADER_W / 2;

  const open = m.style !== "sync";
  const dashArray = m.style === "sync" ? undefined : m.style === "async" ? "7 5" : "4 4";
  const number = autonumber ? `${data.index + 1}. ` : "";
  const labelText = `${number}${m.label}`.trim();

  const isSelf = m.from !== null && m.from === m.to;
  // Lost/found stubs: one real endpoint, the other floats in the environment.
  const x1 = m.from !== null ? sx : tx - STUB;
  const x2 = m.to !== null ? (isSelf ? sx : tx) : sx + STUB;

  const path = isSelf
    ? `M ${sx + BAR_W / 2} ${y - 10} h ${SELF_LOOP_W - 14} v 20 h ${-(SELF_LOOP_W - 14)}`
    : `M ${x1} ${y} H ${x2}`;

  const dir = isSelf ? -1 : x2 > x1 ? 1 : -1;
  const tipX = isSelf ? sx + BAR_W / 2 + 1 : x2;
  const tipY = isSelf ? y + 10 : y;

  const labelX = isSelf ? sx + BAR_W / 2 + 12 : (x1 + x2) / 2;
  const stripW = Math.max(Math.abs(x2 - x1), SELF_LOOP_W + 40);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={`as-seq-msg__line${selected ? " as-edge__stroke--selected" : ""}`}
        style={{ strokeDasharray: dashArray }}
        interactionWidth={14}
      />
      {open ? (
        <path
          className="as-seq-msg__arrow-open"
          d={`M ${tipX - 9 * dir} ${tipY - 4.5} L ${tipX} ${tipY} L ${tipX - 9 * dir} ${tipY + 4.5}`}
          style={{ pointerEvents: "none" }}
        />
      ) : (
        <polygon
          className="as-seq-msg__arrow"
          points="0,-4.5 9,0 0,4.5"
          transform={`translate(${tipX} ${tipY})${dir === -1 ? " rotate(180)" : ""}`}
          style={{ pointerEvents: "none" }}
        />
      )}
      {m.from === null ? <circle className="as-seq-msg__dot" cx={x1} cy={y} r={4} /> : null}
      {m.to === null ? <circle className="as-seq-msg__dot" cx={x2} cy={y} r={4} /> : null}

      <EdgeLabelRenderer>
        <div
          className={`as-seq-msg__label${selected ? " as-seq-msg__label--selected" : ""}${readOnly ? "" : " nodrag"}${data.future ? " as-future" : ""}`}
          style={{
            transform: isSelf
              ? `translate(0, -100%) translate(${labelX}px, ${y - 12}px)`
              : `translate(-50%, -100%) translate(${labelX}px, ${y - 4}px)`,
            cursor: readOnly ? "default" : "ns-resize",
            width: isSelf ? undefined : Math.max(60, stripW - 40),
          }}
          onPointerDown={startDrag}
          title={readOnly ? undefined : "Drag up or down to reorder this message in time"}
        >
          <span className="as-seq-msg__text">{labelText || "​"}</span>
          {m.tech ? <span className="as-seq-msg__tech">[{m.tech}]</span> : null}
          {m.date ? (
            <span className="as-date as-date--inline" title={formatDiagramDate(m.date, { year: "always" })}>
              {formatDiagramDate(m.date)}
            </span>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

export const SEQUENCE_EDGE_TYPES = { message: MessageEdge };
