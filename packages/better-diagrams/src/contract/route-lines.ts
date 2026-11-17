/**
 * route-lines.ts — lines and their words, once the boxes have settled.
 *
 * Placement leaves two things only the finished picture can answer: a line that
 * still has to pass a box on its way, and a label sitting on something. Both
 * are solved here with the document's own vocabulary — waypoints and `labelT`
 * — so the result is ordinary data: every exporter draws it, a person can drag
 * it, and Clear routes removes it.
 *
 * A line with a clear run keeps no waypoints at all, so it goes on floating as
 * its boxes move. A route is added only where the drawn line would hit a box.
 */
import { edgeGeometryFor, endSides, type Box } from "./geometry";
import {
  boundsOf,
  crossingsBetween,
  straddles,
  buildScene,
  edgeWordsRect,
  polylineHitsRect,
  rectsOverlap,
  sampleGeometry,
  type Rect,
  titleRect,
  zoneTitleRect,
  type Scene,
  type SceneBox,
  type SceneLine,
} from "./layout-lint";
import { fieldAnchors, KIND_SHAPES, resolveRouting, type DiagramEdge, type DiagramTemplate, type EdgeAnchor } from "./schema";
import { cardParentIdsOf } from "./layout-frames";

type Pt = { x: number; y: number };

export interface SettleOptions {
  containerKinds?: readonly string[];
  frames?: "root" | "all" | { drill: string };
  /** Leave words where they are. */
  keepWords?: boolean;
  /**
   * Keep a line between table rows close to what it goes round. One bend reads
   * as one stroke, but a line from a row leaves its table sideways, and to clear
   * a table standing right beside it the bend has to be far out: a swing down
   * the page and back. There, a way round by the table's corners is taken if it
   * is plainly shorter and crosses no more lines.
   */
  tight?: boolean;
}

/**
 * How much routing a canvas gets: offending lines × boxes on the canvas. A route
 * is a visibility graph over the boxes nearby, so this is what its cost grows
 * with. Past the first figure a route takes the first clean way through instead
 * of hunting for the middle of the gap; past the second, the boxes are the problem
 * and no amount of routing will make a picture of it. Keeps Tidy on a very large
 * model about the boxes, and quick.
 */
const MAX_TITLE_DETOUR = 1.15;
const ROUTE_POLISH_BUDGET = 500;
const ROUTE_BUDGET = 6000;
/** Past this far from anything, a route is clear enough, and moving it further gains nothing. */
const CLEARANCE_HORIZON = 80;

/** Give every line a clear way through, and every label a clear place to sit. */
export function settleLines(template: DiagramTemplate, opts: SettleOptions = {}): DiagramTemplate {
  const frames = opts.frames ?? "root";
  const canvases: Array<string | null> =
    frames === "root"
      ? [null]
      : frames === "all"
        ? [null, ...cardParentIdsOf(template, opts.containerKinds)]
        : [frames.drill];
  let doc = template;
  for (const frame of canvases) {
    doc = routeCanvas(doc, frame, opts);
    doc = spreadEnds(doc, frame, opts);
    // Giving lines their own places can walk one into a box it was only just
    // clearing, so what that broke gets a route of its own.
    doc = routeCanvas(doc, frame, opts);
    if (!opts.keepWords) doc = placeWords(doc, frame, opts);
  }
  return doc;
}

