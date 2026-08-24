/**
 * draw.ts — the export renderer as ONE emitter and two thin backends.
 *
 * Previously the canvas and SVG exporters were hand-kept mirrors: every visual
 * change had to be made twice, and they drifted (three different seq-badge
 * offset formulas at one point). Now a single `emitTemplate` walks the diagram
 * once and produces draw commands; `drawToCanvas` and `drawToSvg` translate
 * them mechanically. A backend cannot drift from the other because neither
 * contains any layout or styling decisions.
 *
 * Text measurement is deliberately APPROXIMATE (fixed per-font width factors)
 * so the emitter needs no canvas context — identical wrapping everywhere
 * matters more than typographically exact wrapping somewhere.
 *
 * The emitter takes an `ExportPalette`, which is what makes light-mode exports
 * a parameter instead of a second renderer.
 */
import {
  absolutePosition,
  depthOf,
  hiddenByCollapse,
  templateBounds,
  visibleAnchor,
  visibleElements,
  COLLAPSED_SIZE,
  DEFAULT_CONTAINER_OPACITY,
  DEFAULT_ZONE_OPACITY,
  EDGE_COLOR_HEX,
  EDGE_DASH,
  FIELD_ROW_H,
  fieldAnchors,
  fieldListTop,
  resolveRouting,
  type DiagramEdge,
  type DiagramNode,
  type DiagramTemplate,
} from "../contract/schema";
import { zoneOutline, type DiagramZone } from "../contract/zones";
import { dateToDay, effectiveNodeDates, formatDiagramDate, isOverdue, laterDate } from "../contract/timeline";
import {
  cardinalityMarker,
  crowsFootPath,
  edgeGeometryFor,
  edgeHeadPath,
  endLabelInset,
  startAngle,
  tAtDistance,
  type Box,
} from "../contract/geometry";
import { seqBadgeOffset, silhouettePath, teamColor } from "./shapes";
import { kindDef, iconPaths, providerDef, zoneInk, type ResolvedRegistry } from "./registry-types";

export const PAD = 48;
export const GRID = 24;

// ─── Palette ─────────────────────────────────────────────────────────────────

export interface ExportPalette {
  /** Page background. */
  bg: string;
  /** Node/chip body base. */
  surface: string;
  /** Chip/label surfaces one step off the base. */
  surface2: string;
  /** Primary text. */
  text: string;
  /** Secondary text. */
  textDim: string;
  /** Tertiary text (counts, eyebrows). */
  textFaint: string;
  /** Hairlines. */
  border: string;
  /** Grid dots. */
  gridDot: string;
  /** Ink on accent-coloured chips (the seq badge number). */
  accentInk: string;
  /** Deprecated status text (salmon family). */
  warn?: string;
  /** Past-due date chips on not-yet-active elements (amber family). */
  overdue?: string;
  /**
   * Per-edge-colour overrides. An object, or a JSON string of one —
   * `paletteFromTheme` has to squeeze through a string map, so the emitters
   * accept either.
   */
  edgeColors?: Record<string, string> | string;
  /** Per-participant-kind accents for the sequence emitter. Same encoding. */
  seqAccents?: Record<string, string> | string;
}

/** Normalize the record-or-JSON palette fields. */
export function paletteRecord(
  value: Record<string, string> | string | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export const DARK_EXPORT_PALETTE: ExportPalette = {
  bg: "#0f172a",
  surface: "#0b1220",
  surface2: "#1e293b",
  text: "#e2e8f0",
  textDim: "#94a3b8",
  textFaint: "#64748b",
  border: "#334155",
  gridDot: "#1e293b",
  accentInk: "#04121f",
  warn: "#fa8072",
  overdue: "#f59e0b",
};

export const LIGHT_EXPORT_PALETTE: ExportPalette = {
  bg: "#f8fafc",
  surface: "#ffffff",
  surface2: "#f1f5f9",
  text: "#0f172a",
  textDim: "#475569",
  textFaint: "#94a3b8",
  border: "#e2e8f0",
  gridDot: "#e2e8f0",
  accentInk: "#ffffff",
  warn: "#e0674f",
  overdue: "#d97706",
  edgeColors: { slate: "#475569", sky: "#0284c7", emerald: "#059669", amber: "#d97706", rose: "#e11d48", violet: "#7c3aed" },
  seqAccents: { actor: "#64748b", service: "#0284c7", database: "#d97706", queue: "#7c3aed", external: "#475569" },
};

// ─── Command set ─────────────────────────────────────────────────────────────

/**
 * Which document element a command belongs to, and when that element lands
 * (as an epoch day — see `dateToDay`). Stamped by the emitters; the canvas
 * backend ignores it, the SVG backend groups consecutive same-tag commands in
 * a `<g data-el data-day>` so the interactive HTML export can scrub elements
 * in and out client-side without re-rendering anything.
 */
export interface DrawTag {
  id: string;
  day?: number;
}

export type DrawCmd = RawDrawCmd & { tag?: DrawTag };

type RawDrawCmd =
  | {
      op: "path";
      d: string;
      fill?: string;
      fillAlpha?: number;
      stroke?: string;
      strokeAlpha?: number;
      strokeWidth?: number;
      dash?: number[];
      /** Round caps/joins — icon strokes want them. */
      round?: boolean;
      /** Applied before drawing: translate then uniform scale. */
      transform?: { tx: number; ty: number; scale: number };
    }
  | {
      op: "poly";
      /** SVG-style points string in local space. */
      points: string;
      fill: string;
      tx: number;
      ty: number;
      rotateDeg: number;
    }
  | { op: "circle"; cx: number; cy: number; r: number; fill: string; stroke?: string; strokeWidth?: number }
  | {
      op: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      font: "mono" | "sans";
      color: string;
      alpha?: number;
      weight?: number;
      anchor?: "start" | "middle" | "end";
      /** Knock a bg-coloured rect out behind the text (edge labels over lines). */
      knockout?: { color: string; padX: number; height: number };
    }
  | { op: "grid"; x: number; y: number; w: number; h: number; step: number; color: string };

// ─── Shared approximate text metrics ─────────────────────────────────────────

// These live in the contract because `validateTemplate` grows a wrapped node's
// height with the same measurement the renderer lays it out with. Re-exported
// here so the drawing code keeps reading as one module.
import { approxTextWidth, ellipsise, wrapText, wrappedLineCount } from "../contract/text";

export { approxTextWidth, ellipsise, wrapText, wrappedLineCount };

// ─── Small path builders ─────────────────────────────────────────────────────

export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rad = Math.min(r, w / 2, h / 2);
  return (
    `M ${x + rad} ${y} H ${x + w - rad} A ${rad} ${rad} 0 0 1 ${x + w} ${y + rad} ` +
    `V ${y + h - rad} A ${rad} ${rad} 0 0 1 ${x + w - rad} ${y + h} ` +
    `H ${x + rad} A ${rad} ${rad} 0 0 1 ${x} ${y + h - rad} ` +
    `V ${y + rad} A ${rad} ${rad} 0 0 1 ${x + rad} ${y} Z`
  );
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
}

