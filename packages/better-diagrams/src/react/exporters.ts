/**
 * exporters.ts — the built-in export formats.
 *
 * Every exporter is a plain object with a `run(ctx)`, so the set is data, not
 * control flow: a host app adds Terraform or Structurizr output by registering
 * one more entry, and removes PDF by registering `pdf: null`.
 *
 * Image rendering lives in `draw.ts`: one emitter produces draw commands, and
 * the canvas/SVG backends translate them mechanically — the two outputs cannot
 * drift because neither contains a styling decision. Both wrappers here take
 * an optional `ExportPalette`, which is how light-mode exports work.
 */
import {
  toReactFlow,
  visibleElements,
  type DiagramNode,
  type DiagramTemplate,
} from "../contract/schema";
import { formatDiagramDate } from "../contract/timeline";
// Imports `./registry-types`, not `./registry` — registry.ts imports
// BUILTIN_EXPORTERS from here, so depending on it directly would be a cycle.
import type { ExportContext, ExporterDef, ResolvedRegistry } from "./registry-types";
import { emitTemplate, type ExportPalette } from "./draw";
import {
  blobToUint8,
  buildSinglePageJpegPdf,
  canvasToBlob,
  emittedToCanvas,
  emittedToSvg,
  type RenderedCanvas,
} from "./export-helpers";

export { DARK_EXPORT_PALETTE, LIGHT_EXPORT_PALETTE, emitTemplate } from "./draw";
export type { ExportPalette, DrawCmd } from "./draw";
export type { RenderedCanvas } from "./export-helpers";

// ─── Canvas (PNG + PDF) ──────────────────────────────────────────────────────

/** Render a template to an offscreen canvas. Throws in a non-DOM environment. */
export function renderTemplateToCanvas(
  template: DiagramTemplate,
  registry: ResolvedRegistry,
  scale = 2,
  palette: Partial<ExportPalette> = {},
): RenderedCanvas {
  return emittedToCanvas(emitTemplate(template, registry, palette), scale);
}

// ─── SVG ─────────────────────────────────────────────────────────────────────

/** Vector export — opens in Figma/Illustrator and stays editable. */
export function renderTemplateToSvg(
  template: DiagramTemplate,
  registry: ResolvedRegistry,
  palette: Partial<ExportPalette> = {},
): string {
  return emittedToSvg(emitTemplate(template, registry, palette));
}

// ─── C4-PlantUML ─────────────────────────────────────────────────────────────

/** Kind → C4-PlantUML element macro. Anything unmapped becomes a Container. */
const C4_MACRO: Record<string, string> = {
  client: "Person",
  database: "ContainerDb",
  queue: "ContainerQueue",
  external: "System_Ext",
};

/**
 * Text export for the C4-PlantUML ecosystem (PlantUML, GitLab, VS Code,
 * Confluence). Same visibility rules as the Mermaid export: the active
 * provider selection decides what appears; collapse is a view state and is
 * deliberately ignored — the architecture inside a collapsed group is still
 * architecture.
 *
 * Nesting: groups become Container_Boundary (they nest strictly); zones
 * become Deployment_Node wrapping the root-level elements they host. A node
 * inside a group is placed by its group, so a group's zone placement carries
 * its members — the same priority the canvas uses.
 */
