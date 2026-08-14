/**
 * geometry.ts — floating-edge routing, shared by the on-screen edge component
 * and the Canvas2D exporter.
 *
 * Edges attach to whichever side of each box faces the other box, rather than
 * to a fixed handle. That keeps routing sensible as nodes are dragged, and —
 * because both the renderer and the exporter call this one function — the PNG
 * and PDF are pixel-identical to what's on screen.
 *
 * An edge can also carry a path spec: pinned start/end anchors (a chosen side
 * of the box, plus a fraction along it) and absolute-canvas waypoints the line
 * must travel through. The spec routers below honour it for both the curved
 * and the orthogonal style; with no spec, routing is byte-identical to what it
 * always was.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Structural twin of the schema's `EdgeAnchor` — geometry stays import-free. */
export interface EdgeAnchorSpec {
  side: "top" | "right" | "bottom" | "left";
  /** Fraction along the side, 0–1. Default 0.5 = the centre. */
  t?: number;
}

/** The stored routing overrides an edge may carry: anchors and waypoints. */
export interface EdgePathSpec {
  start?: EdgeAnchorSpec;
  end?: EdgeAnchorSpec;
  points?: ReadonlyArray<readonly [number, number]>;
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

const clampLabelT = (labelT: number) =>
  Math.min(0.85, Math.max(0.15, Number.isFinite(labelT) ? labelT : 0.5));

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

