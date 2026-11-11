/**
 * layout-lint.ts — is this picture any good?
 *
 * Measures what a reader SEES, not what the document says: every rule runs on
 * the lines as drawn (the same `edgeGeometryFor`, row anchors and bundling the
 * canvas and the exporters use), so a finding here is a defect on the screen.
 *
 * Three consumers, one measurement:
 *   - people, through the Layout panel (a score, the findings, a fix for each);
 *   - models, through `bd-layout lint`, as feedback on the placement they chose;
 *   - the auto-placer, which uses `cost` to choose between candidates.
 *
 * NO RULE HERE HAS AN OPINION ABOUT SHAPE. A diagram may be long, tall, round
 * or sprawling; no rule looks at its aspect ratio or its size. They look at
 * what makes any picture hard to read: boxes on boxes, lines through boxes,
 * lines through lines, words on top of things, and near-misses the eye reads as
 * mistakes. So a smarter author is never marked down for an unusual arrangement
 * that reads well.
 */
import {
  edgeGeometryFor,
  endGlyphSpan,
  endNotation,
  runsVerticallyAt,
  type Box,
  type EdgeGeometry,
} from "./geometry";
import {
  absolutePosition,
  closedContainers,
  COLLAPSED_SIZE,
  CONTAINER_KINDS,
  DESC_FONT_SIZE,
  DEFAULT_FONT_SIZE,
  fieldAnchors,
  KIND_SHAPES,
  lineEndSlots,
  nodeTextWidth,
  resolveRouting,
  visibleElements,
  withEndSlots,
  wrappedDescWidth,
  type DiagramEdge,
  type DiagramNode,
  type DiagramTemplate,
  type Notation,
} from "./schema";
import { approxTextWidth, wrapText, wrappedLineCount } from "./text";
import type { DiagramZone } from "./zones";
import { DEPENDENCY_RELATION } from "./tasks";
import { cardParentIdsOf, frameResolver } from "./layout-frames";
import type { LintFinding, LintIssue, LintRuleDef, LintSeverity } from "./lint";

// ─── The scene: what the canvas draws ────────────────────────────────────────

type Pt = { x: number; y: number };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneBox extends Rect {
  id: string;
  node: DiagramNode;
  /** An open container: a frame around its members, not an obstacle to lines. */
  frame: boolean;
  /** Open containers this box sits inside, nearest first. */
  ancestors: string[];
}

export interface SceneLine {
  edge: DiagramEdge;
  source: SceneBox;
  target: SceneBox;
  geo: EdgeGeometry;
  /** The drawn line, flattened. */
  samples: Pt[];
  length: number;
  /** Where its words are drawn, when it has any. */
  words?: Rect;
}

export interface Scene {
  /** The drilled canvas this picture is, or null for the root canvas. */
  frame: string | null;
  boxes: SceneBox[];
  zones: DiagramZone[];
  lines: SceneLine[];
  /** How the document draws cardinalities, which decides how wide a line's end is. */
  notation: Notation | undefined;
}

/** The font the canvas and the exporters draw an edge's words in. */
const WORDS_FONT = 11;
const WORDS_PITCH = 14;
const WORDS_MIN_WRAP = 72;
const WORDS_SIDE_WRAP = 160;
const WORDS_MAX_LINES = 4;
const WORDS_SIDE_GAP = 8;
const WORDS_SUB_PITCH = 11;
const TECH_FONT = 9;

/**
 * The rectangle an edge's words occupy — `edgeLabelLayout` in react/shapes.ts
 * reduced to its extent. A contract module cannot import the renderer, so the
 * two are held together by a parity test instead.
 */
export function edgeWordsRect(
  geo: EdgeGeometry,
  labelT: number,
  edge: Partial<Pick<DiagramEdge, "label" | "tech" | "seq" | "date">>,
): Rect | undefined {
  if (!edge.label && !edge.tech && !edge.seq && !edge.date) return undefined;
  const { x, y } = geo.label;
  const beside = runsVerticallyAt(geo, labelT);
  const origin = geo.at(0);
  const room = beside ? WORDS_SIDE_WRAP : Math.max(WORDS_MIN_WRAP, Math.abs(geo.tip.x - origin.x) - 12);
  const lines = edge.label ? wrapText(edge.label, WORDS_FONT, "mono", room, WORDS_MAX_LINES) : [];
  const widest = lines.reduce((m, l) => Math.max(m, approxTextWidth(l, WORDS_FONT, "mono")), 0);
  const sub = Math.max(
    edge.tech ? approxTextWidth(`[${edge.tech}]`, TECH_FONT, "mono") : 0,
    edge.date ? approxTextWidth(String(edge.date), TECH_FONT, "mono") : 0,
  );
  const subLines = (edge.tech ? 1 : 0) + (edge.date ? 1 : 0);
  const w = Math.max(widest, sub, edge.seq ? 16 : 0);
  if (beside) {
    const left = x + WORDS_SIDE_GAP + (edge.seq ? 10 : 0);
    const stack = lines.length * WORDS_PITCH + subLines * WORDS_SUB_PITCH;
    return { x: left, y: y - stack / 2, w, h: stack };
  }
  const rise = Math.max(0, lines.length - 1) * WORDS_PITCH;
  const above = lines.length ? WORDS_FONT + 5 + rise : 0;
  const below = subLines ? 10 + (subLines - 1) * WORDS_SUB_PITCH : 0;
  return { x: x - w / 2, y: y - above, w, h: above + below };
}

/**
 * Where a container's name is drawn: a chip in its top-left corner. Lines and
 * words keep off it. Approximate on purpose, like every text measure here: the
 * name's own width, plus the chrome around it (a collapse button and a count).
 */
export function titleRect(frame: Rect & { node: DiagramNode }): Rect {
  return titleRectOf(frame, frame.node.label, 72);
}

/** A zone's name chip: a swatch and the provider's name take the place of the buttons. */
export function zoneTitleRect(zone: DiagramZone): Rect {
  return titleRectOf(zone, zone.label, 84);
}

function titleRectOf(box: Rect, label: string, chrome: number): Rect {
  return {
    x: box.x,
    y: box.y,
    w: Math.min(box.w, approxTextWidth(label, 11, "mono") + chrome),
    h: 24,
  };
}

