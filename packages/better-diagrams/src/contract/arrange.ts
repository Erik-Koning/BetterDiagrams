/**
 * arrange.ts — a whole document, placed.
 *
 * `autoplace.ts` knows boxes and links; this knows what a document asks of
 * them. A group is a box whose contents were arranged first. A zone is a region
 * whose members move with it. A card's children are another canvas. A locked
 * thing stays where it is and everything else is arranged around it. Provider
 * alternates are one box drawn several ways. A line between two nodes in
 * different containers still pulls those containers together, because it is
 * lifted onto the boxes that are being placed at that level.
 *
 * Three ways to get a good picture, in the order an author gets more capable:
 *
 *   autoPlace      nothing to go on: place everything from the graph.
 *   polishLayout   an arrangement exists and is worth keeping: leave it, fix
 *                  what lint finds, move as little as possible.
 *   arrangeBest    don't know which: measure both. An author's arrangement wins
 *                  unless it is clearly worse, so a model that gets better at
 *                  placing boxes keeps more of what it chose, and one that
 *                  can't place them at all is no worse off.
 */
import {
  alignNear,
  flatRanks,
  placeItems,
  separateBoxes,
  type Flow,
  type PlaceEngine,
  type PlaceLink,
  type PlacedBox,
} from "./autoplace";
import { buildScene, lintLayout, titleRect, zoneTitleRect, type LayoutReport, type SceneBox } from "./layout-lint";
import { pageArcs, type Arc } from "./directed/arcs";
import { settleLines } from "./route-lines";
import { floatingSides } from "./geometry";
import { shapeInsets, type NodeShape } from "./shapes";
import {
  COLLAPSED_SIZE,
  CONTAINER_KINDS,
  DESC_FONT_SIZE,
  DEFAULT_FONT_SIZE,
  fieldRowT,
  KIND_SHAPES,
  nodeTextWidth,
  wrappedBoxSize,
  wrappedDescWidth,
  wrappedNodeHeight,
  type DiagramNode,
  type DiagramSettings,
  type DiagramTemplate,
  type LayoutAlgorithm,
  type LayoutDirection,
  type LayoutShape,
  type LayoutSpacing,
} from "./schema";
import { approxTextWidth, wrappedLineCount } from "./text";
import type { DiagramZone } from "./zones";
import { ASSIGNEE_STRIP_HEIGHT, DEPENDENCY_RELATION, hasAssigneeStrip, TASK_KIND } from "./tasks";
import { cardParentIdsOf, frameResolver, variantGroups } from "./layout-frames";

export interface ArrangeOptions {
  containerKinds?: readonly string[];
  /** Which canvases to arrange: see `LayoutOptions.frames`. */
  frames?: "root" | "all" | { drill: string };
  /** Which family of layout. Unset, the document's `settings.layout` decides, then "auto". */
  algorithm?: LayoutAlgorithm;
  /** Which way the picture reads. Unset, the document's `settings.layout` decides, then "auto". */
  direction?: LayoutDirection;
  /** Which way it reads inside groups and zones. Unset, as above. */
  inner?: LayoutDirection;
  /** A shape to aim for; unset, or "any", aims for none. */
  shape?: LayoutShape;
  /** How much room to leave. */
  spacing?: LayoutSpacing;
  /** Explicit gaps, as the studio's modes pass them. Spacing scales whatever these are. */
  rankGap?: number;
  nodeGap?: number;
  padding?: number;
  headerGap?: number;
  /** Grow a box whose words would be cut off, and even up its near-identical neighbours. Default true. */
  fitText?: boolean;
}

const BASE = { rankGap: 96, nodeGap: 40, padding: 32, headerGap: 56 };
const SPACING_SCALE: Record<LayoutSpacing, number> = { compact: 0.72, normal: 1, airy: 1.4 };
/** Most times polish goes round before settling for what it has. */
const POLISH_ROUNDS = 5;
/** Times each container's members are re-ordered against where the last pass put things. */
const REFINE_PASSES = 3;
/** Above this many boxes, Tidy takes the first direction rather than measuring each. */
const COMPARE_LIMIT = 150;
/** The narrowest and widest a box grows to fit its words, before they wrap instead. */
const WIDEST_FIT = 264;

interface Prefs {
  algorithm: LayoutAlgorithm;
  direction: LayoutDirection;
  inner: LayoutDirection;
  shape: LayoutShape;
  rankGap: number;
  nodeGap: number;
  padding: number;
  headerGap: number;
  /** An arrangement from outside the families: see `PlaceEngine`. */
  engine?: PlaceEngine;
}

function resolvePrefs(template: DiagramTemplate, options: ArrangeOptions): Prefs {
  const saved: NonNullable<DiagramSettings["layout"]> = template.settings?.layout ?? {};
  const scale = SPACING_SCALE[options.spacing ?? saved.spacing ?? "normal"];
  return {
    algorithm: options.algorithm ?? saved.algorithm ?? "auto",
    direction: options.direction ?? saved.direction ?? "auto",
    inner: options.inner ?? saved.inner ?? "auto",
    shape: options.shape ?? saved.shape ?? "any",
    rankGap: saved.rankGap ?? Math.round((options.rankGap ?? BASE.rankGap) * scale),
    nodeGap: saved.nodeGap ?? Math.round((options.nodeGap ?? BASE.nodeGap) * scale),
    padding: options.padding ?? BASE.padding,
    headerGap: options.headerGap ?? BASE.headerGap,
  };
}

/** The gaps an arrangement of this document would use: its own if it stores them, else what its spacing gives. */
export function layoutGaps(template: DiagramTemplate, options: ArrangeOptions = {}): { rankGap: number; nodeGap: number } {
  const { rankGap, nodeGap } = resolvePrefs(template, options);
  return { rankGap, nodeGap };
}

// ─── Text that fits ──────────────────────────────────────────────────────────

const FIXED_BOX_KINDS = new Set(["text", "point", "table", "enum", "group", TASK_KIND]);
const DIAMOND_KINDS = new Set(["decision", "milestone"]);

/**
 * A box big enough for its words. An author who left a label too long for its
 * box wanted the label: growing costs nothing, and "Payment reconcili…" tells a
 * reader nothing. Past `WIDEST_FIT` the text wraps rather than widening further.
 * Only ever grows, a note included, and never touches a locked box.
 */
function growToFit(n: DiagramNode): DiagramNode {
  if (n.locked || n.wrap || n.fields?.length) return n;
  if (n.kind === "text") {
    // A note needs room for its words. One drawn bigger than they need was drawn
    // that size by somebody, so it grows to fit and never shrinks to fit.
    const font = n.fontSize ?? 13;
    const lines = wrappedLineCount(n.label, font, "sans", Math.max(24, n.w - 24));
    const w = Math.max(n.w, lines > 1 ? n.w : Math.max(120, Math.min(n.w, Math.ceil(approxTextWidth(n.label, font, "sans") + 32))));
    const h = Math.max(n.h, Math.ceil(lines * font * 1.35 + 22));
    return w === n.w && h === n.h ? n : { ...n, w, h };
  }
  if (FIXED_BOX_KINDS.has(n.kind as string)) return n;

  const hasIcon = !!n.icon;
  const font = n.fontSize ?? DEFAULT_FONT_SIZE;
  const shape: NodeShape = KIND_SHAPES[n.kind as string] ?? "card";
  const titleNeed = approxTextWidth(n.label, font, "sans");
  // The room a label actually gets: what the card's chrome leaves, less what the
  // shape's own corners take. A pipe's round ends and a diamond's points both eat in.
  const room = (w: number) => nodeTextWidth(w, hasIcon) - shapeInsets(shape, w, n.h).inline * 2;
  const describes = (w: number) =>
    !n.description || wrappedLineCount(n.description, DESC_FONT_SIZE, "sans", wrappedDescWidth(w)) <= 2;
  let w = n.w;
  while (w < WIDEST_FIT && (room(w) < titleNeed || !describes(w))) w += 4;
  if (room(w) >= titleNeed && describes(w)) return w === n.w ? n : { ...n, w };
  // Past the widest a box should go: show it all by wrapping, which grows it downward.
  if (DIAMOND_KINDS.has(n.kind as string)) {
    const fit = wrappedBoxSize(n, { w, h: n.h }, hasIcon, "diamond", "grow");
    return { ...n, wrap: true, w: fit.w, h: fit.h };
  }
  return { ...n, w, wrap: true, h: Math.max(n.h, wrappedNodeHeight(n, w, hasIcon, shape)) };
}

/**
 * Near-identical boxes side by side made the same size. Sizes that differ by a
 * few pixels read as sloppiness, not as meaning; ones that differ a lot are left
 * alone, because then the difference is probably the point.
 */
function evenUpSizes(nodes: readonly DiagramNode[]): DiagramNode[] {
  const groups = new Map<string, DiagramNode[]>();
  for (const n of nodes) {
    if (n.locked || n.wrap || FIXED_BOX_KINDS.has(n.kind as string) || n.fields?.length) continue;
    const key = `${n.parentId ?? ""}|${n.zoneId ?? ""}|${n.kind}`;
    const g = groups.get(key);
    if (g) g.push(n);
    else groups.set(key, [n]);
  }
  const size = new Map<string, { w: number; h: number }>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const widest = Math.max(...group.map((n) => n.w));
    const tallest = Math.max(...group.map((n) => n.h));
    for (const n of group) {
      const w = widest / n.w <= 1.5 ? widest : n.w;
      const h = tallest / n.h <= 1.4 ? tallest : n.h;
      if (w !== n.w || h !== n.h) size.set(n.id, { w, h });
    }
  }
  return nodes.map((n) => (size.has(n.id) ? { ...n, ...size.get(n.id)! } : n));
}

// ─── The containers on a canvas ──────────────────────────────────────────────

export interface Cluster {
  key: string;
  kind: "root" | "group" | "zone";
  node?: DiagramNode;
  zone?: DiagramZone;
  /** Boxes placed directly in this container. */
  members: Member[];
}

export interface Member {
  /** A node id, or `zone:<id>` for a zone. */
  id: string;
  node?: DiagramNode;
  cluster?: Cluster;
  /** Stays where it is, and everything else keeps clear of it. */
  pinned: boolean;
}

export interface CanvasModel {
  frame: string | null;
  root: Cluster;
  clusters: Map<string, Cluster>;
  /** Which member stands for this node at this cluster's level, or null when it is outside it. */
  ownerAt(cluster: Cluster, nodeId: string): string | null;
  containerOf(itemId: string): string | null;
  leadOf(id: string): string;
}

const ZONE_ITEM = "zone:";

/** How far past what it goes round the innermost arc swings, and how much further each one outside it. */
const ARC_CLEAR = 48;
const ARC_STEP = 28;
/** How far apart the ends of arcs sharing a side of a box sit: room for an arrowhead each. */
const ARC_END_PITCH = 14;
/** The radius an arc turns its corners on, room allowing. */
const ARC_CORNER = 40;
/** How far past a corner the first of the two points holding the run straight sits; the second is three times this further on. */
const ARC_HOLD = 6;

/**
 * Which zone, if any, a zone is drawn inside: it sits within the host's box AND
 * draws on top of it, which is how the document says "island". Position alone
 * isn't enough, since a model's first guess at two zones can land one in the
 * other by accident, and being moved out is what they need.
 */
function hostsOf(zones: readonly DiagramZone[]): Map<string, string> {
  const hosts = new Map<string, string>();
  for (const z of zones) {
    let best: DiagramZone | undefined;
    for (const h of zones) {
      if (h === z) continue;
      const inside =
        (z.z ?? 0) > (h.z ?? 0) &&
        z.x >= h.x && z.y >= h.y && z.x + z.w <= h.x + h.w && z.y + z.h <= h.y + h.h && h.w * h.h > z.w * z.h;
      if (inside && (!best || h.w * h.h < best.w * best.h)) best = h;
    }
    if (best) hosts.set(z.id, best.id);
  }
  return hosts;
}

