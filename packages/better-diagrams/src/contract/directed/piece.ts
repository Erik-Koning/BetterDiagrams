/**
 * directed/piece.ts — what one placed piece costs a reader, quickly.
 *
 * The ranking search prices rankings by a model of the drawing (lanes through
 * the ranks). Once a ranking has been laid out there are boxes with places, and
 * a closer answer is cheap: lines drawn straight between them, except the ones
 * the arrangement is known to send round as an arc, which are paged the way
 * they will be drawn (`arcs.ts`). It is what picks between a handful of
 * rankings for one piece; the choice between whole pictures uses the real
 * routes (`directedCost`).
 */
import { acyclicOrder, type Flow, type PlaceLink, type PlacedBox } from "../autoplace";
import { arcCrossings, pageArcs, type Arc } from "./arcs";

type Pt = { x: number; y: number };

export interface PieceWeights {
  /** What multiplies a crossing, and what multiplies a line running backward. */
  crossing: number;
  direction: number;
}

/** A crossing, a line through a box, and two boxes on each other, before any weighting: the auto-placer's own figures. */
const CROSSING = 18;
const THROUGH = 40;
const OVERLAP = 500;
/** A line that has to go round is a little worse than one that runs straight. */
const ARC = 4;
/** A line a reader would have followed forward, drawn backward, counts this many times over: see `RankWeights.turned`. */
const TURNED = 2;

function edgePoint(box: PlacedBox, toward: Pt): Pt {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(dx === 0 ? Infinity : box.w / 2 / Math.abs(dx), dy === 0 ? Infinity : box.h / 2 / Math.abs(dy));
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

export function pieceCost(placed: readonly PlacedBox[], links: readonly PlaceLink[], flow: Flow, weights: PieceWeights): number {
  if (!placed.length) return 0;
  const byId = new Map(placed.map((p) => [p.id, p]));
  const sideways = flow === "right" || flow === "left";
  const sign = flow === "right" || flow === "down" ? 1 : -1;
  const unit = placed.reduce((sum, p) => sum + (p.w + p.h) / 2, 0) / placed.length + 40;
  const lead = (b: PlacedBox) => (sideways ? b.x : b.y);
  const trail = (b: PlacedBox) => (sideways ? b.x + b.w : b.y + b.h);
  const low = (b: PlacedBox) => (sideways ? b.y : b.x);
  const high = (b: PlacedBox) => (sideways ? b.y + b.h : b.x + b.w);
  const mid = (b: PlacedBox) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const alongOf = (p: Pt) => (sideways ? p.x : p.y);
  const acrossOf = (p: Pt) => (sideways ? p.y : p.x);

  const reading = acyclicOrder(
    placed.map((p) => p.id),
    links.filter((l) => byId.has(l.source) && byId.has(l.target)),
  );
  const straight: Array<{ a: Pt; b: Pt; link: PlaceLink }> = [];
  const round: Array<{ link: PlaceLink; s: PlacedBox; t: PlacedBox; run: PlacedBox[] }> = [];
  let through = 0;
  let against = 0;
  let length = 0;
  for (const link of links) {
    const s = byId.get(link.source);
    const t = byId.get(link.target);
    if (!s || !t || s === t) continue;
    const a = mid(s);
    const b = mid(t);
    const along = (alongOf(b) - alongOf(a)) * sign;
    if (!link.tether && !link.undirected && along < -1) {
      against += (link.weight ?? 1) * (reading.get(link.source)! < reading.get(link.target)! ? TURNED : 1);
    }
    const behind = sign > 0 ? trail(t) <= lead(s) : lead(t) >= trail(s);
    if (behind && !link.tether && !link.undirected) {
      // Against the flow: a C round everything between its ends, as it will be drawn.
      const from = Math.min(lead(s), lead(t));
      const to = Math.max(trail(s), trail(t));
      round.push({ link, s, t, run: placed.filter((p) => trail(p) > from && lead(p) < to) });
      length += Math.abs(alongOf(b) - alongOf(a)) + unit;
      continue;
    }
    const clipped = { a: edgePoint(s, b), b: edgePoint(t, a), link };
    const blockers = placed.filter((p) => p !== s && p !== t && segmentHitsBox(clipped.a, clipped.b, p, 3));
    const reach = Math.min(high(s) - low(s), high(t) - low(t)) / 2;
    if (blockers.length && along > 0 && Math.abs(acrossOf(b) - acrossOf(a)) <= reach) {
      // Ahead in its own column with boxes between: one arc round the run.
      round.push({ link, s, t, run: [...blockers, s, t] });
      length += Math.abs(alongOf(b) - alongOf(a)) + unit * 0.5;
      continue;
    }
    through += blockers.length;
    straight.push(clipped);
    length += Math.hypot(clipped.b.x - clipped.a.x, clipped.b.y - clipped.a.y);
  }

  let crossings = 0;
  for (let i = 0; i < straight.length; i += 1) {
    for (let j = i + 1; j < straight.length; j += 1) {
      const p = straight[i]!;
      const q = straight[j]!;
      if (p.link.source === q.link.source || p.link.source === q.link.target || p.link.target === q.link.source || p.link.target === q.link.target) continue;
      if (segmentsCross(p.a, p.b, q.a, q.b)) crossings += 1;
    }
  }

  const arcs: Arc[] = round.map(({ s, t, run }, i) => {
    const inside = new Set(run.filter((p) => p !== s && p !== t).map((p) => p.id));
    let tollLow = 0;
    let tollHigh = 0;
    // A straight line out of the run, to one side, is one this arc cuts across on that side.
    for (const seg of straight) {
      const here = inside.has(seg.link.source) ? byId.get(seg.link.source)! : inside.has(seg.link.target) ? byId.get(seg.link.target)! : null;
      if (!here) continue;
      const there = byId.get(here.id === seg.link.source ? seg.link.target : seg.link.source)!;
      if (inside.has(there.id) || there === s || there === t) continue;
      const delta = acrossOf(mid(there)) - acrossOf(mid(here));
      if (delta < -1) tollLow += 1;
      else if (delta > 1) tollHigh += 1;
    }
    const middle = (Math.min(...placed.map(low)) + Math.max(...placed.map(high))) / 2;
    return {
      id: String(i),
      from: alongOf(mid(s)),
      to: alongOf(mid(t)),
      wallLow: Math.min(...run.map(low)),
      wallHigh: Math.max(...run.map(high)),
      tollLow,
      tollHigh,
      natural: acrossOf(mid(s)) < middle ? "low" : "high",
    };
  });
  const arcCross = arcs.length ? arcCrossings(arcs, pageArcs(arcs)) : 0;

  let overlaps = 0;
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i]!;
      const b = placed[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps += 1;
    }
  }
  const width = Math.max(...placed.map((p) => p.x + p.w)) - Math.min(...placed.map((p) => p.x));
  const height = Math.max(...placed.map((p) => p.y + p.h)) - Math.min(...placed.map((p) => p.y));

  return (
    OVERLAP * overlaps +
    THROUGH * through +
    CROSSING * weights.crossing * (crossings + arcCross) +
    CROSSING * weights.direction * against +
    ARC * arcs.length +
    length / unit +
    Math.sqrt(width * height) / unit
  );
}
