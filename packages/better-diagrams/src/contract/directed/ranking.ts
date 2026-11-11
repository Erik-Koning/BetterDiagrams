/**
 * directed/ranking.ts — which rank each box takes, when a line may run backward
 * if that is what keeps lines from crossing.
 *
 * The usual way to draw a flow (Sugiyama, Tagawa & Toda 1981) decides in order:
 * which lines run backward, then which rank each box takes, then the order
 * within each rank that crosses least. Each step is final before the next
 * begins, so direction is settled before a single crossing is counted, and a
 * line that could have run back to save five crossings never gets the chance.
 *
 * Here the three are one question. A ranking is priced as a whole:
 *
 *     cost = crossing × crossings + backward × lines against the flow + span × ranks skipped
 *
 * and searched by moving one box at a time to a rank next to one of its
 * neighbours, or to a new rank of its own between two. A move past a neighbour
 * turns the line between them round, which is how a line comes to run backward:
 * because, counted with everything else, the picture was cheaper that way. How
 * much a crossing is worth against a backward line is the caller's to say.
 *
 * Crossings are counted the way the ranked layout will draw them: a lane
 * through every rank a line skips, each rank ordered by where its neighbours
 * sit (barycentre sweeps), inversions between consecutive ranks counted with a
 * Fenwick tree (Barth, Mutzel & Jünger 2002). The order found is handed on, so
 * the layout starts from the crossings the ranking was chosen for.
 *
 * Deterministic: the same graph and weights give the same ranks. The search is
 * bounded by how many rankings it prices, never by a clock.
 */
import type { PlaceLink } from "../autoplace";
import { bilayerCrossings } from "../layout-frames";

export interface RankWeights {
  /** What a crossing costs. */
  crossing: number;
  /** What a line pointing against the flow costs. */
  backward: number;
  /**
   * What it costs, on top of that, to turn round a line a reader would have
   * followed forward. Without it the search counts lines and nothing else, and
   * will start a loop from its middle to save one: fewer lines run backward,
   * and the flow reads inside out.
   */
  turned: number;
  /** What each rank a line skips costs: a lane to thread, and a longer line to follow. */
  span: number;
  /**
   * What each rank more than the first start has costs. Left out, ranks are
   * free, and the search will open one for a single box wherever that saves a
   * crossing: the box then stands in a column of its own, which a reader takes
   * for a stage of its own.
   */
  rank?: number;
}

export interface Ranking {
  rank: Map<string, number>;
  /** Where each box sat across the flow, 0 to 1, when the crossings were counted. */
  across: Map<string, number>;
  cost: number;
  crossings: number;
  /** Lines pointing against the flow, by weight. */
  backward: number;
  /** Ranks skipped, summed over lines. */
  span: number;
}

export interface RankSearchOptions {
  /**
   * Accept a worse ranking now and then on the way to a better one (simulated
   * annealing: Kirkpatrick, Gelatt & Vecchi 1983; for drawings, Davidson &
   * Harel 1996), which gets out of the arrangements one box at a time can't.
   */
  anneal?: boolean;
  /** How many rankings may be priced. Left out, it follows the size of the graph. */
  budget?: number;
  /**
   * The order a reader meets the boxes in (`acyclicOrder`). A line that runs
   * forward in it is one of the flow's own; one that runs back in it closes a
   * loop, and is the line to run backward if one must.
   */
  reading?: ReadonlyMap<string, number>;
}

/** Two boxes with at least one line between them, and how those lines point. */
interface Pair {
  a: number;
  b: number;
  /** Weight of the lines pointing a → b, and b → a. */
  ab: number;
  ba: number;
  /** Of those, the weight a reader would have followed forward. */
  abMain: number;
  baMain: number;
  /** Every line between them, pointing or not. */
  lines: number;
}

interface Priced {
  /** Dense ranks, by box. */
  rank: Int32Array;
  /** Position across the flow, 0 to 1, by box. */
  across: Float64Array;
  cost: number;
  crossings: number;
  backward: number;
  span: number;
}

/** A small seeded generator (mulberry32), so annealing is the same every run. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An order of the boxes with few lines running backward (Eades, Lin & Smyth
 * 1993): take a box nothing points at and put it first, take a box that points
 * at nothing and put it last, and when neither is left take the box that sends
 * the most more than it receives. Unlike the reader's order (`acyclicOrder`) it
 * doesn't care where a flow starts, only that as few lines as possible turn
 * round, so it is one more place for the search to begin.
 */
