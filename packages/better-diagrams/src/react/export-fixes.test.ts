/**
 * Regressions in the export pipeline — each one a case where a document
 * exported as something OTHER than what the editor shows, which is the single
 * promise the exporters make.
 *
 * The canvas-backed cases run against a recording 2D context rather than a
 * real one: what is under test is which colour, alpha and page size the
 * pipeline asks for, and no browser is needed to answer that.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry } from "./create-registry";
import { teamColor } from "./shapes";
import { drawToCanvas, emitTemplate, type DrawCmd } from "./draw";
import { approxTextWidth } from "../contract/text";
import { emittedToCanvas } from "./export-helpers";
import {
  BUILTIN_EXPORTERS,
  renderTemplateToC4Puml,
  renderTemplateToMermaid,
  renderTemplateToSvg,
} from "./exporters";
import { runStateExport } from "./state-export";
import type { StateAxes } from "../contract/states";
import {
  EXAMPLE_ZONED_TEMPLATE,
  validateTemplate,
  type DiagramTemplate,
} from "../contract/schema";

const registry = createRegistry();
const doc = (partial: Record<string, unknown>) =>
  validateTemplate({ version: 1, edges: [], ...partial } as unknown as DiagramTemplate) as DiagramTemplate;

type TextCmd = Extract<DrawCmd, { op: "text" }>;
type PathCmd = Extract<DrawCmd, { op: "path" }>;
const texts = (cmds: DrawCmd[]) => cmds.filter((c): c is TextCmd => c.op === "text");
const paths = (cmds: DrawCmd[]) => cmds.filter((c): c is PathCmd => c.op === "path");

// ─── A canvas the exporters can drive with no DOM ────────────────────────────

interface Paint {
  style: string;
  alpha: number;
}

/** Records what each fill/stroke would actually put on the page. */
function recordingContext() {
  const fills: Paint[] = [];
  const strokes: Paint[] = [];
  const stack: number[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "",
    lineJoin: "",
    miterLimit: 10,
    font: "",
    textAlign: "",
    save() {
      stack.push(ctx.globalAlpha);
    },
    restore() {
      ctx.globalAlpha = stack.pop() ?? 1;
    },
    scale() {},
    translate() {},
    rotate() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    setLineDash() {},
    fillRect() {},
    strokeText() {},
    fill() {
      fills.push({ style: String(ctx.fillStyle), alpha: ctx.globalAlpha });
    },
    stroke() {
      strokes.push({ style: String(ctx.strokeStyle), alpha: ctx.globalAlpha });
    },
    fillText() {
      fills.push({ style: String(ctx.fillStyle), alpha: ctx.globalAlpha });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, strokes };
}

interface FakeCanvas {
  width: number;
  height: number;
  getContext(): CanvasRenderingContext2D;
  toBlob(cb: (b: Blob | null) => void, type?: string): void;
}

const canvases: FakeCanvas[] = [];
const priorDocument = (globalThis as { document?: unknown }).document;
const priorPath2D = (globalThis as { Path2D?: unknown }).Path2D;

beforeAll(() => {
  (globalThis as { Path2D?: unknown }).Path2D = class {
    constructor(readonly d: string) {}
  };
  (globalThis as { document?: unknown }).document = {
    createElement() {
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        getContext: () => recordingContext().ctx,
        toBlob: (cb, type) => cb(new Blob([new TextEncoder().encode("bytes")], { type })),
      };
      canvases.push(canvas);
      return canvas;
    },
  };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = priorDocument;
  (globalThis as { Path2D?: unknown }).Path2D = priorPath2D;
});

/** The `/MediaBox[0 0 w h]` numbers of every page, in points. */
async function mediaBoxes(blob: Blob): Promise<Array<[number, number]>> {
  const text = new TextDecoder("latin1").decode(new Uint8Array(await blob.arrayBuffer()));
  return [...text.matchAll(/\/MediaBox\[0 0 (\d+) (\d+)\]/g)].map(
    (m) => [Number(m[1]), Number(m[2])] as [number, number],
  );
}

// ─── 1. Team pills ───────────────────────────────────────────────────────────