/** Sort one canvas's boxes into the containers that position them. */
export function canvasModel(
  template: DiagramTemplate,
  frame: string | null,
  containerKinds: readonly string[],
): CanvasModel {
  const byId = new Map(template.nodes.map((n) => [n.id, n]));
  const cardParents = cardParentIdsOf(template, containerKinds);
  const frameOf = frameResolver(template, cardParents);
  const variantOf = variantGroups(template);
  const leadOf = (id: string) => variantOf.get(id) ?? id;
  const zones = frame === null ? (template.zones ?? []) : [];
  const zoneIds = new Set(zones.map((z) => z.id));
  const hosts = hostsOf(zones);

  const hasKids = new Set(template.nodes.map((n) => n.parentId).filter((p): p is string => !!p));
  const clusters = new Map<string, Cluster>();
  const root: Cluster = { key: "root", kind: "root", members: [] };
  clusters.set("root", root);
  for (const z of zones) clusters.set(`zone:${z.id}`, { key: `zone:${z.id}`, kind: "zone", zone: z, members: [] });
  for (const n of template.nodes) {
    if (frameOf(n.id) === frame && hasKids.has(n.id) && !cardParents.has(n.id)) {
      clusters.set(`group:${n.id}`, { key: `group:${n.id}`, kind: "group", node: n, members: [] });
    }
  }

  const containerByItem = new Map<string, string>();
  const clusterKeyOf = (n: DiagramNode): string => {
    if (n.parentId && byId.has(n.parentId) && !cardParents.has(n.parentId)) return `group:${n.parentId}`;
    if (!n.parentId && n.zoneId && zoneIds.has(n.zoneId)) return `zone:${n.zoneId}`;
    return "root";
  };
  for (const n of template.nodes) {
    if (frameOf(n.id) !== frame) continue;
    const key = clusterKeyOf(n);
    containerByItem.set(n.id, key);
    const lead = leadOf(n.id);
    if (lead !== n.id) continue; // An alternate follows the box it stands in for.
    const group = clusters.get(`group:${n.id}`);
    clusters.get(key)?.members.push({
      id: n.id,
      node: n,
      ...(group ? { cluster: group } : {}),
      pinned: !!n.locked,
    });
  }
  for (const z of zones) {
    const host = hosts.get(z.id);
    const key = host ? `zone:${host}` : "root";
    const item = `${ZONE_ITEM}${z.id}`;
    containerByItem.set(item, key);
    const cluster = clusters.get(`zone:${z.id}`)!;
    // A zone holding something locked can't move without moving what the lock holds.
    const holdsLocked = template.nodes.some((n) => n.zoneId === z.id && n.locked);
    clusters.get(key)!.members.push({ id: item, cluster, pinned: !!z.locked || holdsLocked });
  }
  // The same goes for anything that holds something held, however deep: a group
  // with a locked box in it, the zone that group is in, the zone an island sits on.
  // Moving any of them would carry the locked thing across the canvas with it.
  const holds = (cluster: Cluster): boolean => {
    let any = false;
    for (const m of cluster.members) {
      if (m.cluster && holds(m.cluster)) m.pinned = true;
      if (m.pinned) any = true;
    }
    return any;
  };
  holds(root);

  const ownerAt = (cluster: Cluster, nodeId: string): string | null => {
    let cursor: string | null = leadOf(nodeId);
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      const key = containerByItem.get(cursor);
      if (key === undefined) {
        // Deeper than this canvas: a card's child stands as the card.
        const parent: string | null | undefined = byId.get(cursor)?.parentId;
        cursor = parent ? leadOf(parent) : null;
        continue;
      }
      if (key === cluster.key) return cursor;
      if (key === "root") return null;
      cursor = key.startsWith("group:") ? key.slice(6) : `${ZONE_ITEM}${key.slice(5)}`;
    }
    return null;
  };

  return {
    frame,
    root,
    clusters,
    ownerAt,
    containerOf: (id) => containerByItem.get(id) ?? null,
    leadOf,
  };
}

function wordsRoom(edge: { label?: string; tech?: string; seq?: number }): { labelW?: number; labelH?: number } {
  // How far a line's words reach; the rank gap it crosses makes room for them.
  if (!edge.label && !edge.tech && !edge.seq) return {};
  const text = Math.max(
    edge.label ? approxTextWidth(edge.label, 11, "mono") : 0,
    edge.tech ? approxTextWidth(`[${edge.tech}]`, 9, "mono") : 0,
  );
  return { labelW: Math.min(text, 176), labelH: 44 };
}

// ─── Composing one canvas ────────────────────────────────────────────────────

interface Composed {
  positions: Map<string, { x: number; y: number }>;
  sizes: Map<string, { w: number; h: number }>;
  zones: Map<string, { x: number; y: number; w: number; h: number }>;
  /** Boxes placed by a family with no direction: their lines float. */
  free: Set<string>;
  /** Which way a box's own container flows. Absent means the canvas's flow. */
  innerFlow: Map<string, Flow>;
  /** Boxes laid out as one ring: their lines arc around it. */
  rings: Array<Set<string>>;
  /** Channels long lines were laid through, each with where its two boxes were when it was. */
  routes: LaidRoute[];
}

/**
 * A channel kept for a long line (`PlacedRoute`), with where its two boxes sat
 * in the same coordinates. The boxes go on to be moved with their container,
 * so the points are carried to wherever the boxes end up, if both went together.
 */
interface LaidRoute {
  from: string;
  to: string;
  fromAt: { x: number; y: number };
  toAt: { x: number; y: number };
  points: Array<{ x: number; y: number }>;
  flow: Flow;
}

