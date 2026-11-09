/**
 * layout-frames.ts — what every arrangement has to agree on before it places
 * anything: which boxes stand for one another, which canvas a box lives on,
 * and the two small solvers the layered layouts share. Lives apart from
 * `layout.ts` so the auto-placer can use them without importing it.
 */
import type { DiagramNode, DiagramTemplate } from "./schema";
import { CONTAINER_KINDS } from "./schema";

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
export function variantGroups(template: DiagramTemplate): Map<string, string> {
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

/** Ids of the parents whose children are drill-in detail, not inline content. */
export function cardParentIdsOf(
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
export function frameResolver(
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

/**
 * Lines between two consecutive layers that cross, given each layer's order.
 * Sort the lines by their upper end, then count inversions among the lower
 * ends — a Fenwick tree makes it O(E log E), which matters for a data model
 * with a few hundred foreign keys in one zone.
 */
export function bilayerCrossings(
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
export function isotonic(desired: readonly number[], weights: readonly number[]): number[] {
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
