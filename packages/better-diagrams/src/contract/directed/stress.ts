/**
 * directed/stress.ts — a flow laid out by distance, not by rank.
 *
 * A ranked layout puts every box in a column. That is what makes a flow read
 * as one, and it is also what parks a box far from what it talks to: three big
 * groups that all follow the same one are stacked in a single column after it,
 * and the lines to the top and the bottom of that stack sweep across the
 * picture. A reader minds that more than anything else in a dense diagram.
 *
 * Here the boxes are placed so that distance on the page follows distance in
 * the graph: stress majorization (Gansner, Koren & North 2004), with each pair
 * of joined boxes wanting to sit as far apart as their sizes need and no
 * further. The direction is kept by constraint, not by rank: every line that
 * runs with the flow must end with its target wholly downstream of its source,
 * and after each round of majorization the boxes are moved the least that puts
 * that right again (the projection of DiG-CoLa, Dwyer & Koren 2005, done a
 * pair at a time). So three groups that follow one end up beside it, one above
 * the other, each as near as it can get, and still to its right.
 *
 * It starts from the ranked layout, so it is the same on every run, and what
 * it changes is only what distance asks for. Boxes are then cleared of each
 * other, and the ones nearly in a row or a column are put in it.
 */
import { alignNear, intoFrame, layered, outOfFrame, separateBoxes, type PlaceItem, type PlaceLink, type PlaceOptions, type PlacedBlock, type PlacedBox } from "../autoplace";

/** Past this many boxes in one piece, every pair is too many pairs: the ranked layout stands. */
const STRESS_BOXES = 160;
/** Rounds of majorization, each followed by putting the direction right. */
const ROUNDS = 70;

/**
 * Lay out one connected piece by distance. `reading` is the order a reader
 * meets the boxes in: a line that runs forward in it is held to the flow.
 * Null when the piece is too big for it.
 */
export function stressBlock(
  items: readonly PlaceItem[],
  links: readonly PlaceLink[],
  opts: PlaceOptions,
  reading: ReadonlyMap<string, number>,
): PlacedBlock | null {
  const n = items.length;
  if (n < 3 || n > STRESS_BOXES) return null;
  // One frame for every direction, as the ranked layout has: the flow runs along x here.
  const frame = intoFrame(items, opts.flow);
  const index = new Map(frame.map((item, i) => [item.id, i]));
  const gapAlong = opts.rankGap;
  const gapAcross = opts.nodeGap;

  // ── How far apart each pair wants to be ─────────────────────────────────────
  // Joined boxes: clear of each other by a gap, measured between their middles as
  // if each were as round as it is big. Everything else: the shortest way round.
  const radius = frame.map((item) => (item.w + item.h) / 4);
  const want: number[][] = frame.map(() => new Array<number>(n).fill(Infinity));
  for (let i = 0; i < n; i += 1) want[i]![i] = 0;
  for (const l of links) {
    const u = index.get(l.source);
    const v = index.get(l.target);
    if (u === undefined || v === undefined || u === v) continue;
    const d = radius[u]! + radius[v]! + (gapAlong + gapAcross) / 2;
    want[u]![v] = Math.min(want[u]![v]!, d);
    want[v]![u] = Math.min(want[v]![u]!, d);
  }
  for (let k = 0; k < n; k += 1) {
    for (let i = 0; i < n; i += 1) {
      const ik = want[i]![k]!;
      if (ik === Infinity) continue;
      for (let j = 0; j < n; j += 1) {
        const through = ik + want[k]![j]!;
        if (through < want[i]![j]!) want[i]![j] = through;
      }
    }
  }

  // ── What holds the direction ────────────────────────────────────────────────
  const held: Array<{ u: number; v: number; apart: number }> = [];
  const seen = new Set<number>();
  for (const l of links) {
    if (l.tether || l.undirected) continue;
    const u = index.get(l.source);
    const v = index.get(l.target);
    if (u === undefined || v === undefined || u === v) continue;
    // A line that closes a loop runs back whatever is done: it is left free to.
    if (!((reading.get(l.source) ?? 0) < (reading.get(l.target) ?? 0))) continue;
    if (seen.has(u * n + v)) continue;
    seen.add(u * n + v);
    // Target wholly downstream of source, with room for the line to be seen between them.
    held.push({ u, v, apart: (frame[u]!.w + frame[v]!.w) / 2 + Math.max(24, gapAlong * 0.5) });
  }
  const project = (xs: number[]) => {
    for (let pass = 0; pass < 6; pass += 1) {
      let moved = false;
      for (const { u, v, apart } of held) {
        const short = apart - (xs[v]! - xs[u]!);
        if (short <= 0.01) continue;
        xs[u]! -= short / 2;
        xs[v]! += short / 2;
        moved = true;
      }
      if (!moved) break;
    }
  };

  // ── Where it starts: the ranked layout, read the same way ───────────────────
  // Ports say where a line ends inside a box, in the page's own directions, which this frame has turned.
  const plain = links.map(({ sourcePort: _s, targetPort: _t, ...link }) => link);
  const start = layered(frame, plain, { ...opts, flow: "right", pull: undefined, rankHint: undefined, together: undefined, engine: undefined });
  const startAt = new Map(start.placed.map((p) => [p.id, p]));
  const xs = frame.map((item) => (startAt.get(item.id)?.x ?? 0) + item.w / 2);
  const ys = frame.map((item) => (startAt.get(item.id)?.y ?? 0) + item.h / 2);

  // ── Majorize, and put the direction right, in turn ──────────────────────────
  for (let round = 0; round < ROUNDS; round += 1) {
    for (let i = 0; i < n; i += 1) {
      let sumX = 0;
      let sumY = 0;
      let weight = 0;
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        const target = want[i]![j]!;
        if (target === Infinity) continue;
        const w = 1 / (target * target);
        const dx = xs[i]! - xs[j]!;
        const dy = ys[i]! - ys[j]!;
        const length = Math.hypot(dx, dy) || 0.001;
        sumX += w * (xs[j]! + (target * dx) / length);
        sumY += w * (ys[j]! + (target * dy) / length);
        weight += w;
      }
      if (weight) {
        xs[i] = sumX / weight;
        ys[i] = sumY / weight;
      }
    }
    project(xs);
  }

  // ── Boxes, cleared of each other and lined up where they nearly are ─────────
  const boxes: PlacedBox[] = frame.map((item, i) => ({ id: item.id, x: xs[i]! - item.w / 2, y: ys[i]! - item.h / 2, w: item.w, h: item.h }));
  const smallest = Math.min(...frame.map((item) => Math.min(item.w, item.h)));
  separateBoxes(boxes, gapAcross);
  alignNear(boxes, smallest * 0.45, gapAcross);
  separateBoxes(boxes, gapAcross);
  alignNear(boxes, 12, gapAcross);
  // Clearing and lining up can have nudged a target back over its source: the direction has the last word.
  for (let pass = 0; pass < 3; pass += 1) {
    const centres = boxes.map((b) => b.x + b.w / 2);
    project(centres);
    let moved = false;
    boxes.forEach((b, i) => {
      const x = centres[i]! - b.w / 2;
      if (Math.abs(x - b.x) > 0.5) moved = true;
      b.x = x;
    });
    if (!moved) break;
    separateBoxes(boxes, gapAcross);
  }

  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  for (const b of boxes) {
    b.x = Math.round(b.x - minX);
    b.y = Math.round(b.y - minY);
  }
  const width = Math.max(...boxes.map((b) => b.x + b.w));
  const height = Math.max(...boxes.map((b) => b.y + b.h));
  return outOfFrame(boxes, width, height, opts.flow);
}