// ─── Layout pass (visibility + collapse, shared with nothing else) ───────────

interface Placed {
  node: DiagramNode;
  box: Box;
  depth: number;
}

interface Layout {
  placed: Placed[];
  byId: Map<string, Placed>;
  zones: DiagramZone[];
  edges: DiagramEdge[];
  legend: Array<{ provider: string; count: number }>;
}

function layout(template: DiagramTemplate, containerKinds?: readonly string[]): Layout {
  const visible = visibleElements(template);
  const collapseHidden = hiddenByCollapse(template, { containerKinds });
  const nodeById = new Map(template.nodes.map((n) => [n.id, n]));

  const placed = template.nodes
    .filter((n) => visible.nodes.has(n.id) && !collapseHidden.has(n.id))
    .map((node) => {
      const { x, y } = absolutePosition(node, nodeById);
      const width = node.collapsed ? COLLAPSED_SIZE.w : node.w;
      const height = node.collapsed ? COLLAPSED_SIZE.h : node.h;
      return { node, box: { x, y, width, height }, depth: depthOf(node, nodeById) };
    });
  placed.sort((a, b) => a.depth - b.depth);
  const placedIds = new Set(placed.map((p) => p.node.id));

  const zones = [...(template.zones ?? [])].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const counts = new Map<string, number>();
  for (const zone of zones) counts.set(zone.provider, (counts.get(zone.provider) ?? 0) + 1);

  // Same collapse re-routing as toReactFlow: edges into hidden contents attach
  // to the chip; parallels converge to one; internal wiring disappears.
  const rerouteSeen = new Set<string>();
  const edges = template.edges
    .filter((e) => visible.edges.has(e.id))
    .flatMap((e) => {
      const source = visibleAnchor(e.source, nodeById, collapseHidden);
      const target = visibleAnchor(e.target, nodeById, collapseHidden);
      if (!placedIds.has(source) || !placedIds.has(target) || source === target) return [];
      const rerouted = source !== e.source || target !== e.target;
      if (rerouted) {
        const key = `${source}→${target}`;
        if (rerouteSeen.has(key)) return [];
        rerouteSeen.add(key);
        // Anchors/waypoints describe the ORIGINAL endpoints' boxes — the
        // canvas drops them on re-route (toReactFlow), so exports must too.
        return [
          {
            ...e,
            source,
            target,
            label: "",
            tech: undefined,
            seq: undefined,
            start: undefined,
            end: undefined,
            points: undefined,
          },
        ];
      }
      return [e];
    });

  return {
    placed,
    byId: new Map(placed.map((p) => [p.node.id, p])),
    zones,
    edges,
    legend: [...counts.entries()].map(([provider, count]) => ({ provider, count })),
  };
}

const defaultRoutingOf = (template: DiagramTemplate) => resolveRouting(template.meta?.routing);

function zoneOutlineAbs(zone: DiagramZone): Array<[number, number]> | null {
  const outline = zoneOutline(zone);
  if (!outline) return null;
  return outline.map(([nx, ny]): [number, number] => [zone.x + nx * zone.w, zone.y + ny * zone.h]);
}

// ─── The emitter ─────────────────────────────────────────────────────────────

export interface Emitted {
  cmds: DrawCmd[];
  /** Content bounds including padding — the image size. */
  width: number;
  height: number;
  /** Translate content by this to land at the padded origin. */
  originX: number;
  originY: number;
}

