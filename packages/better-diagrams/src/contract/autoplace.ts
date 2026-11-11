/**
 * autoplace.ts — where boxes go, from the graph alone.
 *
 * A portfolio rather than a recipe: a pipeline wants ranks, an org chart wants
 * a tidy tree, a gateway with twenty services wants a ring around it, a mesh
 * wants room to spread, and a pile of unconnected tables wants a grid. Each
 * connected piece is laid out by every family that applies to it, the cheapest
 * result is kept, and the pieces are packed together.
 *
 * NO FAMILY AIMS AT A SHAPE. Nothing here knows an aspect ratio unless the
 * caller asks for one (`shape`). The cost that picks between candidates counts
 * things a reader sees — crossings, lines through boxes, how far lines travel,
 * how much canvas is spent — so a chain comes out long, a tree comes out as
 * wide as it branches, and a hub comes out round, because that is what they
 * are.
 *
 * Pure geometry: boxes and links in, positions out. It knows nothing about
 * zones, groups or documents; `arrange.ts` drives it once per container.
 */
import type { LayoutAlgorithm, LayoutShape } from "./schema";
import { bilayerCrossings, isotonic } from "./layout-frames";

export type Flow = "right" | "down" | "left" | "up";
export type PlaceFamily = Exclude<LayoutAlgorithm, "auto">;

export interface PlaceItem {
  id: string;
  w: number;
  h: number;
}

export interface PlaceLink {
  source: string;
  target: string;
  /** Lines this link stands for, when several were lifted onto one pair. */
  weight?: number;
  /** Room the line's words want, so the gap it crosses can make it. */
  labelW?: number;
  labelH?: number;
  /** Connects two boxes without saying one comes before the other. */
  tether?: boolean;
  /** Its line has no direction, or runs both ways: no flow to keep. */
  undirected?: boolean;
  /**
   * Where the line really ends, relative to the centre of the item it was lifted
   * onto: the box inside a container, not the container's middle. An outside box
   * sits level with what it connects to, wherever that is in the frame.
   */
  sourcePort?: { x: number; y: number };
  targetPort?: { x: number; y: number };
}

/** A neighbour one rank away, and the offsets at each end of the line to it. */
interface Adjacent {
  id: string;
  w: number;
  /** Offset of this line's end on the box asking. */
  self: number;
  /** Offset of this line's end on the neighbour. */
  other: number;
}

export interface PlaceOptions {
  algorithm: LayoutAlgorithm;
  flow: Flow;
  rankGap: number;
  nodeGap: number;
  shape: LayoutShape;
  /**
   * Where each item's neighbours OUTSIDE this set are, in the coordinates of
   * the canvas. A container's members are ordered to face what they connect
   * to, so a line leaving the container does not have to cross its siblings.
   */
  pull?: ReadonlyMap<string, { x: number; y: number }>;
  /**
   * Stack loose items across this flow rather than packing them into a block:
   * the flow of whatever contains them, since that's where their lines come from.
   */
  stack?: Flow;
  /**
   * Which rank each item would take on the canvas as a whole, ignoring
   * containers. A container's member with no line to its siblings still has
   * lines to the outside, so it belongs at the head or the tail of the flow,
   * not parked past the end of it.
   */
  rankHint?: ReadonlyMap<string, number>;
  /** Keep hinted items in one flow even with nothing joining them here. */
  together?: boolean;
  /**
   * An arrangement of the caller's own for each connected piece, in place of the
   * families here. Loose boxes are still packed, pieces are still put together,
   * and a container's hinted members still flow as one, by the engine's ranks.
   */
  engine?: PlaceEngine;
}

/** A block of placed boxes, as every family returns one. */
export interface PlacedBlock {
  placed: PlacedBox[];
  width: number;
  height: number;
}

/**
 * A way of arranging connected pieces that isn't one of the families: see
 * `directed/`. It is handed in, not imported, so this file knows nothing of it.
 */
export interface PlaceEngine {
  /** Arrange one connected piece, or null to leave it to the ranked family. */
  place(items: readonly PlaceItem[], links: readonly PlaceLink[], opts: PlaceOptions): (PlacedBlock & { family: PlaceFamily }) | null;
  /** The rank each box takes on a canvas with no containers: what `flatRanks` is to the families. */
  ranks(ids: readonly string[], links: readonly PlaceLink[]): Map<string, number>;
}

/**
 * Ranks decided by the caller. A line runs from the lower rank to the higher
 * whichever way it points, so a line the caller ranked backward is drawn
 * backward: that is the caller's to decide, and the reason to hand ranks in.
 */
export interface RankPlan {
  rank: ReadonlyMap<string, number>;
  /**
   * Where each box sat across the flow, 0 to 1, when the ranks were chosen: one
   * more order for the crossing search to start from.
   */
  across?: ReadonlyMap<string, number>;
}

export interface PlacedBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placement {
  placed: PlacedBox[];
  width: number;
  height: number;
  family: PlaceFamily;
  /**
   * Items placed with no direction to them (a ring, a mesh, a grid). A line
   * touching one floats to whichever side faces the other end, which is what
   * gives a ring its spokes; the rest enter their boxes the way the flow runs.
   */
  free: Set<string>;
  /** Pieces laid out around a centre: their lines arc rather than wiggle. */
  rings: Array<Set<string>>;
}

/** Past this many boxes in one piece, only the layered family is worth its cost. */
const PORTFOLIO_LIMIT = 150;
/** Boxes past which the crossing search makes fewer attempts. */
const THOROUGH_LIMIT = 300;
/** A lane through a rank for a line that skips it: what keeps two such lines apart. */
const LANE_GAP = 22;
/** Room kept beyond a lane, so its line doesn't run along the frame around it. */
const LANE_CLEARANCE = 26;
/** How much more a main path's lines want to run level than a branch's. */
const CHAIN_WEIGHT = 5;

// ─── The entry point ─────────────────────────────────────────────────────────

/** Arrange a set of boxes. Positions are relative to (0,0), and every coordinate is whole. */
export function placeItems(
  items: readonly PlaceItem[],
  links: readonly PlaceLink[],
  opts: PlaceOptions,
): Placement {
  if (!items.length) return { placed: [], width: 0, height: 0, family: "grid", free: new Set(), rings: [] };
  const known = new Set(items.map((i) => i.id));
  const usable = links.filter((l) => known.has(l.source) && known.has(l.target) && l.source !== l.target);
  const { connected, loose } = splitComponents(items, usable);

  if (opts.algorithm === "grid") {
    return finish(gridBlock([...items], opts), "grid", new Set(items.map((i) => i.id)), []);
  }

  const free = new Set<string>();
  const rings: Array<Set<string>> = [];
  const blocks: Array<{ placed: PlacedBox[]; width: number; height: number }> = [];
  let family: PlaceFamily = connected.length ? "layered" : "grid";

  // Members with a line leaving this container flow together, ranked with the
  // canvas, however little joins them to each other here.
  const hints = opts.rankHint;
  let rest = connected;
  let spare = loose;
  if (hints && opts.together) {
    const flowing = items.filter((i) => hints.has(i.id));
    const flowingIds = new Set(flowing.map((i) => i.id));
    if (flowing.length) {
      const own = usable.filter((l) => flowingIds.has(l.source) && flowingIds.has(l.target));
      // An engine's hints are its ranks, backward lines and all: they are kept as given.
      blocks.push(layered(flowing, own, opts, opts.engine ? { rank: hints } : undefined));
    }
    rest = [];
    spare = items.filter((i) => !flowingIds.has(i.id));
  }

  for (const comp of rest) {
    const ids = new Set(comp.map((i) => i.id));
    const own = usable.filter((l) => ids.has(l.source) && ids.has(l.target));
    const best = placeComponent(comp, own, opts);
    blocks.push(best);
    if (best.family !== "layered" && best.family !== "tree") for (const i of comp) free.add(i.id);
    if (best.family === "radial") rings.push(ids);
    if (comp === rest[0]) family = best.family;
  }
  if (spare.length) {
    blocks.push(gridBlock(spare, opts));
    for (const i of spare) free.add(i.id);
  }
  return finish(packBlocks(blocks, opts), family, free, rings);
}

function finish(
  block: { placed: PlacedBox[]; width: number; height: number },
  family: PlaceFamily,
  free: Set<string>,
  rings: Array<Set<string>>,
): Placement {
  const out = block.placed.map((p) => ({ ...p, x: Math.round(p.x), y: Math.round(p.y) }));
  // A block's own extent, not its boxes': a lane running past the last box is why
  // a frame has to be that big, or its line would bulge out through the border.
  return {
    placed: out,
    width: Math.max(Math.ceil(block.width), ...out.map((p) => p.x + p.w)),
    height: Math.max(Math.ceil(block.height), ...out.map((p) => p.y + p.h)),
    family,
    free,
    rings,
  };
}

