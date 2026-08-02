import { describe, expect, it } from "vitest";
import { createRegistry as resolveRegistry } from "./create-registry";
import { kindDef, iconPaths } from "./registry-types";
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

  it("keeps built-in kinds before extensions in the inspector order", () => {
    const r = resolveRegistry({ nodeKinds: { zeta: {}, alpha: {} } });
    expect(r.kindOrder.slice(0, 8)).toEqual([
      "service",
      "database",
      "queue",
      "gateway",
      "client",
      "external",
      "group",
      "text",
    ]);
    expect(r.kindOrder.slice(8)).toEqual(["zeta", "alpha"]);
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
    expect(svg).toContain("DATABASE · DEPRECATED");
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
    // One arrowhead polygon per edge.
    expect(svg.match(/<polygon/g)).toHaveLength(EXAMPLE_TEMPLATE.edges.length);
  });
});
