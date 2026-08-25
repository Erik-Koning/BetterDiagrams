/**
 * zones.ts — infrastructure zones.
 *
 * A zone is a shaped background region tagged to an infra provider. It is
 * deliberately NOT a container: nodes reference a zone by `zoneId`, they are
 * not parented to it. That keeps two orthogonal axes usable at once — a node
 * can sit in the "Azure West US" zone *and* the "Payments" group.
 *
 * Each zone lists the providers it can be switched between. Switching changes
 * the zone's colour and, crucially, which nodes inside it are visible: a node
 * whose `providers` list excludes the active provider disappears. That is what
 * makes one diagram show three different deployment topologies.
 *
 * Geometry is normalised: polygon points are 0..1 within the zone's bounding
 * box, so resizing a zone preserves its silhouette.
 */

export const ZONE_SHAPES = ["rect", "rounded", "ellipse", "hexagon", "polygon"] as const;
export type ZoneShape = (typeof ZONE_SHAPES)[number];

/**
 * A box-shaped zone's corner radius, in px.
 *
 * Shared because the zone's HEADER chip has to trace the same arc where it
 * overlaps that corner — on the canvas and in every export. Two independent
 * numbers would drift, and the drift is visible: two curves crossing at the
 * one corner a reader's eye lands on first.
 */
export function zoneCornerRadius(shape: ZoneShape): number {
  return shape === "rounded" ? 18 : 2;
}

/** How a zone's outline draws. `solid` is the default and is never stored. */
export const ZONE_OUTLINES = ["solid", "dashed", "dotted", "none"] as const;
export type ZoneOutline = (typeof ZONE_OUTLINES)[number];

/** A normalised vertex, 0..1 within the zone's bounding box. */
export type ZonePoint = [number, number];

export interface DiagramZone {
  id: string;
  label: string;
  shape: ZoneShape;
  /** Normalised outline; only meaningful when shape === "polygon". */
  points?: ZonePoint[];
  x: number;
  y: number;
  w: number;
  h: number;
  /** Provider ids this zone can be switched between. Never empty after validation. */
  providers: string[];
  /** The active provider id. Always a member of `providers` after validation. */
  provider: string;
  /**
   * Ink override: the OUTLINE colour, canonical lowercase `#rrggbb`. Absent
   * means "the provider's colour". This is deliberately the vivid colour —
   * the human-visible one — and the background fill is DERIVED from it as a
   * duller tint (`opacity` at composite time), so picking one colour styles
   * the whole region coherently in both themes.
   */
  color?: string;
  /** Outline style. Absent = solid. `none` hides the outline entirely. */
  outline?: ZoneOutline;
  /** Background fill on/off. Absent = filled; stored only when `false`. */
  fill?: boolean;
  /** Fill opacity 0..1. Defaults to 0.14 — a tint, not a block of colour. */
  opacity?: number;
  /** Stacking order among zones; higher draws on top. An island beats its host. */
  z?: number;
  /** Pinned in place — the editor refuses to drag or resize it. */
  locked?: boolean;
  /**
   * When this region comes into existence, `YYYY-MM-DD`. Drives the timeline
   * scrubber like any other element's date — but a zone's date does NOT
   * cascade to the nodes on it: `zoneId` is membership, not containment, so a
   * region arriving later says nothing about when its members do.
   */
  date?: string;
}

// Known keys, for editors that warn about keys the schema doesn't define.
// See TEMPLATE_KEYS in schema.ts for how the Record enforces the list.
const ZONE_KEY_MAP: Record<keyof DiagramZone, true> = {
  id: true,
  label: true,
  shape: true,
  points: true,
  x: true,
  y: true,
  w: true,
  h: true,
  providers: true,
  provider: true,
  color: true,
  outline: true,
  fill: true,
  opacity: true,
  z: true,
  locked: true,
  date: true,
};
export const ZONE_KEYS: readonly string[] = Object.keys(ZONE_KEY_MAP);

/** Regular hexagon inscribed in the bounding box, flat-top. */
export const HEXAGON_POINTS: ZonePoint[] = [
  [0.25, 0],
  [0.75, 0],
  [1, 0.5],
  [0.75, 1],
  [0.25, 1],
  [0, 0.5],
];

/** Default outline for a fresh polygon zone — a house shape, obviously editable. */
export const DEFAULT_POLYGON_POINTS: ZonePoint[] = [
  [0, 0.25],
  [0.5, 0],
  [1, 0.25],
  [1, 1],
  [0, 1],
];

/**
 * The outline a shape resolves to, in normalised coordinates.
 * `rect`/`rounded` return null — those render as a plain box with CSS, which
 * keeps their borders crisp and their corner radius uniform.
 */
export function zoneOutline(zone: Pick<DiagramZone, "shape" | "points">): ZonePoint[] | null {
  switch (zone.shape) {
    case "hexagon":
      return HEXAGON_POINTS;
    case "polygon":
      return zone.points && zone.points.length >= 3 ? zone.points : DEFAULT_POLYGON_POINTS;
    default:
      return null;
  }
}

