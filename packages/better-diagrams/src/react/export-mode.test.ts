/**
 * The export's presentation mode.
 *
 * A picture has to say what the screen says. Everything the stylesheet's
 * "Marketing mode" block does — the gradient cards, the bigger type, the
 * labels it tucks away — has a counterpart in `makeSkin`, and these are the
 * assertions that the two stay one look rather than two.
 *
 * Also here: the legend box, whose padding is computed from named constants
 * that `padTop` has to agree with before anything is drawn.
 */
import { describe, expect, it } from "vitest";
import { createRegistry } from "./create-registry";
import { emitTemplate, drawToSvg, makeSkin, DARK_EXPORT_PALETTE, LIGHT_EXPORT_PALETTE, type DrawCmd, type ExportPalette } from "./draw";
import { BUILTIN_EXPORTERS, renderTemplateToCanvas, renderTemplateToSvg } from "./exporters";
import { EXAMPLE_ZONED_TEMPLATE, validateTemplate, type DiagramTemplate } from "../contract/schema";

const registry = createRegistry();
const doc = (partial: Record<string, unknown>) =>
  validateTemplate({ version: 1, edges: [], ...partial } as unknown as DiagramTemplate) as DiagramTemplate;

type TextCmd = Extract<DrawCmd, { op: "text" }>;
type PathCmd = Extract<DrawCmd, { op: "path" }>;
const texts = (cmds: DrawCmd[]) => cmds.filter((c): c is TextCmd => c.op === "text");
const paths = (cmds: DrawCmd[]) => cmds.filter((c): c is PathCmd => c.op === "path");

const CARD = doc({
  nodes: [
    { id: "a", label: "REST API", kind: "service", description: "Node / TypeScript", x: 0, y: 0 },
    { id: "b", label: "Redis", kind: "database", status: "deprecated", x: 320, y: 0 },
  ],
  edges: [{ id: "e", source: "a", target: "b", label: "read/write", tech: "SQL" }],
});

/** The same card with an icon, so the chip is emitted at all. */
const ICONED = doc({
  nodes: [{ id: "a", label: "REST API", kind: "service", icon: "box", x: 0, y: 0 }],
});