export function fewestBackOrder(ids: readonly string[], links: readonly PlaceLink[]): Map<string, number> {
  const index = new Map(ids.map((id, i) => [id, i]));
  const out: number[][] = ids.map(() => []);
  const into: number[][] = ids.map(() => []);
  for (const l of links) {
    if (l.tether || l.undirected) continue;
    const u = index.get(l.source);
    const v = index.get(l.target);
    if (u === undefined || v === undefined || u === v) continue;
    out[u]!.push(v);
    into[v]!.push(u);
  }
  const gone = new Array<boolean>(ids.length).fill(false);
  const outLeft = out.map((list) => list.length);
  const inLeft = into.map((list) => list.length);
  const head: number[] = [];
  const tail: number[] = [];
  const take = (u: number, to: number[]) => {
    gone[u] = true;
    to.push(u);
    for (const v of out[u]!) inLeft[v]! -= 1;
    for (const v of into[u]!) outLeft[v]! -= 1;
  };
  let left = ids.length;
  while (left > 0) {
    let moved = true;
    while (moved) {
      moved = false;
      for (let u = 0; u < ids.length; u += 1) {
        if (gone[u]) continue;
        if (outLeft[u] === 0) {
          take(u, tail);
          left -= 1;
          moved = true;
        } else if (inLeft[u] === 0) {
          take(u, head);
          left -= 1;
          moved = true;
        }
      }
    }
    if (left === 0) break;
    let best = -1;
    for (let u = 0; u < ids.length; u += 1) {
      if (gone[u]) continue;
      if (best < 0 || outLeft[u]! - inLeft[u]! > outLeft[best]! - inLeft[best]!) best = u;
    }
    take(best, head);
    left -= 1;
  }
  const order = new Map<string, number>();
  [...head, ...tail.reverse()].forEach((u, i) => order.set(ids[u]!, i));
  return order;
}

/**
 * Search for the ranking that costs least, starting from each of `seeds` (at
 * least one: a ranking by any means, such as `flatRanks`).
 */
