import { describe, expect, it } from "vitest";
import { createRegistry as resolveRegistry } from "./create-registry";
import { kindDef, iconPaths, zoneFill, zoneInk } from "./registry-types";
import { silhouettePath } from "./shapes";
import { LIGHT_THEME, themeToStyle } from "./theme";
import {
  emitTemplate,
  renderTemplateToC4Puml,
  renderTemplateToMermaid,
  renderTemplateToSvg,
  LIGHT_EXPORT_PALETTE,
} from "./exporters";
import {
  EXAMPLE_TEMPLATE,
  EXAMPLE_ZONED_TEMPLATE,
  validateTemplate,
  type DiagramTemplate,
} from "../contract/schema";

describe("resolveRegistry", () => {
  it("returns the built-ins when given nothing", () => {
    const r = resolveRegistry();
    expect(r.kindOrder).toContain("service");
    expect(r.containerKinds).toEqual(["group"]);
    expect(r.annotationKinds).toEqual(["text"]);
    expect(r.exporterOrder).toContain("png");
  });

  it("adds a new kind with only the fields that differ from the fallback", () => {
    const r = resolveRegistry({ nodeKinds: { lambda: { accent: "#f59e0b", icon: "bolt" } } });
    const def = kindDef(r, "lambda");
    expect(def.accent).toBe("#f59e0b");
    expect(def.icon).toBe("bolt");
    // Label is derived from the key when not supplied.
    expect(def.label).toBe("Lambda");
    expect(r.kindOrder).toContain("lambda");
  });

  it("partially overrides a built-in without erasing its other fields", () => {
    const r = resolveRegistry({ nodeKinds: { service: { accent: "#ff0000" } } });
    const def = kindDef(r, "service");
    expect(def.accent).toBe("#ff0000");
    expect(def.label).toBe("Service");
    expect(def.icon).toBe("box");
  });

  it("removes a built-in when given null", () => {
    const r = resolveRegistry({ nodeKinds: { queue: null }, exporters: { pdf: null } });
    expect(r.kindOrder).not.toContain("queue");
    expect(r.exporterOrder).not.toContain("pdf");
    expect(r.exporters.pdf).toBeUndefined();
  });

  it("orders kinds: built-ins, then cloud packs, then extensions", () => {
    const r = resolveRegistry({ nodeKinds: { zeta: {}, alpha: {} } });
    expect(r.kindOrder.slice(0, 13)).toEqual([
      "service",
      "database",
      "queue",
      "gateway",
      "client",
      "external",
      "table",
      "group",
      "text",
      "decision",
      "terminator",
      "io",
      "point",
    ]);
    // The cloud pack kinds sit between built-ins and extensions.
    expect(r.kindOrder[13]).toBe("aws-lambda");
    expect(r.kindOrder.slice(-2)).toEqual(["zeta", "alpha"]);
  });

  it("registers a container extension so nesting works for it", () => {
    const r = resolveRegistry({ nodeKinds: { region: { container: true } } });
    expect(r.containerKinds).toContain("region");
  });

  it("adds and removes icons", () => {
    const r = resolveRegistry({ icons: { spark: ["M0 0 L10 10"], gear: null } });
    expect(iconPaths(r, "spark")).toEqual(["M0 0 L10 10"]);
    expect(iconPaths(r, "gear")).toBeUndefined();
    expect(r.iconNames).toContain("spark");
    expect(r.iconNames).not.toContain("gear");
  });

  it("always resolves 'none' to no glyph", () => {
    expect(iconPaths(resolveRegistry(), "none")).toBeUndefined();
  });

  it("falls back to a neutral definition for an unregistered kind", () => {
    expect(kindDef(resolveRegistry(), "never-registered").label).toBe("Node");
  });

  it("registers a custom exporter and lists it after the built-ins", () => {
    const r = resolveRegistry({
      exporters: {
        terraform: {
          label: "Terraform",
          run: () => ({ blob: new Blob(["x"]), filename: "main.tf" }),
        },
      },
    });
    expect(r.exporterOrder.at(-1)).toBe("terraform");
    expect(r.exporters.terraform.label).toBe("Terraform");
  });

  it("registers a custom lint rule and removes a built-in", () => {
    const r = resolveRegistry({
      lintRules: {
        "min-nodes": { label: "Minimum size", severity: "info", check: () => [] },
        "no-orphans": null,
      },
    });
    expect(r.lintRules["min-nodes"].label).toBe("Minimum size");
    expect(r.lintRules["no-orphans"]).toBeUndefined();
    expect(r.lintRules["no-cycles"]).toBeDefined();
  });

  it("registers the cloud packs as provider-tagged built-ins", () => {
    const r = resolveRegistry();
    expect(r.nodeKinds["aws-lambda"]).toMatchObject({ label: "Lambda", provider: "aws" });
    expect(r.nodeKinds["azure-cosmos"]).toMatchObject({ provider: "azure", shape: "cylinder" });
    expect(r.nodeKinds["gcp-pubsub"]).toMatchObject({ provider: "gcp", shape: "pipe" });
    // Generic kinds carry no provider tag — that's what the UI filters on.
    expect(r.nodeKinds.service.provider).toBeUndefined();
  });

  it("lets an extension override or remove a cloud kind like any builtin", () => {
    const r = resolveRegistry({
      nodeKinds: { "aws-lambda": { label: "λ" }, "gcp-cdn": null },
    });
    expect(r.nodeKinds["aws-lambda"]).toMatchObject({ label: "λ", provider: "aws" });
    expect(r.kindOrder).not.toContain("gcp-cdn");
    expect("gcp-cdn" in r.nodeKinds).toBe(false);
  });

  it("does not mutate the built-in tables across calls", () => {
    resolveRegistry({ nodeKinds: { service: { accent: "#000" }, temp: {} } });
    const clean = resolveRegistry();
    expect(kindDef(clean, "service").accent).toBe("#38bdf8");
    expect(clean.kindOrder).not.toContain("temp");
  });
});