function composeCanvas(
  template: DiagramTemplate,
  frame: string | null,
  prefs: Prefs,
  flow: Flow,
  innerFlow: Flow,
  containerKinds: readonly string[],
  out: Composed,
): void {
  const model = canvasModel(template, frame, containerKinds);
  const nested = model.clusters.size > 1;
  const nodeById = new Map(template.nodes.map((n) => [n.id, n]));

  // The rank everything would take if containers didn't exist.
  const flatLeaf = (id: string): string | null => {
    let cursor: string | null = model.leadOf(id);
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor) && model.containerOf(cursor) === null) {
      guard.add(cursor);
      const parent: string | null | undefined = nodeById.get(cursor)?.parentId;
      cursor = parent ? model.leadOf(parent) : null;
    }
    return cursor && model.containerOf(cursor) !== null ? cursor : null;
  };
  const ranks = new Map<string, number>();
  if (nested) {
    const flatLinks: PlaceLink[] = [];
    const touched = new Set<string>();
    for (const e of template.edges) {
      const a = flatLeaf(e.source);
      const b = flatLeaf(e.target);
      if (!a || !b || a === b) continue;
      touched.add(a);
      touched.add(b);
      flatLinks.push({ source: a, target: b, ...(e.relation === DEPENDENCY_RELATION || e.secondary ? { tether: true } : {}) });
    }
    const flat = prefs.engine ? prefs.engine.ranks([...touched], flatLinks) : flatRanks([...touched], flatLinks);
    for (const [id, r] of flat) ranks.set(id, r);
  }
  const rankOfMember = (m: Member): number | undefined => {
    if (!m.cluster) return ranks.get(m.id);
    let least: number | undefined = m.node ? ranks.get(m.id) : undefined;
    for (const inner of m.cluster.members) {
      const r = rankOfMember(inner);
      if (r !== undefined && (least === undefined || r < least)) least = r;
    }
    return least;
  };

  const containerSet = new Set(containerKinds);
  const links = template.edges;
  const chips = new Set(
    template.nodes.filter((n) => n.collapsed && containerSet.has(n.kind as string)).map((n) => n.id),
  );

  /** A member's box as this level spaces it, before its contents are known. */
  const leafSize = (n: DiagramNode) => {
    const h = hasAssigneeStrip(n) ? n.h + ASSIGNEE_STRIP_HEIGHT : n.h;
    return chips.has(n.id) ? { ...COLLAPSED_SIZE } : { w: n.w, h };
  };

  /** A zone nobody has put anything in: it keeps the size it was drawn. */
  const isEmptyZone = (m: Member): m is Member & { cluster: Cluster } => !!m.cluster?.zone && m.cluster.members.length === 0;
  /** Locked by a person, as against held in place by something locked inside it. */
  const lockedItself = (m: Member) => (m.node ? !!m.node.locked : !!m.cluster?.zone?.locked);
  // A drilled canvas starts a little in from its corner; the visible one starts at its corner.
  const rootOrigin = frame === null ? { x: 0, y: 0 } : { x: prefs.padding, y: prefs.headerGap };

  type Laid = {
    /** The container's own size when it isn't pinned. */
    width: number;
    height: number;
    placed: PlacedBox[];
    children: Map<string, Laid>;
    inset: { x: number; y: number };
  };

  const layCluster = (
    cluster: Cluster,
    pull: ReadonlyMap<string, { x: number; y: number }> | undefined,
    ports?: (item: string, nodeId: string) => { x: number; y: number } | undefined,
    parentFlow: Flow = flow,
  ): Laid => {
    const children = new Map<string, Laid>();
    const items: Array<{ id: string; w: number; h: number }> = [];
    const pinned: PlacedBox[] = [];
    const notes: Array<{ id: string; w: number; h: number }> = [];
    for (const m of cluster.members) {
      // A note belongs to the picture as a whole, so it goes above it. Parked among
      // the boxes, it reads as a caption for whichever one happens to be nearest.
      if (m.node?.kind === "text" && !m.pinned) {
        notes.push({ id: m.id, w: m.node.w, h: m.node.h });
        continue;
      }
      if (m.pinned) {
        const own = m.node ? (m.cluster ? { w: m.node.w, h: m.node.h } : leafSize(m.node)) : { w: m.cluster!.zone!.w, h: m.cluster!.zone!.h };
        // A lock holds the frame where it is and the size it is. What's inside isn't
        // locked by that, and left alone it would stay piled wherever it was.
        const held = m.cluster ? layCluster(m.cluster, pull, ports, cluster.kind === "root" ? flow : innerFlow) : undefined;
        if (held) children.set(m.id, held);
        // A frame that isn't locked itself, only kept in place by something locked
        // inside it, still grows to hold the rest of what's in it.
        const grows = !!held && !lockedItself(m) && !(m.node && chips.has(m.node.id));
        const size = grows ? { w: Math.max(own.w, held!.width), h: Math.max(own.h, held!.height) } : own;
        pinned.push({ id: m.id, x: 0, y: 0, ...size });
        continue;
      }
      if (m.cluster) {
        const laid = layCluster(m.cluster, pull, ports, cluster.kind === "root" ? flow : innerFlow);
        children.set(m.id, laid);
        if (m.node && chips.has(m.node.id)) {
          items.push({ id: m.id, ...COLLAPSED_SIZE });
        } else if (isEmptyZone(m)) {
          // A zone with nothing in it keeps the size it was drawn, so that's the
          // room it's given: spaced as anything smaller, it lands on its neighbours.
          items.push({ id: m.id, w: m.cluster.zone!.w, h: m.cluster.zone!.h });
        } else {
          items.push({ id: m.id, w: laid.width, h: laid.height });
        }
      } else if (m.node) {
        items.push({ id: m.id, ...leafSize(m.node) });
      }
    }

    const flowHere = cluster.kind === "root" ? flow : innerFlow;
    const flowsVertically = flowHere === "down" || flowHere === "up";
    // Lines lifted onto the boxes placed at this level.
    const placeLinks: PlaceLink[] = [];
    const pairWeight = new Map<string, number>();
    for (const e of links) {
      const a = model.ownerAt(cluster, e.source);
      const b = model.ownerAt(cluster, e.target);
      if (!a || !b || a === b) continue;
      // A line ends where a row or a nested box puts it, not at the middle of the
      // box being placed, so that's what should sit level with the other end.
      const rowOffset = (nodeId: string, fieldId: string | undefined, item: string) => {
        if (!fieldId || item !== nodeId) return undefined;
        const n = nodeById.get(nodeId);
        const t = n ? fieldRowT(n, fieldId) : undefined;
        return n && t !== undefined ? { x: 0, y: t * n.h - n.h / 2 } : undefined;
      };
      // A card spaced with its assignee tabs under it has a middle higher than the
      // middle of that room, and that's where its lines arrive.
      const tabOffset = (nodeId: string, item: string) => {
        const n = item === nodeId ? nodeById.get(nodeId) : undefined;
        return n && hasAssigneeStrip(n) && !flowsVertically ? { x: 0, y: -ASSIGNEE_STRIP_HEIGHT / 2 } : undefined;
      };
      const sourcePort = rowOffset(e.source, e.startField, a) ?? tabOffset(e.source, a) ?? ports?.(a, e.source);
      const targetPort = rowOffset(e.target, e.endField, b) ?? tabOffset(e.target, b) ?? ports?.(b, e.target);
      placeLinks.push({
        source: a,
        target: b,
        ...wordsRoom(e),
        ...(e.relation === DEPENDENCY_RELATION || e.secondary ? { tether: true } : {}),
        ...(e.direction === "none" || e.direction === "both" ? { undirected: true } : {}),
        ...(sourcePort ? { sourcePort } : {}),
        ...(targetPort ? { targetPort } : {}),
      });
      pairWeight.set(`${a}\u0000${b}`, (pairWeight.get(`${a}\u0000${b}`) ?? 0) + 1);
    }
    // Between containers, the heavy links say what comes after what. One stray
    // line from the event bus to a table must not push a whole data tier a column
    // further out; it still draws, it just doesn't get to decide where things go.
    if (cluster.members.some((m) => m.cluster)) {
      const heaviest = new Map<string, number>();
      for (const [key, weight] of pairWeight) {
        const target = key.split("\u0000")[1]!;
        heaviest.set(target, Math.max(heaviest.get(target) ?? 0, weight));
      }
      for (const link of placeLinks) {
        const weight = pairWeight.get(`${link.source}\u0000${link.target}`)!;
        if (weight * 2 < (heaviest.get(link.target) ?? 0)) link.tether = true;
      }
    }
    const memberPull = new Map<string, { x: number; y: number }>();
    if (pull) {
      for (const it of items) {
        const p = pull.get(`${cluster.key}\u0000${it.id}`);
        if (p) memberPull.set(it.id, p);
      }
    }
    const ownFlow = cluster.kind === "root" ? flow : innerFlow;
    // A container's members rank with the whole canvas when lines leave it; on a
    // canvas with no containers, or for a family picked by name, the graph is enough.
    // With nothing joining its members, a container has no order to keep: it stacks.
    const leaves =
      cluster.kind !== "root" &&
      placeLinks.length > 0 &&
      links.some((e) => !!model.ownerAt(cluster, e.source) !== !!model.ownerAt(cluster, e.target));
    const hints = new Map<string, number>();
    if (nested && leaves && (prefs.algorithm === "auto" || prefs.algorithm === "layered")) {
      for (const m of cluster.members) {
        const r = rankOfMember(m);
        if (r !== undefined && !m.pinned) hints.set(m.id, r);
      }
    }
    const placeOptions = {
      algorithm: prefs.algorithm,
      flow: ownFlow,
      rankGap: prefs.rankGap,
      nodeGap: prefs.nodeGap,
      shape: cluster.kind === "root" ? prefs.shape : ("any" as const),
      ...(memberPull.size ? { pull: memberPull } : {}),
      ...(cluster.kind !== "root" ? { stack: parentFlow } : {}),
      ...(hints.size ? { rankHint: hints, together: true } : {}),
      ...(prefs.engine ? { engine: prefs.engine } : {}),
    };
    let placement = placeItems(items, placeLinks, placeOptions);
    for (const id of placement.free) out.free.add(id);
    out.rings.push(...placement.rings);

    // Containers sharing a rank are made the same size across it. Frames that step
    // in and out by a few dozen pixels look accidental; a column of equal frames
    // reads as a column. Their contents stay centred in the extra room.
    const evenUpFrames = () => {
      const vertical = ownFlow === "down" || ownFlow === "up";
      const ranks = new Map<number, PlacedBox[]>();
      for (const p of placement.placed) {
        if (!children.has(p.id)) continue;
        const member = cluster.members.find((m) => m.id === p.id);
        if (member?.node && chips.has(member.node.id)) continue;
        if (member && isEmptyZone(member)) continue;
        const key = Math.round((vertical ? p.y : p.x + p.w / 2) / 8);
        const rank = ranks.get(key);
        if (rank) rank.push(p);
        else ranks.set(key, [p]);
      }
      let changed = false;
      for (const rank of ranks.values()) {
        if (rank.length < 2) continue;
        const widest = Math.max(...rank.map((p) => (vertical ? p.h : p.w)));
        for (const p of rank) {
          const own = vertical ? p.h : p.w;
          // Only frames that nearly match already: a small frame stretched to a big
          // neighbour's size is just a frame with a lot of nothing in it.
          if (own === widest || widest / own > 2) continue;
          const child = children.get(p.id)!;
          const extra = widest - own;
          if (vertical) {
            child.height += extra;
            child.inset.y += extra / 2;
          } else {
            child.width += extra;
            child.inset.x += extra / 2;
          }
          const item = items.find((i) => i.id === p.id)!;
          item.w = child.width;
          item.h = child.height;
          changed = true;
        }
      }
      return changed;
    };
    if (evenUpFrames()) {
      placement = placeItems(items, placeLinks, placeOptions);
    }

    if (cluster.kind !== "root" && innerFlow !== flow) for (const it of items) out.innerFlow.set(it.id, innerFlow);

    // Channels are for lines between two boxes placed here, as themselves: a line
    // into a container ends somewhere inside it, which this level knows nothing of.
    for (const route of placement.routes) {
      const isBox = (id: string) => {
        const member = cluster.members.find((m) => m.id === id);
        return !!member?.node && !member.cluster;
      };
      const a = placement.placed.find((p) => p.id === route.from);
      const b = placement.placed.find((p) => p.id === route.to);
      if (!a || !b || !isBox(route.from) || !isBox(route.to)) continue;
      out.routes.push({ from: route.from, to: route.to, fromAt: { x: a.x, y: a.y }, toAt: { x: b.x, y: b.y }, points: route.points, flow: ownFlow });
    }

    const placed = placement.placed;
    if (notes.length) {
      // A row above what's there, wrapping at its width.
      const across = Math.max(placement.width, ...notes.map((n) => n.w));
      let x = 0;
      let y = 0;
      let rowH = 0;
      const row: PlacedBox[] = [];
      for (const note of notes) {
        if (x > 0 && x + note.w > across) {
          x = 0;
          y += rowH + prefs.nodeGap / 2;
          rowH = 0;
        }
        row.push({ id: note.id, x, y, w: note.w, h: note.h });
        x += note.w + prefs.nodeGap / 2;
        rowH = Math.max(rowH, note.h);
      }
      const drop = placed.length ? y + rowH + prefs.nodeGap : 0;
      for (const p of placed) p.y += drop;
      placed.push(...row);
    }
    // Keep clear of what is pinned, in this container's own coordinates.
    const inset = {
      x: prefs.padding,
      y: cluster.kind === "root" ? 0 : prefs.headerGap,
    };
    let titleSlack = 0;
    if (cluster.kind !== "root" && (flow === "down" || flow === "up" || ownFlow === "down" || ownFlow === "up")) {
      // Lines arrive from above when the flow runs down, and a box at the left of
      // the frame would take its line straight through the frame's name.
      const chip = cluster.node
        ? titleRect({ x: 0, y: 0, w: Infinity, h: 0, node: cluster.node }).w
        : zoneTitleRect({ ...cluster.zone!, x: 0, y: 0, w: Infinity }).w;
      const firstRow = placed.length ? Math.min(...placed.map((p) => p.y)) : 0;
      for (const p of placed) {
        if (p.y > firstRow + 4) continue;
        const centre = inset.x + p.x + p.w / 2;
        if (centre < chip + 28) titleSlack = Math.max(titleSlack, chip + 28 - centre);
      }
      titleSlack = Math.ceil(titleSlack);
      inset.x += titleSlack;
    }
    if (pinned.length) {
      // Where this container's own (0,0) falls, in the coordinates its members are
      // stored in: a zone's are on the canvas, a group's are relative to the group,
      // and a drilled canvas starts a little in from its corner. A zone held here
      // is stored on the canvas like any box in a zone.
      const originX = cluster.kind === "zone" ? cluster.zone!.x + inset.x : cluster.kind === "group" ? inset.x : rootOrigin.x;
      const originY = cluster.kind === "zone" ? cluster.zone!.y + inset.y : cluster.kind === "group" ? inset.y : rootOrigin.y;
      const anchored: PlacedBox[] = pinned.map((p) => {
        const m = cluster.members.find((x) => x.id === p.id)!;
        const at = m.node ?? m.cluster!.zone!;
        return { ...p, x: at.x - originX, y: at.y - originY };
      });
      if (cluster.kind === "root" && frame === null) {
        // Start where the pinned boxes are, so the rest gathers around them.
        const minX = Math.min(...anchored.map((a) => a.x));
        const minY = Math.min(...anchored.map((a) => a.y));
        for (const p of placed) {
          p.x += minX;
          p.y += minY;
        }
      }
      // Inside a frame, making way for what's held must not mean leaving by the top
      // or the left: the frame can grow down and to the right, and that's all. Two
      // walls nothing can be pushed through stand where those edges are.
      const far = 1e6;
      const walls: PlacedBox[] =
        cluster.kind === "root"
          ? []
          : [
              { id: "\u0001wall-left", x: -far - prefs.nodeGap, y: -far, w: far, h: far * 2 },
              { id: "\u0001wall-top", x: -far, y: -far - prefs.nodeGap, w: far * 2, h: far },
            ];
      const everything = [...anchored, ...walls, ...placed];
      separateBoxes(everything, prefs.nodeGap, new Set([...anchored, ...walls].map((a) => a.id)));
      for (const p of placed) {
        p.x = Math.round(p.x);
        p.y = Math.round(p.y);
      }
      placed.push(...anchored);
    }

    const maxX = Math.max(0, ...placed.map((p) => p.x + p.w));
    const maxY = Math.max(0, ...placed.map((p) => p.y + p.h));
    let width = maxX + prefs.padding * 2 + titleSlack * 2;
    let height = maxY + prefs.headerGap + prefs.padding;
    if (cluster.kind === "group") {
      width = Math.max(160, width);
      height = Math.max(120, height);
    } else if (cluster.kind === "zone") {
      // A shape that isn't a rectangle loses its corners: room for that, contents centred.
      const shape = cluster.zone!.shape;
      if (shape !== "rect" && shape !== "rounded") {
        width = Math.round(width * 1.35);
        height = Math.round(height * 1.35);
        inset.x = Math.round((width - maxX) / 2);
        inset.y = Math.round((height - maxY) / 2);
      }
      width = Math.max(200, width);
      height = Math.max(140, height);
    }
    return { width, height, placed, children, inset };
  };

  /** Write a laid container out, with `origin` being where its content's (0,0) falls on the canvas. */
  const emit = (
    cluster: Cluster,
    laid: Laid,
    origin: { x: number; y: number },
    absolute: Map<string, { x: number; y: number }>,
  ) => {
    for (const p of laid.placed) {
      const m = cluster.members.find((x) => x.id === p.id);
      if (!m) continue;
      const abs = { x: origin.x + p.x, y: origin.y + p.y };
      if (m.pinned) {
        absolute.set(m.id, abs);
        const held = laid.children.get(m.id);
        if (m.cluster && held) {
          // Held where it is, and grown if it had to: see `layCluster`.
          if (m.node && (p.w !== m.node.w || p.h !== m.node.h)) out.sizes.set(m.node.id, { w: p.w, h: p.h });
          const zone = m.node ? undefined : m.cluster.zone;
          if (zone && (p.w !== zone.w || p.h !== zone.h)) out.zones.set(zone.id, { x: zone.x, y: zone.y, w: p.w, h: p.h });
          emit(m.cluster, held, { x: abs.x + held.inset.x, y: abs.y + held.inset.y }, absolute);
        }
        continue;
      }
      if (m.node) {
        // A group's members are stored relative to it; everything else is on the canvas.
        const relative = cluster.kind === "group";
        const groupAbs = relative ? absolute.get(cluster.node!.id)! : { x: 0, y: 0 };
        out.positions.set(m.node.id, { x: abs.x - groupAbs.x, y: abs.y - groupAbs.y });
        absolute.set(m.id, abs);
        const child = laid.children.get(m.id);
        if (m.cluster && child) {
          out.sizes.set(m.node.id, { w: child.width, h: child.height });
          emit(m.cluster, child, { x: abs.x + child.inset.x, y: abs.y + child.inset.y }, absolute);
        }
      } else if (m.cluster?.zone) {
        const child = laid.children.get(m.id);
        if (child) {
          const hasContents = m.cluster.members.length > 0;
          out.zones.set(m.cluster.zone.id, {
            x: abs.x,
            y: abs.y,
            w: hasContents ? child.width : m.cluster.zone.w,
            h: hasContents ? child.height : m.cluster.zone.h,
          });
          absolute.set(m.id, abs);
          emit(m.cluster, child, { x: abs.x + child.inset.x, y: abs.y + child.inset.y }, absolute);
        }
      }
    }
  };

  // First pass: where everything would go, knowing nothing about the outside.
  let laid = layCluster(model.root, undefined);
  let placedAt = new Map<string, { x: number; y: number }>();
  emit(model.root, laid, rootOrigin, placedAt);

  // Then, with the containers placed, order each one's members to face what they
  // connect to outside it, and sit each box level with where its lines really end.
  // That moves things, which gives the next pass something better to aim at. A
  // canvas with no nesting has nothing to refine.
  const passes = template.nodes.length > COMPARE_LIMIT ? 1 : REFINE_PASSES;
  for (let pass = 0; pass < passes && model.clusters.size > 1; pass += 1) {
    const here = placedAt;
    const centreOf = (nodeId: string): { x: number; y: number } | undefined => {
      const lead = model.leadOf(nodeId);
      const p = here.get(lead);
      const n = nodeById.get(lead);
      return p && n ? { x: p.x + n.w / 2, y: p.y + n.h / 2 } : undefined;
    };
    const sum = new Map<string, { x: number; y: number; n: number }>();
    const add = (key: string, at: { x: number; y: number } | undefined) => {
      if (!at) return;
      const s = sum.get(key) ?? { x: 0, y: 0, n: 0 };
      sum.set(key, { x: s.x + at.x, y: s.y + at.y, n: s.n + 1 });
    };
    for (const cluster of model.clusters.values()) {
      if (cluster.kind === "root") continue;
      for (const e of links) {
        const a = model.ownerAt(cluster, e.source);
        const b = model.ownerAt(cluster, e.target);
        if (a && !b) add(`${cluster.key}\u0000${a}`, centreOf(e.target));
        else if (b && !a) add(`${cluster.key}\u0000${b}`, centreOf(e.source));
      }
    }
    const pull = new Map<string, { x: number; y: number }>();
    for (const [key, s] of sum) pull.set(key, { x: s.x / s.n, y: s.y / s.n });

    // Where each line really lands inside the item it was lifted onto.
    const boxOfItem = (id: string): { x: number; y: number; w: number; h: number } | undefined => {
      const at = here.get(id);
      if (!at) return undefined;
      if (id.startsWith(ZONE_ITEM)) {
        const z = out.zones.get(id.slice(ZONE_ITEM.length));
        return z ? { x: at.x, y: at.y, w: z.w, h: z.h } : undefined;
      }
      const n = nodeById.get(id);
      if (!n) return undefined;
      const size = out.sizes.get(id) ?? leafSize(n);
      return { x: at.x, y: at.y, w: size.w, h: size.h };
    };
    const portCache = new Map<string, { x: number; y: number } | undefined>();
    for (const cluster of model.clusters.values()) {
      for (const m of cluster.members) {
        if (!m.cluster) continue;
        const outer = boxOfItem(m.id);
        if (!outer) continue;
        for (const e of links) {
          for (const end of [e.source, e.target]) {
            if (model.ownerAt(cluster, end) !== m.id) continue;
            const inner = centreOf(end);
            if (!inner) continue;
            portCache.set(`${m.id}\u0000${end}`, {
              x: inner.x - (outer.x + outer.w / 2),
              y: inner.y - (outer.y + outer.h / 2),
            });
          }
        }
      }
    }
    if (!pull.size && !portCache.size) break;
    out.positions.clear();
    out.sizes.clear();
    out.zones.clear();
    out.free.clear();
    out.innerFlow.clear();
    out.rings.length = 0;
    out.routes.length = 0;
    laid = layCluster(model.root, pull, (item, nodeId) => portCache.get(`${item}\u0000${nodeId}`));
    placedAt = new Map();
    emit(model.root, laid, rootOrigin, placedAt);
  }
}