/** Connected pieces, biggest first, and the boxes nothing connects. Document order breaks ties. */
function splitComponents(
  items: readonly PlaceItem[],
  links: readonly PlaceLink[],
): { connected: PlaceItem[][]; loose: PlaceItem[] } {
  const parent = new Map(items.map((i) => [i.id, i.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const touched = new Set<string>();
  for (const l of links) {
    parent.set(find(l.source), find(l.target));
    touched.add(l.source);
    touched.add(l.target);
  }
  const byRoot = new Map<string, PlaceItem[]>();
  const loose: PlaceItem[] = [];
  for (const item of items) {
    if (!touched.has(item.id)) {
      loose.push(item);
      continue;
    }
    const root = find(item.id);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(item);
    else byRoot.set(root, [item]);
  }
  const connected = [...byRoot.values()];
  connected.sort((a, b) => b.length - a.length);
  return { connected, loose };
}

// ─── One connected piece ─────────────────────────────────────────────────────

function placeComponent(
  items: readonly PlaceItem[],
  links: readonly PlaceLink[],
  opts: PlaceOptions,
): { placed: PlacedBox[]; width: number; height: number; family: PlaceFamily } {
  const own = opts.engine?.place(items, links, opts);
  if (own) return own;
  const fixed = opts.algorithm === "auto" ? (opts.rankHint ? "layered" : null) : opts.algorithm;
  const families: PlaceFamily[] = fixed ? [fixed] : familiesFor(items, links);
  let best: { placed: PlacedBox[]; width: number; height: number; family: PlaceFamily } | null = null;
  let bestCost = Infinity;
  for (const family of families) {
    const block = runFamily(family, items, links, opts);
    if (!block) continue;
    // A hierarchy drawn as a tree says what it is; ranks only happen to fit it.
    const cost = families.length > 1 ? quickCost(block.placed, links, opts) * (family === "tree" ? 0.8 : 1) : 0;
    if (cost < bestCost) {
      best = { ...block, family };
      bestCost = cost;
    }
  }
  return best ?? { ...layered(items, links, opts), family: "layered" };
}

/**
 * Which families suit a piece at all. Decided by what the graph IS before any
 * cost is compared: a flow with a direction must keep it, however tidy a scatter
 * might measure, or a flow chart comes out reading backwards. So a mesh only
 * counts as a mesh when no direction runs through it (a fifth of its lines would
 * have to run backward, or its lines don't point anywhere), and a hub only as a
 * hub when almost everything hangs directly off it.
 */
function familiesFor(items: readonly PlaceItem[], links: readonly PlaceLink[]): PlaceFamily[] {
  if (items.length > PORTFOLIO_LIMIT) return ["layered"];
  // A line that really ends somewhere inside a box wants that spot level with its
  // other end, and only the ranked layout can do anything about that.
  if (links.some((l) => l.sourcePort || l.targetPort)) return ["layered"];
  const families: PlaceFamily[] = ["layered"];
  if (items.length >= 3 && forestOf(items, links)) families.push("tree");
  const degree = degreesOf(items, links);
  const top = Math.max(...degree.values());
  const pairs = [...degree.values()].reduce((sum, d) => sum + d, 0) / 2;
  const hub = items.length >= 7 && top >= 6 && top >= (items.length - 1) * 0.6 && pairs - (items.length - 1) <= 2;
  const ring = items.length >= 3 && [...degree.values()].every((d) => d === 2);
  if ((hub || ring) && items.length <= 60) families.push("radial");
  if (items.length >= 4 && items.length <= 120 && pairs >= items.length) {
    const order = acyclicOrder(items.map((i) => i.id), links);
    const directed = links.filter((l) => !l.tether && !l.undirected);
    const backward = directed.filter((l) => order.get(l.source)! > order.get(l.target)!).length;
    if (!directed.length || backward / directed.length >= 0.2) families.push("organic");
  }
  return families;
}

function runFamily(
  family: PlaceFamily,
  items: readonly PlaceItem[],
  links: readonly PlaceLink[],
  opts: PlaceOptions,
): { placed: PlacedBox[]; width: number; height: number } | null {
  switch (family) {
    case "layered":
      return layered(items, links, opts);
    case "tree":
      return tidyTree(items, links, opts);
    case "radial":
      return radial(items, links, opts);
    case "organic":
      return organic(items, links, opts);
    case "grid":
      return gridBlock([...items], opts);
  }
}

/**
 * One key for a pair of boxes. Joined by a NUL, which no id contains: joined by
 * anything an id can hold, "a b" to "c" and "a" to "b c" are the same key, and
 * one of the two lines vanishes from the ranking.
 */
const pairKey = (a: string, b: string) => `${a}\u0000${b}`;

function degreesOf(items: readonly PlaceItem[], links: readonly PlaceLink[]): Map<string, number> {
  const degree = new Map(items.map((i) => [i.id, 0]));
  const seen = new Set<string>();
  for (const l of links) {
    const key = l.source < l.target ? pairKey(l.source, l.target) : pairKey(l.target, l.source);
    if (seen.has(key)) continue;
    seen.add(key);
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  return degree;
}

// ─── Comparing candidates ────────────────────────────────────────────────────

/**
 * What a candidate costs a reader, with straight lines standing in for the
 * drawn ones — quick enough to run on every family of every container. The
 * document-level choice of direction uses the real routes (`layout-lint.ts`).
 *
 * Deliberately has no term for width against height: the canvas spent is
 * charged by its area, and lines by how far they travel, so a shape is only
 * ever preferred because it is shorter or smaller, never for being a shape.
 */
function quickCost(placed: readonly PlacedBox[], links: readonly PlaceLink[], opts: PlaceOptions): number {
  const byId = new Map(placed.map((p) => [p.id, p]));
  const unit =
    placed.reduce((sum, p) => sum + (p.w + p.h) / 2, 0) / Math.max(1, placed.length) + opts.nodeGap;
  const horizontal = opts.flow === "right" || opts.flow === "left";
  const sign = opts.flow === "right" || opts.flow === "down" ? 1 : -1;

  const segments: Array<{ a: Pt; b: Pt; link: PlaceLink }> = [];
  let length = 0;
  let against = 0;
  let oblique = 0;
  for (const link of links) {
    const s = byId.get(link.source);
    const t = byId.get(link.target);
    if (!s || !t) continue;
    const a = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
    const b = { x: t.x + t.w / 2, y: t.y + t.h / 2 };
    const clipped = { a: edgePoint(s, b), b: edgePoint(t, a), link };
    segments.push(clipped);
    length += Math.hypot(clipped.b.x - clipped.a.x, clipped.b.y - clipped.a.y);
    const along = horizontal ? b.x - a.x : b.y - a.y;
    const across = horizontal ? b.y - a.y : b.x - a.x;
    if (!link.tether && along * sign < -1) against += 1;
    if (Math.abs(across) > Math.abs(along)) oblique += 1;
  }

  let crossings = 0;
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const p = segments[i]!;
      const q = segments[j]!;
      if (
        p.link.source === q.link.source ||
        p.link.source === q.link.target ||
        p.link.target === q.link.source ||
        p.link.target === q.link.target
      )
        continue;
      if (segmentsCross(p.a, p.b, q.a, q.b)) crossings += 1;
    }
  }

  let through = 0;
  for (const { a, b, link } of segments) {
    for (const box of placed) {
      if (box.id === link.source || box.id === link.target) continue;
      if (segmentHitsBox(a, b, box, 3)) through += 1;
    }
  }

  let overlaps = 0;
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i]!;
      const b = placed[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps += 1;
    }
  }

  const minX = Math.min(...placed.map((p) => p.x));
  const minY = Math.min(...placed.map((p) => p.y));
  const maxX = Math.max(...placed.map((p) => p.x + p.w));
  const maxY = Math.max(...placed.map((p) => p.y + p.h));
  const area = Math.sqrt((maxX - minX) * (maxY - minY));

  return (
    overlaps * 500 +
    through * 40 +
    crossings * 18 +
    length / unit +
    area / unit +
    against * 1.5 +
    oblique * 0.75
  );
}

type Pt = { x: number; y: number };

/** Where the line from a box's centre toward `toward` leaves the box. */
function edgePoint(box: PlacedBox, toward: Pt): Pt {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(
    dx === 0 ? Infinity : box.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : box.h / 2 / Math.abs(dy),
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const orient = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
}

function segmentHitsBox(a: Pt, b: Pt, box: PlacedBox, inset: number): boolean {
  let lo = 0;
  let hi = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks: Array<[number, number]> = [
    [-dx, a.x - (box.x + inset)],
    [dx, box.x + box.w - inset - a.x],
    [-dy, a.y - (box.y + inset)],
    [dy, box.y + box.h - inset - a.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) lo = Math.max(lo, r);
    else hi = Math.min(hi, r);
    if (lo > hi) return false;
  }
  return true;
}

// ─── Flow frames ─────────────────────────────────────────────────────────────

/**
 * The ranked families work in one frame — ranks along x, order along y — and
 * every other flow is that frame swapped and mirrored, so a change of direction
 * can never change the algorithm, only how its answer is read.
 */
function intoFrame(items: readonly PlaceItem[], flow: Flow): PlaceItem[] {
  return flow === "down" || flow === "up"
    ? items.map((i) => ({ id: i.id, w: i.h, h: i.w }))
    : items.map((i) => ({ ...i }));
}

function outOfFrame(
  placed: readonly PlacedBox[],
  width: number,
  height: number,
  flow: Flow,
): { placed: PlacedBox[]; width: number; height: number } {
  if (flow === "right") return { placed: [...placed], width, height };
  if (flow === "left") {
    return { placed: placed.map((p) => ({ ...p, x: width - p.x - p.w })), width, height };
  }
  const swapped = placed.map((p) => ({ id: p.id, x: p.y, y: p.x, w: p.h, h: p.w }));
  if (flow === "down") return { placed: swapped, width: height, height: width };
  return {
    placed: swapped.map((p) => ({ ...p, y: width - p.y - p.h })),
    width: height,
    height: width,
  };
}

const isVertical = (flow: Flow) => flow === "down" || flow === "up";

/** How far a pull sits across the flow: the coordinate ranks are ordered along. */
function crossOf(point: { x: number; y: number }, flow: Flow): number {
  return isVertical(flow) ? point.x : point.y;
}

// ─── Layered ─────────────────────────────────────────────────────────────────

/**
 * An order of the boxes in which only the links that close a loop run backward.
 *
 * A depth-first walk from the boxes nothing points at, in document order: a link
 * back to a box still being walked is what closes a loop, so that link is the one
 * to reverse. It follows the flow the way a reader would: start at Start, keep
 * going, and call the line that returns to an earlier step the "retry". A cleverer
 * minimum (Eades, Lin & Smyth) reverses fewer lines but happily picks a mid-flow
 * box to start from, which turns a flow chart inside out.
 */
export function acyclicOrder(ids: readonly string[], links: readonly PlaceLink[]): Map<string, number> {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const l of links) {
    if (l.tether) continue;
    out.get(l.source)!.push(l.target);
    incoming.set(l.target, incoming.get(l.target)! + 1);
  }
  const done = new Set<string>();
  const finished: string[] = [];
  const walk = (start: string) => {
    // Iterative: a long chain must not run the stack out.
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    done.add(start);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const targets = out.get(top.id)!;
      if (top.next < targets.length) {
        const target = targets[top.next]!;
        top.next += 1;
        if (!done.has(target)) {
          done.add(target);
          stack.push({ id: target, next: 0 });
        }
      } else {
        finished.push(top.id);
        stack.pop();
      }
    }
  };
  for (const id of ids) if (incoming.get(id) === 0 && !done.has(id)) walk(id);
  for (const id of ids) if (!done.has(id)) walk(id);
  const order = new Map<string, number>();
  finished.reverse().forEach((id, i) => order.set(id, i));
  return order;
}

