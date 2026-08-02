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
  DEFAULT_ZONE_OPACITY,
  EDGE_COLOR_HEX,
  EDGE_DASH,
  type DiagramEdge,
  type DiagramNode,
  type DiagramTemplate,
  type DiagramZone,
} from "../contract/schema";
import { zoneOutline } from "../contract/zones";
import { formatDiagramDate } from "../contract/timeline";
import { edgeGeometryFor, startAngle, type Box } from "../contract/geometry";
import { seqBadgeOffset, silhouettePath, teamColor } from "./shapes";
import { kindDef, iconPaths, providerDef, type ResolvedRegistry } from "./registry-types";

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
};

// ─── Command set ─────────────────────────────────────────────────────────────

export type DrawCmd =
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
      anchor?: "start" | "middle";
      /** Knock a bg-coloured rect out behind the text (edge labels over lines). */
      knockout?: { color: string; padX: number; height: number };
    }
  | { op: "grid"; x: number; y: number; w: number; h: number; step: number; color: string };

// ─── Shared approximate text metrics ─────────────────────────────────────────

const CHAR_FACTOR = { mono: 0.602, sans: 0.52 } as const;

export function approxTextWidth(text: string, size: number, font: "mono" | "sans"): number {
  return text.length * size * CHAR_FACTOR[font];
}