/** How a frame's canvas is drawn: which boxes, where, with which lines. */
export function buildScene(
  template: DiagramTemplate,
  opts: { containerKinds?: readonly string[]; frame?: string | null } = {},
): Scene {
  const frame = opts.frame ?? null;
  const containerKinds = opts.containerKinds ?? CONTAINER_KINDS;
  const containers = new Set(containerKinds);
  const byId = new Map(template.nodes.map((n) => [n.id, n]));
  const cardParents = cardParentIdsOf(template, containerKinds);
  const frameOf = frameResolver(template, cardParents);
  const visible = visibleElements(template);
  const closed = new Set(
    [...closedContainers(template, { containerKinds })].filter((id) =>
      containers.has(byId.get(id)?.kind as string),
    ),
  );

  /** Hidden when a closed container sits between this box and its canvas. */
  const insideClosed = (n: DiagramNode): boolean => {
    let cursor = n.parentId ? byId.get(n.parentId) : undefined;
    const guard = new Set<string>([n.id]);
    while (cursor && !guard.has(cursor.id) && !cardParents.has(cursor.id)) {
      if (closed.has(cursor.id)) return true;
      guard.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return false;
  };

  /** Position on its own canvas: the walk stops at a card, whose coordinates belong outside. */
  const positionOf = (n: DiagramNode): Pt => {
    if (frame === null && !frameOf(n.id)) return absolutePosition(n, byId);
    let x = n.x;
    let y = n.y;
    let parent = n.parentId && !cardParents.has(n.parentId) ? byId.get(n.parentId) : undefined;
    const guard = new Set<string>([n.id]);
    while (parent && !guard.has(parent.id)) {
      guard.add(parent.id);
      x += parent.x;
      y += parent.y;
      parent = parent.parentId && !cardParents.has(parent.parentId) ? byId.get(parent.parentId) : undefined;
    }
    return { x, y };
  };

  const boxes: SceneBox[] = [];
  const boxById = new Map<string, SceneBox>();
  const parents = new Set(template.nodes.map((n) => n.parentId).filter(Boolean));
  for (const n of template.nodes) {
    if (frameOf(n.id) !== frame) continue;
    if (!visible.nodes.has(n.id) || insideClosed(n)) continue;
    const { x, y } = positionOf(n);
    const chip = closed.has(n.id);
    const hasKids = parents.has(n.id);
    const ancestors: string[] = [];
    let cursor = n.parentId ? byId.get(n.parentId) : undefined;
    const guard = new Set<string>([n.id]);
    while (cursor && !guard.has(cursor.id) && !cardParents.has(cursor.id)) {
      ancestors.push(cursor.id);
      guard.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    const box: SceneBox = {
      id: n.id,
      node: n,
      x,
      y,
      w: chip ? COLLAPSED_SIZE.w : n.w,
      h: chip ? COLLAPSED_SIZE.h : n.h,
      // An empty group still draws its frame: it is a region, not a box in the way.
      frame: containers.has(n.kind as string) && !chip && (hasKids || n.kind === "group"),
      ancestors,
    };
    boxes.push(box);
    boxById.set(n.id, box);
  }

  /** Where a line ends when its box is folded away: the chip it is folded into. */
  const anchor = (id: string): SceneBox | undefined => {
    let cursor = byId.get(id);
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      const shown = boxById.get(cursor.id);
      if (shown) return shown;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return undefined;
  };

  const drawn: Array<{ edge: DiagramEdge; source: SceneBox; target: SceneBox }> = [];
  const seenPairs = new Set<string>();
  for (const edge of template.edges) {
    // A dependency is drawn only while one of its ends is hovered.
    if (edge.relation === DEPENDENCY_RELATION || !visible.edges.has(edge.id)) continue;
    const s = anchor(edge.source);
    const t = anchor(edge.target);
    if (!s || !t) continue;
    if (s.id !== edge.source || t.id !== edge.target) {
      // A folded end: every line into a chip draws as one.
      const key = `${s.id}\u0000${t.id}`;
      if (s.id === t.id || seenPairs.has(key)) continue;
      seenPairs.add(key);
    }
    drawn.push({ edge, source: s, target: t });
  }

  const asBox = (b: SceneBox): Box => ({ x: b.x, y: b.y, width: b.w, height: b.h });
  const notation = template.settings?.notation;
  const slots = lineEndSlots(
    drawn.map(({ edge, source, target }) => ({ ...edge, source: source.id, target: target.id })),
    (id) => {
      const b = boxById.get(id);
      return b && { fields: b.node.fields, description: b.node.description, box: asBox(b) };
    },
    notation,
  );
  const routing = resolveRouting(template.meta?.routing);
  const anchorNode = (b: SceneBox) => ({
    fields: b.node.fields,
    description: b.node.description,
    h: b.h,
    centerX: b.x + b.w / 2,
  });

  const lines: SceneLine[] = drawn.map(({ edge, source, target }) => {
    const labelT = edge.labelT ?? 0.5;
    const geo = edgeGeometryFor(edge.routing ?? routing, asBox(source), asBox(target), labelT, {
      ...withEndSlots(fieldAnchors(edge, anchorNode(source), anchorNode(target)), slots.get(edge.id)),
      points: edge.points,
      startShape: KIND_SHAPES[source.node.kind as string],
      endShape: KIND_SHAPES[target.node.kind as string],
    });
    const coarse = sampleGeometry(geo, 16);
    const estimate = polylineLength(coarse);
    const samples = withCorners(
      sampleGeometry(geo, Number.isFinite(estimate) ? Math.min(64, Math.max(10, Math.ceil(estimate / 14))) : 10),
      edge.points,
    );
    return {
      edge,
      source,
      target,
      geo,
      samples,
      length: polylineLength(samples),
      words: edgeWordsRect(geo, labelT, edge),
    };
  });

  return { frame, boxes, zones: frame === null ? (template.zones ?? []) : [], lines, notation };
}

/**
 * A route's own corners, put among its samples. A long route is sampled far
 * apart, and a chord between two samples either side of a corner cuts across
 * it, through whatever the route was drawn to go round. Each waypoint goes
 * between the two samples it lies between; one the path doesn't pass through
 * (a curve's control, say) is left out.
 */
function withCorners(samples: Pt[], points: DiagramEdge["points"]): Pt[] {
  if (!points?.length || samples.length < 2) return samples;
  const out = [...samples];
  for (const [x, y] of points) {
    let at = -1;
    let least = Infinity;
    for (let i = 1; i < out.length; i += 1) {
      const a = out[i - 1]!;
      const b = out[i]!;
      const extra = Math.hypot(x - a.x, y - a.y) + Math.hypot(b.x - x, b.y - y) - Math.hypot(b.x - a.x, b.y - a.y);
      if (extra < least) {
        least = extra;
        at = i;
      }
    }
    // Going by way of it at most doubles the step: more than that and it isn't a point on this path.
    const span = at > 0 ? Math.hypot(out[at]!.x - out[at - 1]!.x, out[at]!.y - out[at - 1]!.y) : 0;
    if (at > 0 && least > 0.01 && least <= span) out.splice(at, 0, { x, y });
  }
  return out;
}

export function sampleGeometry(geo: EdgeGeometry, count: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= count; i += 1) out.push(geo.at(i / count));
  return out;
}

function polylineLength(points: readonly Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

// ─── Geometry tests ──────────────────────────────────────────────────────────

/** Does the segment pass through the rectangle, shrunk by `inset`? */
export function segmentHitsRect(a: Pt, b: Pt, r: Rect, inset = 0): boolean {
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
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    if (lo > hi) return false;
  }
  return true;
}

export function polylineHitsRect(points: readonly Pt[], r: Rect, inset = 0): boolean {
  for (let i = 1; i < points.length; i += 1) {
    if (segmentHitsRect(points[i - 1]!, points[i]!, r, inset)) return true;
  }
  return false;
}

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** Whether a rectangle sits across another's edge: partly in, partly out. */
export function straddles(inner: Rect, frame: Rect): boolean {
  return rectsOverlap(inner, frame) && !contains(frame, inner);
}

function contains(outer: Rect, inner: Rect, slack = 0): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.w <= outer.x + outer.w + slack &&
    inner.y + inner.h <= outer.y + outer.h + slack
  );
}

function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  // Two lines on one straight line aren't crossing: `sharedRuns` counts those.
  if (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0) return false;
  // Touching counts. Two curves can cross exactly on a sample, as symmetric ones do.
  return o1 * o2 <= 0 && o3 * o4 <= 0;
}