/**
 * Ranks: longest path, then each box slides toward whichever side has more of
 * its lines. A coordinate-descent stand-in for network simplex: it only ever
 * shortens the total span. A box with slack and equal lines both ways stays next to
 * what feeds it, so the line that reaches it is short and direct; drifting toward an
 * emptier rank makes that line wrap around whatever it now has to pass.
 */
function assignRanks(
  ids: readonly string[],
  edges: ReadonlyArray<{ u: string; v: string; w: number }>,
  hint?: ReadonlyMap<string, number>,
): Map<string, number> {
  const preds = new Map(ids.map((id) => [id, [] as Array<{ id: string; w: number }>]));
  const succs = new Map(ids.map((id) => [id, [] as Array<{ id: string; w: number }>]));
  const pending = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) {
    preds.get(e.v)!.push({ id: e.u, w: e.w });
    succs.get(e.u)!.push({ id: e.v, w: e.w });
    pending.set(e.v, pending.get(e.v)! + 1);
  }
  const rank = new Map(ids.map((id) => [id, hint?.get(id) ?? 0]));
  const queue = ids.filter((id) => pending.get(id) === 0);
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]!;
    for (const { id: next } of succs.get(id)!) {
      rank.set(next, Math.max(rank.get(next)!, rank.get(id)! + 1));
      pending.set(next, pending.get(next)! - 1);
      if (pending.get(next) === 0) queue.push(next);
    }
  }

  const bounds = (id: string) => ({
    low: preds.get(id)!.length ? Math.max(...preds.get(id)!.map((p) => rank.get(p.id)! + 1)) : -Infinity,
    high: succs.get(id)!.length ? Math.min(...succs.get(id)!.map((s) => rank.get(s.id)! - 1)) : Infinity,
  });
  for (let round = 0; round < (hint ? 0 : 8); round += 1) {
    let moved = false;
    for (const id of ids) {
      const inW = preds.get(id)!.reduce((sum, p) => sum + p.w, 0);
      const outW = succs.get(id)!.reduce((sum, s) => sum + s.w, 0);
      if (inW === outW) continue;
      const { low, high } = bounds(id);
      const next = outW > inW ? high : low;
      if (Number.isFinite(next) && next !== rank.get(id)) {
        rank.set(id, next);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const used = [...new Set(rank.values())].sort((a, b) => a - b);
  const dense = new Map(used.map((r, i) => [r, i]));
  for (const id of ids) rank.set(id, dense.get(rank.get(id)!)!);
  return rank;
}

/**
 * The rank every box would take if containers didn't exist. A container's
 * members are then ranked by this, which keeps a flow reading one way as it
 * passes through a group, even for a member joined to nothing inside it.
 */
export function flatRanks(ids: readonly string[], links: readonly PlaceLink[]): Map<string, number> {
  return ranksInOrder(ids, links);
}

/**
 * Ranks for an order of the boxes: a line runs from whichever end comes first
 * in `position`, so the order says which lines run backward. Left out, the
 * order is the reader's (`acyclicOrder`).
 */
export function ranksInOrder(
  ids: readonly string[],
  links: readonly PlaceLink[],
  order?: ReadonlyMap<string, number>,
): Map<string, number> {
  const known = new Set(ids);
  const usable = links.filter((l) => !l.tether && known.has(l.source) && known.has(l.target) && l.source !== l.target);
  const position = order ?? acyclicOrder(ids, usable);
  const seen = new Map<string, { u: string; v: string; w: number }>();
  for (const l of usable) {
    const forward = position.get(l.source)! < position.get(l.target)!;
    const u = forward ? l.source : l.target;
    const v = forward ? l.target : l.source;
    const hit = seen.get(pairKey(u, v));
    if (hit) hit.w += l.weight ?? 1;
    else seen.set(pairKey(u, v), { u, v, w: l.weight ?? 1 });
  }
  return assignRanks(ids, [...seen.values()]);
}

/**
 * Sugiyama layout: break cycles, rank, thread a lane through every rank a line
 * skips, minimise crossings by repeated sweeps, then slide each rank along its
 * column until lines run as level as the boxes allow. Lanes take no room along
 * the flow but do across it, which is what leaves a gap for the line that
 * skips a rank: a box cannot be placed in a lane.
 *
 * Rank gaps follow the lines: a gap crossed by a long label grows to fit the
 * words, and one crossed by lines that travel far across the flow widens so
 * they don't arrive as near-vertical slashes.
 */
export function layered(
  items: readonly PlaceItem[],
  links: readonly PlaceLink[],
  opts: PlaceOptions,
  plan?: RankPlan,
): PlacedBlock {
  const vertical = isVertical(opts.flow);
  const frame = intoFrame(items, opts.flow);
  const size = new Map<string, { w: number; h: number }>(frame.map((i) => [i.id, i]));
  const ids = frame.map((i) => i.id);
  const reading = acyclicOrder(ids, links);
  // With ranks handed in, a line runs from the lower rank; the reader's order only breaks a tie.
  const position = plan
    ? new Map(
        [...ids]
          .sort((a, b) => (plan.rank.get(a) ?? 0) - (plan.rank.get(b) ?? 0) || reading.get(a)! - reading.get(b)!)
          .map((id, i) => [id, i]),
      )
    : reading;

  // ── Acyclic links, merged: two lines between one pair are one heavier link ──
  const merged = new Map<string, { u: string; v: string; w: number; label: number; offU: number; offV: number; heard: number }>();
  for (const l of links) {
    if (l.tether) continue;
    const forward = position.get(l.source)! < position.get(l.target)!;
    const u = forward ? l.source : l.target;
    const v = forward ? l.target : l.source;
    const key = pairKey(u, v);
    const room = (vertical ? l.labelH : l.labelW) ?? 0;
    const weight = l.weight ?? 1;
    const atSource = l.sourcePort ? crossOf(l.sourcePort, opts.flow) : 0;
    const atTarget = l.targetPort ? crossOf(l.targetPort, opts.flow) : 0;
    const offU = forward ? atSource : atTarget;
    const offV = forward ? atTarget : atSource;
    const hit = merged.get(key);
    if (hit) {
      // Several lines lifted onto one pair: aim for the middle of where they land.
      // A line running against the flow has no say in where the flow lines up, or a
      // return path pulls the main line off its axis.
      const heard = forward ? hit.heard + weight : hit.heard;
      if (forward) {
        hit.offU = hit.heard ? (hit.offU * hit.heard + offU * weight) / heard : offU;
        hit.offV = hit.heard ? (hit.offV * hit.heard + offV * weight) / heard : offV;
      }
      hit.heard = heard;
      hit.w += weight;
      hit.label = Math.max(hit.label, room);
    } else {
      merged.set(key, { u, v, w: weight, label: room, offU, offV, heard: forward ? weight : 0 });
    }
  }
  const edges = [...merged.values()];
  const rank = assignRanks(ids, edges, plan?.rank ?? opts.rankHint);

  // A box only tethers touch ranks with what it is tethered to, not the far left.
  for (const l of links) {
    if (!l.tether) continue;
    const solid = (id: string) => edges.some((e) => e.u === id || e.v === id);
    if (!solid(l.source) && solid(l.target)) rank.set(l.source, rank.get(l.target)!);
    else if (!solid(l.target) && solid(l.source)) rank.set(l.target, rank.get(l.source)!);
  }

  // ── Layers, with a lane through every rank a line skips ─────────────────────
  const depth = Math.max(...rank.values()) + 1;
  const layers: string[][] = Array.from({ length: depth }, () => []);
  for (const id of ids) layers[rank.get(id)!]!.push(id);
  const up = new Map<string, Adjacent[]>();
  const down = new Map<string, Adjacent[]>();
  const connect = (a: string, b: string, w: number, offA = 0, offB = 0) => {
    if (!down.has(a)) down.set(a, []);
    if (!up.has(b)) up.set(b, []);
    down.get(a)!.push({ id: b, w, self: offA, other: offB });
    up.get(b)!.push({ id: a, w, self: offB, other: offA });
  };
  const lanes = new Set<string>();
  /** Where a lane would sit across the flow, going by the two boxes its line joins. */
  const laneAcross = new Map<string, number>();
  const labelInGap = new Array<number>(Math.max(0, depth - 1)).fill(0);
  let laneCount = 0;
  for (const e of edges) {
    const from = rank.get(e.u)!;
    const to = rank.get(e.v)!;
    if (e.label) {
      const mid = Math.floor((from + to - 1) / 2);
      if (mid >= 0 && mid < labelInGap.length) labelInGap[mid] = Math.max(labelInGap[mid]!, e.label);
    }
    let prev = e.u;
    let offset = e.offU;
    for (let r = from + 1; r < to; r += 1) {
      const lane = `\u0001lane${laneCount++}`;
      lanes.add(lane);
      if (plan?.across) {
        const a = plan.across.get(e.u) ?? 0.5;
        const b = plan.across.get(e.v) ?? 0.5;
        laneAcross.set(lane, a + ((b - a) * (r - from)) / (to - from));
      }
      size.set(lane, { w: 0, h: 0 });
      layers[r]!.push(lane);
      connect(prev, lane, e.w, offset, 0);
      prev = lane;
      offset = 0;
    }
    connect(prev, e.v, e.w, offset, e.offV);
  }

  const across = plan?.across;
  const seeded = across
    ? layers.map((layer) =>
        layer
          .map((id, i) => ({ id, i, at: laneAcross.get(id) ?? across.get(id) ?? 0.5 }))
          .sort((a, b) => a.at - b.at || a.i - b.i)
          .map((entry) => entry.id),
      )
    : undefined;
  const ordered = orderLayers(layers, up, down, ids, frame, opts, seeded);
  markChains(edges, rank, up, down, !!plan);

  // Past the height the caller's shape wants, a rank wraps into sub-columns.
  const columns = wrapColumns(ordered, size, lanes, frame, opts);
  const { top, centre } = assignCross(columns, size, lanes, up, down, opts);

  // ── Along the flow ───────────────────────────────────────────────────────────
  const columnWidths = columns.map((col) => Math.max(0, ...col.map((id) => size.get(id)!.w)));
  const gaps: number[] = [];
  columns.forEach((col, ci) => {
    if (ci === columns.length - 1) return;
    // The next gap: at least the rank gap, wider for words and for lines that
    // have far to travel across it.
    let travel = 0;
    let across = 0;
    const nextCol = new Set(columns[ci + 1]);
    for (const id of col) {
      for (const n of down.get(id) ?? []) {
        if (!nextCol.has(n.id)) continue;
        const offset = Math.abs(centre(id) - centre(n.id));
        travel = Math.max(travel, offset);
        // Floating lines take the axis with the wider gap, so a rank gap at
        // least this wide keeps a line leaving its box the way the flow runs.
        if (!lanes.has(id) && !lanes.has(n.id)) {
          across = Math.max(across, offset - (size.get(id)!.h + size.get(n.id)!.h) / 2 + 2);
        }
      }
    }
    const words = ci < labelInGap.length ? labelInGap[ci]! : 0;
    const roomForWords = words ? words + 24 : 0;
    const roomForTravel = Math.min(travel * 0.22, opts.rankGap * 1.8);
    const roomForPorts = Math.min(across, opts.rankGap * 2.2);
    gaps.push(Math.max(opts.rankGap, roomForWords, roomForTravel, roomForPorts));
  });
  // Gaps that nearly match are made to match: 96 next to 103 only looks careless.
  const even = evenedGaps(gaps);
  const placed: PlacedBox[] = [];
  let x = 0;
  columns.forEach((col, ci) => {
    for (const id of col) {
      if (lanes.has(id)) continue;
      const s = size.get(id)!;
      placed.push({ id, x: x + (columnWidths[ci]! - s.w) / 2, y: top.get(id)!, w: s.w, h: s.h });
    }
    x += columnWidths[ci]! + (even[ci] ?? 0);
  });
  const width = placed.length ? Math.max(...placed.map((p) => p.x + p.w)) : 0;
  const height = Math.max(
    0,
    ...columns.flat().map((id) => top.get(id)! + size.get(id)!.h + (lanes.has(id) ? LANE_CLEARANCE : 0)),
  );
  return outOfFrame(placed, width, height, opts.flow);
}

/**
 * The line a flow's reader follows: from each box, the way on that runs longest,
 * if one does. Those lines weigh more when boxes settle, so a main path comes out
 * as one straight column and what leaves it visibly branches off. A tie has no
 * main path: a fan with equal branches stays centred on them.
 */
function markChains(
  edges: ReadonlyArray<{ u: string; v: string }>,
  rank: ReadonlyMap<string, number>,
  up: Map<string, Adjacent[]>,
  down: Map<string, Adjacent[]>,
  mutual = false,
): void {
  const succs = new Map<string, string[]>();
  const preds = new Map<string, string[]>();
  for (const e of edges) {
    const list = succs.get(e.u);
    if (list) list.push(e.v);
    else succs.set(e.u, [e.v]);
    const back = preds.get(e.v);
    if (back) back.push(e.u);
    else preds.set(e.v, [e.u]);
  }
  // How long a path leads up to a box: the other half of which line is the main one.
  const behind = new Map<string, number>();
  const behindOf = (id: string): number => {
    const known = behind.get(id);
    if (known !== undefined) return known;
    behind.set(id, 0);
    let best = 0;
    for (const prev of preds.get(id) ?? []) best = Math.max(best, behindOf(prev) + 1);
    behind.set(id, best);
    return best;
  };
  /**
   * Whether a line is also the main way INTO its target: of the lines arriving
   * from the rank before, the one with the longest path behind it, if one is
   * longer. Where several arrive level, as into the box that collects a fan,
   * none is the main one, and the box sits in the middle of them all.
   */
  const mainInto = (from: string, to: string): boolean => {
    const arriving = (preds.get(to) ?? [])
      .filter((p) => rank.get(p) === rank.get(to)! - 1)
      .map((p) => ({ p, behind: behindOf(p) }))
      .sort((a, b) => b.behind - a.behind);
    if (arriving.length <= 1) return true;
    return arriving[0]!.p === from && arriving[0]!.behind > arriving[1]!.behind;
  };
  const reach = new Map<string, number>();
  const reachOf = (id: string): number => {
    const known = reach.get(id);
    if (known !== undefined) return known;
    reach.set(id, 0);
    let best = 0;
    for (const next of succs.get(id) ?? []) best = Math.max(best, reachOf(next) + 1);
    reach.set(id, best);
    return best;
  };
  const heavy = (from: string, to: string) => {
    for (const a of down.get(from) ?? []) if (a.id === to) a.w *= CHAIN_WEIGHT;
    for (const a of up.get(to) ?? []) if (a.id === from) a.w *= CHAIN_WEIGHT;
  };
  for (const [from, nexts] of succs) {
    const ranked = nexts
      .filter((n) => rank.get(n) === rank.get(from)! + 1)
      .map((n) => ({ n, reach: reachOf(n) }))
      .sort((a, b) => b.reach - a.reach);
    if (!ranked.length) continue;
    const longer = ranked.length === 1 || ranked[0]!.reach > ranked[1]!.reach;
    if (longer && (!mutual || mainInto(from, ranked[0]!.n))) heavy(from, ranked[0]!.n);
  }
}

/** Crossing reduction: barycentre sweeps with adjacent swaps, best of several starts. */
function orderLayers(
  layers: readonly string[][],
  up: ReadonlyMap<string, readonly Adjacent[]>,
  down: ReadonlyMap<string, readonly Adjacent[]>,
  ids: readonly string[],
  frame: readonly PlaceItem[],
  opts: PlaceOptions,
  seeded?: readonly string[][],
): string[][] {
  const pos = new Map<string, number>();
  const index = (order: readonly (readonly string[])[]) => {
    for (const layer of order) layer.forEach((id, i) => pos.set(id, i));
  };
  const crossings = (order: readonly (readonly string[])[]) => {
    index(order);
    let total = 0;
    for (let l = 0; l + 1 < order.length; l += 1) {
      const pairs: Array<[number, number]> = [];
      for (const id of order[l]!) {
        for (const n of down.get(id) ?? []) pairs.push([pos.get(id)!, pos.get(n.id)!]);
      }
      total += bilayerCrossings(pairs, order[l + 1]!.length);
    }
    return total;
  };

  // A pull is scaled to where it falls among the others in play.
  const pulls = opts.pull;
  let lo = Infinity;
  let hi = -Infinity;
  if (pulls) {
    for (const id of ids) {
      const p = pulls.get(id);
      if (!p) continue;
      const c = crossOf(p, opts.flow);
      lo = Math.min(lo, c);
      hi = Math.max(hi, c);
    }
  }
  const pullOf = (id: string): number | undefined => {
    const p = pulls?.get(id);
    if (!p || !(hi > lo)) return undefined;
    return (crossOf(p, opts.flow) - lo) / (hi - lo);
  };

  const sortLayer = (layer: string[], against: ReadonlyMap<string, readonly Adjacent[]>) => {
    const denom = Math.max(1, layer.length - 1);
    const score = new Map<string, number>();
    for (const id of layer) {
      const near = against.get(id) ?? [];
      let sum = 0;
      let weight = 0;
      for (const n of near) {
        sum += (pos.get(n.id) ?? 0) * n.w;
        weight += n.w;
      }
      const pull = pullOf(id);
      if (!weight && pull === undefined) continue;
      const own = weight ? sum / weight / denom : pull!;
      score.set(id, pull === undefined ? own : (own * weight + pull) / (weight + 1));
    }
    const movable = layer
      .filter((id) => score.has(id))
      .sort((a, b) => score.get(a)! - score.get(b)!);
    let next = 0;
    for (let i = 0; i < layer.length; i += 1) {
      if (score.has(layer[i]!)) layer[i] = movable[next++]!;
    }
    layer.forEach((id, i) => pos.set(id, i));
  };

  const pairCost = (a: string, b: string): number => {
    let n = 0;
    for (const side of [up, down]) {
      for (const x of side.get(a) ?? []) {
        for (const y of side.get(b) ?? []) if (pos.get(x.id)! > pos.get(y.id)!) n += x.w * y.w;
      }
    }
    return n;
  };
  const transpose = (order: string[][]) => {
    for (const layer of order) {
      let improved = true;
      let guard = 0;
      while (improved && guard++ < layer.length) {
        improved = false;
        for (let i = 0; i + 1 < layer.length; i += 1) {
          const a = layer[i]!;
          const b = layer[i + 1]!;
          if (pairCost(b, a) < pairCost(a, b)) {
            layer[i] = b;
            layer[i + 1] = a;
            pos.set(b, i);
            pos.set(a, i + 1);
            improved = true;
          }
        }
      }
    }
  };

  /** Depth-first from the roots, which keeps a subtree's boxes next to each other. */
  const depthFirst = (): string[][] => {
    const out: string[][] = layers.map(() => []);
    const seen = new Set<string>();
    const layerOf = new Map<string, number>();
    layers.forEach((layer, l) => layer.forEach((id) => layerOf.set(id, l)));
    const stack: string[] = [];
    for (const start of [...layers.flat()].reverse()) {
      if ((up.get(start) ?? []).length === 0) stack.push(start);
    }
    for (const start of [...layers.flat()].reverse()) stack.unshift(start);
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out[layerOf.get(id)!]!.push(id);
      const next = down.get(id) ?? [];
      for (let i = next.length - 1; i >= 0; i -= 1) stack.push(next[i]!.id);
    }
    return out;
  };

  const thorough = frame.length <= THOROUGH_LIMIT;
  const starts = thorough ? [depthFirst(), layers.map((l) => [...l])] : [depthFirst()];
  // An order someone already found few crossings in is tried first, so a tie keeps it.
  if (seeded) starts.unshift(seeded.map((l) => [...l]));
  let best = starts[0]!.map((l) => [...l]);
  let bestCount = crossings(best);
  for (const start of starts) {
    let order = start.map((l) => [...l]);
    let stale = 0;
    const count0 = crossings(order);
    if (count0 < bestCount) {
      best = order.map((l) => [...l]);
      bestCount = count0;
    }
    for (let sweep = 0; sweep < 28 && bestCount > 0; sweep += 1) {
      index(order);
      if (sweep % 2 === 0) for (let l = 1; l < order.length; l += 1) sortLayer(order[l]!, up);
      else for (let l = order.length - 2; l >= 0; l -= 1) sortLayer(order[l]!, down);
      if (thorough) transpose(order);
      const count = crossings(order);
      if (count < bestCount) {
        best = order.map((l) => [...l]);
        bestCount = count;
        stale = 0;
      } else if (++stale >= 6) {
        break;
      }
    }
    order = best;
  }
  return best;
}

/**
 * Split ranks that would run past what the caller's `shape` allows into
 * side-by-side sub-columns. With no shape asked for ("any") a rank is only
 * wrapped when it is plainly out of proportion: many times the median rank,
 * which is a heap of siblings and not a shape anybody chose.
 */
function wrapColumns(
  layers: readonly string[][],
  size: ReadonlyMap<string, { w: number; h: number }>,
  lanes: ReadonlySet<string>,
  frame: readonly PlaceItem[],
  opts: PlaceOptions,
): string[][] {
  const heightOf = (col: readonly string[]) =>
    col.reduce((sum, id) => sum + size.get(id)!.h + opts.nodeGap, -opts.nodeGap);
  const heights = layers.map(heightOf).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? 0;
  const area = frame.reduce((sum, i) => sum + (i.w + opts.rankGap) * (i.h + opts.nodeGap), 0);
  // The frame is rotated for a vertical flow, so its y is the page's x.
  const aspect = aspectFor(opts);
  const limit =
    aspect === null
      ? Math.max(1800, median * 4)
      : Math.max(360, isVertical(opts.flow) ? Math.sqrt(area * aspect) : Math.sqrt(area / aspect));

  const columns: string[][] = [];
  for (const layer of layers) {
    const col = layer.filter((id) => !lanes.has(id));
    if (col.length < 2 || heightOf(col) <= limit) {
      columns.push([...layer]);
      continue;
    }
    const parts = Math.min(col.length, Math.ceil(heightOf(col) / limit));
    const per = Math.ceil(layer.length / parts);
    for (let i = 0; i < layer.length; i += per) columns.push(layer.slice(i, i + per));
  }
  return columns;
}

/** Gaps within a modest ratio of the widest all become the widest. A really wide one stays itself. */
function evenedGaps(gaps: readonly number[]): number[] {
  const sorted = [...gaps].sort((a, b) => a - b);
  const out = new Map<number, number>();
  let start = 0;
  for (let i = 1; i <= sorted.length; i += 1) {
    if (i === sorted.length || sorted[i]! > sorted[start]! * 1.6) {
      for (let j = start; j < i; j += 1) out.set(sorted[j]!, sorted[i - 1]!);
      start = i;
    }
  }
  return gaps.map((g) => out.get(g) ?? g);
}

/** The width:height a caller asked for, or null when any shape will do. */
function aspectFor(opts: Pick<PlaceOptions, "shape">): number | null {
  switch (opts.shape) {
    case "wide":
      return 2;
    case "tall":
      return 0.6;
    case "square":
      return 1;
    default:
      return null;
  }
}

/**
 * Where each box sits across the flow. The order is a hard constraint and the
 * wish to sit level with a neighbour a soft one, so each rank is a weighted
 * isotonic fit of those wishes. Lanes weigh most, which is what runs a long
 * line straight rather than bending it around every rank it skips.
 */
function assignCross(
  columns: readonly string[][],
  size: ReadonlyMap<string, { w: number; h: number }>,
  lanes: ReadonlySet<string>,
  up: ReadonlyMap<string, readonly Adjacent[]>,
  down: ReadonlyMap<string, readonly Adjacent[]>,
  opts: PlaceOptions,
): { top: Map<string, number>; centre: (id: string) => number } {
  const sep = (a: string, b: string) => {
    const la = lanes.has(a);
    const lb = lanes.has(b);
    if (la && lb) return LANE_GAP;
    // A line passing between two boxes gets as much room as the boxes give each
    // other. Squeezed in, it reads as touching them and has nowhere to curve.
    if (la || lb) return Math.max(LANE_GAP, opts.nodeGap);
    return opts.nodeGap;
  };
  const stacked = (col: readonly string[]) => {
    let h = 0;
    col.forEach((id, i) => {
      h += size.get(id)!.h;
      if (i) h += sep(col[i - 1]!, id);
    });
    return h;
  };
  const tallest = Math.max(0, ...columns.map(stacked));

  const top = new Map<string, number>();
  columns.forEach((col) => {
    let y = (tallest - stacked(col)) / 2;
    col.forEach((id, i) => {
      if (i) y += sep(col[i - 1]!, id);
      top.set(id, y);
      y += size.get(id)!.h;
    });
  });
  const centre = (id: string) => top.get(id)! + size.get(id)!.h / 2;
  const pairWeight = (a: string, b: string, w: number) => {
    const la = lanes.has(a);
    const lb = lanes.has(b);
    return w * (la && lb ? 8 : la || lb ? 3 : 1);
  };

  const slide = (col: readonly string[], sides: ReadonlyArray<ReadonlyMap<string, readonly Adjacent[]>>) => {
    const offsets: number[] = [];
    let offset = 0;
    col.forEach((id, i) => {
      if (i) offset += sep(col[i - 1]!, id);
      offsets.push(offset);
      offset += size.get(id)!.h;
    });
    const weights: number[] = [];
    const desired = col.map((id, i) => {
      let sum = 0;
      let weight = 0;
      for (const side of sides) {
        for (const n of side.get(id) ?? []) {
          const w = pairWeight(id, n.id, n.w);
          sum += (centre(n.id) + n.other - n.self) * w;
          weight += w;
        }
      }
      weights.push(weight || 0.001);
      const want = weight ? sum / weight : centre(id);
      return want - size.get(id)!.h / 2 - offsets[i]!;
    });
    const fitted = isotonic(desired, weights);
    col.forEach((id, i) => top.set(id, fitted[i]! + offsets[i]!));
  };

  for (let round = 0; round < 10; round += 1) {
    for (const col of columns) slide(col, [up]);
    for (let c = columns.length - 1; c >= 0; c -= 1) slide(columns[c]!, [down]);
  }
  for (let round = 0; round < 3; round += 1) {
    for (const col of columns) slide(col, [up, down]);
    for (let c = columns.length - 1; c >= 0; c -= 1) slide(columns[c]!, [up, down]);
  }

  // A whole column moves as one when that puts several lines dead level at once.
  // Two columns of boxes facing each other, off by half a box, read as a mistake,
  // and no single box can fix it because each is blocked by the next.
  for (let round = 0; round < 3; round += 1) {
    for (let c = 0; c < columns.length; c += 1) {
      const col = columns[c]!;
      const real = col.filter((id) => !lanes.has(id));
      if (real.length < 2) continue;
      const votes = new Map<number, number>();
      for (const id of real) {
        for (const n of [...(up.get(id) ?? []), ...(down.get(id) ?? [])]) {
          const delta = Math.round((centre(n.id) + n.other - n.self - centre(id)) * 2) / 2;
          if (Math.abs(delta) > 160) continue;
          votes.set(delta, (votes.get(delta) ?? 0) + 1);
        }
      }
      let bestDelta = 0;
      let bestVotes = votes.get(0) ?? 0;
      for (const [delta, count] of votes) {
        if (count > bestVotes + (delta === 0 ? 0 : 0.5)) {
          bestVotes = count;
          bestDelta = delta;
        }
      }
      if (bestDelta && bestVotes >= 2) for (const id of col) top.set(id, top.get(id)! + bestDelta);
    }
  }

  // Moves one member of a rank, and anything in its way, keeping their order.
  const place = (col: readonly string[], i: number, y: number) => {
    top.set(col[i]!, y);
    for (let k = i + 1; k < col.length; k += 1) {
      const floor = top.get(col[k - 1]!)! + size.get(col[k - 1]!)!.h + sep(col[k - 1]!, col[k]!);
      if (top.get(col[k]!)! >= floor) break;
      top.set(col[k]!, floor);
    }
    for (let k = i - 1; k >= 0; k -= 1) {
      const ceiling = top.get(col[k + 1]!)! - sep(col[k]!, col[k + 1]!) - size.get(col[k]!)!.h;
      if (top.get(col[k]!)! <= ceiling) break;
      top.set(col[k]!, ceiling);
    }
  };
  // A lane is where its line was going to go. The line is drawn straight between
  // the boxes it joins, wherever the lane ended up, so the lane moves to the line:
  // otherwise the line runs through whatever the lane was keeping out of its way.
  for (let c = 0; c < columns.length; c += 1) {
    const col = columns[c]!;
    col.forEach((id, i) => {
      if (!lanes.has(id)) return;
      let backward = id;
      let steps = 0;
      let from: { y: number } | null = null;
      for (;;) {
        const prev: Adjacent | undefined = (up.get(backward) ?? [])[0];
        if (!prev) break;
        steps += 1;
        if (!lanes.has(prev.id)) {
          from = { y: centre(prev.id) + prev.other };
          break;
        }
        backward = prev.id;
      }
      let forward = id;
      let ahead = 0;
      let to: { y: number } | null = null;
      for (;;) {
        const next: Adjacent | undefined = (down.get(forward) ?? [])[0];
        if (!next) break;
        ahead += 1;
        if (!lanes.has(next.id)) {
          to = { y: centre(next.id) + next.other };
          break;
        }
        forward = next.id;
      }
      if (!from || !to) return;
      const y = from.y + ((to.y - from.y) * steps) / (steps + ahead);
      if (Math.abs(y - top.get(id)!) >= 0.5) place(col, i, y);
    });
  }

  // The main path is a straight line, whatever that takes. Anything in the way in
  // its rank moves aside, keeping its order, and the rank just gets longer.
  for (let c = 1; c < columns.length; c += 1) {
    const col = columns[c]!;
    col.forEach((id, i) => {
      const chain = (up.get(id) ?? []).find((n) => !lanes.has(n.id) && n.w >= CHAIN_WEIGHT);
      if (!chain) return;
      const want = centre(chain.id) + chain.other - chain.self - size.get(id)!.h / 2;
      if (Math.abs(want - top.get(id)!) >= 0.5) place(col, i, want);
    });
  }

  // Close the last few pixels: a line that nearly runs level should run level.
  // A box between two neighbours on one side stays between them, though: lining
  // up with the nearer one would turn a balanced fan into a lopsided one.
  const NEAR = 18;
  const BALANCED = 6;
  for (let pass = 0; pass < 3; pass += 1) {
    for (const col of columns) {
      col.forEach((id, i) => {
        // On the main path already: lining up with a branch would bend it.
        if ([...(up.get(id) ?? []), ...(down.get(id) ?? [])].some((n) => !lanes.has(n.id) && n.w >= CHAIN_WEIGHT)) return;
        const h = size.get(id)!.h;
        const sideOf = (side: readonly Adjacent[] | undefined): number[] => {
          const deltas = (side ?? []).map((n) => centre(n.id) + n.other - n.self - centre(id));
          const reach = deltas.length > 1 ? BALANCED : NEAR;
          return deltas.filter((d) => Math.abs(d) >= 0.5 && Math.abs(d) <= reach);
        };
        const near = [...sideOf(up.get(id)), ...sideOf(down.get(id))].sort((a, b) => Math.abs(a) - Math.abs(b));
        const delta = near[0];
        if (delta === undefined) return;
        const y = top.get(id)! + delta;
        const prev = i ? col[i - 1]! : null;
        const next = i + 1 < col.length ? col[i + 1]! : null;
        if (prev && y < top.get(prev)! + size.get(prev)!.h + sep(prev, id)) return;
        if (next && y + h + sep(id, next) > top.get(next)!) return;
        top.set(id, y);
      });
    }
  }

  // Everything counts toward where the block starts, lanes too: see `finish`.
  const minY = Math.min(...columns.flat().map((id) => top.get(id)! - (lanes.has(id) ? LANE_CLEARANCE : 0)));
  for (const id of top.keys()) top.set(id, top.get(id)! - minY);
  return { top, centre };
}

// ─── Tidy tree ───────────────────────────────────────────────────────────────

/**
 * Each box's single parent, when the piece is a forest once links point
 * forward. Null otherwise: a box with two parents has no tidy place in a tree.
 */
function forestOf(items: readonly PlaceItem[], links: readonly PlaceLink[]): Map<string, string> | null {
  const parent = new Map<string, string>();
  const seen = new Set<string>();
  for (const l of links) {
    if (l.tether) return null;
    const key = pairKey(l.source, l.target);
    if (seen.has(key)) continue;
    seen.add(key);
    if (parent.has(l.target)) return null;
    parent.set(l.target, l.source);
  }
  // A cycle has no root to start from.
  for (const start of parent.keys()) {
    const guard = new Set<string>([start]);
    let cursor = parent.get(start);
    while (cursor !== undefined) {
      if (guard.has(cursor)) return null;
      guard.add(cursor);
      cursor = parent.get(cursor);
    }
  }
  return items.length ? parent : null;
}

/**
 * A tidy tree: a parent centred on its children, subtrees packed as close as
 * their outlines allow (Reingold–Tilford, by contours). Ranks stay aligned, so
 * it reads as levels.
 */
function tidyTree(
  items: readonly PlaceItem[],
  links: readonly PlaceLink[],
  opts: PlaceOptions,
): { placed: PlacedBox[]; width: number; height: number } | null {
  const parent = forestOf(items, links);
  if (!parent) return null;
  const frame = intoFrame(items, opts.flow);
  const size = new Map(frame.map((i) => [i.id, i]));
  const kids = new Map(frame.map((i) => [i.id, [] as string[]]));
  for (const i of frame) {
    const p = parent.get(i.id);
    if (p !== undefined) kids.get(p)!.push(i.id);
  }
  const pulls = opts.pull;
  if (pulls) {
    for (const list of kids.values()) {
      list.sort((a, b) => {
        const pa = pulls.get(a);
        const pb = pulls.get(b);
        return pa && pb ? crossOf(pa, opts.flow) - crossOf(pb, opts.flow) : 0;
      });
    }
  }
  const roots = frame.filter((i) => !parent.has(i.id)).map((i) => i.id);

  const depth = new Map<string, number>();
  const walk = (id: string, d: number) => {
    depth.set(id, d);
    for (const k of kids.get(id)!) walk(k, d + 1);
  };
  roots.forEach((r) => walk(r, 0));

  type Contour = Map<number, { lo: number; hi: number }>;
  const shift = new Map<string, number>();

  const layout = (id: string): Contour => {
    const own = size.get(id)!;
    const d = depth.get(id)!;
    const children = kids.get(id)!;
    const contour: Contour = new Map();
    let first: number | null = null;
    let last = 0;
    for (const child of children) {
      const sub: Contour = layout(child);
      // How far this subtree must move to clear what is already there.
      let offset: number = first === null ? 0 : -Infinity;
      for (const [level, band] of sub) {
        const placed = contour.get(level);
        // Siblings sit a gap apart; further down, a bigger gap keeps one subtree's
        // boxes from reading as part of the next one's.
        const gap = level === d + 1 ? opts.nodeGap : opts.nodeGap * 1.6;
        if (placed) offset = Math.max(offset, placed.hi + gap - band.lo);
      }
      if (!Number.isFinite(offset)) offset = 0;
      shift.set(child, offset);
      for (const [level, band] of sub) {
        const moved = { lo: band.lo + offset, hi: band.hi + offset };
        const placed = contour.get(level);
        contour.set(level, placed ? { lo: Math.min(placed.lo, moved.lo), hi: Math.max(placed.hi, moved.hi) } : moved);
      }
      if (first === null) first = offset;
      last = offset;
    }
    // On an odd number of children the parent sits straight across from the middle
    // one, which reads as a spine; on an even number, midway between the outer two.
    const middle = children.length % 2 === 1 ? children[(children.length - 1) / 2]! : null;
    const mid = first === null ? 0 : middle ? shift.get(middle)! : (first + last) / 2;
    for (const child of children) shift.set(child, shift.get(child)! - mid);
    const out: Contour = new Map();
    for (const [level, band] of contour) out.set(level, { lo: band.lo - mid, hi: band.hi - mid });
    out.set(d, { lo: -own.h / 2, hi: own.h / 2 });
    return out;
  };

  const centres = new Map<string, number>();
  let base = 0;
  for (const root of roots) {
    const contour = layout(root);
    let lo = Infinity;
    let hi = -Infinity;
    for (const band of contour.values()) {
      lo = Math.min(lo, band.lo);
      hi = Math.max(hi, band.hi);
    }
    const at = base - lo;
    const place = (id: string, y: number) => {
      centres.set(id, y);
      for (const k of kids.get(id)!) place(k, y + shift.get(k)!);
    };
    place(root, at);
    base = at + hi + opts.rankGap;
  }

  // Ranks line up, whatever size their boxes.
  const levels = Math.max(...depth.values()) + 1;
  const widths = new Array<number>(levels).fill(0);
  for (const i of frame) widths[depth.get(i.id)!] = Math.max(widths[depth.get(i.id)!]!, i.w);
  const labelRoom = new Array<number>(levels).fill(0);
  for (const l of links) {
    const room = (isVertical(opts.flow) ? l.labelH : l.labelW) ?? 0;
    const d = depth.get(l.source)!;
    if (room) labelRoom[d] = Math.max(labelRoom[d]!, room + 24);
  }
  const portRoom = new Array<number>(levels).fill(0);
  for (const i of frame) {
    const p = parent.get(i.id);
    if (p === undefined) continue;
    const d = depth.get(p)!;
    const offset = Math.abs(centres.get(i.id)! - centres.get(p)!);
    portRoom[d] = Math.max(portRoom[d]!, Math.min(offset - (i.h + size.get(p)!.h) / 2 + 2, opts.rankGap * 3));
  }
  const treeGaps = evenedGaps(
    Array.from({ length: Math.max(0, levels - 1) }, (_, d) => Math.max(opts.rankGap, labelRoom[d]!, portRoom[d]!)),
  );
  const xs = new Array<number>(levels).fill(0);
  for (let d = 1; d < levels; d += 1) xs[d] = xs[d - 1]! + widths[d - 1]! + treeGaps[d - 1]!;

  const placed = frame.map((i) => {
    const d = depth.get(i.id)!;
    return {
      id: i.id,
      x: xs[d]! + (widths[d]! - i.w) / 2,
      y: centres.get(i.id)! - i.h / 2,
      w: i.w,
      h: i.h,
    };
  });
  const minY = Math.min(...placed.map((p) => p.y));
  for (const p of placed) p.y -= minY;
  const width = Math.max(...placed.map((p) => p.x + p.w));
  const height = Math.max(...placed.map((p) => p.y + p.h));
  return outOfFrame(placed, width, height, opts.flow);
}

// ─── Radial ──────────────────────────────────────────────────────────────────

/**
 * Rings around the best-connected box, or one ring when every box is equal (a
 * pure cycle). Each ring grows just until its boxes clear each other. A ring is
 * an ellipse as wide as the boxes are wide: on a true circle the boxes at the
 * top and bottom collide long before the ones at the sides have any company.
 */
function radial(
  items: readonly PlaceItem[],
  links: readonly PlaceLink[],
  opts: PlaceOptions,
): { placed: PlacedBox[]; width: number; height: number } {
  const size = new Map(items.map((i) => [i.id, i]));
  const degree = degreesOf(items, links);
  const neighbours = new Map(items.map((i) => [i.id, [] as string[]]));
  for (const l of links) {
    neighbours.get(l.source)!.push(l.target);
    neighbours.get(l.target)!.push(l.source);
  }
  const ring = [...degree.values()].every((d) => d === 2);
  const stretch = Math.min(
    ring ? 1.35 : 1.7,
    Math.max(1, items.reduce((s, i) => s + i.w, 0) / Math.max(1, items.reduce((s, i) => s + i.h, 0))),
  );

  if (ring) {
    const order: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = items[0]!.id;
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      order.push(cursor);
      cursor = neighbours.get(cursor)!.find((n) => !seen.has(n));
    }
    const angles = order.map((_, i) => -Math.PI / 2 + (i * 2 * Math.PI) / order.length);
    return settleRings([{ ids: order, angles }], size, stretch, null, opts);
  }

  let hub = items[0]!.id;
  for (const i of items) if (degree.get(i.id)! > degree.get(hub)!) hub = i.id;

  // A spanning tree by breadth, so every box hangs off its nearest ring.
  const parent = new Map<string, string>();
  const levelOf = new Map<string, number>([[hub, 0]]);
  const queue = [hub];
  for (let q = 0; q < queue.length; q += 1) {
    const id = queue[q]!;
    for (const n of neighbours.get(id)!) {
      if (levelOf.has(n)) continue;
      levelOf.set(n, levelOf.get(id)! + 1);
      parent.set(n, id);
      queue.push(n);
    }
  }
  const kids = new Map(items.map((i) => [i.id, [] as string[]]));
  for (const [child, p] of parent) kids.get(p)!.push(child);
  const weight = new Map<string, number>();
  const weigh = (id: string): number => {
    const k = kids.get(id)!;
    const w = k.length ? k.reduce((sum, c) => sum + weigh(c), 0) : 1;
    weight.set(id, w);
    return w;
  };
  weigh(hub);

  // Every subtree gets a wedge the size of its leaves, centred on its parent.
  const angle = new Map<string, number>();
  const spread = (id: string, from: number, to: number) => {
    angle.set(id, (from + to) / 2);
    const k = kids.get(id)!;
    const total = k.reduce((sum, c) => sum + weight.get(c)!, 0);
    let at = from;
    for (const c of k) {
      const span = ((to - from) * weight.get(c)!) / total;
      spread(c, at, at + span);
      at += span;
    }
  };
  // The first wedge is centred at the top, so one spoke stands straight up.
  const firstSpan = kids.get(hub)!.length ? (2 * Math.PI * weight.get(kids.get(hub)![0]!)!) / weight.get(hub)! : 0;
  spread(hub, -Math.PI / 2 - firstSpan / 2, (3 * Math.PI) / 2 - firstSpan / 2);

  const levels: Array<{ ids: string[]; angles: number[] }> = [];
  for (const id of queue) {
    const level = levelOf.get(id)!;
    if (level === 0) continue;
    levels[level - 1] ??= { ids: [], angles: [] };
    levels[level - 1]!.ids.push(id);
    levels[level - 1]!.angles.push(angle.get(id)!);
  }
  return settleRings(levels, size, stretch, hub, opts);
}

