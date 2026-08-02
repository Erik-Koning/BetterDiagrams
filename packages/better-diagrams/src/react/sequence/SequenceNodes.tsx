/**
 * SequenceNodes.tsx — the sequence renderers: participant headers (with the
 * lifeline and the press-drag bar-creation strip), activation bars, fragment
 * frames, and notes.
 *
 * The lifeline lives INSIDE the participant node as an absolutely-positioned
 * overflow child, so it moves with its column for free — and because
 * absolutely-positioned children don't contribute to offsetHeight, React Flow
 * measures just the header.
 */
import { memo, useCallback, useRef, useState } from "react";
import {
  NodeResizer,
  useInternalNode,
  useReactFlow,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useSequence } from "./context";
import { ConnectHandles } from "../nodes";
import { DateChip } from "../chrome";
import { teamColor } from "../shapes";
import { SEQ_KIND_ACCENT } from "../sequence-draw";
import type {
  SeqActivation,
  SeqFragment,
  SeqMessage,
  SeqNote,
  SeqParticipant,
} from "../../contract/sequence";
import { ACT_ID_PREFIX } from "../../contract/sequence";
import {
  BAR_W,
  HEADER_H,
  HEADER_W,
  MIN_BAR_H,
  messageRowAt,
} from "../../contract/sequence-layout";

let barCounter = 0;

// ─── Participant ─────────────────────────────────────────────────────────────

export type ParticipantNodeType = Node<
  { participant: SeqParticipant; order: number; diagramHeight: number },
  "participant"
>;

export const ParticipantNode = memo(function ParticipantNode({
  id,
  data,
  selected,
}: NodeProps<ParticipantNodeType>) {
  const { readOnly, commitSpanGeometry } = useSequence();
  const { setNodes, screenToFlowPosition } = useReactFlow();
  const p = data.participant;
  const accent = SEQ_KIND_ACCENT[p.kind] ?? "#64748b";

  /**
   * Press on the lifeline creates an activation bar at that row and, while
   * still holding, drags its extent — release anchors it to the covered
   * message rows (the polygon editor's press-drag recipe).
   */
  const startBar = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (readOnly) return;
      event.stopPropagation();
      const strip = event.currentTarget;
      const startY = screenToFlowPosition({ x: event.clientX, y: event.clientY }).y;
      const barId = `${ACT_ID_PREFIX}bar_${Date.now().toString(36)}${(barCounter++).toString(36)}`;

      // The document object is a stub until the gesture ends —
      // commitSpanGeometry rewrites the anchors before anything persists.
      setNodes((nodes) => [
        ...nodes,
        {
          id: barId,
          type: "activation" as const,
          position: { x: (HEADER_W - BAR_W) / 2, y: startY },
          width: BAR_W,
          height: MIN_BAR_H,
          style: { width: BAR_W, height: MIN_BAR_H },
          parentId: id,
          zIndex: 600,
          data: { activation: { id: barId.slice(ACT_ID_PREFIX.length), participant: id, from: "" } },
        },
      ]);

      strip.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent) => {
        const y = screenToFlowPosition({ x: e.clientX, y: e.clientY }).y;
        const top = Math.min(startY, y);
        const height = Math.max(MIN_BAR_H, Math.abs(y - startY));
        setNodes((nodes) =>
          nodes.map((n) =>
            n.id === barId
              ? { ...n, position: { ...n.position, y: top }, height, style: { ...n.style, width: BAR_W, height } }
              : n,
          ),
        );
      };
      const up = () => {
        strip.releasePointerCapture(event.pointerId);
        strip.removeEventListener("pointermove", move as EventListener);
        strip.removeEventListener("pointerup", up);
        commitSpanGeometry(barId);
      };
      strip.addEventListener("pointermove", move as EventListener);
      strip.addEventListener("pointerup", up);
    },
    [readOnly, id, setNodes, screenToFlowPosition, commitSpanGeometry],
  );

  return (
    <>
      <ConnectHandles hidden={readOnly} />
      <div
        className={`as-seq-head${selected ? " as-seq-head--selected" : ""}${p.status ? ` as-node--status-${p.status}` : ""}`}
        style={{ "--as-seq-accent": accent } as CSSProperties}
      >
        <div className="as-seq-head__body">
          <div className="as-seq-head__kind">
            {p.kind}
            {p.status ? <span className="as-node__status"> · {p.status}</span> : null}
            <DateChip date={p.date} inline prefix="Joins" />
          </div>
          <div
            className="as-seq-head__label"
            title={p.description ? `${p.label} — ${p.description}` : p.label}
          >
            {p.label}
          </div>
        </div>
        {p.team ? (
          <span
            className="as-node__team"
            style={{ "--as-team-color": teamColor(p.team) } as CSSProperties}
            title={`Owned by ${p.team}`}
          >
            {p.team}
          </span>
        ) : null}
      </div>

      {/* The lifeline: a dashed spine plus a narrow interactive strip. */}
      <div
        className="as-seq-lifeline"
        style={{ top: HEADER_H, height: Math.max(0, data.diagramHeight - HEADER_H) }}
      >
        <div className="as-seq-lifeline__line" aria-hidden="true" />
        {!readOnly ? (
          <div
            className="as-seq-lifeline__hit nodrag"
            onPointerDown={startBar}
            title="Press and drag to add an activation bar"
          />
        ) : null}
      </div>
    </>
  );
});

// ─── Activation bar ──────────────────────────────────────────────────────────

export type ActivationNodeType = Node<{ activation: SeqActivation }, "activation">;