/** SVG `points` attribute for a normalised outline, scaled to a 100x100 viewBox. */
/**
 * The header chip's outer corner — the zone's own, so the two curves lie on
 * top of each other where the chip sits on the boundary. An ellipse or a
 * polygon has no rectangular corner there to trace, so the chip keeps its own
 * curve. One function because the canvas and the exporters both ask.
 */
export function zoneChipRadius(zone: Pick<DiagramZone, "shape" | "points">): number {
  return zoneOutline(zone) || zone.shape === "ellipse" ? 10 : zoneCornerRadius(zone.shape);
}

export function outlineToSvgPoints(points: ZonePoint[]): string {
  return points.map(([x, y]) => `${x * 100},${y * 100}`).join(" ");
}

/**
 * Is an absolute canvas point inside this zone?
 *
 * Shape-aware, which is what makes overlapping zones behave: dropping a node
 * into the notch of an L-shaped region should not put it in that region.
 */
export function pointInZone(zone: DiagramZone, px: number, py: number): boolean {
  if (zone.w <= 0 || zone.h <= 0) return false;
  const nx = (px - zone.x) / zone.w;
  const ny = (py - zone.y) / zone.h;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return false;

  if (zone.shape === "ellipse") {
    const dx = (nx - 0.5) / 0.5;
    const dy = (ny - 0.5) / 0.5;
    return dx * dx + dy * dy <= 1;
  }

  const outline = zoneOutline(zone);
  if (!outline) return true; // rect / rounded — the bounding box is the shape
  return pointInPolygon(outline, nx, ny);
}

/** Ray casting against a normalised polygon. */
function pointInPolygon(points: ZonePoint[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Area of the bounding box — used to break ties when zones overlap. */
export function zoneArea(zone: DiagramZone): number {
  return Math.max(0, zone.w) * Math.max(0, zone.h);
}

/**
 * Pick the zone a point belongs to when several overlap.
 *
 * Highest `z` wins, then smallest area — so a small island drawn on top of a
 * diagram-wide region claims the nodes sitting inside it.
 */
export function zoneAt(zones: readonly DiagramZone[], px: number, py: number): DiagramZone | null {
  let best: DiagramZone | null = null;
  for (const zone of zones) {
    if (!pointInZone(zone, px, py)) continue;
    if (!best) {
      best = zone;
      continue;
    }
    const bz = best.z ?? 0;
    const zz = zone.z ?? 0;
    if (zz > bz || (zz === bz && zoneArea(zone) < zoneArea(best))) best = zone;
  }
  return best;
}

/**
 * Nudge a box so it sits inside a zone's bounding box.
 *
 * Used when the document declares a `zoneId` the geometry contradicts — an LLM
 * routinely emits the right membership with coordinates that miss the box.
 * Trusting the declaration and fixing the position preserves intent; the
 * reverse would silently drop the membership the author asked for.
 *
 * `headroom` keeps the node clear of the zone's header chip.
 */
export function clampBoxIntoZone(
  box: { x: number; y: number; w: number; h: number },
  zone: DiagramZone,
  headroom = 30,
): { x: number; y: number } {
  const padX = 12;
  // A node bigger than its zone can't be contained; pin it to the top-left
  // rather than producing a negative range and NaN.
  const maxX = Math.max(zone.x + padX, zone.x + zone.w - box.w - padX);
  const maxY = Math.max(zone.y + headroom, zone.y + zone.h - box.h - padX);
  return {
    x: Math.min(Math.max(box.x, zone.x + padX), maxX),
    y: Math.min(Math.max(box.y, zone.y + headroom), maxY),
  };
}

/**
 * Grow a zone's box to contain out-of-range polygon points.
 *
 * Vertices are stored normalised 0..1 within the box, so a vertex dragged
 * past an edge lands outside that range. This computes the enlarged absolute
 * box that contains every vertex and remaps all points back into 0..1 within
 * it — the shape the user drew stays exactly where they drew it, the box
 * stretches to hold it. Returns null when everything already fits.
 */
export function containZonePoints(
  box: { x: number; y: number; w: number; h: number },
  points: ZonePoint[],
): { x: number; y: number; w: number; h: number; points: ZonePoint[] } | null {
  let minX = 0;
  let minY = 0;
  let maxX = 1;
  let maxY = 1;
  for (const [px, py] of points) {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  if (minX === 0 && minY === 0 && maxX === 1 && maxY === 1) return null;
  // The span always includes the original 0..1 box, so it is never zero.
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  return {
    x: box.x + minX * box.w,
    y: box.y + minY * box.h,
    w: box.w * spanX,
    h: box.h * spanY,
    points: points.map(([px, py]): ZonePoint => [(px - minX) / spanX, (py - minY) / spanY]),
  };
}