export function renderTemplateToC4Puml(template: DiagramTemplate): string {
  const safe = (id: string) => id.replace(/[^A-Za-z0-9_]/g, "_");
  const q = (text: string) => text.replace(/"/g, "'");
  const visible = visibleElements(template);
  const nodes = template.nodes.filter((n) => visible.nodes.has(n.id) && n.kind !== "text");
  const zoneById = new Map((template.zones ?? []).map((z) => [z.id, z]));

  const lines: string[] = ["@startuml"];
  lines.push("!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml");
  lines.push("");
  if (template.meta?.title) lines.push(`title ${q(String(template.meta.title))}`);
  lines.push("");

  const children = new Map<string | null, DiagramNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(n);
  }

  const emitElement = (n: DiagramNode, indent: string) => {
    const macro = C4_MACRO[n.kind as string] ?? "Container";
    const tech = n.description ? `, "${q(n.description)}"` : "";
    // Non-default lifecycle stages travel as C4 tags, so a host stylesheet
    // (AddElementTag) can restyle them; harmless when undefined there.
    const tag = n.status ? `, $tags="${n.status}"` : "";
    lines.push(`${indent}${macro}(${safe(n.id)}, "${q(n.label)}"${tech}${tag})`);
  };

  const emitLevel = (parentId: string | null, indent: string) => {
    for (const n of children.get(parentId) ?? []) {
      if (n.kind === "group") {
        lines.push(`${indent}Container_Boundary(${safe(n.id)}, "${q(n.label)}") {`);
        emitLevel(n.id, `${indent}  `);
        lines.push(`${indent}}`);
      } else {
        emitElement(n, indent);
      }
    }
  };

  // Root-level elements grouped by the zone hosting them; zoneless roots last.
  const roots = children.get(null) ?? [];
  const byZone = new Map<string | null, DiagramNode[]>();
  for (const n of roots) {
    const key = n.zoneId && zoneById.has(n.zoneId) ? n.zoneId : null;
    if (!byZone.has(key)) byZone.set(key, []);
    byZone.get(key)!.push(n);
  }

  for (const [zoneId, members] of byZone) {
    if (zoneId === null) continue;
    const zone = zoneById.get(zoneId)!;
    lines.push(`Deployment_Node(${safe(zone.id)}, "${q(zone.label)}", "${q(zone.provider)}") {`);
    for (const n of members) {
      if (n.kind === "group") {
        lines.push(`  Container_Boundary(${safe(n.id)}, "${q(n.label)}") {`);
        emitLevel(n.id, "    ");
        lines.push("  }");
      } else {
        emitElement(n, "  ");
      }
    }
    lines.push("}");
  }
  for (const n of byZone.get(null) ?? []) {
    if (n.kind === "group") {
      lines.push(`Container_Boundary(${safe(n.id)}, "${q(n.label)}") {`);
      emitLevel(n.id, "  ");
      lines.push("}");
    } else {
      emitElement(n, "");
    }
  }

  lines.push("");
  for (const e of template.edges) {
    if (!visible.edges.has(e.id)) continue;
    const macro = e.direction === "both" ? "BiRel" : "Rel";
    const label = e.seq ? `${e.seq}. ${e.label || ""}`.trim() : e.label || "";
    const tech = e.tech ? `, "${q(e.tech)}"` : "";
    lines.push(`${macro}(${safe(e.source)}, ${safe(e.target)}, "${q(label)}"${tech})`);
  }

  lines.push("@enduml");
  return lines.join("\n");
}

// ─── Mermaid ─────────────────────────────────────────────────────────────────

const ARROW: Record<string, string> = { solid: "-->", dashed: "-.->", dotted: "-.->" };