describe("team colours survive the canvas backend", () => {
  it("teamColor is canonical #rrggbb, and stable per name", () => {
    expect(teamColor("Platform")).toMatch(/^#[0-9a-f]{6}$/);
    expect(teamColor("Platform")).toBe(teamColor("Platform"));
    expect(teamColor("Platform")).not.toBe(teamColor("Fintech"));
  });

  it("the pill's tint, outline and label all use a colour canvas can fade", () => {
    const { cmds } = emitTemplate(
      doc({ nodes: [{ id: "a", label: "API", kind: "service", team: "Platform", x: 0, y: 0, w: 170, h: 76 }] }),
      registry,
    );
    const ink = teamColor("Platform");
    const pill = paths(cmds).find((c) => c.fill === ink && c.fillAlpha === 0.14);
    expect(pill).toBeTruthy();
    expect(pill!.stroke).toBe(ink);
    expect(texts(cmds).find((c) => c.text === "Platform")!.color).toBe(ink);
  });

  it("an alpha is never dropped, whatever form the colour arrives in", () => {
    const hex = recordingContext();
    drawToCanvas(hex.ctx, [{ op: "path", d: "M 0 0", fill: "#336699", fillAlpha: 0.14 }]);
    expect(hex.fills).toEqual([{ style: "rgba(51, 102, 153, 0.14)", alpha: 1 }]);

    // A host palette may hand the emitter any CSS colour. Painting it at full
    // strength — the old behaviour — is what buried the team pill's label.
    const css = recordingContext();
    drawToCanvas(css.ctx, [{ op: "path", d: "M 0 0", fill: "hsl(210 60% 55%)", fillAlpha: 0.14 }]);
    expect(css.fills).toEqual([{ style: "hsl(210 60% 55%)", alpha: 0.14 }]);
  });

  it("a fill's alpha does not leak into the stroke beside it", () => {
    const { ctx, strokes } = recordingContext();
    drawToCanvas(ctx, [
      { op: "path", d: "M 0 0", fill: "hsl(0 0% 0%)", fillAlpha: 0.1, stroke: "#ffffff" },
    ]);
    expect(strokes).toEqual([{ style: "#ffffff", alpha: 1 }]);
  });
});

// ─── 2. PDF page size ────────────────────────────────────────────────────────

describe("PDF pages are sized in CSS pixels", () => {
  it("a single-document PDF prints at 0.75pt per CSS pixel", async () => {
    const template = doc({
      nodes: [{ id: "a", label: "API", kind: "service", x: 0, y: 0, w: 170, h: 76 }],
    });
    const { width, height } = emitTemplate(template, registry);
    const result = await BUILTIN_EXPORTERS.pdf.run({ template, registry, filename: "d" });
    expect(await mediaBoxes(result!.blob)).toEqual([
      [Math.round((width * 72) / 96), Math.round((height * 72) / 96)],
    ]);
  });

  it("state pages too — the 2x backing store is not the page", async () => {
    const axes: StateAxes = { zones: [], stops: [] };
    const rendered = () => ({
      canvas: canvasStub(),
      width: 1036,
      height: 616,
    });
    const single = await runStateExport({
      format: "pdf",
      filename: "d",
      axes,
      combos: [{ providers: {}, at: null }, { providers: {}, at: null }],
      pdfLayout: "single",
      materialize: (c) => c,
      renderCanvas: rendered as never,
    });
    expect(await mediaBoxes(single.blob)).toEqual([
      [777, 462],
      [777, 462],
    ]);

    const separate = await runStateExport({
      format: "pdf",
      filename: "d",
      axes,
      combos: [{ providers: {}, at: null }],
      pdfLayout: "separate",
      materialize: (c) => c,
      renderCanvas: rendered as never,
    });
    expect(await mediaBoxes(separate.blob)).toEqual([[777, 462]]);
  });
});

/** A canvas whose backing store is the 2x one a real export would allocate. */
function canvasStub() {
  return {
    width: 2072,
    height: 1232,
    toBlob: (cb: (b: Blob | null) => void, type?: string) =>
      cb(new Blob([new TextEncoder().encode("jpeg")], { type })),
  };
}

// ─── 3. Self-loops ───────────────────────────────────────────────────────────

describe("self-loops are exported", () => {
  const retry = (extra: Record<string, unknown> = {}) =>
    doc({
      nodes: [
        { id: "ask", label: "Approved?", kind: "decision", x: 0, y: 0, w: 170, h: 100 },
        { id: "out", label: "Out", kind: "service", x: 400, y: 0, w: 170, h: 76 },
        { id: "g", label: "G", kind: "group", x: 0, y: 300, w: 400, h: 200, ...extra },
        { id: "in", label: "In", kind: "service", parentId: "g", x: 24, y: 48, w: 170, h: 76 },
      ],
      edges: [
        { id: "loop", source: "ask", target: "ask", label: "retry" },
        { id: "cross", source: "out", target: "in", label: "calls" },
      ],
    });

  it("the retry arrow reaches the image exports", () => {
    const { cmds } = emitTemplate(retry(), registry);
    expect(cmds.some((c) => c.tag?.id === "edge:loop")).toBe(true);
    expect(renderTemplateToSvg(retry(), registry)).toContain('data-el="edge:loop"');
  });

  it("but an edge that COLLAPSED onto one card still does not", () => {
    // Both ends land on the folded group's chip: that is its internal wiring,
    // and the canvas draws no loop for it either.
    const collapsed = validateTemplate({
      version: 1,
      nodes: [
        { id: "g", label: "G", kind: "group", collapsed: true, x: 0, y: 0, w: 400, h: 200 },
        { id: "a", label: "A", kind: "service", parentId: "g", x: 24, y: 48, w: 170, h: 76 },
        { id: "b", label: "B", kind: "service", parentId: "g", x: 24, y: 120, w: 170, h: 76 },
      ],
      edges: [{ id: "inner", source: "a", target: "b", label: "x" }],
    } as unknown as DiagramTemplate) as DiagramTemplate;
    const { cmds } = emitTemplate(collapsed, registry);
    expect(cmds.some((c) => c.tag?.id === "edge:inner")).toBe(false);
  });

  it("and the text formats keep it when the document also has drill detail", () => {
    // `rootLevelProjection` runs only once something is hidden inline, which is
    // exactly when the old `source === target` test started eating self-loops.
    const drilled = doc({
      nodes: [
        { id: "ask", label: "Approved?", kind: "decision", x: 0, y: 0, w: 170, h: 100 },
        { id: "svc", label: "Svc", kind: "service", x: 400, y: 0, w: 170, h: 76 },
        { id: "детail", label: "Detail", kind: "service", parentId: "svc", x: 0, y: 0, w: 170, h: 76 },
      ],
      edges: [{ id: "loop", source: "ask", target: "ask", label: "retry" }],
    });
    expect(renderTemplateToMermaid(drilled)).toContain('ask -->|"retry"| ask');
    expect(renderTemplateToC4Puml(drilled)).toContain('Rel(ask, ask, "retry")');
  });
});

// ─── 4. Group frames honour `status` ─────────────────────────────────────────

describe("a group's lifecycle stage reaches the export", () => {
  const group = (status: string) =>
    doc({ nodes: [{ id: "g", label: "Tier", kind: "group", status, x: 0, y: 0, w: 400, h: 200 }] });

  it("a proposed frame is dotted, not the default dashed", () => {
    const frame = paths(emitTemplate(group("proposed"), registry).cmds).find(
      (c) => c.tag?.id === "node:g",
    )!;
    expect(frame.dash).toEqual([2, 3]);
  });

  it("a deprecated frame dims and says so in its name chip", () => {
    const { cmds } = emitTemplate(group("deprecated"), registry);
    const frame = paths(cmds).find((c) => c.tag?.id === "node:g")!;
    expect(frame.strokeAlpha).toBe(0.55);
    expect(frame.fillAlpha).toBeCloseTo(0.28 * 0.55, 5);
    expect(texts(cmds).map((c) => c.text)).toContain(" · DEPRECATED");
  });

  it("a dark frame wears the hazard tape the canvas gives it", () => {
    const strokes = paths(emitTemplate(group("dark"), registry).cmds).map((c) => c.stroke);
    expect(strokes).toContain("#020617");
    expect(strokes).toContain("#f8fafc");
  });

  it("an invisible frame stays invisible whatever stage it is at", () => {
    // The canvas zeroes the border width for `outline: "none"`, so the status
    // class restyles a border that is not there.
    const hidden = doc({
      nodes: [
        { id: "g", label: "Tier", kind: "group", status: "proposed", outline: "none", x: 0, y: 0, w: 400, h: 200 },
      ],
    });
    const frame = paths(emitTemplate(hidden, registry).cmds).find((c) => c.tag?.id === "node:g")!;
    expect(frame.stroke).toBeUndefined();
  });
});

// ─── 4b. The document-wide fold reaches the export ───────────────────────────

describe("settings.groupContents folds the export like the canvas", () => {
  const folded = doc({
    settings: { groupContents: "hide" },
    nodes: [
      { id: "empty", label: "Spare", kind: "group", x: 0, y: 0, w: 300, h: 200 },
      { id: "g", label: "Tier", kind: "group", x: 500, y: 0, w: 400, h: 200 },
      { id: "a", label: "A", kind: "service", parentId: "g", x: 24, y: 48, w: 170, h: 76 },
      { id: "out", label: "Out", kind: "service", x: 0, y: 400, w: 170, h: 76 },
    ],
    edges: [{ id: "e", source: "a", target: "out", label: "calls" }],
  });

  it("draws a chip for the group, hides its contents, and re-routes the edge", () => {
    const { cmds, width } = emitTemplate(folded, registry);
    const labels = texts(cmds).map((c) => c.text);
    expect(labels).toContain("▸ Tier"); // the chip, with its fold glyph
    expect(labels).not.toContain("A");
    expect(labels).toContain("Spare"); // the empty frame stays open
    // A re-routed edge is still drawn — from the chip — and the picture is
    // cropped to the 180px chip, not to the 400px frame it stands for.
    expect(cmds.some((c) => c.tag?.id === "edge:e")).toBe(true);
    const open = emitTemplate({ ...folded, settings: undefined }, registry);
    expect(open.width - width).toBe(400 - 180);
  });

  it("the whole-document React Flow export still unfolds it", async () => {
    const result = await BUILTIN_EXPORTERS.reactflow.run({ template: folded, registry, filename: "d" });
    const rf = JSON.parse(await result!.blob.text()) as { nodes: Array<{ id: string; width: number }> };
    expect(rf.nodes.map((n) => n.id)).toContain("a");
    expect(rf.nodes.find((n) => n.id === "g")!.width).toBe(400);
  });
});

// ─── 5. Note line breaks ─────────────────────────────────────────────────────

describe("a note's own line breaks", () => {
  const note = (label: string, fontSize = 13) =>
    doc({ nodes: [{ id: "n", label, kind: "text", fontSize, x: 0, y: 0, w: 300, h: 60 }] });

  it("every typed line is drawn, even past the box's height", () => {
    const lines = ["one", "two", "three", "four", "five"];
    const drawn = texts(emitTemplate(note(lines.join("\n")), registry).cmds).map((c) => c.text);
    expect(drawn).toEqual(lines);
  });

  it("the line pitch is the canvas's 1.4, not a flat +5", () => {
    const drawn = texts(emitTemplate(note("a\nb", 26), registry).cmds);
    expect(drawn[1].y - drawn[0].y).toBe(Math.round(26 * 1.4));
  });
});

// ─── 6. Description font and clamp ───────────────────────────────────────────

describe("a card's description matches .as-node__desc", () => {
  const long = "A description long enough to need several lines of wrapping to say what it says.";
  const card = (over: Record<string, unknown>) =>
    doc({
      nodes: [
        { id: "a", label: "API", kind: "service", description: long, x: 0, y: 0, w: 170, h: 76, ...over },
      ],
    });
  const descLines = (t: DiagramTemplate) =>
    texts(emitTemplate(t, registry).cmds).filter((c) => c.size === 11 && c.font === "sans");

  it("is 11px and clamps to two lines", () => {
    expect(descLines(card({}))).toHaveLength(2);
  });

  it("wraps past two lines when the node asks to, in a box validation grew to hold them", () => {
    const wrapped = card({ wrap: true, w: 140 });
    const lines = descLines(wrapped);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.at(-1)!.y).toBeLessThanOrEqual(wrapped.nodes[0]!.h);
  });

  it("never prints a wrapped description past a box that skipped validation", () => {
    const shrunk = card({ wrap: true, w: 140 });
    shrunk.nodes[0]!.h = 60;
    expect(descLines(shrunk).at(-1)!.y).toBeLessThanOrEqual(60);
  });

  it("runs a wrapped card's description the full width under its icon, in the type it was measured in", () => {
    const t = card({ wrap: true, icon: "server" });
    for (const mode of ["technical", "marketing"] as const) {
      const drawn = texts(emitTemplate(t, registry, {}, { mode }).cmds);
      const title = drawn.find((c) => c.text === "API")!;
      const lines = drawn.filter((c) => c.size === 11 && c.font === "sans");
      expect(lines.length, mode).toBeGreaterThan(2);
      // From the card's own padding — left of the title, which sits beside
      // the icon — and every line from the same edge.
      expect(lines.every((c) => c.x === lines[0]!.x), mode).toBe(true);
      expect(lines[0]!.x, mode).toBeLessThan(title.x);
      expect(lines[0]!.x - t.nodes[0]!.x, mode).toBe(14);
    }
  });
});