/** Bounding box of a polyline, for the quick no before the expensive check. */
export function boundsOf(points: readonly Pt[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** How many separate times two lines cross. Consecutive hits are one crossing. */
export function crossingsBetween(a: readonly Pt[], b: readonly Pt[]): number {
  return crossingAngles(a, b).length;
}

/**
 * Each place two lines cross, as the angle between them there: 90 is square
 * across, near 0 is two lines that meet almost parallel and are hard to tell
 * apart. Consecutive hits are one crossing.
 */
export function crossingAngles(a: readonly Pt[], b: readonly Pt[]): number[] {
  const angles: number[] = [];
  let last = -10;
  for (let i = 1; i < a.length; i += 1) {
    const box = boundsOf([a[i - 1]!, a[i]!]);
    for (let j = 1; j < b.length; j += 1) {
      const p = b[j - 1]!;
      const q = b[j]!;
      if (Math.max(p.x, q.x) < box.x || Math.min(p.x, q.x) > box.x + box.w) continue;
      if (Math.max(p.y, q.y) < box.y || Math.min(p.y, q.y) > box.y + box.h) continue;
      if (segmentsIntersect(a[i - 1]!, a[i]!, p, q)) {
        if (i - last > 2) angles.push(angleBetween(a[i - 1]!, a[i]!, p, q));
        last = i;
        break;
      }
    }
  }
  return angles;
}

/** The angle between two segments, folded to 0–90 degrees. */
function angleBetween(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const vx = d.x - c.x;
  const vy = d.y - c.y;
  const lengths = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (!lengths) return 90;
  const cos = Math.min(1, Math.abs(ux * vx + uy * vy) / lengths);
  return (Math.acos(cos) * 180) / Math.PI;
}

/** How finely `sharedRuns` indexes the canvas: about a sampling step or two. */
const RUN_CELL = 32;
/** A bundle runs close on purpose for this far from the box it meets. */
const RUN_BUNDLE = 44;
/** Within a stroke's width, two lines are on top of each other. */
const RUN_ON_TOP = 3;
/**
 * Within this, they are beside each other but too close for the eye to keep
 * apart. Lines a router spaces out side by side sit further apart than this.
 */
const RUN_CLOSE = 8;

/**
 * How far each pair of lines runs on top of each other (`length`), and how far
 * they run close beside each other (`close`). One pass over a spatial index, so
 * a model with hundreds of lines isn't every pair times every sample. Lines
 * sharing a box are forgiven the stretch where they bundle to meet it.
 */
function sharedRuns(lines: readonly SceneLine[]): Map<string, { a: number; b: number; length: number; close: number }> {
  const cells = new Map<string, Array<{ line: number; from: Pt; to: Pt }>>();
  const keyOf = (x: number, y: number) => `${Math.floor(x / RUN_CELL)},${Math.floor(y / RUN_CELL)}`;
  lines.forEach((line, index) => {
    const pts = line.samples;
    for (let i = 1; i < pts.length; i += 1) {
      const from = pts[i - 1]!;
      const to = pts[i]!;
      const seen = new Set<string>();
      for (const [x, y] of [[from.x, from.y], [to.x, to.y], [(from.x + to.x) / 2, (from.y + to.y) / 2]] as const) {
        const key = keyOf(x, y);
        if (seen.has(key)) continue;
        seen.add(key);
        const cell = cells.get(key);
        if (cell) cell.push({ line: index, from, to });
        else cells.set(key, [{ line: index, from, to }]);
      }
    }
  });

  const runs = new Map<string, { a: number; b: number; length: number; close: number }>();
  lines.forEach((line, index) => {
    const pts = line.samples;
    const total = line.length;
    let travelled = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const p = pts[i]!;
      const step = Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y);
      travelled += step;
      // The nearest each other line comes to this point.
      const near = new Map<number, number>();
      const cx = Math.floor(p.x / RUN_CELL);
      const cy = Math.floor(p.y / RUN_CELL);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const seg of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (seg.line <= index) continue;
            const q = closestOnSegment(p, seg.from, seg.to);
            const gap = Math.hypot(p.x - q.x, p.y - q.y);
            if (gap <= RUN_CLOSE && gap < (near.get(seg.line) ?? Infinity)) near.set(seg.line, gap);
          }
        }
      }
      for (const [other, gap] of near) {
        const o = lines[other]!;
        const atStart = travelled < RUN_BUNDLE && (line.source.id === o.source.id || line.source.id === o.target.id);
        const atEnd = total - travelled < RUN_BUNDLE && (line.target.id === o.source.id || line.target.id === o.target.id);
        if (atStart || atEnd) continue;
        const key = `${index} ${other}`;
        const run = runs.get(key) ?? { a: index, b: other, length: 0, close: 0 };
        if (gap <= RUN_ON_TOP) run.length += step;
        else run.close += step;
        runs.set(key, run);
      }
    }
  });
  return runs;
}

/** How near a polyline comes to a rectangle: 0 when it touches or crosses it. */
function polylineToRect(points: readonly Pt[], r: Rect): number {
  if (polylineHitsRect(points, r)) return 0;
  const toRect = (p: Pt) => Math.hypot(Math.max(r.x - p.x, 0, p.x - (r.x + r.w)), Math.max(r.y - p.y, 0, p.y - (r.y + r.h)));
  const corners: Pt[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x, y: r.y + r.h },
    { x: r.x + r.w, y: r.y + r.h },
  ];
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    // A segment that misses a rectangle comes nearest at one of its own ends or at one of the corners.
    best = Math.min(best, toRect(a), toRect(b));
    for (const c of corners) {
      const q = closestOnSegment(c, a, b);
      best = Math.min(best, Math.hypot(c.x - q.x, c.y - q.y));
    }
  }
  return best;
}

/**
 * Where a line is heading over a stretch of its length, measured from one end:
 * `from` and `to` are distances along the line from that end, in pixels.
 */
function headingNear(geo: EdgeGeometry, length: number, atEnd: boolean, from: number, to: number): Pt | null {
  if (length < to * 1.5) return null;
  const steps = 24;
  const reach = Math.min(0.5, (to * 1.6) / length);
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (reach * i) / steps;
    pts.push(geo.at(atEnd ? 1 - t : t));
  }
  // Positions by distance travelled from the end.
  const at = (distance: number): Pt => {
    let travelled = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const step = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
      if (travelled + step >= distance) {
        const k = step ? (distance - travelled) / step : 0;
        return { x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * k, y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * k };
      }
      travelled += step;
    }
    return pts[pts.length - 1]!;
  };
  const near = at(from);
  const far = at(to);
  // Heading toward the end it was measured from.
  return { x: near.x - far.x, y: near.y - far.y };
}

/** The size of window a picture is fitted to before anyone zooms. */
export const TYPICAL_WINDOW = { w: 1500, h: 900 };
/** Fitted to the window smaller than this, a box's 13px label is under 7px on screen. */
export const READABLE_ZOOM = 0.5;
/**
 * How much it costs for the words to shrink when the picture is fitted to the
 * window: per halving. Not a preference for any shape, since anything that fits
 * at full size pays nothing. Readers named size more often than anything else
 * when choosing between two pictures of one diagram.
 */
export const LEGIBILITY_WEIGHT = 16;
/**
 * Past `READABLE_ZOOM` it stops being a preference: text nobody can read is as
 * much a defect as a line through a box, however few crossings it took.
 */
export const ILLEGIBLE_WEIGHT = 1500;

/** How far a picture of this size is scaled to fit the window: 1 when it fits as it is. */
export function fitZoom(width: number, height: number): number {
  return Math.min(1, TYPICAL_WINDOW.w / Math.max(1, width), TYPICAL_WINDOW.h / Math.max(1, height));
}

function closestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  if (!len) return a;
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

// ─── The rules ───────────────────────────────────────────────────────────────

/** Each rule's id. Stable: a host filters on them, and `lint-ignore:<rule>` names them. */
export const LAYOUT_RULE_IDS = [
  "box-overlap",
  "line-through-box",
  "line-crossing",
  "line-overlap",
  "words-collision",
  "words-on-line",
  "words-on-border",
  "box-too-close",
  "outside-container",
  "region-collision",
  "intruder",
  "line-over-title",
  "line-on-border",
  "almost-level",
  "text-clipped",
  "near-alignment",
  "uneven-spacing",
  "against-the-flow",
  "long-line",
  "line-detour",
  "loose-container",
  "sparse-canvas",
  "shallow-crossing",
  "close-lines",
  "line-hook",
  "curve-bulge",
  "ambiguous-words",
  "crowded-ends",
  "too-dense",
] as const;
export type LayoutRuleId = (typeof LAYOUT_RULE_IDS)[number];

