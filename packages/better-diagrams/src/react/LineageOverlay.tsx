/**
 * LineageOverlay.tsx — column lineage drawn over the canvas, row to row.
 *
 * Lineage is not a relationship, so it never becomes an edge: these lines
 * are a display pass in flow coordinates (React Flow's viewport portal),
 * from the row a value comes from to the row it is written to, placed with
 * the same row maths foreign-key lines use (`fieldRowT`). A column the table
 * does not draw as a row anchors at the table's middle, and so does a table
 * folded into a chip or a level down — at the middle of what stands for it.
 * Pointer events pass through; the panel is where the reader acts.
 */
import { useInternalNode, ViewportPortal } from "@xyflow/react";
import type { FieldRef } from "../contract/fields";
import { fieldRowT, type NodeField } from "../contract/schema";
import { documentNodeId } from "./path-view";

export interface OverlayLink {
  id: string;
  from: FieldRef;
  to: FieldRef;
  /** Drawn bright (the chain to the column under the pointer). */
  emphasis?: boolean;
}

/**
 * Where a column sits on this canvas: its row on its table's card, or —
 * when the table is folded into a chip or lives a level down — the middle
 * of whatever stands for it, as the paths and the HTML export do.
 */
function useRowPoint(ref: FieldRef, canvasId: string | undefined) {
  const node = useInternalNode(canvasId ?? "");
  if (!canvasId || !node || node.hidden) return null;
  const { x, y } = node.internals.positionAbsolute;
  const w = node.measured?.width ?? node.width ?? 0;
  const h = node.measured?.height ?? node.height ?? 0;
  const own = documentNodeId(canvasId) === ref.nodeId;
  const data = node.data as { fields?: readonly NodeField[]; description?: string } | undefined;
  const t = own ? (fieldRowT({ ...(data?.fields ? { fields: data.fields } : {}), ...(data?.description ? { description: data.description } : {}), h }, ref.fieldId) ?? 0.5) : 0.5;
  return { x, y: y + t * h, w };
}

function LineageLine({ link, reps }: { link: OverlayLink; reps: ReadonlyMap<string, string> | null }) {
  const fromCanvas = reps ? reps.get(link.from.nodeId) : link.from.nodeId;
  const toCanvas = reps ? reps.get(link.to.nodeId) : link.to.nodeId;
  const a = useRowPoint(link.from, fromCanvas);
  const b = useRowPoint(link.to, toCanvas);
  // Both ends folded into one chip: nothing to draw between them.
  if (!a || !b || (fromCanvas === toCanvas && documentNodeId(fromCanvas!) !== link.from.nodeId)) return null;
  // Leave through the face looking at the other table.
  const rightward = b.x + b.w / 2 >= a.x + a.w / 2;
  const x1 = rightward ? a.x + a.w : a.x;
  const x2 = rightward ? b.x : b.x + b.w;
  const bend = Math.max(40, Math.abs(x2 - x1) / 2) * (rightward ? 1 : -1);
  return (
    <path
      className={`as-lineage__line${link.emphasis ? " as-lineage__line--on" : ""}`}
      data-lineage={link.id}
      d={`M ${x1} ${a.y} C ${x1 + bend} ${a.y}, ${x2 - bend} ${b.y}, ${x2} ${b.y}`}
      markerEnd="url(#as-lineage-arrow)"
    />
  );
}

/**
 * `reps` maps a table to the canvas node standing for it (`representatives`);
 * without it, a table draws only when it is on the canvas itself.
 */
export function LineageOverlay({ links, reps = null }: { links: readonly OverlayLink[]; reps?: ReadonlyMap<string, string> | null }) {
  if (!links.length) return null;
  return (
    <ViewportPortal>
      <svg className="as-lineage" aria-hidden="true">
        <defs>
          <marker id="as-lineage-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="as-lineage__arrow" />
          </marker>
        </defs>
        {links.map((l) => (
          <LineageLine key={l.id} link={l} reps={reps} />
        ))}
      </svg>
    </ViewportPortal>
  );
}
