/**
 * layout.ts — container-constrained automatic layout.
 *
 * A layered (Sugiyama-style) arrangement: rank nodes by longest path along the
 * edges, order within each rank to reduce crossings, then assign coordinates.
 * Left-to-right, matching how the schema asks an LLM to lay diagrams out.
 *
 * Written in-package rather than pulling in dagre for one reason: the layout
 * has to respect *containers*. Nodes belong to a zone or a group, and a global
 * layout that ignored that would drag nodes out of the region that decides
 * whether they're visible at all — silently changing the document's meaning.
 * dagre has no notion of that constraint, so it would need a per-container
 * driver on top anyway; the ranking itself is the small part.
 *
 * Scope, deliberately: this arranges nodes *within* each container and
 * arranges root-level nodes globally. Containers grow to fit their contents
 * but do not move relative to each other — a "tidy" that also rearranged the
 * user's regions would be a surprise, not a convenience.
 *
 * KNOWN LIMITATION: overlapping zones are laid out independently, so a host
 * region's contents can land on top of an island drawn inside it. Avoiding
 * that needs obstacle-aware packing, which is a much larger problem than the
 * ranking. In practice islands sit in a corner and the collision doesn't
 * arise; when it does, the fix is to drag the island or the node clear.
 */
import { pointInZone } from "./zones";
import { COLLAPSED_SIZE, CONTAINER_KINDS, visibleElements } from "./schema";
import type { ArrangeMode, DiagramNode, DiagramTemplate } from "./schema";

/**
 * Provider ALTERNATES, mapped to the one that stands in for the set.
 *
 * "Azure SQL / Amazon RDS / Cloud SQL" is one box drawn three ways: the nodes
 * are authored at the same spot with disjoint `providers`, so exactly one is
 * ever visible and switching the scenario swaps it in place. A layout that
 * ranked them as three members would deal them three slots — a permanent gap
 * wherever the hidden two would sit, and a database that jumps across the
 * diagram when the scenario changes.
 *
 * What marks a set as alternates, without asking the author to say so:
 *   - same container (they are laid out together at all),
 *   - the same neighbours (they stand in the same place in the graph), and
 *   - provider lists that cannot both be showing at once.
 *
 * The last one is checked greedily against the set so far, so a node that
 * overlaps an existing member starts its own group rather than dissolving the
 * whole set — a cache on {azure, aws} is not an alternate of an Azure-only
 * database, and gets a slot of its own.
 */
function variantGroups(template: DiagramTemplate): Map<string, string> {
  const lead = new Map<string, string>();
  const scoped = template.nodes.filter((n) => n.providers?.length);
  if (scoped.length < 2) return lead;

  const neighbours = new Map<string, Set<string>>();
  for (const n of template.nodes) neighbours.set(n.id, new Set());
  for (const e of template.edges) {
    neighbours.get(e.source)?.add(e.target);
    neighbours.get(e.target)?.add(e.source);
  }

  /** Same container AND same neighbours, ignoring the candidates themselves. */
  const signature = (n: DiagramNode, family: ReadonlySet<string>): string => {
    const others = [...(neighbours.get(n.id) ?? [])].filter((id) => !family.has(id)).sort();
    return `${n.parentId ?? ""}|${n.zoneId ?? ""}|${others.join(",")}`;
  };

  const family = new Set(scoped.map((n) => n.id));
  const bySignature = new Map<string, DiagramNode[]>();
  for (const n of scoped) {
    const key = signature(n, family);
    const bucket = bySignature.get(key);
    if (bucket) bucket.push(n);
    else bySignature.set(key, [n]);
  }

  for (const candidates of bySignature.values()) {
    if (candidates.length < 2) continue;
    // Greedy: each group takes the members whose providers don't collide with
    // anything already in it; the rest start groups of their own.
    const remaining = [...candidates];
    while (remaining.length) {
      const first = remaining.shift()!;
      const claimed = new Set(first.providers ?? []);
      const members: DiagramNode[] = [];
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        const other = remaining[i]!;
        if ((other.providers ?? []).some((p) => claimed.has(p))) continue;
        for (const p of other.providers ?? []) claimed.add(p);
        members.push(other);
        remaining.splice(i, 1);
      }
      for (const m of members) lead.set(m.id, first.id);
    }
  }
  return lead;
}

export interface LayoutOptions {
  /** Horizontal gap between ranks. */
  rankGap?: number;
  /** Vertical gap between nodes in the same rank. */
  nodeGap?: number;
  /** Inset from a container's edges. */
  padding?: number;
  /** Extra top inset, clearing a zone or group's header chip. */
  headerGap?: number;
  /**
   * Kinds that render as open containers. A parent of any OTHER kind is a
   * card whose children are drill-in detail: layout never moves them, never
   * resizes the card, and never mixes their local coords into root space.
   */
  containerKinds?: readonly string[];
  /**
   * Which coordinate frames to arrange. A card's children live in their own
   * drilled canvas, so "the layout" is really one layout per frame:
   *
   *   "root" (default) — the visible canvas only, leaving drill spaces alone
   *                      so a Tidy never rearranges a level you cannot see
   *   "all"            — every frame; for a document with no layout yet (a
   *                      bare content doc, a fresh generation), where the
   *                      alternative is each drill space piled at its origin
   *   { drill: id }    — only that card's drilled canvas (Tidy while focused)
   */
  frames?: "root" | "all" | { drill: string };
  /**
   * The width:height a frame should tend toward, 1.6 by default (a canvas is
   * wider than it is tall). A rank with many members and few edges among them
   * otherwise becomes one very tall spine — 22 tables in a band stack some
   * 3,700px high and fit-zoom to 15% — so a rank taller than the target is
   * wrapped into side-by-side sub-columns. A rank that fits on a screen
   * ({@link WRAP_FLOOR}) is never wrapped, so small diagrams lay out exactly
   * as they always did. 0 turns the wrapping off.
   */
  aspect?: number;
  /**
   * What the arrangement optimises for — see `ARRANGE_MODES`. Unset, the
   * document's own `settings.arrange` decides, and "flow" when it says
   * nothing: so a Tidy keeps arranging the way the document was last set.
   */
  mode?: ArrangeMode;
}