/** Grow each ring, innermost first, until its boxes clear each other and the ring inside it. */
function settleRings(
  rings: ReadonlyArray<{ ids: readonly string[]; angles: readonly number[] }>,
  size: ReadonlyMap<string, PlaceItem>,
  stretch: number,
  hub: string | null,
  opts: PlaceOptions,
): { placed: PlacedBox[]; width: number; height: number } {
  const placed: PlacedBox[] = [];
  let radius = 0;
  const hubSize = hub ? size.get(hub)! : null;
  if (hubSize) {
    placed.push({ id: hub!, x: -hubSize.w / 2, y: -hubSize.h / 2, w: hubSize.w, h: hubSize.h });
    radius = Math.max(hubSize.w / stretch, hubSize.h) / 2;
  }
  const gap = opts.nodeGap;
  const clear = (a: PlacedBox, b: PlacedBox) =>
    a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y;
  for (const ring of rings) {
    let r = radius + opts.rankGap;
    let boxes: PlacedBox[] = [];
    for (let attempt = 0; attempt < 400; attempt += 1) {
      boxes = ring.ids.map((id, i) => {
        const s = size.get(id)!;
        const cx = Math.cos(ring.angles[i]!) * r * stretch;
        const cy = Math.sin(ring.angles[i]!) * r;
        return { id, x: cx - s.w / 2, y: cy - s.h / 2, w: s.w, h: s.h };
      });
      const ok = boxes.every(
        (b, i) =>
          boxes.slice(i + 1).every((c) => clear(b, c)) && placed.every((c) => clear(b, c)),
      );
      if (ok) break;
      r += 10;
    }
    placed.push(...boxes);
    radius = r + Math.max(...ring.ids.map((id) => size.get(id)!.h)) / 2;
  }
  const minX = Math.min(...placed.map((p) => p.x));
  const minY = Math.min(...placed.map((p) => p.y));
  for (const p of placed) {
    p.x = Math.round(p.x - minX);
    p.y = Math.round(p.y - minY);
  }
  return {
    placed,
    width: Math.max(...placed.map((p) => p.x + p.w)),
    height: Math.max(...placed.map((p) => p.y + p.h)),
  };
}

