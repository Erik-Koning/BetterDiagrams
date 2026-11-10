/**
 * directed/metrics.ts — how well a drawn picture reads as a flow.
 *
 * `lintLayout` finds what is wrong with a picture. These are the measures that
 * say how organised it is when nothing is wrong: do the lines run one way, do
 * they enter a box on one side and leave on the other, are crossings square,
 * are ranks evenly apart. Each is a number with a meaning of its own, taken
 * from the picture as drawn (the same scene the linter reads), and each comes
 * from a result someone measured on readers or proved on paper:
 *
 *   crossings, bends, flow, symmetry  Purchase 1997, 2002: which aesthetics change how fast a graph is read
 *   crossing angle                    Huang, Eades & Hong 2014: square crossings cost a reader least
 *   path continuity (the spine)       Ware, Purchase, Colpoys & McGill 2002
 *   backward lines                    Eades, Lin & Smyth 1993: the feedback arc set
 *   stress                            Gansner, Koren & North 2004
 *   stability                         Misue, Eades, Lai & Sugiyama 1995: the mental map
 *
 * Nothing here knows how the picture was made, so the same numbers compare a
 * hand-drawn diagram with any arrangement of it.
 */
import {
  boundsOf,
  buildScene,
  crossingAngles,
  lintLayout,
  rectsOverlap,
  type LayoutReport,
  type LintLayoutOptions,
  type Scene,
  type SceneBox,
  type SceneLine,
} from "../layout-lint";
import { CONTAINER_KINDS, type DiagramTemplate } from "../schema";

/** Which way a picture reads. */
export type FlowAxis = "right" | "down" | "left" | "up";

export interface FlowMetrics {
  /** The way the picture reads: the one asked for, else the one most of its lines run. */
  axis: FlowAxis;
  boxes: number;
  lines: number;
  /** Places two lines cross. */
  crossings: number;
  /** Pairs of lines that run on top of each other, or a few pixels apart. */
  overlaps: number;
  /** How far from square the crossings are, in degrees, on average. 0 with none. */
  crossingAngle: number;
  /** Lines that have a direction. The four below are out of these. */
  directed: number;
  /** Lines whose target sits upstream of their source. */
  backward: number;
  /** Loops in the graph. Each needs at least one line to run back, whatever the arrangement. */
  backwardNeeded: number;
  /** Lines whose ends sit level along the flow, so they run across it. */
  flat: number;
  /** Of the distance lines travel along the flow, the share travelled with it. 1 is every line all the way. */
  flowConsistency: number;
  /** Of the ends of forward lines, the share on the right face: leaving downstream, arriving upstream. */
  portDiscipline: number;
  /** Of the boxes that only send or only receive, the share at the start or the end of their piece. */
  sourceSinkPlacement: number;
  /** How evenly a box's lines are spread around it, 0 to 1, averaged over boxes with two or more. */
  angularResolution: number;
  /** Right angles a line turns through, on average. A straight line is 0. */
  bends: number;
  /** How straight the longest path runs: 1 is dead level. */
  spineStraightness: number;
  /** How far drawn distances are from graph distances, at the best scale. 0 is a perfect match; null when there are too many boxes to say. */
  stress: number | null;
  /** How even the gaps between ranks are: 1 is all the same. */
  rankEvenness: number;
  /** Share of boxes with a mirror image across the line the flow runs along. */
  symmetry: number;
  /** How much of each group or zone its contents fill, on average. */
  groupCompactness: number;
  /** How much line lengths vary: their standard deviation over their mean. */
  lengthSpread: number;
}

export interface MeasureFlowOptions extends LintLayoutOptions {
  /** The way the picture is meant to read. Left out, it is read off the lines. */
  axis?: FlowAxis;
  /** The lint of the same document and canvas, when it has already been done. */
  report?: LayoutReport;
}

type Pt = { x: number; y: number };

const AXES: Record<FlowAxis, Pt> = {
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  up: { x: 0, y: -1 },
};

/** Past this many lines the pairwise measures are left to the linter's counts. */
const PAIRWISE_LINES = 800;
/** Past this many boxes, all-pairs distances are too many to be worth it. */
const STRESS_BOXES = 400;