interface RuleMeta {
  label: string;
  description: string;
  severity: LintSeverity;
  /** What one finding takes off the score, and the most this rule can take. */
  penalty: number;
  cap: number;
  /** Weight in `cost`, the number candidates are chosen by. */
  cost: number;
}

/**
 * `too-dense` takes nothing off the score: it depends on how big the picture
 * is, and the score never marks a picture down for its size. It still counts
 * in the cost, and it is still reported.
 *
 * The penalties are a judgement about what a reader notices first, and the only
 * tuning knob here. Errors are the things that make a diagram wrong; warnings
 * the things that make it hard to read; info the polish that separates a good
 * one from a great one.
 */
export const LAYOUT_RULES: Record<LayoutRuleId, RuleMeta> = {
  "box-overlap": { label: "Boxes overlap", description: "Two boxes cover each other, so one of them cannot be read.", severity: "error", penalty: 14, cap: 60, cost: 60 },
  "line-through-box": { label: "Line runs through a box", description: "A line passes behind a box it doesn't connect to, which reads as a connection that isn't there.", severity: "error", penalty: 7, cap: 45, cost: 34 },
  "outside-container": { label: "Spills out of its container", description: "A box sits outside the group or zone it belongs to.", severity: "error", penalty: 7, cap: 35, cost: 30 },
  "region-collision": { label: "Regions overlap", description: "Two zones partly overlap, with neither inside the other, so it is unclear what belongs to which.", severity: "warning", penalty: 7, cap: 28, cost: 24 },
  intruder: { label: "A box sits in someone else's frame", description: "A box that doesn't belong to a group or zone is drawn inside it.", severity: "warning", penalty: 6, cap: 24, cost: 22 },
  "line-crossing": { label: "Lines cross", description: "Each crossing makes a reader stop and work out which line goes where.", severity: "info", penalty: 1.5, cap: 20, cost: 9 },
  "line-overlap": { label: "Lines run on top of each other", description: "Two lines share a stretch of canvas, so they read as one.", severity: "warning", penalty: 3, cap: 18, cost: 12 },
  "words-collision": { label: "Words collide", description: "A line's label sits on a box or on another label.", severity: "warning", penalty: 3, cap: 21, cost: 11 },
  "words-on-line": { label: "A line runs through words", description: "Another line passes through a label.", severity: "info", penalty: 1, cap: 8, cost: 4 },
  "words-on-border": { label: "Words on a frame's edge", description: "A label straddling a group's or zone's border reads as neither inside nor out.", severity: "info", penalty: 1, cap: 6, cost: 4 },
  "box-too-close": { label: "Boxes nearly touch", description: "Boxes this close read as one object.", severity: "warning", penalty: 1, cap: 8, cost: 4 },
  "line-over-title": { label: "Line over a container's title", description: "A line crosses the name of a group or zone, so the name can't be read.", severity: "warning", penalty: 2, cap: 10, cost: 7 },
  "line-on-border": { label: "Line runs along a frame's edge", description: "A line running on top of a group's or zone's border reads as part of the border.", severity: "info", penalty: 1, cap: 5, cost: 4 },
  "almost-level": { label: "Line is almost straight", description: "A long line a few pixels off level looks like a mistake. Exactly level, or plainly sloped, reads as intent.", severity: "info", penalty: 0.5, cap: 4, cost: 3 },
  "text-clipped": { label: "Text is cut off", description: "A box is too small for its words, so they are cut short.", severity: "warning", penalty: 1, cap: 8, cost: 1.5 },
  "near-alignment": { label: "Nearly lined up", description: "A few pixels off a line reads as a mistake where exactly on it reads as intent.", severity: "info", penalty: 0.5, cap: 5, cost: 1.5 },
  "uneven-spacing": { label: "Uneven spacing", description: "Boxes in one row or column sit at different distances for no visible reason.", severity: "info", penalty: 0.5, cap: 4, cost: 1 },
  "against-the-flow": { label: "Runs against the flow", description: "Most lines run one way and this one the other. A loop has to; otherwise it may be pointing at the wrong box.", severity: "info", penalty: 0.25, cap: 3, cost: 1 },
  "long-line": { label: "A very long line", description: "This line travels much further than the rest. Its ends may want to sit closer.", severity: "info", penalty: 0.5, cap: 4, cost: 5 },
  "line-detour": { label: "A line takes the long way", description: "A line travels far further than the distance between its ends.", severity: "info", penalty: 0.5, cap: 3, cost: 1 },
  "loose-container": { label: "Container much bigger than its contents", description: "A frame with this much empty room looks unfinished.", severity: "info", penalty: 1, cap: 5, cost: 3 },
  "sparse-canvas": { label: "A lot of empty canvas", description: "The boxes cover very little of the space they are spread over, so they will be small when fitted to a screen.", severity: "info", penalty: 2, cap: 2, cost: 6 },
  "shallow-crossing": { label: "Lines cross at a shallow angle", description: "Two lines that cross almost parallel are hard to tell apart where they meet. Square across reads at a glance.", severity: "info", penalty: 1, cap: 8, cost: 6 },
  "close-lines": { label: "Lines run close together", description: "Two lines run alongside each other a few pixels apart, so the eye can't keep them apart.", severity: "warning", penalty: 2, cap: 12, cost: 8 },
  "line-hook": { label: "A line doubles back", description: "A line turns back on itself near one of its ends, which reads as a mistake.", severity: "warning", penalty: 2, cap: 10, cost: 6 },
  "curve-bulge": { label: "A curve bulges out", description: "A curve swings far outside the space between its ends, taking room and crossing what's there.", severity: "info", penalty: 1, cap: 6, cost: 4 },
  "ambiguous-words": { label: "Words could belong to another line", description: "A label sits as near another line as its own, so a reader can't tell which line it names.", severity: "warning", penalty: 2, cap: 10, cost: 6 },
  "crowded-ends": { label: "Line ends crowd together", description: "Lines meet a box so close together that their ends sit on top of each other.", severity: "warning", penalty: 1.5, cap: 9, cost: 5 },
  "too-dense": { label: "Too much for one view", description: "Fitted to a screen this picture is too small to read, and it has more lines than boxes. Collapsing a group, or splitting the diagram, helps more than any arrangement.", severity: "warning", penalty: 0, cap: 0, cost: 30 },
};

export interface LayoutFinding extends LintFinding {
  rule: LayoutRuleId;
  /** The drilled canvas the finding is on; absent on the root canvas. */
  frame?: string;
}

export interface LayoutReport {
  /** 100 is a picture with nothing to fix. */
  score: number;
  /** What candidates are chosen by: lower is better, and it can go past where the score stops. */
  cost: number;
  findings: LayoutFinding[];
  /** How much of each rule was found. */
  counts: Partial<Record<LayoutRuleId, number>>;
  metrics: {
    boxes: number;
    lines: number;
    width: number;
    height: number;
    /** Total drawn length of every line. */
    lineLength: number;
    /** How far the canvas (the drilled one if one was asked for, else the root) is scaled to fit a typical window: 1 when it fits as it is. */
    zoom: number;
  };
}

type Emit = (rule: LayoutRuleId, issue: LintIssue) => void;

/** Crossing at less than this many degrees, two lines read as one for a moment. */
const SHALLOW_CROSSING = 25;
/** How far two lines run close together before they read as one. */
const CLOSE_RUN = 60;
/** Arriving more than this far off the way it came, a line has doubled back. */
const HOOK_TURN = 115;
/** How far back from an end "the way it came" is measured. */
const HOOK_REACH = 160;
/** A curve this far outside the space between its ends has swung out of its way. */
const BULGE_MIN = 60;
/** How near another line can be to a label before the label could name it. */
const AMBIGUOUS_REACH = 24;
/** Line ends whose glyphs are nearer than this have run into each other: a little under the pixel a bundle leaves between them. */
const CROWDED_SLACK = 0.75;
/** Below this many lines, a picture isn't dense, however small it is. */
const DENSE_LINES = 20;