describe("text exporters", () => {
  it("produces mermaid with subgraphs for containers", () => {
    const out = renderTemplateToMermaid(EXAMPLE_TEMPLATE);
    expect(out).toMatch(/^flowchart LR/);
    expect(out).toContain("subgraph vpc");
    expect(out).toContain("end");
    // Async edges use the dotted arrow form.
    expect(out).toContain("-.->");
    // Annotations are not flowchart nodes.
    expect(out).not.toContain("note[");
  });

  it("exports flow-chart kinds by their shapes, self-loops included", () => {
    const doc = {
      version: 1 as const,
      nodes: [
        { id: "start", label: "Start", kind: "terminator", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 160, h: 56 },
        { id: "ask", label: "Approved?", kind: "decision", icon: "none", description: "", parentId: null, x: 0, y: 150, w: 170, h: 100 },
        { id: "form", label: "Read form", kind: "io", icon: "none", description: "", parentId: null, x: 300, y: 150, w: 180, h: 70 },
      ],
      edges: [
        { id: "e1", source: "start", target: "ask", label: "", style: "solid" as const, color: "slate" as const },
        { id: "e2", source: "ask", target: "ask", label: "retry", style: "solid" as const, color: "slate" as const },
      ],
    };
    const mermaid = renderTemplateToMermaid(doc);
    expect(mermaid).toContain('start(["Start"])');
    expect(mermaid).toContain('ask{"Approved?"}');
    expect(mermaid).toContain('form[/"Read form"/]');
    // The retry loop survives as a self-edge.
    expect(mermaid).toContain("ask -->|retry| ask");
  });

  it("cuts flow-chart silhouettes the canvas and exports share", () => {
    expect(silhouettePath("diamond", 0, 0, 100, 60).body).toBe("M 50 0 L 100 30 L 50 60 L 0 30 Z");
    expect(silhouettePath("parallelogram", 0, 0, 100, 60).body).toBe("M 16 0 H 100 L 84 60 H 0 Z");
  });

  it("exports a dangling arrow as a dot in mermaid, and not at all in C4", () => {
    const doc = {
      version: 1 as const,
      nodes: [
        { id: "api", label: "API", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 },
        { id: "db", label: "DB", kind: "database", icon: "database", description: "", parentId: null, x: 300, y: 0, w: 170, h: 76 },
        { id: "pt", label: "", kind: "point", icon: "none", description: "", parentId: null, x: 400, y: 200, w: 12, h: 12 },
      ],
      edges: [
        { id: "e1", source: "api", target: "db", label: "reads", style: "solid" as const, color: "slate" as const },
        { id: "e2", source: "api", target: "pt", label: "future", style: "dashed" as const, color: "slate" as const },
      ],
    };
    const mermaid = renderTemplateToMermaid(doc);
    // The dot is mermaid's smallest circle; the arrow to it survives.
    expect(mermaid).toContain('pt((" "))');
    expect(mermaid).toContain("api -.->|future| pt");

    // C4 is a strict semantic model: no dot, no dangling Rel — but the rest
    // of the diagram is untouched.
    const puml = renderTemplateToC4Puml(doc);
    expect(puml).not.toContain("pt");
    expect(puml).toContain('Rel(api, db, "reads")');
  });

  it("exports cloud kinds by their silhouette — DynamoDB is a cylinder, SQS a pipe", () => {
    const doc = {
      version: 1 as const,
      nodes: [
        { id: "t", label: "Orders", kind: "aws-dynamodb", icon: "database", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 },
        { id: "q", label: "Jobs", kind: "aws-sqs", icon: "layers", description: "", parentId: null, x: 200, y: 0, w: 170, h: 76 },
        { id: "fn", label: "Worker", kind: "aws-lambda", icon: "bolt", description: "", parentId: null, x: 400, y: 0, w: 170, h: 76 },
      ],
      edges: [],
    };
    const mermaid = renderTemplateToMermaid(doc);
    expect(mermaid).toContain('t[("Orders")]');
    expect(mermaid).toContain('q[["Jobs"]]');
    expect(mermaid).toContain('fn["Worker"]');

    const puml = renderTemplateToC4Puml(doc);
    expect(puml).toContain('ContainerDb(t, "Orders")');
    expect(puml).toContain('ContainerQueue(q, "Jobs")');
    expect(puml).toContain('Container(fn, "Worker")');
  });

  it("escapes quotes in labels so the mermaid stays parseable", () => {
    const out = renderTemplateToMermaid({
      version: 1,
      nodes: [
        { id: "a", label: 'The "Main" API', kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 },
      ],
      edges: [],
    });
    expect(out).not.toMatch(/"The "Main" API"/);
    expect(out).toContain("'Main'");
  });

  it("produces SVG with escaped markup in labels", () => {
    const svg = renderTemplateToSvg(
      {
        version: 1,
        nodes: [
          { id: "a", label: "<script>x</script>", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 },
        ],
        edges: [],
      },
      resolveRegistry(),
    );
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
  });

  it("maps the example diagram to C4-PlantUML", () => {
    const out = renderTemplateToC4Puml(EXAMPLE_ZONED_TEMPLATE);
    expect(out).toMatch(/^@startuml/);
    expect(out.trimEnd()).toMatch(/@enduml$/);
    expect(out).toContain("C4_Container.puml");
    expect(out).toContain('title Multi-cloud deployment');
    // Kinds map to C4 macros; zones become deployment nodes.
    expect(out).toContain('ContainerDb(sql_az, "Azure SQL"');
    expect(out).toContain('Deployment_Node(region, "Cloud Region", "azure")');
    // The active provider filters: only the Azure DB exports.
    expect(out).not.toContain("sql_aws");
    // Relations carry labels; edge lines reference sanitised aliases.
    expect(out).toContain('Rel(cdn, api, "HTTPS")');
  });

  it("emits BiRel, tech, and seq in C4-PlantUML relations", () => {
    const out = renderTemplateToC4Puml({
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 },
        { id: "b", label: "B", kind: "service", icon: "box", description: "", parentId: null, x: 300, y: 0, w: 170, h: 76 },
      ],
      edges: [
        { id: "e", source: "a", target: "b", label: "sync", style: "solid", color: "slate", tech: "gRPC", direction: "both", seq: 2 },
      ],
    });
    expect(out).toContain('BiRel(a, b, "2. sync", "gRPC")');
  });

  it("palette changes recolor the export without changing its structure", () => {
    // The IR guarantee: light vs dark differ ONLY in colours — identical
    // command stream shape, so the layouts can never diverge.
    const registry = resolveRegistry();
    const dark = emitTemplate(EXAMPLE_ZONED_TEMPLATE, registry);
    const light = emitTemplate(EXAMPLE_ZONED_TEMPLATE, registry, LIGHT_EXPORT_PALETTE);
    expect(light.cmds.length).toBe(dark.cmds.length);
    expect(light.cmds.map((c) => c.op)).toEqual(dark.cmds.map((c) => c.op));
    expect(light.width).toBe(dark.width);

    const svg = renderTemplateToSvg(EXAMPLE_ZONED_TEMPLATE, registry, LIGHT_EXPORT_PALETTE);
    // Light page background, no dark surfaces left. (Careful: `#0f172a` still
    // appears legitimately — it is the light palette's TEXT colour.)
    expect(svg).toContain('fill="#f8fafc"');
    expect(svg).not.toContain('fill="#0b1220"');
    expect(svg).not.toContain('fill="#1e293b"');
  });

  it("renders owning-team pills into image exports", () => {
    const svg = renderTemplateToSvg(EXAMPLE_ZONED_TEMPLATE, resolveRegistry());
    // The REST API node's team from the example document.
    expect(svg).toContain(">Platform</text>");
  });

  it("stamps the version tag and status conventions into image exports", () => {
    const svg = renderTemplateToSvg(EXAMPLE_ZONED_TEMPLATE, resolveRegistry());
    expect(svg).toContain(">v2.1</text>");
    // Redis is deprecated in the example — the eyebrow spells the stage out.
    // The eyebrow is now two segments — the kind in the accent, the status
    // token in salmon — so the two halves assert separately.
    expect(svg).toContain("DATABASE");
    expect(svg).toContain("· DEPRECATED");
  });

  it("centres and wraps a node's label in image exports, matching the canvas", () => {
    const label = "A deliberately long component label that will not fit on one line";
    const doc = validateTemplate({
      nodes: [
        { id: "n", label, kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76, textAlign: "center", wrap: true },
      ],
      edges: [],
    }) as DiagramTemplate;
    const svg = renderTemplateToSvg(doc, resolveRegistry());

    // Centred text is emitted with an anchor rather than a shifted x, so the
    // canvas and the export cannot drift apart as the label changes.
    expect(svg).toContain('text-anchor="middle"');
    // Wrapped, so the label arrives as several <text> runs rather than one
    // ellipsised line — and nothing is elided.
    expect(svg).not.toContain("…");
    expect(svg).toContain("deliberately");
    expect(svg).toContain("line</text>");
  });

  it("right-aligns with an end anchor", () => {
    const doc = validateTemplate({
      nodes: [
        { id: "n", label: "Ledger", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76, textAlign: "right" },
      ],
      edges: [],
    }) as DiagramTemplate;
    expect(renderTemplateToSvg(doc, resolveRegistry())).toContain('text-anchor="end"');
  });

  it("omits a transparent group's frame entirely from image exports", () => {
    const group = (over: Record<string, unknown>): DiagramTemplate =>
      validateTemplate({
        nodes: [
          { id: "g", label: "Payments", kind: "group", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 320, h: 240, ...over },
        ],
        edges: [],
      }) as DiagramTemplate;
    const registry = resolveRegistry();

    // The default frame draws both layers.
    const normal = renderTemplateToSvg(group({}), registry);
    expect(normal).toContain("stroke-dasharray");

    // An abstract grouping box must not reappear in the PNG — no border, no
    // wash, just the label chip that makes it selectable.
    const invisible = renderTemplateToSvg(group({ fill: false, outline: "none" }), registry);
    expect(invisible).not.toContain("stroke-dasharray");
    expect(invisible).toContain(">Payments</text>");
  });

  it("draws a container frame in its own colour when one is set", () => {
    const doc = validateTemplate({
      nodes: [
        { id: "g", label: "Payments", kind: "group", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 320, h: 240, color: "#8b5cf6", outline: "dotted" },
      ],
      edges: [],
    }) as DiagramTemplate;
    const svg = renderTemplateToSvg(doc, resolveRegistry());
    expect(svg).toContain("#8b5cf6");
  });

  it("draws a box behind a text note unless it opts out with `plain`", () => {
    const doc = (plain: boolean): DiagramTemplate => ({
      version: 1,
      nodes: [
        { id: "n", label: "A note", kind: "text", icon: "none", description: "", parentId: null, ...(plain ? { plain: true } : {}), x: 0, y: 0, w: 200, h: 60, fontSize: 13 },
      ],
      edges: [],
    });
    const registry = resolveRegistry();
    const boxed = emitTemplate(doc(false), registry);
    const bare = emitTemplate(doc(true), registry);
    // Exactly one extra command: the note's card.
    expect(boxed.cmds.length).toBe(bare.cmds.length + 1);
    expect(renderTemplateToSvg(doc(false), registry)).toContain("A note");
  });

  it("renders the whole example diagram to SVG", () => {
    const svg = renderTemplateToSvg(EXAMPLE_TEMPLATE, resolveRegistry());
    expect(svg).toMatch(/^<svg /);
    expect(svg.trimEnd()).toMatch(/<\/svg>$/);
    // One arrowhead per edge: a filled path whose apex sits at the target's
    // attachment (heads draw BACKWARD from the tip so nodes can't cover them).
    const heads = svg.match(/<path d="M [^"]+ Z" fill="#(?!0)[0-9a-f]{6}"\/>/g) ?? [];
    expect(heads.length).toBeGreaterThanOrEqual(EXAMPLE_TEMPLATE.edges.length);
  });
});