function withEdges(
  doc: DiagramTemplate,
  change: ReadonlyMap<string, (edge: DiagramEdge) => DiagramEdge>,
): DiagramTemplate {
  if (!change.size) return doc;
  return { ...doc, edges: doc.edges.map((e) => change.get(e.id)?.(e) ?? e) };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** What a line must not pass through: the boxes it doesn't touch, and every container's name. */
function obstaclesFor(line: SceneLine, scene: Scene): Rect[] {
  const exempt = new Set([line.source.id, line.target.id, ...line.source.ancestors, ...line.target.ancestors]);
  return [
    ...scene.boxes.filter((b) => !b.frame && b.node.kind !== "point" && !exempt.has(b.id)),
    ...scene.boxes
      .filter((b) => b.frame && b.id !== line.source.id && b.id !== line.target.id)
      .map((b) => titleRect(b)),
    ...scene.zones.map((z) => zoneTitleRect(z)),
  ];
}

function routeCanvas(doc: DiagramTemplate, frame: string | null, opts: SettleOptions): DiagramTemplate {
  const scene = buildScene(doc, { containerKinds: opts.containerKinds, frame });
  const hitsOf = (line: SceneLine) => {
    const reach = boundsOf(line.samples);
    return obstaclesFor(line, scene).filter((b) => rectsOverlap(reach, b) && polylineHitsRect(line.samples, b, 2));
  };
  const offenders = scene.lines.filter((line) => line.source.id !== line.target.id && hitsOf(line).length > 0);
  /** Whether a real box is in the way, rather than only a container's name. */
  const blockedByBox = (line: SceneLine) => hitsOf(line).some((b) => "id" in b);
  const effort = offenders.length * scene.boxes.length;
  if (!offenders.length || effort > ROUTE_BUDGET) return doc;
  const polishRoutes = effort <= ROUTE_POLISH_BUDGET;

  const routing = resolveRouting(doc.meta?.routing);
  const routed: Pt[][] = scene.lines.filter((l) => !offenders.includes(l)).map((l) => l.samples);
  const change = new Map<string, (edge: DiagramEdge) => DiagramEdge>();
  // Shortest first: a short line has the fewest ways round, a long one can move over.
  for (const line of [...offenders].sort((a, b) => a.length - b.length)) {
    // First, keeping the sides it already leaves and arrives by: left to choose for
    // itself, a line faces its first waypoint, and a line that was leaving a box
    // sideways sets off out of the top to swing round to where it was going anyway.
    const held = holdSides(line);
    let drawnLine = held;
    let points = routeAround(held, scene, routing, routed, polishRoutes, opts.tight);
    if (!points) {
      drawnLine = line;
      points = routeAround(line, scene, routing, routed, polishRoutes, opts.tight);
    }
    if (!points && (line.edge.start?.auto || line.edge.end?.auto)) {
      // The side the placer chose may be what's boxing it in: let the route choose.
      const { start, end, ...rest } = line.edge;
      drawnLine = {
        ...line,
        edge: { ...rest, ...(start && !start.auto ? { start } : {}), ...(end && !end.auto ? { end } : {}) },
      };
      points = routeAround(drawnLine, scene, routing, routed, polishRoutes, opts.tight);
    }
    if (!points) continue;
    const drawn = sampleGeometry(lineGeometry(drawnLine, routing, points), 36);
    // Going round a box is worth a detour. Going round a name isn't worth a hook:
    // a line briefly over a title is a smaller fault than a line that doubles back.
    if (!blockedByBox(line) && lengthOf(drawn) > line.length * MAX_TITLE_DETOUR) continue;
    const { start, end } = drawnLine.edge;
    change.set(line.edge.id, (e) => {
      const { start: _s, end: _e, ...rest } = e;
      return { ...rest, ...(start ? { start } : {}), ...(end ? { end } : {}), points };
    });
    routed.push(drawn);
  }
  return withEdges(doc, change);
}

/** The line with its ends pinned, for the placer's own purposes, to the sides it's on now. */
function holdSides(line: SceneLine): SceneLine {
  const { edge, source, target } = line;
  if (edge.startField || edge.endField) return line;
  const sides = endSides(asBox(source), asBox(target), { start: edge.start, end: edge.end, points: edge.points });
  return {
    ...line,
    edge: {
      ...edge,
      start: edge.start ?? { side: sides.start, auto: true },
      end: edge.end ?? { side: sides.end, auto: true },
    },
  };
}

function lengthOf(points: readonly Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

function asBox(b: SceneBox): Box {
  return { x: b.x, y: b.y, width: b.w, height: b.h };
}

/** The line as it would draw through these waypoints. Row anchors still apply; bundling moves it a few pixels at most. */
function lineGeometry(line: SceneLine, routing: ReturnType<typeof resolveRouting>, points: Array<[number, number]>) {
  const anchorNode = (b: SceneBox) => ({
    fields: b.node.fields,
    description: b.node.description,
    h: b.h,
    centerX: b.x + b.w / 2,
  });
  return edgeGeometryFor(line.edge.routing ?? routing, asBox(line.source), asBox(line.target), line.edge.labelT ?? 0.5, {
    ...fieldAnchors(line.edge, anchorNode(line.source), anchorNode(line.target)),
    points,
    startShape: KIND_SHAPES[line.source.node.kind as string],
    endShape: KIND_SHAPES[line.target.node.kind as string],
  });
}

/**
 * The shortest way round: a visibility graph over the corners of the boxes
 * nearby, inflated so a route has room to curve. Then every waypoint it can do
 * without is dropped, and what is left slides toward the middle of its gap.
 *
 * Tries wider clearances first, and returns null when no route draws clean —
 * better an honest line through a box, which lint reports, than a tangle.
 */
function routeAround(
  line: SceneLine,
  scene: Scene,
  routing: ReturnType<typeof resolveRouting>,
  others: readonly Pt[][],
  polish: boolean,
  tight = false,
): Array<[number, number]> | null {
  const obstacles = obstaclesFor(line, scene);
  const otherReach = polish ? others.map((points) => ({ points, bounds: boundsOf(points) })) : [];
  const start = line.samples[0]!;
  const end = line.geo.tip;
  const span = Math.hypot(end.x - start.x, end.y - start.y);

  const frame = sharedFrame(line, scene);
  const insideFrame = (samples: readonly Pt[]) =>
    !frame ||
    samples.every(
      (p) => p.x >= frame.x + 4 && p.x <= frame.x + frame.w - 4 && p.y >= frame.y + 4 && p.y <= frame.y + frame.h - 4,
    );
  const drawsClean = (points: Array<[number, number]>, margin = 4) => {
    const geo = lineGeometry(line, routing, points);
    const samples = sampleGeometry(geo, Math.min(64, Math.max(24, Math.ceil(line.length / 10))));
    return {
      samples,
      clean:
        !obstacles.some((b) => polylineHitsRect(samples, b, -margin)) &&
        !polylineHitsRect(samples.slice(2, -2), line.source, 1) &&
        !polylineHitsRect(samples.slice(2, -2), line.target, 1) &&
        insideFrame(samples),
    };
  };

  // One clean bend, if there is one: a single point off to the side of the straight
  // run, as close to it as will clear everything. Threading corner to corner finds a
  // shorter line, but a line with one bend reads as one stroke, and one with three
  // wobbles. Of the two sides, the one that crosses the fewest other lines.
  // The one bend found, where it is far enough out that a way round by the corners is worth a look.
  let swing: { points: Array<[number, number]>; length: number; crossings: number } | null = null;
  if (span > 0) {
    const nx = -(end.y - start.y) / span;
    const ny = (end.x - start.x) / span;
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    for (const off of SINGLE_BEND_OFFSETS) {
      let best: { points: Array<[number, number]>; crossings: number; samples: Pt[] } | null = null;
      for (const sign of [1, -1]) {
        const points: Array<[number, number]> = [[Math.round(mid.x + nx * off * sign), Math.round(mid.y + ny * off * sign)]];
        const { clean, samples } = drawsClean(points, SINGLE_BEND_CLEARANCE);
        if (!clean) continue;
        const crossings = others.reduce((sum, other) => sum + crossingsBetween(samples, other), 0);
        if (!best || crossings < best.crossings) best = { points, crossings, samples };
      }
      if (!best) continue;
      if (!tight || off <= TIGHT_BEND || !(line.edge.startField || line.edge.endField)) return best.points;
      swing = { points: best.points, length: lengthOf(best.samples), crossings: best.crossings };
      break;
    }
  }

  for (const clearance of [26, 18, 12, 8]) {
    const margin = Math.max(320, span * 0.6);
    const region: Rect = {
      x: Math.min(start.x, end.x) - margin,
      y: Math.min(start.y, end.y) - margin,
      w: Math.abs(end.x - start.x) + margin * 2,
      h: Math.abs(end.y - start.y) + margin * 2,
    };
    const nearby = obstacles.filter((b) => rectsOverlap(region, b));
    const path = shortestPath(start, end, nearby, line.source, line.target, clearance, sharedFrame(line, scene));
    if (!path) continue;

    let points: Array<[number, number]> = path.slice(1, -1).map((p) => [Math.round(p.x), Math.round(p.y)]);
    if (!points.length || !drawsClean(points).clean) continue;

    // Drop what it can do without: fewer bends is what makes a route read as one stroke.
    for (let i = points.length - 1; i >= 0 && points.length > 1; i -= 1) {
      const without = points.filter((_, n) => n !== i);
      if (drawsClean(without).clean) points = without;
    }
    if (swing) {
      // Plainly shorter, and across no more lines than the bend: or the bend stands.
      const { samples } = drawsClean(points);
      const crossings = others.reduce((sum, other) => sum + crossingsBetween(samples, other), 0);
      if (lengthOf(samples) > swing.length * TIGHT_GAIN || crossings > swing.crossings) return swing.points;
    }

    if (!polish) return points;

    // Toward the middle of the gap, away from the boxes and the lines already drawn.
    const clearanceOf = (candidate: Array<[number, number]>): number => {
      const { samples, clean } = drawsClean(candidate);
      if (!clean) return -Infinity;
      // Only what's close enough to matter: anything further off than the clearance
      // this could possibly win isn't worth measuring to.
      const reach = boundsOf(samples);
      const close = nearby.filter((b) => rectsOverlap(reach, b, CLEARANCE_HORIZON));
      let least = CLEARANCE_HORIZON;
      for (let i = 0; i < samples.length; i += 2) {
        const p = samples[i]!;
        for (const b of close) least = Math.min(least, distanceToRect(p, b));
      }
      for (const other of otherReach) {
        if (!rectsOverlap(reach, other.bounds, CLEARANCE_HORIZON)) continue;
        for (let i = 0; i < samples.length; i += 3) {
          const p = samples[i]!;
          for (let j = 0; j < other.points.length; j += 3) {
            // A line a little apart reads as two; one on top reads as one.
            least = Math.min(least, Math.hypot(p.x - other.points[j]!.x, p.y - other.points[j]!.y) * 1.6);
          }
        }
      }
      return least;
    };
    let score = clearanceOf(points);
    for (let round = 0; round < 1; round += 1) {
      for (let i = 0; i < points.length; i += 1) {
        for (const step of [24, 12]) {
          for (const [dx, dy] of [
            [step, 0],
            [-step, 0],
            [0, step],
            [0, -step],
          ] as const) {
            const candidate = points.map((p, n): [number, number] => (n === i ? [p[0] + dx, p[1] + dy] : p));
            const s = clearanceOf(candidate);
            if (s > score + 0.5) {
              score = s;
              points = candidate;
            }
          }
        }
      }
    }
    return points;
  }
  return swing?.points ?? null;
}

function distanceToRect(p: Pt, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/** Dijkstra over the start, the end and the inflated corners of each obstacle. */
function shortestPath(
  start: Pt,
  end: Pt,
  obstacles: readonly Rect[],
  source: Rect,
  target: Rect,
  clearance: number,
  within?: Rect,
): Pt[] | null {
  const inflated = obstacles.map((b) => ({
    x: b.x - clearance,
    y: b.y - clearance,
    w: b.w + clearance * 2,
    h: b.h + clearance * 2,
  }));
  // A corner sitting inside another inflated box is no way through.
  const outside = (x: number, y: number) =>
    !!within && (x < within.x + 6 || x > within.x + within.w - 6 || y < within.y + 6 || y > within.y + within.h - 6);
  const corner = (x: number, y: number): Pt | null =>
    outside(x, y) || inflated.some((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) ? null : { x, y };
  const nodes: Pt[] = [start, end];
  // The source and target can be walked around too: a line may have to leave
  // from the far side of its own box.
  for (const r of [...inflated, inflate(source, clearance), inflate(target, clearance)]) {
    for (const p of [
      corner(r.x, r.y),
      corner(r.x + r.w, r.y),
      corner(r.x, r.y + r.h),
      corner(r.x + r.w, r.y + r.h),
    ]) {
      if (p) nodes.push(p);
    }
  }
  const clear = (a: Pt, b: Pt) =>
    !inflated.some((r) => segmentCrossesOpenRect(a, b, r)) &&
    !segmentCrossesOpenRect(a, b, source) &&
    !segmentCrossesOpenRect(a, b, target);

  const dist = new Array<number>(nodes.length).fill(Infinity);
  const prev = new Array<number>(nodes.length).fill(-1);
  const done = new Array<boolean>(nodes.length).fill(false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    let least = Infinity;
    for (let i = 0; i < nodes.length; i += 1) {
      if (!done[i] && dist[i]! < least) {
        least = dist[i]!;
        u = i;
      }
    }
    if (u < 0) return null;
    if (u === 1) break;
    done[u] = true;
    for (let v = 0; v < nodes.length; v += 1) {
      if (done[v]) continue;
      const a = nodes[u]!;
      const b = nodes[v]!;
      const step = Math.hypot(a.x - b.x, a.y - b.y);
      // A small charge per bend: of two near-equal routes, the straighter one.
      const next = dist[u]! + step + 18;
      if (next < dist[v]! && clear(a, b)) {
        dist[v] = next;
        prev[v] = u;
      }
    }
  }
  const path: Pt[] = [];
  for (let at = 1; at !== -1; at = prev[at]!) path.unshift(nodes[at]!);
  return path;
}

/**
 * The container both ends of a line sit in, if they share one. A line between two
 * members of a frame has no business leaving it: going out and back reads as
 * traffic to somewhere else.
 */
function sharedFrame(line: SceneLine, scene: Scene): Rect | undefined {
  const { source, target } = line;
  const parent = source.ancestors.find((id) => target.ancestors.includes(id));
  if (parent) return scene.boxes.find((b) => b.id === parent);
  const zoneId = source.node.zoneId;
  if (zoneId && !source.ancestors.length && zoneId === target.node.zoneId && !target.ancestors.length) {
    return scene.zones.find((z) => z.id === zoneId);
  }
  return undefined;
}

function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

/** How far off the straight run a single bend may go, nearest first, and how much room it wants. */
const SINGLE_BEND_OFFSETS = [24, 40, 60, 84, 112, 144, 180, 224, 280, 350, 440];
const SINGLE_BEND_CLEARANCE = 12;
/** How far out one bend may be before a `tight` route looks for a way that keeps to the boxes. */
const TIGHT_BEND = 144;
/** How much shorter that way has to be to replace the bend. */
const TIGHT_GAIN = 0.85;

/** Whether a segment passes through a rectangle's interior; running along an edge doesn't count. */
function segmentCrossesOpenRect(a: Pt, b: Pt, r: Rect): boolean {
  const inset = 0.5;
  let lo = 0;
  let hi = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks: Array<[number, number]> = [
    [-dx, a.x - (r.x + inset)],
    [dx, r.x + r.w - inset - a.x],
    [-dy, a.y - (r.y + inset)],
    [dy, r.y + r.h - inset - a.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    if (lo >= hi) return false;
  }
  return true;
}

// ─── Ends ────────────────────────────────────────────────────────────────────

/** Space between the ends sharing a side, within what the side has room for. */
const END_SPACING = 20;
const END_MIN_SPACING = 10;
const END_INSET = 12;
/** How far an end will slide along its side so its line runs dead level. */
const LEVEL_REACH = 22;

/**
 * Every line gets its own place on a box. Lines bundled tight leave a box as one
 * thick stroke and split somewhere further on, and a reader can't tell which way
 * each goes; a little apart, in the order they head off in, each can be followed
 * from the start. Then a line that's nearly level between its two ends is made
 * level, where that keeps it clear of its neighbours.
 *
 * Only what's the placer's to decide: a fraction a person dragged, a row a foreign
 * key belongs on, and a diamond's points all stay as they are. The result is an
 * `auto` anchor, so the next Tidy can decide again.
 */
function spreadEnds(doc: DiagramTemplate, frame: string | null, opts: SettleOptions): DiagramTemplate {
  // Bundled is the renderer's own way with a shared side, so all this has to do is
  // leave it to it, and clear out any places an earlier spread gave them.
  if (doc.settings?.layout?.ends === "bundled") {
    return {
      ...doc,
      edges: doc.edges.map((e) => {
        if (e.start?.t === undefined && e.end?.t === undefined) return e;
        const drop = (a: EdgeAnchor | undefined) => (a?.auto && a.t !== undefined ? { side: a.side, auto: true } : a);
        const start = drop(e.start);
        const end = drop(e.end);
        const { start: _s, end: _e, ...rest } = e;
        return { ...rest, ...(start ? { start } : {}), ...(end ? { end } : {}) };
      }),
    };
  }
  const scene = buildScene(doc, { containerKinds: opts.containerKinds, frame });
  type End = { line: SceneLine; which: "start" | "end"; box: SceneBox; side: "top" | "right" | "bottom" | "left"; far: number };
  const groups = new Map<string, End[]>();
  // A side someone chose stays theirs, and bundles with its neighbours as ever.
  const freeToMove = (a: EdgeAnchor | undefined) => !a || a.auto === true;
  for (const line of scene.lines) {
    const { edge, source, target } = line;
    if (source.id === target.id) continue;
    const sides = endSides(asBox(source), asBox(target), { start: edge.start, end: edge.end, points: edge.points });
    const points = edge.points ?? [];
    const consider = (which: "start" | "end", box: SceneBox, other: SceneBox) => {
      const anchor = which === "start" ? edge.start : edge.end;
      const field = which === "start" ? edge.startField : edge.endField;
      if (field || !freeToMove(anchor) || KIND_SHAPES[box.node.kind as string] === "diamond") return;
      const side = sides[which];
      const [x, y] = points.length
        ? which === "start"
          ? points[0]!
          : points[points.length - 1]!
        : [other.x + other.w / 2, other.y + other.h / 2];
      const key = `${box.id}|${side}`;
      const end: End = { line, which, box, side, far: side === "left" || side === "right" ? y! : x! };
      const group = groups.get(key);
      if (group) group.push(end);
      else groups.set(key, [end]);
    };
    consider("start", source, target);
    consider("end", target, source);
  }

  const placed = new Map<string, { start?: EdgeAnchor; end?: EdgeAnchor }>();
  const set = (end: End, anchor: EdgeAnchor) => {
    const entry = placed.get(end.line.edge.id) ?? {};
    entry[end.which] = anchor;
    placed.set(end.line.edge.id, entry);
  };
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const { box, side } = group[0]!;
    const length = side === "left" || side === "right" ? box.h : box.w;
    const usable = Math.max(0, length - END_INSET * 2);
    const spacing = Math.max(Math.min(END_SPACING, usable / Math.max(1, group.length - 1)), Math.min(END_MIN_SPACING, usable / Math.max(1, group.length - 1)));
    const alongCentre = side === "left" || side === "right" ? box.y + box.h / 2 : box.x + box.w / 2;
    const reachOf = (end: End) => {
      const other = end.which === "start" ? end.line.target : end.line.source;
      return side === "left" || side === "right"
        ? Math.abs(other.x + other.w / 2 - (box.x + box.w / 2))
        : Math.abs(other.y + other.h / 2 - (box.y + box.h / 2));
    };
    // In the order they head off in. Two from the same direction: the one with
    // further to come swings wider, so it takes the outer place, or they cross.
    const order = [...group].sort((a, b) => {
      if (Math.abs(a.far - b.far) > 1) return a.far - b.far;
      return a.far < alongCentre ? reachOf(a) - reachOf(b) : reachOf(b) - reachOf(a);
    });
    const total = spacing * (group.length - 1);
    let first = length / 2 - total / 2;
    // A line going straight across to a box level with this one is the main line:
    // it stays dead centre, and the rest sit around it. Spreading them evenly would
    // knock it a few pixels off, and the box after that a few the other way.
    const vertical = side === "left" || side === "right";
    const centreOf = (b: SceneBox) => (vertical ? b.y + b.h / 2 : b.x + b.w / 2);
    const straight = order.findIndex((end) => {
      const other = end.which === "start" ? end.line.target : end.line.source;
      return !end.line.edge.points?.length && Math.abs(centreOf(other) - centreOf(box)) <= 1;
    });
    if (straight >= 0) {
      const wanted = length / 2 - spacing * straight;
      const low = END_INSET;
      const high = length - END_INSET - total;
      first = Math.min(high, Math.max(low, wanted));
      if (high < low) first = length / 2 - total / 2;
    }
    order.forEach((end, i) => {
      const at = first + spacing * i;
      set(end, { side, t: Math.round((at / length) * 1000) / 1000, auto: true });
    });
  }

  // Dead level where nearly level: each line that faces straight across.
  const positionOf = (box: SceneBox, side: End["side"], t: number) =>
    side === "left" || side === "right" ? box.y + box.h * t : box.x + box.w * t;
  const siblingsOn = new Map<string, number[]>();
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    siblingsOn.set(
      key,
      group.map((e) => {
        const a = placed.get(e.line.edge.id)?.[e.which];
        return a?.t ?? 0.5;
      }),
    );
  }
  for (const line of scene.lines) {
    const { edge, source, target } = line;
    if (edge.points?.length || source.id === target.id) continue;
    const anchors = placed.get(edge.id);
    if (!anchors?.start || !anchors.end) continue;
    const a = anchors.start;
    const b = anchors.end;
    const facing =
      (a.side === "right" && b.side === "left") ||
      (a.side === "left" && b.side === "right") ||
      (a.side === "bottom" && b.side === "top") ||
      (a.side === "top" && b.side === "bottom");
    if (!facing) continue;
    const pa = positionOf(source, a.side, a.t ?? 0.5);
    const pb = positionOf(target, b.side, b.t ?? 0.5);
    const delta = pa - pb;
    if (delta === 0 || Math.abs(delta) > LEVEL_REACH) continue;
    const length = b.side === "left" || b.side === "right" ? target.h : target.w;
    const moved = (b.t ?? 0.5) + delta / length;
    const key = `${target.id}|${b.side}`;
    const others = (siblingsOn.get(key) ?? []).filter((t) => t !== (b.t ?? 0.5));
    if (moved * length < END_INSET || moved * length > length - END_INSET) continue;
    if (others.some((t) => Math.abs(t - moved) * length < END_MIN_SPACING)) {
      // Blocked by a neighbour on the side: the whole group can slide instead,
      // keeping its spacing, if there's room for all of it.
      const group = groups.get(key) ?? [];
      const slid = group.map((end) => {
        const anchor = placed.get(end.line.edge.id)?.[end.which];
        return { end, anchor, t: (anchor?.t ?? 0.5) + delta / length };
      });
      if (slid.every(({ t }) => t * length >= END_INSET && t * length <= length - END_INSET)) {
        for (const { end, anchor, t } of slid) if (anchor) set(end, { ...anchor, t: Math.round(t * 1000) / 1000 });
        siblingsOn.set(key, slid.map(({ t }) => t));
      }
      continue;
    }
    anchors.end = { ...b, t: Math.round(moved * 1000) / 1000 };
  }

  if (!placed.size) return doc;
  const change = new Map<string, (edge: DiagramEdge) => DiagramEdge>();
  for (const [id, anchors] of placed) change.set(id, (e) => ({ ...e, ...anchors }));
  return withEdges(doc, change);
}

// ─── Words ───────────────────────────────────────────────────────────────────

const WORD_LINE_LIMIT = 150;

/** Where along its line a label may sit, nearest the middle first. */
const WORD_SLOTS = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75, 0.2, 0.8, 0.16, 0.84];

/**
 * Slide each label along its line to the spot that collides with the least.
 * Two passes, so the first label placed gets to reconsider once it can see
 * where the others went. A label already clear of everything stays exactly
 * where it is, including one a person dragged there.
 */
function placeWords(doc: DiagramTemplate, frame: string | null, opts: SettleOptions): DiagramTemplate {
  const scene = buildScene(doc, { containerKinds: opts.containerKinds, frame });
  const worded = scene.lines
    .filter((l) => l.words && l.source.id !== l.target.id)
    .sort((a, b) => b.words!.w * b.words!.h - a.words!.w * a.words!.h);
  if (!worded.length) return doc;
  const solids = scene.boxes.filter((b) => !b.frame);

  const rects = new Map<string, Rect>(worded.map((l) => [l.edge.id, l.words!]));
  const chosen = new Map<string, number>();
  const rectAt = (line: SceneLine, t: number) => {
    const point = line.geo.at(t);
    return edgeWordsRect({ ...line.geo, label: point }, t, line.edge)!;
  };
  const titles = [
    ...scene.boxes.filter((b) => b.frame).map((b) => titleRect(b)),
    ...scene.zones.map((z) => zoneTitleRect(z)),
  ];
  const frames: Rect[] = [...scene.boxes.filter((b) => b.frame), ...scene.zones];
  const reach = scene.lines.map((l) => ({ line: l, bounds: boundsOf(l.samples) }));
  const costOf = (line: SceneLine, rect: Rect) => {
    let cost = 0;
    for (const b of solids) {
      if (rectsOverlap(rect, b)) cost += 100;
      else if (rectsOverlap(rect, b, 6)) cost += 12;
    }
    for (const t of titles) if (rectsOverlap(rect, t, 4)) cost += 100;
    const roomy = { x: rect.x - 6, y: rect.y - 6, w: rect.w + 12, h: rect.h + 12 };
    for (const f of frames) {
      if (straddles(rect, f)) cost += 40;
      else if (straddles(roomy, f)) cost += 14;
    }
    for (const [id, other] of rects) if (id !== line.edge.id && rectsOverlap(rect, other, 3)) cost += 100;
    // On a big model, boxes and other labels are what matter; lines through words
    // aren't worth checking every label against every line for.
    if (reach.length > WORD_LINE_LIMIT) return cost;
    for (const { line: other, bounds } of reach) {
      if (rectsOverlap(rect, bounds) && polylineHitsRect(other.samples, rect, 1)) cost += other === line ? 8 : 30;
    }
    return cost;
  };

  // A "yes" or a "no" answers the decision it leaves, so it reads right next to it.
  // Anywhere else it's a label on a line, and the middle is as good as anywhere.
  const homeOf = (line: SceneLine) => (KIND_SHAPES[line.source.node.kind as string] === "diamond" ? 0.2 : 0.5);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const line of worded) {
      const home = homeOf(line);
      const current = chosen.get(line.edge.id) ?? line.edge.labelT ?? home;
      if (home === 0.5 && costOf(line, rectAt(line, current)) === 0) continue;
      let best = current;
      let bestCost = Infinity;
      for (const t of WORD_SLOTS) {
        const cost = costOf(line, rectAt(line, t)) + Math.abs(t - home) * 2;
        if (cost < bestCost) {
          best = t;
          bestCost = cost;
        }
      }
      chosen.set(line.edge.id, best);
      rects.set(line.edge.id, rectAt(line, best));
    }
  }
  const change = new Map<string, (edge: DiagramEdge) => DiagramEdge>();
  for (const [id, t] of chosen) {
    change.set(id, (e) => {
      if (t === (e.labelT ?? 0.5)) return e;
      if (t === 0.5) {
        const { labelT: _dropped, ...rest } = e;
        return rest;
      }
      return { ...e, labelT: t };
    });
  }
  return withEdges(doc, change);
}