/** The width:height a laid-out frame tends toward — a canvas is wider than tall. */
export const WRAP_ASPECT = 1.6;
/**
 * A rank shorter than this is never wrapped, whatever the aspect asks: about
 * a laptop canvas at 100%, so three stacked services stay a stack and the
 * wrap only ever touches a rank that would not fit on a screen anyway.
 */
export const WRAP_FLOOR = 720;
/**
 * How tall a level whose boxes cover `area` should be to sit at
 * {@link WRAP_ASPECT}, never below {@link WRAP_FLOOR}. Shared with the
 * scoped view, which fans a drilled level's ghosts by the same rule.
 */
export function wrapHeight(area: number, aspect = WRAP_ASPECT): number {
  return aspect > 0 ? Math.max(WRAP_FLOOR, Math.sqrt(area / aspect)) : Infinity;
}
const DEFAULTS = {
  rankGap: 90,
  nodeGap: 28,
  padding: 28,
  headerGap: 52,
  aspect: WRAP_ASPECT,
  mode: "flow",
} as const satisfies LayoutMetrics;

/** The numeric knobs — what the pure placement routines consume. */
type LayoutMetrics = Required<Omit<LayoutOptions, "containerKinds" | "frames">>;

/** Ids of the parents whose children are drill-in detail, not inline content. */
function cardParentIdsOf(
  template: DiagramTemplate,
  containerKinds?: readonly string[],
): Set<string> {
  const containerSet = new Set(containerKinds ?? CONTAINER_KINDS);
  const parents = new Set(template.nodes.map((n) => n.parentId).filter((p): p is string => !!p));
  return new Set(
    template.nodes
      .filter((n) => parents.has(n.id) && !containerSet.has(n.kind as string))
      .map((n) => n.id),
  );
}

/**
 * Which drilled canvas a node is positioned in — the nearest card ancestor,
 * or null for the visible root canvas. Coordinates only ever mean something
 * relative to their own frame, so every geometric comparison starts here.
 */
function frameResolver(
  template: DiagramTemplate,
  cardParents: ReadonlySet<string>,
): (id: string) => string | null {
  const byId = new Map(template.nodes.map((n) => [n.id, n]));
  const cache = new Map<string, string | null>();
  return (id: string) => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    let cursor = byId.get(id)?.parentId ?? null;
    const guard = new Set<string>([id]);
    let frame: string | null = null;
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      if (cardParents.has(cursor)) {
        frame = cursor;
        break;
      }
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    cache.set(id, frame);
    return frame;
  };
}

interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Sized {
  id: string;
  w: number;
  h: number;
}

interface Link {
  source: string;
  target: string;
}

/**
 * Rank by longest path from a source: a node sits one rank past its deepest
 * predecessor. Kahn's algorithm, so a cycle simply leaves nodes unranked
 * rather than looping forever; anything left over lands in rank 0.
 */