/** Past this many boxes on one canvas the pairwise polish rules are skipped. */
const PAIRWISE_LIMIT = 400;
/** Past this many lines, crossings are not worth counting one by one. */
const CROSSING_LIMIT = 500;

function lintScene(scene: Scene, emit: Emit): void {
  const { boxes, lines, zones } = scene;
  const solids = boxes.filter((b) => !b.frame);
  const frames = boxes.filter((b) => b.frame);
  const textual = (b: SceneBox) => b.node.kind === "text";
  const point = (b: SceneBox) => b.node.kind === "point";
  const name = (b: SceneBox) => (b.node.label ? `"${b.node.label}"` : b.id);
  const siblings = (a: SceneBox, b: SceneBox) => (a.ancestors[0] ?? "") === (b.ancestors[0] ?? "");

  // ── Boxes against boxes ─────────────────────────────────────────────────────
  if (solids.length <= PAIRWISE_LIMIT * 3) {
    const sorted = [...solids].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length; i += 1) {
      const a = sorted[i]!;
      for (let j = i + 1; j < sorted.length; j += 1) {
        const b = sorted[j]!;
        if (b.x > a.x + a.w + 10) break;
        // Provider alternates stacked on purpose are never visible together,
        // and the scene only holds what is visible.
        if (rectsOverlap(a, b)) {
          emit("box-overlap", { message: `${name(a)} and ${name(b)} overlap`, nodeIds: [a.id, b.id] });
        } else if (rectsOverlap(a, b, 8) && !point(a) && !point(b)) {
          emit("box-too-close", { message: `${name(a)} and ${name(b)} nearly touch`, nodeIds: [a.id, b.id] });
        }
      }
    }
  }

  // ── Containers ──────────────────────────────────────────────────────────────
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  for (const b of boxes) {
    const parent = b.ancestors[0] ? boxById.get(b.ancestors[0]) : undefined;
    if (parent && !contains(parent, b, 1)) {
      emit("outside-container", { message: `${name(b)} spills out of ${name(parent)}`, nodeIds: [b.id, parent.id] });
    }
  }
  for (const f of frames) {
    for (const b of boxes) {
      if (b === f || b.ancestors.includes(f.id) || f.ancestors.includes(b.id)) continue;
      if (rectsOverlap(f, b)) {
        // Two frames meeting is one finding; a box inside a frame is the other.
        if (b.frame && boxes.indexOf(b) < boxes.indexOf(f)) continue;
        emit("intruder", { message: `${name(b)} overlaps ${name(f)} but isn't part of it`, nodeIds: [b.id, f.id] });
      }
    }
  }
  const zoneOf = (z: DiagramZone): Rect => ({ x: z.x, y: z.y, w: z.w, h: z.h });
  for (let i = 0; i < zones.length; i += 1) {
    for (let j = i + 1; j < zones.length; j += 1) {
      const a = zoneOf(zones[i]!);
      const b = zoneOf(zones[j]!);
      if (rectsOverlap(a, b) && !contains(a, b) && !contains(b, a)) {
        emit("region-collision", { message: `Zones "${zones[i]!.label}" and "${zones[j]!.label}" partly overlap` });
      }
    }
  }
  for (const b of boxes) {
    if (b.ancestors.length) continue;
    const own = b.node.zoneId;
    for (const z of zones) {
      if (z.id === own) {
        if (!contains(zoneOf(z), b, 1)) {
          emit("outside-container", { message: `${name(b)} spills out of zone "${z.label}"`, nodeIds: [b.id] });
        }
      } else if (rectsOverlap(zoneOf(z), b) && !contains(zoneOf(z), b) && !textual(b)) {
        // Inside another zone entirely is how an island works; straddling is not.
        const inOwn = zones.find((o) => o.id === own);
        if (!inOwn || !contains(zoneOf(z), zoneOf(inOwn))) {
          emit("intruder", { message: `${name(b)} straddles zone "${z.label}"`, nodeIds: [b.id] });
        }
      }
    }
  }
  for (const f of frames) {
    const members = boxes.filter((b) => b.ancestors[0] === f.id);
    if (!members.length) continue;
    const area = members.reduce((sum, m) => sum + m.w * m.h, 0);
    if (area / (f.w * f.h) < 0.12) {
      emit("loose-container", { message: `${name(f)} is much bigger than what's in it`, nodeIds: [f.id] });
    }
  }
  for (const z of zones) {
    // A group in the zone counts as the room it takes; what's inside it is the group's business.
    const members = boxes.filter((b) => !b.ancestors.length && b.node.zoneId === z.id);
    const held = zones.filter((o) => o !== z && contains(zoneOf(z), zoneOf(o)));
    if (!members.length && !held.length) continue;
    const area =
      members.reduce((sum, m) => sum + m.w * m.h, 0) + held.reduce((sum, o) => sum + o.w * o.h, 0);
    if (area / (z.w * z.h) < 0.1) {
      emit("loose-container", { message: `Zone "${z.label}" is much bigger than what's in it` });
    }
  }

  // ── Lines against boxes ─────────────────────────────────────────────────────
  for (const line of lines) {
    const exempt = new Set([line.source.id, line.target.id, ...line.source.ancestors, ...line.target.ancestors]);
    const bounds = boundsOf(line.samples);
    for (const b of solids) {
      if (exempt.has(b.id) || point(b)) continue;
      if (!rectsOverlap(bounds, b)) continue;
      if (polylineHitsRect(line.samples, b, 2)) {
        emit("line-through-box", {
          message: `The line from ${name(line.source)} to ${name(line.target)} runs through ${name(b)}`,
          nodeIds: [b.id],
          edgeIds: [line.edge.id],
        });
      }
    }
    for (const f of frames) {
      // A line attached to the frame itself isn't crossing it, it's arriving.
      if (f.id === line.source.id || f.id === line.target.id) continue;
      const title = titleRect(f);
      if (rectsOverlap(bounds, title) && polylineHitsRect(line.samples, title)) {
        emit("line-over-title", {
          message: `The line from ${name(line.source)} to ${name(line.target)} crosses the title of ${name(f)}`,
          nodeIds: [f.id],
          edgeIds: [line.edge.id],
        });
      }
    }
  }

  // ── Lines against lines ─────────────────────────────────────────────────────
  if (lines.length <= CROSSING_LIMIT) {
    const bounds = lines.map((l) => boundsOf(l.samples));
    for (let i = 0; i < lines.length; i += 1) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!rectsOverlap(bounds[i]!, bounds[j]!)) continue;
        const a = lines[i]!;
        const b = lines[j]!;
        for (const angle of crossingAngles(a.samples, b.samples)) {
          emit("line-crossing", {
            message: `The lines ${describeLine(a)} and ${describeLine(b)} cross`,
            edgeIds: [a.edge.id, b.edge.id],
          });
          if (angle < SHALLOW_CROSSING) {
            emit("shallow-crossing", {
              message: `The lines ${describeLine(a)} and ${describeLine(b)} cross at ${Math.round(angle)}°, almost parallel`,
              edgeIds: [a.edge.id, b.edge.id],
            });
          }
        }
      }
    }
  }
  // Shared stretches are found through an index, so they are counted however many lines there are.
  for (const run of sharedRuns(lines).values()) {
    const a = lines[run.a]!;
    const b = lines[run.b]!;
    if (run.length > 36) {
      emit("line-overlap", {
        message: `The lines ${describeLine(a)} and ${describeLine(b)} run on top of each other`,
        edgeIds: [a.edge.id, b.edge.id],
      });
    }
    if (run.close > CLOSE_RUN) {
      emit("close-lines", {
        message: `The lines ${describeLine(a)} and ${describeLine(b)} run a few pixels apart`,
        edgeIds: [a.edge.id, b.edge.id],
      });
    }
  }

  // ── Words ───────────────────────────────────────────────────────────────────
  const worded = lines.filter((l) => l.words);
  const lineBounds = lines.map((l) => boundsOf(l.samples));
  for (let i = 0; i < worded.length; i += 1) {
    const a = worded[i]!;
    for (const b of solids) {
      if (rectsOverlap(a.words!, b)) {
        emit("words-collision", {
          message: `The words on ${describeLine(a)} sit on ${name(b)}`,
          edgeIds: [a.edge.id],
          nodeIds: [b.id],
        });
      }
    }
    for (const f of frames) {
      if (rectsOverlap(a.words!, titleRect(f))) {
        emit("words-collision", {
          message: `The words on ${describeLine(a)} sit on the title of ${name(f)}`,
          edgeIds: [a.edge.id],
          nodeIds: [f.id],
        });
      }
    }
    for (const z of zones) {
      if (rectsOverlap(a.words!, zoneTitleRect(z))) {
        emit("words-collision", { message: `The words on ${describeLine(a)} sit on the title of zone "${z.label}"`, edgeIds: [a.edge.id] });
      }
      if (straddles(a.words!, zoneOf(z))) {
        emit("words-on-border", { message: `The words on ${describeLine(a)} straddle the edge of zone "${z.label}"`, edgeIds: [a.edge.id] });
      }
    }
    for (const f of frames) {
      if (straddles(a.words!, f)) {
        emit("words-on-border", { message: `The words on ${describeLine(a)} straddle the edge of ${name(f)}`, edgeIds: [a.edge.id], nodeIds: [f.id] });
      }
    }
    for (let j = i + 1; j < worded.length; j += 1) {
      const b = worded[j]!;
      if (rectsOverlap(a.words!, b.words!)) {
        emit("words-collision", {
          message: `The words on ${describeLine(a)} and ${describeLine(b)} sit on each other`,
          edgeIds: [a.edge.id, b.edge.id],
        });
      }
    }
    for (let o = 0; o < lines.length; o += 1) {
      const other = lines[o]!;
      if (other === a || !rectsOverlap(a.words!, lineBounds[o]!)) continue;
      if (polylineHitsRect(other.samples, a.words!, 1)) {
        emit("words-on-line", {
          message: `The line ${describeLine(other)} runs through the words on ${describeLine(a)}`,
          edgeIds: [a.edge.id, other.edge.id],
        });
      }
    }
    // Words that sit as near another line as their own could name either.
    const own = polylineToRect(a.samples, a.words!);
    const reach = { x: a.words!.x - AMBIGUOUS_REACH, y: a.words!.y - AMBIGUOUS_REACH, w: a.words!.w + AMBIGUOUS_REACH * 2, h: a.words!.h + AMBIGUOUS_REACH * 2 };
    for (let o = 0; o < lines.length; o += 1) {
      const other = lines[o]!;
      if (other === a || !rectsOverlap(reach, lineBounds[o]!)) continue;
      const gap = polylineToRect(other.samples, a.words!);
      // Touching is `words-on-line`.
      if (gap > 1 && gap < AMBIGUOUS_REACH && gap <= own + 4) {
        emit("ambiguous-words", {
          message: `The words on ${describeLine(a)} sit as near ${describeLine(other)}`,
          edgeIds: [a.edge.id, other.edge.id],
        });
        break;
      }
    }
  }

  // ── Text that doesn't fit ───────────────────────────────────────────────────
  for (const line of lines) {
    const bounds = boundsOf(line.samples);
    for (const z of zones) {
      const title = zoneTitleRect(z);
      if (rectsOverlap(bounds, title) && polylineHitsRect(line.samples, title)) {
        emit("line-over-title", { message: `The line ${describeLine(line)} crosses the title of zone "${z.label}"`, edgeIds: [line.edge.id] });
      }
    }
  }
  for (const b of solids) {
    if (b.node.wrap || b.node.collapsed || point(b)) continue;
    const n = b.node;
    if (n.kind === "text") {
      const font = n.fontSize ?? 13;
      const lineCount = wrappedLineCount(n.label, font, "sans", Math.max(24, b.w - 16));
      if (lineCount * font * 1.35 + 8 > b.h + 2) {
        emit("text-clipped", { message: `The note ${name(b)} doesn't fit its box`, nodeIds: [b.id] });
      }
      continue;
    }
    if (n.fields?.length) continue;
    const font = n.fontSize ?? DEFAULT_FONT_SIZE;
    if (approxTextWidth(n.label, font, "sans") > nodeTextWidth(b.w, !!n.icon)) {
      emit("text-clipped", { message: `${name(b)} is cut off`, nodeIds: [b.id] });
    } else if (n.description) {
      const lines = wrappedLineCount(n.description, DESC_FONT_SIZE, "sans", wrappedDescWidth(b.w));
      if (lines > 2) emit("text-clipped", { message: `The description of ${name(b)} is cut off`, nodeIds: [b.id] });
    }
  }

  // ── Polish ──────────────────────────────────────────────────────────────────
  if (solids.length <= PAIRWISE_LIMIT) {
    const NEAR = 10;
    for (let i = 0; i < solids.length; i += 1) {
      for (let j = i + 1; j < solids.length; j += 1) {
        const a = solids[i]!;
        const b = solids[j]!;
        if (!siblings(a, b) || textual(a) || textual(b) || point(a) || point(b)) continue;
        // A box only reads as "meant to line up" with what is next to it.
        const dx = Math.abs(a.x + a.w / 2 - b.x - b.w / 2);
        const dy = Math.abs(a.y + a.h / 2 - b.y - b.h / 2);
        // Off by a small share of a box still reads as a row someone meant.
        const nearX = Math.max(NEAR, Math.min(a.w, b.w) * 0.12);
        const nearY = Math.max(NEAR, Math.min(a.h, b.h) * 0.3);
        const offX = dx > 0.5 && dx <= nearX && Math.abs(a.x - b.x) > 0.5 && Math.abs(a.x + a.w - b.x - b.w) > 0.5;
        const offY = dy > 0.5 && dy <= nearY && Math.abs(a.y - b.y) > 0.5 && Math.abs(a.y + a.h - b.y - b.h) > 0.5;
        if ((offX && dy < (a.h + b.h) * 2.5) || (offY && dx < (a.w + b.w) * 2)) {
          emit("near-alignment", { message: `${name(a)} and ${name(b)} are nearly lined up`, nodeIds: [a.id, b.id] });
        }
      }
    }
    const bands = (key: "x" | "y", size: "w" | "h", along: "x" | "y", span: "w" | "h") => {
      const groups = new Map<string, SceneBox[]>();
      for (const b of solids) {
        if (textual(b) || point(b)) continue;
        const k = `${b.ancestors[0] ?? ""}|${Math.round((b[key] + b[size] / 2) / 2)}`;
        const g = groups.get(k);
        if (g) g.push(b);
        else groups.set(k, [b]);
      }
      for (const group of groups.values()) {
        if (group.length < 3) continue;
        const sorted = group.sort((a, b) => a[along] - b[along]);
        const gaps: number[] = [];
        for (let i = 1; i < sorted.length; i += 1) {
          gaps.push(sorted[i]![along] - sorted[i - 1]![along] - sorted[i - 1]![span]);
        }
        const lo = Math.min(...gaps);
        const hi = Math.max(...gaps);
        if (lo > 0 && hi / lo > 1.5 && hi - lo > 24) {
          emit("uneven-spacing", {
            message: `${name(sorted[0]!)} and the boxes lined up with it are unevenly spaced`,
            nodeIds: sorted.map((b) => b.id),
          });
        }
      }
    };
    bands("y", "h", "x", "w");
    bands("x", "w", "y", "h");
  }

  // ── Where the lines go ──────────────────────────────────────────────────────
  if (lines.length >= 4) {
    const along = lines.map((l) => ({
      l,
      dx: l.geo.tip.x - l.samples[0]!.x,
      dy: l.geo.tip.y - l.samples[0]!.y,
    }));
    const meanX = along.reduce((sum, a) => sum + a.dx, 0) / along.length;
    const meanY = along.reduce((sum, a) => sum + a.dy, 0) / along.length;
    const magnitude = Math.hypot(meanX, meanY);
    const meanLength = along.reduce((sum, a) => sum + Math.hypot(a.dx, a.dy), 0) / along.length;
    // Only where the picture has a direction at all: a ring or a star has none.
    if (magnitude > meanLength * 0.35) {
      for (const { l, dx, dy } of along) {
        if (l.source.id === l.target.id || (l.edge.direction ?? "forward") !== "forward") continue;
        if ((dx * meanX + dy * meanY) / magnitude < -meanLength * 0.25) {
          emit("against-the-flow", { message: `The line ${describeLine(l)} runs against the flow`, edgeIds: [l.edge.id] });
        }
      }
    }
    const sorted = lines.map((l) => l.length).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    for (const l of lines) {
      if (l.length > Math.max(720, median * 4)) {
        emit("long-line", { message: `The line ${describeLine(l)} is much longer than the rest`, edgeIds: [l.edge.id] });
      }
    }
  }
  for (const l of lines) {
    if (l.source.id === l.target.id) continue;
    const direct = Math.hypot(l.geo.tip.x - l.samples[0]!.x, l.geo.tip.y - l.samples[0]!.y);
    if (l.length > direct * 1.9 && l.length - direct > 120) {
      emit("line-detour", { message: `The line ${describeLine(l)} takes the long way round`, edgeIds: [l.edge.id] });
    }
  }

  for (const l of lines) {
    if (l.source.id === l.target.id || l.edge.points?.length) continue;
    const dx = Math.abs(l.geo.tip.x - l.samples[0]!.x);
    const dy = Math.abs(l.geo.tip.y - l.samples[0]!.y);
    if ((dx > 120 && dy > 1 && dy <= 24) || (dy > 120 && dx > 1 && dx <= 24)) {
      emit("almost-level", { message: `The line ${describeLine(l)} is a few pixels off straight`, edgeIds: [l.edge.id] });
    }
  }
  const borders: Array<{ rect: Rect; name: string; id?: string }> = [
    ...frames.map((f) => ({ rect: f as Rect, name: name(f), id: f.id })),
    ...zones.map((z) => ({ rect: zoneOf(z), name: `zone "${z.label}"` })),
  ];
  for (const l of lines) {
    for (const { rect, name: frameName, id } of borders) {
      if (id === l.source.id || id === l.target.id) continue;
      let along = 0;
      for (let i = 1; i < l.samples.length; i += 1) {
        const p = l.samples[i]!;
        const q = l.samples[i - 1]!;
        const onX = (Math.abs(p.x - rect.x) <= 4 || Math.abs(p.x - rect.x - rect.w) <= 4) && p.y >= rect.y && p.y <= rect.y + rect.h;
        const onY = (Math.abs(p.y - rect.y) <= 4 || Math.abs(p.y - rect.y - rect.h) <= 4) && p.x >= rect.x && p.x <= rect.x + rect.w;
        if (onX || onY) along += Math.hypot(p.x - q.x, p.y - q.y);
      }
      if (along > 50) {
        emit("line-on-border", { message: `The line ${describeLine(l)} runs along the edge of ${frameName}`, edgeIds: [l.edge.id] });
      }
    }
  }

  // ── The shape of each line ──────────────────────────────────────────────────
  for (const l of lines) {
    if (l.source.id === l.target.id) continue;
    for (const atEnd of [false, true]) {
      // Where it arrives from, against the way it was heading before it got
      // close: a line that overshoots its box and comes back arrives against
      // that, where an elbow or a curve into a side arrives along it.
      const reach = Math.min(HOOK_REACH, l.length / 2);
      const approach = headingNear(l.geo, l.length, atEnd, 0, reach);
      const arrival = headingNear(l.geo, l.length, atEnd, 0, 16);
      if (!approach || !arrival || l.length < 60) continue;
      const turn = Math.acos(
        Math.max(-1, Math.min(1, (approach.x * arrival.x + approach.y * arrival.y) / (Math.hypot(approach.x, approach.y) * Math.hypot(arrival.x, arrival.y) || 1))),
      );
      if ((turn * 180) / Math.PI > HOOK_TURN) {
        const box = atEnd ? l.target : l.source;
        emit("line-hook", { message: `The line ${describeLine(l)} doubles back where it meets ${name(box)}`, edgeIds: [l.edge.id] });
        break;
      }
    }
    if (l.edge.points?.length) continue;
    const s = l.samples;
    let level = 0;
    for (let i = 1; i < s.length; i += 1) {
      if (Math.abs(s[i]!.x - s[i - 1]!.x) < 0.5 || Math.abs(s[i]!.y - s[i - 1]!.y) < 0.5) level += 1;
    }
    // Elbows are a router's detour, which `line-detour` measures; this is a curve's swing.
    if (level >= (s.length - 1) / 2) continue;
    const first = s[0]!;
    const last = s[s.length - 1]!;
    const lo = { x: Math.min(first.x, last.x) - 24, y: Math.min(first.y, last.y) - 24 };
    const hi = { x: Math.max(first.x, last.x) + 24, y: Math.max(first.y, last.y) + 24 };
    let bulge = 0;
    for (const p of s) bulge = Math.max(bulge, lo.x - p.x, p.x - hi.x, lo.y - p.y, p.y - hi.y);
    if (bulge > BULGE_MIN) {
      emit("curve-bulge", { message: `The line ${describeLine(l)} swings ${Math.round(bulge)}px out of its way`, edgeIds: [l.edge.id] });
    }
  }

  // ── Where lines meet boxes ──────────────────────────────────────────────────
  const ends = new Map<string, Array<{ at: number; span: number; line: SceneLine; box: SceneBox }>>();
  for (const l of lines) {
    if (l.source.id === l.target.id) continue;
    const direction = l.edge.direction ?? "forward";
    const startSpan = endGlyphSpan(l.edge.startHead ?? (direction === "both" ? "arrow" : undefined), endNotation(l.edge.startLabel, scene.notation).marker);
    const endSpan = endGlyphSpan(l.edge.endHead ?? (direction !== "none" ? "arrow" : undefined), endNotation(l.edge.endLabel, scene.notation).marker);
    for (const [box, p, span] of [[l.source, l.samples[0]!, startSpan], [l.target, l.samples[l.samples.length - 1]!, endSpan]] as const) {
      const sides = [
        { side: "left", gap: Math.abs(p.x - box.x), at: p.y },
        { side: "right", gap: Math.abs(p.x - box.x - box.w), at: p.y },
        { side: "top", gap: Math.abs(p.y - box.y), at: p.x },
        { side: "bottom", gap: Math.abs(p.y - box.y - box.h), at: p.x },
      ].sort((a, b) => a.gap - b.gap);
      const key = `${box.id}|${sides[0]!.side}`;
      const list = ends.get(key) ?? [];
      list.push({ at: sides[0]!.at, span, line: l, box });
      ends.set(key, list);
    }
  }
  for (const list of ends.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.at - b.at);
    const crowded = new Set<SceneLine>();
    for (let i = 1; i < list.length; i += 1) {
      const gap = list[i]!.at - list[i - 1]!.at;
      // Exactly together is a bundle someone asked for. Side by side with their
      // glyphs clear of each other is how ends sharing a side are drawn
      // (`bundleSideEnds`); nearer than that, the glyphs sit on each other.
      if (gap > 0.5 && gap < (list[i]!.span + list[i - 1]!.span) / 2 + CROWDED_SLACK) {
        crowded.add(list[i]!.line);
        crowded.add(list[i - 1]!.line);
      }
    }
    if (crowded.size) {
      emit("crowded-ends", {
        message: `${crowded.size} lines meet ${name(list[0]!.box)} too close together to tell apart`,
        nodeIds: [list[0]!.box.id],
        edgeIds: [...crowded].map((l) => l.edge.id),
      });
    }
  }

  // ── Is the canvas earning its space? ────────────────────────────────────────
  const spread = extentOf(scene);
  if (solids.length >= 4 && spread.w * spread.h > 0) {
    const covered = solids.reduce((sum, b) => sum + b.w * b.h, 0);
    if (covered / (spread.w * spread.h) < 0.07) {
      emit("sparse-canvas", { message: "The boxes cover very little of the canvas they are spread over" });
    }
  }
  if (spread.w > 0 && spread.h > 0) {
    const fit = fitZoom(spread.w, spread.h);
    if (fit < READABLE_ZOOM && lines.length >= DENSE_LINES && lines.length >= solids.length * 1.2) {
      emit("too-dense", {
        message: `${solids.length} boxes and ${lines.length} lines: fitted to a screen this is ${Math.round(fit * 100)}% size`,
      });
    }
  }
}

