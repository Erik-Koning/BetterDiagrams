/**
 * quick-add.ts — where a node added from a selected card's side arrows lands.
 *
 * Select a card and four arrows stand off its sides (QuickAddHandles.tsx);
 * clicking one adds a node of the same kind on that side, already wired to
 * the card. This is the geometry half, pure over React Flow's node array so
 * it is tested without a canvas — jsdom measures every node as a zero box.
 */
import type { Node } from "@xyflow/react";
import { isBoundaryNodeId, isGhostNodeId, type DiagramNodeData } from "../contract/schema";

export type QuickAddSide = "top" | "right" | "bottom" | "left";

/**
 * Tidy's rank gap (layout.ts `DEFAULTS.rankGap`), so a chain built a click at
 * a time reads like one the auto-layout drew, and the arrow between two boxes
 * is long enough to carry a label.
 */
export const QUICK_ADD_GAP = 90;
/** Tidy's node gap: the clear space the new box keeps from any neighbour. */
const NEIGHBOUR_GAP = 28;
/** Tidy's container insets — the sides, and the top that clears a frame's label bar. */
const FRAME_PAD = 28;
const FRAME_HEADER = 52;
/** Slots tried either side of the straight-out one, and how many steps further out. */
const FAN_SLOTS = 6;
const OUT_STEPS = 8;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const sizeOf = (n: Pick<Node, "width" | "height" | "measured">) => ({
  w: n.width ?? n.measured?.width ?? 0,
  h: n.height ?? n.measured?.height ?? 0,
});

/** Strict, so two boxes that merely touch do not overlap. */
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The top-left corner, in absolute canvas coordinates, of a box of `size`
 * added on `side` of `source`.
 *
 * Straight out first, centred on the source so the arrow between them is
 * level. When that spot is taken — the usual case being the box this same
 * arrow added last time — the nearest free slot on the same side wins:
 * fanned beside the straight-out one (below or right of it first, the way a
 * tree branches), or further out. Nothing free within reach, it goes
 * straight out anyway; an overlap the user can drag apart beats a box that
 * lands somewhere they were not looking.
 */
export function quickAddSpot(
  source: Box,
  size: { w: number; h: number },
  side: QuickAddSide,
  obstacles: readonly Box[],
): { x: number; y: number } {
  const across = side === "left" || side === "right";
  const sign = side === "right" || side === "bottom" ? 1 : -1;
  const base = across
    ? {
        x: side === "right" ? source.x + source.w + QUICK_ADD_GAP : source.x - QUICK_ADD_GAP - size.w,
        y: source.y + source.h / 2 - size.h / 2,
      }
    : {
        x: source.x + source.w / 2 - size.w / 2,
        y: side === "bottom" ? source.y + source.h + QUICK_ADD_GAP : source.y - QUICK_ADD_GAP - size.h,
      };
  const fanStep = (across ? size.h : size.w) + NEIGHBOUR_GAP;
  const outStep = (across ? size.w : size.h) + QUICK_ADD_GAP;

  const candidates: Array<{ x: number; y: number; d: number }> = [];
  for (let out = 0; out < OUT_STEPS; out++) {
    // 0, +1, -1, +2, -2 …
    for (let slot = 0; slot <= FAN_SLOTS * 2; slot++) {
      const k = slot === 0 ? 0 : slot % 2 ? (slot + 1) / 2 : -slot / 2;
      const along = out * outStep * sign;
      const at = across
        ? { x: base.x + along, y: base.y + k * fanStep }
        : { x: base.x + k * fanStep, y: base.y + along };
      candidates.push({ ...at, d: Math.hypot(at.x - base.x, at.y - base.y) });
    }
  }
  // Stable, so equal distances keep the order above.
  candidates.sort((a, b) => a.d - b.d);

  const free = candidates.find((at) => {
    const box = {
      x: at.x - NEIGHBOUR_GAP,
      y: at.y - NEIGHBOUR_GAP,
      w: size.w + NEIGHBOUR_GAP * 2,
      h: size.h + NEIGHBOUR_GAP * 2,
    };
    return !obstacles.some((o) => overlaps(box, o));
  });
  const at = free ?? base;
  return { x: Math.round(at.x), y: Math.round(at.y) };
}

/** An open frame on this canvas — one that draws its children inside it, and so has to hold them. */
function isOpenFrame(n: Node): boolean {
  const data = n.data as Partial<DiagramNodeData>;
  return n.type === "group" && !data.collapsed && !data.folded && !isBoundaryNodeId(n.id) && !isGhostNodeId(n.id);
}

