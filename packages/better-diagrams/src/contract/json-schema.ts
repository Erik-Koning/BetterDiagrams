/**
 * json-schema.ts — the document as a JSON Schema (draft 2020-12).
 *
 * For everything that isn't TypeScript: an editor's `$schema` autocompletion,
 * a backend in another language, an LLM's structured output. It describes the
 * document validation PRODUCES — closed vocabularies, no unknown keys — so a
 * value the schema rejects is one `validateTemplate` would repair or drop.
 *
 *   import schema from "@mosphere/better-diagrams/schema.json";   // built-ins
 *   diagramJsonSchema({ knownKinds: ["vault"] });                    // plus a registry's
 *
 * Built from the same vocabularies and key lists validation uses, and tested
 * against them, so it cannot fall behind a new property or enum value.
 */
import {
  ARRANGE_MODES,
  EDGE_ANCHOR_SIDES,
  EDGE_COLORS,
  EDGE_DIRECTIONS,
  EDGE_HEADS,
  EDGE_ROUTINGS,
  EDGE_STYLES,
  FIELD_KEYS,
  GROUP_CONTENTS,
  ICON_NAMES,
  NODE_KINDS,
  NODE_OUTLINES,
  NODE_STATUSES,
  NODE_TEXT_ALIGNS,
  NODE_TEXT_VALIGNS,
  NOTATIONS,
  PROVIDER_IDS,
  TASK_PRIORITIES,
  TASK_STAGES,
  VERSION_TAG_POSITIONS,
  type ValidateOptions,
} from "./schema";
import { ZONE_OUTLINES, ZONE_SHAPES } from "./zones";
import { ALL_CLOUD_KIND_IDS } from "./cloud";
import { ANALYSIS_KINDS } from "./analyses";

/** A JSON Schema object — kept structural so the contract stays dependency-free. */
export type JsonSchema = Record<string, unknown>;

export type JsonSchemaOptions = Pick<ValidateOptions, "knownKinds" | "knownIcons" | "knownProviders">;

const str = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "string", description, ...extra });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const num = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "number", description, ...extra });
const oneOf = (values: readonly string[], description: string): JsonSchema => ({
  type: "string",
  enum: [...new Set(values)],
  description,
});
const strings = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });
const ref = (name: string, description?: string): JsonSchema =>
  description ? { $ref: `#/$defs/${name}`, description } : { $ref: `#/$defs/${name}` };
const object = (properties: Record<string, JsonSchema>, required: string[] = [], description?: string): JsonSchema => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

/**
 * The document's JSON Schema. Pass a registry's kinds, icons and providers to
 * accept them too — the same lists `validateTemplate` takes, and for the same
 * reason: without them a custom kind is one validation turns into "service".
 */