// ─── The document ────────────────────────────────────────────────────────────

/** The directions worth trying when the author didn't say. */
function candidateFlows(template: DiagramTemplate): Flow[] {
  // A row anchor only exists on a table's left and right faces, and a work plan
  // reads as time: both are left to right whatever a score would say.
  const sideways =
    template.edges.some((e) => e.startField || e.endField) ||
    template.nodes.some((n) => n.kind === TASK_KIND || !!n.fields?.length);
  if (sideways) return ["right"];
  const flowchart = template.nodes.some((n) => n.kind === "decision" || n.kind === "terminator");
  return flowchart ? ["down", "right"] : ["right", "down"];
}

function canvasesInScope(template: DiagramTemplate, options: ArrangeOptions): Array<string | null> {
  const frames = options.frames ?? "root";
  if (frames === "root") return [null];
  if (frames !== "all") return [frames.drill];
  return [null, ...cardParentIdsOf(template, options.containerKinds ?? CONTAINER_KINDS)];
}

/** Whether a canvas in scope has containers, so an inner flow means anything. */
function hasContainers(template: DiagramTemplate): boolean {
  return (template.zones?.length ?? 0) > 0 || template.nodes.some((n) => !!n.parentId);
}

function composeDocument(
  template: DiagramTemplate,
  prefs: Prefs,
  flow: Flow,
  innerFlow: Flow,
  options: ArrangeOptions,
): DiagramTemplate {
  const containerKinds = options.containerKinds ?? CONTAINER_KINDS;
  const canvases = canvasesInScope(template, options);
  const cardParents = cardParentIdsOf(template, containerKinds);
  const frameOf = frameResolver(template, cardParents);
  const inScope = new Set(canvases);

  // The words get their room first: everything after this is spaced by the real boxes.
  let nodes = template.nodes;
  if (options.fitText !== false) {
    const scoped = (n: DiagramNode) => inScope.has(frameOf(n.id));
    nodes = evenUpSizes(nodes.map((n) => (scoped(n) ? growToFit(n) : n))).map((n, i) =>
      scoped(template.nodes[i]!) ? n : template.nodes[i]!,
    );
  }
  const sized: DiagramTemplate = { ...template, nodes };

  const composed: Composed = { positions: new Map(), sizes: new Map(), zones: new Map(), free: new Set(), innerFlow: new Map(), rings: [], routes: [] };
  const routes: LaidRoute[] = [];
  const positions = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, { w: number; h: number }>();
  const zones = new Map<string, { x: number; y: number; w: number; h: number }>();
  const free = new Set<string>();
  const inner = new Map<string, Flow>();
  const rings: Array<Set<string>> = [];
  for (const canvas of canvases) {
    composeCanvas(sized, canvas, prefs, flow, innerFlow, containerKinds, composed);
    for (const [k, v] of composed.positions) positions.set(k, v);
    for (const [k, v] of composed.sizes) sizes.set(k, v);
    for (const [k, v] of composed.zones) zones.set(k, v);
    for (const k of composed.free) free.add(k);
    for (const [k, v] of composed.innerFlow) inner.set(k, v);
    rings.push(...composed.rings);
    routes.push(...composed.routes);
    composed.rings.length = 0;
    composed.routes.length = 0;
    composed.positions.clear();
    composed.sizes.clear();
    composed.zones.clear();
    composed.free.clear();
    composed.innerFlow.clear();
  }

  const variantOf = variantGroups(sized);
  const placedNodes = sized.nodes.map((node) => {
    const lead = variantOf.get(node.id) ?? node.id;
    const position = node.locked ? undefined : positions.get(lead);
    const size = node.locked ? undefined : sizes.get(node.id);
    return {
      ...node,
      ...(position ?? {}),
      ...(size ?? {}),
    };
  });
  const placedZones = (sized.zones ?? []).map((z) => {
    const box = z.locked ? undefined : zones.get(z.id);
    return box ? { ...z, ...box } : z;
  });

  // Hand-placed routes described where the boxes used to be, and a side the last
  // layout chose was its opinion about boxes that have now moved. A route a
  // person drew between two boxes that are both still where they were, and the
  // size they were, describes the picture as well as it ever did: it stays.
  const touched = (id: string) => inScope.has(frameOf(id));
  const boxOn = (nodes: readonly DiagramNode[]) => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return (id: string): string | undefined => {
      const n = byId.get(id);
      if (!n) return undefined;
      let { x, y } = n;
      const guard = new Set<string>([id]);
      // Up through the groups it's in, as far as the canvas it's drawn on.
      for (let p = n.parentId; p && !guard.has(p) && !cardParents.has(p); ) {
        guard.add(p);
        const parent = byId.get(p);
        if (!parent) break;
        x += parent.x;
        y += parent.y;
        p = parent.parentId;
      }
      return `${x},${y},${n.w},${n.h}`;
    };
  };
  const boxBefore = boxOn(template.nodes);
  const boxAfter = boxOn(placedNodes);
  const stayed = (id: string) => boxBefore(id) === boxAfter(id);
  const keptRoutes = new Set<string>();
  const edges = sized.edges.map((e) => {
    if (!touched(e.source) && !touched(e.target)) return e;
    if (!e.points && !e.start?.auto && !e.end?.auto) return e;
    if (e.points && !e.start?.auto && !e.end?.auto && stayed(e.source) && stayed(e.target)) {
      keptRoutes.add(e.id);
      return e;
    }
    const { points: _stale, ...rest } = e;
    if (rest.start?.auto) delete rest.start;
    if (rest.end?.auto) delete rest.end;
    return rest;
  });

  const placedDoc: DiagramTemplate = {
    ...sized,
    nodes: placedNodes,
    edges,
    ...(placedZones.length ? { zones: placedZones } : {}),
  };
  let levelled = levelAcrossContainers(placedDoc, canvases, flow, containerKinds, prefs.nodeGap);
  if (keptRoutes.size && levelled !== placedDoc) {
    // Levelling slid a box after all: a route kept for it has gone stale like any other.
    const boxLevelled = boxOn(levelled.nodes);
    const still = (id: string) => boxBefore(id) === boxLevelled(id);
    levelled = {
      ...levelled,
      edges: levelled.edges.map((e) => {
        if (!keptRoutes.has(e.id) || (still(e.source) && still(e.target))) return e;
        const { points: _stale, ...rest } = e;
        return rest;
      }),
    };
  }
  return pinFlowSides(channelled(levelled, routes, cardParents), canvases, flow, inner, free, rings, containerKinds);
}

/** How far apart lines sharing one channel run. */
const CHANNEL_PITCH = 10;

/**
 * Draw long lines through the channels the layout kept for them. A channel is
 * carried to where its two boxes ended up, and dropped if they didn't go
 * together (one was levelled, or pushed off something locked): then the line
 * is drawn as any other. A line a person has pinned, or that ends on a row, is
 * theirs and stays as it is; a line out of or into a decision leaves by the
 * point that says which answer it is; and a line running back against the flow
 * goes round the outside instead, as an arc.
 */
function channelled(doc: DiagramTemplate, routes: readonly LaidRoute[], cardParents: ReadonlySet<string>): DiagramTemplate {
  if (!routes.length) return doc;
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const absolute = (id: string) => {
    const n = byId.get(id);
    if (!n) return undefined;
    let { x, y } = n;
    const guard = new Set<string>([id]);
    // Up through the groups it's in, as far as the canvas it's drawn on.
    for (let p = n.parentId; p && !guard.has(p) && !cardParents.has(p); ) {
      guard.add(p);
      const parent = byId.get(p);
      if (!parent) break;
      x += parent.x;
      y += parent.y;
      p = parent.parentId;
    }
    return { x, y };
  };
  const carried = new Map<string, { route: LaidRoute; dx: number; dy: number }>();
  for (const route of routes) {
    const a = absolute(route.from);
    const b = absolute(route.to);
    if (!a || !b) continue;
    const dx = a.x - route.fromAt.x;
    const dy = a.y - route.fromAt.y;
    if (Math.abs(b.x - route.toAt.x - dx) > 1 || Math.abs(b.y - route.toAt.y - dy) > 1) continue;
    carried.set(`${route.from}\u0000${route.to}`, { route, dx, dy });
  }
  if (!carried.size) return doc;
  const isDiamond = (id: string) => KIND_SHAPES[byId.get(id)?.kind as string] === "diamond";
  /** How many lines have taken each channel so far: the second runs beside the first. */
  const taken = new Map<string, number>();
  const sharing = new Map<string, number>();
  const channelOf = (e: DiagramTemplate["edges"][number]) => {
    if (e.points?.length || e.start || e.end || e.startField || e.endField) return undefined;
    // A decision branches from its points, one way for each answer: which point a
    // line leaves by is the picture's meaning, and is decided where sides are pinned.
    if (isDiamond(e.source) || isDiamond(e.target)) return undefined;
    const forward = carried.get(`${e.source}\u0000${e.target}`);
    if (forward) return { key: `${e.source}\u0000${e.target}`, ...forward, reversed: false };
    // Only a line with no direction of its own is drawn back along a channel.
    const back = (e.direction ?? "forward") !== "forward" ? carried.get(`${e.target}\u0000${e.source}`) : undefined;
    return back ? { key: `${e.target}\u0000${e.source}`, ...back, reversed: true } : undefined;
  };
  for (const e of doc.edges) {
    const channel = channelOf(e);
    if (channel) sharing.set(channel.key, (sharing.get(channel.key) ?? 0) + 1);
  }
  return {
    ...doc,
    edges: doc.edges.map((e) => {
      const channel = channelOf(e);
      if (!channel) return e;
      const { route, dx, dy, key, reversed } = channel;
      const nth = taken.get(key) ?? 0;
      taken.set(key, nth + 1);
      const aside = (nth - ((sharing.get(key) ?? 1) - 1) / 2) * CHANNEL_PITCH;
      const sideways = route.flow === "right" || route.flow === "left";
      const points = route.points.map((p): [number, number] => [Math.round(p.x + dx + (sideways ? 0 : aside)), Math.round(p.y + dy + (sideways ? aside : 0))]);
      const out = route.flow === "right" ? "right" : route.flow === "left" ? "left" : route.flow === "down" ? "bottom" : "top";
      const into = route.flow === "right" ? "left" : route.flow === "left" ? "right" : route.flow === "down" ? "top" : "bottom";
      return {
        ...e,
        start: { side: reversed ? into : out, auto: true },
        end: { side: reversed ? out : into, auto: true },
        points: reversed ? points.reverse() : points,
      };
    }),
  };
}

/** How far a whole container or box slides so a line that crosses a frame runs level. */
const LEVEL_REACH = 72;

/**
 * Lines between containers are placed by where each container's insides were the
 * pass before, so they land a few pixels off level, and a few pixels off is what
 * reads as a mistake. Once everything is final, a top-level container or box slides
 * across the flow to put the line it's the most lines' worth off level on dead level,
 * as long as that doesn't run it into a neighbour.
 */