const centre = (b: SceneBox): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const isDirected = (l: SceneLine) => (l.edge.direction ?? "forward") === "forward" && l.source.id !== l.target.id;
const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/**
 * The way most lines run, counting each line once whatever its length: the sum
 * of their headings, and whichever of the four ways that leans.
 */
export function inferAxis(scene: Scene): FlowAxis {
  let x = 0;
  let y = 0;
  for (const l of scene.lines) {
    if (!isDirected(l)) continue;
    const a = centre(l.source);
    const b = centre(l.target);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!length) continue;
    x += (b.x - a.x) / length;
    y += (b.y - a.y) / length;
  }
  if (Math.abs(x) >= Math.abs(y)) return x < 0 ? "left" : "right";
  return y < 0 ? "up" : "down";
}

/** A frame for one direction: how far along the flow a point is, and how far across it. */
function frameOf(axis: FlowAxis) {
  const d = AXES[axis];
  const along = (p: Pt) => p.x * d.x + p.y * d.y;
  // Across is the other axis, the same way up whichever way the flow runs.
  const across = (p: Pt) => (d.x !== 0 ? p.y : p.x);
  const span = (b: SceneBox) => (d.x !== 0 ? b.w : b.h);
  /** The face a point on a box's edge is on, as the flow sees it. */
  const face = (b: SceneBox, p: Pt): "upstream" | "downstream" | "side" => {
    const sides = [
      { name: "left", gap: Math.abs(p.x - b.x) },
      { name: "right", gap: Math.abs(p.x - b.x - b.w) },
      { name: "up", gap: Math.abs(p.y - b.y) },
      { name: "down", gap: Math.abs(p.y - b.y - b.h) },
    ].sort((m, n) => m.gap - n.gap);
    const nearest = sides[0]!.name;
    const out = axis;
    const back = ({ right: "left", left: "right", down: "up", up: "down" } as const)[axis];
    return nearest === out ? "downstream" : nearest === back ? "upstream" : "side";
  };
  return { along, across, span, face };
}

/** Loops: the strongly connected pieces with more than one box, or a box joined to itself both ways. */
function loopsIn(ids: readonly string[], arcs: ReadonlyArray<[string, string]>): number {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [u, v] of arcs) out.get(u)?.push(v);
  // Tarjan, without recursion: a long chain must not run the stack out.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let next = 0;
  let loops = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work: Array<{ id: string; child: number }> = [{ id: root, child: 0 }];
    index.set(root, next);
    low.set(root, next);
    next += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1]!;
      const targets = out.get(top.id)!;
      if (top.child < targets.length) {
        const target = targets[top.child]!;
        top.child += 1;
        if (!index.has(target)) {
          index.set(target, next);
          low.set(target, next);
          next += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ id: target, child: 0 });
        } else if (onStack.has(target)) {
          low.set(top.id, Math.min(low.get(top.id)!, index.get(target)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(top.id)!));
      if (low.get(top.id) === index.get(top.id)) {
        let size = 0;
        for (;;) {
          const id = stack.pop()!;
          onStack.delete(id);
          size += 1;
          if (id === top.id) break;
        }
        if (size > 1) loops += 1;
      }
    }
  }
  return loops;
}