export function searchRanks(
  ids: readonly string[],
  links: readonly PlaceLink[],
  weights: RankWeights,
  seeds: ReadonlyArray<ReadonlyMap<string, number>>,
  options: RankSearchOptions = {},
): Ranking {
  const n = ids.length;
  const index = new Map(ids.map((id, i) => [id, i]));
  // The ranks the first start stands in (the reader's, as `directedLayout` calls this): what a rank more is counted from.
  const fewest = seeds.length ? new Set(ids.map((id) => seeds[0]!.get(id) ?? 0)).size : 0;

  // ── The graph, as pairs of boxes ────────────────────────────────────────────
  const pairs: Pair[] = [];
  const pairAt = new Map<number, Pair>();
  for (const l of links) {
    if (l.tether) continue;
    const s = index.get(l.source);
    const t = index.get(l.target);
    if (s === undefined || t === undefined || s === t) continue;
    const a = Math.min(s, t);
    const b = Math.max(s, t);
    let pair = pairAt.get(a * n + b);
    if (!pair) {
      pair = { a, b, ab: 0, ba: 0, abMain: 0, baMain: 0, lines: 0 };
      pairAt.set(a * n + b, pair);
      pairs.push(pair);
    }
    const w = l.weight ?? 1;
    pair.lines += w;
    if (!l.undirected) {
      const main = options.reading ? (options.reading.get(l.source) ?? 0) < (options.reading.get(l.target) ?? 0) : false;
      if (s === a) {
        pair.ab += w;
        if (main) pair.abMain += w;
      } else {
        pair.ba += w;
        if (main) pair.baMain += w;
      }
    }
  }
  const near: number[][] = ids.map(() => []);
  for (const p of pairs) {
    near[p.a]!.push(p.b);
    near[p.b]!.push(p.a);
  }

  // ── Pricing a ranking ───────────────────────────────────────────────────────
  /**
   * Price ranks given as any whole numbers (they are made dense first), ordering
   * each rank from where the boxes sat in `from`.
   */
  const price = (raw: Int32Array, from: Float64Array, sweeps: number): Priced => {
    const used = [...new Set(raw)].sort((x, y) => x - y);
    const denseOf = new Map(used.map((r, i) => [r, i]));
    const rank = new Int32Array(n);
    for (let i = 0; i < n; i += 1) rank[i] = denseOf.get(raw[i]!)!;
    const depth = used.length;

    let backward = 0;
    let turned = 0;
    let span = 0;
    // Every box and every lane is an entry; a lane sits where its line would pass.
    const layerOf: number[] = Array.from(rank);
    const key: number[] = Array.from(from);
    // Segments between consecutive ranks, as [upper entry, lower entry].
    const segments: Array<Array<[number, number]>> = Array.from({ length: Math.max(0, depth - 1) }, () => []);
    for (const p of pairs) {
      const up = rank[p.a]! < rank[p.b]! ? p.a : p.b;
      const down = up === p.a ? p.b : p.a;
      const top = rank[up]!;
      const bottom = rank[down]!;
      backward += up === p.a ? p.ba : p.ab;
      turned += up === p.a ? p.baMain : p.abMain;
      span += p.lines * (bottom - top - 1);
      let prev = up;
      for (let r = top + 1; r < bottom; r += 1) {
        const lane = layerOf.length;
        layerOf.push(r);
        key.push(from[up]! + ((from[down]! - from[up]!) * (r - top)) / (bottom - top));
        segments[r - 1]!.push([prev, lane]);
        prev = lane;
      }
      segments[bottom - 1]!.push([prev, down]);
    }
    const total = layerOf.length;
    const layers: number[][] = Array.from({ length: depth }, () => []);
    for (let e = 0; e < total; e += 1) layers[layerOf[e]!]!.push(e);
    for (const layer of layers) layer.sort((x, y) => key[x]! - key[y]! || x - y);

    const above: number[][] = Array.from({ length: total }, () => []);
    const below: number[][] = Array.from({ length: total }, () => []);
    for (const gap of segments) {
      for (const [u, v] of gap) {
        below[u]!.push(v);
        above[v]!.push(u);
      }
    }
    const pos = new Float64Array(total);
    const slot = new Int32Array(total);
    const place = (layer: readonly number[]) => {
      const last = Math.max(1, layer.length - 1);
      layer.forEach((e, i) => {
        pos[e] = i / last;
        slot[e] = i;
      });
    };
    layers.forEach(place);
    const count = (): number => {
      let crossings = 0;
      for (let g = 0; g < segments.length; g += 1) {
        crossings += bilayerCrossings(
          segments[g]!.map(([u, v]) => [slot[u]!, slot[v]!]),
          layers[g + 1]!.length,
        );
      }
      return crossings;
    };
    // Each rank in turn takes the order of where its neighbours on one side sit.
    // An entry with no neighbour that side keeps its place among the others.
    const settle = (layer: number[], side: readonly number[][]) => {
      const wish = new Map<number, number>();
      for (const e of layer) {
        const neighbours = side[e]!;
        if (!neighbours.length) continue;
        let sum = 0;
        for (const o of neighbours) sum += pos[o]!;
        wish.set(e, sum / neighbours.length);
      }
      const movable = layer.filter((e) => wish.has(e)).sort((x, y) => wish.get(x)! - wish.get(y)! || pos[x]! - pos[y]!);
      let next = 0;
      for (let i = 0; i < layer.length; i += 1) if (wish.has(layer[i]!)) layer[i] = movable[next++]!;
      place(layer);
    };

    let crossings = count();
    let best = layers.map((layer) => [...layer]);
    for (let sweep = 0; sweep < sweeps && crossings > 0; sweep += 1) {
      for (let l = 1; l < depth; l += 1) settle(layers[l]!, above);
      for (let l = depth - 2; l >= 0; l -= 1) settle(layers[l]!, below);
      const now = count();
      if (now < crossings) {
        crossings = now;
        best = layers.map((layer) => [...layer]);
      }
    }
    const across = new Float64Array(n);
    for (const layer of best) {
      layer.forEach((e, i) => {
        if (e < n) across[e] = (i + 0.5) / layer.length;
      });
    }
    return {
      rank,
      across,
      crossings,
      backward,
      span,
      cost:
        weights.crossing * crossings +
        weights.backward * backward +
        weights.turned * turned +
        weights.span * span +
        (weights.rank ?? 0) * Math.max(0, depth - fewest),
    };
  };

  // ── Where to start ──────────────────────────────────────────────────────────
  let evaluations = 0;
  const budget = options.budget ?? Math.max(80, Math.min(4000, Math.floor(1_200_000 / (n + pairs.length * 3 + 10))));
  const middle = new Float64Array(n).fill(0.5);
  let current: Priced | null = null;
  for (const seed of seeds) {
    const raw = new Int32Array(n);
    for (let i = 0; i < n; i += 1) raw[i] = seed.get(ids[i]!) ?? 0;
    // A start that puts two joined boxes in one rank can't be drawn as ranks: the later box steps on.
    for (let round = 0; round < n; round += 1) {
      let clash = false;
      for (const p of pairs) {
        if (raw[p.a] === raw[p.b]) {
          raw[p.ab >= p.ba ? p.b : p.a]! += 1;
          clash = true;
        }
      }
      if (!clash) break;
    }
    if (pairs.some((p) => raw[p.a] === raw[p.b])) continue;
    const priced = price(raw, middle, 8);
    evaluations += 1;
    if (!current || priced.cost < current.cost) current = priced;
  }
  if (!current) {
    // No start could be drawn (every one had a loop it couldn't open): one rank a box, in order.
    const raw = new Int32Array(n);
    for (let i = 0; i < n; i += 1) raw[i] = i;
    current = price(raw, middle, 8);
  }

  // ── Moves ───────────────────────────────────────────────────────────────────
  /**
   * The ranks worth trying for a box, in doubled numbers: an even number joins
   * the rank that is there, an odd one is a new rank between two. Each is
   * beside one of the box's neighbours, since nowhere else changes a line's
   * direction or its length for the better.
   */
  const targetsFor = (state: Priced, u: number): number[] => {
    const here = state.rank[u]! * 2;
    const taken = new Set(near[u]!.map((v) => state.rank[v]! * 2));
    const out = new Set<number>();
    for (const at of [here, ...taken]) {
      for (const step of [-2, -1, 1, 2]) {
        const to = at + step;
        if (to === here || taken.has(to)) continue;
        out.add(to);
      }
    }
    return [...out];
  };
  /** What a box's own lines would cost at a rank, without counting crossings: enough to say which moves to price in full. */
  const localCost = (state: Priced, u: number, to: number): number => {
    let cost = 0;
    for (const v of near[u]!) {
      const pair = pairAt.get(Math.min(u, v) * n + Math.max(u, v))!;
      const other = state.rank[v]! * 2;
      const outgoing = u === pair.a ? pair.ab : pair.ba;
      const incoming = u === pair.a ? pair.ba : pair.ab;
      const outgoingMain = u === pair.a ? pair.abMain : pair.baMain;
      const incomingMain = u === pair.a ? pair.baMain : pair.abMain;
      cost += weights.backward * (to < other ? incoming : outgoing) + weights.turned * (to < other ? incomingMain : outgoingMain);
      cost += (weights.span * pair.lines * (Math.abs(to - other) - 2)) / 2;
    }
    return cost;
  };
  const moved = (state: Priced, u: number, to: number): Priced => {
    const raw = new Int32Array(n);
    for (let i = 0; i < n; i += 1) raw[i] = state.rank[i]! * 2;
    raw[u] = to;
    evaluations += 1;
    return price(raw, state.across, 2);
  };

  /** Take every move that lowers the cost, until none does or the budget is spent. */
  const descend = (start: Priced, limit: number): Priced => {
    let state = start;
    const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => near[y]!.length - near[x]!.length || x - y);
    for (let improved = true; improved && evaluations < limit; ) {
      improved = false;
      for (const u of order) {
        if (!near[u]!.length) continue;
        const targets = targetsFor(state, u)
          .map((to) => ({ to, local: localCost(state, u, to) }))
          .sort((x, y) => x.local - y.local || x.to - y.to)
          .slice(0, 3);
        let best: Priced | null = null;
        for (const { to } of targets) {
          if (evaluations >= limit) break;
          const candidate = moved(state, u, to);
          if (candidate.cost < (best ?? state).cost - 1e-9) best = candidate;
        }
        if (best) {
          state = best;
          improved = true;
        }
      }
    }
    return state;
  };

  let best = descend(current, options.anneal ? Math.floor(budget * 0.35) : budget);

  if (options.anneal && n >= 3 && pairs.length) {
    const random = seeded(n * 7919 + pairs.length * 104729);
    const movable = Array.from({ length: n }, (_, i) => i).filter((u) => near[u]!.length);
    let state = best;
    // Warm enough to take a move that costs a crossing about one time in three.
    let heat = weights.crossing * 0.9;
    const steps = Math.max(0, Math.floor(budget * 0.5));
    const cooling = steps > 1 ? Math.pow(0.02, 1 / steps) : 1;
    for (let step = 0; step < steps && movable.length; step += 1) {
      const u = movable[Math.floor(random() * movable.length)]!;
      const targets = targetsFor(state, u);
      if (!targets.length) continue;
      const candidate = moved(state, u, targets[Math.floor(random() * targets.length)]!);
      const worse = candidate.cost - state.cost;
      if (worse <= 0 || random() < Math.exp(-worse / heat)) state = candidate;
      if (state.cost < best.cost - 1e-9) best = state;
      heat *= cooling;
    }
    best = descend(best, budget);
  }

  // The order within ranks is worth a longer look once the ranks are settled.
  const final = price(best.rank, best.across, 12);
  const settled = final.cost <= best.cost ? final : best;
  return {
    rank: new Map(ids.map((id, i) => [id, settled.rank[i]!])),
    across: new Map(ids.map((id, i) => [id, settled.across[i]!])),
    cost: settled.cost,
    crossings: settled.crossings,
    backward: settled.backward,
    span: settled.span,
  };
}