/**
 * Grow the frames around `childId`, innermost first, until each holds what
 * it contains.
 *
 * A frame grown up or left moves its origin, and its children's positions
 * are relative to that origin — so they move back by the same amount and
 * stay where they are on screen (the frame resizer does the same).
 *
 * The inset kept is Tidy's, but never more than the frame already gives its
 * other children: a frame whose boxes sit 20px under its label is not grown
 * for a new box placed level with them.
 */
export function growFramesToFit(nodes: readonly Node[], childId: string): Node[] {
  let next = [...nodes];
  const index = new Map(next.map((n, i) => [n.id, i]));
  let child = next[index.get(childId) ?? -1];
  const seen = new Set<string>();
  while (child?.parentId && !seen.has(child.parentId)) {
    seen.add(child.parentId);
    const at = index.get(child.parentId);
    const frame = at === undefined ? undefined : next[at];
    if (at === undefined || !frame || !isOpenFrame(frame)) break;

    const { w: fw, h: fh } = sizeOf(frame);
    const c = { ...child.position, ...sizeOf(child) };
    const others = next.filter((n) => n.parentId === frame.id && n.id !== child!.id);
    const inset = (cap: number, gaps: number[]) => Math.max(0, Math.min(cap, ...gaps));
    const left = inset(FRAME_PAD, others.map((n) => n.position.x));
    const top = inset(FRAME_HEADER, others.map((n) => n.position.y));
    const right = inset(FRAME_PAD, others.map((n) => fw - n.position.x - sizeOf(n).w));
    const bottom = inset(FRAME_PAD, others.map((n) => fh - n.position.y - sizeOf(n).h));

    const dx = Math.max(0, left - c.x);
    const dy = Math.max(0, top - c.y);
    const w = Math.max(fw + dx, c.x + dx + c.w + right);
    const h = Math.max(fh + dy, c.y + dy + c.h + bottom);
    if (!dx && !dy && w === fw && h === fh) break;

    if (dx || dy) {
      next = next.map((n) =>
        n.parentId === frame.id ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n,
      );
    }
    const grown: Node = {
      ...frame,
      position: { x: frame.position.x - dx, y: frame.position.y - dy },
      width: w,
      height: h,
      style: { ...frame.style, width: w, height: h },
    };
    next[at] = grown;
    child = grown;
  }
  return next;
}

/**
 * The canvas with `fresh` added on `side` of `sourceId`: placed clear of its
 * neighbours, a sibling of the source (so it stays in the source's frame,
 * which grows to hold it), and the only thing selected. `zoneAt` names the
 * zone its centre lands in, the way a drop decides one.
 *
 * Null when the source is not on the canvas.
 */
export function addBeside(
  nodes: readonly Node[],
  sourceId: string,
  side: QuickAddSide,
  fresh: Node,
  zoneAt?: (x: number, y: number) => string | null,
): Node[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const source = byId.get(sourceId);
  if (!source) return null;

  const absolute = (n: Node): { x: number; y: number } => {
    let x = n.position.x;
    let y = n.position.y;
    const seen = new Set([n.id]);
    let parent = n.parentId ? byId.get(n.parentId) : undefined;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      x += parent.position.x;
      y += parent.position.y;
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return { x, y };
  };

  // The frames around the source are where the new box is meant to go, and a
  // zone is a backdrop — neither is in the way.
  const around = new Set<string>();
  for (let p = source.parentId; p && !around.has(p); p = byId.get(p)?.parentId) around.add(p);
  const obstacles = nodes
    .filter((n) => !n.hidden && !around.has(n.id) && n.type !== "zone" && !isBoundaryNodeId(n.id))
    .map((n) => ({ ...absolute(n), ...sizeOf(n) }));

  const size = sizeOf(fresh);
  const spot = quickAddSpot({ ...absolute(source), ...sizeOf(source) }, size, side, obstacles);
  const parent = source.parentId ? byId.get(source.parentId) : undefined;
  const origin = parent ? absolute(parent) : { x: 0, y: 0 };
  const zoneId = zoneAt?.(spot.x + size.w / 2, spot.y + size.h / 2);

  const node: Node = {
    ...fresh,
    position: { x: spot.x - origin.x, y: spot.y - origin.y },
    ...(source.parentId ? { parentId: source.parentId } : {}),
    // The source's stacking band: same frame depth, same layer.
    ...(source.zIndex !== undefined ? { zIndex: source.zIndex } : {}),
    selected: true,
    data: { ...fresh.data, ...(zoneId ? { zoneId } : {}) },
  };
  return growFramesToFit(
    [...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), node],
    node.id,
  );
}