/** Connected pieces of the picture, by the lines drawn. */
function piecesOf(boxes: readonly SceneBox[], lines: readonly SceneLine[]): SceneBox[][] {
  const parent = new Map(boxes.map((b) => [b.id, b.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const l of lines) {
    if (parent.has(l.source.id) && parent.has(l.target.id)) parent.set(find(l.source.id), find(l.target.id));
  }
  const byRoot = new Map<string, SceneBox[]>();
  for (const b of boxes) {
    const root = find(b.id);
    const piece = byRoot.get(root);
    if (piece) piece.push(b);
    else byRoot.set(root, [b]);
  }
  return [...byRoot.values()];
}

/**
 * Stress: for every pair of boxes joined by some path, how far the distance
 * between them on the canvas is from the number of lines between them in the
 * graph, at whatever scale suits the picture best. A low number is a picture
 * where near in the graph means near on the page.
 */
function stressOf(boxes: readonly SceneBox[], lines: readonly SceneLine[]): number | null {
  const joined = new Set<string>();
  for (const l of lines) {
    joined.add(l.source.id);
    joined.add(l.target.id);
  }
  const nodes = boxes.filter((b) => joined.has(b.id));
  if (nodes.length < 3) return 0;
  if (nodes.length > STRESS_BOXES) return null;
  const at = new Map(nodes.map((b, i) => [b.id, i]));
  const near: number[][] = nodes.map(() => []);
  for (const l of lines) {
    const u = at.get(l.source.id);
    const v = at.get(l.target.id);
    if (u === undefined || v === undefined || u === v) continue;
    near[u]!.push(v);
    near[v]!.push(u);
  }
  const centres = nodes.map(centre);
  let ratio = 0;
  let square = 0;
  const pairs: Array<{ drawn: number; graph: number }> = [];
  for (let from = 0; from < nodes.length; from += 1) {
    const hops = new Array<number>(nodes.length).fill(-1);
    hops[from] = 0;
    const queue = [from];
    for (let q = 0; q < queue.length; q += 1) {
      const u = queue[q]!;
      for (const v of near[u]!) {
        if (hops[v] !== -1) continue;
        hops[v] = hops[u]! + 1;
        queue.push(v);
      }
    }
    for (let to = from + 1; to < nodes.length; to += 1) {
      const graph = hops[to]!;
      if (graph <= 0) continue;
      const drawn = Math.hypot(centres[to]!.x - centres[from]!.x, centres[to]!.y - centres[from]!.y);
      pairs.push({ drawn, graph });
      ratio += drawn / graph;
      square += (drawn * drawn) / (graph * graph);
    }
  }
  if (!pairs.length || !square) return 0;
  const scale = ratio / square;
  let total = 0;
  for (const p of pairs) total += ((scale * p.drawn) / p.graph - 1) ** 2;
  return total / pairs.length;
}

/** The boxes on the longest run of forward lines, in order. */
function spineOf(boxes: readonly SceneBox[], forward: ReadonlyArray<[string, string]>, along: (p: Pt) => number): SceneBox[] {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const into = new Map<string, string[]>();
  for (const [u, v] of forward) {
    const list = into.get(v);
    if (list) list.push(u);
    else into.set(v, [u]);
  }
  // Forward lines only ever run downstream, so upstream first is a valid order.
  const ordered = [...boxes].sort((a, b) => along(centre(a)) - along(centre(b)));
  const reach = new Map<string, number>();
  const from = new Map<string, string>();
  let end: string | undefined;
  for (const b of ordered) {
    let best = 0;
    for (const u of into.get(b.id) ?? []) {
      const r = (reach.get(u) ?? 0) + 1;
      if (r > best) {
        best = r;
        from.set(b.id, u);
      }
    }
    reach.set(b.id, best);
    if (end === undefined || best > reach.get(end)!) end = b.id;
  }
  const spine: SceneBox[] = [];
  for (let id = end; id !== undefined; id = from.get(id)) {
    spine.unshift(byId.get(id)!);
    if (spine.length > boxes.length) break;
  }
  return spine;
}

/**
 * Measure how a document's picture reads as a flow. Pure: nothing is changed.
 * One canvas is measured: the drilled one if one was asked for, else the root.
 */
export function measureFlow(template: DiagramTemplate, opts: MeasureFlowOptions = {}): FlowMetrics {
  const drilled = typeof opts.frames === "object" ? opts.frames.drill : null;
  const lintOptions: LintLayoutOptions = { containerKinds: opts.containerKinds, frames: drilled === null ? "root" : { drill: drilled } };
  const report = opts.report ?? lintLayout(template, lintOptions);
  const scene = buildScene(template, { containerKinds: opts.containerKinds ?? CONTAINER_KINDS, frame: drilled });
  return measureScene(scene, report, opts.axis);
}

/** The same, for a scene already built. */
export function measureScene(scene: Scene, report: LayoutReport, wanted?: FlowAxis): FlowMetrics {
  const axis = wanted ?? inferAxis(scene);
  const { along, across, span, face } = frameOf(axis);
  const { lines } = scene;
  const solids = scene.boxes.filter((b) => !b.frame);
  const directed = lines.filter(isDirected);

  // ── Crossings, and how square they are ──────────────────────────────────────
  let crossings = report.counts["line-crossing"] ?? 0;
  let offSquare = 0;
  if (lines.length <= PAIRWISE_LINES) {
    crossings = 0;
    const bounds = lines.map((l) => boundsOf(l.samples));
    for (let i = 0; i < lines.length; i += 1) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!rectsOverlap(bounds[i]!, bounds[j]!)) continue;
        for (const angle of crossingAngles(lines[i]!.samples, lines[j]!.samples)) {
          crossings += 1;
          offSquare += 90 - angle;
        }
      }
    }
  }
  const overlaps = (report.counts["line-overlap"] ?? 0) + (report.counts["close-lines"] ?? 0);

  // ── Direction ───────────────────────────────────────────────────────────────
  let backward = 0;
  let flat = 0;
  let withFlow = 0;
  let againstFlow = 0;
  let goodEnds = 0;
  let ends = 0;
  const forward: Array<[string, string]> = [];
  for (const l of directed) {
    const delta = along(centre(l.target)) - along(centre(l.source));
    // Level is within a quarter of the smaller box: nearer than that, neither is plainly ahead.
    const level = Math.max(8, Math.min(span(l.source), span(l.target)) * 0.25);
    if (delta < -level) backward += 1;
    else if (delta <= level) flat += 1;
    else forward.push([l.source.id, l.target.id]);
    for (let i = 1; i < l.samples.length; i += 1) {
      const step = along(l.samples[i]!) - along(l.samples[i - 1]!);
      if (step > 0) withFlow += step;
      else againstFlow -= step;
    }
    if (delta > level) {
      ends += 2;
      if (face(l.source, l.samples[0]!) === "downstream") goodEnds += 1;
      if (face(l.target, l.samples[l.samples.length - 1]!) === "upstream") goodEnds += 1;
    }
  }
  const boxIds = scene.boxes.map((b) => b.id);
  const backwardNeeded = loopsIn(
    boxIds,
    directed.map((l) => [l.source.id, l.target.id]),
  );

  // ── Boxes that only send, and boxes that only receive ───────────────────────
  const sends = new Map<string, number>();
  const receives = new Map<string, number>();
  for (const l of directed) {
    sends.set(l.source.id, (sends.get(l.source.id) ?? 0) + 1);
    receives.set(l.target.id, (receives.get(l.target.id) ?? 0) + 1);
  }
  let ended = 0;
  let wellEnded = 0;
  for (const piece of piecesOf(scene.boxes, lines)) {
    if (piece.length < 3) continue;
    const positions = piece.map((b) => along(centre(b)));
    const lo = Math.min(...positions);
    const hi = Math.max(...positions);
    // "At the end" is within about half a box of the furthest one.
    const near = Math.max(8, median(piece.map(span)) * 0.6);
    for (const b of piece) {
      const out = sends.get(b.id) ?? 0;
      const into = receives.get(b.id) ?? 0;
      const at = along(centre(b));
      if (out && !into) {
        ended += 1;
        if (at - lo <= near) wellEnded += 1;
      } else if (into && !out) {
        ended += 1;
        if (hi - at <= near) wellEnded += 1;
      }
    }
  }

  // ── Around each box ─────────────────────────────────────────────────────────
  const around = new Map<string, Map<string, number>>();
  for (const l of lines) {
    if (l.source.id === l.target.id) continue;
    const a = centre(l.source);
    const b = centre(l.target);
    for (const [self, other, from, to] of [
      [l.source.id, l.target.id, a, b],
      [l.target.id, l.source.id, b, a],
    ] as const) {
      const set = around.get(self) ?? new Map<string, number>();
      set.set(other, Math.atan2(to.y - from.y, to.x - from.x));
      around.set(self, set);
    }
  }
  let resolution = 0;
  let hubs = 0;
  for (const set of around.values()) {
    if (set.size < 2) continue;
    const angles = [...set.values()].sort((a, b) => a - b);
    let least = Math.PI * 2 - (angles[angles.length - 1]! - angles[0]!);
    for (let i = 1; i < angles.length; i += 1) least = Math.min(least, angles[i]! - angles[i - 1]!);
    hubs += 1;
    resolution += Math.min(1, least / ((Math.PI * 2) / angles.length));
  }

  // ── The lines themselves ────────────────────────────────────────────────────
  let turned = 0;
  for (const l of lines) {
    let heading: number | null = null;
    for (let i = 1; i < l.samples.length; i += 1) {
      const dx = l.samples[i]!.x - l.samples[i - 1]!.x;
      const dy = l.samples[i]!.y - l.samples[i - 1]!.y;
      if (Math.hypot(dx, dy) < 0.5) continue;
      const next = Math.atan2(dy, dx);
      if (heading !== null) {
        let turn = Math.abs(next - heading);
        if (turn > Math.PI) turn = Math.PI * 2 - turn;
        turned += turn;
      }
      heading = next;
    }
  }
  const lengths = lines.map((l) => l.length);
  const meanLength = lengths.reduce((sum, v) => sum + v, 0) / Math.max(1, lengths.length);
  const lengthSpread =
    lengths.length > 1 && meanLength > 0
      ? Math.sqrt(lengths.reduce((sum, v) => sum + (v - meanLength) ** 2, 0) / lengths.length) / meanLength
      : 0;

  // ── The longest path ────────────────────────────────────────────────────────
  const spine = spineOf(scene.boxes, forward, along);
  let spineStraightness = 1;
  if (spine.length >= 3) {
    const offsets = spine.map((b) => across(centre(b)));
    const reach = along(centre(spine[spine.length - 1]!)) - along(centre(spine[0]!));
    const wander = Math.max(...offsets) - Math.min(...offsets);
    spineStraightness = reach > 0 ? Math.max(0, 1 - wander / reach) : 0;
  }

  // ── Ranks ───────────────────────────────────────────────────────────────────
  let rankEvenness = 1;
  if (solids.length >= 3) {
    const sorted = [...solids].sort((a, b) => along(centre(a)) - along(centre(b)));
    const apart = Math.max(8, median(solids.map(span)) * 0.5);
    // Leading and trailing edge of each rank, along the flow.
    const ranks: Array<{ lead: number; trail: number }> = [];
    let last = -Infinity;
    for (const b of sorted) {
      const at = along(centre(b));
      const lead = at - span(b) / 2;
      const trail = at + span(b) / 2;
      if (at - last > apart || !ranks.length) ranks.push({ lead, trail });
      else {
        const rank = ranks[ranks.length - 1]!;
        rank.lead = Math.min(rank.lead, lead);
        rank.trail = Math.max(rank.trail, trail);
      }
      last = at;
    }
    if (ranks.length >= 3) {
      const gaps = ranks.slice(1).map((r, i) => r.lead - ranks[i]!.trail);
      const mean = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
      const deviation = Math.sqrt(gaps.reduce((sum, g) => sum + (g - mean) ** 2, 0) / gaps.length);
      rankEvenness = Math.max(0, 1 - deviation / Math.max(1, Math.abs(mean)));
    }
  }

  // ── Symmetry across the line the flow runs along ────────────────────────────
  let symmetry = 1;
  if (solids.length >= 2) {
    const points = solids.map((b) => ({ a: along(centre(b)), c: across(centre(b)) }));
    const reachOf = Math.max(4, median(solids.map((b) => Math.min(b.w, b.h))) * 0.35);
    const lows = Math.min(...solids.map((b) => across(centre(b))));
    const highs = Math.max(...solids.map((b) => across(centre(b))));
    const middles = [(lows + highs) / 2, points.reduce((sum, p) => sum + p.c, 0) / points.length];
    symmetry = 0;
    for (const middle of middles) {
      let mirrored = 0;
      for (const p of points) {
        const image = 2 * middle - p.c;
        if (points.some((q) => Math.abs(q.a - p.a) <= reachOf && Math.abs(q.c - image) <= reachOf)) mirrored += 1;
      }
      symmetry = Math.max(symmetry, mirrored / points.length);
    }
  }

  // ── Groups and zones ────────────────────────────────────────────────────────
  const fills: number[] = [];
  const fill = (frame: { x: number; y: number; w: number; h: number }, members: readonly SceneBox[]) => {
    if (!members.length || !(frame.w > 0) || !(frame.h > 0)) return;
    const minX = Math.min(...members.map((m) => m.x));
    const minY = Math.min(...members.map((m) => m.y));
    const maxX = Math.max(...members.map((m) => m.x + m.w));
    const maxY = Math.max(...members.map((m) => m.y + m.h));
    fills.push(Math.min(1, ((maxX - minX) * (maxY - minY)) / (frame.w * frame.h)));
  };
  for (const f of scene.boxes) if (f.frame) fill(f, scene.boxes.filter((b) => b.ancestors[0] === f.id));
  for (const z of scene.zones) fill(z, scene.boxes.filter((b) => !b.ancestors.length && b.node.zoneId === z.id));

  const share = (part: number, whole: number) => (whole ? part / whole : 1);
  return {
    axis,
    boxes: scene.boxes.length,
    lines: lines.length,
    crossings,
    overlaps,
    crossingAngle: crossings ? offSquare / crossings : 0,
    directed: directed.length,
    backward,
    backwardNeeded,
    flat,
    flowConsistency: share(withFlow, withFlow + againstFlow),
    portDiscipline: share(goodEnds, ends),
    sourceSinkPlacement: share(wellEnded, ended),
    angularResolution: share(resolution, hubs),
    bends: lines.length ? turned / (Math.PI / 2) / lines.length : 0,
    spineStraightness,
    stress: stressOf(scene.boxes, lines),
    rankEvenness,
    symmetry,
    groupCompactness: fills.length ? fills.reduce((sum, f) => sum + f, 0) / fills.length : 1,
    lengthSpread,
  };
}