describe("a diamond's label sits in its middle", () => {
  // Marketing drops the eyebrow, so the title is the whole text block.
  const label = (node: Record<string, unknown>) => {
    const t = doc({ nodes: [{ id: "m", label: "Gate", kind: "milestone", x: 0, y: 0, w: 300, h: 120, ...node }] });
    return texts(emitTemplate(t, registry, {}, { mode: "marketing" }).cmds).find((c) => c.text === "Gate")!;
  };

  it("as far from the top point as from the bottom one", () => {
    const title = label({});
    // The baseline, less half a cap height, is the glyph's middle.
    const glyphMid = title.y - title.size * 0.35;
    expect(Math.abs(glyphMid - 60)).toBeLessThan(4);
  });

  it("centred by default, on the diamond rather than right of it", () => {
    const title = label({});
    expect(title.anchor).toBe("middle");
    // Within the card's own 14/10 inset skew — not the ~29px the diamond's
    // one-sided corner inset used to push it.
    expect(Math.abs(title.x - 150)).toBeLessThan(3);
  });

  it("left, where the document says so", () => {
    expect(label({ textAlign: "left" }).anchor).toBeUndefined();
  });
});

describe("a wrapped diamond keeps all of its text inside the outline", () => {
  const description = "checkouts_in_flight_idx: one preparing or purchasing checkout per operator and item.";
  const question = (w: number, over: Record<string, unknown> = {}) =>
    doc({
      nodes: [{ id: "ask", label: "Same item already in flight?", kind: "decision", description, wrap: true, x: 0, y: 0, w, h: 120, ...over }],
    });

  /** How far outside the diamond a run of text reaches: 0 when it is inside. */
  const overrun = (t: TextCmd, box: { x: number; y: number; w: number; h: number }) => {
    const width = approxTextWidth(t.text, t.size, t.font ?? "sans");
    const left = t.anchor === "middle" ? t.x - width / 2 : t.anchor === "end" ? t.x - width : t.x;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let worst = 0;
    for (const x of [left, left + width]) {
      for (const y of [t.y - t.size * 0.8, t.y + t.size * 0.2]) {
        worst = Math.max(worst, Math.abs(x - cx) / (box.w / 2) + Math.abs(y - cy) / (box.h / 2) - 1);
      }
    }
    return worst;
  };

  for (const mode of ["technical", "marketing"] as const) {
    for (const w of [170, 250, 400]) {
      it(`${mode}, ${w} wide: every line inside, none dropped`, () => {
        const t = question(w);
        const n = t.nodes[0]!;
        const runs = texts(emitTemplate(t, registry, {}, { mode }).cmds);
        const inside = runs.filter((r) => r.y > n.y && r.y < n.y + n.h + 20);
        expect(inside.length).toBeGreaterThan(2);
        for (const run of inside) expect(overrun(run, { x: n.x, y: n.y, w: n.w, h: n.h }), run.text).toBeLessThanOrEqual(0);
        // Every word of the description is there — the box was grown to hold
        // it, so no line was capped away.
        const drawn = inside.map((r) => r.text).join("").replace(/\s+/g, "");
        expect(drawn).toContain(description.replace(/\s+/g, ""));
      });
    }
  }

  it("a wrapped milestone's date sits in the middle, under the last line of its title", () => {
    const t = doc({
      nodes: [{ id: "m", label: "Public beta launch for every region", kind: "milestone", date: "2026-11-01", wrap: true, x: 0, y: 0, w: 170, h: 96 }],
    });
    const n = t.nodes[0]!;
    const runs = texts(emitTemplate(t, registry).cmds);
    const title = runs.filter((r) => r.size === 13);
    const chip = runs.find((r) => r.text.startsWith("Nov 1"))!;
    expect(title.length).toBeGreaterThan(1);
    // The chip's text is centred in its pill, so its middle is the pill's.
    const chipMid = chip.x + approxTextWidth(chip.text, chip.size, chip.font ?? "sans") / 2;
    expect(Math.abs(chipMid - (n.x + n.w / 2))).toBeLessThan(3);
    expect(chip.y).toBeGreaterThan(Math.max(...title.map((r) => r.y)));
    for (const run of [...title, chip]) expect(overrun(run, { x: n.x, y: n.y, w: n.w, h: n.h }), run.text).toBeLessThanOrEqual(0);
  });
});