// ─── Organic ─────────────────────────────────────────────────────────────────

/**
 * Stress majorization: every pair of boxes wants to sit as far apart as the
 * graph says they are, so a mesh takes the shape of its own structure. Starts
 * from a circle in depth-first order, so the result is the same on every run.
 * Overlaps are then pushed apart, and nearly lined-up boxes lined up.
 */
function organic(
  items: readonly PlaceItem[],
  links: readonly PlaceLink[],
  opts: PlaceOptions,
): { placed: PlacedBox[]; width: number; height: number } {
  const n = items.length;
  const index = new Map(items.map((item, i) => [item.id, i]));
  const adjacency: number[][] = items.map(() => []);
  for (const l of links) {
    adjacency[index.get(l.source)!]!.push(index.get(l.target)!);
    adjacency[index.get(l.target)!]!.push(index.get(l.source)!);
  }
  const dist: number[][] = items.map((_, s) => {
    const d = new Array<number>(n).fill(Infinity);
    d[s] = 0;
    const queue = [s];
    for (let q = 0; q < queue.length; q += 1) {
      const u = queue[q]!;
      for (const v of adjacency[u]!) {
        if (d[v] === Infinity) {
          d[v] = d[u]! + 1;
          queue.push(v);
        }
      }
    }
    return d;
  });

  const meanW = items.reduce((s, i) => s + i.w, 0) / n;
  const meanH = items.reduce((s, i) => s + i.h, 0) / n;
  const ideal = Math.hypot(meanW, meanH) + opts.nodeGap * 2;

  const walk: number[] = [];
  const seen = new Set<number>();
  const visit = (u: number) => {
    seen.add(u);
    walk.push(u);
    for (const v of adjacency[u]!) if (!seen.has(v)) visit(v);
  };
  visit(0);
  for (let i = 0; i < n; i += 1) if (!seen.has(i)) visit(i);
  const xs = new Array<number>(n).fill(0);
  const ys = new Array<number>(n).fill(0);
  const startRadius = (ideal * n) / (2 * Math.PI);
  walk.forEach((u, i) => {
    xs[u] = Math.cos((i * 2 * Math.PI) / n) * startRadius;
    ys[u] = Math.sin((i * 2 * Math.PI) / n) * startRadius;
  });

  for (let iter = 0; iter < 90; iter += 1) {
    for (let i = 0; i < n; i += 1) {
      let sumX = 0;
      let sumY = 0;
      let sumW = 0;
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        const d = dist[i]![j]!;
        if (!Number.isFinite(d)) continue;
        const target = d * ideal;
        const w = 1 / (target * target);
        const dx = xs[i]! - xs[j]!;
        const dy = ys[i]! - ys[j]!;
        const len = Math.hypot(dx, dy) || 0.001;
        sumX += w * (xs[j]! + (target * dx) / len);
        sumY += w * (ys[j]! + (target * dy) / len);
        sumW += w;
      }
      if (sumW) {
        xs[i] = sumX / sumW;
        ys[i] = sumY / sumW;
      }
    }
  }

  const boxes: PlacedBox[] = items.map((item, i) => ({
    id: item.id,
    x: xs[i]! - item.w / 2,
    y: ys[i]! - item.h / 2,
    w: item.w,
    h: item.h,
  }));
  alignNear(boxes, Math.min(meanH, meanW) * 0.3);
  separateBoxes(boxes, opts.nodeGap);
  alignNear(boxes, 10, opts.nodeGap);
  separateBoxes(boxes, opts.nodeGap);
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  for (const b of boxes) {
    b.x = Math.round(b.x - minX);
    b.y = Math.round(b.y - minY);
  }
  return {
    placed: boxes,
    width: Math.max(...boxes.map((b) => b.x + b.w)),
    height: Math.max(...boxes.map((b) => b.y + b.h)),
  };
}

