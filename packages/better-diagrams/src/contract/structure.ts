/**
 * structure.ts — the shape of a data model: its hubs, the tables and keys
 * holding it together, and the domains it falls into.
 *
 * At a thousand tables nobody reads the whole diagram; they read its
 * structure. Over the KEY graph between tables (undirected — a key joins
 * two tables either way), this computes:
 *
 *   hubs          betweenness centrality (Brandes) — how many shortest
 *                 routes between other tables run through a table — with
 *                 degree beside it; sampled past `sampleAbove` tables, and
 *                 saying so (`approximate`).
 *   articulation  tables whose removal splits the model (Tarjan);
 *   bridges       keys whose removal splits it (never one of two parallel keys).
 *   islands       tables no key touches.
 *   shared        tables pointed at from all over the model (users, accounts,
 *                 audit) — keys spread over many domains, none holding half —
 *                 set aside so they don't pull the domains together.
 *   domains       a partition of the rest suggested by Louvain, deterministic
 *                 (document order breaks every tie), each named after its most
 *                 central table, with its internal and external keys and the
 *                 partition's modularity.
 *   misplaced     tables whose keys mostly lead into another declared group
 *                 than their own — the importer's bands and groups, or the
 *                 author's.
 *
 * Zero dependencies, like every contract module.
 */
import { edgeFieldIds, type FieldDocument } from "./fields";
import { storesFields } from "./coverage";

type DocNode = FieldDocument["nodes"][number] & { parentId?: string | null };

export interface TableMetrics {
  degreeIn: number;
  degreeOut: number;
  /** Shortest routes between other tables running through this one. */
  betweenness: number;
  /** `betweenness` over the most any table could have, 0..1. */
  centrality: number;
}

export interface Domain {
  id: string;
  /** The most central table's label. */
  label: string;
  tables: string[];
  internalKeys: number;
  externalKeys: number;
}

export interface ModelStructure {
  /** Every table's metrics. */
  metrics: Map<string, TableMetrics>;
  /** Tables by centrality, most central first (ties by degree, then document order). */
  hubs: string[];
  articulation: string[];
  /** How many pieces the model around each articulation table falls into without it. */
  splits: Record<string, number>;
  /** Edge ids. */
  bridges: string[];
  islands: string[];
  /** Tables so many others point at (users, accounts) that they belong to no one domain — set aside before clustering. */
  shared: string[];
  /** Tables joined to others only through shared tables: in no domain, but not islands. */
  unassigned: string[];
  /** Suggested domains, largest first; shared, unassigned and island tables are in none. */
  domains: Domain[];
  /** The partition's modularity over the keys between tables that are not shared (0 = no structure). */
  modularity: number;
  misplaced: Array<{ nodeId: string; group: string; pullsToward: string; share: number }>;
  /** Betweenness was sampled rather than exact. */
  approximate: boolean;
}

export interface StructureOptions {
  isTable?: (node: FieldDocument["nodes"][number]) => boolean;
  /** Past this many tables, betweenness is estimated from this many evenly spaced sources. Default 1500. */
  sampleAbove?: number;
  /**
   * The fewest distinct tables a table must be joined to before it can count
   * as shared — and then only if those tables spread over three or more
   * domains with none holding half. Default 5; `false` sets nothing aside.
   */
  sharedThreshold?: number | false;
  /** Local-moving rounds per Louvain level. Default 50. */
  maxIterations?: number;
}