// ─── 7. Chrome gets its own margin ───────────────────────────────────────────

describe("legend, title block and version tag never cover the drawing", () => {
  it("the legend sits right of every element, in reserved gutter", () => {
    const { cmds, width, originX } = emitTemplate(EXAMPLE_ZONED_TEMPLATE, registry);
    const legendLabel = texts(cmds).find((c) => c.text === "INFRASTRUCTURE")!;
    const contentRight = Math.max(
      ...EXAMPLE_ZONED_TEMPLATE.zones!.map((z) => z.x + z.w),
      ...EXAMPLE_ZONED_TEMPLATE.nodes.map((n) => n.x + n.w),
    );
    expect(legendLabel.x).toBeGreaterThan(contentRight);
    // And the page grew to hold it rather than being cropped around it.
    expect(legendLabel.x + originX).toBeLessThan(width);
  });

  it("the version tag sits above every element when the title block is there too", () => {
    const { cmds } = emitTemplate(EXAMPLE_ZONED_TEMPLATE, registry);
    const tag = texts(cmds).find((c) => c.text === "v2.1")!;
    const title = texts(cmds).find((c) => c.text === "Multi-cloud deployment")!;
    const contentTop = Math.min(
      ...EXAMPLE_ZONED_TEMPLATE.zones!.map((z) => z.y),
      ...EXAMPLE_ZONED_TEMPLATE.nodes.map((n) => n.y),
    );
    expect(title.y).toBeLessThan(contentTop);
    expect(tag.y).toBeLessThan(contentTop);
    expect(tag.y).toBeGreaterThan(title.y);
  });

  it("a document with no chrome is padded exactly as it always was", () => {
    const plain = doc({ nodes: [{ id: "a", label: "A", kind: "service", x: 0, y: 0, w: 170, h: 76 }] });
    const { width, height, originX, originY } = emitTemplate(plain, registry);
    expect([width, height, originX, originY]).toEqual([170 + 96, 76 + 96, 48, 48]);
  });
});

