/**
 * resize.ts — resizing one node of a multi-selection resizes them all.
 *
 * React Flow moves every selected node when one is dragged, but a resize
 * reaches only the box under the handle: matching five cards meant five
 * drags and a lot of squinting. The resizer reports its progress as
 * `dimensions` node changes, so the editor's change handler runs them
 * through `fanOutResize` — each change for a selected node is repeated for
 * every other selected node, and they all follow the handle live.
 *
 * Every follower keeps its own floor. A size the handle can reach on the
 * dragged box is not always one a neighbour can hold: a table needs its
 * rows, a wrapped title its lines, a group its children. The floors are the
 * same ones the renderers put on their own resizers (`shapeMinHeight`,
 * `groupContentBox`), so a follower is never made smaller than a direct
 * resize of it would allow.
 */
import type { Node, NodeChange } from "@xyflow/react";
import {
  DEFAULT_FONT_SIZE,
  NODE_MIN_SIZE,
  fieldsBoxHeight,
  wrappedTitleHeight,
  isBoundaryNodeId,
  isGhostNodeId,
  isZoneNodeId,
  type DiagramNodeData,
} from "../contract/schema";
import { kindDef } from "./registry-types";
import type { ResolvedRegistry } from "./registry-types";

/** Inset a group keeps between its frame and the children it wraps. */
export const GROUP_CONTENT_PAD = 12;

/**
 * The shortest a card can be at `width` and still hold what it shows — the
 * same measurement `validateTemplate` uses, so the canvas and the document
 * can never disagree about how tall a box has to be.
 */
export function shapeMinHeight(data: DiagramNodeData, width: number): number {
  return Math.max(
    NODE_MIN_SIZE.shape.h,
    data.fields?.length ? fieldsBoxHeight(data.fields.length, !!data.description) : 0,
    data.wrap
      ? wrappedTitleHeight(
          data.label,
          data.fontSize ?? DEFAULT_FONT_SIZE,
          width,
          !!data.icon && data.icon !== "none",
        )
      : 0,
  );
}

/** How much room a group's children need, in the frame's own coordinates. */
export function groupContentBox(
  id: string,
  nodes: readonly Pick<Node, "parentId" | "position" | "width" | "height" | "measured">[],
): { w: number; h: number } {
  let w = 0;
  let h = 0;
  for (const child of nodes) {
    if (child.parentId !== id) continue;
    w = Math.max(w, child.position.x + (child.width ?? child.measured?.width ?? 0) + GROUP_CONTENT_PAD);
    h = Math.max(h, child.position.y + (child.height ?? child.measured?.height ?? 0) + GROUP_CONTENT_PAD);
  }
  return { w, h };
}

/**
 * Which resizer a node answers to. Only boxes of one class follow each other:
 * a card's size means nothing on a frame around other cards or on a bare
 * note, and a frame's size on a card would swallow the canvas.
 */
export type SizeClass = "card" | "frame" | "note" | "point";
export function sizeClassOf(kind: string, registry: ResolvedRegistry): SizeClass {
  const def = kindDef(registry, kind);
  return def.container ? "frame" : def.annotation ? "note" : def.point ? "point" : "card";
}

/** The smallest box a node may be resized to — its renderer's own floor. */
export function nodeSizeFloor(
  node: Node,
  registry: ResolvedRegistry,
  nodes: readonly Node[],
  width: number,
): { w: number; h: number } {
  const data = node.data as DiagramNodeData;
  const cls = sizeClassOf(data.kind, registry);
  if (cls === "frame") {
    const content = groupContentBox(node.id, nodes);
    return {
      w: Math.max(NODE_MIN_SIZE.group.w, content.w),
      h: Math.max(NODE_MIN_SIZE.group.h, content.h),
    };
  }
  if (cls === "note") return { ...NODE_MIN_SIZE.annotation };
  // A wrapped title's height depends on the width it wraps at — the width
  // the box will actually get, never one below the floor.
  const w = Math.max(NODE_MIN_SIZE.shape.w, width);
  return { w: NODE_MIN_SIZE.shape.w, h: shapeMinHeight(data, w) };
}

/** The node's ancestors and descendants — what a resize must not drag along. */
function relativesOf(id: string, nodes: readonly Node[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ancestors = new Set<string>();
  for (let cursor = byId.get(id)?.parentId; cursor && !ancestors.has(cursor) && cursor !== id; ) {
    ancestors.add(cursor);
    cursor = byId.get(cursor)?.parentId;
  }
  // Descendants are grown from the node itself — kept apart from the
  // ancestors, or a sibling (a child of an ancestor) would read as one.
  const descendants = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (n.id === id || descendants.has(n.id) || !n.parentId) continue;
      if (n.parentId === id || descendants.has(n.parentId)) {
        descendants.add(n.id);
        grew = true;
      }
    }
  }
  return new Set([...ancestors, ...descendants]);
}

/**
 * Repeat each resize of a selected node for every other node selected with
 * it. Only the RESIZER's changes qualify — they carry a `resizing` flag; the
 * measurements React Flow's own observer reports do not, and fanning those
 * out would stamp one box's DOM size onto its neighbours on every mount.
 *
 * Followers are the resized node's peers: the same size class (card, frame
 * or note — see `sizeClassOf`), never a zone, a ghost, a boundary frame, a
 * dangling-arrow dot (a 12×12 point with no resizer), or a locked node,
 * whose lock means exactly "not this". Nor the resized node's own container
 * or contents: a band across a group selects the frame AND what is in it,
 * and resizing the frame must not stamp its size onto the cards inside.
 */
export function fanOutResize(
  changes: readonly NodeChange[],
  nodes: readonly Node[],
  registry: ResolvedRegistry,
): NodeChange[] {
  const resizes = changes.filter(
    (change) =>
      change.type === "dimensions" && change.dimensions && typeof change.resizing === "boolean",
  );
  if (!resizes.length) return [...changes];
  const selected = nodes.filter((n) => n.selected);
  if (selected.length < 2) return [...changes];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const extra: NodeChange[] = [];
  for (const change of resizes) {
    if (change.type !== "dimensions" || !change.dimensions) continue;
    const source = byId.get(change.id);
    if (!source?.selected || isZoneNodeId(source.id)) continue;
    const cls = sizeClassOf((source.data as DiagramNodeData).kind, registry);
    const relatives = relativesOf(change.id, nodes);
    for (const follower of selected) {
      if (follower.id === change.id || relatives.has(follower.id)) continue;
      if (isZoneNodeId(follower.id) || isGhostNodeId(follower.id) || isBoundaryNodeId(follower.id)) continue;
      const data = follower.data as DiagramNodeData;
      if (data.locked || cls === "point" || sizeClassOf(data.kind, registry) !== cls) continue;
      const floor = nodeSizeFloor(follower, registry, nodes, change.dimensions.width);
      extra.push({
        id: follower.id,
        type: "dimensions",
        resizing: change.resizing,
        setAttributes: true,
        dimensions: {
          width: Math.max(floor.w, change.dimensions.width),
          height: Math.max(floor.h, change.dimensions.height),
        },
      });
    }
  }
  return [...changes, ...extra];
}
