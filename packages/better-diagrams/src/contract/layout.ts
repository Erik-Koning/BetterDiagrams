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
import { pointInZone, type DiagramZone } from "./zones";
import { visibleElements } from "./schema";
import type { DiagramEdge, DiagramNode, DiagramTemplate } from "./schema";

export interface LayoutOptions {
  /** Horizontal gap between ranks. */
  rankGap?: number;
  /** Vertical gap between nodes in the same rank. */
  nodeGap?: number;
  /** Inset from a container's edges. */
  padding?: number;
  /** Extra top inset, clearing a zone or group's header chip. */
  headerGap?: number;
}

const DEFAULTS = { rankGap: 90, nodeGap: 28, padding: 28, headerGap: 52 } as const;

interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Arrange a set of boxes by the edges between them.
 *
 * Returns positions relative to (0,0) plus the total size occupied. Pure — it
 * knows nothing about zones or groups, which is what lets the same routine
 * drive every container and the root canvas.
 */
function layoutGroup(
  items: Array<{ id: string; w: number; h: number }>,
  edges: ReadonlyArray<{ source: string; target: string }>,
  opts: Required<LayoutOptions>,
): { placed: Placed[]; width: number; height: number } {
  if (!items.length) return { placed: [], width: 0, height: 0 };

  const ids = new Set(items.map((i) => i.id));
  const internal = edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);

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

  // ── Rank: longest path from a source ──────────────────────────────────────
  // Kahn's algorithm, so a cycle simply leaves nodes unranked rather than
  // looping forever. Anything left over is placed in rank 0.
  const rank = new Map<string, number>();
  const queue: string[] = [];
  for (const id of ids) if ((indegree.get(id) ?? 0) === 0) (rank.set(id, 0), queue.push(id));

  const pending = new Map(indegree);
  while (queue.length) {
    const id = queue.shift()!;
    const r = rank.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      // Longest path: a node sits one rank past its deepest predecessor.
      rank.set(next, Math.max(rank.get(next) ?? 0, r + 1));
      pending.set(next, (pending.get(next) ?? 0) - 1);
      if ((pending.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  for (const id of ids) if (!rank.has(id)) rank.set(id, 0); // cycle remnants

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
    // rank. Two passes would refine it further; one is enough to remove the
    // obvious crossings without the cost.
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
  const columns = ranks.map((r) => byRank.get(r)!);
  const columnWidths = columns.map((row) =>
    Math.max(...row.map((id) => sizeById.get(id)!.w)),
  );
  const columnHeights = columns.map((row) =>
    row.reduce((sum, id) => sum + sizeById.get(id)!.h, 0) + opts.nodeGap * (row.length - 1),
  );
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

/**
 * Tidy a whole template.
 *
 * Nodes are assigned to the innermost container that owns them — a group wins
 * over a zone, because `parentId` is an explicit statement of containment
 * while zone membership is positional. Containers grow to fit; zones keep
 * their origin.
 */
export function autoLayout(template: DiagramTemplate, options: LayoutOptions = {}): DiagramTemplate {
  const opts = { ...DEFAULTS, ...options };
  const zones = template.zones ?? [];
  const containerIds = new Set(
    template.nodes.filter((n) => template.nodes.some((c) => c.parentId === n.id)).map((n) => n.id),
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

  const positions = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, { w: number; h: number }>();
  for (const n of template.nodes) sizes.set(n.id, { w: n.w, h: n.h });

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

  const groupKeys = [...buckets.keys()]
    .filter((k) => k.startsWith("group:"))
    .sort((a, b) => groupDepth(b.slice(6)) - groupDepth(a.slice(6)));

  for (const key of groupKeys) {
    const members = buckets.get(key)!;
    const result = layoutGroup(
      members.map((n) => ({ id: n.id, ...sizes.get(n.id)! })),
      template.edges,
      opts,
    );
    for (const p of result.placed) {
      // Group children are positioned relative to the group's own top-left.
      positions.set(p.id, { x: opts.padding + p.x, y: opts.headerGap + p.y });
    }
    // Grow the group so its contents fit.
    const groupId = key.slice(6);
    sizes.set(groupId, {
      w: Math.max(160, result.width + opts.padding * 2),
      h: Math.max(120, result.height + opts.headerGap + opts.padding),
    });
  }

  // Zones: lay members out inside the zone box, growing the zone if needed.
  const grownZones = zones.map((zone) => {
    const members = buckets.get(`zone:${zone.id}`) ?? [];
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
  const rootMembers = buckets.get("root") ?? [];
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
    const position = positions.get(node.id);
    const size = sizes.get(node.id)!;
    return {
      ...node,
      ...(position ? { x: position.x, y: position.y } : {}),
      // Only containers were resized; leaves keep their authored size.
      ...(containerIds.has(node.id) ? { w: size.w, h: size.h } : {}),
    };
  });

  return {
    ...template,
    nodes,
    ...(grownZones.length ? { zones: grownZones } : {}),
  };
}

/**
 * Does this template look like it needs tidying?
 *
 * Used to offer layout on freshly generated documents without imposing it on a
 * hand-arranged one. True when any two nodes in the same container overlap —
 * the failure mode LLM output actually has.
 */
export function hasOverlaps(template: DiagramTemplate): boolean {
  const zones = template.zones ?? [];
  const byId = new Map(template.nodes.map((n) => [n.id, n]));
  const abs = (n: DiagramNode) => {
    let x = n.x;
    let y = n.y;
    let parent = n.parentId ? byId.get(n.parentId) : undefined;
    const guard = new Set<string>([n.id]);
    while (parent && !guard.has(parent.id)) {
      guard.add(parent.id);
      x += parent.x;
      y += parent.y;
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return { x, y };
  };

  // Only nodes visible *at the same time* can look like a mess. Provider
  // alternatives are routinely stacked on one spot on purpose — an Azure SQL
  // and an RDS occupying the same coordinates is the intended way to express
  // "this slot, per provider", not something to tidy apart.
  const visible = visibleElements(template).nodes;

  // Containers legitimately overlap their own children, so compare leaves only.
  const leaves = template.nodes.filter(
    (n) =>
      visible.has(n.id) &&
      !template.nodes.some((c) => c.parentId === n.id) &&
      n.kind !== "text",
  );
  const boxes = leaves.map((n) => ({ ...abs(n), w: n.w, h: n.h }));

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) return true;
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

/** Re-exported for tests and for hosts building their own layout controls. */
export type { DiagramZone, DiagramEdge };