// ─── 8. Dates keep their year ────────────────────────────────────────────────

describe("exported dates carry the year", () => {
  it("a date chip in the current year still names it", () => {
    const thisYear = `${new Date().getFullYear()}-03-02`;
    const dated = doc({
      nodes: [{ id: "a", label: "A", kind: "service", date: thisYear, x: 0, y: 0, w: 170, h: 76 }],
    });
    const chip = texts(emitTemplate(dated, registry).cmds).find((c) => c.text.startsWith("Mar 2"))!;
    expect(chip.text).toBe(`Mar 2 ’${String(new Date().getFullYear() % 100).padStart(2, "0")}`);
  });
});

// ─── 9. React Flow JSON is the whole document ────────────────────────────────

describe("the React Flow export keeps everything", () => {
  it("provider-hidden nodes are present, and no edge is a collapse stand-in", async () => {
    const result = await BUILTIN_EXPORTERS.reactflow.run({
      template: EXAMPLE_ZONED_TEMPLATE,
      registry,
      filename: "d",
    });
    const rf = JSON.parse(await result!.blob.text()) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ id: string }>;
    };
    const ids = rf.nodes.map((n) => n.id);
    // All three alternatives, not just the active provider's.
    expect(ids).toEqual(expect.arrayContaining(["sql-az", "sql-aws", "sql-gcp"]));
    expect(rf.edges.map((e) => e.id)).toEqual(EXAMPLE_ZONED_TEMPLATE.edges.map((e) => e.id));
  });

  it("a collapsed group's contents come back too", async () => {
    const folded = validateTemplate({
      version: 1,
      nodes: [
        { id: "g", label: "G", kind: "group", collapsed: true, x: 0, y: 0, w: 400, h: 200 },
        { id: "a", label: "A", kind: "service", parentId: "g", x: 24, y: 48, w: 170, h: 76 },
      ],
      edges: [],
    } as unknown as DiagramTemplate) as DiagramTemplate;
    const result = await BUILTIN_EXPORTERS.reactflow.run({ template: folded, registry, filename: "d" });
    const rf = JSON.parse(await result!.blob.text()) as { nodes: Array<{ id: string }> };
    expect(rf.nodes.map((n) => n.id)).toContain("a");
  });
});