describe("zone styling", () => {
  const registry = resolveRegistry();
  const styledDoc = (over: Record<string, unknown>) =>
    validateTemplate({
      version: 1,
      zones: [
        {
          id: "z",
          label: "Z",
          shape: "rounded",
          x: 0,
          y: 0,
          w: 400,
          h: 300,
          providers: ["azure"],
          provider: "azure",
          ...over,
        },
      ],
      nodes: [],
      edges: [],
    });

  it("zoneInk: the override wins, else the provider, else the fallback grey", () => {
    expect(zoneInk(registry, { provider: "azure" })).toBe("#0078d4");
    expect(zoneInk(registry, { provider: "azure", color: "#22c55e" })).toBe("#22c55e");
    expect(zoneInk(registry, { provider: "no-such-provider" })).toBe("#64748b");
  });

  it("zoneFill derives the dull tint from the ink", () => {
    expect(zoneFill(registry, { provider: "azure", opacity: 0.2 })).toBe("rgba(0, 120, 212, 0.2)");
    expect(zoneFill(registry, { provider: "azure", color: "#22c55e", opacity: 0.5 })).toBe(
      "rgba(34, 197, 94, 0.5)",
    );
    // Default opacity when unset, transparent when the fill is off.
    expect(zoneFill(registry, { provider: "azure" })).toBe("rgba(0, 120, 212, 0.14)");
    expect(zoneFill(registry, { provider: "azure", fill: false })).toBe("transparent");
  });

  it("a colour override reaches the SVG export", () => {
    const svg = renderTemplateToSvg(styledDoc({ color: "#22c55e" }), registry);
    // The body strokes and fills with the ink…
    expect(svg).toContain('stroke="#22c55e"');
    expect(svg).toContain('fill="#22c55e"');
    // …while the LEGEND stays the provider's colour — it is an infra key, and
    // a recoloured zone is still hosted where it is hosted.
    expect(svg).toContain("#0078d4");
    expect(svg).not.toContain('stroke="#0078d4" stroke-opacity="0.75"');
  });

  it("outline styles export as the same dash tables the canvas uses", () => {
    expect(renderTemplateToSvg(styledDoc({ outline: "dashed" }), registry)).toContain(
      'stroke-dasharray="8 5"',
    );
    expect(renderTemplateToSvg(styledDoc({ outline: "dotted" }), registry)).toContain(
      'stroke-dasharray="2 4"',
    );
  });

  it("outline none exports no stroke; fill false no fill", () => {
    // The body is identifiable by its exact alpha signature — the header chip
    // also fills with the ink but at its own 0.22.
    const noOutline = renderTemplateToSvg(styledDoc({ outline: "none", color: "#22c55e" }), registry);
    expect(noOutline).not.toContain('stroke="#22c55e" stroke-opacity="0.75"');
    expect(noOutline).toContain('fill-opacity="0.14"'); // the fill stays

    const noFill = renderTemplateToSvg(styledDoc({ fill: false, color: "#22c55e" }), registry);
    expect(noFill).not.toContain('fill-opacity="0.14"'); // the body fill is gone
    expect(noFill).toContain('stroke="#22c55e" stroke-opacity="0.75"'); // the outline stays
  });

  it("outline none + fill false emits no body path at all", () => {
    const svg = renderTemplateToSvg(
      styledDoc({ outline: "none", fill: false, color: "#22c55e" }),
      registry,
    );
    const withBody = renderTemplateToSvg(styledDoc({ color: "#22c55e" }), registry);
    expect((svg.match(/<path/g) ?? []).length).toBeLessThan(
      (withBody.match(/<path/g) ?? []).length,
    );
    // The header chip still shows where (and what) the region is.
    expect(svg).toContain("#22c55e");
  });
});