describe("export presentation mode", () => {
  it("defaults to technical, and an unknown mode does not half-apply a look", () => {
    const base = emitTemplate(CARD, registry);
    expect(emitTemplate(CARD, registry, {}, { mode: "technical" })).toEqual(base);
    // `resolveStudioMode` is what the host-facing wrappers coerce through.
    expect(renderTemplateToSvg(CARD, registry, {}, { mode: "nonsense" })).toEqual(
      renderTemplateToSvg(CARD, registry),
    );
  });

  it("marketing paints cards with a gradient; technical never does", () => {
    expect(paths(emitTemplate(CARD, registry).cmds).some((p) => p.gradient)).toBe(false);
    const mk = paths(emitTemplate(CARD, registry, {}, { mode: "marketing" }).cmds);
    expect(mk.some((p) => p.gradient)).toBe(true);
    expect(mk.some((p) => p.shadow)).toBe(true);
  });

  it("marketing tucks the kind eyebrow away but never a lifecycle status", () => {
    // Deprecated draws its eyebrow as two runs, so the status can wear salmon
    // while the kind keeps the accent.
    const tech = texts(emitTemplate(CARD, registry).cmds).map((t) => t.text);
    expect(tech).toContain("SERVICE");
    expect(tech).toContain("DATABASE");
    expect(tech).toContain(" · DEPRECATED");

    const mk = texts(emitTemplate(CARD, registry, {}, { mode: "marketing" }).cmds).map((t) => t.text);
    expect(mk).not.toContain("SERVICE");
    expect(mk.some((t) => t.includes("DATABASE"))).toBe(false);
    expect(mk).toContain("DEPRECATED");
  });

  it("marketing drops an edge's technology sub-label and sets its labels in sans", () => {
    const tech = texts(emitTemplate(CARD, registry).cmds);
    expect(tech.map((t) => t.text)).toContain("[SQL]");
    expect(tech.find((t) => t.text === "read/write")?.font).toBe("mono");

    const mk = texts(emitTemplate(CARD, registry, {}, { mode: "marketing" }).cmds);
    expect(mk.map((t) => t.text)).not.toContain("[SQL]");
    const label = mk.find((t) => t.text === "read/write");
    expect(label?.font).toBe("sans");
    expect(label?.size).toBe(13);
  });

  it("marketing steps the title up, but a node's own fontSize still wins", () => {
    const sized = doc({ nodes: [{ id: "a", label: "Sized", kind: "service", fontSize: 22, x: 0, y: 0 }] });
    const title = (t: DiagramTemplate, mode?: string) =>
      texts(emitTemplate(t, registry, {}, { mode: mode as never }).cmds).find((c) => c.text === "REST API" || c.text === "Sized");

    expect(title(CARD)?.size).toBe(13);
    expect(title(CARD, "marketing")?.size).toBe(16);
    expect(title(sized, "marketing")?.size).toBe(22);
  });

  it("marketing's icon chip inverts on a light palette: the tile, not the wash", () => {
    const gradientsOf = (palette: Partial<ExportPalette>) =>
      paths(emitTemplate(ICONED, registry, palette, { mode: "marketing" }).cmds)
        .map((p) => p.gradient)
        .filter((g): g is NonNullable<typeof g> => !!g);

    // On white the chip starts AT the surface — a pale tile over a tinted
    // card. Nothing else in the drawing does, so its presence is the assertion.
    expect(gradientsOf(LIGHT_EXPORT_PALETTE).map((g) => g.from)).toContain(LIGHT_EXPORT_PALETTE.surface);
    // Over the dark canvas it stays a pool of the kind's own hue instead.
    expect(gradientsOf({}).map((g) => g.from)).not.toContain("#0b1220");
  });

  it("gradients and shadows reach the SVG, with ids that survive being inlined together", () => {
    const emitted = emitTemplate(CARD, registry, LIGHT_EXPORT_PALETTE, { mode: "marketing" });
    const a = drawToSvg(emitted.cmds, { gridId: "view-a" });
    expect(a).toMatch(/<linearGradient id="view-a-d\d+"/);
    expect(a).toMatch(/<feDropShadow /);
    // Two views on one page must not collide on a url(#…).
    const b = drawToSvg(emitted.cmds, { gridId: "view-b" });
    const ids = (svg: string) => new Set(svg.match(/id="[^"]+"/g) ?? []);
    expect([...ids(a)].some((id) => ids(b).has(id))).toBe(false);
  });

  it("marketing drops a record's type column and required mark, and bands its header", () => {
    const table = doc({
      nodes: [
        {
          id: "t",
          label: "orders",
          kind: "table",
          x: 0,
          y: 0,
          fields: [
            { name: "id", type: "uuid", key: "pk", required: true },
            { name: "total", type: "numeric" },
          ],
        },
      ],
    });

    const tech = texts(emitTemplate(table, registry).cmds).map((t) => t.text);
    expect(tech).toContain("uuid");
    expect(tech).toContain("id*");

    const mk = texts(emitTemplate(table, registry, {}, { mode: "marketing" }).cmds).map((t) => t.text);
    expect(mk).not.toContain("uuid");
    expect(mk).not.toContain("id*");
    expect(mk).toContain("id");

    // The header band runs straight down and stops at 46px, so the rows below
    // it sit on flat colour rather than under a corner-to-corner wash.
    const band = paths(emitTemplate(table, registry, {}, { mode: "marketing" }).cmds).find((p) => p.gradient)!;
    expect(band.gradient!.x1).toBe(band.gradient!.x2);
    expect(band.gradient!.y2 - band.gradient!.y1).toBe(46);
  });

  it("the built-in picture exporters carry the mode through", async () => {
    const svg = BUILTIN_EXPORTERS.svg.run({
      template: CARD,
      registry,
      filename: "x",
      mode: "marketing",
    });
    const text = await (svg as { blob: Blob }).blob.text();
    expect(text).toMatch(/<linearGradient/);
    expect(text).not.toMatch(/\[SQL\]/);
  });
});

describe("marketing without gradients", () => {
  /** A card, a chip-bearing card, a collapsed group and a record: every fade the mode paints. */
  const EVERY_FADE = doc({
    nodes: [
      { id: "a", label: "REST API", kind: "service", icon: "box", x: 0, y: 0 },
      { id: "g", label: "Platform", kind: "group", collapsed: true, x: 320, y: 0 },
      { id: "t", label: "orders", kind: "table", x: 0, y: 200, fields: [{ name: "id", type: "uuid", key: "pk" }] },
    ],
  });
  const flat = (palette: Partial<ExportPalette> = {}) =>
    emitTemplate(EVERY_FADE, registry, palette, { mode: "marketing", gradients: false });
  const glossy = (palette: Partial<ExportPalette> = {}) =>
    emitTemplate(EVERY_FADE, registry, palette, { mode: "marketing" });

  it("emits no gradient at all, on either palette", () => {
    expect(paths(glossy().cmds).filter((p) => p.gradient).length).toBeGreaterThan(2);
    expect(paths(flat().cmds).some((p) => p.gradient)).toBe(false);
    expect(paths(flat(LIGHT_EXPORT_PALETTE).cmds).some((p) => p.gradient)).toBe(false);
  });

  it("is still the marketing dress: only the fills differ", () => {
    // Strip the paint from every path and the two are the same drawing —
    // shadows, corners, the bigger type and the tucked labels included.
    const strip = (cmds: DrawCmd[]) =>
      cmds.map((c) => (c.op === "path" ? { ...c, gradient: undefined, fill: undefined, fillAlpha: undefined } : c));
    expect(strip(flat().cmds)).toEqual(strip(glossy().cmds));
    expect(paths(flat().cmds).some((p) => p.shadow)).toBe(true);
    expect(texts(flat().cmds).find((t) => t.text === "REST API")?.size).toBe(16);
  });

  it("paints each fade as a flat hex where the gradient was", () => {
    const g = paths(glossy().cmds);
    const f = paths(flat().cmds);
    expect(f.length).toBe(g.length);
    g.forEach((p, i) => {
      if (!p.gradient) return;
      expect(f[i].gradient).toBeUndefined();
      expect(f[i].fill).toMatch(/^#[0-9a-f]{6}$/);
    });
  });

  it("the flat coat sits a quarter of the way from the fade's pale end, like `--as-mk-flat`", () => {
    const box = { x: 0, y: 0, width: 100, height: 50 };
    const ends = makeSkin("marketing", DARK_EXPORT_PALETTE).card("#38bdf8", box).gradient!;
    const coat = makeSkin("marketing", DARK_EXPORT_PALETTE, false).card("#38bdf8", box);
    const channel = (hex: string, i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
    // 25% of the tinted end, 75% of the pale one — lighter than the midpoint.
    const wash = [1, 3, 5]
      .map((i) => Math.round(channel(ends.from, i) * 0.25 + channel(ends.to, i) * 0.75).toString(16).padStart(2, "0"))
      .join("");
    expect(coat.gradient).toBeUndefined();
    expect(coat.fill).toBe(`#${wash}`);
    // The chip's coat too, on the palette where the chip inverts.
    const chip = makeSkin("marketing", LIGHT_EXPORT_PALETTE, false).iconChip("#38bdf8", 0, 0, 36);
    expect(chip.gradient).toBeUndefined();
    expect(chip.fill).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("technical is untouched by the setting, and gradients default on", () => {
    const base = emitTemplate(EVERY_FADE, registry);
    expect(emitTemplate(EVERY_FADE, registry, {}, { gradients: false })).toEqual(base);
    expect(emitTemplate(EVERY_FADE, registry, {}, { mode: "marketing", gradients: true })).toEqual(glossy());
  });

  it("reaches the SVG and both HTML pages through the built-in exporters", async () => {
    const ctx = { template: EVERY_FADE, registry, filename: "x", mode: "marketing", gradients: false };
    const svg = await (BUILTIN_EXPORTERS.svg.run(ctx) as { blob: Blob }).blob.text();
    expect(svg).not.toMatch(/<linearGradient/);
    expect(svg).toMatch(/<feDropShadow /);
    const html = await (BUILTIN_EXPORTERS.html.run(ctx) as { blob: Blob }).blob.text();
    expect(html).not.toMatch(/<linearGradient/);
    // The drilling page pre-renders one SVG per level; the switch has to
    // reach every one of them.
    const nested = doc({
      nodes: [
        { id: "g", label: "Platform", kind: "group", x: 0, y: 0, w: 400, h: 200 },
        { id: "a", label: "API", kind: "service", parentId: "g", x: 20, y: 40 },
      ],
    });
    const drilled = await (BUILTIN_EXPORTERS.html.run({ ...ctx, template: nested }) as { blob: Blob }).blob.text();
    expect(drilled).toMatch(/as-grid-v1/);
    expect(drilled).not.toMatch(/<linearGradient/);
  });

  it("reaches the canvas, which PNG and PDF replay", () => {
    // A context that swallows every call and counts the one that matters.
    let gradients = 0;
    const fakeContext = new Proxy({} as Record<string, unknown>, {
      get: (target, key) =>
        key === "createLinearGradient"
          ? () => {
              gradients += 1;
              return { addColorStop() {} };
            }
          : key in target
            ? target[key as string]
            : () => undefined,
      set: (target, key, value) => {
        target[key as string] = value;
        return true;
      },
    });
    const priorDocument = (globalThis as { document?: unknown }).document;
    const priorPath2D = (globalThis as { Path2D?: unknown }).Path2D;
    (globalThis as { Path2D?: unknown }).Path2D = class {
      constructor(readonly d: string) {}
    };
    (globalThis as { document?: unknown }).document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => fakeContext }),
    };
    try {
      renderTemplateToCanvas(EVERY_FADE, registry, 2, {}, { mode: "marketing" });
      expect(gradients).toBeGreaterThan(2);
      gradients = 0;
      renderTemplateToCanvas(EVERY_FADE, registry, 2, {}, { mode: "marketing", gradients: false });
      expect(gradients).toBe(0);
    } finally {
      (globalThis as { document?: unknown }).document = priorDocument;
      (globalThis as { Path2D?: unknown }).Path2D = priorPath2D;
    }
  });
});

describe("the export legend", () => {
  /** `roundedRectPath`'s own point order, read back. */
  const rectOf = (d: string) => {
    const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const [xr, y, , r] = n;
    return { x: xr - r, y, right: n[8], bottom: n[17] };
  };
  const legendBox = (cmds: DrawCmd[]) => {
    const i = cmds.findIndex((c) => c.op === "text" && c.text === "INFRASTRUCTURE");
    expect(i).toBeGreaterThan(0);
    return { box: rectOf((cmds[i - 1] as PathCmd).d), title: cmds[i] as TextCmd, at: i };
  };

  const emitted = emitTemplate(EXAMPLE_ZONED_TEMPLATE, registry);
  const { box, title, at } = legendBox(emitted.cmds);
  // Page coordinates: the emitter's origin is what lands content at the pad.
  const pageX = (x: number) => x + emitted.originX;
  const pageY = (y: number) => y + emitted.originY;

  it("sits a full inset in from the page corner, not hard against it", () => {
    expect(pageY(box.y)).toBe(16);
    expect(emitted.width - pageX(box.right)).toBe(16);
  });

  it("pads its contents evenly, top and bottom", () => {
    const rows = texts(emitted.cmds.slice(at)).filter((t) => t.size === 11);
    expect(rows.length).toBeGreaterThan(0);
    const last = rows.at(-1)!;
    // The title's cap sits one pad below the top; the last row's baseline
    // leaves at least as much beneath it. Before, it had one pixel.
    const above = title.y - 9 - box.y;
    const below = box.bottom - last.y;
    expect(above).toBe(12);
    expect(below).toBeGreaterThanOrEqual(above - 1);
  });

  it("reserves its own headroom, so it never hangs into the drawing", () => {
    const tall = validateTemplate({
      ...EXAMPLE_ZONED_TEMPLATE,
      zones: ["aws", "azure", "gcp", "onprem", "saas"].map((provider, i) => ({
        id: `z${i}`,
        label: provider,
        provider,
        x: i * 260,
        y: 0,
        w: 240,
        h: 160,
      })),
      nodes: ["aws", "azure", "gcp", "onprem", "saas"].map((provider, i) => ({
        id: `n${i}`,
        label: provider,
        kind: "service",
        x: i * 260 + 20,
        y: 40,
        zone: `z${i}`,
      })),
      edges: [],
    } as unknown as DiagramTemplate) as DiagramTemplate;
    const out = emitTemplate(tall, registry);
    const { box: big } = legendBox(out.cmds);
    // Everything above y=0 in page space is reserved margin; the box lives
    // entirely inside it.
    expect(big.bottom + out.originY).toBeLessThanOrEqual(out.originY);
  });
});