// ─── 10. C4-PlantUML ─────────────────────────────────────────────────────────

describe("C4-PlantUML renders", () => {
  it("a zoned document includes the library that defines Deployment_Node", () => {
    const out = renderTemplateToC4Puml(EXAMPLE_ZONED_TEMPLATE);
    expect(out).toContain("C4_Deployment.puml");
    // C4_Deployment includes C4_Container itself — including both redefines
    // every macro and PlantUML complains.
    expect(out.match(/!include/g)).toHaveLength(1);
  });

  it("a zoneless document keeps the lighter container library", () => {
    const flat = doc({ nodes: [{ id: "a", label: "A", kind: "service", x: 0, y: 0, w: 170, h: 76 }] });
    expect(renderTemplateToC4Puml(flat)).toContain("C4_Container.puml");
  });

  it("a zone and a node sharing an id get aliases of their own", () => {
    const clash = doc({
      zones: [{ id: "core", label: "Core", shape: "rounded", x: 0, y: 0, w: 600, h: 400, providers: ["aws"], provider: "aws" }],
      nodes: [{ id: "core", label: "Core service", kind: "service", zoneId: "core", x: 40, y: 60, w: 170, h: 76 }],
    });
    const out = renderTemplateToC4Puml(clash);
    expect(out).toContain('Container(core, "Core service")');
    expect(out).toContain('Deployment_Node(core_2, "Core", "aws")');
  });
});

