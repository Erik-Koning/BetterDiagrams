/**
 * directed/arcs.ts — which side a line that goes round takes, and how far out.
 *
 * A line that skips ahead down its own column, or runs back against the flow,
 * can't go straight: it arcs round what is between its ends. Drawn one at a
 * time, every such arc takes the same side at the same distance, and a column
 * with five of them is a knot. Drawn together they are a book embedding: the
 * column is the spine, each side of it a page, and two arcs on one page cross
 * exactly when their spans interleave (one starts inside the other and ends
 * outside it). So:
 *
 *   - sides are chosen for the fewest interleaved pairs on a page, counting
 *     also the lines an arc would cut across on its way out. Finding the best
 *     split is NP-hard (Masuda, Nakajima, Kashiwabara & Fujisawa 1990), so a
 *     small set is tried every way and a large one is improved a flip at a
 *     time (as in Cimikowski 2002);
 *   - an arc that spans another on its page goes further out than it, so
 *     nested arcs sit inside one another like brackets and never touch.
 *
 * Pure: spans and walls in, a side and a depth out.
 */

export interface Arc {
  id: string;
  /** Where its two ends are along the flow, either way round. */
  from: number;
  to: number;
  /** The outer edge of what it goes round, on the low side (top or left) and the high side. */
  wallLow: number;
  wallHigh: number;
  /** How many other lines it would cut across on its way round each side. */
  tollLow: number;
  tollHigh: number;
  /** The side it would take with nothing else to consider. */
  natural: "low" | "high";
}

export interface PagedArc {
  side: "low" | "high";
  /** 1 for the innermost arc on its side; each arc spanning another is one further out. */
  depth: number;
}

/** Arcs whose walls are further apart than this are round different things, and don't meet. */
const SAME_WALL = 140;
/** Up to this many arcs, every split is tried. */
const EXHAUSTIVE = 12;
/** What leaving its natural side costs an arc: less than any crossing, more than nothing. */
const UNNATURAL = 0.3;
/**
 * What each arc more on one side than the other costs. A little more than
 * half of UNNATURAL, so that with nothing else to choose by, arcs are shared
 * out between the two sides rather than stacked four deep on one.
 */
const LOPSIDED = 0.2;

const span = (a: Arc) => ({ lo: Math.min(a.from, a.to), hi: Math.max(a.from, a.to) });

/** One starts inside the other and ends outside it: on one page, these cross. */
function interleaved(a: Arc, b: Arc): boolean {
  const p = span(a);
  const q = span(b);
  const slack = 1;
  return (p.lo + slack < q.lo && q.lo + slack < p.hi && p.hi + slack < q.hi) || (q.lo + slack < p.lo && p.lo + slack < q.hi && q.hi + slack < p.hi);
}

/** Whether two arcs would share a page on this side at all. */
function sameWall(a: Arc, b: Arc, side: "low" | "high"): boolean {
  return Math.abs(side === "low" ? a.wallLow - b.wallLow : a.wallHigh - b.wallHigh) < SAME_WALL;
}