function levelAcrossContainers(
  doc: DiagramTemplate,
  canvases: ReadonlyArray<string | null>,
  flow: Flow,
  containerKinds: readonly string[],
  gap: number,
): DiagramTemplate {
  if (!hasContainers(doc)) return doc;
  const axis: "x" | "y" = flow === "right" || flow === "left" ? "y" : "x";
  const size: "w" | "h" = axis === "y" ? "h" : "w";
  let current = doc;
  for (const frame of canvases) {
    for (let round = 0; round < 3; round += 1) {
      const scene = buildScene(current, { containerKinds, frame });
      const owner = (b: { id: string; ancestors: string[]; node: DiagramNode }) => {
        const outer = b.ancestors[b.ancestors.length - 1] ?? b.id;
        const top = scene.boxes.find((x) => x.id === outer);
        return top?.node.zoneId ? `zone:${top.node.zoneId}` : outer;
      };
      const rectOf = (id: string) => {
        if (id.startsWith(ZONE_ITEM)) return scene.zones.find((z) => `${ZONE_ITEM}${z.id}` === id);
        return scene.boxes.find((b) => b.id === id);
      };
      const tops = new Set<string>();
      for (const b of scene.boxes) tops.add(owner(b));
      for (const z of scene.zones) tops.add(`${ZONE_ITEM}${z.id}`);

      let changed = false;
      for (const item of tops) {
        const rect = rectOf(item);
        if (!rect) continue;
        if (carriesLock(current, item)) continue;
        const votes = new Map<number, number>();
        for (const line of scene.lines) {
          const a = owner(line.source);
          const b = owner(line.target);
          if (a === b || (a !== item && b !== item) || line.edge.points?.length) continue;
          const mine = a === item ? line.source : line.target;
          const other = a === item ? line.target : line.source;
          const delta = Math.round(other[axis] + other[size] / 2 - (mine[axis] + mine[size] / 2));
          if (delta === 0 || Math.abs(delta) > LEVEL_REACH) continue;
          votes.set(delta, (votes.get(delta) ?? 0) + 1);
        }
        let bestDelta = 0;
        let bestVotes = 0;
        for (const [delta, count] of votes) {
          if (count > bestVotes || (count === bestVotes && Math.abs(delta) < Math.abs(bestDelta))) {
            bestDelta = delta;
            bestVotes = count;
          }
        }
        if (!bestDelta) continue;
        const moved = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
        moved[axis] += bestDelta;
        const blocked = [...tops].some((otherItem) => {
          if (otherItem === item) return false;
          const o = rectOf(otherItem);
          return !!o && moved.x < o.x + o.w + gap / 2 && o.x < moved.x + moved.w + gap / 2 && moved.y < o.y + o.h + gap / 2 && o.y < moved.y + moved.h + gap / 2;
        });
        if (blocked) continue;
        current = shiftTopItem(current, item, axis, bestDelta);
        changed = true;
        break;
      }
      if (!changed) break;
    }
  }
  return current;
}

/** A zone and every zone drawn on it, which all move together. */
function zonesMovingWith(doc: DiagramTemplate, zoneId: string): Set<string> {
  const hosts = hostsOf(doc.zones ?? []);
  const moving = new Set([zoneId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [inner, host] of hosts) {
      if (moving.has(host) && !moving.has(inner)) {
        moving.add(inner);
        grew = true;
      }
    }
  }
  return moving;
}

/**
 * Whether moving a top-level box, group or zone would move something locked: the
 * thing itself, a zone drawn on it, or any box it holds, however deep. A lock is
 * a place on the canvas, so whatever carries one stays where it is too.
 */
function carriesLock(doc: DiagramTemplate, item: string): boolean {
  const carried = new Set<string>();
  if (item.startsWith(ZONE_ITEM)) {
    const moving = zonesMovingWith(doc, item.slice(ZONE_ITEM.length));
    if ((doc.zones ?? []).some((z) => moving.has(z.id) && z.locked)) return true;
    for (const n of doc.nodes) if (!n.parentId && n.zoneId && moving.has(n.zoneId)) carried.add(n.id);
  } else {
    carried.add(item);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of doc.nodes) {
      if (n.parentId && carried.has(n.parentId) && !carried.has(n.id)) {
        carried.add(n.id);
        grew = true;
      }
    }
  }
  return doc.nodes.some((n) => carried.has(n.id) && n.locked);
}

/** Move a top-level box, group or zone, with whatever a zone holds. */
function shiftTopItem(doc: DiagramTemplate, item: string, axis: "x" | "y", delta: number): DiagramTemplate {
  if (!item.startsWith(ZONE_ITEM)) {
    return { ...doc, nodes: doc.nodes.map((n) => (n.id === item ? { ...n, [axis]: n[axis] + delta } : n)) };
  }
  const moving = zonesMovingWith(doc, item.slice(ZONE_ITEM.length));
  return {
    ...doc,
    zones: (doc.zones ?? []).map((z) => (moving.has(z.id) ? { ...z, [axis]: z[axis] + delta } : z)),
    nodes: doc.nodes.map((n) => (!n.parentId && n.zoneId && moving.has(n.zoneId) ? { ...n, [axis]: n[axis] + delta } : n)),
  };
}

/**
 * Lines leave a box the way the flow runs and enter the next one from behind.
 *
 * Floating lines take whichever axis has the wider gap, so a line to a box far
 * across the flow would leave through the box's top and land on its neighbour's
 * bottom while its siblings run side to side, and the picture stops reading as a
 * flow. Most lines are already right: the rank gaps grow to make them so. The few
 * a gap can't fix get their sides pinned, marked `auto` so the next Tidy doesn't
 * mistake them for a person's choice. A line against the flow keeps floating, as
 * does anything placed with no direction: a ring's spokes face where they go.
 */