// ─── 11. Mermaid ─────────────────────────────────────────────────────────────

describe("Mermaid stays parseable", () => {
  it("edge labels are quoted and folded onto one line", () => {
    const punctuated = doc({
      nodes: [
        { id: "a", label: "A", kind: "service", x: 0, y: 0, w: 170, h: 76 },
        { id: "b", label: "B", kind: "service", x: 400, y: 0, w: 170, h: 76 },
      ],
      edges: [{ id: "e", source: "a", target: "b", label: 'read (cached)\nvia "edge"' }],
    });
    const out = renderTemplateToMermaid(punctuated);
    expect(out).toContain(`a -->|"read (cached) via 'edge'"| b`);
    // One statement per edge, whatever the label contained.
    expect(out.split("\n").filter((l) => l.includes("-->"))).toHaveLength(1);
  });

  it("ids that are keywords, and ids that sanitise alike, stay apart", () => {
    const awkward = doc({
      nodes: [
        { id: "end", label: "Done", kind: "terminator", x: 0, y: 0, w: 160, h: 56 },
        { id: "api-v1", label: "v1", kind: "service", x: 200, y: 0, w: 170, h: 76 },
        { id: "api_v1", label: "v1 again", kind: "service", x: 400, y: 0, w: 170, h: 76 },
      ],
      edges: [{ id: "e", source: "api-v1", target: "api_v1", label: "" }],
    });
    const out = renderTemplateToMermaid(awkward);
    expect(out).toContain('n_end(["Done"])');
    expect(out).toContain('api_v1["v1"]');
    expect(out).toContain('api_v1_2["v1 again"]');
    expect(out).toContain("api_v1 --> api_v1_2");
  });

  it("a multi-line zone label stays inside its comment", () => {
    const wrapped = doc({
      zones: [{ id: "z", label: "West\nRegion", shape: "rounded", x: 0, y: 0, w: 600, h: 400, providers: ["aws"], provider: "aws" }],
      nodes: [{ id: "a", label: "A", kind: "service", zoneId: "z", x: 40, y: 60, w: 170, h: 76 }],
    });
    const out = renderTemplateToMermaid(wrapped);
    expect(out).toContain("%% zone: West Region on aws");
    expect(out.split("\n").every((l) => l.startsWith("%%") || !l.includes("Region"))).toBe(true);
  });
});