  return {
    path: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`,
    label: at(clampLabelT(labelT)),
    tip: p2,
    // Tangent at the endpoint: the direction from the last control point.
    angle: Math.atan2(p2.y - c2.y, p2.x - c2.x),
    at,
  };
}

// ─── Shared machinery ────────────────────────────────────────────────────────

type Pt = { x: number; y: number };

/**
 * Arc-length parameterisation over a polyline: uniform t-spacing regardless of
 * segment lengths, which is what lets `nearestTOnCurve` (a pure sampler over
 * `at`) drive label dragging for every geometry unchanged.
 */
function arcLengthAt(points: readonly Pt[]): (t: number) => Pt {
  const lengths: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lengths.push(lengths[i - 1] + seg);
  }
  const total = lengths[lengths.length - 1] || 1;

  return (t: number) => {
    const target = Math.min(1, Math.max(0, t)) * total;
    for (let i = 1; i < points.length; i++) {
      if (target <= lengths[i] || i === points.length - 1) {
        const segLen = lengths[i] - lengths[i - 1] || 1;
        const local = (target - lengths[i - 1]) / segLen;
        return {
          x: points[i - 1].x + (points[i].x - points[i - 1].x) * local,
          y: points[i - 1].y + (points[i].y - points[i - 1].y) * local,
        };
      }
    }
    return points[points.length - 1];
  };
}

const isHorizontal = (side: EdgeAnchorSpec["side"]) => side === "left" || side === "right";

/** The point on a box's `side` at fraction `t` along it. */
function anchorPoint(box: Box, side: EdgeAnchorSpec["side"], t = 0.5): Pt {
  const f = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0.5));
  switch (side) {
    case "top":
      return { x: box.x + box.width * f, y: box.y };
    case "bottom":
      return { x: box.x + box.width * f, y: box.y + box.height };
    case "left":
      return { x: box.x, y: box.y + box.height * f };
    case "right":
      return { x: box.x + box.width, y: box.y + box.height * f };
  }
}

/** Unit vector pointing OUT of the box through `side`. */
function outwardNormal(side: EdgeAnchorSpec["side"]): Pt {
  switch (side) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
  }
}

/**
 * The side an unanchored endpoint leaves through: whichever face of the box
 * looks toward the first thing the path travels to. With waypoints that is
 * the nearest waypoint, NOT the far box — aiming at the far box could put the
 * exit on the wrong side and make the line double back across its own node.
 */
function autoSide(box: Box, toward: Pt): EdgeAnchorSpec["side"] {
  const dx = toward.x - (box.x + box.width / 2);
  const dy = toward.y - (box.y + box.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "bottom" : "top";
}

/** Samples per cubic segment when flattening a spline for arc-length `at`. */
const SPLINE_SAMPLES = 16;

/**
 * A smooth curve through every point: Catmull-Rom tangents at the interior
 * waypoints, perpendicular launch/landing at the boxes — the curve leaves and
 * arrives square to the side it is pinned to, matching the floating router's
 * visual language.
 */
function curvedSpecGeometry(
  p1: Pt,
  startSide: EdgeAnchorSpec["side"],
  waypoints: readonly Pt[],
  p2: Pt,
  endSide: EdgeAnchorSpec["side"],
  labelT: number,
): EdgeGeometry {
  const P: Pt[] = [p1, ...waypoints, p2];
  const n = P.length - 1;

  // Tangents. m[i] is the derivative at P[i]; a cubic segment i uses
  // c1 = P[i] + m[i]/3 and c2 = P[i+1] − m[i+1]/3.
  const m: Pt[] = new Array(P.length);
  for (let i = 1; i < n; i++) {
    m[i] = { x: (P[i + 1].x - P[i - 1].x) / 2, y: (P[i + 1].y - P[i - 1].y) / 2 };
  }
  const launch = (side: EdgeAnchorSpec["side"], from: Pt, to: Pt, sign: 1 | -1): Pt => {
    const off = Math.max(MIN_CONTROL_OFFSET, Math.hypot(to.x - from.x, to.y - from.y) * CONTROL_RATIO);
    const normal = outwardNormal(side);
    return { x: normal.x * off * 3 * sign, y: normal.y * off * 3 * sign };
  };
  m[0] = launch(startSide, P[0], P[1], 1);
  // Arrival travels INTO the box: opposite of the outward normal.
  m[n] = launch(endSide, P[n], P[n - 1], -1);

  const segments: Array<{ a: Pt; c1: Pt; c2: Pt; b: Pt }> = [];
  for (let i = 0; i < n; i++) {
    segments.push({
      a: P[i],
      c1: { x: P[i].x + m[i].x / 3, y: P[i].y + m[i].y / 3 },
      c2: { x: P[i + 1].x - m[i + 1].x / 3, y: P[i + 1].y - m[i + 1].y / 3 },
      b: P[i + 1],
    });
  }

  const path =
    `M ${p1.x} ${p1.y} ` +
    segments.map((s) => `C ${s.c1.x} ${s.c1.y}, ${s.c2.x} ${s.c2.y}, ${s.b.x} ${s.b.y}`).join(" ");

  // Flatten for arc-length evaluation — dense enough for labels and hit tests.
  const flat: Pt[] = [p1];
  for (const s of segments) {
    for (let k = 1; k <= SPLINE_SAMPLES; k++) {
      const t = k / SPLINE_SAMPLES;
      const u = 1 - t;
      flat.push({
        x: u * u * u * s.a.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.b.x,
        y: u * u * u * s.a.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.b.y,
      });
    }
  }
  const at = arcLengthAt(flat);

  const lastSeg = segments[segments.length - 1];
  return {
    path,
    label: at(clampLabelT(labelT)),
    tip: p2,
    angle: Math.atan2(p2.y - lastSeg.c2.y, p2.x - lastSeg.c2.x),
    at,
  };
}

/**
 * A right-angle connector through every waypoint. Between free points the
 * elbow turns horizontal-first when the horizontal distance dominates; at the
 * boxes the first and last segments always run perpendicular to the side the
 * line is pinned to, so it never slides along its own node's face.
 */
function orthogonalSpecGeometry(
  p1: Pt,
  startSide: EdgeAnchorSpec["side"],
  waypoints: readonly Pt[],
  p2: Pt,
  endSide: EdgeAnchorSpec["side"],
  labelT: number,
): EdgeGeometry {
  const pts: Pt[] = [p1];
  const push = (p: Pt) => {
    const last = pts[pts.length - 1];
    if (last.x !== p.x || last.y !== p.y) pts.push(p);
  };

  const targets: Pt[] = [...waypoints, p2];
  for (let i = 0; i < targets.length; i++) {
    const a = pts[pts.length - 1];
    const b = targets[i];
    const first = i === 0;
    const last = i === targets.length - 1;
    if (a.x !== b.x && a.y !== b.y) {
      if (first && last) {
        // Straight from box to box: both perpendicularity rules apply at once.
        if (isHorizontal(startSide) && isHorizontal(endSide)) {
          const midX = (a.x + b.x) / 2;
          push({ x: midX, y: a.y });
          push({ x: midX, y: b.y });
        } else if (!isHorizontal(startSide) && !isHorizontal(endSide)) {
          const midY = (a.y + b.y) / 2;
          push({ x: a.x, y: midY });
          push({ x: b.x, y: midY });
        } else if (isHorizontal(startSide)) {
          push({ x: b.x, y: a.y });
        } else {
          push({ x: a.x, y: b.y });
        }
      } else if (first) {
        // Leave the source square to its side.
        push(isHorizontal(startSide) ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
      } else if (last) {
        // Arrive at the target square to its side.
        push(isHorizontal(endSide) ? { x: a.x, y: b.y } : { x: b.x, y: a.y });
      } else {
        // Free leg: horizontal-first when the horizontal distance dominates.
        push(Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
      }
    }
    push(b);
  }

  const at = arcLengthAt(pts);
  const tail = pts[pts.length - 1];
  const beforeTail = pts.length > 1 ? pts[pts.length - 2] : tail;

  return {
    path: pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" "),
    label: at(clampLabelT(labelT)),
    tip: tail,
    angle: Math.atan2(tail.y - beforeTail.y, tail.x - beforeTail.x),
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

  let points: Pt[];

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

  const at = arcLengthAt(points);
  const last = points[points.length - 1];
  const beforeLast = points[points.length - 2];

  return {
    path: points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" "),
    label: at(clampLabelT(labelT)),
    tip: last,
    angle: Math.atan2(last.y - beforeLast.y, last.x - beforeLast.x),
    at,
  };
}

/**
 * One entry point for both routings, so the on-screen edge and the exporters
 * can never disagree about which router an edge uses. Pass the edge's stored
 * path spec (anchors/waypoints) as the fifth argument; with no spec the
 * output is identical to what this function always produced.
 */
export function edgeGeometryFor(
  routing: "curved" | "orthogonal" | undefined,
  source: Box,
  target: Box,
  labelT = 0.5,
  spec?: EdgePathSpec,
): EdgeGeometry {
  const waypoints: Pt[] = (spec?.points ?? []).map(([x, y]) => ({ x, y }));
  if (!spec?.start && !spec?.end && !waypoints.length) {
    return routing === "orthogonal"
      ? orthogonalEdgeGeometry(source, target, labelT)
      : floatingEdgeGeometry(source, target, labelT);
  }

  const centerOf = (b: Box): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const startSide = spec?.start?.side ?? autoSide(source, waypoints[0] ?? centerOf(target));
  const endSide =
    spec?.end?.side ?? autoSide(target, waypoints[waypoints.length - 1] ?? centerOf(source));
  const p1 = anchorPoint(source, startSide, spec?.start?.t);
  const p2 = anchorPoint(target, endSide, spec?.end?.t);

  return routing === "orthogonal"
    ? orthogonalSpecGeometry(p1, startSide, waypoints, p2, endSide, labelT)
    : curvedSpecGeometry(p1, startSide, waypoints, p2, endSide, labelT);
}

// ─── Crow's-foot cardinality markers ─────────────────────────────────────────

/**
 * The four cardinalities crow's-foot (IE) notation can draw. Derived from an
 * edge's end label rather than stored separately: the cardinality IS the
 * marker, and a second field would let the symbol and the text disagree.
 */
export type CardinalityMarker = "one" | "zero-one" | "one-many" | "zero-many";

/**
 * Read an end label as a cardinality, or nothing.
 *
 * Deliberately strict: only text that genuinely reads as a cardinality earns a
 * symbol. An end label saying "owns" is role text and keeps the plain line it
 * has always had — a lenient parser would draw "exactly one" on every labelled
 * architecture edge in every existing document.
 */
export function cardinalityMarker(text: string | undefined): CardinalityMarker | undefined {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return undefined;
  const many = /\*|\+|\bn\b|\bmany\b/.test(t);
  const zero = /^0|\?|\bzero\b|\boptional\b/.test(t);
  const one = /^1|\bone\b/.test(t);
  if (many) return zero ? "zero-many" : one ? "one-many" : "zero-many";
  if (zero) return "zero-one";
  if (one) return "one";
  return undefined;
}

/** Distance from the box to the crow's foot's apex. */
const FOOT_LEN = 12;
/** Half-width of the foot where it meets the box. */
const FOOT_SPREAD = 6;
/** Half-length of a "one" tick. */
const TICK_HALF = 6;
/** Radius of the "zero" ring. */
const RING_R = 4;

/**
 * One stroked path for a cardinality marker at `point`, where `angleIntoBox`
 * is the direction of travel INTO that box (`geo.angle` at the target,
 * `startAngle(geo)` at the source).
 *
 * Returned as a single `d` string of subpaths so both renderers draw it the
 * same way with one stroke: the canvas as an SVG `<path>`, the exporters as a
 * `path` draw command. Nothing here is filled — a filled ring would read as a
 * dot, which in this notation means the opposite of what it says.
 */
export function crowsFootPath(
  marker: CardinalityMarker,
  point: { x: number; y: number },
  angleIntoBox: number,
): string {
  // Away from the box, back along the line; `n` is perpendicular to that.
  const dx = -Math.cos(angleIntoBox);
  const dy = -Math.sin(angleIntoBox);
  const nx = -dy;
  const ny = dx;
  const at = (along: number, across = 0) =>
    `${point.x + dx * along + nx * across} ${point.y + dy * along + ny * across}`;

  const parts: string[] = [];
  const many = marker === "one-many" || marker === "zero-many";
  if (many) {
    // Three prongs converging away from the entity, splayed against it.
    parts.push(`M ${at(FOOT_LEN)} L ${at(0, FOOT_SPREAD)}`);
    parts.push(`M ${at(FOOT_LEN)} L ${at(0, -FOOT_SPREAD)}`);
    parts.push(`M ${at(FOOT_LEN)} L ${at(0)}`);
  }
  const tick = many ? 17 : 11;
  if (marker === "one" || marker === "one-many" || marker === "zero-one") {
    parts.push(`M ${at(tick, TICK_HALF)} L ${at(tick, -TICK_HALF)}`);
  }
  // "Exactly one" is two bars — the second is what distinguishes it from the
  // mandatory half of "one or more".
  if (marker === "one") {
    parts.push(`M ${at(tick + 5, TICK_HALF)} L ${at(tick + 5, -TICK_HALF)}`);
  }
  if (marker === "zero-one" || marker === "zero-many") {
    const c = many ? 23 : 17;
    parts.push(
      `M ${at(c - RING_R)} A ${RING_R} ${RING_R} 0 1 0 ${at(c + RING_R)} ` +
        `A ${RING_R} ${RING_R} 0 1 0 ${at(c - RING_R)}`,
    );
  }
  return parts.join(" ");
}

/**
 * How far in from each box an end label (cardinality) sits. Shared by the
 * on-screen edge and the export emitter so the two place it identically — and
 * pushed clear of a marker when one is drawn, since the symbol occupies the
 * span the text would otherwise sit in.
 */
export const END_LABEL_INSET = 24;

export const endLabelInset = (marker: CardinalityMarker | undefined) => (marker ? 38 : END_LABEL_INSET);

/**
 * Approximate path length, by flattening `at`. Every geometry here is
 * arc-length parameterised, so this is all that's needed to convert a distance
 * in pixels into a `t`.
 */
export function approxLength(geo: EdgeGeometry, samples = 24): number {
  let total = 0;
  let prev = geo.at(0);
  for (let i = 1; i <= samples; i++) {
    const next = geo.at(i / samples);
    total += Math.hypot(next.x - prev.x, next.y - prev.y);
    prev = next;
  }
  return total;
}

/**
 * The `t` a fixed distance in from one end — where an end label (cardinality)
 * sits, so it stays the same distance from its box whether the edge is 60px or
 * 600px long. Clamped to the middle third at worst, so the two ends of a very
 * short edge cannot swap places or collide with the centre label.
 */
export function tAtDistance(geo: EdgeGeometry, distance: number, fromEnd = false): number {
  const length = approxLength(geo);
  const fraction = length > 0 ? Math.min(0.33, distance / length) : 0.15;
  return fromEnd ? 1 - fraction : fraction;
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