function pinFlowSides(
  doc: DiagramTemplate,
  canvases: ReadonlyArray<string | null>,
  flow: Flow,
  innerFlows: ReadonlyMap<string, Flow>,
  free: ReadonlySet<string>,
  rings: ReadonlyArray<ReadonlySet<string>>,
  containerKinds: readonly string[],
): DiagramTemplate {
  type Side = "top" | "right" | "bottom" | "left";
  const pins = new Map<string, { start: Side; end: Side; points?: Array<[number, number]>; startT?: number; endT?: number }>();
  for (const frame of canvases) {
    const scene = buildScene(doc, { containerKinds, frame });
    const solid = scene.boxes.filter((b) => !b.frame);
    const extent = {
      x: Math.min(...solid.map((b) => b.x)),
      y: Math.min(...solid.map((b) => b.y)),
      w: Math.max(...solid.map((b) => b.x + b.w)) - Math.min(...solid.map((b) => b.x)),
      h: Math.max(...solid.map((b) => b.y + b.h)) - Math.min(...solid.map((b) => b.y)),
    };
    const ringCentre = (ring: ReadonlySet<string>) => {
      const members = scene.boxes.filter((b) => ring.has(b.id));
      if (!members.length) return undefined;
      return {
        x: members.reduce((sum, b) => sum + b.x + b.w / 2, 0) / members.length,
        y: members.reduce((sum, b) => sum + b.y + b.h / 2, 0) / members.length,
      };
    };
    // Lines that go round are given their sides and depths together: see `directed/arcs.ts`.
    const arcs: Array<Arc & { sideways: boolean; s: SceneBox; t: SceneBox }> = [];
    /** Lines leaving what an arc goes round, toward each side: each is one it would cut across. */
    const tollOf = (run: readonly SceneBox[], s: SceneBox, t: SceneBox, sideways: boolean) => {
      const inside = new Set(run.filter((b) => b !== s && b !== t).map((b) => b.id));
      let low = 0;
      let high = 0;
      for (const l of scene.lines) {
        const here = inside.has(l.source.id) ? l.source : inside.has(l.target.id) ? l.target : null;
        if (!here) continue;
        const there = here === l.source ? l.target : l.source;
        if (inside.has(there.id) || there.id === s.id || there.id === t.id) continue;
        const from = sideways ? here.y + here.h / 2 : here.x + here.w / 2;
        const to = sideways ? there.y + there.h / 2 : there.x + there.w / 2;
        if (to < from - 1) low += 1;
        else if (to > from + 1) high += 1;
      }
      return { low, high };
    };
    const arcOf = (id: string, s: SceneBox, t: SceneBox, sideways: boolean, run: readonly SceneBox[], natural: "low" | "high") => {
      const toll = tollOf(run, s, t, sideways);
      arcs.push({
        id,
        sideways,
        s,
        t,
        from: sideways ? s.x + s.w / 2 : s.y + s.h / 2,
        to: sideways ? t.x + t.w / 2 : t.y + t.h / 2,
        wallLow: Math.min(...run.map((b) => (sideways ? b.y : b.x))),
        wallHigh: Math.max(...run.map((b) => (sideways ? b.y + b.h : b.x + b.w))),
        tollLow: toll.low,
        tollHigh: toll.high,
        natural,
      });
    };
    for (const line of scene.lines) {
      const { edge, source: s, target: t } = line;
      // A route a person drew, kept because neither end moved, already says how its line runs.
      if (s.id === t.id || edge.start || edge.end || edge.startField || edge.endField || edge.points?.length) continue;
      // Around a ring or a hub, a line that leaves and arrives on the same axis
      // wiggles. Leaving on one axis and arriving on the other arcs, and the arc
      // should bulge away from the middle, so it follows the picture's shape.
      const ring = rings.find((r) => r.has(s.id) && r.has(t.id));
      if (ring) {
        const sc = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
        const tc = { x: t.x + t.w / 2, y: t.y + t.h / 2 };
        const apartX = Math.abs(tc.x - sc.x) > (s.w + t.w) / 4;
        const apartY = Math.abs(tc.y - sc.y) > (s.h + t.h) / 4;
        const centre = ringCentre(ring);
        if (!apartX || !apartY || !centre) continue;
        const acrossFirst = Math.hypot(tc.x - centre.x, sc.y - centre.y);
        const downFirst = Math.hypot(sc.x - centre.x, tc.y - centre.y);
        const goRight = tc.x > sc.x;
        const goDown = tc.y > sc.y;
        pins.set(
          edge.id,
          acrossFirst >= downFirst
            ? { start: goRight ? "right" : "left", end: goDown ? "top" : "bottom" }
            : { start: goDown ? "bottom" : "top", end: goRight ? "left" : "right" },
        );
        continue;
      }
      if (free.has(s.id) || free.has(t.id)) continue;
      const sameContainer = (s.ancestors[0] ?? s.node.zoneId ?? "") === (t.ancestors[0] ?? t.node.zoneId ?? "");
      const own = sameContainer ? (innerFlows.get(s.id) ?? innerFlows.get(t.id) ?? flow) : flow;
      const ahead =
        own === "right"
          ? t.x >= s.x + s.w
          : own === "left"
            ? t.x + t.w <= s.x
            : own === "down"
              ? t.y >= s.y + s.h
              : t.y + t.h <= s.y;
      const behind =
        own === "right"
          ? t.x + t.w <= s.x
          : own === "left"
            ? t.x >= s.x + s.w
            : own === "down"
              ? t.y + t.h <= s.y
              : t.y >= s.y + s.h;
      const flowsSideways = own === "right" || own === "left";

      // A line against the flow goes round the outside: out of a side and into the
      // same side, as a C, so it can't be mistaken for the flow it runs against.
      if (behind && !edge.points?.length) {
        const across = flowsSideways
          ? { near: s.y + s.h / 2, middle: extent.y + extent.h / 2, low: "top" as const, high: "bottom" as const }
          : { near: s.x + s.w / 2, middle: extent.x + extent.w / 2, low: "left" as const, high: "right" as const };
        const side = across.near < across.middle ? across.low : across.high;
        // Traffic both ways between neighbours is one road with two lanes: the
        // answer runs straight back beside the request, face to face. Sent round
        // the outside it reads as a second, unrelated connection.
        if (scene.lines.some((l) => l.source.id === t.id && l.target.id === s.id)) {
          const corridor = flowsSideways
            ? { x: Math.min(s.x + s.w, t.x + t.w), y: Math.min(s.y, t.y), w: Math.abs(s.x - t.x) - Math.min(s.w, t.w), h: Math.max(s.y + s.h, t.y + t.h) - Math.min(s.y, t.y) }
            : { x: Math.min(s.x, t.x), y: Math.min(s.y + s.h, t.y + t.h), w: Math.max(s.x + s.w, t.x + t.w) - Math.min(s.x, t.x), h: Math.abs(s.y - t.y) - Math.min(s.h, t.h) };
          const clear = !solid.some(
            (b) => b !== s && b !== t && b.x < corridor.x + corridor.w && corridor.x < b.x + b.w && b.y < corridor.y + corridor.h && corridor.y < b.y + b.h,
          );
          if (clear) {
            pins.set(
              edge.id,
              own === "right"
                ? { start: "left", end: "right" }
                : own === "left"
                  ? { start: "right", end: "left" }
                  : own === "down"
                    ? { start: "top", end: "bottom" }
                    : { start: "bottom", end: "top" },
            );
            continue;
          }
        }
        const round = solid.filter((b) =>
          flowsSideways
            ? b.x + b.w > Math.min(s.x, t.x) && b.x < Math.max(s.x + s.w, t.x + t.w)
            : b.y + b.h > Math.min(s.y, t.y) && b.y < Math.max(s.y + s.h, t.y + t.h),
        );
        arcOf(edge.id, s, t, flowsSideways, round.length ? round : [s, t], side === across.low ? "low" : "high");
        continue;
      }
      if (!ahead) continue;

      // A line to a box further down its own column, with others between: going
      // through is out, and threading past them wobbles. One clean arc around the
      // whole run reads as what it is, a line that skips ahead.
      if (!edge.points?.length) {
        const across = flowsSideways
          ? { sc: s.y + s.h / 2, tc: t.y + t.h / 2, reach: Math.min(s.h, t.h) / 2 }
          : { sc: s.x + s.w / 2, tc: t.x + t.w / 2, reach: Math.min(s.w, t.w) / 2 };
        const inTheWay = solid.filter((b) => {
          if (b === s || b === t) return false;
          const between = flowsSideways
            ? b.x + b.w > Math.min(s.x + s.w, t.x + t.w) && b.x < Math.max(s.x, t.x)
            : b.y + b.h > Math.min(s.y + s.h, t.y + t.h) && b.y < Math.max(s.y, t.y);
          if (!between) return false;
          const level = Math.min(across.sc, across.tc);
          const far = Math.max(across.sc, across.tc);
          return flowsSideways
            ? b.y < far + across.reach && b.y + b.h > level - across.reach
            : b.x < far + across.reach && b.x + b.w > level - across.reach;
        });
        if (inTheWay.length && Math.abs(across.sc - across.tc) <= across.reach) {
          const low: Side = flowsSideways ? "top" : "left";
          const high: Side = flowsSideways ? "bottom" : "right";
          // The side with fewer other lines to get tangled in.
          const count = (want: Side) =>
            scene.lines.filter((l) => {
              if (l === line || (l.source.id !== s.id && l.target.id !== t.id && l.source.id !== t.id && l.target.id !== s.id)) return false;
              const a = l.source.id === s.id || l.source.id === t.id ? l.target : l.source;
              const here = flowsSideways ? a.y + a.h / 2 : a.x + a.w / 2;
              return want === low ? here < across.sc - 1 : here > across.sc + 1;
            }).length;
          const side = count(low) <= count(high) ? low : high;
          arcOf(edge.id, s, t, flowsSideways, [...inTheWay, s, t], side === low ? "low" : "high");
          continue;
        }
      }

      // A decision has four points to branch from. A branch that carries straight
      // on keeps going out of the far point; one that heads off to the side leaves
      // by the point on that side and comes round into the top of what it reaches.
      if (KIND_SHAPES[s.node.kind as string] === "diamond") {
        const out = scene.lines.filter((l) => l.source.id === s.id && l.target.id !== s.id);
        const sc = flowsSideways ? s.y + s.h / 2 : s.x + s.w / 2;
        const tc = flowsSideways ? t.y + t.h / 2 : t.x + t.w / 2;
        const offset = tc - sc;
        if (out.length >= 2 && Math.abs(offset) > (flowsSideways ? s.h : s.w) / 4) {
          const entry: Side =
            own === "right" ? "left" : own === "left" ? "right" : own === "down" ? "top" : "bottom";
          const start: Side = flowsSideways ? (offset < 0 ? "top" : "bottom") : offset < 0 ? "left" : "right";
          pins.set(edge.id, { start, end: entry });
          continue;
        }
      }
      // Likewise into a decision or a milestone: more than one line can't all land
      // on one point. What comes from level with it takes the near point, and what
      // comes from the side takes the point on that side.
      if (KIND_SHAPES[t.node.kind as string] === "diamond") {
        const arrivals = scene.lines.filter((l) => l.target.id === t.id && l.source.id !== t.id);
        const sc = flowsSideways ? s.y + s.h / 2 : s.x + s.w / 2;
        const tc = flowsSideways ? t.y + t.h / 2 : t.x + t.w / 2;
        const offset = sc - tc;
        if (arrivals.length >= 2 && Math.abs(offset) > (flowsSideways ? t.h : t.w) / 4) {
          const exit: Side = own === "right" ? "right" : own === "left" ? "left" : own === "down" ? "bottom" : "top";
          const end: Side = flowsSideways ? (offset < 0 ? "top" : "bottom") : offset < 0 ? "left" : "right";
          pins.set(edge.id, { start: exit, end });
          continue;
        }
      }
      const want =
        own === "right"
          ? ({ start: "right", end: "left" } as const)
          : own === "left"
            ? ({ start: "left", end: "right" } as const)
            : own === "down"
              ? ({ start: "bottom", end: "top" } as const)
              : ({ start: "top", end: "bottom" } as const);
      const floats = floatingSides(
        { x: s.x, y: s.y, width: s.w, height: s.h },
        { x: t.x, y: t.y, width: t.w, height: t.h },
      );
      if (floats.start !== want.start || floats.end !== want.end) pins.set(edge.id, want);
    }
    // Arcs along the flow share its two sides; arcs across it share the other two.
    for (const sideways of [true, false]) {
      const group = arcs.filter((a) => a.sideways === sideways);
      const pages = pageArcs(group);
      const sideOf = (arc: (typeof group)[number]): Side => {
        const low = pages.get(arc.id)!.side === "low";
        return sideways ? (low ? "top" : "bottom") : low ? "left" : "right";
      };

      // Where each arc's two ends sit on their boxes. Arcs are the only lines on
      // these sides, so they are placed here and now, to the pixel: an arc that
      // heads on along the flow leaves below one that heads back, and of two
      // heading the same way the one further out leaves from further behind, so
      // no two cross at the box they share and every arc leaves its box dead level.
      const along = (b: SceneBox) => (sideways ? { start: b.x, size: b.w } : { start: b.y, size: b.h });
      const ends = new Map<string, Array<{ arc: (typeof group)[number]; which: "from" | "to"; ahead: boolean; depth: number }>>();
      for (const arc of group) {
        for (const which of ["from", "to"] as const) {
          const box = which === "from" ? arc.s : arc.t;
          const other = which === "from" ? arc.to : arc.from;
          const here = which === "from" ? arc.from : arc.to;
          const key = `${box.id}\u0000${sideOf(arc)}`;
          const list = ends.get(key) ?? [];
          list.push({ arc, which, ahead: other > here, depth: pages.get(arc.id)!.depth });
          ends.set(key, list);
        }
      }
      const attach = new Map<string, { from?: number; to?: number }>();
      for (const list of ends.values()) {
        const box = list[0]!.which === "from" ? list[0]!.arc.s : list[0]!.arc.t;
        const { start, size } = along(box);
        // Heading back first, shallowest outermost; then heading on, deepest first.
        list.sort((a, b) => Number(a.ahead) - Number(b.ahead) || (a.ahead ? b.depth - a.depth : a.depth - b.depth) || (a.arc.id < b.arc.id ? -1 : 1));
        const pitch = Math.min(ARC_END_PITCH, (size - 20) / Math.max(1, list.length - 1));
        list.forEach((end, i) => {
          const at = start + size / 2 + (i - (list.length - 1) / 2) * pitch;
          attach.set(end.arc.id, { ...attach.get(end.arc.id), [end.which]: at });
        });
      }

      for (const arc of group) {
        const page = pages.get(arc.id)!;
        const side = sideOf(arc);
        const out = ARC_CLEAR + (page.depth - 1) * ARC_STEP;
        const bulge = page.side === "low" ? arc.wallLow - out : arc.wallHigh + out;
        const from = attach.get(arc.id)?.from ?? arc.from;
        const to = attach.get(arc.id)?.to ?? arc.to;
        // A bracket: out, round a corner, straight along, round a corner, and back
        // in. One point in the middle lets a long arc sag toward it and wander
        // across its neighbours, so each corner is three: one half way round the
        // turn, and two just past it that hold the run between the corners dead
        // straight (a curve passes through a point at the angle half way between
        // its neighbours, and half way between two points in line is in line).
        const at = (position: number, inward = 0): [number, number] => {
          const across = bulge + (page.side === "low" ? inward : -inward);
          return sideways ? [Math.round(position), Math.round(across)] : [Math.round(across), Math.round(position)];
        };
        const way = Math.sign(to - from) || 1;
        const reach = Math.abs(to - from);
        const radius = Math.min(ARC_CORNER, out * 0.8, reach / 4);
        const settle = radius + ARC_HOLD;
        const points: Array<[number, number]> =
          reach >= 2 * (settle + ARC_HOLD * 3) + 16
            ? [
                at(from + way * radius * 0.293, radius * 0.293),
                at(from + way * settle),
                at(from + way * (settle + ARC_HOLD * 3)),
                at(to - way * (settle + ARC_HOLD * 3)),
                at(to - way * settle),
                at(to - way * radius * 0.293, radius * 0.293),
              ]
            : [at((from + to) / 2)];
        const fraction = (box: SceneBox, position: number) => {
          const { start, size } = along(box);
          return Math.min(0.95, Math.max(0.05, (position - start) / size));
        };
        pins.set(arc.id, { start: side, end: side, points, startT: fraction(arc.s, from), endT: fraction(arc.t, to) });
      }
    }
  }
  if (!pins.size) return doc;
  return {
    ...doc,
    edges: doc.edges.map((e) => {
      const pin = pins.get(e.id);
      return pin
        ? {
            ...e,
            start: { side: pin.start, ...(pin.startT === undefined ? {} : { t: pin.startT }), auto: true },
            end: { side: pin.end, ...(pin.endT === undefined ? {} : { t: pin.endT }), auto: true },
            ...(pin.points ? { points: pin.points } : {}),
          }
        : e;
    }),
  };
}

/**
 * Place a whole document from its graph. Pure, deterministic, and moves nothing
 * locked. Every direction in play is composed in full and measured as drawn, and
 * the cheapest wins.
 */
export function autoPlace(template: DiagramTemplate, options: ArrangeOptions = {}): DiagramTemplate {
  return autoPlaceWith(template, options, {});
}

/** What an arrangement from outside the families brings: how it places, and how it tells a good picture from a bad one. */
export interface PlaceWith {
  engine?: PlaceEngine;
  /** What a settled document costs, read along `flow`. Lower is better; left out, it is the linter's cost. */
  cost?: (settled: DiagramTemplate, flow: Flow) => number;
  /**
   * The directions to use, outside containers and inside them, when someone has
   * already compared them: comparing is a full layout each, and a second way of
   * placing the same document rarely reads better a different way round.
   */
  flows?: { outer: Flow; inner: Flow };
  /** Told which directions won. */
  chose?: (flows: { outer: Flow; inner: Flow }) => void;
}

/**
 * `autoPlace`, with the placing and the choosing open to the caller: everything
 * else an arrangement needs (containers, locks, text that fits, routed lines)
 * is the same for all of them, and is here.
 */
export function autoPlaceWith(template: DiagramTemplate, options: ArrangeOptions, own: PlaceWith): DiagramTemplate {
  const prefs: Prefs = { ...resolvePrefs(template, options), ...(own.engine ? { engine: own.engine, algorithm: "layered" as const } : {}) };
  const flows: Flow[] = prefs.direction === "auto" ? candidateFlows(template) : [prefs.direction];
  // A flow through containers may run differently inside them: regions stacked
  // down the page, each reading across, is often the picture that fits.
  const pairs: Array<{ outer: Flow; inner: Flow }> = [];
  if (hasContainers(template)) {
    const inners: Flow[] =
      prefs.inner !== "auto" ? [prefs.inner] : prefs.direction === "auto" ? candidateFlows(template) : [prefs.direction];
    const sideways = prefs.direction === "auto" && candidateFlows(template).length === 1;
    for (const outer of sideways ? (["right", "down"] as Flow[]) : flows) {
      for (const inner of inners) pairs.push({ outer, inner });
    }
  } else {
    for (const flow of flows) pairs.push({ outer: flow, inner: flow });
  }
  // Comparing is a full layout each. Past this size the first choice is good
  // enough, and being quick about it matters more.
  if (template.nodes.length > COMPARE_LIMIT) pairs.length = 1;
  if (own.flows) pairs.splice(0, pairs.length, own.flows);
  const lintOptions = { containerKinds: options.containerKinds, frames: options.frames ?? ("root" as const) };
  let best: DiagramTemplate | null = null;
  let bestCost = Infinity;
  for (const { outer, inner } of pairs) {
    const composed = composeDocument(template, prefs, outer, inner, options);
    const settled = settleLines(composed, { containerKinds: options.containerKinds, frames: options.frames });
    if (pairs.length === 1) {
      own.chose?.({ outer, inner });
      return settled;
    }
    // The linter's cost already counts how small the words end up when the
    // picture is fitted to a window, so this chooses by what readers do.
    const cost = own.cost ? own.cost(settled, outer) : lintLayout(settled, lintOptions).cost;
    // A real difference, or the first choice stands: flipping a diagram's
    // direction for a rounding error would make Tidy feel arbitrary.
    if (cost < bestCost * 0.97) {
      best = settled;
      bestCost = cost;
      own.chose?.({ outer, inner });
    }
  }
  return best ?? template;
}