/**
 * Push overlapping boxes apart along whichever axis needs the smaller move,
 * until each pair clears by `gap`. Boxes in `pinned` never move: the other one
 * takes the whole push. Keeps every box on the same side of the others where
 * it can, so what was to the left stays to the left.
 */
export function separateBoxes(
  boxes: PlacedBox[],
  gap: number,
  pinned: ReadonlySet<string> = new Set(),
): void {
  for (let sweep = 0; sweep < 300; sweep += 1) {
    let moved = false;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overX = Math.min(a.x + a.w + gap - b.x, b.x + b.w + gap - a.x);
        const overY = Math.min(a.y + a.h + gap - b.y, b.y + b.h + gap - a.y);
        if (overX <= 0 || overY <= 0) continue;
        const fixedA = pinned.has(a.id);
        const fixedB = pinned.has(b.id);
        if (fixedA && fixedB) continue;
        const shareA = fixedA ? 0 : fixedB ? 1 : 0.5;
        const shareB = 1 - shareA;
        moved = true;
        if (overX < overY) {
          const dir = a.x + a.w / 2 <= b.x + b.w / 2 ? 1 : -1;
          a.x -= dir * overX * shareA;
          b.x += dir * overX * shareB;
        } else {
          const dir = a.y + a.h / 2 <= b.y + b.h / 2 ? 1 : -1;
          a.y -= dir * overY * shareA;
          b.y += dir * overY * shareB;
        }
      }
    }
    if (!moved) return;
  }
  // Boxed in by things that can't move, pushing can go round in circles. Whatever
  // is still touching something takes the nearest place that's clear. Overlapping
  // is the one thing a layout is never allowed to do, so this isn't best-effort.
  const touching = (b: PlacedBox) =>
    boxes.some((o) => o !== b && b.x < o.x + o.w + gap && o.x < b.x + b.w + gap && b.y < o.y + o.h + gap && o.y < b.y + b.h + gap);
  for (const box of boxes) {
    if (pinned.has(box.id) || !touching(box)) continue;
    const { x, y } = box;
    const step = Math.max(gap, 16);
    search: for (let ring = 1; ring < 400; ring += 1) {
      for (let i = -ring; i <= ring; i += 1) {
        for (const [dx, dy] of [
          [i, -ring],
          [i, ring],
          [-ring, i],
          [ring, i],
        ] as const) {
          box.x = x + dx * step;
          box.y = y + dy * step;
          if (!touching(box)) break search;
        }
      }
    }
  }
}