function describeLine(line: SceneLine): string {
  return `${line.source.node.label || line.source.id} → ${line.target.node.label || line.target.id}`;
}

function extentOf(scene: Scene): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (r: Rect) => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  };
  scene.boxes.forEach(extend);
  scene.zones.forEach((z) => extend(z));
  for (const l of scene.lines) {
    if (l.edge.points?.length) extend(boundsOf(l.samples));
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export interface LintLayoutOptions {
  containerKinds?: readonly string[];
  /**
   * Which canvases to measure: "root" (default), "all" of them, or one card's
   * drilled canvas. A finding names the canvas it was found on.
   */
  frames?: "root" | "all" | { drill: string };
}

/** The drilled canvases a document has, each its own picture. */
function canvasesOf(template: DiagramTemplate, opts: LintLayoutOptions): Array<string | null> {
  const frames = opts.frames ?? "root";
  if (frames === "root") return [null];
  if (frames !== "all") return [frames.drill];
  return [null, ...cardParentIdsOf(template, opts.containerKinds)];
}

/** Measure a document's layout. Pure: the document is not changed. */
export function lintLayout(template: DiagramTemplate, opts: LintLayoutOptions = {}): LayoutReport {
  const findings: LayoutFinding[] = [];
  const counts: Partial<Record<LayoutRuleId, number>> = {};
  const metrics = { boxes: 0, lines: 0, width: 0, height: 0, lineLength: 0, zoom: 1 };
  let softCost = 0;

  // The size reported is the drilled canvas when one was asked for, else the root's.
  const measured = typeof opts.frames === "object" ? opts.frames.drill : null;
  for (const frame of canvasesOf(template, opts)) {
    const scene = buildScene(template, { containerKinds: opts.containerKinds, frame });
    metrics.boxes += scene.boxes.length;
    metrics.lines += scene.lines.length;
    const lineLength = scene.lines.reduce((sum, l) => sum + l.length, 0);
    metrics.lineLength += lineLength;
    if (frame === measured) {
      const spread = extentOf(scene);
      metrics.width = spread.w;
      metrics.height = spread.h;
      metrics.zoom = fitZoom(spread.w, spread.h);
      // How small the words end up on screen, which readers weigh above most
      // else. The cost counts it, so arrangements are chosen by it; the score
      // doesn't, so a long picture is never marked down for being long.
      softCost += -Math.log2(metrics.zoom) * LEGIBILITY_WEIGHT + Math.max(0, READABLE_ZOOM - metrics.zoom) * ILLEGIBLE_WEIGHT;
    }

    // A box can opt out of a rule with the same tag every other check honours.
    const tagged = new Map(scene.boxes.filter((b) => b.node.tags?.length).map((b) => [b.id, b.node.tags!]));
    const ignored = (issue: LintIssue, rule: LayoutRuleId) =>
      !!tagged.size && !!issue.nodeIds?.length && issue.nodeIds.every((id) => tagged.get(id)?.includes(`lint-ignore:${rule}`) ?? false);
    lintScene(scene, (rule, issue) => {
      if (ignored(issue, rule)) return;
      counts[rule] = (counts[rule] ?? 0) + 1;
      findings.push({
        ...issue,
        rule,
        severity: LAYOUT_RULES[rule].severity,
        ...(frame === null ? {} : { frame }),
      });
    });

    // The soft part of the cost: lines should be short and the canvas small,
    // each measured in box sizes so a diagram of big boxes isn't charged for
    // them. Neither knows anything about the picture's proportions.
    if (scene.boxes.length) {
      const unit =
        scene.boxes.reduce((sum, b) => sum + (b.frame ? 0 : (b.w + b.h) / 2), 0) /
          Math.max(1, scene.boxes.filter((b) => !b.frame).length) +
        30;
      const spread = extentOf(scene);
      softCost += (lineLength / unit) * 0.35 + (Math.sqrt(spread.w * spread.h) / unit) * 0.5;
    }
  }

  let penalty = 0;
  let cost = softCost;
  for (const rule of LAYOUT_RULE_IDS) {
    const count = counts[rule] ?? 0;
    if (!count) continue;
    const meta = LAYOUT_RULES[rule];
    // Past a rule's cap, more of the same still counts, a tenth as much, up to
    // a little more again: so 300 problems read worse than 30, but no one rule
    // can sink the score on its own.
    const over = Math.max(0, count * meta.penalty - meta.cap);
    penalty += Math.min(meta.cap, count * meta.penalty) + Math.min(meta.cap * SCORE_OVERFLOW_CAP, over * SCORE_OVERFLOW);
    cost += count * meta.cost;
  }
  const rank: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return {
    score: scoreOf(penalty),
    cost,
    findings,
    counts,
    metrics,
  };
}

/** How much of the penalty past a rule's cap still counts, and the most it can add, as a share of the cap. */
const SCORE_OVERFLOW = 0.1;
const SCORE_OVERFLOW_CAP = 0.4;
/** Below this score the scale bends, so it nears 0 without ever pinning there. */
const SCORE_BEND = 40;

/**
 * 100 less the penalty, down to 40; past that the score keeps falling but
 * ever more slowly, meeting the straight part at the same slope. A picture
 * with 30 problems and one with 300 then read differently, where they used to
 * both say 0.
 */
function scoreOf(penalty: number): number {
  const straight = 100 - penalty;
  if (straight >= SCORE_BEND) return Math.round(straight);
  return Math.round(SCORE_BEND * Math.exp((straight - SCORE_BEND) / SCORE_BEND));
}

const rootReports = new WeakMap<DiagramTemplate, LayoutReport>();
/** One measurement per document, shared by every rule below. */
function rootReport(template: DiagramTemplate): LayoutReport {
  let report = rootReports.get(template);
  if (!report) rootReports.set(template, (report = lintLayout(template)));
  return report;
}

/**
 * The layout rules in the shape the Checks menu takes, for a host that would
 * rather see them there: `registry={{ lintRules: LAYOUT_LINT_RULES }}`. Each
 * measures the root canvas. They are not on by default: a governance check is
 * about what the document says, and a box being a few pixels off doesn't belong
 * in the same list as a database with no owner.
 */
export const LAYOUT_LINT_RULES: Record<string, LintRuleDef> = Object.fromEntries(
  LAYOUT_RULE_IDS.map((rule) => [
    `layout/${rule}`,
    {
      label: LAYOUT_RULES[rule].label,
      description: LAYOUT_RULES[rule].description,
      severity: LAYOUT_RULES[rule].severity,
      check(t: DiagramTemplate): LintIssue[] {
        return rootReport(t).findings.filter((f) => f.rule === rule);
      },
    } satisfies LintRuleDef,
  ]),
);
