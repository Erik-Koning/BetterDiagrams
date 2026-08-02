/**
 * geometry.ts — floating-edge routing, shared by the on-screen edge component
 * and the Canvas2D exporter.
 *
 * Edges attach to whichever side of each box faces the other box, rather than
 * to a fixed handle. That keeps routing sensible as nodes are dragged, and —
 * because both the renderer and the exporter call this one function — the PNG
 * and PDF are pixel-identical to what's on screen.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EdgeGeometry {
  /** SVG path `d` string, also usable via `new Path2D(d)` on canvas. */
  path: string;
  /** Point on the curve at `labelT`, where the label is drawn. */
  label: { x: number; y: number };
  /** Where the arrowhead sits (the target attachment point). */
  tip: { x: number; y: number };
  /** Arrowhead rotation in radians. */
  angle: number;
  /** Evaluate the curve at any t in [0,1] — used for label drag hit-testing. */
  at(t: number): { x: number; y: number };
}

const MIN_CONTROL_OFFSET = 40;
const CONTROL_RATIO = 0.35;

/**
 * Route a curve between two boxes.
 *
 * `labelT` is clamped to [0.15, 0.85] so a label never sits underneath the
 * node it is attached to.
 */
export function floatingEdgeGeometry(source: Box, target: Box, labelT = 0.5): EdgeGeometry {
  const scx = source.x + source.width / 2;
  const scy = source.y + source.height / 2;
  const tcx = target.x + target.width / 2;
  const tcy = target.y + target.height / 2;

  const dx = tcx - scx;
  const dy = tcy - scy;

  let p1: { x: number; y: number };
  let p2: { x: number; y: number };
  let c1: { x: number; y: number };
  let c2: { x: number; y: number };

  if (Math.abs(dx) >= Math.abs(dy)) {
    // Predominantly horizontal: leave/enter through the left or right edge.
    p1 = { x: dx > 0 ? source.x + source.width : source.x, y: scy };
    p2 = { x: dx > 0 ? target.x : target.x + target.width, y: tcy };
    const off = Math.max(MIN_CONTROL_OFFSET, Math.abs(dx) * CONTROL_RATIO);
    c1 = { x: p1.x + (dx > 0 ? off : -off), y: p1.y };
    c2 = { x: p2.x + (dx > 0 ? -off : off), y: p2.y };
  } else {
    // Predominantly vertical: leave/enter through the top or bottom edge.
    p1 = { x: scx, y: dy > 0 ? source.y + source.height : source.y };
    p2 = { x: tcx, y: dy > 0 ? target.y : target.y + target.height };
    const off = Math.max(MIN_CONTROL_OFFSET, Math.abs(dy) * CONTROL_RATIO);
    c1 = { x: p1.x, y: p1.y + (dy > 0 ? off : -off) };
    c2 = { x: p2.x, y: p2.y + (dy > 0 ? -off : off) };
  }

  const at = (t: number) => {
    const u = 1 - t;
    return {
      x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
      y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
    };
  };

  const t = Math.min(0.85, Math.max(0.15, Number.isFinite(labelT) ? labelT : 0.5));

  return {
    path: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`,
    label: at(t),
    tip: p2,
    // Tangent at the endpoint: the direction from the last control point.
    angle: Math.atan2(p2.y - c2.y, p2.x - c2.x),
    at,
  };
}

/**
 * Route a right-angle (Manhattan) connector between two boxes.
 *
 * Exit sides are chosen by the dominant axis, exactly like the curved router,
 * so switching an edge between routings never flips which side it attaches
 * to. The path is 2–3 segments with the elbow at the midpoint. `at(t)` is
 * parameterised by ARC LENGTH along the polyline — uniform t-spacing, which is
 * what lets `nearestTOnCurve` (a pure sampler over `at`) drive label dragging
 * for this geometry unchanged.
 */
export function orthogonalEdgeGeometry(source: Box, target: Box, labelT = 0.5): EdgeGeometry {
  const scx = source.x + source.width / 2;
  const scy = source.y + source.height / 2;
  const tcx = target.x + target.width / 2;
  const tcy = target.y + target.height / 2;

  const dx = tcx - scx;
  const dy = tcy - scy;

  let points: Array<{ x: number; y: number }>;

  if (Math.abs(dx) >= Math.abs(dy)) {
    // Horizontal-dominant: out the left/right side, elbow at mid-x.
    const p1 = { x: dx > 0 ? source.x + source.width : source.x, y: scy };
    const p2 = { x: dx > 0 ? target.x : target.x + target.width, y: tcy };
    const midX = (p1.x + p2.x) / 2;
    points =
      p1.y === p2.y
        ? [p1, p2]
        : [p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2];
  } else {
    // Vertical-dominant: out the top/bottom side, elbow at mid-y.
    const p1 = { x: scx, y: dy > 0 ? source.y + source.height : source.y };
    const p2 = { x: tcx, y: dy > 0 ? target.y : target.y + target.height };
    const midY = (p1.y + p2.y) / 2;
    points =
      p1.x === p2.x
        ? [p1, p2]
        : [p1, { x: p1.x, y: midY }, { x: p2.x, y: midY }, p2];
  }

  // Cumulative segment lengths, for arc-length parameterisation.
  const lengths: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lengths.push(lengths[i - 1] + seg);
  }
  const total = lengths[lengths.length - 1] || 1;

  const at = (t: number) => {
    const target_ = Math.min(1, Math.max(0, t)) * total;
    for (let i = 1; i < points.length; i++) {
      if (target_ <= lengths[i] || i === points.length - 1) {
        const segLen = lengths[i] - lengths[i - 1] || 1;
        const local = (target_ - lengths[i - 1]) / segLen;
        return {
          x: points[i - 1].x + (points[i].x - points[i - 1].x) * local,
          y: points[i - 1].y + (points[i].y - points[i - 1].y) * local,
        };
      }
    }
    return points[points.length - 1];
  };

  const last = points[points.length - 1];
  const beforeLast = points[points.length - 2];
  const t = Math.min(0.85, Math.max(0.15, Number.isFinite(labelT) ? labelT : 0.5));

  return {
    path: points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" "),
    label: at(t),
    tip: last,
    angle: Math.atan2(last.y - beforeLast.y, last.x - beforeLast.x),
    at,
  };
}

/**
 * One entry point for both routings, so the on-screen edge and the exporters
 * can never disagree about which router an edge uses.
 */
export function edgeGeometryFor(
  routing: "curved" | "orthogonal" | undefined,
  source: Box,
  target: Box,
  labelT = 0.5,
): EdgeGeometry {
  return routing === "orthogonal"
    ? orthogonalEdgeGeometry(source, target, labelT)
    : floatingEdgeGeometry(source, target, labelT);
}

/**
 * Direction of travel at the source attachment, for a start arrowhead
 * (`direction: "both"`). Works for any geometry — it only samples `at`.
 */
export function startAngle(geo: EdgeGeometry): number {
  const a = geo.at(0);
  const b = geo.at(0.04);
  // Reversed: the start arrowhead points AWAY from the path, back into source.
  return Math.atan2(a.y - b.y, a.x - b.x);
}

/**
 * Find the t along the curve nearest a point — used when dragging an edge
 * label. Coarse sampling then a local refinement; plenty accurate for a
 * pointer and far cheaper than solving the cubic.
 */
export function nearestTOnCurve(
  geo: EdgeGeometry,
  point: { x: number; y: number },
  samples = 24,
): number {
  let bestT = 0.5;
  let bestDist = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = 0.15 + (0.7 * i) / samples;
    const q = geo.at(t);
    const d = (q.x - point.x) ** 2 + (q.y - point.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestT = t;
    }
  }
  // Refine within one sample step for a smoother drag.
  const step = 0.7 / samples;
  for (let i = -4; i <= 4; i++) {
    const t = Math.min(0.85, Math.max(0.15, bestT + (step * i) / 4));
    const q = geo.at(t);
    const d = (q.x - point.x) ** 2 + (q.y - point.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestT = t;
    }
  }
  return bestT;
}