// ─── Polishing an arrangement that exists ────────────────────────────────────

export interface PolishOptions extends ArrangeOptions {
  /** How far a box may move to line up with its neighbours. */
  alignWithin?: number;
}

/**
 * Keep the arrangement; fix what lint finds. Boxes nearly in line go in line,
 * overlaps are pushed apart by the smallest move, runs of nearly even gaps are
 * made even, containers fit what they hold, and lines and labels are cleared.
 *
 * Moves nothing locked. Never returns something that measures worse than what
 * it was given: an arrangement polish can't help comes back unchanged.
 */
export function polishLayout(template: DiagramTemplate, options: PolishOptions = {}): DiagramTemplate {
  const prefs = resolvePrefs(template, options);
  const containerKinds = options.containerKinds ?? CONTAINER_KINDS;
  const alignWithin = options.alignWithin ?? 12;
  const canvases = canvasesInScope(template, options);
  const lintOptions = { containerKinds: options.containerKinds, frames: options.frames ?? ("root" as const) };

  let nodes = template.nodes.map((n) => ({ ...n }));
  if (options.fitText !== false) {
    const cards = cardParentIdsOf(template, containerKinds);
    const frameOf = frameResolver(template, cards);
    const scoped = new Set(canvases);
    nodes = nodes.map((n) => (scoped.has(frameOf(n.id)) ? { ...growToFit(n) } : n));
  }
  let zones = (template.zones ?? []).map((z) => ({ ...z }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const gap = Math.round(prefs.nodeGap * 0.6);

  for (const canvas of canvases) {
    const model = canvasModel({ ...template, nodes, zones }, canvas, containerKinds);
    const walk = (cluster: Cluster) => {
      for (const m of cluster.members) if (m.cluster) walk(m.cluster);

      // Members in one coordinate system: a group's are relative to it, the rest absolute.
      const boxes: PlacedBox[] = [];
      const pinned = new Set<string>();
      for (const m of cluster.members) {
        if (m.node) {
          const n = byId.get(m.node.id)!;
          boxes.push({ id: m.id, x: n.x, y: n.y, w: n.w, h: n.h });
        } else if (m.cluster?.zone) {
          const z = zoneById.get(m.cluster.zone.id)!;
          boxes.push({ id: m.id, x: z.x, y: z.y, w: z.w, h: z.h });
        }
        if (m.pinned) pinned.add(m.id);
      }
      if (!boxes.length) return;

      const before = new Map(boxes.map((b) => [b.id, { x: b.x, y: b.y }]));
      const leaves = boxes.filter((b) => {
        const m = cluster.members.find((x) => x.id === b.id);
        return !m?.cluster;
      });
      // A rough author lands within about a third of a box of the row they meant.
      // Notes and dots sit where they're put; they aren't in anyone's row.
      const rowMembers = leaves.filter((b) => {
        const kind = cluster.members.find((m) => m.id === b.id)?.node?.kind;
        return kind !== "text" && kind !== "point";
      });
      const typical = rowMembers.length ? Math.min(...rowMembers.map((b) => b.h)) : 0;
      // Each step can undo a little of the last: evening a row knocks a box off the
      // column it was just squared to. Round until nothing moves, so that a person
      // pressing Polish twice doesn't see it drift.
      for (let round = 0; round < POLISH_ROUNDS; round += 1) {
        const was = boxes.map((b) => `${Math.round(b.x)},${Math.round(b.y)}`).join();
        // Clear overlaps first: two boxes on top of each other can't line up with
        // anything, since moving either one still leaves it touching the other.
        separateBoxes(boxes, gap, pinned);
        alignNear(rowMembers, Math.max(alignWithin, typical * 0.4), gap, pinned);
        separateBoxes(boxes, gap, pinned);
        hangUnderOnlyNeighbour(rowMembers, template.edges, gap, pinned);
        separateBoxes(boxes, gap, pinned);
        evenGaps(rowMembers, pinned);
        separateBoxes(boxes, gap, pinned);
        if (boxes.map((b) => `${Math.round(b.x)},${Math.round(b.y)}`).join() === was) break;
      }
      for (const b of boxes) {
        b.x = Math.round(b.x);
        b.y = Math.round(b.y);
      }

      for (const b of boxes) {
        const m = cluster.members.find((x) => x.id === b.id);
        if (!m || m.pinned) continue;
        const from = before.get(b.id)!;
        const dx = b.x - from.x;
        const dy = b.y - from.y;
        if (m.node) {
          const n = byId.get(m.node.id)!;
          n.x = b.x;
          n.y = b.y;
          // A zone's members are absolute, so moving one moves only it. A group's
          // members ride along by being relative to it.
        } else if (m.cluster?.zone) {
          const z = zoneById.get(m.cluster.zone.id)!;
          z.x = b.x;
          z.y = b.y;
          moveZoneContents(m.cluster, dx, dy);
        }
      }

      // Fit the container around what it now holds.
      if (cluster.kind === "group") fitGroup(cluster);
      else if (cluster.kind === "zone") fitZone(cluster);
    };

    const moveZoneContents = (cluster: Cluster, dx: number, dy: number) => {
      for (const m of cluster.members) {
        if (m.node) {
          const n = byId.get(m.node.id)!;
          n.x += dx;
          n.y += dy;
        } else if (m.cluster?.zone) {
          const z = zoneById.get(m.cluster.zone.id)!;
          z.x += dx;
          z.y += dy;
          moveZoneContents(m.cluster, dx, dy);
        }
      }
    };

    const fitGroup = (cluster: Cluster) => {
      const g = byId.get(cluster.node!.id)!;
      if (g.locked || g.collapsed) return;
      const members = cluster.members.map((m) => byId.get(m.id)).filter((n): n is DiagramNode => !!n);
      if (!members.length) return;
      const minX = Math.min(...members.map((n) => n.x));
      const minY = Math.min(...members.map((n) => n.y));
      // A member left of or above the frame's inner edge: move the frame out to
      // it, keeping every member where it is on the canvas.
      const shiftX = Math.min(0, minX - prefs.padding);
      const shiftY = Math.min(0, minY - prefs.headerGap);
      if (shiftX || shiftY) {
        g.x += shiftX;
        g.y += shiftY;
        for (const n of members) {
          n.x -= shiftX;
          n.y -= shiftY;
        }
      }
      const maxX = Math.max(...members.map((n) => n.x + n.w));
      const maxY = Math.max(...members.map((n) => n.y + n.h));
      g.w = Math.max(160, maxX + prefs.padding);
      g.h = Math.max(120, maxY + prefs.padding);
    };

    const fitZone = (cluster: Cluster) => {
      const z = zoneById.get(cluster.zone!.id)!;
      if (z.locked || !cluster.members.length) return;
      const boxes = cluster.members
        .map((m) => {
          if (m.node) {
            const n = byId.get(m.node.id)!;
            return { x: n.x, y: n.y, w: n.w, h: n.h };
          }
          const inner = m.cluster?.zone ? zoneById.get(m.cluster.zone.id) : undefined;
          return inner ? { x: inner.x, y: inner.y, w: inner.w, h: inner.h } : null;
        })
        .filter((b): b is { x: number; y: number; w: number; h: number } => !!b);
      if (!boxes.length) return;
      const minX = Math.min(...boxes.map((b) => b.x)) - prefs.padding;
      const minY = Math.min(...boxes.map((b) => b.y)) - prefs.headerGap;
      const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + prefs.padding;
      const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + prefs.padding;
      // Grow to hold them; an author's roomier zone keeps its room.
      const left = Math.min(z.x, minX);
      const top = Math.min(z.y, minY);
      const right = Math.max(z.x + z.w, maxX);
      const bottom = Math.max(z.y + z.h, maxY);
      z.x = left;
      z.y = top;
      z.w = right - left;
      z.h = bottom - top;
    };

    walk(model.root);
  }
  zones = [...zoneById.values()];

  const moved: DiagramTemplate = {
    ...template,
    nodes: nodes.map((n) => byId.get(n.id) ?? n),
    ...(zones.length ? { zones } : {}),
  };
  // A polish keeps hand-drawn routes; only those a box now sits on are redrawn.
  const polished = settleLines(clearBlockedRoutes(moved, options), {
    containerKinds: options.containerKinds,
    frames: options.frames,
  });
  const was = lintLayout(template, lintOptions);
  const now = lintLayout(polished, lintOptions);
  return now.cost <= was.cost ? polished : template;
}

/**
 * A box sits square to its closest neighbour, if that's nearby and free. A database
 * under its service is the arrangement the author meant, and a line landing off to
 * one side makes the picture look unconsidered. Nothing else about the arrangement
 * changes: it stays on the same side, in the same row.
 */
function hangUnderOnlyNeighbour(
  boxes: PlacedBox[],
  edges: DiagramTemplate["edges"],
  gap: number,
  pinned: ReadonlySet<string>,
): void {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const neighbours = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!neighbours.has(e.source)) neighbours.set(e.source, new Set());
    if (!neighbours.has(e.target)) neighbours.set(e.target, new Set());
    neighbours.get(e.source)!.add(e.target);
    neighbours.get(e.target)!.add(e.source);
  }
  for (const box of boxes) {
    if (pinned.has(box.id)) continue;
    const near = neighbours.get(box.id);
    if (!near?.size) continue;
    // Its closest neighbour, which is the line the eye follows. One it's only got
    // the one of can pull it a long way; with others, only if it's nearly there.
    const centreGap = (o: PlacedBox) => Math.hypot(o.x + o.w / 2 - box.x - box.w / 2, o.y + o.h / 2 - box.y - box.h / 2);
    const others = [...near].map((id) => byId.get(id)).filter((o): o is PlacedBox => !!o);
    if (!others.length) continue;
    const other = others.reduce((a, b) => (centreGap(b) < centreGap(a) ? b : a));
    const dx = Math.abs(other.x + other.w / 2 - box.x - box.w / 2);
    const dy = Math.abs(other.y + other.h / 2 - box.y - box.h / 2);
    // Square up across whichever axis it's already further along.
    const axis: "x" | "y" = dy >= dx ? "x" : "y";
    const size: "w" | "h" = axis === "x" ? "w" : "h";
    const reach = (axis === "x" ? box.w : box.h) * (near.size === 1 ? 1.6 : 0.5);
    const offset = other[axis] + other[size] / 2 - box[axis] - box[size] / 2;
    if (!offset || Math.abs(offset) > reach) continue;
    const before = box[axis];
    box[axis] += offset;
    const clash = boxes.some(
      (o) => o !== box && box.x < o.x + o.w + gap && o.x < box.x + box.w + gap && box.y < o.y + o.h + gap && o.y < box.y + box.h + gap,
    );
    if (clash) box[axis] = before;
  }
}

/** A hand-drawn route a box now sits on is no longer a route anybody wants. */
function clearBlockedRoutes(template: DiagramTemplate, options: ArrangeOptions): DiagramTemplate {
  const report = lintLayout(template, {
    containerKinds: options.containerKinds,
    frames: options.frames,
  });
  const blocked = new Set(
    report.findings.filter((f) => f.rule === "line-through-box").flatMap((f) => f.edgeIds ?? []),
  );
  if (!blocked.size) return template;
  return {
    ...template,
    edges: template.edges.map((e) => {
      if (!blocked.has(e.id) || !e.points) return e;
      const { points: _blocked, ...rest } = e;
      return rest;
    }),
  };
}

/**
 * Rows and columns whose gaps are nearly equal made exactly equal, with the
 * two ends holding still. Gaps that differ a lot are probably saying something
 * (a break between sections), so those stay.
 */
function evenGaps(boxes: PlacedBox[], pinned: ReadonlySet<string>): void {
  const run = (line: "x" | "y", lineSize: "w" | "h", along: "x" | "y", span: "w" | "h") => {
    const groups = new Map<number, PlacedBox[]>();
    for (const b of boxes) {
      const k = Math.round(b[line] + b[lineSize] / 2);
      const g = groups.get(k);
      if (g) g.push(b);
      else groups.set(k, [b]);
    }
    for (const group of groups.values()) {
      if (group.length < 3) continue;
      const sorted = [...group].sort((a, b) => a[along] - b[along]);
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i += 1) {
        gaps.push(sorted[i]![along] - sorted[i - 1]![along] - sorted[i - 1]![span]);
      }
      const lo = Math.min(...gaps);
      const hi = Math.max(...gaps);
      if (lo <= 0 || hi / lo > 1.6 || hi === lo) continue;
      const even = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      let at = sorted[0]![along];
      for (let i = 1; i < sorted.length; i += 1) {
        at += sorted[i - 1]![span] + even;
        const box = sorted[i]!;
        // A box moves with whatever it's lined up with the other way: being on a
        // column matters more than an even row, so the column comes too, or not at all.
        const centre = box[along] + box[span] / 2;
        const mates = boxes.filter((o) => o !== box && Math.abs(o[along] + o[span] / 2 - centre) < 1);
        if (pinned.has(box.id) || mates.some((o) => pinned.has(o.id))) continue;
        const delta = at - box[along];
        box[along] = at;
        for (const o of mates) o[along] += delta;
      }
    }
  };
  run("y", "h", "x", "w");
  run("x", "w", "y", "h");
}

