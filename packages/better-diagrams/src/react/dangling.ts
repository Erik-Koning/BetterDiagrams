/**
 * dangling.ts — where a loose connection may land.
 *
 * Two gestures end with "the pointer is over the canvas, holding a line":
 * dragging a NEW connection out of a handle (ArchitectureStudio's
 * onConnectEnd) and dragging an EXISTING edge's endpoint (edges.tsx). Both
 * must agree on what sits under the pointer — the visually topmost node an
 * edge may attach to — or the same drop would connect in one gesture and
 * dangle in the other. This module is that shared judgement.
 */
import { isBoundaryNodeId, isGhostNodeId } from "../contract/schema";

/** The slice of a React Flow instance the hit-test needs. */
export interface DropProbeFlow {
  getNodes(): Array<{ id: string; type?: string; zIndex?: number }>;
  getInternalNode(id: string):
    | {
        internals: { positionAbsolute: { x: number; y: number } };
        measured?: { width?: number | null; height?: number | null };
      }
    | undefined;
}

/**
 * The VISUALLY topmost node under a canvas point that an edge may attach to:
 * highest zIndex wins (the canvas paints leaf nodes at LEAF_Z_INDEX+ over
 * containers at their depth, and lifts a node sitting inside another by a
 * whole STACK_BAND), later entry on a tie — children follow their parents in
 * the array. Reading the same z the eye does is what makes a drop land on the
 * card on top rather than the one it covers. Zones and view artifacts
 * (ghosts, drill-in boundaries) are not attachable: an edge to one could
 * never persist.
 */
export function topDropTarget(flow: DropProbeFlow, point: { x: number; y: number }): string | null {
  let hit: string | null = null;
  let hitZ = -Infinity;
  for (const node of flow.getNodes()) {
    if (node.type === "zone" || isGhostNodeId(node.id) || isBoundaryNodeId(node.id)) continue;
    const internal = flow.getInternalNode(node.id);
    if (!internal) continue;
    const { x, y } = internal.internals.positionAbsolute;
    const w = internal.measured?.width ?? 0;
    const h = internal.measured?.height ?? 0;
    const inside = point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h;
    const z = node.zIndex ?? 0;
    if (inside && z >= hitZ) {
      hit = node.id;
      hitZ = z;
    }
  }
  return hit;
}
