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
  ghostSourceId,
  hiddenInline,
  onlyEdgeBetween,
  isBoundaryNodeId,
  isGhostNodeId,
  POINT_KINDS,
  toReactFlow,
  visibleAnchor,
  visibleElements,
  type DiagramNode,
  type DiagramTemplate,
} from "../contract/schema";
import { cardinalityMarker, type CardinalityMarker } from "../contract/geometry";
import { formatDiagramDate, templateTimeline } from "../contract/timeline";
import { splitTemplate } from "../contract/presentation";
import { drillableIds, focusPath, scopedView } from "../contract/scope";
import { CLOUD_NODE_KINDS } from "./cloud-kinds";
// Imports `./registry-types`, not `./registry` — registry.ts imports
// BUILTIN_EXPORTERS from here, so depending on it directly would be a cycle.
import type { ExportContext, ExporterDef, ResolvedRegistry } from "./registry-types";
import { emitTemplate, type ExportPalette } from "./draw";
import { levelLabel } from "./chrome";
import { buildMultiViewHtml, buildTimelineHtml, type ViewEntry } from "./html-export";
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
  opts: { gridId?: string } = {},
): string {
  return emittedToSvg(emitTemplate(template, registry, palette), opts);
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
/**
 * Project a document onto its root level for the flat text formats: drill
 * children disappear, and their crossing edges land on the card that holds
 * them — the same rerouting the canvas and image exports apply. Uses the
 * builtin container vocabulary (these renderers carry no registry).
 */
function rootLevelProjection(template: DiagramTemplate): DiagramTemplate {
  const hidden = hiddenInline(template);
  if (!hidden.size) return template;
  const byId = new Map(template.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const alone = onlyEdgeBetween(template.edges, (id) => visibleAnchor(id, byId, hidden));
  return {
    ...template,
    nodes: template.nodes.filter((n) => !hidden.has(n.id)),
    edges: template.edges.flatMap((e) => {
      const source = visibleAnchor(e.source, byId, hidden);
      const target = visibleAnchor(e.target, byId, hidden);
      // Both ends re-anchored onto one card: internal wiring, not shown. A
      // loop the document states is a retry arrow and survives the projection
      // — the same test toReactFlow and the image emitter apply.
      if (source === target && (source !== e.source || target !== e.target)) return [];
      if (source === e.source && target === e.target) return [e];
      const key = `${source}→${target}`;
      if (seen.has(key)) return [];
      seen.add(key);
      // A stand-in summarising SEVERAL hidden originals shows none of their
      // labels; standing in for one, it keeps that one's.
      return [alone(e) ? { ...e, source, target } : { ...e, source, target, label: "" }];
    }),
  };
}

/**
 * Grammar-safe, collision-free aliases for a list of document ids, in order.
 *
 * Both text formats need identifiers made of `[A-Za-z0-9_]`, and the obvious
 * `id.replace(/[^A-Za-z0-9_]/g, "_")` corrupts rather than degrades: `api-v1`
 * and `api_v1` sanitise to one alias and MERGE into a single node, and a node
 * whose id is `end` or `subgraph` — a natural id for a terminator — is a
 * Mermaid keyword that breaks the parse outright. Only the ids that would
 * actually collide or read as keywords are renamed, so the aliases every
 * existing document has always exported with are unchanged.
 */
function uniqueAliases(ids: readonly string[], reserved?: ReadonlySet<string>): string[] {
  const taken = new Set<string>();
  return ids.map((id) => {
    const sanitised = id.replace(/[^A-Za-z0-9_]/g, "_");
    // An identifier may not open with a digit, and an empty id is not one.
    const base =
      /^[A-Za-z_]/.test(sanitised) && !reserved?.has(sanitised.toLowerCase())
        ? sanitised
        : `n_${sanitised}`;
    let alias = base;
    for (let n = 2; taken.has(alias); n++) alias = `${base}_${n}`;
    taken.add(alias);
    return alias;
  });
}

/** Fold a label onto one line — both formats emit line-oriented statements. */
const oneLine = (text: string) => String(text).replace(/\s+/g, " ").trim();

export function renderTemplateToC4Puml(rawTemplate: DiagramTemplate): string {
  const template = rootLevelProjection(rawTemplate);
  // Zones and nodes become PlantUML aliases in ONE namespace, so they are
  // named together: a zone `db` and a node `db` would otherwise declare the
  // same alias twice and the second declaration would be rejected.
  const zoneIds = (template.zones ?? []).map((z) => z.id);
  const nodeIds = template.nodes.map((n) => n.id);
  const aliases = uniqueAliases([...nodeIds, ...zoneIds]);
  const nodeAlias = new Map(nodeIds.map((id, i) => [id, aliases[i]]));
  const zoneAlias = new Map(zoneIds.map((id, i) => [id, aliases[nodeIds.length + i]]));
  const safe = (id: string) => nodeAlias.get(id) ?? id.replace(/[^A-Za-z0-9_]/g, "_");
  const safeZone = (id: string) => zoneAlias.get(id) ?? id.replace(/[^A-Za-z0-9_]/g, "_");
  const q = (text: string) => oneLine(text).replace(/"/g, "'");
  const visible = visibleElements(template);
  // C4 is a strict semantic model with no dangling-arrow concept: a point
  // node (and any arrow that ends on one) is sketch scaffolding, not
  // architecture, so it stays out of this export entirely.
  const pointIds = new Set(
    template.nodes.filter((n) => POINT_KINDS.includes(n.kind as string)).map((n) => n.id),
  );
  const nodes = template.nodes.filter(
    (n) => visible.nodes.has(n.id) && n.kind !== "text" && !pointIds.has(n.id),
  );
  const zoneById = new Map((template.zones ?? []).map((z) => [z.id, z]));

  const lines: string[] = ["@startuml"];
  // `Deployment_Node` is defined in C4_Deployment.puml, not C4_Container.puml
  // — a zoned document rendered with only the container library and PlantUML
  // reported an undefined macro. The deployment library includes the container
  // one itself, so exactly one !include is right in both cases.
  const stdlib = zoneIds.length ? "C4_Deployment" : "C4_Container";
  lines.push(
    `!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/${stdlib}.puml`,
  );
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
    // Cloud pack kinds carry their semantics in their shape: aws-dynamodb is
    // a cylinder, azure-service-bus a pipe — export them as what they are.
    const cloudShape = CLOUD_NODE_KINDS[n.kind as string]?.shape;
    const macro =
      C4_MACRO[n.kind as string] ??
      (cloudShape === "cylinder" ? "ContainerDb" : cloudShape === "pipe" ? "ContainerQueue" : "Container");
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
    lines.push(`Deployment_Node(${safeZone(zone.id)}, "${q(zone.label)}", "${q(zone.provider)}") {`);
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
    if (pointIds.has(e.source) || pointIds.has(e.target)) continue;
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

/**
 * Mermaid keywords that cannot stand as a node id. `end` is the one that
 * actually bites — a terminator node called "end" is the obvious thing to
 * write, and it closes whatever subgraph is open instead of declaring a node.
 */
const MERMAID_KEYWORDS: ReadonlySet<string> = new Set([
  "end",
  "graph",
  "flowchart",
  "subgraph",
  "class",
  "classdef",
  "click",
  "style",
  "linkstyle",
  "direction",
  "default",
]);

/**
 * Mermaid's glyph for each cardinality, per end — read through the SAME parser
 * the canvas draws its crow's feet from, so the exported notation and the
 * on-screen symbol can never disagree. Mermaid requires a cardinality on every
 * relationship, so text that isn't one falls back to "exactly one" here rather
 * than to no marker.
 */
const ER_GLYPH: Record<CardinalityMarker, { left: string; right: string }> = {
  one: { left: "||", right: "||" },
  "zero-one": { left: "|o", right: "o|" },
  "one-many": { left: "}|", right: "|{" },
  "zero-many": { left: "}o", right: "o{" },
};

const erCardinality = (raw: string | undefined, side: "left" | "right") =>
  ER_GLYPH[cardinalityMarker(raw) ?? "one"][side];

/**
 * An ER diagram, when the document IS one — every visible box carries rows.
 * A mixed document stays a flowchart: half the entities having no columns
 * would make an `erDiagram` claim something false about them.
 */
function renderTemplateToMermaidEr(template: DiagramTemplate, safe: (id: string) => string): string {
  const visible = visibleElements(template);
  const lines = ["erDiagram"];
  // Mermaid attribute types are single tokens; a name with spaces or a stray
  // quote would break the block rather than render oddly.
  const token = (text: string) => text.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_()[\]]/g, "");

  for (const n of template.nodes) {
    if (!visible.nodes.has(n.id) || !n.fields?.length) continue;
    lines.push(`  ${safe(n.id)} {`);
    for (const field of n.fields) {
      // Mermaid wants `type name KEY`; it has no "optional" marker, so a
      // required column says so in the comment slot instead.
      const key = field.key === "pk" || field.key === "pfk" ? " PK" : field.key === "fk" ? " FK" : "";
      const note = field.required ? ' "required"' : "";
      lines.push(`    ${token(field.type || "string")} ${token(field.name) || "column"}${key}${note}`);
    }
    lines.push("  }");
  }

  const pointIds = new Set(
    template.nodes.filter((n) => POINT_KINDS.includes(n.kind as string)).map((n) => n.id),
  );
  for (const e of template.edges) {
    if (!visible.edges.has(e.id)) continue;
    // An ER diagram has no dangling relationships — Mermaid would conjure an
    // empty entity for the unknown id, which reads as a data-model mistake.
    if (pointIds.has(e.source) || pointIds.has(e.target)) continue;
    const rel = `${erCardinality(e.startLabel, "left")}--${erCardinality(e.endLabel, "right")}`;
    // The relationship label is mandatory in Mermaid's ER grammar; the joined
    // columns are the truest thing to say when the edge carries no words.
    const label =
      e.label || (e.startField && e.endField ? `${e.startField} → ${e.endField}` : "relates");
    lines.push(`  ${safe(e.source)} ${rel} ${safe(e.target)} : "${oneLine(label).replace(/"/g, "'")}"`);
  }
  return lines.join("\n");
}

/** Text export — pastes straight into a Markdown ```mermaid fence. */
export function renderTemplateToMermaid(rawTemplate: DiagramTemplate): string {
  const template = rootLevelProjection(rawTemplate);
  const ids = template.nodes.map((n) => n.id);
  const aliases = uniqueAliases(ids, MERMAID_KEYWORDS);
  const alias = new Map(ids.map((id, i) => [id, aliases[i]]));
  const safe = (id: string) => alias.get(id) ?? id.replace(/[^A-Za-z0-9_]/g, "_");
  const visible = visibleElements(template);

  // A document whose every visible box is a record exports as what it is.
  // A dangling arrow's dot is sketch scaffolding, not a box — one mustn't
  // flip a data model's export from erDiagram to flowchart.
  const boxes = template.nodes.filter(
    (n) =>
      visible.nodes.has(n.id) &&
      n.kind !== "text" &&
      n.kind !== "group" &&
      !POINT_KINDS.includes(n.kind as string),
  );
  if (boxes.length && boxes.every((n) => n.fields?.length)) {
    return renderTemplateToMermaidEr(template, safe);
  }

  const lines: string[] = [];

  // Mermaid subgraphs must nest strictly, so they can't express zones that
  // overlap. Record the active infra selection as a comment header instead,
  // and reserve subgraphs for the (strictly nested) groups.
  for (const zone of template.zones ?? []) {
    // A comment ends at the newline, so a multi-line zone label would leave
    // its tail standing as a statement Mermaid cannot parse.
    lines.push(`%% zone: ${oneLine(zone.label)} on ${oneLine(zone.provider)}`);
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
    // A dangling arrow's endpoint: mermaid's closest thing to a dot is a tiny
    // circle. The edge to it still exports, arrow into nearly-nothing.
    if (POINT_KINDS.includes(n.kind as string)) {
      lines.push(`${indent}${safe(n.id)}((" "))`);
      return;
    }
    // The date is real data, not decoration, so it travels with the semantic
    // exports too — on the same sub-line the description already uses, which
    // is the only free-form slot a Mermaid node label has.
    const sub = [n.description, n.date ? formatDiagramDate(n.date, { year: "always" }) : ""]
      .filter(Boolean)
      .join(" · ");
    const label = sub ? `${n.label}<br/><small>${sub}</small>` : n.label;
    const text = `"${oneLine(label).replace(/"/g, "'")}"`;
    // Cloud pack kinds export by their silhouette (aws-dynamodb → cylinder).
    const cloudShape = CLOUD_NODE_KINDS[n.kind as string]?.shape;
    if (n.kind === "database" || cloudShape === "cylinder") lines.push(`${indent}${safe(n.id)}[(${text})]`);
    else if (n.kind === "decision") lines.push(`${indent}${safe(n.id)}{${text}}`);
    else if (n.kind === "terminator" || n.kind === "client" || n.kind === "external")
      lines.push(`${indent}${safe(n.id)}([${text}])`);
    else if (n.kind === "io") lines.push(`${indent}${safe(n.id)}[/${text}/]`);
    else if (n.kind === "queue" || cloudShape === "pipe") lines.push(`${indent}${safe(n.id)}[[${text}]]`);
    else lines.push(`${indent}${safe(n.id)}[${text}]`);
  };

  const emitLevel = (parentId: string | null, indent: string) => {
    for (const n of children.get(parentId) ?? []) {
      if (n.kind === "text") continue;
      if (n.kind === "group") {
        lines.push(`${indent}subgraph ${safe(n.id)}["${oneLine(n.label).replace(/"/g, "'")}"]`);
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
    // QUOTED, on one line. Bare edge text only survives if it happens to
    // contain nothing Mermaid punctuates with, so a label as ordinary as
    // `read (cached)` used to break the whole file.
    // A pipe closes the `|…|` delimiter even inside the quotes, so it has to
    // go whatever else is escaped — the quoting is what saves brackets and
    // parentheses, not this.
    const label = e.label
      ? `|"${oneLine(e.label).replace(/"/g, "'").replace(/\|/g, "/")}"|`
      : "";
    lines.push(`  ${safe(e.source)} ${arrow}${label} ${safe(e.target)}`);
  }
  return lines.join("\n");
}

// ─── The built-in registry ───────────────────────────────────────────────────

const json = (value: unknown) => new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });

/**
 * Validation options mirroring the registry, for `splitTemplate`'s internal
 * re-validate — without them a custom kind or provider would be "repaired"
 * away from a document that legitimately uses it.
 */
const splitOpts = (registry: ResolvedRegistry) => ({
  knownKinds: registry.kindOrder,
  knownIcons: registry.iconNames,
  containerKinds: registry.containerKinds,
  knownProviders: registry.providerOrder,
});

/**
 * One `ViewEntry` per drill level: the root plus every node with children,
 * each pre-rendered through the SAME pipeline as the canvas. Click targets:
 * a drillable node opens its level, a ghost visits its home level, and the
 * boundary frame steps out one level.
 */
function buildDrillViews(
  template: DiagramTemplate,
  registry: ResolvedRegistry,
  palette: Partial<ExportPalette> = {},
): ViewEntry[] {
  const parents = drillableIds(template);
  const parentSet = new Set(parents);
  const byId = new Map(template.nodes.map((n) => [n.id, n]));
  const drillHidden = hiddenInline(template, registry.containerKinds);
  const rootLabel = String(template.meta?.title ?? "Overview");
  const labelOf = (id: string) => byId.get(id)?.label ?? id;
  /** The view that SHOWS a node — its parent's level, or the root. */
  const homeViewOf = (id: string) => focusPath(template, id).at(-1) ?? "";

  const crumbFor = (id: string) => [
    { key: "", label: rootLabel },
    ...[...focusPath(template, id), id].map((step) => ({ key: step, label: labelOf(step) })),
  ];

  const rootDrills: Record<string, string> = {};
  for (const p of parents) {
    // Drill-hidden parents have no box on the root canvas; everything else
    // (cards, frames, chips) is stamped `node:<id>` and clickable.
    if (!drillHidden.has(p)) rootDrills[`node:${p}`] = p;
  }

  const views: ViewEntry[] = [
    {
      key: "",
      crumb: [{ key: "", label: rootLabel }],
      levelLabel: levelLabel(0),
      parent: null,
      svg: renderTemplateToSvg(template, registry, palette, { gridId: "as-grid-v0" }),
      drills: rootDrills,
    },
  ];

  parents.forEach((focusId, i) => {
    const view = scopedView(template, focusId, { containerKinds: registry.containerKinds });
    const drills: Record<string, string> = {};
    for (const n of view.nodes) {
      if (isBoundaryNodeId(n.id)) {
        drills[`node:${n.id}`] = homeViewOf(focusId);
      } else if (isGhostNodeId(n.id)) {
        drills[`node:${n.id}`] = homeViewOf(ghostSourceId(n.id));
      } else if (parentSet.has(n.id)) {
        drills[`node:${n.id}`] = n.id;
      }
    }
    views.push({
      key: focusId,
      crumb: crumbFor(focusId),
      levelLabel: levelLabel(focusPath(template, focusId).length + 1),
      parent: homeViewOf(focusId),
      svg: renderTemplateToSvg(view, registry, palette, { gridId: `as-grid-v${i + 1}` }),
      drills,
    });
  });
  return views;
}

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
      // The PAGE is sized in CSS pixels, not backing-store pixels: the canvas
      // is rendered at 2x for sharpness, and handing those dimensions to the
      // PDF writer prints the diagram at twice its physical size (a 1036px
      // document came out as a 21-inch page).
      const { canvas, width, height } = renderTemplateToCanvas(template, registry, 2, palette);
      const jpegBlob = await canvasToBlob(canvas, "image/jpeg", 0.92);
      const jpeg = await blobToUint8(jpegBlob);
      return {
        blob: buildSinglePageJpegPdf(jpeg, width, height),
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
  html: {
    label: "Interactive HTML",
    hint: "Self-contained page — drill between levels, scrub the timeline",
    // The page carries its own scrubber, so it needs every element and every
    // date — a hide-mode slice would leave it nothing to scrub.
    fullDocument: true,
    run({ template, registry, filename, palette }: ExportContext) {
      const title = String(template.meta?.title ?? filename);
      const stops = templateTimeline(template).stops;
      // Any nesting makes the page multi-view: one pre-rendered SVG per
      // drillable level, clickable in place. A flat document keeps the
      // original single-view page byte-for-byte.
      const page = drillableIds(template).length
        ? buildMultiViewHtml({ views: buildDrillViews(template, registry, palette), title, stops, palette })
        : buildTimelineHtml({
            svg: renderTemplateToSvg(template, registry, palette),
            title,
            stops,
            palette,
          });
      return { blob: new Blob([page], { type: "text/html" }), filename: `${filename}.html` };
    },
  },
  template: {
    label: "Template (.json)",
    hint: "The schema — save this to your database",
    // A round-trip document, per its own hint. Slicing it under a hide-mode
    // scrub would turn "export → save" into silent deletion of everything the
    // cursor was hiding — the picture formats show the slice, the persistence
    // formats never do.
    fullDocument: true,
    run({ template, filename }: ExportContext) {
      return { blob: json(template), filename: `${filename}.template.json` };
    },
  },
  content: {
    label: "Content (.json)",
    hint: "Architecture without layout — hand this to an AI",
    // Document-shaped: the whole point is that every element is in it.
    fullDocument: true,
    run({ template, registry, filename }: ExportContext) {
      const { content } = splitTemplate(template, splitOpts(registry));
      return { blob: json(content), filename: `${filename}.content.json` };
    },
  },
  layout: {
    label: "Layout (.json)",
    hint: "Positions & routes — pairs with Content",
    fullDocument: true,
    run({ template, registry, filename }: ExportContext) {
      const { presentation } = splitTemplate(template, splitOpts(registry));
      return { blob: json(presentation), filename: `${filename}.layout.json` };
    },
  },
  reactflow: {
    label: "React Flow (.json)",
    hint: "Nodes and edges for @xyflow/react",
    // Document-shaped like `template`: consumers rebuild state from it, so a
    // slice would propagate the same silent loss one hop downstream.
    fullDocument: true,
    run({ template, registry, filename }: ExportContext) {
      // Everything, in its expanded form. The defaults drop every node the
      // active provider hides, fold each collapsed group's contents away, and
      // replace edges into them with synthetic `collapsed:` stand-ins —
      // exactly the silent loss the flag above exists to prevent, one hop
      // downstream. A consumer rebuilding state from this file has to receive
      // the whole document, collapse flags and all, and unfold it itself.
      const rf = toReactFlow(template, {
        containerKinds: registry.containerKinds,
        annotationKinds: registry.annotationKinds,
        applyVisibility: false,
        applyCollapse: false,
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