export function diagramJsonSchema(options: JsonSchemaOptions = {}): JsonSchema {
  const kinds = [...NODE_KINDS, ...ALL_CLOUD_KIND_IDS, ...(options.knownKinds ?? [])];
  const icons = [...ICON_NAMES, ...(options.knownIcons ?? [])];
  const providers = [...PROVIDER_IDS, ...(options.knownProviders ?? [])];

  const node = object(
    {
      id: str("Unique among nodes. Edges, children and paths refer to it.", { minLength: 1 }),
      label: str("The title on the card. Defaults to the id."),
      kind: oneOf(kinds, "What the box is: picks its shape, colour and icon. `group` is a container; `text` a note; `table` a data-model entity."),
      icon: oneOf(icons, "An icon drawn on the card; `none` for the kind's own."),
      description: str("A line or two under the title."),
      fields: { type: "array", items: ref("field"), maxItems: 500, description: "Rows — a table's columns, an enum's values." },
      parentId: { type: ["string", "null"], description: "The node this one sits inside: a container's frame, or another node's drill-in detail." },
      x: num("Left edge, relative to the parent when there is one."),
      y: num("Top edge, relative to the parent when there is one."),
      w: num("Width.", { exclusiveMinimum: 0 }),
      h: num("Height. Grows to fit fields and wrapped text.", { exclusiveMinimum: 0 }),
      fontSize: num("Title size in px. Default 13.", { exclusiveMinimum: 0 }),
      textAlign: oneOf(NODE_TEXT_ALIGNS, "Horizontal text alignment. Default left."),
      textVAlign: oneOf(NODE_TEXT_VALIGNS, "Vertical text alignment. Default middle; a wrapped card reads from the top."),
      wrap: bool("Show all the text: the title wraps and the card grows to fit."),
      fill: bool("Containers: false draws the frame without its tint."),
      outline: oneOf(NODE_OUTLINES, "Containers: the frame's line. Default dashed."),
      color: ref("color", "Accent colour, `#rrggbb`. Absent means the kind's own."),
      opacity: num("Containers: tint strength.", { minimum: 0, maximum: 1 }),
      zoneId: { type: ["string", "null"], description: "The infrastructure zone this node sits on." },
      providers: strings("Provider ids this node exists on. Absent means always visible."),
      tags: strings("Free labels, filterable in the editor."),
      url: str("A deep link: an ADR, a repo, a runbook, a dashboard."),
      team: str("The owning team, shown as a tag on the card."),
      assignees: strings("People working on it — drawn on tasks."),
      storyPoints: num("A task's estimate.", { minimum: 0 }),
      done: bool("A task is finished."),
      stage: oneOf(TASK_STAGES, "Where an open task stands. Absent means to do."),
      priority: oneOf(TASK_PRIORITIES, "How urgent a task is, p0 the most."),
      capacity: num("Containers: the story points a sprint or phase can hold.", { minimum: 0 }),
      status: oneOf(NODE_STATUSES, "Lifecycle stage. Default active."),
      date: ref("date", "When this lands, for the timeline."),
      locked: bool("Pinned in place in the editor."),
      plain: bool("Text notes: bare text without a box."),
      collapsed: bool("Containers: folded into a chip."),
      data: ref("data", "The host's own metadata. Never drawn."),
    },
    ["id"],
    "A box on the canvas.",
  );

  const edge = object(
    {
      id: str("Unique among edges. Generated when absent.", { minLength: 1 }),
      source: str("The node the line starts from.", { minLength: 1 }),
      target: str("The node it points at. May equal source for a loop.", { minLength: 1 }),
      label: str("A short verb phrase on the line."),
      labelT: num("Where the label sits along the line.", { minimum: 0.15, maximum: 0.85 }),
      style: oneOf(EDGE_STYLES, "Line style. Default solid."),
      color: oneOf(EDGE_COLORS, "Line colour. Default slate."),
      providers: strings("Provider ids this connection exists on."),
      tech: str("Technology or protocol, C4 style: `[JSON/HTTPS]`."),
      relation: str("What kind of relationship: composition, reference, hierarchy, polymorphic, or a registry's own."),
      direction: oneOf(EDGE_DIRECTIONS, "Arrowheads. Default forward."),
      startHead: oneOf(EDGE_HEADS, "The glyph at the source end."),
      endHead: oneOf(EDGE_HEADS, "The glyph at the target end."),
      seq: { type: "integer", minimum: 1, description: "Step number for a dynamic diagram." },
      routing: oneOf(EDGE_ROUTINGS, "Routing for this line. Absent follows meta.routing."),
      start: ref("anchor", "Pin the start to a side of the source box."),
      end: ref("anchor", "Pin the end to a side of the target box."),
      startLabel: str("Cardinality or role text at the source end."),
      endLabel: str("Cardinality or role text at the target end."),
      startField: str("The source node's field the line attaches to."),
      endField: str("The target node's field the line attaches to."),
      points: ref("points", "Waypoints in absolute canvas coordinates."),
      date: ref("date", "When this connection lands."),
      data: ref("data", "The host's own metadata. Never drawn."),
    },
    ["source", "target"],
    "A line between two nodes.",
  );

  const zone = object(
    {
      id: str("Unique among zones.", { minLength: 1 }),
      label: str("The zone's title."),
      shape: oneOf(ZONE_SHAPES, "Outline shape. Default rounded."),
      points: {
        type: "array",
        minItems: 3,
        items: { type: "array", prefixItems: [{ type: "number", minimum: 0, maximum: 1 }, { type: "number", minimum: 0, maximum: 1 }], minItems: 2, maxItems: 2 },
        description: "Polygon corners, normalised 0..1 inside the box.",
      },
      x: num("Left edge."),
      y: num("Top edge."),
      w: num("Width.", { exclusiveMinimum: 0 }),
      h: num("Height.", { exclusiveMinimum: 0 }),
      providers: { type: "array", items: { type: "string", examples: providers }, description: "The providers this zone can show." },
      provider: str("The provider shown now; one of `providers`.", { examples: providers }),
      color: ref("color", "Tint colour."),
      outline: oneOf(ZONE_OUTLINES, "Outline. Default solid."),
      fill: bool("False draws the outline only."),
      opacity: num("Tint strength.", { minimum: 0, maximum: 1 }),
      z: { type: "integer", description: "Stacking order among zones." },
      locked: bool("Pinned in place in the editor."),
      date: ref("date", "When this zone lands."),
    },
    ["id"],
    "An infrastructure zone drawn behind the nodes.",
  );

  const field = object(
    {
      id: str("Unique on its node. Made from the name when absent."),
      name: str("The column or value name.", { minLength: 1 }),
      type: str("Its type, as written: `uuid`, `varchar(64)`."),
      key: oneOf(FIELD_KEYS, "pk, fk or pfk."),
      required: bool("Not nullable."),
      unique: bool("Unique."),
      derived: bool("Computed from other fields."),
      description: str("A note about the field."),
      tags: strings("Short tags; `hidden` keeps the row off the card."),
    },
    ["name"],
    "A row on a node.",
  );

  const path = object(
    {
      id: str("Unique among paths.", { minLength: 1 }),
      title: str("What the flow is called."),
      steps: { type: "array", items: { type: "string" }, minItems: 1, description: "Node ids start to end, with an edge id between two nodes only when several edges join them." },
      color: oneOf(EDGE_COLORS, "Glow colour. Absent takes the next in the cycle."),
      description: str("One line about the flow."),
    },
    ["id", "steps"],
    "A named flow the reader can light up.",
  );

  const viewRecord = object(
    {
      nodes: {
        type: "object",
        additionalProperties: object({ x: num("Left."), y: num("Top."), w: num("Width.", { exclusiveMinimum: 0 }), h: num("Height.", { exclusiveMinimum: 0 }) }, ["x", "y", "w", "h"]),
      },
      edges: {
        type: "object",
        additionalProperties: object({
          labelT: num("Label position.", { minimum: 0.15, maximum: 0.85 }),
          start: ref("anchor"),
          end: ref("anchor"),
          points: ref("points"),
        }),
      },
    },
    [],
    "Layout for one drill-in level, keyed by the focused node's id.",
  );

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "BetterDiagrams diagram",
    description:
      "An architecture, data-model or task diagram. See DiagramTemplate in @mosphere/better-diagrams for the full meaning of each property.",
    type: "object",
    properties: {
      $schema: str("This schema's location, for editors."),
      version: { const: 1, description: "The document format version." },
      meta: {
        type: "object",
        description: "Document metadata. Unknown keys round-trip untouched.",
        properties: {
          title: str("The diagram's title."),
          routing: oneOf(EDGE_ROUTINGS, "The routing edges inherit. Default curved."),
          versionTag: str("A revision label shown in a corner."),
          versionTagPosition: oneOf(VERSION_TAG_POSITIONS, "Which corner. Default top-left."),
          views: { type: "object", additionalProperties: ref("viewRecord"), description: "Per-level layout for drill-in views." },
        },
        additionalProperties: true,
      },
      zones: { type: "array", items: ref("zone") },
      nodes: { type: "array", items: ref("node") },
      edges: { type: "array", items: ref("edge") },
      paths: { type: "array", items: ref("path") },
      analyses: { type: "array", items: ref("analysis"), maxItems: 200 },
      lineage: { type: "array", items: ref("lineageLink") },
      settings: object(
        {
          groupContents: oneOf(GROUP_CONTENTS, "Whether groups show their contents. Default show."),
          arrange: oneOf(ARRANGE_MODES, "What Tidy optimises for. Default flow."),
          notation: oneOf(NOTATIONS, "How cardinality is drawn. Default both."),
          capacity: { type: "object", additionalProperties: { type: "number", minimum: 0 }, description: "Story points per person, by name." },
        },
        [],
        "How the whole document is shown.",
      ),
    },
    required: ["nodes", "edges"],
    additionalProperties: false,
    $defs: {
      node,
      edge,
      zone,
      field,
      path,
      viewRecord,
      date: str("A day, YYYY-MM-DD.", { pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
      color: str("`#rgb`, `#rrggbb`, `#rrggbbaa`, or `#rrggbb/NN` with NN a percent opacity.", {
        pattern: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$|^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})/\\d{1,3}$",
      }),
      anchor: object({ side: oneOf(EDGE_ANCHOR_SIDES, "Which side."), t: num("Where along that side.", { minimum: 0, maximum: 1 }) }, ["side"]),
      points: {
        type: "array",
        items: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], minItems: 2, maxItems: 2 },
      },
      data: { type: "object", description: "Anything; kept as-is." },
      fieldRef: object({ nodeId: str("A node id.", { minLength: 1 }), fieldId: str("A field id on it.", { minLength: 1 }) }, ["nodeId", "fieldId"]),
      lineageLink: object(
        {
          id: str("Unique among links.", { minLength: 1 }),
          from: ref("fieldRef", "The source column."),
          to: ref("fieldRef", "The column made from it."),
          transform: str("How: the expression or step."),
          job: str("What runs it."),
        },
        ["id", "from", "to"],
        "Which column's values are made from which.",
      ),
      analysis: {
        type: "object",
        description: "A saved analysis, written by the editor's Save analysis. Its body depends on `kind`.",
        properties: {
          id: str("Unique among analyses.", { minLength: 1 }),
          title: str("What it asks.", { minLength: 1 }),
          kind: oneOf(ANALYSIS_KINDS, "Which panel opens it."),
          note: str("A note kept with it."),
          created: str("When it was saved."),
        },
        required: ["id", "title", "kind"],
        additionalProperties: true,
      },
    },
  };
}