export interface LayoutStability {
  /** How far a box moved, on average, in boxes: 0 is nothing moved, 1 is a box's own size. */
  moved: number;
  /** Share of pairs of boxes still the same way round: left of, and above. */
  orderKept: number;
}

/**
 * How much of the picture a reader already knew survives a new arrangement.
 * The two are lined up first, since a whole picture sliding across the canvas
 * changes nothing a reader remembers.
 */
export function layoutStability(before: DiagramTemplate, after: DiagramTemplate, opts: LintLayoutOptions = {}): LayoutStability {
  const drilled = typeof opts.frames === "object" ? opts.frames.drill : null;
  const sceneOf = (t: DiagramTemplate) => buildScene(t, { containerKinds: opts.containerKinds ?? CONTAINER_KINDS, frame: drilled });
  const was = new Map(sceneOf(before).boxes.filter((b) => !b.frame).map((b) => [b.id, b]));
  const pairs: Array<{ a: Pt; b: Pt; size: number }> = [];
  for (const b of sceneOf(after).boxes) {
    const old = was.get(b.id);
    if (old && !b.frame) pairs.push({ a: centre(old), b: centre(b), size: (old.w + old.h) / 2 });
  }
  if (!pairs.length) return { moved: 0, orderKept: 1 };
  const shiftX = pairs.reduce((sum, p) => sum + p.b.x - p.a.x, 0) / pairs.length;
  const shiftY = pairs.reduce((sum, p) => sum + p.b.y - p.a.y, 0) / pairs.length;
  const size = pairs.reduce((sum, p) => sum + p.size, 0) / pairs.length;
  const moved = pairs.reduce((sum, p) => sum + Math.hypot(p.b.x - shiftX - p.a.x, p.b.y - shiftY - p.a.y), 0) / pairs.length / Math.max(1, size);

  let kept = 0;
  let asked = 0;
  // Every pair up to a few thousand; past that, every nth, which is as good a sample as any.
  const stride = Math.max(1, Math.floor((pairs.length * (pairs.length - 1)) / 2 / 4000));
  let n = 0;
  for (let i = 0; i < pairs.length; i += 1) {
    for (let j = i + 1; j < pairs.length; j += 1) {
      n += 1;
      if (n % stride) continue;
      const p = pairs[i]!;
      const q = pairs[j]!;
      for (const key of ["x", "y"] as const) {
        const then = Math.sign(Math.round(q.a[key] - p.a[key]));
        if (!then) continue;
        asked += 1;
        if (Math.sign(Math.round(q.b[key] - p.b[key])) === then) kept += 1;
      }
    }
  }
  return { moved, orderKept: asked ? kept / asked : 1 };
}
