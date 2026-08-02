/**
 * sequence-draw.ts — the sequence-diagram image emitter.
 *
 * Same architecture as `emitTemplate`: one function turns the document into
 * backend-neutral draw commands, and the existing canvas/SVG backends replay
 * them — PNG, PDF, and SVG can never disagree with each other. No new DrawCmd
 * ops were needed; everything composes from path/poly/circle/text/grid.
 */
import {
  DARK_EXPORT_PALETTE,
  GRID,
  approxTextWidth,
  ellipsise,
  roundedRectPath,
  wrapText,
  type DrawCmd,
  type Emitted,
  type ExportPalette,
} from "./draw";
import {
  activationBox,
  fragmentBox,
  participantOrder,
  type SeqMessage,
  type SequenceTemplate,
} from "../contract/sequence";
import {
  BAR_W,
  FRAG_HEAD_H,
  HEADER_H,
  HEADER_W,
  MARGIN_X,
  SELF_LOOP_W,
  diagramHeight,
  lifelineX,
  rowY,
  slotX,
} from "../contract/sequence-layout";
import { formatDiagramDate } from "../contract/timeline";
import { teamColor } from "./shapes";

const PAD = 48;

/** Accent per participant kind — ONE table for the editor and the exporter. */
export const SEQ_KIND_ACCENT: Record<string, string> = {
  actor: "#94a3b8",
  service: "#38bdf8",
  database: "#f59e0b",
  queue: "#a78bfa",
  external: "#64748b",
};