export function emitTemplate(
  template: DiagramTemplate,
  registry: ResolvedRegistry,
  paletteOverride: Partial<ExportPalette> = {},
): Emitted {
  const palette: ExportPalette = { ...DARK_EXPORT_PALETTE, ...paletteOverride };
  // Fixed-hex palettes re-resolve per theme: a light export darkens the edge
  // colours the same way the canvas's CSS variables do.
  const edgeHex = { ...EDGE_COLOR_HEX, ...paletteRecord(palette.edgeColors) };
  const { placed, byId, zones, edges, legend } = layout(template, registry.containerKinds);
  const b = templateBounds(template, { onlyVisible: true, containerKinds: registry.containerKinds });
  const width = Math.max(1, b.maxX - b.minX + PAD * 2);
  const height = Math.max(1, b.maxY - b.minY + PAD * 2);
  const cmds: DrawCmd[] = [];

  // Effective landing days, for tagging: nodes after the containment cascade,
  // edges never earlier than either endpoint — the same rules the editor's
  // scrubber applies, resolved here so a viewer only ever compares numbers.
  const nodeDates = effectiveNodeDates(template);
  const dayOf = (date?: string) => (date ? dateToDay(date) : undefined);
  /** Stamp everything pushed since `start` as belonging to one element. */
  const stamp = (start: number, id: string, day?: number) => {
    for (let i = start; i < cmds.length; i++) cmds[i].tag ??= { id, ...(day !== undefined ? { day } : {}) };
  };

  // Background + dot grid.
  cmds.push({
    op: "path",
    d: `M ${b.minX - PAD} ${b.minY - PAD} h ${width} v ${height} h ${-width} Z`,
    fill: palette.bg,
  });
  cmds.push({
    op: "grid",
    x: Math.floor((b.minX - PAD) / GRID) * GRID,
    y: Math.floor((b.minY - PAD) / GRID) * GRID,
    w: width + GRID,
    h: height + GRID,
    step: GRID,
    color: palette.gridDot,
  });

  // Zones, back to front. The ink (override or provider colour) mirrors what
  // the canvas paints — see zoneInk; the fill is the same colour tinted.
  for (const zone of zones) {
    const zoneStart = cmds.length;
    const def = providerDef(registry, zone.provider);
    const ink = zoneInk(registry, zone);
    const alpha = zone.opacity ?? DEFAULT_ZONE_OPACITY;
    const outlined = zone.outline !== "none";
    const filled = zone.fill !== false;
    const polygon = zoneOutlineAbs(zone);
    const d =
      zone.shape === "ellipse"
        ? ellipsePath(zone.x + zone.w / 2, zone.y + zone.h / 2, zone.w / 2, zone.h / 2)
        : polygon
          ? `M ${polygon.map(([px, py]) => `${px} ${py}`).join(" L ")} Z`
          : roundedRectPath(zone.x, zone.y, zone.w, zone.h, zone.shape === "rounded" ? 18 : 2);
    // No outline AND no fill leaves nothing to draw — skip rather than emit a
    // no-op path that would pollute the HTML player's tagged groups.
    if (outlined || filled) {
      cmds.push({
        op: "path",
        d,
        ...(filled ? { fill: ink, fillAlpha: alpha } : {}),
        ...(outlined
          ? {
              stroke: ink,
              strokeAlpha: 0.75,
              strokeWidth: 1.5,
              // Same dash tables the canvas CSS uses, so the outline in a PNG
              // is the outline on screen.
              ...(zone.outline === "dashed" || zone.outline === "dotted"
                ? { dash: EDGE_DASH[zone.outline] }
                : {}),
            }
          : {}),
      });
    }

    // The date rides inside the zone's own header chip rather than beside it,
    // so the chip's width formula stays the single source of its size. The
    // label keeps the PROVIDER's name — a recoloured zone is still hosted
    // where it is hosted.
    const label = `${zone.label}  ·  ${def.label}${
      zone.date ? `  ·  ${formatDiagramDate(zone.date)}` : ""
    }`;
    const chipW = approxTextWidth(label, 11, "mono") + 26;
    cmds.push({
      op: "path",
      d: roundedRectPath(zone.x, zone.y, chipW, 22, 6),
      fill: ink,
      fillAlpha: 0.22,
      stroke: ink,
      strokeAlpha: 0.55,
      strokeWidth: 1,
    });
    cmds.push({ op: "path", d: roundedRectPath(zone.x + 8, zone.y + 8, 7, 7, 1.5), fill: ink });
    cmds.push({ op: "text", x: zone.x + 21, y: zone.y + 15, text: label, size: 11, font: "mono", weight: 600, color: palette.text });
    stamp(zoneStart, `zone:${zone.id}`, dayOf(zone.date));
  }

  // Date chip — the same outlined grey chip the editor renders (.as-date), so
  // "this lands in June" survives into the shared artefact rather than being
  // an editor-only affordance.
  const dateChipW = (date: string) => approxTextWidth(formatDiagramDate(date), 9, "mono") + 12;
  const pushDateChip = (date: string, x: number, y: number, overdue = false) => {
    const text = formatDiagramDate(date);
    // Overdue — past date, element still pre-active — is the chip's one loud
    // moment: amber border and text, same as the editor.
    const ink = overdue ? (palette.overdue ?? "#f59e0b") : palette.textDim;
    const d = roundedRectPath(x, y, approxTextWidth(text, 9, "mono") + 12, 15, 4);
    cmds.push({ op: "path", d, fill: palette.surface, fillAlpha: 0.7 });
    cmds.push({ op: "path", d, stroke: ink, strokeAlpha: overdue ? 0.65 : 0.4, strokeWidth: 1 });
    cmds.push({ op: "text", x: x + 6, y: y + 11, text, size: 9, font: "mono", weight: 500, color: ink });
  };

  // Owning-team tag — the same pill the editor renders (see .as-node__team),
  // so ownership survives into the shared artefact.
  const teamPillW = (team: string) => approxTextWidth(team, 9, "mono") + 14;
  const pushTeamPill = (team: string, x: number, y: number) => {
    const c = teamColor(team);
    const d = roundedRectPath(x, y, teamPillW(team), 16, 8);
    cmds.push({ op: "path", d, fill: palette.surface });
    cmds.push({ op: "path", d, fill: c, fillAlpha: 0.14, stroke: c, strokeAlpha: 0.55, strokeWidth: 1 });
    cmds.push({ op: "text", x: x + 7, y: y + 11.5, text: team, size: 9, font: "mono", weight: 600, color: c });
  };

  // Expanded container boundaries. Collapsed chips paint later, with the
  // leaves — they are solid cards, and edges travel under cards, not over.
  for (const { node, box } of placed) {
    const def = kindDef(registry, node.kind);
    if (!def.container || node.collapsed) continue;
    const nodeStart = cmds.length;
    // Frame styling, resolved exactly as GroupNode resolves it for the canvas
    // — the ink is the stored colour (or the kind accent), the fill is derived
    // from it, and `fill: false` / `outline: "none"` each drop their layer. A
    // frame with neither is invisible in the export too, which is the point:
    // an abstract grouping box must not reappear in the PNG.
    const frameInk = node.color || def.accent;
    const frameTinted = !!node.color || node.opacity !== undefined;
    const frameOutline = node.outline ?? "dashed";
    const frameDash =
      frameOutline === "dashed" ? [6, 5] : frameOutline === "dotted" ? [2, 4] : undefined;
    cmds.push({
      op: "path",
      d: roundedRectPath(box.x, box.y, box.width, box.height, 10),
      // The default tint is the neutral surface wash groups have always used;
      // an ink-derived tint appears only once the node stores a colour.
      ...(node.fill === false
        ? {}
        : {
            fill: frameTinted ? frameInk : palette.surface2,
            fillAlpha: node.opacity ?? DEFAULT_CONTAINER_OPACITY,
          }),
      ...(frameOutline === "none"
        ? {}
        : { stroke: frameInk, strokeWidth: 1.2, ...(frameDash ? { dash: frameDash } : {}) }),
    });
    const chipW = Math.max(60, approxTextWidth(node.label, 11, "mono") + 18);
    cmds.push({ op: "path", d: roundedRectPath(box.x, box.y, chipW, 22, 6), fill: palette.surface2 });
    cmds.push({ op: "text", x: box.x + 9, y: box.y + 15, text: node.label, size: 11, font: "mono", color: palette.textDim });
    // Beside the boundary's name chip, in the same order the editor's group
    // label renders them: date first, then the owning team.
    let cursor = box.x + chipW + 6;
    if (node.date) {
      pushDateChip(node.date, cursor, box.y + 4, isOverdue(node.date, node.status));
      cursor += dateChipW(node.date) + 6;
    }
    if (node.team) pushTeamPill(node.team, cursor, box.y + 3);
    stamp(nodeStart, `node:${node.id}`, dayOf(nodeDates.get(node.id)));
  }

  // Edges.
  const defaultRouting = defaultRoutingOf(template);
  for (const edge of edges) {
    const edgeStart = cmds.length;
    const s = byId.get(edge.source);
    const t = byId.get(edge.target);
    if (!s || !t) continue;
    // Field references resolve to row anchors here exactly as they do on the
    // canvas — same function, so a foreign-key line lands on the same column
    // in the PNG as it does on screen.
    const anchorNode = ({ node, box }: Placed) => ({
      fields: node.fields,
      description: node.description,
      h: box.height,
      centerX: box.x + box.width / 2,
    });
    const geo = edgeGeometryFor(edge.routing ?? defaultRouting, s.box, t.box, edge.labelT ?? 0.5, {
      ...fieldAnchors(edge, anchorNode(s), anchorNode(t)),
      points: edge.points,
    });
    const color = edgeHex[edge.color] ?? edgeHex.slate;
    const direction = edge.direction ?? "forward";

    cmds.push({ op: "path", d: geo.path, stroke: color, strokeWidth: 1.8, dash: EDGE_DASH[edge.style] });
    // An end stating its cardinality draws the crow's-foot symbol instead of
    // an end glyph — the same rule the canvas applies, from the same parser.
    // Otherwise, the same glyph resolution as the canvas: `direction` decides
    // which ends carry one by default, startHead/endHead choose which.
    const startMarker = cardinalityMarker(edge.startLabel);
    const endMarker = cardinalityMarker(edge.endLabel);
    const endHead = edge.endHead ?? (direction !== "none" ? "arrow" : undefined);
    const startHead = edge.startHead ?? (direction === "both" ? "arrow" : undefined);
    if (endHead && !endMarker) {
      const glyph = edgeHeadPath(endHead, geo.tip, geo.angle);
      cmds.push(
        glyph.filled
          ? { op: "path", d: glyph.d, fill: color }
          : { op: "path", d: glyph.d, stroke: color, strokeWidth: 1.8, round: true },
      );
    }
    if (startHead && !startMarker) {
      const glyph = edgeHeadPath(startHead, geo.at(0), startAngle(geo));
      cmds.push(
        glyph.filled
          ? { op: "path", d: glyph.d, fill: color }
          : { op: "path", d: glyph.d, stroke: color, strokeWidth: 1.8, round: true },
      );
    }
    if (endMarker) {
      cmds.push({ op: "path", d: crowsFootPath(endMarker, geo.tip, geo.angle), stroke: color, strokeWidth: 1.8, round: true });
    }
    if (startMarker) {
      cmds.push({ op: "path", d: crowsFootPath(startMarker, geo.at(0), startAngle(geo)), stroke: color, strokeWidth: 1.8, round: true });
    }

    if (edge.seq) {
      const cx = geo.label.x - seqBadgeOffset(edge.label);
      cmds.push({ op: "circle", cx, cy: geo.label.y - 9, r: 8, fill: color, stroke: palette.bg, strokeWidth: 1.5 });
      cmds.push({ op: "text", x: cx, y: geo.label.y - 5.6, text: String(edge.seq), size: 9, font: "mono", weight: 700, color: palette.accentInk, anchor: "middle" });
    }
    if (edge.label) {
      cmds.push({
        op: "text",
        x: geo.label.x + (edge.seq ? 6 : 0),
        y: geo.label.y - 4,
        text: edge.label,
        size: 11,
        font: "mono",
        color: palette.textDim,
        anchor: "middle",
        knockout: { color: palette.bg, padX: 4, height: 15 },
      });
    }
    if (edge.tech) {
      cmds.push({
        op: "text",
        x: geo.label.x,
        y: geo.label.y + (edge.label ? 8 : -4),
        text: `[${edge.tech}]`,
        size: 9,
        font: "mono",
        color: palette.textDim,
        alpha: 0.8,
        anchor: "middle",
        knockout: { color: palette.bg, padX: 3, height: 11 },
      });
    }
    // Cardinality, a fixed distance in from each box — near the end it
    // describes rather than wherever the middle label sits.
    for (const [text, fromEnd, marker] of [
      [edge.startLabel, false, startMarker],
      [edge.endLabel, true, endMarker],
    ] as const) {
      if (!text) continue;
      const at = geo.at(tAtDistance(geo, endLabelInset(marker), fromEnd));
      cmds.push({
        op: "text",
        x: at.x,
        y: at.y - 4,
        text,
        size: 10,
        font: "mono",
        weight: 600,
        color: palette.text,
        anchor: "middle",
        knockout: { color: palette.bg, padX: 3, height: 13 },
      });
    }
    if (edge.date) {
      cmds.push({
        op: "text",
        x: geo.label.x,
        y: geo.label.y + (edge.label ? 8 : -4) + (edge.tech ? 11 : 0),
        text: formatDiagramDate(edge.date),
        size: 9,
        font: "mono",
        color: palette.textDim,
        alpha: 0.7,
        anchor: "middle",
        knockout: { color: palette.bg, padX: 3, height: 11 },
      });
    }
    stamp(
      edgeStart,
      `edge:${edge.id}`,
      dayOf(laterDate(edge.date, laterDate(nodeDates.get(edge.source), nodeDates.get(edge.target)))),
    );
  }

  // Leaves, annotations, and collapsed-container chips — everything edges
  // must pass under.
  for (const { node, box } of placed) {
    const def = kindDef(registry, node.kind);
    if (def.container && !node.collapsed) continue;
    const leafStart = cmds.length;

    // A dangling-arrow endpoint: just the dot the canvas shows (.as-point__dot
    // — 7px, dim, on a bg ring), never a card. Its box still routed the edge.
    if (def.point) {
      cmds.push({
        op: "circle",
        cx: box.x + box.width / 2,
        cy: box.y + box.height / 2,
        r: 3.5,
        fill: palette.textDim,
        stroke: palette.bg,
        strokeWidth: 1,
      });
      stamp(leafStart, `node:${node.id}`, dayOf(nodeDates.get(node.id)));
      continue;
    }

    if (def.container) {
      const d = roundedRectPath(box.x, box.y, box.width, box.height, 9);
      cmds.push({ op: "path", d, fill: palette.surface });
      cmds.push({ op: "path", d, fill: def.accent, fillAlpha: 0.1, stroke: def.accent, strokeAlpha: 0.45, strokeWidth: 1 });
      cmds.push({
        op: "text",
        x: box.x + 10,
        y: box.y + box.height / 2 + 4,
        text: ellipsise(`▸ ${node.label}`, 11, "mono", box.width - 18),
        size: 11,
        font: "mono",
        weight: 600,
        color: palette.text,
      });
      if (node.date) pushDateChip(node.date, box.x + box.width - dateChipW(node.date) - 8, box.y + (box.height - 15) / 2, isOverdue(node.date, node.status));
      if (node.team) {
        const shift = node.date ? dateChipW(node.date) + 6 : 0;
        pushTeamPill(node.team, box.x + box.width - teamPillW(node.team) - 8 - shift, box.y + (box.height - 16) / 2);
      }
      stamp(leafStart, `node:${node.id}`, dayOf(nodeDates.get(node.id)));
      continue;
    }

    if (def.annotation) {
      const size = node.fontSize || 13;
      // Notes are boxed unless they opt out — matching `.as-annotation--boxed`.
      const boxed = !node.plain;
      const pad = boxed ? 9 : 4;
      if (boxed) {
        cmds.push({
          op: "path",
          d: roundedRectPath(box.x, box.y, box.width, box.height, 8),
          fill: palette.surface,
          fillAlpha: 0.78,
          stroke: palette.border,
          strokeWidth: 1,
        });
      }
      const lines = wrapText(node.label, size, "sans", box.width - pad * 2, Math.max(1, Math.floor(box.height / (size + 5))));
      lines.forEach((line, i) =>
        cmds.push({ op: "text", x: box.x + pad, y: box.y + (boxed ? 6 : 0) + size + i * (size + 5), text: line, size, font: "sans", color: palette.text }),
      );
      if (node.date) {
        // Under the last line of the note, clamped inside the box so a long
        // annotation can't push the chip past its own outline.
        const below = box.y + (boxed ? 6 : 0) + lines.length * (size + 5) + 2;
        pushDateChip(node.date, box.x + pad, Math.min(below, box.y + box.height - 17));
      }
      stamp(leafStart, `node:${node.id}`, dayOf(nodeDates.get(node.id)));
      continue;
    }

    // Lifecycle status: outline style for not-built-yet, dimming for on-the-
    // way-out — the same conventions the editor's CSS applies. `stubbed` gets
    // the heavy construction dash; `dark` gets a hazard-tape ring on top.
    const status = node.status;
    const statusDash =
      status === "proposed"
        ? [2, 3]
        : status === "planned"
          ? [6, 5]
          : status === "stubbed"
            ? [10, 4]
            : undefined;
    const dim =
      status === "deprecated"
        ? 0.55
        : status === "retired"
          ? 0.4
          : status === "dark"
            ? 0.65
            : status === "stubbed"
              ? 0.85
              : 1;

    const sil = silhouettePath(def.shape ?? "card", box.x + 0.75, box.y + 0.75, box.width - 1.5, box.height - 1.5);
    cmds.push({ op: "path", d: sil.body, fill: palette.surface });
    cmds.push({
      op: "path",
      d: sil.body,
      fill: def.accent,
      fillAlpha: 0.06 * dim,
      stroke: def.accent,
      strokeAlpha: 0.4 * dim,
      strokeWidth: 1.2,
      ...(statusDash ? { dash: statusDash } : {}),
    });
    if (sil.detail) cmds.push({ op: "path", d: sil.detail, stroke: def.accent, strokeAlpha: 0.35 * dim, strokeWidth: 1.2 });
    if (status === "dark") {
      // Black/white hazard tape: a black underlay with white dashes over it,
      // matching the editor's two-layer border. Undimmed on purpose — the
      // warning IS the point, whatever the body fades to.
      cmds.push({ op: "path", d: sil.body, stroke: "#020617", strokeWidth: 2.5 });
      cmds.push({ op: "path", d: sil.body, stroke: "#f8fafc", strokeWidth: 1.8, dash: [6, 6] });
    }

    const cTop = sil.contentTop;
    const icon = iconPaths(registry, node.icon);
    const textX = box.x + sil.contentInlinePad + (icon ? 50 : 14);
    const contentMidY = box.y + cTop + (box.height - cTop) / 2;
    if (icon) {
      cmds.push({
        op: "path",
        d: roundedRectPath(box.x + sil.contentInlinePad + 12, contentMidY - 14, 28, 28, 7),
        fill: def.accent,
        fillAlpha: 0.13,
      });
      for (const d of icon) {
        cmds.push({
          op: "path",
          d,
          stroke: def.accent,
          strokeWidth: 1.8,
          round: true,
          transform: { tx: box.x + sil.contentInlinePad + 17.5, ty: contentMidY - 8.5, scale: 17 / 24 },
        });
      }
    }

    const textW = box.width - (textX - box.x) - 10;
    const kindText = def.label.toUpperCase();
    const statusText = status ? ` · ${status.toUpperCase()}` : "";

    // Text layout — mirrors the CSS classes ShapeNode applies, so an export
    // reproduces what the user arranged rather than a second interpretation.
    // `anchorX` is where a run of text is placed FROM; the anchor tells the
    // backend which end of the run that x refers to.
    const fontSize = node.fontSize ?? 13;
    const align = node.textAlign ?? "left";
    const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
    const anchorX = align === "center" ? textX + textW / 2 : align === "right" ? textX + textW : textX;
    const aligned = anchor === "start" ? {} : ({ anchor } as const);

    // A wrapped title takes as many lines as it needs; validateTemplate has
    // already grown the box to hold them, using this same measurement.
    const titleLines = node.wrap
      ? wrapText(node.label, fontSize, "sans", textW, Number.MAX_SAFE_INTEGER)
      : [ellipsise(node.label, fontSize, "sans", textW)];
    const lineH = Math.round(fontSize * 1.35);
    // What the extra lines push down: description, strike-through, everything
    // after the title.
    const titleOverflow = Math.max(0, titleLines.length - 1) * lineH;

    const rows = node.fields ?? [];
    // A node with rows holds its description to ONE line: the rows below are
    // placed by a shared formula, and a second line would shift every one of
    // them out from under its edge anchor.
    const descLines = node.description
      ? wrapText(node.description, 10.5, "sans", textW, rows.length ? 1 : node.wrap ? 4 : 2)
      : [];

    // Vertical placement moves the whole text block inside the box. Record
    // nodes are excluded: their rows sit at offsets a field-anchored edge also
    // computes, so shifting them would leave every foreign-key line pointing
    // between columns. (The canvas agrees — .as-node--record pins to the top.)
    const blockH = 45 + titleOverflow + descLines.length * 13;
    const slack = Math.max(0, box.height - cTop - blockH);
    const vShift = rows.length
      ? 0
      : node.textVAlign === "top"
        ? -slack / 2
        : node.textVAlign === "bottom"
          ? slack / 2
          : 0;
    const ty = (offset: number) => box.y + cTop + offset + vShift;

    if (status === "deprecated") {
      // The status token gets the editor's salmon; the node's own dimming
      // still applies through the shared alpha, exactly as opacity does on
      // the canvas. Centred/right-aligned nodes draw the eyebrow as one run so
      // the two halves can't drift apart under a non-start anchor.
      const eyebrowX = align === "left" ? textX : anchorX;
      cmds.push({ op: "text", x: eyebrowX, y: ty(16), text: kindText, size: 9, font: "mono", color: def.accent, alpha: 0.8 * dim, ...aligned });
      if (align === "left") {
        cmds.push({
          op: "text",
          x: textX + approxTextWidth(kindText, 9, "mono"),
          y: ty(16),
          text: statusText,
          size: 9,
          font: "mono",
          color: palette.warn ?? "#fa8072",
          alpha: 0.8 * dim,
        });
      }
    } else {
      cmds.push({ op: "text", x: anchorX, y: ty(16), text: kindText + statusText, size: 9, font: "mono", color: def.accent, alpha: 0.8 * dim, ...aligned });
    }
    titleLines.forEach((line, i) =>
      cmds.push({ op: "text", x: anchorX, y: ty(31 + i * lineH), text: line, size: fontSize, font: "sans", weight: 600, color: palette.text, ...aligned, ...(dim < 1 ? { alpha: dim } : {}) }),
    );
    if (status === "retired") {
      const strikeW = approxTextWidth(titleLines[0] ?? "", fontSize, "sans");
      const strikeX = align === "center" ? anchorX - strikeW / 2 : align === "right" ? anchorX - strikeW : textX;
      cmds.push({ op: "path", d: `M ${strikeX} ${ty(26.5)} L ${strikeX + strikeW} ${ty(26.5)}`, stroke: palette.text, strokeAlpha: dim, strokeWidth: 1 });
    }
    descLines.forEach((line, i) =>
      cmds.push({ op: "text", x: anchorX, y: ty(45 + titleOverflow + i * 13), text: line, size: 10.5, font: "sans", color: palette.textDim, ...aligned, ...(dim < 1 ? { alpha: dim } : {}) }),
    );

    // Field rows — the same list the canvas draws, from the same metrics.
    const listTop = box.y + fieldListTop(!!node.description);
    if (rows.length) {
      const rightEdge = box.x + box.width - 10;
      cmds.push({
        op: "path",
        d: `M ${textX} ${listTop - 4} L ${rightEdge} ${listTop - 4}`,
        stroke: palette.border,
        strokeWidth: 1,
        strokeAlpha: dim,
      });
      rows.forEach((field, i) => {
        const rowTop = listTop + i * FIELD_ROW_H;
        let nameX = textX;
        if (field.key) {
          const badge = field.key.toUpperCase();
          const badgeW = Math.max(20, approxTextWidth(badge, 8, "mono") + 6);
          const d = roundedRectPath(textX, rowTop + 3.5, badgeW, 12, 3);
          // A primary key identifies the record and carries the tint; a
          // foreign key only points elsewhere, so it stays an outline —
          // matching .as-node__fieldkey--pk in the stylesheet.
          if (field.key !== "fk") {
            cmds.push({ op: "path", d, fill: def.accent, fillAlpha: 0.18 * dim });
          }
          cmds.push({ op: "path", d, stroke: def.accent, strokeAlpha: 0.45 * dim, strokeWidth: 1 });
          cmds.push({
            op: "text",
            x: textX + (badgeW - approxTextWidth(badge, 8, "mono")) / 2,
            y: rowTop + 12.5,
            text: badge,
            size: 8,
            font: "mono",
            weight: 700,
            color: def.accent,
            ...(dim < 1 ? { alpha: dim } : {}),
          });
          nameX = textX + badgeW + 6;
        }
        // The type takes the right edge; the name gets whatever is left, so a
        // long column name ellipsises rather than running under its own type.
        const typeText = field.type ?? "";
        const typeW = typeText ? approxTextWidth(typeText, 9.5, "mono") : 0;
        const nameW = rightEdge - nameX - (typeW ? typeW + 8 : 0);
        cmds.push({
          op: "text",
          x: nameX,
          y: rowTop + 13,
          text: ellipsise(`${field.name}${field.required ? "*" : ""}`, 10.5, "mono", nameW),
          size: 10.5,
          font: "mono",
          color: palette.text,
          ...(dim < 1 ? { alpha: dim } : {}),
        });
        if (typeText) {
          cmds.push({
            op: "text",
            x: rightEdge - typeW,
            y: rowTop + 13,
            text: typeText,
            size: 9.5,
            font: "mono",
            color: palette.textFaint,
            ...(dim < 1 ? { alpha: dim } : {}),
          });
        }
      });
    }

    if (node.date) {
      // Stacked under whatever text the node ended up with, then clamped
      // inside the box — a two-line description on a default-height node
      // leaves no room, and the chip must not escape the silhouette.
      const below = rows.length
        ? listTop + rows.length * FIELD_ROW_H + 2
        : box.y + cTop + 36 + descLines.length * 13;
      pushDateChip(node.date, textX, Math.min(below, box.y + box.height - 19), isOverdue(node.date, node.status));
    }
    // Bottom-right, riding the edge — mirrors the editor's placement.
    if (node.team) pushTeamPill(node.team, box.x + box.width - teamPillW(node.team) - 6, box.y + box.height - 8);
    stamp(leafStart, `node:${node.id}`, dayOf(nodeDates.get(node.id)));
  }

  // Legend.
  if (legend.length) {
    const rowH = 18;
    const boxW = 150;
    const boxH = 14 + legend.length * rowH + 8;
    const lx = b.maxX + PAD - boxW - 8;
    const ly = b.minY - PAD + 8;
    cmds.push({ op: "path", d: roundedRectPath(lx, ly, boxW, boxH, 8), fill: palette.surface, fillAlpha: 0.92, stroke: palette.border, strokeWidth: 1 });
    cmds.push({ op: "text", x: lx + 10, y: ly + 16, text: "INFRASTRUCTURE", size: 9, font: "mono", weight: 600, color: palette.textDim });
    legend.forEach(({ provider, count }, i) => {
      const def = providerDef(registry, provider);
      const y = ly + 26 + i * rowH;
      cmds.push({ op: "path", d: roundedRectPath(lx + 10, y + 2, 11, 11, 3), fill: def.color, fillAlpha: 0.3, stroke: def.color, strokeAlpha: 0.7, strokeWidth: 1 });
      cmds.push({ op: "text", x: lx + 28, y: y + 12, text: def.label, size: 11, font: "sans", color: palette.text });
      if (count > 1) {
        cmds.push({ op: "text", x: lx + boxW - 16, y: y + 12, text: String(count), size: 10, font: "mono", color: palette.textFaint });
      }
    });
  }

  // Title block.
  if (template.meta?.title) {
    cmds.push({ op: "text", x: b.minX - PAD + 10, y: b.minY - PAD + 24, text: String(template.meta.title), size: 15, font: "sans", weight: 700, color: palette.text });
    cmds.push({
      op: "text",
      x: b.minX - PAD + 10,
      y: b.minY - PAD + 40,
      text: `${placed.length} elements · ${edges.length} connections`,
      size: 10,
      font: "mono",
      color: palette.textFaint,
    });
  }

  // Version tag notice — pinned in its corner, same as the editor's chip.
  if (template.meta?.versionTag) {
    const tag = String(template.meta.versionTag);
    const pos = template.meta.versionTagPosition ?? "top-left";
    const pillW = approxTextWidth(tag, 10, "mono") + 20;
    const px = pos.endsWith("left") ? b.minX - PAD + 10 : b.maxX + PAD - pillW - 10;
    // Top-left is also the title block's corner; sit below it when both show.
    const titleOffset = pos === "top-left" && template.meta?.title ? 40 : 0;
    const py = pos.startsWith("top") ? b.minY - PAD + 10 + titleOffset : b.maxY + PAD - 30;
    cmds.push({ op: "path", d: roundedRectPath(px, py, pillW, 20, 10), fill: palette.surface, fillAlpha: 0.92, stroke: palette.border, strokeWidth: 1 });
    cmds.push({ op: "text", x: px + 10, y: py + 14, text: tag, size: 10, font: "mono", weight: 600, color: palette.textDim });
  }

  return { cmds, width, height, originX: -b.minX + PAD, originY: -b.minY + PAD };
}