export const ActivationBarNode = memo(function ActivationBarNode({
  id,
  data,
  selected,
}: NodeProps<ActivationNodeType>) {
  const { readOnly, commitSpanGeometry } = useSequence();
  // The bar tints like its participant, matching the image exporter.
  const parent = useInternalNode(data.activation.participant);
  const kind = (parent?.data as { participant?: SeqParticipant } | undefined)?.participant?.kind;
  const accent = SEQ_KIND_ACCENT[kind ?? "service"] ?? SEQ_KIND_ACCENT.service;
  return (
    <>
      <NodeResizer
        isVisible={!!selected && !readOnly}
        minWidth={BAR_W}
        maxWidth={BAR_W}
        minHeight={MIN_BAR_H}
        onResizeEnd={() => commitSpanGeometry(id)}
      />
      <div
        className={`as-seq-bar${selected ? " as-seq-bar--selected" : ""}`}
        style={{ "--as-seq-accent": accent } as CSSProperties}
        title="Activation"
      />
    </>
  );
});

// ─── Fragment frame ──────────────────────────────────────────────────────────

export type FragmentNodeType = Node<
  { fragment: SeqFragment; elseOffsets: Array<{ label: string; at: string; dy: number }> },
  "fragment"
>;

export const FragmentNode = memo(function FragmentNode({
  id,
  data,
  selected,
  positionAbsoluteY,
}: NodeProps<FragmentNodeType>) {
  const { readOnly, commitSpanGeometry, requestCommit } = useSequence();
  const { getEdges, setNodes, screenToFlowPosition } = useReactFlow();
  const frag = data.fragment;

  /** Drag a branch divider to another message row inside the span. */
  const startDividerDrag = useCallback(
    (branchAt: string) => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (readOnly) return;
      event.stopPropagation();
      const el = event.currentTarget;
      el.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent) => {
        const y = screenToFlowPosition({ x: e.clientX, y: e.clientY }).y;
        el.style.top = `${y - positionAbsoluteY}px`;
      };
      const up = (e: PointerEvent) => {
        el.releasePointerCapture(event.pointerId);
        el.removeEventListener("pointermove", move as EventListener);
        el.removeEventListener("pointerup", up as EventListener);
        el.style.top = "";
        const y = screenToFlowPosition({ x: e.clientX, y: e.clientY }).y;
        const rows = [...getEdges()].sort(
          (a, b) => ((a.data?.y as number) ?? 0) - ((b.data?.y as number) ?? 0),
        );
        const rowId = (i: number) => (rows[i]?.data as { message: SeqMessage })?.message.id;
        const index = new Map(rows.map((_r, i) => [rowId(i), i]));
        const fromIdx = index.get(frag.from) ?? 0;
        const toIdx = index.get(frag.to) ?? fromIdx;
        // A divider lives strictly inside (from .. to].
        const target = Math.max(fromIdx + 1, Math.min(toIdx, messageRowAt(y + 20)));
        const at = rowId(target);
        if (!at) return;
        setNodes((cur) =>
          cur.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    fragment: {
                      ...frag,
                      elses: (frag.elses ?? []).map((b) => (b.at === branchAt ? { ...b, at } : b)),
                    },
                  },
                }
              : n,
          ),
        );
        requestCommit();
      };
      el.addEventListener("pointermove", move as EventListener);
      el.addEventListener("pointerup", up as EventListener);
    },
    [readOnly, id, frag, positionAbsoluteY, getEdges, setNodes, screenToFlowPosition, requestCommit],
  );

  return (
    <>
      <NodeResizer
        isVisible={!!selected && !readOnly}
        minHeight={40}
        onResizeEnd={() => commitSpanGeometry(id)}
      />
      <div className={`as-seq-frag${selected ? " as-seq-frag--selected" : ""}`}>
        <div className="as-seq-frag__head">
          <span className="as-seq-frag__tab">{frag.kind}</span>
          {frag.label ? <span className="as-seq-frag__guard">[{frag.label}]</span> : null}
        </div>
        {data.elseOffsets.map((branch) => (
          <div
            key={branch.at}
            className={`as-seq-frag__else${readOnly ? "" : " nodrag"}`}
            style={{ top: branch.dy }}
            onPointerDown={readOnly ? undefined : startDividerDrag(branch.at)}
            title={readOnly ? undefined : "Drag to move this branch to another row"}
          >
            <span className="as-seq-frag__guard">[{branch.label || "else"}]</span>
          </div>
        ))}
      </div>
    </>
  );
});

// ─── Note ────────────────────────────────────────────────────────────────────

export type SeqNoteNodeType = Node<{ note: SeqNote }, "seqnote">;

export const SeqNoteNode = memo(function SeqNoteNode({
  id,
  data,
  selected,
}: NodeProps<SeqNoteNodeType>) {
  const { readOnly, requestCommit } = useSequence();
  const { updateNodeData } = useReactFlow();
  const [editing, setEditing] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const note = data.note;

  const stopEditing = useCallback(() => {
    setEditing(false);
    requestCommit();
  }, [requestCommit]);

  return (
    <div
      className={`as-seq-note${selected ? " as-seq-note--selected" : ""}`}
      onDoubleClick={readOnly ? undefined : () => setEditing(true)}
      title={readOnly ? undefined : "Double-click to edit"}
    >
      {editing && !readOnly ? (
        <textarea
          ref={areaRef}
          className="as-seq-note__input nodrag"
          value={note.text}
          autoFocus
          onChange={(event) =>
            updateNodeData(id, { note: { ...note, text: event.target.value } })
          }
          onBlur={stopEditing}
          onKeyDown={(event) => {
            if (event.key === "Escape") stopEditing();
            event.stopPropagation();
          }}
        />
      ) : (
        note.text || "…"
      )}
    </div>
  );
});

export const SEQUENCE_NODE_TYPES = {
  participant: ParticipantNode,
  activation: ActivationBarNode,
  fragment: FragmentNode,
  seqnote: SeqNoteNode,
};
