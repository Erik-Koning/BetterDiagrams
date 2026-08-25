/**
 * The interactive HTML export: element tagging in the SVG backend, effective-
 * day inheritance, and the page the builder produces. All string assertions —
 * the emitters and the builder are DOM-free by design, and these tests prove
 * that stays true.
 */
import { describe, expect, it } from "vitest";
import { emitTemplate, drawToSvg } from "./draw";
import { emitSequence } from "./sequence-draw";
import { buildTimelineHtml } from "./html-export";
import {
  BUILTIN_EXPORTERS,
  renderTemplateToC4Puml,
  renderTemplateToMermaid,
  renderTemplateToSvg,
} from "./exporters";
import { BUILTIN_SEQUENCE_EXPORTERS } from "./sequence-exporters";
import { createRegistry } from "./create-registry";
import { EXAMPLE_TEMPLATE, EXAMPLE_ZONED_TEMPLATE, validateTemplate } from "../contract/schema";
import { validateSequence } from "../contract/sequence";
import { dateToDay, templateTimeline } from "../contract/timeline";

const registry = createRegistry();

describe("SVG element tagging", () => {
  const svg = drawToSvg(emitTemplate(EXAMPLE_ZONED_TEMPLATE, registry).cmds);

  it("groups a dated node's commands under its effective day", () => {
    expect(svg).toContain(`data-el="node:wrk" data-day="${dateToDay("2026-06-15")}"`);
    expect(svg).toContain(`data-el="node:pay" data-day="${dateToDay("2026-09-30")}"`);
  });

  it("tags undated elements without a day", () => {
    // The CDN has no date — present at every cursor, so no day to compare.
    expect(svg).toMatch(/data-el="node:cdn"(?! data-day)/);
  });

  it("gives an edge the later of its endpoints", () => {
    // z7 (queue → worker) carries no date of its own; both ends land Jun 15.
    expect(svg).toContain(`data-el="edge:z7" data-day="${dateToDay("2026-06-15")}"`);
  });

  it("tags a dated zone with its own day", () => {
    expect(svg).toContain(`data-el="zone:vendor" data-day="${dateToDay("2026-09-30")}"`);
  });

  it("cascades a container's date onto its children", () => {
    const t = validateTemplate({
      version: 1,
      nodes: [
        { id: "g", label: "G", kind: "group", icon: "none", description: "", parentId: null, date: "2026-06-15", x: 0, y: 0, w: 400, h: 300 },
        { id: "inner", label: "I", kind: "service", icon: "box", description: "", parentId: "g", x: 30, y: 60, w: 170, h: 76 },
      ],
      edges: [],
    });
    const out = drawToSvg(emitTemplate(t, registry).cmds);
    expect(out).toContain(`data-el="node:inner" data-day="${dateToDay("2026-06-15")}"`);
  });

  it("balances every group it opens", () => {
    // Icon paths carry their own single-line `<g transform>…</g>` wrappers, so
    // the balance check is over ALL group tags, not just the element ones.
    const opens = (svg.match(/<g[ >]/g) ?? []).length;
    const closes = (svg.match(/<\/g>/g) ?? []).length;
    expect((svg.match(/<g class="bd-el"/g) ?? []).length).toBeGreaterThan(0);
    expect(closes).toBe(opens);
  });
});

describe("sequence SVG tagging", () => {
  const seq = validateSequence({
    version: 1,
    participants: [
      { id: "u", label: "User", kind: "actor" },
      { id: "led", label: "Ledger", kind: "database", date: "2026-06-15" },
    ],
    messages: [{ id: "m1", from: "u", to: "led", label: "post", style: "sync" }],
    activations: [{ id: "a1", participant: "led", from: "m1" }],
    notes: [{ id: "n1", text: "hi", side: "right", participant: "led" }],
  });
  const svg = drawToSvg(emitSequence(seq).cmds);
  const jun = dateToDay("2026-06-15");

  it("tags participants, and messages inherit the later participant", () => {
    expect(svg).toContain(`data-el="participant:led" data-day="${jun}"`);
    expect(svg).toContain(`data-el="message:m1" data-day="${jun}"`);
  });

  it("anchored constructs inherit from what they anchor to", () => {
    expect(svg).toContain(`data-el="activation:a1" data-day="${jun}"`);
    expect(svg).toContain(`data-el="note:n1" data-day="${jun}"`);
  });
});