// ─── 13. Oversized diagrams ──────────────────────────────────────────────────

describe("rendering a diagram too big for one canvas", () => {
  const wide = (w: number) =>
    emitTemplate(doc({ nodes: [{ id: "a", label: "A", kind: "service", x: 0, y: 0, w, h: 400 }] }), registry);

  it("steps the oversampling down rather than failing", () => {
    // 9096 CSS px wide: 2x overshoots the 16384px dimension cap, 1.5x fits.
    emittedToCanvas(wide(9000));
    expect(canvases.at(-1)!.width).toBe(Math.ceil((9000 + 96) * 1.5));
  });

  it("keeps the full 2x when there is room for it", () => {
    emittedToCanvas(wide(1000));
    expect(canvases.at(-1)!.width).toBe((1000 + 96) * 2);
  });

  it("says what happened when even 1:1 will not fit", () => {
    expect(() => emittedToCanvas(wide(20000))).toThrow(/larger than a browser canvas can hold/);
    expect(() => emittedToCanvas(wide(20000))).toThrow(/SVG/);
  });
});

// ─── A card's top row, laid out as the canvas's flex row ─────────────────────

describe("a card's top row keeps the canvas's order and alignment", () => {
  const card = (extra: Record<string, unknown>) =>
    doc({ nodes: [{ id: "n", label: "Card", kind: "task", x: 0, y: 0, w: 260, h: 90, ...extra }] });
  /** The row's words, left to right as drawn. */
  const row = (t: DiagramTemplate, mode = "technical") => {
    const top = texts(emitTemplate(t, registry, {}, { mode: mode as "technical" }).cmds).filter((c) => c.size === 9 && c.tag?.id === "node:n");
    return top.sort((a, b) => a.x - b.x).map((c) => c.text);
  };

  it("a right-aligned task reads kind, then its pills — not the pills first", () => {
    expect(row(card({ textAlign: "right", priority: "p2", stage: "in-review" }))).toEqual(["TASK", "P2", "IN REVIEW"]);
  });

  it("a centred or right-aligned deprecated card keeps the word", () => {
    for (const textAlign of ["center", "right"]) {
      expect(row(doc({ nodes: [{ id: "n", label: "Old", kind: "service", status: "deprecated", textAlign, x: 0, y: 0, w: 260, h: 80 }] }))).toEqual([
        "SERVICE",
        " · DEPRECATED",
      ]);
    }
  });

  it("a marketing task's pills clear its estimate", () => {
    const { cmds } = emitTemplate(card({ storyPoints: 3, priority: "p1" }), registry, {}, { mode: "marketing" });
    const run = texts(cmds).find((c) => c.text === "3 PTS")!;
    const pill = texts(cmds).find((c) => c.text === "P1")!;
    // Bold capitals: at least the pill formula's width per glyph before the
    // pill's own edge, 5px left of its label.
    expect(pill.x - 5).toBeGreaterThanOrEqual(run.x + "3 PTS".length * 9 * 0.72);
  });
});