export function pageArcs(arcs: readonly Arc[]): Map<string, PagedArc> {
  const n = arcs.length;
  const out = new Map<string, PagedArc>();
  if (!n) return out;

  // ── Which page ──────────────────────────────────────────────────────────────
  const clash: Array<Array<{ other: number; low: boolean; high: boolean }>> = arcs.map(() => []);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (!interleaved(arcs[i]!, arcs[j]!)) continue;
      const low = sameWall(arcs[i]!, arcs[j]!, "low");
      const high = sameWall(arcs[i]!, arcs[j]!, "high");
      if (!low && !high) continue;
      clash[i]!.push({ other: j, low, high });
      clash[j]!.push({ other: i, low, high });
    }
  }
  const own = (i: number, high: boolean) => {
    const a = arcs[i]!;
    return (high ? a.tollHigh : a.tollLow) + ((a.natural === "high") === high ? 0 : UNNATURAL);
  };
  const costOf = (sides: readonly boolean[]) => {
    let cost = 0;
    for (let i = 0; i < n; i += 1) {
      cost += own(i, sides[i]!);
      for (const c of clash[i]!) {
        if (c.other > i && sides[c.other] === sides[i] && (sides[i] ? c.high : c.low)) cost += 1;
      }
    }
    const high = sides.filter(Boolean).length;
    return cost + LOPSIDED * Math.abs(n - 2 * high);
  };

  let sides: boolean[] = arcs.map((a) => a.natural === "high");
  if (n <= EXHAUSTIVE) {
    let best = costOf(sides);
    for (let mask = 0; mask < 1 << n; mask += 1) {
      const trial = arcs.map((_, i) => ((mask >> i) & 1) === 1);
      const cost = costOf(trial);
      if (cost < best - 1e-9) {
        best = cost;
        sides = trial;
      }
    }
  } else {
    // Longest first, each to the cheaper page given those placed; then flips while one helps.
    const order = arcs.map((_, i) => i).sort((x, y) => span(arcs[y]!).hi - span(arcs[y]!).lo - (span(arcs[x]!).hi - span(arcs[x]!).lo) || x - y);
    const placed = new Set<number>();
    const local = (i: number, high: boolean) => {
      let cost = own(i, high);
      for (const c of clash[i]!) if (placed.has(c.other) && sides[c.other] === high && (high ? c.high : c.low)) cost += 1;
      return cost;
    };
    for (const i of order) {
      sides[i] = local(i, true) < local(i, false);
      placed.add(i);
    }
    for (let round = 0; round < 8; round += 1) {
      let flipped = false;
      for (const i of order) {
        if (local(i, !sides[i]) < local(i, sides[i]!) - 1e-9) {
          sides[i] = !sides[i];
          flipped = true;
        }
      }
      if (!flipped) break;
    }
  }

  // ── How far out ─────────────────────────────────────────────────────────────
  const depth = new Array<number>(n).fill(0);
  const byLength = arcs.map((_, i) => i).sort((x, y) => span(arcs[x]!).hi - span(arcs[x]!).lo - (span(arcs[y]!).hi - span(arcs[y]!).lo) || x - y);
  for (const i of byLength) {
    const p = span(arcs[i]!);
    const side = sides[i]! ? "high" : "low";
    let least = 1;
    const used = new Set<number>();
    for (const j of byLength) {
      if (j === i || !depth[j] || sides[j] !== sides[i] || !sameWall(arcs[i]!, arcs[j]!, side)) continue;
      const q = span(arcs[j]!);
      // Clear of each other along the flow. Meeting end to end is not clear: two
      // arcs at one depth that meet at a box read as one line running past it.
      if (q.hi < p.lo - 1 || q.lo > p.hi + 1) continue;
      // Spanned by this one: this one goes outside it. Merely overlapping: not the same depth.
      if (p.lo <= q.lo && q.hi <= p.hi) least = Math.max(least, depth[j]! + 1);
      used.add(depth[j]!);
    }
    while (used.has(least)) least += 1;
    depth[i] = least;
  }

  arcs.forEach((a, i) => out.set(a.id, { side: sides[i]! ? "high" : "low", depth: depth[i]! }));
  return out;
}

/**
 * How many times arcs paged this way cross: each other, where two on one page
 * interleave, and the lines each cuts across on its way out.
 */
export function arcCrossings(arcs: readonly Arc[], pages: ReadonlyMap<string, PagedArc>): number {
  let crossings = 0;
  arcs.forEach((a, i) => {
    const side = pages.get(a.id)?.side ?? a.natural;
    crossings += side === "low" ? a.tollLow : a.tollHigh;
    for (let j = i + 1; j < arcs.length; j += 1) {
      const b = arcs[j]!;
      if ((pages.get(b.id)?.side ?? b.natural) === side && interleaved(a, b) && sameWall(a, b, side)) crossings += 1;
    }
  });
  return crossings;
}