describe("buildTimelineHtml", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><g class="bd-el" data-el="node:a" data-day="20620"></g></svg>`;
  const dated = buildTimelineHtml({
    svg,
    title: "Roadmap <2026> & beyond",
    stops: ["2026-03-02", "2026-06-15"],
  });

  it("is one self-contained page: svg, styles, and the player inline", () => {
    expect(dated).toContain("<!DOCTYPE html>");
    expect(dated).toContain(svg);
    expect(dated).toContain("<style>");
    expect(dated).toContain("<script>");
    // Self-contained means NO external references of any kind.
    expect(dated).not.toMatch(/src="http|href="http|@import/);
  });

  it("escapes the title but embeds the stops verbatim", () => {
    expect(dated).toContain("Roadmap &lt;2026&gt; &amp; beyond");
    expect(dated).toContain('["2026-03-02","2026-06-15"]');
  });

  it("announces dates, not raw day numbers, from the slider", () => {
    // The slider's value is an epoch day; without aria-valuetext a screen
    // reader reads "20567" where a sighted user reads "Mar 14".
    expect(dated).toContain('range.setAttribute("aria-valuetext", fmt(cursor))');
  });

  it("carries the scrubber, menu, date picker, and fullscreen controls", () => {
    for (const marker of [
      'id="bd-timeline"',
      'id="bd-range"',
      'id="bd-date"',
      'id="bd-datepick"',
      "Ghost later",
      "Hide later",
      "Fit to window",
      'id="bd-full"',
      'id="bd-menu"',
    ]) {
      expect(dated).toContain(marker);
    }
  });

  it("omits the timeline entirely for an undated document", () => {
    const plain = buildTimelineHtml({ svg, title: "Plain", stops: [] });
    expect(plain).not.toContain('id="bd-timeline"');
    expect(plain).not.toContain("Ghost later");
    // The viewer chrome stays.
    expect(plain).toContain('id="bd-full"');
    expect(plain).toContain("Fit to window");
  });
});

describe("the html exporter", () => {
  it("is registered in both sets and demands the full document", () => {
    expect(BUILTIN_EXPORTERS.html.fullDocument).toBe(true);
    expect(BUILTIN_SEQUENCE_EXPORTERS.html.fullDocument).toBe(true);
  });

  it("splits the exporter sets by intent: pictures slice, documents never do", () => {
    // Picture and communication formats show what is on screen — a PNG of the
    // June view should look like June.
    for (const key of ["png", "pdf", "svg", "mermaid", "c4puml"]) {
      expect(BUILTIN_EXPORTERS[key].fullDocument, key).toBeUndefined();
    }
    for (const key of ["png", "pdf", "svg", "mermaid", "plantuml"]) {
      expect(BUILTIN_SEQUENCE_EXPORTERS[key].fullDocument, `seq ${key}`).toBeUndefined();
    }
    // Round-trip formats never slice: "export → save to database" while
    // scrubbed must not silently delete everything the cursor was hiding.
    for (const key of ["html", "template", "reactflow", "content", "layout"]) {
      expect(BUILTIN_EXPORTERS[key].fullDocument, key).toBe(true);
    }
    for (const key of ["html", "json"]) {
      expect(BUILTIN_SEQUENCE_EXPORTERS[key].fullDocument, `seq ${key}`).toBe(true);
    }
  });

  it("produces a page whose stops match the document", async () => {
    const result = await BUILTIN_EXPORTERS.html.run({
      template: EXAMPLE_ZONED_TEMPLATE,
      registry,
      filename: "arch",
    });
    expect(result?.filename).toBe("arch.html");
    const text = await result!.blob.text();
    expect(text).toContain(JSON.stringify(templateTimeline(EXAMPLE_ZONED_TEMPLATE).stops));
    expect(text).toContain("Multi-cloud deployment");
    expect(text).toContain("data-day");
  });

  it("exports an undated document as a plain viewer", async () => {
    const result = await BUILTIN_EXPORTERS.html.run({
      template: EXAMPLE_TEMPLATE,
      registry,
      filename: "plain",
    });
    const text = await result!.blob.text();
    expect(text).not.toContain('id="bd-timeline"');
  });
});

describe("buildMultiViewHtml — the drill-down page", () => {
  const registry = createRegistry();

  /** Card parent with detail + an outsider — two views plus the root. */
  const DOC = validateTemplate({
    version: 1,
    meta: { title: "Drill export" },
    nodes: [
      { id: "web", label: "Storefront", kind: "service", icon: "globe", description: "", parentId: null, x: 100, y: 100, w: 170, h: 76 },
      { id: "pay", label: "Payments", kind: "service", icon: "box", description: "", parentId: null, x: 500, y: 100, w: 170, h: 76 },
      { id: "api", label: "Pay API", kind: "service", icon: "box", description: "", parentId: "pay", x: 28, y: 52, w: 170, h: 76 },
    ],
    edges: [{ id: "buys", source: "web", target: "api", label: "buys", style: "solid", color: "sky" }],
  });

  it("emits one section per level with distinct grid ids and nav plumbing", async () => {
    const result = await BUILTIN_EXPORTERS.html.run({
      template: DOC,
      registry,
      filename: "drill",
    });
    const text = await result!.blob.text();

    // One section per view: the root plus the one drillable parent.
    expect(text.match(/<section class="bd-view"/g)).toHaveLength(2);
    expect(text).toContain('data-view=""');
    expect(text).toContain('data-view="pay"');
    // Every inlined SVG keeps its own dot-grid pattern.
    expect(text).toContain('id="as-grid-v0"');
    expect(text).toContain('id="as-grid-v1"');
    expect(text.match(/id="as-grid-v0"/g)).toHaveLength(1);
    // Crumb bar, drill map, hash router, and the derived elements.
    expect(text).toContain('id="bd-crumbbar"');
    expect(text).toContain('"drills"');
    expect(text).toContain("hashchange");
    expect(text).toContain("node:boundary:pay");
    expect(text).toContain("node:ghost:web");
    // Still fully self-contained.
    expect(text).not.toMatch(/src="http|href="http|@import/);
  });

  it("keeps the flat-document page byte-identical to the single-view builder", async () => {
    const flat = validateTemplate({
      version: 1,
      meta: { title: "Flat" },
      nodes: [
        { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 },
      ],
      edges: [],
    });
    const result = await BUILTIN_EXPORTERS.html.run({ template: flat, registry, filename: "flat" });
    const text = await result!.blob.text();
    const direct = buildTimelineHtml({
      svg: renderTemplateToSvg(flat, registry, {}),
      title: "Flat",
      stops: [],
    });
    expect(text).toBe(direct);
    expect(text).not.toContain("bd-crumbbar");
  });

  it("mermaid and c4puml project drill detail onto its card", () => {
    const mermaid = renderTemplateToMermaid(DOC);
    expect(mermaid).not.toContain("Pay API");
    // Re-anchored onto the card — and since it is the ONLY edge landing on
    // that pair, it still says what it does (see `onlyEdgeBetween`).
    expect(mermaid).toContain("web -->|buys| pay");
    const puml = renderTemplateToC4Puml(DOC);
    expect(puml).not.toContain("Pay API");
    expect(puml).toContain("Rel(web, pay");
  });
});