export function emitSequence(
  template: SequenceTemplate,
  paletteOverride: Partial<ExportPalette> = {},
): Emitted {
  const palette: ExportPalette = { ...DARK_EXPORT_PALETTE, ...paletteOverride };
  const t = template;
  const order = participantOrder(t);
  const msgIndex = new Map(t.messages.map((m, i) => [m.id, i]));
  const columns = Math.max(1, t.participants.length);
  const lifeEnd = diagramHeight(t.messages.length);

  // Note geometry is computed up front because it decides the image bounds —
  // a note LEFT of the first column extends past the margin, and a fixed
  // frame would clip its text off the edge.
  const noteBoxes = (t.notes ?? []).map((note) => {
    const o = order.get(note.participant) ?? 0;
    const atIdx = note.at !== undefined ? (msgIndex.get(note.at) ?? 0) : undefined;
    const w = 150;
    const ny = (atIdx !== undefined ? rowY(atIdx) : HEADER_H + 20) - 14;
    const nx =
      note.side === "left"
        ? lifelineX(o) - w - 20
        : note.side === "over"
          ? lifelineX(o) - w / 2
          : lifelineX(o) + 20;
    const lines = wrapText(note.text, 10, "sans", w - 18, 3);
    return { note, nx, ny, w, lines, h: 14 + lines.length * 13 };
  });

  const minX = Math.min(MARGIN_X, ...noteBoxes.map((n) => n.nx - 10)) - PAD;
  const maxX =
    Math.max(
      slotX(columns - 1) + HEADER_W + SELF_LOOP_W,
      ...noteBoxes.map((n) => n.nx + n.w + 10),
    ) + PAD;
  const width = maxX - minX;
  const height = lifeEnd + PAD * 2;
  const cmds: DrawCmd[] = [];

  // Background + dot grid.
  cmds.push({ op: "path", d: `M ${minX} ${-PAD} h ${width} v ${height} h ${-width} Z`, fill: palette.bg });
  cmds.push({
    op: "grid",
    x: Math.floor(minX / GRID) * GRID,
    y: Math.floor(-PAD / GRID) * GRID,
    w: width + GRID,
    h: height + GRID,
    step: GRID,
    color: palette.gridDot,
  });

  // Fragments first — frames paint behind lifelines and messages.
  for (const frag of t.fragments ?? []) {
    const box = fragmentBox(t, frag);
    cmds.push({
      op: "path",
      d: roundedRectPath(box.x, box.y, box.w, box.h, 6),
      fill: palette.surface2,
      fillAlpha: 0.25,
      stroke: palette.border,
      strokeWidth: 1.2,
    });
    // Pentagon operator tab.
    const tabW = approxTextWidth(frag.kind, 10, "mono") + 26;
    cmds.push({
      op: "path",
      d: `M ${box.x} ${box.y} h ${tabW} v ${FRAG_HEAD_H - 9} l -9 9 h ${-(tabW - 9)} Z`,
      fill: palette.surface2,
      stroke: palette.border,
      strokeWidth: 1,
    });
    cmds.push({ op: "text", x: box.x + 8, y: box.y + 14, text: frag.kind, size: 10, font: "mono", weight: 700, color: palette.text });
    if (frag.label) {
      cmds.push({ op: "text", x: box.x + tabW + 8, y: box.y + 14, text: `[${frag.label}]`, size: 10, font: "mono", color: palette.textDim });
    }
    // Branch dividers.
    for (const branch of frag.elses ?? []) {
      const idx = msgIndex.get(branch.at);
      if (idx === undefined) continue;
      const y = rowY(idx) - 20;
      cmds.push({ op: "path", d: `M ${box.x} ${y} h ${box.w}`, stroke: palette.border, strokeWidth: 1, dash: [5, 4] });
      cmds.push({
        op: "text",
        x: box.x + 8,
        y: y + 13,
        text: `[${branch.label || "else"}]`,
        size: 10,
        font: "mono",
        color: palette.textDim,
        knockout: { color: palette.bg, padX: 3, height: 13 },
      });
    }
  }

  // Lifelines, then activation bars over them.
  t.participants.forEach((_p, i) => {
    const x = lifelineX(i);
    cmds.push({ op: "path", d: `M ${x} ${HEADER_H} V ${lifeEnd}`, stroke: palette.border, strokeWidth: 1.2, dash: [6, 5] });
  });
  for (const act of t.activations ?? []) {
    const box = activationBox(t, act);
    const accent = SEQ_KIND_ACCENT[t.participants.find((p) => p.id === act.participant)?.kind ?? "service"];
    cmds.push({
      op: "path",
      d: roundedRectPath(box.x, box.y, BAR_W, box.h, 3),
      fill: palette.surface,
    });
    cmds.push({
      op: "path",
      d: roundedRectPath(box.x, box.y, BAR_W, box.h, 3),
      fill: accent,
      fillAlpha: 0.25,
      stroke: accent,
      strokeAlpha: 0.7,
      strokeWidth: 1.2,
    });
  }

  // Participant headers (drawn after lifelines so they sit on top).
  t.participants.forEach((p, i) => {
    const x = slotX(i);
    const accent = SEQ_KIND_ACCENT[p.kind] ?? palette.textDim;
    cmds.push({ op: "path", d: roundedRectPath(x, 0, HEADER_W, HEADER_H, 8), fill: palette.surface });
    cmds.push({
      op: "path",
      d: roundedRectPath(x, 0, HEADER_W, HEADER_H, 8),
      fill: accent,
      fillAlpha: 0.08,
      stroke: accent,
      strokeAlpha: 0.5,
      strokeWidth: 1.2,
    });
    if (p.kind === "actor") {
      // Small stick-figure glyph beside the label.
      const cx = x + 20;
      cmds.push({ op: "circle", cx, cy: 14, r: 5, fill: accent, stroke: palette.surface, strokeWidth: 1 });
      cmds.push({ op: "path", d: `M ${cx} 19 V 31 M ${cx - 7} 24 H ${cx + 7} M ${cx} 31 L ${cx - 6} 40 M ${cx} 31 L ${cx + 6} 40`, stroke: accent, strokeWidth: 1.6, round: true });
    }
    const textX = p.kind === "actor" ? x + 36 : x + 12;
    const textW = HEADER_W - (textX - x) - 10;
    // The date rides on the kind eyebrow, exactly where the editor's header
    // puts its chip — the header box is fixed-height, so it cannot stack.
    const eyebrow =
      p.kind.toUpperCase() +
      (p.status ? ` · ${p.status.toUpperCase()}` : "") +
      (p.date ? ` · ${formatDiagramDate(p.date)}` : "");
    cmds.push({ op: "text", x: textX, y: 20, text: ellipsise(eyebrow, 8, "mono", textW), size: 8, font: "mono", color: accent, alpha: 0.85 });
    cmds.push({ op: "text", x: textX, y: 36, text: ellipsise(p.label, 13, "sans", textW), size: 13, font: "sans", weight: 600, color: palette.text });
    if (p.team) {
      const c = teamColor(p.team);
      const pillW = approxTextWidth(p.team, 9, "mono") + 14;
      const px = x + HEADER_W - pillW - 6;
      const d = roundedRectPath(px, HEADER_H - 8, pillW, 16, 8);
      cmds.push({ op: "path", d, fill: palette.surface });
      cmds.push({ op: "path", d, fill: c, fillAlpha: 0.14, stroke: c, strokeAlpha: 0.55, strokeWidth: 1 });
      cmds.push({ op: "text", x: px + 7, y: HEADER_H + 3.5, text: p.team, size: 9, font: "mono", weight: 600, color: c });
    }
  });

  // Messages.
  const autonumber = t.meta?.autonumber === true;
  t.messages.forEach((m, i) => {
    const y = rowY(i);
    const dash = m.style === "sync" ? undefined : m.style === "async" ? [7, 5] : [4, 4];
    pushMessage(cmds, palette, order, m, i, y, dash, autonumber);
  });

  // Notes.
  for (const { nx, ny, w, lines, h } of noteBoxes) {
    // Dog-eared note card.
    cmds.push({
      op: "path",
      d: `M ${nx} ${ny} h ${w - 10} l 10 10 v ${h - 10} h ${-w} Z`,
      fill: palette.surface2,
      fillAlpha: 0.9,
      stroke: palette.border,
      strokeWidth: 1,
    });
    cmds.push({ op: "path", d: `M ${nx + w - 10} ${ny} v 10 h 10`, stroke: palette.border, strokeWidth: 1 });
    lines.forEach((line, li) =>
      cmds.push({ op: "text", x: nx + 9, y: ny + 16 + li * 13, text: line, size: 10, font: "sans", color: palette.textDim }),
    );
  }

  // Title + version tag, matching emitTemplate's corners.
  if (t.meta?.title) {
    cmds.push({ op: "text", x: minX + 10, y: -PAD + 24, text: String(t.meta.title), size: 15, font: "sans", weight: 700, color: palette.text });
    cmds.push({
      op: "text",
      x: minX + 10,
      y: -PAD + 40,
      text: `${t.participants.length} participants · ${t.messages.length} messages`,
      size: 10,
      font: "mono",
      color: palette.textFaint,
    });
  }
  if (t.meta?.versionTag) {
    const tag = String(t.meta.versionTag);
    const pos = t.meta.versionTagPosition ?? "top-left";
    const pillW = approxTextWidth(tag, 10, "mono") + 20;
    const px = pos.endsWith("left") ? minX + 10 : minX + width - pillW - 10;
    const titleOffset = pos === "top-left" && t.meta?.title ? 40 : 0;
    const py = pos.startsWith("top") ? -PAD + 10 + titleOffset : -PAD + height - 30;
    cmds.push({ op: "path", d: roundedRectPath(px, py, pillW, 20, 10), fill: palette.surface, fillAlpha: 0.92, stroke: palette.border, strokeWidth: 1 });
    cmds.push({ op: "text", x: px + 10, y: py + 14, text: tag, size: 10, font: "mono", weight: 600, color: palette.textDim });
  }

  return { cmds, width, height, originX: -minX, originY: PAD };
}