export function wrapText(text: string, size: number, font: "mono" | "sans", maxWidth: number, maxLines: number): string[] {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (approxTextWidth(candidate, size, font) > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = candidate;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && line && lines[maxLines - 1] !== line) {
    // Out of room — ellipsise what we kept.
    let last = lines[maxLines - 1];
    while (last.length > 1 && approxTextWidth(`${last}…`, size, font) > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines.slice(0, maxLines);
}

export function ellipsise(text: string, size: number, font: "mono" | "sans", maxWidth: number): string {
  let s = text;
  while (s.length > 1 && approxTextWidth(`${s}…`, size, font) > maxWidth) s = s.slice(0, -1);
  return s === text ? text : `${s}…`;
}

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

const ARROW_POINTS = "0,-4.5 9,0 0,4.5";

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

function layout(template: DiagramTemplate): Layout {
  const visible = visibleElements(template);
  const collapseHidden = hiddenByCollapse(template);
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
        return [{ ...e, source, target, label: "", tech: undefined, seq: undefined }];
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

function defaultRoutingOf(template: DiagramTemplate): "curved" | "orthogonal" {
  return template.meta?.routing === "orthogonal" ? "orthogonal" : "curved";
}

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
  const { placed, byId, zones, edges, legend } = layout(template);
  const b = templateBounds(template, { onlyVisible: true });
  const width = Math.max(1, b.maxX - b.minX + PAD * 2);
  const height = Math.max(1, b.maxY - b.minY + PAD * 2);
  const cmds: DrawCmd[] = [];

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

  // Zones, back to front.
  for (const zone of zones) {
    const def = providerDef(registry, zone.provider);
    const alpha = zone.opacity ?? DEFAULT_ZONE_OPACITY;
    const polygon = zoneOutlineAbs(zone);
    const d =
      zone.shape === "ellipse"
        ? ellipsePath(zone.x + zone.w / 2, zone.y + zone.h / 2, zone.w / 2, zone.h / 2)
        : polygon
          ? `M ${polygon.map(([px, py]) => `${px} ${py}`).join(" L ")} Z`
          : roundedRectPath(zone.x, zone.y, zone.w, zone.h, zone.shape === "rounded" ? 18 : 2);
    cmds.push({ op: "path", d, fill: def.color, fillAlpha: alpha, stroke: def.color, strokeAlpha: 0.75, strokeWidth: 1.5 });

    // The date rides inside the zone's own header chip rather than beside it,
    // so the chip's width formula stays the single source of its size.
    const label = `${zone.label}  ·  ${def.label}${
      zone.date ? `  ·  ${formatDiagramDate(zone.date)}` : ""
    }`;
    const chipW = approxTextWidth(label, 11, "mono") + 26;
    cmds.push({
      op: "path",
      d: roundedRectPath(zone.x, zone.y, chipW, 22, 6),
      fill: def.color,
      fillAlpha: 0.22,
      stroke: def.color,
      strokeAlpha: 0.55,
      strokeWidth: 1,
    });
    cmds.push({ op: "path", d: roundedRectPath(zone.x + 8, zone.y + 8, 7, 7, 1.5), fill: def.color });
    cmds.push({ op: "text", x: zone.x + 21, y: zone.y + 15, text: label, size: 11, font: "mono", weight: 600, color: palette.text });
  }

  // Date chip — the same outlined grey chip the editor renders (.as-date), so
  // "this lands in June" survives into the shared artefact rather than being
  // an editor-only affordance.
  const dateChipW = (date: string) => approxTextWidth(formatDiagramDate(date), 9, "mono") + 12;
  const pushDateChip = (date: string, x: number, y: number) => {
    const text = formatDiagramDate(date);
    const d = roundedRectPath(x, y, approxTextWidth(text, 9, "mono") + 12, 15, 4);
    cmds.push({ op: "path", d, fill: palette.surface, fillAlpha: 0.7 });
    cmds.push({ op: "path", d, stroke: palette.textDim, strokeAlpha: 0.4, strokeWidth: 1 });
    cmds.push({ op: "text", x: x + 6, y: y + 11, text, size: 9, font: "mono", weight: 500, color: palette.textDim });
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

  // Containers: expanded boundaries or collapsed chips.
  for (const { node, box } of placed) {
    const def = kindDef(registry, node.kind);
    if (!def.container) continue;
    if (node.collapsed) {
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
      if (node.date) pushDateChip(node.date, box.x + box.width - dateChipW(node.date) - 8, box.y + (box.height - 15) / 2);
      if (node.team) {
        const shift = node.date ? dateChipW(node.date) + 6 : 0;
        pushTeamPill(node.team, box.x + box.width - teamPillW(node.team) - 8 - shift, box.y + (box.height - 16) / 2);
      }
      continue;
    }
    cmds.push({
      op: "path",
      d: roundedRectPath(box.x, box.y, box.width, box.height, 10),
      fill: palette.surface2,
      fillAlpha: 0.28,
      stroke: def.accent,
      strokeWidth: 1.2,
      dash: [6, 5],
    });
    const chipW = Math.max(60, approxTextWidth(node.label, 11, "mono") + 18);
    cmds.push({ op: "path", d: roundedRectPath(box.x, box.y, chipW, 22, 6), fill: palette.surface2 });
    cmds.push({ op: "text", x: box.x + 9, y: box.y + 15, text: node.label, size: 11, font: "mono", color: palette.textDim });
    // Beside the boundary's name chip, in the same order the editor's group
    // label renders them: date first, then the owning team.
    let cursor = box.x + chipW + 6;
    if (node.date) {
      pushDateChip(node.date, cursor, box.y + 4);
      cursor += dateChipW(node.date) + 6;
    }
    if (node.team) pushTeamPill(node.team, cursor, box.y + 3);
  }

  // Edges.
  const defaultRouting = defaultRoutingOf(template);
  for (const edge of edges) {
    const s = byId.get(edge.source);
    const t = byId.get(edge.target);
    if (!s || !t) continue;
    const geo = edgeGeometryFor(edge.routing ?? defaultRouting, s.box, t.box, edge.labelT ?? 0.5);
    const color = EDGE_COLOR_HEX[edge.color] ?? EDGE_COLOR_HEX.slate;
    const direction = edge.direction ?? "forward";

    cmds.push({ op: "path", d: geo.path, stroke: color, strokeWidth: 1.8, dash: EDGE_DASH[edge.style] });
    if (direction !== "none") {
      cmds.push({ op: "poly", points: ARROW_POINTS, fill: color, tx: geo.tip.x, ty: geo.tip.y, rotateDeg: (geo.angle * 180) / Math.PI });
    }
    if (direction === "both") {
      const origin = geo.at(0);
      cmds.push({ op: "poly", points: ARROW_POINTS, fill: color, tx: origin.x, ty: origin.y, rotateDeg: (startAngle(geo) * 180) / Math.PI });
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
  }

  // Leaves and annotations.
  for (const { node, box } of placed) {
    const def = kindDef(registry, node.kind);
    if (def.container) continue;

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
      continue;
    }

    // Lifecycle status: outline style for not-built-yet, dimming for on-the-
    // way-out — the same conventions the editor's CSS applies.
    const status = node.status;
    const statusDash = status === "proposed" ? [2, 3] : status === "planned" ? [6, 5] : undefined;
    const dim = status === "deprecated" ? 0.55 : status === "retired" ? 0.4 : 1;

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
    const eyebrow = def.label.toUpperCase() + (status ? ` · ${status.toUpperCase()}` : "");
    const title = ellipsise(node.label, 13, "sans", textW);
    cmds.push({ op: "text", x: textX, y: box.y + cTop + 16, text: eyebrow, size: 9, font: "mono", color: def.accent, alpha: 0.8 * dim });
    cmds.push({ op: "text", x: textX, y: box.y + cTop + 31, text: title, size: 13, font: "sans", weight: 600, color: palette.text, ...(dim < 1 ? { alpha: dim } : {}) });
    if (status === "retired") {
      const strikeW = approxTextWidth(title, 13, "sans");
      cmds.push({ op: "path", d: `M ${textX} ${box.y + cTop + 26.5} L ${textX + strikeW} ${box.y + cTop + 26.5}`, stroke: palette.text, strokeAlpha: dim, strokeWidth: 1 });
    }
    const descLines = node.description ? wrapText(node.description, 10.5, "sans", textW, 2) : [];
    descLines.forEach((line, i) =>
      cmds.push({ op: "text", x: textX, y: box.y + cTop + 45 + i * 13, text: line, size: 10.5, font: "sans", color: palette.textDim, ...(dim < 1 ? { alpha: dim } : {}) }),
    );
    if (node.date) {
      // Stacked under whatever text the node ended up with, then clamped
      // inside the box — a two-line description on a default-height node
      // leaves no room, and the chip must not escape the silhouette.
      const below = box.y + cTop + 36 + descLines.length * 13;
      pushDateChip(node.date, textX, Math.min(below, box.y + box.height - 19));
    }
    // Bottom-right, riding the edge — mirrors the editor's placement.
    if (node.team) pushTeamPill(node.team, box.x + box.width - teamPillW(node.team) - 6, box.y + box.height - 8);
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
        ctx.textAlign = cmd.anchor === "middle" ? "center" : "left";
        if (cmd.knockout) {
          const w = approxTextWidth(cmd.text, cmd.size, cmd.font) + cmd.knockout.padX * 2;
          const left = cmd.anchor === "middle" ? cmd.x - w / 2 : cmd.x - cmd.knockout.padX;
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

export function drawToSvg(cmds: DrawCmd[]): string {
  const out: string[] = [];
  for (const cmd of cmds) {
    switch (cmd.op) {
      case "grid": {
        // A pattern keeps the SVG small where canvas just loops.
        out.push(
          `<defs><pattern id="as-grid" width="${cmd.step}" height="${cmd.step}" patternUnits="userSpaceOnUse" x="${cmd.x}" y="${cmd.y}"><rect width="1.2" height="1.2" fill="${cmd.color}"/></pattern></defs>`,
          `<rect x="${cmd.x}" y="${cmd.y}" width="${cmd.w}" height="${cmd.h}" fill="url(#as-grid)"/>`,
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
          const left = cmd.anchor === "middle" ? cmd.x - w / 2 : cmd.x - cmd.knockout.padX;
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
        ]
          .filter(Boolean)
          .join(" ");
        out.push(`<text x="${cmd.x}" y="${cmd.y}" ${attrs}>${esc(cmd.text)}</text>`);
        break;
      }
    }
  }
  return out.join("\n");
}
