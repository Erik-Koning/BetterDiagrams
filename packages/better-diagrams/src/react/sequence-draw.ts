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
  paletteRecord,
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
import { dateToDay, formatDiagramDate, isOverdue, laterDate } from "../contract/timeline";

/**
 * Dates in an EXPORT always carry the year.
 *
 * On screen the year is dropped while it matches today's — a roadmap inside
 * one year should not repeat it on every row. An exported picture outlives
 * the calendar: opened next January, "Sep 30" no longer says which year, and
 * nothing in the file can tell you.
 */
const exportDate = (date: string) => formatDiagramDate(date, { year: "always" });
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
  // Per-kind accents re-resolve through the palette, mirroring the editor's
  // --as-seq-* variables.
  const accents = { ...SEQ_KIND_ACCENT, ...paletteRecord(palette.seqAccents) };
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

  // Effective landing days for tagging, mirroring sequenceTimelineView: a
  // message is never earlier than either participant; bars, frames, and notes
  // inherit from what they anchor to.
  const pDate = new Map(t.participants.map((p) => [p.id, p.date]));
  const mDate = new Map(
    t.messages.map((m) => [
      m.id,
      laterDate(
        m.date,
        laterDate(m.from ? pDate.get(m.from) : undefined, m.to ? pDate.get(m.to) : undefined),
      ),
    ]),
  );
  const dayOf = (date?: string) => (date ? dateToDay(date) : undefined);
  /** Stamp everything pushed since `start` as belonging to one element. */
  const stamp = (start: number, id: string, day?: number) => {
    for (let i = start; i < cmds.length; i++) cmds[i].tag ??= { id, ...(day !== undefined ? { day } : {}) };
  };

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
    const fragStart = cmds.length;
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
    stamp(fragStart, `fragment:${frag.id}`, dayOf(laterDate(mDate.get(frag.from), mDate.get(frag.to))));
  }

  // Lifelines, then activation bars over them.
  t.participants.forEach((p, i) => {
    const lifeStart = cmds.length;
    const x = lifelineX(i);
    cmds.push({ op: "path", d: `M ${x} ${HEADER_H} V ${lifeEnd}`, stroke: palette.border, strokeWidth: 1.2, dash: [6, 5] });
    stamp(lifeStart, `participant:${p.id}`, dayOf(p.date));
  });
  for (const act of t.activations ?? []) {
    const actStart = cmds.length;
    const box = activationBox(t, act);
    const accent = accents[t.participants.find((p) => p.id === act.participant)?.kind ?? "service"];
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
    stamp(actStart, `activation:${act.id}`, dayOf(laterDate(pDate.get(act.participant), mDate.get(act.from))));
  }

  // Participant headers (drawn after lifelines so they sit on top).
  t.participants.forEach((p, i) => {
    const headStart = cmds.length;
    const x = slotX(i);
    const accent = accents[p.kind] ?? palette.textDim;
    // The same lifecycle conventions the architecture emitter applies — the
    // editor's participant headers carry them, and an export that dropped
    // them would be the canvas/export drift this file exists to prevent.
    const status = p.status;
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
    const headRect = roundedRectPath(x, 0, HEADER_W, HEADER_H, 8);
    cmds.push({ op: "path", d: headRect, fill: palette.surface });
    cmds.push({
      op: "path",
      d: headRect,
      fill: accent,
      fillAlpha: 0.08 * dim,
      stroke: accent,
      strokeAlpha: 0.5 * dim,
      strokeWidth: 1.2,
      ...(statusDash ? { dash: statusDash } : {}),
    });
    if (status === "dark") {
      // Black/white hazard tape, undimmed — the warning is the point.
      cmds.push({ op: "path", d: headRect, stroke: "#020617", strokeWidth: 2.5 });
      cmds.push({ op: "path", d: headRect, stroke: "#f8fafc", strokeWidth: 1.8, dash: [6, 6] });
    }
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
    // The eyebrow as coloured segments: the status token wears deprecated's
    // salmon, the date token wears overdue's amber, everything else the kind
    // accent. One mechanism instead of a branch per special case; the last
    // segment absorbs the ellipsis.
    const segments: Array<{ text: string; color: string }> = [
      { text: p.kind.toUpperCase(), color: accent },
    ];
    if (p.status) {
      segments.push({
        text: ` · ${p.status.toUpperCase()}`,
        color: p.status === "deprecated" ? (palette.warn ?? "#fa8072") : accent,
      });
    }
    if (p.date) {
      segments.push({
        text: ` · ${exportDate(p.date)}`,
        color: isOverdue(p.date, p.status) ? (palette.overdue ?? "#f59e0b") : accent,
      });
    }
    let segX = textX;
    segments.forEach((seg, si) => {
      const remaining = Math.max(0, textW - (segX - textX));
      const text = si === segments.length - 1 ? ellipsise(seg.text, 8, "mono", remaining) : seg.text;
      cmds.push({ op: "text", x: segX, y: 20, text, size: 8, font: "mono", color: seg.color, alpha: 0.85 });
      segX += approxTextWidth(text, 8, "mono");
    });
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
    stamp(headStart, `participant:${p.id}`, dayOf(p.date));
  });

  // Messages.
  const autonumber = t.meta?.autonumber === true;
  t.messages.forEach((m, i) => {
    const msgStart = cmds.length;
    const y = rowY(i);
    const dash = m.style === "sync" ? undefined : m.style === "async" ? [7, 5] : [4, 4];
    pushMessage(cmds, palette, order, m, i, y, dash, autonumber);
    stamp(msgStart, `message:${m.id}`, dayOf(mDate.get(m.id)));
  });

  // Notes.
  for (const { note, nx, ny, w, lines, h } of noteBoxes) {
    const noteStart = cmds.length;
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
    stamp(noteStart, `note:${note.id}`, dayOf(pDate.get(note.participant)));
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
      cmds.push({ op: "text", x: x + 12, y: y + (m.tech ? 37 : 26), text: exportDate(m.date), size: 9, font: "mono", color: palette.textDim, alpha: 0.7 });
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
    cmds.push({ op: "text", x: midX, y: y + (m.tech ? 24 : 13), text: exportDate(m.date), size: 9, font: "mono", color: palette.textDim, alpha: 0.7, anchor: "middle", knockout: { color: palette.bg, padX: 3, height: 11 } });
  }
}