// ─── Choosing between the author and the algorithm ───────────────────────────

/** Whether the author placed anything at all, or every box still sits where a default left it. */
export function hasPlacement(template: DiagramTemplate): boolean {
  const roots = template.nodes.filter((n) => !n.parentId);
  if (roots.length < 2) return roots.length === 1 && (roots[0]!.x !== 0 || roots[0]!.y !== 0);
  const spots = new Set(roots.map((n) => `${n.x},${n.y}`));
  return spots.size >= Math.ceil(roots.length * 0.6);
}

export type ArrangeSource = "kept" | "polished" | "placed";

export interface ArrangeResult {
  template: DiagramTemplate;
  /** Which won: the author's arrangement untouched, polished, or the algorithm's. */
  source: ArrangeSource;
  report: LayoutReport;
}

/**
 * How many points below the algorithm's an author's arrangement may score and
 * still be kept. Measured in score, the things a reader would call wrong, and not
 * in cost: cost also likes short lines and a small canvas, and an author is
 * entitled to spread a diagram out.
 */
const AUTHOR_MARGIN = 8;

/**
 * The right arrangement for a document that just arrived. An author's placement
 * is kept (polished) unless the algorithm's is clearly better; one with nothing
 * placed gets the algorithm's. The better the author, the more of its choices
 * survive, with no setting to flip.
 */
export function arrangeBest(template: DiagramTemplate, options: ArrangeOptions = {}): ArrangeResult {
  const lintOptions = { containerKinds: options.containerKinds, frames: options.frames ?? ("root" as const) };
  const placed = autoPlace(template, options);
  const placedReport = lintLayout(placed, lintOptions);
  if (!hasPlacement(template)) return { template: placed, source: "placed", report: placedReport };

  const polished = polishLayout(template, options);
  const polishedReport = lintLayout(polished, lintOptions);
  const broken = (polishedReport.counts["box-overlap"] ?? 0) > 0 || (polishedReport.counts["outside-container"] ?? 0) > 0;
  if (!broken && polishedReport.score >= placedReport.score - AUTHOR_MARGIN) {
    return { template: polished, source: polished === template ? "kept" : "polished", report: polishedReport };
  }
  return { template: placed, source: "placed", report: placedReport };
}

// ─── Options to choose between ───────────────────────────────────────────────

export interface LayoutCandidate {
  id: string;
  label: string;
  algorithm: LayoutAlgorithm;
  direction: LayoutDirection;
  template: DiagramTemplate;
  report: LayoutReport;
}

/**
 * The genuinely different arrangements a document can take, for a person to look
 * at and choose from: Best fit, then the rest by how they measure. Two candidates
 * that land every box in the same place count once.
 */
export function layoutCandidates(template: DiagramTemplate, options: ArrangeOptions = {}): LayoutCandidate[] {
  const lintOptions = { containerKinds: options.containerKinds, frames: options.frames ?? ("root" as const) };
  // The same documents Tidy only ever lays left to right: see `candidateFlows`.
  const sideways = candidateFlows(template).length === 1;
  const specs: Array<{ id: string; label: string; algorithm: LayoutAlgorithm; direction: LayoutDirection }> = [
    { id: "auto", label: "Best fit", algorithm: "auto", direction: "auto" },
    { id: "layered-right", label: "Left to right", algorithm: "layered", direction: "right" },
    ...(sideways ? [] : [{ id: "layered-down", label: "Top down", algorithm: "layered" as const, direction: "down" as const }]),
    { id: "tree-right", label: "Tree", algorithm: "tree", direction: "right" },
    ...(sideways ? [] : [{ id: "tree-down", label: "Org chart", algorithm: "tree" as const, direction: "down" as const }]),
    { id: "radial", label: "Radial", algorithm: "radial", direction: "right" },
    { id: "organic", label: "Organic", algorithm: "organic", direction: "right" },
    { id: "grid", label: "Grid", algorithm: "grid", direction: "right" },
  ];
  const seen = new Set<string>();
  const out: LayoutCandidate[] = [];
  for (const spec of specs) {
    const doc = autoPlace(template, { ...options, algorithm: spec.algorithm, direction: spec.direction });
    const key = doc.nodes.map((n) => `${n.id}:${n.x},${n.y}`).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...spec, template: doc, report: lintLayout(doc, lintOptions) });
  }
  // Best fit is what Tidy would do, so it leads whatever the others measure: a
  // real difference in cost is what it takes to turn Tidy from its first choice.
  const lead = out.filter((c) => c.id === "auto");
  const rest = out.filter((c) => c.id !== "auto").sort((a, b) => a.report.cost - b.report.cost);
  return [...lead, ...rest];
}

// ─── Part of a canvas ────────────────────────────────────────────────────────

/**
 * Arrange just the selected boxes, around where they already are, leaving
 * everything else alone. The set keeps its centre so it doesn't fly across the
 * canvas, and only boxes that share a container move: a box's coordinates mean
 * nothing next to those of a box in another group, and a box in one zone has no
 * business being arranged into another. What's arranged stays inside the group
 * or zone it's in, which grows down and to the right if it has to.
 */
export function arrangeSelection(
  template: DiagramTemplate,
  ids: readonly string[],
  options: ArrangeOptions = {},
): DiagramTemplate {
  const prefs = resolvePrefs(template, options);
  const wanted = new Set(ids);
  const nodeById = new Map(template.nodes.map((n) => [n.id, n]));
  const zoneById = new Map((template.zones ?? []).map((z) => [z.id, z]));
  const cardParents = cardParentIdsOf(template, options.containerKinds ?? CONTAINER_KINDS);
  const byParent = new Map<string, DiagramNode[]>();
  for (const n of template.nodes) {
    if (!wanted.has(n.id) || n.locked) continue;
    const key = n.parentId ? `group\u0000${n.parentId}` : n.zoneId && zoneById.has(n.zoneId) ? `zone\u0000${n.zoneId}` : "";
    const group = byParent.get(key);
    if (group) group.push(n);
    else byParent.set(key, [n]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  /** Frames that had to grow to hold what was arranged in them. */
  const grownNodes = new Map<string, { w: number; h: number }>();
  const grownZones = new Map<string, { w: number; h: number }>();
  for (const members of byParent.values()) {
    if (members.length < 2) continue;
    const memberIds = new Set(members.map((n) => n.id));
    const links: PlaceLink[] = template.edges
      .filter((e) => memberIds.has(e.source) && memberIds.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, ...wordsRoom(e), ...(e.secondary ? { tether: true } : {}) }));
    const flow: Flow = prefs.direction === "auto" ? candidateFlows(template)[0]! : prefs.direction;
    const placement = placeItems(
      members.map((n) => ({ id: n.id, w: n.w, h: n.h })),
      links,
      { algorithm: prefs.algorithm, flow, rankGap: prefs.rankGap, nodeGap: prefs.nodeGap, shape: prefs.shape },
    );
    const minX = Math.min(...members.map((n) => n.x));
    const minY = Math.min(...members.map((n) => n.y));
    const maxX = Math.max(...members.map((n) => n.x + n.w));
    const maxY = Math.max(...members.map((n) => n.y + n.h));
    let originX = Math.round((minX + maxX) / 2 - placement.width / 2);
    let originY = Math.round((minY + maxY) / 2 - placement.height / 2);

    // Inside a frame, the set stays inside it: no further up or left than the
    // frame's own inner edge (or than the set already reached), and where it now
    // runs past the right or the bottom, the frame grows to hold it. A card's
    // children are a canvas of their own, with no edge to keep to.
    const first = members[0]!;
    const group = first.parentId && !cardParents.has(first.parentId) ? nodeById.get(first.parentId) : undefined;
    const zone = !first.parentId && first.zoneId ? zoneById.get(first.zoneId) : undefined;
    if (group || zone) {
      const left = zone ? zone.x : 0;
      const top = zone ? zone.y : 0;
      originX = Math.max(originX, left + Math.max(0, Math.min(prefs.padding, minX - left)));
      originY = Math.max(originY, top + Math.max(0, Math.min(prefs.headerGap, minY - top)));
      const right = originX + placement.width + prefs.padding;
      const bottom = originY + placement.height + prefs.padding;
      if (zone && !zone.locked) {
        const was = grownZones.get(zone.id) ?? { w: zone.w, h: zone.h };
        grownZones.set(zone.id, { w: Math.max(was.w, right - zone.x), h: Math.max(was.h, bottom - zone.y) });
      }
      // A group grows, and so does each frame around it that it now reaches past.
      let reachX = right;
      let reachY = bottom;
      const guard = new Set<string>();
      for (let frame = group; frame && !frame.locked && !guard.has(frame.id); ) {
        guard.add(frame.id);
        const was = grownNodes.get(frame.id) ?? { w: frame.w, h: frame.h };
        const now = { w: Math.max(was.w, reachX), h: Math.max(was.h, reachY) };
        if (now.w === was.w && now.h === was.h) break;
        grownNodes.set(frame.id, now);
        reachX = frame.x + now.w + prefs.padding;
        reachY = frame.y + now.h + prefs.padding;
        const outer: DiagramNode | undefined = frame.parentId && !cardParents.has(frame.parentId) ? nodeById.get(frame.parentId) : undefined;
        if (!outer) {
          const around = !frame.parentId && frame.zoneId ? zoneById.get(frame.zoneId) : undefined;
          if (around && !around.locked) {
            const zoneWas = grownZones.get(around.id) ?? { w: around.w, h: around.h };
            grownZones.set(around.id, { w: Math.max(zoneWas.w, reachX - around.x), h: Math.max(zoneWas.h, reachY - around.y) });
          }
        }
        frame = outer;
      }
    }
    for (const p of placement.placed) positions.set(p.id, { x: originX + p.x, y: originY + p.y });
  }
  if (!positions.size) return template;
  const edges = template.edges.map((e) => {
    if (!e.points || (!positions.has(e.source) && !positions.has(e.target))) return e;
    const { points: _stale, ...rest } = e;
    return rest;
  });
  const placed = {
    ...template,
    nodes: template.nodes.map((n) => {
      const p = positions.get(n.id);
      const size = grownNodes.get(n.id);
      return p || size ? { ...n, ...p, ...size } : n;
    }),
    edges,
    ...(grownZones.size ? { zones: (template.zones ?? []).map((z) => (grownZones.has(z.id) ? { ...z, ...grownZones.get(z.id)! } : z)) } : {}),
  };
  return settleLines(placed, { containerKinds: options.containerKinds, frames: options.frames, keepWords: false });
}

/**
 * Run the named lines dead straight, by moving whichever end is free to move. A
 * line a few pixels off level is the commonest thing a person wants to fix by hand
 * and the fiddliest to do with a mouse. Leaves alone a line whose ends aren't in the
 * same container, or one that straightening would land a box on a neighbour.
 */
export function straightenLines(template: DiagramTemplate, edgeIds: readonly string[]): DiagramTemplate {
  const nodes = template.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const clear = (moved: DiagramNode) =>
    !nodes.some(
      (o) =>
        o !== moved &&
        o.id !== moved.parentId &&
        o.parentId === moved.parentId &&
        moved.x < o.x + o.w &&
        o.x < moved.x + moved.w &&
        moved.y < o.y + o.h &&
        o.y < moved.y + moved.h,
    );
  let changed = false;
  for (const id of edgeIds) {
    const edge = template.edges.find((e) => e.id === id);
    if (!edge) continue;
    const s = byId.get(edge.source);
    const t = byId.get(edge.target);
    if (!s || !t || s === t || s.parentId !== t.parentId) continue;
    const dx = Math.abs(t.x + t.w / 2 - (s.x + s.w / 2));
    const dy = Math.abs(t.y + t.h / 2 - (s.y + s.h / 2));
    // Whichever way it's nearer to straight already.
    const axis: "x" | "y" = dy <= dx ? "y" : "x";
    const size: "w" | "h" = axis === "y" ? "h" : "w";
    const mover = t.locked ? s : t;
    const anchor = mover === t ? s : t;
    if (mover.locked) continue;
    const before = mover[axis];
    mover[axis] = Math.round(anchor[axis] + anchor[size] / 2 - mover[size] / 2);
    if (!clear(mover)) mover[axis] = before;
    else if (mover[axis] !== before) changed = true;
  }
  if (!changed) return template;
  const moved = new Set(nodes.filter((n, i) => n.x !== template.nodes[i]!.x || n.y !== template.nodes[i]!.y).map((n) => n.id));
  return {
    ...template,
    nodes,
    edges: template.edges.map((e) => {
      const touched = moved.has(e.source) || moved.has(e.target);
      if (!touched) return e;
      const { start, end, ...rest } = e;
      return {
        ...rest,
        ...(start && !start.auto ? { start } : {}),
        ...(end && !end.auto ? { end } : {}),
      };
    }),
  };
}