// ─── Backends ────────────────────────────────────────────────────────────────

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
const fontOf = (font: "mono" | "sans") => (font === "mono" ? MONO : SANS);

/** `#rrggbb` + alpha → `rgba()`, for canvas. */
function rgba(hex: string, alpha: number | undefined): string {
  if (alpha === undefined || alpha >= 1) return hex;
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => Number.parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function drawToCanvas(ctx: CanvasRenderingContext2D, cmds: DrawCmd[]): void {
  for (const cmd of cmds) {
    switch (cmd.op) {
      case "grid": {
        ctx.fillStyle = cmd.color;
        for (let gx = cmd.x; gx < cmd.x + cmd.w; gx += cmd.step) {
          for (let gy = cmd.y; gy < cmd.y + cmd.h; gy += cmd.step) {
            ctx.fillRect(gx, gy, 1.2, 1.2);
          }
        }
        break;
      }
      case "path": {
        ctx.save();
        if (cmd.transform) {
          ctx.translate(cmd.transform.tx, cmd.transform.ty);
          ctx.scale(cmd.transform.scale, cmd.transform.scale);
        }
        const path = new Path2D(cmd.d);
        if (cmd.fill) {
          ctx.fillStyle = rgba(cmd.fill, cmd.fillAlpha);
          ctx.fill(path);
        }
        if (cmd.stroke) {
          ctx.strokeStyle = rgba(cmd.stroke, cmd.strokeAlpha);
          ctx.lineWidth = cmd.strokeWidth ?? 1;
          if (cmd.round) {
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
          }
          ctx.setLineDash(cmd.dash ?? []);
          ctx.stroke(path);
        }
        ctx.restore();
        break;
      }
      case "poly": {
        ctx.save();
        ctx.fillStyle = cmd.fill;
        ctx.translate(cmd.tx, cmd.ty);
        ctx.rotate((cmd.rotateDeg * Math.PI) / 180);
        ctx.beginPath();
        const pts = cmd.points.split(" ").map((p) => p.split(",").map(Number));
        pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        break;
      }
      case "circle": {
        ctx.save();
        ctx.fillStyle = cmd.fill;
        ctx.beginPath();
        ctx.arc(cmd.cx, cmd.cy, cmd.r, 0, Math.PI * 2);
        ctx.fill();
        if (cmd.stroke) {
          ctx.strokeStyle = cmd.stroke;
          ctx.lineWidth = cmd.strokeWidth ?? 1;
          ctx.stroke();
        }
        ctx.restore();
        break;
      }
      case "text": {
        ctx.save();
        ctx.font = `${cmd.weight ?? 400} ${cmd.size}px ${fontOf(cmd.font)}`;
        ctx.textAlign = cmd.anchor === "middle" ? "center" : cmd.anchor === "end" ? "right" : "left";
        if (cmd.knockout) {
          const w = approxTextWidth(cmd.text, cmd.size, cmd.font) + cmd.knockout.padX * 2;
          const left =
            cmd.anchor === "middle"
              ? cmd.x - w / 2
              : cmd.anchor === "end"
                ? cmd.x - w + cmd.knockout.padX
                : cmd.x - cmd.knockout.padX;
          ctx.fillStyle = cmd.knockout.color;
          ctx.fillRect(left, cmd.y - cmd.knockout.height + 4, w, cmd.knockout.height);
        }
        ctx.fillStyle = rgba(cmd.color, cmd.alpha);
        ctx.fillText(cmd.text, cmd.x, cmd.y);
        ctx.restore();
        break;
      }
    }
  }
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function drawToSvg(cmds: DrawCmd[], opts: { gridId?: string } = {}): string {
  // Several SVGs inlined into ONE page (the multi-view HTML export) must not
  // share a <pattern> id — the browser resolves url(#…) document-wide.
  const gridId = opts.gridId ?? "as-grid";
  const out: string[] = [];
  // Consecutive commands stamped with one tag render inside one group, so a
  // whole element can be shown, dimmed, or hidden by touching a single <g>.
  // The emitters push each element's commands contiguously, which is what
  // makes run-length grouping sufficient.
  let openTag: string | null = null;
  const keyOf = (tag?: DrawTag) => (tag ? `${tag.id}\u0000${tag.day ?? ""}` : null);
  for (const cmd of cmds) {
    const key = keyOf(cmd.tag);
    if (key !== openTag) {
      if (openTag !== null) out.push("</g>");
      if (key !== null) {
        const tag = cmd.tag!;
        out.push(
          `<g class="bd-el" data-el="${esc(tag.id)}"${tag.day !== undefined ? ` data-day="${tag.day}"` : ""}>`,
        );
      }
      openTag = key;
    }
    switch (cmd.op) {
      case "grid": {
        // A pattern keeps the SVG small where canvas just loops.
        out.push(
          `<defs><pattern id="${gridId}" width="${cmd.step}" height="${cmd.step}" patternUnits="userSpaceOnUse" x="${cmd.x}" y="${cmd.y}"><rect width="1.2" height="1.2" fill="${cmd.color}"/></pattern></defs>`,
          `<rect x="${cmd.x}" y="${cmd.y}" width="${cmd.w}" height="${cmd.h}" fill="url(#${gridId})"/>`,
        );
        break;
      }
      case "path": {
        const attrs = [
          cmd.fill ? `fill="${cmd.fill}"` : `fill="none"`,
          cmd.fillAlpha !== undefined ? `fill-opacity="${cmd.fillAlpha}"` : "",
          cmd.stroke ? `stroke="${cmd.stroke}"` : "",
          cmd.strokeAlpha !== undefined ? `stroke-opacity="${cmd.strokeAlpha}"` : "",
          cmd.strokeWidth ? `stroke-width="${cmd.strokeWidth}"` : "",
          cmd.dash?.length ? `stroke-dasharray="${cmd.dash.join(" ")}"` : "",
          cmd.round ? `stroke-linecap="round" stroke-linejoin="round"` : "",
        ]
          .filter(Boolean)
          .join(" ");
        const el = `<path d="${cmd.d}" ${attrs}/>`;
        out.push(
          cmd.transform
            ? `<g transform="translate(${cmd.transform.tx} ${cmd.transform.ty}) scale(${cmd.transform.scale})">${el}</g>`
            : el,
        );
        break;
      }
      case "poly": {
        out.push(
          `<polygon points="${cmd.points}" fill="${cmd.fill}" transform="translate(${cmd.tx} ${cmd.ty}) rotate(${cmd.rotateDeg})"/>`,
        );
        break;
      }
      case "circle": {
        out.push(
          `<circle cx="${cmd.cx}" cy="${cmd.cy}" r="${cmd.r}" fill="${cmd.fill}"${cmd.stroke ? ` stroke="${cmd.stroke}" stroke-width="${cmd.strokeWidth ?? 1}"` : ""}/>`,
        );
        break;
      }
      case "text": {
        if (cmd.knockout) {
          const w = approxTextWidth(cmd.text, cmd.size, cmd.font) + cmd.knockout.padX * 2;
          const left =
            cmd.anchor === "middle"
              ? cmd.x - w / 2
              : cmd.anchor === "end"
                ? cmd.x - w + cmd.knockout.padX
                : cmd.x - cmd.knockout.padX;
          out.push(
            `<rect x="${left}" y="${cmd.y - cmd.knockout.height + 4}" width="${w}" height="${cmd.knockout.height}" fill="${cmd.knockout.color}"/>`,
          );
        }
        const attrs = [
          `font-size="${cmd.size}"`,
          `font-family="${fontOf(cmd.font)}"`,
          cmd.weight ? `font-weight="${cmd.weight}"` : "",
          `fill="${cmd.color}"`,
          cmd.alpha !== undefined ? `fill-opacity="${cmd.alpha}"` : "",
          cmd.anchor === "middle" ? `text-anchor="middle"` : "",
          cmd.anchor === "end" ? `text-anchor="end"` : "",
        ]
          .filter(Boolean)
          .join(" ");
        out.push(`<text x="${cmd.x}" y="${cmd.y}" ${attrs}>${esc(cmd.text)}</text>`);
        break;
      }
    }
  }
  if (openTag !== null) out.push("</g>");
  return out.join("\n");
}