/**
 * Bring box centres that nearly share a line onto it. With `keepClear`, a box
 * that would run into a neighbour by moving stays where it is.
 */
export function alignNear(
  boxes: PlacedBox[],
  tolerance: number,
  keepClear?: number,
  pinned: ReadonlySet<string> = new Set(),
): void {
  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? "w" : "h";
    const sorted = [...boxes].sort((a, b) => a[axis] + a[size] / 2 - (b[axis] + b[size] / 2));
    let run: PlacedBox[] = [];
    const settle = () => {
      if (run.length < 2) return;
      const anchor = run.find((b) => pinned.has(b.id));
      const line = anchor
        ? anchor[axis] + anchor[size] / 2
        : run.reduce((sum, b) => sum + b[axis] + b[size] / 2, 0) / run.length;
      for (const b of run) {
        if (pinned.has(b.id)) continue;
        const before = b[axis];
        b[axis] = line - b[size] / 2;
        if (keepClear !== undefined && boxes.some((o) => o !== b && touches(b, o, keepClear))) b[axis] = before;
      }
    };
    for (const box of sorted) {
      const c = box[axis] + box[size] / 2;
      const last = run[run.length - 1];
      if (last && c - (last[axis] + last[size] / 2) > tolerance) {
        settle();
        run = [];
      }
      run.push(box);
    }
    settle();
  }
}