describe("lifecycle stage rendering in exports", () => {
  const registry = resolveRegistry();
  const statusDoc = (status: string) =>
    validateTemplate({
      version: 1,
      nodes: [
        { id: "n", label: "N", kind: "service", icon: "box", description: "", parentId: null, status, x: 0, y: 0, w: 170, h: 76 },
      ],
      edges: [],
    });

  it("stubbed draws the heavy construction dash", () => {
    expect(renderTemplateToSvg(statusDoc("stubbed"), registry)).toContain('stroke-dasharray="10 4"');
  });

  it("dark draws the black/white hazard ring", () => {
    const svg = renderTemplateToSvg(statusDoc("dark"), registry);
    expect(svg).toContain('stroke="#020617"');
    expect(svg).toMatch(/stroke="#f8fafc"[^/]*stroke-dasharray="6 6"/);
  });

  it("deprecated's status token exports in salmon", () => {
    const svg = renderTemplateToSvg(statusDoc("deprecated"), registry);
    expect(svg).toContain('fill="#fa8072"');
    expect(svg).toContain("DEPRECATED");
    // Only deprecated wears it — the other stages keep the accent.
    expect(renderTemplateToSvg(statusDoc("retired"), registry)).not.toContain("#fa8072");
  });

  it("an active node draws neither", () => {
    const svg = renderTemplateToSvg(statusDoc("active"), registry);
    expect(svg).not.toContain("#020617");
    expect(svg).not.toContain('stroke-dasharray="10 4"');
  });
});