function rankNodes(ids: ReadonlySet<string>, internal: readonly Link[]): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of ids) {
    outgoing.set(id, []);
    indegree.set(id, 0);
  }
  for (const e of internal) {
    outgoing.get(e.source)!.push(e.target);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }

  const rank = new Map<string, number>();
  const queue: string[] = [];
  for (const id of ids) if ((indegree.get(id) ?? 0) === 0) (rank.set(id, 0), queue.push(id));

  const pending = new Map(indegree);
  while (queue.length) {
    const id = queue.shift()!;
    const r = rank.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, r + 1));
      pending.set(next, (pending.get(next) ?? 0) - 1);
      if ((pending.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  for (const id of ids) if (!rank.has(id)) rank.set(id, 0); // cycle remnants

  // ── Tighten: pull a node toward what it feeds ─────────────────────────────
  // Longest path puts every source in the first rank, however far away the
  // one thing it connects to sits — a table whose only line goes to the last
  // rank stretches that line across the whole diagram. Moving a node one rank
  // right shortens each outgoing line by one and lengthens each incoming one
  // by one, so a node with more lines out than in slides right until it sits
  // just before its nearest successor. Predecessors never lose a rank to it:
  // a node only ever moves right, and never past what it feeds.
  let moved = true;
  for (let guard = 0; moved && guard < ids.size; guard += 1) {
    moved = false;
    for (const id of ids) {
      const succ = outgoing.get(id) ?? [];
      if (succ.length <= (indegree.get(id) ?? 0)) continue;
      const ceiling = Math.min(...succ.map((s) => rank.get(s)!)) - 1;
      if (ceiling > rank.get(id)!) {
        rank.set(id, ceiling);
        moved = true;
      }
    }
  }
  return rank;
}

/**
 * Split ranks that would tower (see `aspect`) into side-by-side sub-columns.
 * The target comes from the total area the boxes occupy, so it scales with
 * the content rather than being a fixed pixel count; the floor keeps it from
 * ever touching a rank that fits on a screen, which is what keeps small
 * diagrams byte-identical.
 */
function wrapRanks(
  ranks: readonly (readonly string[])[],
  sizeById: ReadonlyMap<string, Sized>,
  opts: LayoutMetrics,
): string[][] {
  const colHeight = (row: readonly string[]) =>
    row.reduce((sum, id) => sum + sizeById.get(id)!.h, 0) + opts.nodeGap * (row.length - 1);
  const area = [...sizeById.values()].reduce(
    (sum, i) => sum + (i.w + opts.rankGap) * (i.h + opts.nodeGap),
    0,
  );
  const targetHeight = wrapHeight(area, opts.aspect);
  const columns: string[][] = [];
  for (const row of ranks) {
    if (row.length < 2 || colHeight(row) <= targetHeight) {
      columns.push([...row]);
      continue;
    }
    const parts = Math.min(row.length, Math.ceil(colHeight(row) / targetHeight));
    const per = Math.ceil(row.length / parts);
    for (let i = 0; i < row.length; i += per) columns.push(row.slice(i, i + per));
  }
  return columns;
}

/**
 * Arrange a set of boxes by the edges between them.
 *
 * Returns positions relative to (0,0) plus the total size occupied. Pure — it
 * knows nothing about zones or groups, which is what lets the same routine
 * drive every container and the root canvas.
 *
 * "flow" ranks by longest path, orders each rank once by the mean position of
 * its predecessors, and stacks the ranks left to right — compact and quick.
 * "untangle" is the same skeleton with the lines given the final say; see
 * {@link layoutUntangled}.
 */
function layoutGroup(
  items: Sized[],
  edges: ReadonlyArray<Link>,
  opts: LayoutMetrics,
): { placed: Placed[]; width: number; height: number } {
  if (!items.length) return { placed: [], width: 0, height: 0 };
  if (opts.mode === "untangle") return layoutUntangled(items, edges, opts);

  const ids = new Set(items.map((i) => i.id));
  const internal = edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);

  // ── Rank: longest path from a source ──────────────────────────────────────
  const rank = rankNodes(ids, internal);

  // ── Order within each rank: barycentre, to reduce crossings ───────────────
  const byRank = new Map<number, string[]>();
  for (const item of items) {
    const r = rank.get(item.id)!;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(item.id);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);

  const predecessors = new Map<string, string[]>();
  for (const id of ids) predecessors.set(id, []);
  for (const e of internal) predecessors.get(e.target)!.push(e.source);

  const order = new Map<string, number>();
  for (const r of ranks) {
    const row = byRank.get(r)!;
    if (r === ranks[0]) {
      row.forEach((id, i) => order.set(id, i));
      continue;
    }
    // Sort each rank by the mean position of its predecessors in the previous
    // rank. One pass is enough to remove the obvious crossings without the
    // cost; "untangle" is the mode that keeps going.
    const score = new Map<string, number>();
    row.forEach((id, i) => {
      const preds = (predecessors.get(id) ?? []).filter((p) => order.has(p));
      score.set(
        id,
        preds.length ? preds.reduce((sum, p) => sum + order.get(p)!, 0) / preds.length : i,
      );
    });
    row.sort((a, b) => score.get(a)! - score.get(b)!);
    row.forEach((id, i) => order.set(id, i));
  }

  // ── Coordinates ───────────────────────────────────────────────────────────
  const sizeById = new Map(items.map((i) => [i.id, i]));
  const colHeight = (row: readonly string[]) =>
    row.reduce((sum, id) => sum + sizeById.get(id)!.h, 0) + opts.nodeGap * (row.length - 1);

  const columns = wrapRanks(
    ranks.map((r) => byRank.get(r)!),
    sizeById,
    opts,
  );
  const columnWidths = columns.map((row) => Math.max(...row.map((id) => sizeById.get(id)!.w)));
  const columnHeights = columns.map(colHeight);
  const tallest = Math.max(...columnHeights, 0);

  const placed: Placed[] = [];
  let x = 0;
  columns.forEach((row, ci) => {
    // Centre each column vertically against the tallest, so the flow reads
    // along a spine rather than hanging off the top edge.
    let y = (tallest - columnHeights[ci]) / 2;
    for (const id of row) {
      const size = sizeById.get(id)!;
      placed.push({ id, x: x + (columnWidths[ci] - size.w) / 2, y, w: size.w, h: size.h });
      y += size.h + opts.nodeGap;
    }
    x += columnWidths[ci] + opts.rankGap;
  });

  return {
    placed,
    width: Math.max(0, x - opts.rankGap),
    height: tallest,
  };
}

// ── Untangle ────────────────────────────────────────────────────────────────

/**
 * Lines between two consecutive layers that cross, given each layer's order.
 * Sort the lines by their upper end, then count inversions among the lower
 * ends — a Fenwick tree makes it O(E log E), which matters for a data model
 * with a few hundred foreign keys in one zone.
 */
function bilayerCrossings(
  links: ReadonlyArray<[upper: number, lower: number]>,
  lowerSize: number,
): number {
  if (links.length < 2) return 0;
  const sorted = [...links].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const tree = new Array<number>(lowerSize + 1).fill(0);
  let crossings = 0;
  let seen = 0;
  for (const [, lower] of sorted) {
    // How many earlier lines land at or above this one's lower end.
    let notBelow = 0;
    for (let i = lower + 1; i > 0; i -= i & -i) notBelow += tree[i]!;
    crossings += seen - notBelow;
    for (let i = lower + 1; i <= lowerSize; i += i & -i) tree[i]! += 1;
    seen += 1;
  }
  return crossings;
}

/**
 * Least-squares fit of `desired` under "each value at least the one before":
 * pool-adjacent-violators, weighted. This is what lets a column of boxes slide
 * toward the boxes they connect to without any two of them overlapping —
 * the order the crossing pass chose is a hard constraint, the wish to sit
 * level with a neighbour is a soft one.
 */