export function modelStructure(doc: FieldDocument, opts: StructureOptions = {}): ModelStructure {
  const isTable = opts.isTable ?? storesFields;
  const tables = (doc.nodes as readonly DocNode[]).filter(isTable);
  const index = new Map(tables.map((n, i) => [n.id, i]));
  const n = tables.length;

  // Key edges between tables; self-loops say nothing about structure.
  const keyEdges = doc.edges.filter(
    (e) => edgeFieldIds(e).start !== undefined && e.source !== e.target && index.has(e.source) && index.has(e.target),
  );
  const adj: Array<Array<{ to: number; edge: string }>> = Array.from({ length: n }, () => []);
  const degreeIn = new Array<number>(n).fill(0);
  const degreeOut = new Array<number>(n).fill(0);
  for (const e of keyEdges) {
    const a = index.get(e.source)!;
    const b = index.get(e.target)!;
    adj[a]!.push({ to: b, edge: e.id });
    adj[b]!.push({ to: a, edge: e.id });
    degreeOut[a]!++;
    degreeIn[b]!++;
  }
  // Neighbours without parallel duplicates, for the shortest-path counts.
  const nbrs = adj.map((list) => [...new Set(list.map((x) => x.to))]);

  // ── Betweenness (Brandes, unweighted) ──
  const sampleAbove = opts.sampleAbove ?? 1500;
  const approximate = n > sampleAbove;
  const sources = approximate
    ? Array.from({ length: Math.min(n, 300) }, (_, i) => Math.floor((i * n) / Math.min(n, 300)))
    : Array.from({ length: n }, (_, i) => i);
  const cb = new Array<number>(n).fill(0);
  const sigma = new Array<number>(n);
  const dist = new Array<number>(n);
  const delta = new Array<number>(n);
  for (const s of sources) {
    const stack: number[] = [];
    const preds: number[][] = Array.from({ length: n }, () => []);
    sigma.fill(0);
    dist.fill(-1);
    sigma[s] = 1;
    dist[s] = 0;
    const queue = [s];
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head]!;
      stack.push(v);
      for (const w of nbrs[v]!) {
        if (dist[w]! < 0) {
          dist[w] = dist[v]! + 1;
          queue.push(w);
        }
        if (dist[w] === dist[v]! + 1) {
          sigma[w]! += sigma[v]!;
          preds[w]!.push(v);
        }
      }
    }
    delta.fill(0);
    while (stack.length) {
      const w = stack.pop()!;
      for (const v of preds[w]!) delta[v]! += (sigma[v]! / sigma[w]!) * (1 + delta[w]!);
      if (w !== s) cb[w]! += delta[w]!;
    }
  }
  // Undirected: every pair was counted from both ends; a sample scales up.
  const scale = (approximate ? n / sources.length : 1) / 2;
  const maxPairs = n > 2 ? ((n - 1) * (n - 2)) / 2 : 1;
  const metrics = new Map<string, TableMetrics>();
  tables.forEach((t, i) => {
    const betweenness = cb[i]! * scale;
    metrics.set(t.id, { degreeIn: degreeIn[i]!, degreeOut: degreeOut[i]!, betweenness, centrality: Math.min(1, betweenness / maxPairs) });
  });
  const hubs = tables
    .map((t, i) => ({ id: t.id, i, b: cb[i]!, d: degreeIn[i]! + degreeOut[i]! }))
    .filter((x) => x.d > 0)
    .sort((a, b) => b.b - a.b || b.d - a.d || a.i - b.i)
    .map((x) => x.id);

  // ── Articulation points and bridges (Tarjan, iterative) ──
  const disc = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const isCut = new Array<boolean>(n).fill(false);
  const cutChildren = new Array<number>(n).fill(0);
  const roots = new Set<number>();
  const bridges: string[] = [];
  let time = 0;
  for (let root = 0; root < n; root++) {
    if (disc[root] !== -1) continue;
    roots.add(root);
    let rootChildren = 0;
    // Frame: node, the edge that entered it, the next arc to try.
    const frames: Array<{ v: number; via: string | null; next: number }> = [{ v: root, via: null, next: 0 }];
    disc[root] = low[root] = time++;
    while (frames.length) {
      const top = frames[frames.length - 1]!;
      const arcs = adj[top.v]!;
      if (top.next < arcs.length) {
        const { to, edge } = arcs[top.next++]!;
        if (edge === top.via) continue;
        if (disc[to] === -1) {
          disc[to] = low[to] = time++;
          if (top.v === root) rootChildren++;
          frames.push({ v: to, via: edge, next: 0 });
        } else {
          low[top.v] = Math.min(low[top.v]!, disc[to]!);
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (!parent) continue;
      low[parent.v] = Math.min(low[parent.v]!, low[top.v]!);
      if (low[top.v]! > disc[parent.v]!) bridges.push(top.via!);
      if (low[top.v]! >= disc[parent.v]!) {
        cutChildren[parent.v]!++;
        if (parent.v !== root) isCut[parent.v] = true;
      }
    }
    if (rootChildren > 1) isCut[root] = true;
  }
  const articulation = tables.filter((_, i) => isCut[i]).map((t) => t.id);
  // A root's every child is a piece; elsewhere the cut children plus the rest.
  const splits: Record<string, number> = {};
  tables.forEach((t, i) => {
    if (isCut[i]) splits[t.id] = roots.has(i) ? cutChildren[i]! : cutChildren[i]! + 1;
  });
  const islands = tables.filter((_, i) => adj[i]!.length === 0).map((t) => t.id);

  // ── Domains ──
  // Clustered by Louvain, deterministic: document order breaks every tie.
  // Some tables are pointed at from all over the model (users, accounts,
  // audit) and belong to no one domain; left in, they pull the domains
  // together. They are recognised by where their keys go — a table joined to
  // at least `sharedThreshold` others, spread over three or more domains
  // with none holding half — set aside as shared, and the rest clustered
  // again. A table at the centre of its own domain (a Product its
  // production tables surround) has most of its keys at home, and stays.
  const minNeighbours = opts.sharedThreshold === false ? Infinity : (opts.sharedThreshold ?? 5);
  const cluster = (isShared: readonly boolean[]) => {
    // The clustered graph: keys between two tables that are not shared, parallel keys as weight.
    const weights: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());
    let clusteredEdges = 0;
    for (let v = 0; v < n; v++) {
      if (isShared[v]) continue;
      for (const { to } of adj[v]!) {
        if (isShared[to] || to === v) continue;
        weights[v]!.set(to, (weights[v]!.get(to) ?? 0) + 1);
        if (v < to) clusteredEdges++;
      }
    }
    const clustered = [...Array(n).keys()].filter((v) => weights[v]!.size > 0);
    const partition = (communityOf: (v: number) => number) => {
      const groups = new Map<number, number[]>();
      for (const v of clustered) {
        const c = communityOf(v);
        (groups.get(c) ?? groups.set(c, []).get(c)!).push(v);
      }
      let q = 0;
      const members = [...groups.values()];
      const found: Domain[] = members.map((list) => {
        const set = new Set(list);
        let internal = 0;
        let external = 0;
        let degreeSum = 0;
        for (const v of list) {
          for (const [to, w] of weights[v]!) {
            degreeSum += w;
            if (set.has(to)) internal += w;
          }
          // Keys out count every line leaving the domain, shared tables included.
          for (const { to } of adj[v]!) if (!set.has(to)) external++;
        }
        internal /= 2;
        if (clusteredEdges) q += internal / clusteredEdges - (degreeSum / (2 * clusteredEdges)) ** 2;
        const central = [...list].sort((a, b) => cb[b]! - cb[a]! || adj[b]!.length - adj[a]!.length || a - b)[0]!;
        return { id: "", label: tables[central]!.label ?? tables[central]!.id, tables: list.map((v) => tables[v]!.id), internalKeys: internal, externalKeys: external };
      });
      return { found, q, members };
    };
    const community = louvain(clustered, weights, opts.maxIterations ?? 50);
    let result = partition((v) => community.get(v)!);
    // A split no better than keeping each connected piece whole is noise
    // (two halves of four tables, modularity 0): say one domain per piece.
    if (result.q < 0.01 && result.found.length > 1) {
      const piece = new Map<number, number>();
      for (const start of clustered) {
        if (piece.has(start)) continue;
        const stack = [start];
        piece.set(start, start);
        while (stack.length) {
          for (const to of weights[stack.pop()!]!.keys()) {
            if (piece.has(to)) continue;
            piece.set(to, start);
            stack.push(to);
          }
        }
      }
      result = partition((v) => piece.get(v)!);
    }
    return { ...result, weights };
  };

  let isShared = new Array<boolean>(n).fill(false);
  let pass = cluster(isShared);
  if (minNeighbours !== Infinity && pass.members.length >= 3) {
    const domainOf = new Map<number, number>();
    pass.members.forEach((list, d) => list.forEach((v) => domainOf.set(v, d)));
    const spread = nbrs.map((list, v) => {
      if (list.length < minNeighbours) return false;
      // Keys from each neighbouring domain to this table. A domain with fewer
      // keys inside it than keys to this table exists only around it — a
      // piece of its own domain the clustering cut off — and counts as home.
      const toHub = new Map<number, number>();
      for (const { to } of adj[v]!) {
        const d = domainOf.get(to) ?? -1;
        toHub.set(d, (toHub.get(d) ?? 0) + 1);
      }
      const own = domainOf.get(v) ?? -2;
      const bucket = (d: number) => (d === own || (d >= 0 && pass.found[d]!.internalKeys < (toHub.get(d) ?? 0)) ? own : d);
      const counts = new Map<number, number>();
      for (const to of list) {
        const b = bucket(domainOf.get(to) ?? -1);
        counts.set(b, (counts.get(b) ?? 0) + 1);
      }
      return counts.size >= 3 && Math.max(...counts.values()) / list.length < 0.5;
    });
    if (spread.some(Boolean)) {
      isShared = spread;
      pass = cluster(isShared);
    }
  }
  const shared = tables.filter((_, v) => isShared[v]).map((t) => t.id);
  // Joined to other tables only through shared ones: in no domain, but not an island either.
  const unassigned = tables.filter((_, v) => !isShared[v] && adj[v]!.length > 0 && pass.weights[v]!.size === 0).map((t) => t.id);
  const modularity = pass.q;
  const domains: Domain[] = pass.found
    .sort((a, b) => b.tables.length - a.tables.length || a.label.localeCompare(b.label))
    .map((d, i) => ({ ...d, id: `domain-${i + 1}` }));

  // ── Misplaced: keys mostly leading into another declared group ──
  const groupOf = new Map(tables.map((t) => [t.id, t.parentId ?? null]));
  const misplaced: ModelStructure["misplaced"] = [];
  tables.forEach((t, v) => {
    const own = groupOf.get(t.id);
    if (!own || adj[v]!.length < 2) return;
    const counts = new Map<string, number>();
    for (const { to } of adj[v]!) {
      const g = groupOf.get(tables[to]!.id);
      if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    const total = adj[v]!.length;
    let top: [string, number] | null = null;
    for (const entry of counts) if (!top || entry[1] > top[1]) top = entry;
    if (top && top[0] !== own && top[1] / total > 0.5) {
      misplaced.push({ nodeId: t.id, group: own, pullsToward: top[0], share: Math.round((top[1] / total) * 100) / 100 });
    }
  });

  return {
    metrics,
    hubs,
    articulation,
    splits,
    bridges,
    islands,
    shared,
    unassigned,
    domains,
    modularity: Math.round(modularity * 1000) / 1000,
    misplaced,
    approximate,
  };
}

/**
 * Louvain community detection over an undirected weighted graph, made
 * deterministic: nodes are visited in the order given, a node stays put
 * unless a move strictly gains, and ties between moves go to the lowest
 * community. Local moving, then the communities become nodes, until a level
 * moves nothing. Returns each node's community (an arbitrary but stable id).
 */
function louvain(nodes: readonly number[], weights: ReadonlyArray<ReadonlyMap<number, number>>, maxRounds: number): Map<number, number> {
  // Level graph: dense ids 0..k-1, neighbour weights, self-loop weight (internal edges, each once).
  const position = new Map(nodes.map((v, i) => [v, i]));
  let adj: Array<Map<number, number>> = nodes.map((v) => {
    const out = new Map<number, number>();
    for (const [to, w] of weights[v]!) {
      const j = position.get(to);
      if (j !== undefined) out.set(j, w);
    }
    return out;
  });
  let self: number[] = nodes.map(() => 0);
  let member = nodes.map((_, i) => i); // original position → current level node
  const EPS = 1e-12;
  for (let level = 0; level < 20; level++) {
    const k = adj.length;
    const degree = adj.map((nb, i) => [...nb.values()].reduce((a, b) => a + b, 0) + 2 * self[i]!);
    const m2 = degree.reduce((a, b) => a + b, 0);
    if (!m2) break;
    const comm = adj.map((_, i) => i);
    const tot = [...degree];
    let movedAny = false;
    for (let round = 0; round < maxRounds; round++) {
      let moved = false;
      for (let i = 0; i < k; i++) {
        const ci = comm[i]!;
        const toComm = new Map<number, number>();
        for (const [j, w] of adj[i]!) if (j !== i) toComm.set(comm[j]!, (toComm.get(comm[j]!) ?? 0) + w);
        tot[ci]! -= degree[i]!;
        const gain = (c: number) => (toComm.get(c) ?? 0) - (tot[c]! * degree[i]!) / m2;
        let best = ci;
        let bestGain = gain(ci);
        for (const c of toComm.keys()) {
          const g = gain(c);
          if (g > bestGain + EPS || (Math.abs(g - bestGain) <= EPS && c < best && best !== ci)) {
            best = c;
            bestGain = g;
          }
        }
        tot[best]! += degree[i]!;
        if (best !== ci) {
          comm[i] = best;
          moved = true;
          movedAny = true;
        }
      }
      if (!moved) break;
    }
    if (!movedAny) break;
    // Aggregate: communities in order of first appearance become the next level's nodes.
    const renumber = new Map<number, number>();
    for (let i = 0; i < k; i++) if (!renumber.has(comm[i]!)) renumber.set(comm[i]!, renumber.size);
    const next: Array<Map<number, number>> = Array.from({ length: renumber.size }, () => new Map());
    const nextSelf = new Array<number>(renumber.size).fill(0);
    for (let i = 0; i < k; i++) {
      const a = renumber.get(comm[i]!)!;
      nextSelf[a]! += self[i]!;
      for (const [j, w] of adj[i]!) {
        const b = renumber.get(comm[j]!)!;
        if (a === b) {
          if (i < j) nextSelf[a]! += w;
        } else next[a]!.set(b, (next[a]!.get(b) ?? 0) + w);
      }
    }
    member = member.map((x) => renumber.get(comm[x]!)!);
    adj = next;
    self = nextSelf;
  }
  return new Map(nodes.map((v, i) => [v, member[i]!]));
}

/**
 * The structure as plain JSON, and as the panels read it: the top hubs with
 * their numbers, each articulation table with the pieces it would leave,
 * each bridge key with its two tables. What the editor's panel lists and
 * what the HTML export embeds, so both say the same thing.
 */
export interface StructureSummary {
  tables: number;
  hubs: Array<{ id: string; degree: number; centrality: number }>;
  articulation: Array<{ id: string; splits: number }>;
  bridges: Array<{ edgeId: string; source: string; target: string; field?: string }>;
  islands: string[];
  shared: string[];
  unassigned: string[];
  domains: Domain[];
  modularity: number;
  misplaced: ModelStructure["misplaced"];
  approximate: boolean;
}

export function summarizeStructure(doc: FieldDocument, s: ModelStructure, opts: { hubs?: number } = {}): StructureSummary {
  const edges = new Map(doc.edges.map((e) => [e.id, e]));
  return {
    tables: s.metrics.size,
    hubs: s.hubs.slice(0, opts.hubs ?? 50).map((id) => {
      const m = s.metrics.get(id)!;
      return { id, degree: m.degreeIn + m.degreeOut, centrality: Math.round(m.centrality * 1000) / 1000 };
    }),
    articulation: s.articulation.map((id) => ({ id, splits: s.splits[id] ?? 2 })).sort((a, b) => b.splits - a.splits),
    bridges: s.bridges.map((edgeId) => {
      const e = edges.get(edgeId)!;
      const field = edgeFieldIds(e).start;
      return { edgeId, source: e.source, target: e.target, ...(field !== undefined ? { field } : {}) };
    }),
    islands: s.islands,
    shared: s.shared,
    unassigned: s.unassigned,
    domains: s.domains,
    modularity: s.modularity,
    misplaced: s.misplaced,
    approximate: s.approximate,
  };
}