function touches(a: PlacedBox, b: PlacedBox, gap: number): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

// ─── Grid ────────────────────────────────────────────────────────────────────

/**
 * Boxes with nothing to say about each other, in rows and columns, in the
 * order they were given (or facing what they connect to outside, when they
 * do). Asked to `stack`, they line up across the flow while they still fit on
 * a screen, which keeps every box's sides free for the lines coming in; a block
 * otherwise takes the column count that spends the least canvas.
 */
function gridBlock(
  items: PlaceItem[],
  opts: Pick<PlaceOptions, "flow" | "nodeGap" | "rankGap" | "shape" | "pull" | "stack">,
): { placed: PlacedBox[]; width: number; height: number } {
  const pulls = opts.pull;
  if (pulls && items.some((i) => pulls.has(i.id))) {
    const order = new Map(items.map((i, n) => [i.id, n]));
    const along = opts.stack ?? opts.flow;
    const fallback = items.length ? Math.max(...items.map((i) => crossOf(pulls.get(i.id) ?? { x: 0, y: 0 }, along))) : 0;
    items = [...items].sort((a, b) => {
      const pa = pulls.get(a.id);
      const pb = pulls.get(b.id);
      const ca = pa ? crossOf(pa, along) : fallback;
      const cb = pb ? crossOf(pb, along) : fallback;
      return ca - cb || order.get(a.id)! - order.get(b.id)!;
    });
  }
  const n = items.length;
  const aspect = aspectFor(opts);
  const gapX = opts.nodeGap + 12;
  const gapY = opts.nodeGap;

  const measure = (cols: number) => {
    const rows = Math.ceil(n / cols);
    const widths = new Array<number>(cols).fill(0);
    const heights = new Array<number>(rows).fill(0);
    items.forEach((item, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      widths[c] = Math.max(widths[c]!, item.w);
      heights[r] = Math.max(heights[r]!, item.h);
    });
    const W = widths.reduce((a, b) => a + b, 0) + gapX * (cols - 1);
    const H = heights.reduce((a, b) => a + b, 0) + gapY * (rows - 1);
    return { cols, rows, widths, heights, W, H };
  };

  let best = measure(Math.max(1, Math.round(Math.sqrt(n))));
  if (opts.stack && aspect === null && n <= 8) {
    best = isVertical(opts.stack) ? measure(n) : measure(1);
  } else {
    let bestScore = Infinity;
    for (let cols = 1; cols <= n; cols += 1) {
      const m = measure(cols);
      const ratio = m.W / Math.max(1, m.H);
      const score =
        aspect === null
          ? // The least canvas, then the shortest way around it.
            m.W * m.H + (m.W + m.H) ** 2 * 0.5
          : Math.abs(Math.log(ratio / aspect));
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
  }

  const xs = [0];
  for (let c = 1; c < best.cols; c += 1) xs.push(xs[c - 1]! + best.widths[c - 1]! + gapX);
  const ys = [0];
  for (let r = 1; r < best.rows; r += 1) ys.push(ys[r - 1]! + best.heights[r - 1]! + gapY);
  const placed = items.map((item, i) => {
    const c = i % best.cols;
    const r = Math.floor(i / best.cols);
    return {
      id: item.id,
      x: xs[c]! + (best.widths[c]! - item.w) / 2,
      y: ys[r]! + (best.heights[r]! - item.h) / 2,
      w: item.w,
      h: item.h,
    };
  });
  return { placed, width: best.W, height: best.H };
}

// ─── Packing the pieces ──────────────────────────────────────────────────────

/**
 * Lay finished pieces out beside one another: shelves, trying every row count
 * and keeping the one that wastes the least canvas (or lands nearest the shape
 * the caller asked for). A shelf runs ACROSS the flow, so separate left-to-right
 * pipelines read as rows and separate top-down ones as columns. Set end to end,
 * two unrelated flows read as one with an arrow missing.
 */
function packBlocks(
  blocks: ReadonlyArray<{ placed: PlacedBox[]; width: number; height: number }>,
  opts: PlaceOptions,
): { placed: PlacedBox[]; width: number; height: number } {
  if (blocks.length === 1) return blocks[0]!;
  // Wider than any gap inside a piece: that is what says these are separate.
  const gap = Math.max(opts.rankGap * 1.5, opts.nodeGap * 3.5);
  const aspect = aspectFor(opts);
  const order = blocks
    .map((b, i) => ({ b, i }))
    .sort((p, q) => q.b.width * q.b.height - p.b.width * p.b.height || p.i - q.i)
    .map((e) => e.b);

  const vertical = isVertical(opts.flow);
  const major = (b: { width: number; height: number }) => (vertical ? b.width : b.height);
  const minor = (b: { width: number; height: number }) => (vertical ? b.height : b.width);
  const longest = Math.max(...order.map(major));
  const total = order.reduce((sum, b) => sum + major(b) + gap, -gap);

  type Layout = { offsets: Array<{ main: number; cross: number }>; main: number; cross: number };
  const shelve = (limit: number): Layout => {
    const offsets: Layout["offsets"] = [];
    let main = 0;
    let cross = 0;
    let shelf = 0;
    let usedMain = 0;
    for (const b of order) {
      if (main > 0 && main + major(b) > limit) {
        cross += shelf + gap;
        main = 0;
        shelf = 0;
      }
      offsets.push({ main, cross });
      main += major(b) + gap;
      usedMain = Math.max(usedMain, main - gap);
      shelf = Math.max(shelf, minor(b));
    }
    return { offsets, main: usedMain, cross: cross + shelf };
  };

  let best = shelve(longest);
  let bestScore = Infinity;
  const steps = Math.min(16, order.length * 2);
  for (let s = 0; s <= steps; s += 1) {
    const limit = longest + ((total - longest) * s) / Math.max(1, steps);
    const layout = shelve(limit);
    const W = vertical ? layout.main : layout.cross;
    const H = vertical ? layout.cross : layout.main;
    const score = aspect === null ? W * H + (W + H) ** 2 * 0.25 : Math.abs(Math.log(W / Math.max(1, H) / aspect));
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = layout;
    }
  }

  const placed: PlacedBox[] = [];
  order.forEach((b, i) => {
    const at = best.offsets[i]!;
    const dx = vertical ? at.main : at.cross;
    const dy = vertical ? at.cross : at.main;
    for (const p of b.placed) placed.push({ ...p, x: p.x + dx, y: p.y + dy });
  });
  return {
    placed,
    width: vertical ? best.main : best.cross,
    height: vertical ? best.cross : best.main,
  };
}