function isotonic(desired: readonly number[], weights: readonly number[]): number[] {
  const blocks: Array<{ sum: number; weight: number; count: number }> = [];
  for (let i = 0; i < desired.length; i += 1) {
    blocks.push({ sum: desired[i]! * weights[i]!, weight: weights[i]!, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;
      if (prev.sum / prev.weight <= last.sum / last.weight) break;
      blocks.pop();
      blocks.pop();
      blocks.push({
        sum: prev.sum + last.sum,
        weight: prev.weight + last.weight,
        count: prev.count + last.count,
      });
    }
  }
  const out: number[] = [];
  for (const block of blocks) {
    const value = block.sum / block.weight;
    for (let i = 0; i < block.count; i += 1) out.push(value);
  }
  return out;
}

/** Prefix every channel id carries — a NUL, which no authored id contains. */
const CHANNEL_PREFIX = " channel:";
/** The pull a channel exerts on what it connects to — see `layoutUntangled`. */
const CHANNEL_WEIGHT = 4;
/** Crossing-reduction sweeps, and how many fruitless ones end the search. */
const UNTANGLE_SWEEPS = 24;
const UNTANGLE_PATIENCE = 4;
/** Rounds of sliding boxes level with what they connect to. */
const STRAIGHTEN_ROUNDS = 4;

/**
 * The same layered layout, optimised for the lines rather than the boxes.
 *
 * Three things "flow" does not do:
 *
 *  1. A line that spans several ranks is threaded through a *channel* — a
 *     zero-width member of every rank between, ordered and spaced like a box.
 *     Left to its own devices the straight line from rank 0 to rank 2 runs
 *     through whatever sits in rank 1; a channel is a slot no box may take.
 *  2. Ranks are re-ordered by repeated barycentre sweeps in both directions,
 *     each followed by an adjacent-swap pass, keeping the ordering with the
 *     fewest crossings. One downward pass fixes the obvious cases; a crossing
 *     that only re-ordering the FIRST rank can remove needs the upward one.
 *  3. Boxes then slide up or down their column toward the mean of what they
 *     connect to, channels pulling hardest (`CHANNEL_WEIGHT`), so a line
 *     runs level instead of diagonally across a neighbour. The order from
 *     step 2 and the gaps between boxes are never violated.
 *
 * Boxes with no line at all have nothing to untangle, so they sit out of
 * the sweeps and are parked in a grid after the last rank — otherwise they
 * pad rank 0 and stretch every line that starts there.
 */
function layoutUntangled(
  items: Sized[],
  edges: ReadonlyArray<Link>,
  opts: LayoutMetrics,
): { placed: Placed[]; width: number; height: number } {
  const ids = new Set(items.map((i) => i.id));
  const seen = new Set<string>();
  const internal: Link[] = [];
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
    const key = `${e.source} ${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    internal.push({ source: e.source, target: e.target });
  }

  const degree = new Map<string, number>();
  for (const e of internal) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const connected = items.filter((i) => (degree.get(i.id) ?? 0) > 0);
  const isolated = items.filter((i) => (degree.get(i.id) ?? 0) === 0);

  const rank = rankNodes(new Set(connected.map((i) => i.id)), internal);
  const depth = connected.length ? Math.max(...connected.map((i) => rank.get(i.id)!)) + 1 : 0;

  // ── The layered graph, channels included ──────────────────────────────────
  const sizeById = new Map<string, Sized>(connected.map((i) => [i.id, i]));
  const layers: string[][] = Array.from({ length: depth }, () => []);
  for (const item of connected) layers[rank.get(item.id)!]!.push(item.id);
  /** Neighbours one layer up (toward rank 0) and one layer down. */
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  const link = (upper: string, lower: string) => {
    if (!down.has(upper)) down.set(upper, []);
    if (!up.has(lower)) up.set(lower, []);
    down.get(upper)!.push(lower);
    up.get(lower)!.push(upper);
  };
  const spans = new Set<string>();
  let channels = 0;
  for (const e of internal) {
    let [upper, lower] = [e.source, e.target];
    // A back-edge (cycle remnant) is layered as if it pointed forward.
    if (rank.get(upper)! > rank.get(lower)!) [upper, lower] = [lower, upper];
    if (rank.get(upper) === rank.get(lower)) continue; // same rank: nothing to order across
    const key = `${upper} ${lower}`;
    if (spans.has(key)) continue;
    spans.add(key);
    let prev = upper;
    for (let r = rank.get(upper)! + 1; r < rank.get(lower)!; r += 1) {
      const id = `${CHANNEL_PREFIX}${channels++}`;
      // A channel is spaced like a small box: zero wide, one gap tall, so the
      // line it carries has a lane of its own between the real boxes.
      sizeById.set(id, { id, w: 0, h: opts.nodeGap });
      layers[r]!.push(id);
      link(prev, id);
      prev = id;
    }
    link(prev, lower);
  }
  const isChannel = (id: string) => id.startsWith(CHANNEL_PREFIX);

  // ── Order: barycentre sweeps, best of many ────────────────────────────────
  const pos = new Map<string, number>();
  const index = (order: readonly (readonly string[])[]) => {
    order.forEach((layer) => layer.forEach((id, i) => pos.set(id, i)));
  };
  const crossingsOf = (order: readonly (readonly string[])[]): number => {
    index(order);
    let total = 0;
    for (let l = 0; l + 1 < order.length; l += 1) {
      const links: Array<[number, number]> = [];
      for (const id of order[l]!) {
        for (const lower of down.get(id) ?? []) links.push([pos.get(id)!, pos.get(lower)!]);
      }
      total += bilayerCrossings(links, order[l + 1]!.length);
    }
    return total;
  };
  /**
   * Re-order one layer by the mean position of its neighbours in the layer
   * it is being sorted against. A member with no neighbour there has no
   * opinion and keeps its slot; only the members that do are re-dealt.
   */
  const sortByBarycentre = (layer: string[], neighbours: ReadonlyMap<string, string[]>) => {
    const score = new Map<string, number>();
    for (const id of layer) {
      const near = neighbours.get(id) ?? [];
      if (near.length) score.set(id, near.reduce((sum, n) => sum + pos.get(n)!, 0) / near.length);
    }
    const movable = layer.filter((id) => score.has(id)).sort((a, b) => score.get(a)! - score.get(b)!);
    let next = 0;
    for (let i = 0; i < layer.length; i += 1) {
      if (score.has(layer[i]!)) layer[i] = movable[next++]!;
    }
    layer.forEach((id, i) => pos.set(id, i));
  };
  /** Crossings between the lines of two rank-mates when `a` sits above `b`. */
  const pairCrossings = (a: string, b: string): number => {
    let n = 0;
    for (const side of [up, down]) {
      for (const x of side.get(a) ?? []) {
        for (const y of side.get(b) ?? []) if (pos.get(x)! > pos.get(y)!) n += 1;
      }
    }
    return n;
  };
  /** Swap adjacent rank-mates while doing so removes crossings. */
  const transpose = (order: string[][]) => {
    for (const layer of order) {
      let improved = true;
      let guard = 0;
      while (improved && guard++ < layer.length) {
        improved = false;
        for (let i = 0; i + 1 < layer.length; i += 1) {
          const a = layer[i]!;
          const b = layer[i + 1]!;
          if (pairCrossings(b, a) < pairCrossings(a, b)) {
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

  let order = layers.map((layer) => [...layer]);
  let best = order.map((layer) => [...layer]);
  let bestCount = crossingsOf(order);
  let stale = 0;
  for (let sweep = 0; sweep < UNTANGLE_SWEEPS && bestCount > 0; sweep += 1) {
    index(order);
    if (sweep % 2 === 0) {
      for (let l = 1; l < order.length; l += 1) sortByBarycentre(order[l]!, up);
    } else {
      for (let l = order.length - 2; l >= 0; l -= 1) sortByBarycentre(order[l]!, down);
    }
    transpose(order);
    const count = crossingsOf(order);
    if (count < bestCount) {
      best = order.map((layer) => [...layer]);
      bestCount = count;
      stale = 0;
    } else if (++stale >= UNTANGLE_PATIENCE) {
      break;
    }
  }
  order = best;

  // ── Coordinates ───────────────────────────────────────────────────────────
  const gap = opts.nodeGap;
  const colHeight = (row: readonly string[]) =>
    row.reduce((sum, id) => sum + sizeById.get(id)!.h, 0) + gap * (row.length - 1);

  const columns = wrapRanks(order, sizeById, opts);
  const columnWidths = columns.map((row) => Math.max(...row.map((id) => sizeById.get(id)!.w), 0));
  const columnHeights = columns.map(colHeight);
  const tallest = Math.max(...columnHeights, 0);

  // Start from the flow arrangement — each column centred on the tallest —
  // then let every column slide toward what it connects to.
  const top = new Map<string, number>();
  columns.forEach((row, ci) => {
    let y = (tallest - columnHeights[ci]!) / 2;
    for (const id of row) {
      top.set(id, y);
      y += sizeById.get(id)!.h + gap;
    }
  });
  const centre = (id: string) => top.get(id)! + sizeById.get(id)!.h / 2;
  const weightOf = (id: string) => (isChannel(id) ? CHANNEL_WEIGHT : 1);
  const slide = (row: readonly string[], sides: ReadonlyArray<ReadonlyMap<string, string[]>>) => {
    // Constraint space: subtract each box's offset down the stack so "no
    // overlap, order kept" reads as plain "non-decreasing".
    const offsets: number[] = [];
    let offset = 0;
    for (const id of row) {
      offsets.push(offset);
      offset += sizeById.get(id)!.h + gap;
    }
    const desired = row.map((id, i) => {
      let sum = 0;
      let weight = 0;
      for (const side of sides) {
        for (const n of side.get(id) ?? []) {
          sum += centre(n) * weightOf(n);
          weight += weightOf(n);
        }
      }
      const want = weight ? sum / weight : centre(id);
      return want - sizeById.get(id)!.h / 2 - offsets[i]!;
    });
    const fitted = isotonic(desired, row.map(weightOf));
    row.forEach((id, i) => top.set(id, fitted[i]! + offsets[i]!));
  };
  for (let round = 0; round < STRAIGHTEN_ROUNDS; round += 1) {
    for (const row of columns) slide(row, [up]);
    for (let ci = columns.length - 1; ci >= 0; ci -= 1) slide(columns[ci]!, [down]);
  }
  for (const row of columns) slide(row, [up, down]);

  // Real boxes only from here: the channels did their job in the ordering
  // and the sliding, and a reader never sees them.
  const real = columns.flat().filter((id) => !isChannel(id));
  const minY = real.length ? Math.min(...real.map((id) => top.get(id)!)) : 0;
  const placed: Placed[] = [];
  let x = 0;
  columns.forEach((row, ci) => {
    for (const id of row) {
      if (isChannel(id)) continue;
      const size = sizeById.get(id)!;
      placed.push({
        id,
        x: x + (columnWidths[ci]! - size.w) / 2,
        y: top.get(id)! - minY,
        w: size.w,
        h: size.h,
      });
    }
    x += columnWidths[ci]! + opts.rankGap;
  });
  let height = placed.length ? Math.max(...placed.map((p) => p.y + p.h)) : 0;

  // ── The boxes no line touches, parked after the flow ──────────────────────
  if (isolated.length) {
    const parkedSizes = new Map<string, Sized>(isolated.map((i) => [i.id, i]));
    const parked = wrapRanks([isolated.map((i) => i.id)], parkedSizes, opts);
    const parkedHeights = parked.map(
      (row) => row.reduce((sum, id) => sum + parkedSizes.get(id)!.h, 0) + gap * (row.length - 1),
    );
    const parkedTallest = Math.max(...parkedHeights, 0);
    // Centre the grid on the flow beside it, or the flow on the grid when
    // the grid is the taller of the two.
    const shift = Math.max(0, (parkedTallest - height) / 2);
    if (shift) for (const p of placed) p.y += shift;
    height = Math.max(height, parkedTallest);
    parked.forEach((row, ci) => {
      const width = Math.max(...row.map((id) => parkedSizes.get(id)!.w));
      let y = (height - parkedHeights[ci]!) / 2;
      for (const id of row) {
        const size = parkedSizes.get(id)!;
        placed.push({ id, x: x + (width - size.w) / 2, y, w: size.w, h: size.h });
        y += size.h + gap;
      }
      x += width + opts.rankGap;
    });
  }

  return { placed, width: Math.max(0, x - opts.rankGap), height };
}

/**
 * Tidy a whole template.
 *
 * Nodes are assigned to the innermost container that owns them — a group wins
 * over a zone, because `parentId` is an explicit statement of containment
 * while zone membership is positional. Containers grow to fit; zones keep
 * their origin.
 */
export function autoLayout(template: DiagramTemplate, options: LayoutOptions = {}): DiagramTemplate {
  const opts: LayoutMetrics = {
    ...DEFAULTS,
    ...options,
    mode: options.mode ?? template.settings?.arrange ?? "flow",
  };
  const zones = template.zones ?? [];
  // A card's children live in their own drilled canvas, so a tidy arranges
  // one FRAME — by default the visible one, never a level you can't see.
  const containerKindSet = new Set(options.containerKinds ?? CONTAINER_KINDS);
  const cardParents = cardParentIdsOf(template, options.containerKinds);
  const frameOf = frameResolver(template, cardParents);
  const frames = options.frames ?? "root";
  const inScope = (frame: string | null) =>
    frames === "all" ? true : frames === "root" ? frame === null : frame === frames.drill;
  const rootInScope = inScope(null);
  const containerIds = new Set(
    template.nodes
      .filter(
        (n) =>
          template.nodes.some((c) => c.parentId === n.id) &&
          // A card is never resized: its contents render on another level.
          !cardParents.has(n.id) &&
          inScope(frameOf(n.id)),
      )
      .map((n) => n.id),
  );

  // Bucket every node by the container that positions it.
  //   "group:<id>" → laid out in that group's local space
  //   "zone:<id>"  → laid out in absolute space, inside the zone box
  //   "root"       → laid out in absolute space
  const bucketOf = (node: DiagramNode): string => {
    if (node.parentId) return `group:${node.parentId}`;
    if (node.zoneId && zones.some((z) => z.id === node.zoneId)) return `zone:${node.zoneId}`;
    return "root";
  };

  const buckets = new Map<string, DiagramNode[]>();
  for (const node of template.nodes) {
    // A container is positioned by *its* bucket, and its children are laid out
    // inside it — so a group appears in its parent's bucket, not its own.
    const key = bucketOf(node);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(node);
  }

  // A lock says "the editor refuses to drag or resize it". A tidy is the
  // editor moving things, so it has to honour that: a pinned node keeps its
  // position and its size, and the rest of the diagram is arranged around
  // whatever space is left. It is still an obstacle the ranking doesn't know
  // about, which is the price of pinning something inside a flow.
  const locked = new Set(template.nodes.filter((n) => n.locked).map((n) => n.id));

  // Provider ALTERNATES — the same box in two topologies — are authored on
  // top of each other so switching provider swaps them in place. Ranking them
  // as separate members would deal them separate slots, leaving a permanent
  // gap for whichever is hidden and making the database jump when the
  // scenario changes. One of each set takes part in the layout; the others
  // follow it. See `variantGroups` for what counts as an alternate.
  const variantOf = variantGroups(template);

  const positions = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, { w: number; h: number }>();
  /** What a container should STORE, which for a chip is not what it is spaced by. */
  const fitted = new Map<string, { w: number; h: number }>();
  /**
   * Containers drawn as a chip. Such a group is SPACED as a chip — its
   * rank-mates must not leave a hole the size of the frame it is not
   * drawing — while its STORED size still has to hold what it is hiding,
   * or expanding it would spill its children outside their own frame.
   * Two different sizes, so they are kept in two different maps.
   */
  const chipped = new Set(
    template.nodes.filter((n) => n.collapsed && containerKindSet.has(n.kind as string)).map((n) => n.id),
  );
  for (const n of template.nodes) {
    sizes.set(n.id, chipped.has(n.id) ? { ...COLLAPSED_SIZE } : { w: n.w, h: n.h });
  }

  /** The members one layout pass should actually rank, in document order. */
  const rankable = (members: DiagramNode[]): DiagramNode[] =>
    members.filter((n) => !locked.has(n.id) && (variantOf.get(n.id) ?? n.id) === n.id);

  // Groups innermost-first, so a nested group has its final size before the
  // group containing it is laid out.
  const groupDepth = (id: string): number => {
    let d = 0;
    let cursor = template.nodes.find((n) => n.id === id);
    const guard = new Set<string>();
    while (cursor?.parentId && !guard.has(cursor.parentId)) {
      guard.add(cursor.parentId);
      d++;
      cursor = template.nodes.find((n) => n.id === cursor!.parentId);
    }
    return d;
  };

  /** A group's members sit in its own drilled canvas when it IS a card. */
  const frameOfGroup = (gid: string) => (cardParents.has(gid) ? gid : frameOf(gid));

  const groupKeys = [...buckets.keys()]
    .filter((k) => k.startsWith("group:") && inScope(frameOfGroup(k.slice(6))))
    .sort((a, b) => groupDepth(b.slice(6)) - groupDepth(a.slice(6)));

  for (const key of groupKeys) {
    const members = rankable(buckets.get(key)!);
    const result = layoutGroup(
      members.map((n) => ({ id: n.id, ...sizes.get(n.id)! })),
      template.edges,
      opts,
    );
    for (const p of result.placed) {
      // Group children are positioned relative to the group's own top-left.
      positions.set(p.id, { x: opts.padding + p.x, y: opts.headerGap + p.y });
    }
    // Grow the group so its contents fit — but never a card: its drill
    // contents render on their own level, so its rank-mates must keep
    // spacing against the card's REAL footprint.
    const groupId = key.slice(6);
    if (!cardParents.has(groupId)) {
      const fit = {
        w: Math.max(160, result.width + opts.padding * 2),
        h: Math.max(120, result.height + opts.headerGap + opts.padding),
      };
      fitted.set(groupId, fit);
      // A chip keeps its chip footprint for spacing; everything else is
      // spaced by the box it actually draws.
      if (!chipped.has(groupId)) sizes.set(groupId, fit);
    }
  }

  // Zones: lay members out inside the zone box, growing the zone if needed.
  // Zones and the root flow belong to the visible canvas, so a drill-scoped
  // tidy leaves both exactly as they were.
  const grownZones = zones.map((zone) => {
    const members = rootInScope ? rankable(buckets.get(`zone:${zone.id}`) ?? []) : [];
    if (!members.length) return zone;
    const result = layoutGroup(
      members.map((n) => ({ id: n.id, ...sizes.get(n.id)! })),
      template.edges,
      opts,
    );
    for (const p of result.placed) {
      positions.set(p.id, {
        x: zone.x + opts.padding + p.x,
        y: zone.y + opts.headerGap + p.y,
      });
    }
    const needW = result.width + opts.padding * 2;
    const needH = result.height + opts.headerGap + opts.padding;
    // A non-rectangular zone loses usable area at its edges, so give the
    // contents extra room rather than letting them spill outside the outline.
    const slack = zone.shape === "rect" || zone.shape === "rounded" ? 1 : 1.35;
    return {
      ...zone,
      w: Math.max(zone.w, needW * slack),
      h: Math.max(zone.h, needH * slack),
    };
  });

  // Root: everything not in a group or zone, placed clear of the zones.
  const rootMembers = rootInScope ? rankable(buckets.get("root") ?? []) : [];
  if (rootMembers.length) {
    const result = layoutGroup(
      rootMembers.map((n) => ({ id: n.id, ...sizes.get(n.id)! })),
      template.edges,
      opts,
    );
    // Drop the root flow below the zones so the two don't overlap.
    const zoneBottom = grownZones.length
      ? Math.max(...grownZones.map((z) => z.y + z.h)) + opts.rankGap
      : 0;
    const zoneLeft = grownZones.length ? Math.min(...grownZones.map((z) => z.x)) : 0;
    for (const p of result.placed) {
      positions.set(p.id, { x: zoneLeft + p.x, y: zoneBottom + p.y });
    }
  }

  const nodes = template.nodes.map((node) => {
    // An alternate lands wherever its representative landed, which is what
    // keeps the three managed databases one box that changes name.
    const lead = variantOf.get(node.id) ?? node.id;
    const position = locked.has(node.id) ? undefined : positions.get(lead);
    const size = sizes.get(node.id)!;
    return {
      ...node,
      ...(position ? { x: position.x, y: position.y } : {}),
      // Only containers were resized; leaves keep their authored size. A
      // locked container is not resized either — the lock covers both.
      ...(containerIds.has(node.id) && !locked.has(node.id)
        ? (fitted.get(node.id) ?? size)
        : {}),
    };
  });

  // A tidy re-ranks everything, so hand-placed edge waypoints are stale by
  // definition — clear them rather than leave routes bending toward where the
  // nodes used to be. Pinned anchors survive: which side an edge attaches to
  // is intent, not a position.
  const edges = template.edges.some((e) => e.points)
    ? template.edges.map((e) => {
        if (!e.points) return e;
        // A route is only stale if this tidy actually re-ranked one of its
        // ends: waypoints in a frame nobody touched still describe reality.
        if (!inScope(frameOf(e.source)) && !inScope(frameOf(e.target))) return e;
        const { points: _stale, ...rest } = e;
        return rest;
      })
    : template.edges;

  return {
    ...template,
    nodes,
    edges,
    ...(grownZones.length ? { zones: grownZones } : {}),
  };
}

/**
 * Give positions to just the named nodes, moving NOTHING that already has one.
 *
 * The counterpart to `autoLayout` for incremental arrivals — a merged content
 * edit, a presentation record lost to reparenting. A full re-layout would
 * rearrange the exact hand-made arrangement the caller is trying to preserve,
 * so this stacks each newcomer below the occupied area of its own container
 * (group, zone, or the root canvas) and only ever GROWS containers to fit —
 * growth is additive; existing nodes stay where they are.
 *
 * Deepest containers first, like `autoLayout`: a pending group has its final
 * grown size before the group itself is placed.
 */
export function placeUnpositioned(
  template: DiagramTemplate,
  ids: readonly string[],
  options: LayoutOptions = {},
): DiagramTemplate {
  const opts = { ...DEFAULTS, ...options };
  const wanted = new Set(ids);
  if (!wanted.size || !template.nodes.some((n) => wanted.has(n.id))) return template;

  const nodes = template.nodes.map((n) => ({ ...n }));
  const nById = new Map(nodes.map((n) => [n.id, n]));
  const zones = (template.zones ?? []).map((z) => ({ ...z }));
  const zById = new Map(zones.map((z) => [z.id, z]));
  const pending = new Set([...wanted].filter((id) => nById.has(id)));

  const depthOf = (n: DiagramNode): number => {
    let d = 0;
    let cursor: DiagramNode | undefined = n;
    const guard = new Set<string>([n.id]);
    while (cursor?.parentId && !guard.has(cursor.parentId)) {
      guard.add(cursor.parentId);
      d++;
      cursor = nById.get(cursor.parentId);
    }
    return d;
  };

  // Ensure every ancestor is big enough to contain the child, and the zone big
  // enough to contain the topmost node. Only w/h ever change. The walk stops
  // at a card parent: its children live in its own drilled canvas, so the
  // card's rendered size owes them nothing.
  const containerSet = new Set(options.containerKinds ?? CONTAINER_KINDS);
  const growAround = (id: string) => {
    let child = nById.get(id);
    while (child?.parentId) {
      const parent = nById.get(child.parentId);
      if (!parent || !containerSet.has(parent.kind as string)) break;
      parent.w = Math.max(parent.w, child.x + child.w + opts.padding);
      parent.h = Math.max(parent.h, child.y + child.h + opts.padding);
      child = parent;
    }
    // Zone growth only makes sense in root space — a walk that stopped at a
    // card parent left `child` holding drill-space coordinates.
    const zone = child?.zoneId ? zById.get(child.zoneId) : undefined;
    if (zone && child && !child.parentId) {
      zone.w = Math.max(zone.w, child.x + child.w + opts.padding - zone.x);
      zone.h = Math.max(zone.h, child.y + child.h + opts.padding - zone.y);
    }
  };

  const bucketOf = (n: DiagramNode): string => {
    if (n.parentId && nById.has(n.parentId)) return `group:${n.parentId}`;
    if (n.zoneId && zById.has(n.zoneId)) return `zone:${n.zoneId}`;
    return "root";
  };

  // Deepest first, insertion order preserved by the Map.
  const arrivals = nodes.filter((n) => pending.has(n.id)).sort((a, b) => depthOf(b) - depthOf(a));
  const buckets = new Map<string, DiagramNode[]>();
  for (const n of arrivals) {
    const key = bucketOf(n);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(n);
  }

  const bottomOf = (list: DiagramNode[], fallback: number) =>
    list.length ? Math.max(...list.map((s) => s.y + s.h)) + opts.nodeGap : fallback;

  for (const [key, members] of buckets) {
    if (key.startsWith("group:")) {
      const gid = key.slice(6);
      // Positioned siblings, in the group's parent-relative space.
      const siblings = nodes.filter((n) => n.parentId === gid && !pending.has(n.id));
      let y = bottomOf(siblings, opts.headerGap);
      for (const m of members) {
        m.x = opts.padding;
        m.y = y;
        y += m.h + opts.nodeGap;
        pending.delete(m.id);
        growAround(m.id);
      }
    } else if (key.startsWith("zone:")) {
      const zone = zById.get(key.slice(5))!;
      const siblings = nodes.filter((n) => !n.parentId && n.zoneId === zone.id && !pending.has(n.id));
      let y = bottomOf(siblings, zone.y + opts.headerGap);
      for (const m of members) {
        m.x = zone.x + opts.padding;
        m.y = y;
        y += m.h + opts.nodeGap;
        pending.delete(m.id);
        growAround(m.id);
      }
    } else {
      // Root: below everything already on the canvas.
      const placedRoots = nodes.filter((n) => !n.parentId && !pending.has(n.id));
      const bottoms = [...placedRoots.map((n) => n.y + n.h), ...zones.map((z) => z.y + z.h)];
      const lefts = [...placedRoots.map((n) => n.x), ...zones.map((z) => z.x)];
      let y = bottoms.length ? Math.max(...bottoms) + opts.rankGap : 0;
      const x = lefts.length ? Math.min(...lefts) : 0;
      for (const m of members) {
        m.x = x;
        m.y = y;
        y += m.h + opts.nodeGap;
        pending.delete(m.id);
        growAround(m.id);
      }
    }
  }

  return { ...template, nodes, ...(zones.length ? { zones } : {}) };
}

/**
 * Does this template look like it needs tidying?
 *
 * Used to offer layout on freshly generated documents without imposing it on a
 * hand-arranged one. True when any two nodes in the same container overlap —
 * the failure mode LLM output actually has.
 */
export function hasOverlaps(
  template: DiagramTemplate,
  opts: { containerKinds?: readonly string[] } = {},
): boolean {
  const zones = template.zones ?? [];
  const byId = new Map(template.nodes.map((n) => [n.id, n]));
  const containerSet = new Set(opts.containerKinds ?? CONTAINER_KINDS);
  const cardParents = cardParentIdsOf(template, opts.containerKinds);
  const frameOf = frameResolver(template, cardParents);
  /**
   * Position within the node's OWN frame — the walk stops at a card, whose
   * position belongs to the frame outside. Mixing the two would compare a
   * drilled canvas's local coordinates against the root canvas's.
   */
  const abs = (n: DiagramNode) => {
    let x = n.x;
    let y = n.y;
    let parent = n.parentId && !cardParents.has(n.parentId) ? byId.get(n.parentId) : undefined;
    const guard = new Set<string>([n.id]);
    while (parent && !guard.has(parent.id)) {
      guard.add(parent.id);
      x += parent.x;
      y += parent.y;
      parent =
        parent.parentId && !cardParents.has(parent.parentId)
          ? byId.get(parent.parentId)
          : undefined;
    }
    return { x, y };
  };

  // Only nodes visible *at the same time* can look like a mess. Provider
  // alternatives are routinely stacked on one spot on purpose — an Azure SQL
  // and an RDS occupying the same coordinates is the intended way to express
  // "this slot, per provider", not something to tidy apart.
  const visible = visibleElements(template).nodes;

  // Open containers legitimately overlap their own children, so skip them —
  // but a CARD parent's children render elsewhere entirely, making the card
  // an ordinary box whose overlaps are as real as any leaf's.
  const leaves = template.nodes.filter(
    (n) =>
      visible.has(n.id) &&
      (!template.nodes.some((c) => c.parentId === n.id) || !containerSet.has(n.kind as string)) &&
      n.kind !== "text",
  );

  // Compare only boxes that share a frame: a drilled canvas is its own
  // picture, and a model that piled one at the origin needs tidying just as
  // much as a messy root — but the two never overlap each other.
  const byFrame = new Map<string, Array<{ x: number; y: number; w: number; h: number }>>();
  for (const n of leaves) {
    const key = frameOf(n.id) ?? "";
    if (!byFrame.has(key)) byFrame.set(key, []);
    byFrame.get(key)!.push({ ...abs(n), w: n.w, h: n.h });
  }

  for (const boxes of byFrame.values()) {
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) return true;
      }
    }
  }

  // A node sitting outside the zone it claims also counts as needing a tidy.
  for (const node of template.nodes) {
    if (!node.zoneId || node.parentId) continue;
    const zone = zones.find((z) => z.id === node.zoneId);
    if (zone && !pointInZone(zone, node.x + node.w / 2, node.y + node.h / 2)) return true;
  }
  return false;
}