describe("colour theming", () => {
  const registry = resolveRegistry();

  it("themeToStyle fans the record tokens out to per-entry variables", () => {
    const style = themeToStyle(LIGHT_THEME) as Record<string, string>;
    expect(style["--as-edge-sky"]).toBe("#0284c7");
    expect(style["--as-seq-database"]).toBe("#d97706");
    expect(style["--as-warn"]).toBe("#e0674f");
    expect(style["--as-diff-removed"]).toBe("#e11d48");
  });

  it("light exports darken the edge palette", () => {
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 },
        { id: "b", label: "B", kind: "service", icon: "box", description: "", parentId: null, x: 400, y: 0, w: 170, h: 76 },
      ],
      edges: [{ id: "e", source: "a", target: "b", label: "", style: "solid", color: "sky" }],
    });
    // Edge strokes are the only 1.8-wide strokes — a clean discriminator.
    expect(renderTemplateToSvg(doc, registry)).toContain('stroke="#38bdf8" stroke-width="1.8"');
    expect(renderTemplateToSvg(doc, registry, LIGHT_EXPORT_PALETTE)).toContain(
      'stroke="#0284c7" stroke-width="1.8"',
    );
  });

  it("overdue date chips export amber on pre-active elements only", () => {
    const doc = (status?: string) =>
      validateTemplate({
        version: 1,
        nodes: [
          { id: "n", label: "N", kind: "service", icon: "box", description: "", parentId: null, ...(status ? { status } : {}), date: "2020-01-01", x: 0, y: 0, w: 170, h: 76 },
        ],
        edges: [],
      });
    // A 2020 date is permanently past, so this stays deterministic.
    expect(renderTemplateToSvg(doc("planned"), registry)).toContain('fill="#f59e0b"');
    // Active with a past date just means "landed" — quiet grey chip.
    expect(renderTemplateToSvg(doc(), registry)).not.toContain("#f59e0b");
  });
});