/** One message row: line, arrowhead(s), label, tech, optional number badge. */
function pushMessage(
  cmds: DrawCmd[],
  palette: ExportPalette,
  order: Map<string, number>,
  m: SeqMessage,
  index: number,
  y: number,
  dash: number[] | undefined,
  autonumber: boolean,
): void {
  const color = palette.textDim;
  const number = autonumber ? `${index + 1}. ` : "";
  const labelText = `${number}${m.label}`;

  const arrowAt = (x: number, dir: 1 | -1, open: boolean) => {
    if (open) {
      cmds.push({ op: "path", d: `M ${x - 9 * dir} ${y - 4.5} L ${x} ${y} L ${x - 9 * dir} ${y + 4.5}`, stroke: color, strokeWidth: 1.6, round: true });
    } else {
      cmds.push({ op: "poly", points: "0,-4.5 9,0 0,4.5", fill: color, tx: x, ty: y, rotateDeg: dir === 1 ? 0 : 180 });
    }
  };
  const open = m.style !== "sync";

  // Self-message: rectangular loop to the right of the lifeline.
  if (m.from !== null && m.from === m.to) {
    const x = lifelineX(order.get(m.from) ?? 0) + BAR_W / 2;
    cmds.push({
      op: "path",
      d: `M ${x} ${y - 10} h ${SELF_LOOP_W - 14} v 20 h ${-(SELF_LOOP_W - 14)}`,
      stroke: color,
      strokeWidth: 1.6,
      dash,
    });
    arrowAt(x + 1, -1, open);
    cmds.push({ op: "text", x: x + 12, y: y - 16, text: labelText, size: 11, font: "mono", color: palette.textDim, knockout: { color: palette.bg, padX: 4, height: 15 } });
    if (m.tech) cmds.push({ op: "text", x: x + 12, y: y + 26, text: `[${m.tech}]`, size: 9, font: "mono", color: palette.textDim, alpha: 0.8 });
    if (m.date) {
      cmds.push({ op: "text", x: x + 12, y: y + (m.tech ? 37 : 26), text: formatDiagramDate(m.date), size: 9, font: "mono", color: palette.textDim, alpha: 0.7 });
    }
    return;
  }

  // Lost/found: a stub from/to a filled dot in the environment.
  const STUB = 90;
  const fromX = m.from !== null ? lifelineX(order.get(m.from) ?? 0) : null;
  const toX = m.to !== null ? lifelineX(order.get(m.to) ?? 0) : null;
  const x1 = fromX ?? (toX! > 0 ? toX! - STUB : toX! + STUB);
  const x2 = toX ?? (fromX! > 0 ? fromX! + STUB : fromX! - STUB);

  cmds.push({ op: "path", d: `M ${x1} ${y} H ${x2}`, stroke: color, strokeWidth: 1.6, dash });
  arrowAt(x2, x2 > x1 ? 1 : -1, open);
  if (m.from === null) cmds.push({ op: "circle", cx: x1, cy: y, r: 4, fill: color });
  if (m.to === null) cmds.push({ op: "circle", cx: x2, cy: y, r: 4, fill: color });

  const midX = (x1 + x2) / 2;
  if (labelText.trim()) {
    cmds.push({ op: "text", x: midX, y: y - 6, text: labelText, size: 11, font: "mono", color: palette.textDim, anchor: "middle", knockout: { color: palette.bg, padX: 4, height: 15 } });
  }
  if (m.tech) {
    cmds.push({ op: "text", x: midX, y: y + 13, text: `[${m.tech}]`, size: 9, font: "mono", color: palette.textDim, alpha: 0.8, anchor: "middle", knockout: { color: palette.bg, padX: 3, height: 11 } });
  }
  if (m.date) {
    cmds.push({ op: "text", x: midX, y: y + (m.tech ? 24 : 13), text: formatDiagramDate(m.date), size: 9, font: "mono", color: palette.textDim, alpha: 0.7, anchor: "middle", knockout: { color: palette.bg, padX: 3, height: 11 } });
  }
}