/** Text export — pastes straight into a Markdown ```mermaid fence. */
export function renderTemplateToMermaid(template: DiagramTemplate): string {
  const safe = (id: string) => id.replace(/[^A-Za-z0-9_]/g, "_");
  const visible = visibleElements(template);
  const lines: string[] = [];

  // Mermaid subgraphs must nest strictly, so they can't express zones that
  // overlap. Record the active infra selection as a comment header instead,
  // and reserve subgraphs for the (strictly nested) groups.
  for (const zone of template.zones ?? []) {
    lines.push(`%% zone: ${zone.label} on ${zone.provider}`);
  }
  lines.push("flowchart LR");

  const children = new Map<string | null, DiagramNode[]>();
  for (const n of template.nodes) {
    if (!visible.nodes.has(n.id)) continue;
    const key = n.parentId ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(n);
  }

  const emitNode = (n: DiagramNode, indent: string) => {
    // The date is real data, not decoration, so it travels with the semantic
    // exports too — on the same sub-line the description already uses, which
    // is the only free-form slot a Mermaid node label has.
    const sub = [n.description, n.date ? formatDiagramDate(n.date, { year: "always" }) : ""]
      .filter(Boolean)
      .join(" · ");
    const label = sub ? `${n.label}<br/><small>${sub}</small>` : n.label;
    const text = `"${label.replace(/"/g, "'")}"`;
    if (n.kind === "database") lines.push(`${indent}${safe(n.id)}[(${text})]`);
    else if (n.kind === "client" || n.kind === "external") lines.push(`${indent}${safe(n.id)}([${text}])`);
    else if (n.kind === "queue") lines.push(`${indent}${safe(n.id)}[[${text}]]`);
    else lines.push(`${indent}${safe(n.id)}[${text}]`);
  };

  const emitLevel = (parentId: string | null, indent: string) => {
    for (const n of children.get(parentId) ?? []) {
      if (n.kind === "text") continue;
      if (n.kind === "group") {
        lines.push(`${indent}subgraph ${safe(n.id)}["${n.label.replace(/"/g, "'")}"]`);
        emitLevel(n.id, `${indent}  `);
        lines.push(`${indent}end`);
      } else {
        emitNode(n, indent);
      }
    }
  };
  emitLevel(null, "  ");

  for (const e of template.edges) {
    if (!visible.edges.has(e.id)) continue;
    const arrow = ARROW[e.style] ?? "-->";
    lines.push(`  ${safe(e.source)} ${arrow}${e.label ? `|${e.label.replace(/\|/g, "/")}|` : ""} ${safe(e.target)}`);
  }
  return lines.join("\n");
}

// ─── The built-in registry ───────────────────────────────────────────────────

const json = (value: unknown) => new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });

export const BUILTIN_EXPORTERS: Record<string, ExporterDef> = {
  png: {
    label: "PNG image",
    hint: "Raster snapshot at 2x",
    async run({ template, registry, filename, palette }: ExportContext) {
      const { canvas } = renderTemplateToCanvas(template, registry, 2, palette);
      return { blob: await canvasToBlob(canvas, "image/png"), filename: `${filename}.png` };
    },
  },
  pdf: {
    label: "PDF document",
    hint: "Single page, sized to fit",
    async run({ template, registry, filename, palette }: ExportContext) {
      const { canvas } = renderTemplateToCanvas(template, registry, 2, palette);
      const jpegBlob = await canvasToBlob(canvas, "image/jpeg", 0.92);
      const jpeg = await blobToUint8(jpegBlob);
      return {
        blob: buildSinglePageJpegPdf(jpeg, canvas.width, canvas.height),
        filename: `${filename}.pdf`,
      };
    },
  },
  svg: {
    label: "SVG vector",
    hint: "Editable in Figma or Illustrator",
    run({ template, registry, filename, palette }: ExportContext) {
      return {
        blob: new Blob([renderTemplateToSvg(template, registry, palette)], { type: "image/svg+xml" }),
        filename: `${filename}.svg`,
      };
    },
  },
  template: {
    label: "Template (.json)",
    hint: "The schema — save this to your database",
    run({ template, filename }: ExportContext) {
      return { blob: json(template), filename: `${filename}.template.json` };
    },
  },
  reactflow: {
    label: "React Flow (.json)",
    hint: "Nodes and edges for @xyflow/react",
    run({ template, registry, filename }: ExportContext) {
      const rf = toReactFlow(template, {
        containerKinds: registry.containerKinds,
        annotationKinds: registry.annotationKinds,
      });
      return { blob: json(rf), filename: `${filename}.reactflow.json` };
    },
  },
  mermaid: {
    label: "Mermaid (.mmd)",
    hint: "Paste into Markdown or a wiki",
    run({ template, filename }: ExportContext) {
      return {
        blob: new Blob([renderTemplateToMermaid(template)], { type: "text/plain" }),
        filename: `${filename}.mmd`,
      };
    },
  },
  c4puml: {
    label: "C4-PlantUML (.puml)",
    hint: "Renders in PlantUML, GitLab, VS Code",
    run({ template, filename }: ExportContext) {
      return {
        blob: new Blob([renderTemplateToC4Puml(template)], { type: "text/plain" }),
        filename: `${filename}.puml`,
      };
    },
  },
};