describe("edge route export parity", () => {
  const registry = resolveRegistry();
  const routed = validateTemplate({
    version: 1,
    nodes: [
      { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 100, h: 50 },
      { id: "b", label: "B", kind: "service", icon: "box", description: "", parentId: null, x: 400, y: 0, w: 100, h: 50 },
    ],
    edges: [
      {
        id: "e1", source: "a", target: "b", label: "", style: "solid", color: "slate",
        start: { side: "bottom" }, points: [[250, 300]],
      },
    ],
  });

  it("draws the anchored, waypointed path in SVG exactly as the canvas would", () => {
    const svg = renderTemplateToSvg(routed, registry);
    // Leaves the bottom of A (its centre-bottom is 50,50) — the M of the edge path.
    expect(svg).toContain("M 50 50");
    // And the curve passes through the waypoint's x territory: the spline is
    // emitted as chained cubics, one knot exactly at the waypoint.
    expect(svg).toMatch(/C [^"]*250 300/);
  });

  it("strips the route from collapse-rerouted edges in exports too", () => {
    const collapsed = validateTemplate({
      version: 1,
      nodes: [
        { id: "g", label: "G", kind: "group", icon: "none", description: "", parentId: null, collapsed: true, x: 0, y: 0, w: 400, h: 300 },
        { id: "inner", label: "I", kind: "service", icon: "box", description: "", parentId: "g", x: 30, y: 60, w: 170, h: 76 },
        { id: "out", label: "O", kind: "service", icon: "box", description: "", parentId: null, x: 600, y: 400, w: 170, h: 76 },
      ],
      edges: [
        {
          id: "e1", source: "inner", target: "out", label: "", style: "solid", color: "slate",
          start: { side: "top" }, points: [[900, -500]],
        },
      ],
    });
    const { cmds } = emitTemplate(collapsed, registry);
    const edgePath = cmds.find((c) => c.op === "path" && c.stroke && !c.fill);
    // The waypoint (and the anchor on the hidden box) must not leak into the
    // chip-rerouted line — no command reaches toward the stale route.
    expect(JSON.stringify(edgePath)).not.toContain("-500");
  });
});
