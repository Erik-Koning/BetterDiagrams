/**
 * validation-report.ts — what `validateTemplate` changed, and where.
 *
 * Validation repairs rather than rejects, so a slightly-off document still
 * loads. That is right for rendering and wrong for a program editing the
 * document: an edge pointing at a typo'd id simply disappears. This runs the
 * same validation and lists every repair that lost or changed something the
 * input said, each with a JSON Pointer into the INPUT:
 *
 *   const { template, issues } = validateTemplateReport(json);
 *   for (const i of issues) console.warn(i.path, i.message);
 *   // /edges/4  The edge's target "paymnts" names no node, so the edge was left out.
 *
 * Defaults filled in or stripped (a missing `icon`, `status: "active"`) are
 * not issues: nothing the author wrote was lost. The template returned is
 * exactly `validateTemplate(raw, opts)`.
 */
import {
  ANNOTATION_KINDS,
  ARRANGE_MODES,
  CONTAINER_KINDS,
  EDGE_COLORS,
  EDGE_DIRECTIONS,
  EDGE_HEADS,
  EDGE_KEYS,
  EDGE_ROUTINGS,
  EDGE_STYLES,
  FIELD_KEYS,
  GROUP_CONTENTS,
  MAX_NODE_FIELDS,
  NODE_FIELD_KEYS,
  NODE_KEYS,
  NODE_OUTLINES,
  NODE_STATUSES,
  NODE_TEXT_ALIGNS,
  NODE_TEXT_VALIGNS,
  NOTATIONS,
  SETTINGS_KEYS,
  TASK_PRIORITIES,
  TASK_STAGES,
  TEMPLATE_KEYS,
  VERSION_TAG_POSITIONS,
  idOf,
  migrateTemplate,
  validateTemplate,
  type DiagramTemplate,
  type ValidateOptions,
} from "./schema";
import { ZONE_KEYS, ZONE_OUTLINES, ZONE_SHAPES } from "./zones";
import { PATH_KEYS } from "./paths";
import { TASK_KIND } from "./tasks";

export const VALIDATION_ISSUE_CODES = [
  /** An element that couldn't be read at all — no usable id, or not an object. */
  "dropped",
  /** An id already in use; the element was renamed (`api` → `api_2`). */
  "duplicate-id",
  /** A key the schema doesn't define; it was dropped. */
  "unknown-key",
  /** A value outside its vocabulary, or not a number; reset to the default. */
  "unknown-value",
  /** A reference to an id the document doesn't have; the reference (or, for an edge's end, the edge) was dropped. */
  "missing-reference",
  /** A `parentId` that made a node contain itself; it was cleared. */
  "parent-cycle",
  /** A date that isn't `YYYY-MM-DD` (or a form that reads as one); it was dropped. */
  "invalid-date",
  /** A key that means something only on another kind of element — frame styling on a card; it was dropped. */
  "not-applicable",
] as const;
export type ValidationIssueCode = (typeof VALIDATION_ISSUE_CODES)[number];

export interface ValidationIssue {
  code: ValidationIssueCode;
  /** JSON Pointer (RFC 6901) into the document as given, e.g. `/nodes/3/kind`. */
  path: string;
  /** One sentence: what was wrong, and what validation did about it. */
  message: string;
}

export interface ValidationReport {
  /** The validated document — identical to `validateTemplate(raw, opts)`. */
  template: DiagramTemplate;
  /** Every repair that lost or changed something the input said, in document order. */
  issues: ValidationIssue[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const given = (v: unknown) => v !== undefined && v !== null && v !== "";
const show = (v: unknown) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v));
const pointer = (...parts: Array<string | number>) =>
  parts.map((p) => `/${String(p).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");

/** The `num()` reading validation uses: blank means "not given", anything else must be finite. */
const readsAsNumber = (v: unknown) => !given(v) || Number.isFinite(Number(v));

/**
 * Validate a document and list what validation repaired. Throws exactly
 * where `validateTemplate` does: no `nodes` array, or a `version` from a
 * newer release.
 */
export function validateTemplateReport(raw: unknown, opts: ValidateOptions = {}): ValidationReport {
  const template = validateTemplate(raw, opts);
  const doc = migrateTemplate(raw ?? {}) as Obj;
  const issues: ValidationIssue[] = [];
  const add = (code: ValidationIssueCode, path: string, message: string) => issues.push({ code, path, message });
  const unknownKeys = (value: Obj, known: readonly string[], at: string, what: string) => {
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) add("unknown-key", `${at}${pointer(key)}`, `"${key}" isn't a ${what} property, so it was dropped.`);
    }
  };
  const vocab = (value: Obj, key: string, allowed: readonly string[], at: string, fallback: string) => {
    if (given(value[key]) && !allowed.includes(value[key] as string)) {
      const article = /^[aeiou]/i.test(key) ? "an" : "a";
      add("unknown-value", `${at}${pointer(key)}`, `${show(value[key])} isn't ${article} ${key} value (${allowed.join(", ")}), so ${fallback}.`);
    }
  };
  const date = (value: Obj, at: string, kept: unknown, key = "date") => {
    if (given(value[key]) && !kept) {
      add("invalid-date", `${at}/${key}`, `${show(value[key])} isn't a date this reads (YYYY-MM-DD), so it was dropped.`);
    }
  };

  unknownKeys(doc, TEMPLATE_KEYS, "", "document");
  const containers = new Set(opts.containerKinds ?? CONTAINER_KINDS);
  const annotations = new Set(opts.annotationKinds ?? ANNOTATION_KINDS);

  // ── Zones ──
  const rawZones = list(doc.zones);
  let z = 0;
  rawZones.forEach((zone, i) => {
    const at = pointer("zones", i);
    if (!isObj(zone) || typeof zone.id !== "string") {
      add("dropped", at, "A zone without a string id can't be read, so it was left out.");
      return;
    }
    const out = template.zones?.[z++];
    if (!out) return;
    unknownKeys(zone, ZONE_KEYS, at, "zone");
    if (out.id !== zone.id) add("duplicate-id", `${at}/id`, `Zone id "${zone.id}" was already used, so this one became "${out.id}".`);
    vocab(zone, "shape", ZONE_SHAPES, at, `it became "rounded"`);
    vocab(zone, "outline", ZONE_OUTLINES, at, "the default solid outline is used");
    date(zone, at, out.date);
  });
  const zoneIds = new Set((template.zones ?? []).map((zone) => zone.id));

  // ── Nodes ──
  const finalIds = new Set(template.nodes.map((node) => node.id));
  let n = 0;
  list(doc.nodes).forEach((node, i) => {
    const at = pointer("nodes", i);
    if (!isObj(node) || idOf(node.id) === null) {
      add("dropped", at, "A node needs an id (a string or a number), so this one was left out.");
      return;
    }
    const out = template.nodes[n++];
    const rawId = idOf(node.id) as string;
    unknownKeys(node, NODE_KEYS, at, "node");
    if (out.id !== rawId) add("duplicate-id", `${at}/id`, `Node id "${rawId}" was already used, so this one became "${out.id}".`);
    if (given(node.kind) && node.kind !== out.kind) {
      add(
        "unknown-value",
        `${at}/kind`,
        `Kind ${show(node.kind)} isn't known here, so the node became a "${out.kind}". A custom kind needs its registry's kinds passed as \`knownKinds\`.`,
      );
    }
    if (given(node.icon) && node.icon !== out.icon) {
      add("unknown-value", `${at}/icon`, `Icon ${show(node.icon)} isn't known here, so the node has none.`);
    }
    for (const key of ["x", "y", "w", "h", "fontSize"] as const) {
      const bad = !readsAsNumber(node[key]) || (key !== "x" && key !== "y" && given(node[key]) && Number(node[key]) <= 0);
      if (bad) add("unknown-value", `${at}/${key}`, `${key} must be ${key === "x" || key === "y" ? "a number" : "a positive number"}, so the default was used.`);
    }
    vocab(node, "status", NODE_STATUSES, at, `the node is "active"`);
    vocab(node, "textAlign", NODE_TEXT_ALIGNS, at, `the text is left-aligned`);
    vocab(node, "textVAlign", NODE_TEXT_VALIGNS, at, `the text is centred vertically`);
    vocab(node, "stage", TASK_STAGES, at, `the task reads as "to do"`);
    vocab(node, "priority", TASK_PRIORITIES, at, `it has no priority`);
    date(node, at, out.date);
    if (out.kind !== TASK_KIND && given(node.startDate)) {
      add("not-applicable", `${at}/startDate`, `"startDate" applies to tasks only, and kind "${out.kind}" isn't one, so it was dropped.`);
    } else {
      date(node, at, out.startDate, "startDate");
    }

    const isContainer = containers.has(out.kind);
    if (isContainer) vocab(node, "outline", NODE_OUTLINES, at, `the frame is dashed`);
    const frameOnly: Array<[string, boolean]> = [
      ["collapsed", node.collapsed === true],
      ["fill", node.fill === false],
      ["outline", given(node.outline)],
      ["opacity", given(node.opacity)],
      ["capacity", given(node.capacity)],
    ];
    if (!isContainer) {
      for (const [key, set] of frameOnly) {
        if (set) add("not-applicable", `${at}/${key}`, `"${key}" applies to containers only, and kind "${out.kind}" isn't one, so it was dropped.`);
      }
    }
    if (node.plain === true && !annotations.has(out.kind)) {
      add("not-applicable", `${at}/plain`, `"plain" applies to text notes only, so it was dropped.`);
    }

    const parent = idOf(node.parentId);
    if (parent && out.parentId === null) {
      if (parent === out.id || !finalIds.has(parent)) {
        add("missing-reference", `${at}/parentId`, `parentId "${parent}" names no other node, so the node sits at the top level.`);
      } else {
        add("parent-cycle", `${at}/parentId`, `parentId "${parent}" would put the node inside itself, so it was cleared.`);
      }
    }
    const zone = idOf(node.zoneId);
    if (zone && !zoneIds.has(zone)) {
      add("missing-reference", `${at}/zoneId`, `zoneId "${zone}" names no zone, so the node is in none.`);
    }

    // Fields: entries without a name or id are skipped, then the rest map in order.
    let f = 0;
    list(node.fields).forEach((field, j) => {
      const fat = `${at}/fields/${j}`;
      const named = isObj(field) && ((typeof field.name === "string" && field.name.trim()) || (typeof field.id === "string" && field.id.trim()));
      if (!named) {
        add("dropped", fat, "A field needs a name or an id, so this one was left out.");
        return;
      }
      const kept = out.fields?.[f++];
      if (!kept) {
        add("dropped", fat, `A node holds at most ${MAX_NODE_FIELDS} fields, so this one was left out.`);
        return;
      }
      unknownKeys(field as Obj, NODE_FIELD_KEYS, fat, "field");
      const fieldId = typeof (field as Obj).id === "string" ? ((field as Obj).id as string).trim() : "";
      if (fieldId && kept.id !== fieldId) add("duplicate-id", `${fat}/id`, `Field id "${fieldId}" was already used on this node, so this one became "${kept.id}".`);
      vocab(field as Obj, "key", FIELD_KEYS, fat, "it is not a key");
    });
  });

  // ── Edges ── (kept in order when both ends name a node, as validation filters them)
  let e = 0;
  list(doc.edges).forEach((edge, i) => {
    const at = pointer("edges", i);
    if (!isObj(edge)) {
      add("dropped", at, "An edge must be an object, so this one was left out.");
      return;
    }
    const missing = (["source", "target"] as const).filter((end) => !finalIds.has(String(edge[end])));
    if (missing.length) {
      const ends = missing.map((end) => `${end} ${show(edge[end])}`).join(" and ");
      add("missing-reference", at, `The edge's ${ends} names no node, so the edge was left out.`);
      return;
    }
    const out = template.edges[e++];
    unknownKeys(edge, EDGE_KEYS, at, "edge");
    if (given(edge.id) && out.id !== String(edge.id)) {
      add("duplicate-id", `${at}/id`, `Edge id "${String(edge.id)}" was already used, so this one became "${out.id}".`);
    }
    vocab(edge, "style", EDGE_STYLES, at, `it is drawn solid`);
    vocab(edge, "color", EDGE_COLORS, at, `it is drawn slate`);
    vocab(edge, "direction", EDGE_DIRECTIONS, at, `it points forward`);
    vocab(edge, "startHead", EDGE_HEADS, at, `the end draws the default head`);
    vocab(edge, "endHead", EDGE_HEADS, at, `the end draws the default head`);
    vocab(edge, "routing", EDGE_ROUTINGS, at, `it follows the document's routing`);
    for (const [key, endKey] of [
      ["startField", "source"],
      ["endField", "target"],
    ] as const) {
      if (given(edge[key]) && !out[key]) {
        add("missing-reference", `${at}/${key}`, `${key} ${show(edge[key])} names no field of the ${endKey} node, so the line attaches to the box.`);
      }
    }
    date(edge, at, out.date);
  });

  // ── Paths, analyses, lineage ──
  const rawPaths = list(doc.paths);
  const keptPaths = new Map((template.paths ?? []).map((p) => [p.id, p]));
  rawPaths.forEach((path, i) => {
    const at = pointer("paths", i);
    if (!isObj(path)) return;
    unknownKeys(path, PATH_KEYS, at, "path");
    const kept = keptPaths.get(String(idOf(path.id)));
    const steps = list(path.steps).length;
    if (kept && kept.steps.length < steps) {
      add("missing-reference", `${at}/steps`, `${steps - kept.steps.length} of the path's steps named nothing that exists, so they were dropped.`);
    }
  });
  const droppedPaths = rawPaths.length - (template.paths?.length ?? 0);
  if (droppedPaths > 0) {
    add("dropped", "/paths", `${droppedPaths} path${droppedPaths === 1 ? "" : "s"} had no step left that names a node, so ${droppedPaths === 1 ? "it was" : "they were"} left out.`);
  }
  for (const [key, one, many] of [
    ["analyses", "saved analysis", "saved analyses"],
    ["lineage", "lineage link", "lineage links"],
  ] as const) {
    const dropped = list(doc[key]).length - (template[key]?.length ?? 0);
    if (dropped > 0) {
      add("dropped", `/${key}`, `${dropped} ${dropped === 1 ? one : many} couldn't be read or named nodes that don't exist, so ${dropped === 1 ? "it was" : "they were"} left out.`);
    }
  }

  // ── Settings and meta ──
  if (isObj(doc.settings)) {
    unknownKeys(doc.settings, SETTINGS_KEYS, "/settings", "settings");
    vocab(doc.settings, "groupContents", GROUP_CONTENTS, "/settings", `groups show their contents`);
    vocab(doc.settings, "arrange", ARRANGE_MODES, "/settings", `Tidy arranges by flow`);
    if (given(doc.settings.roadmap) && !template.settings?.roadmap) {
      add("unknown-value", "/settings/roadmap", `The roadmap axis needs a "from" date and a numeric "dayWidth", so it was dropped and is fitted to the plan.`);
    }
    vocab(doc.settings, "notation", NOTATIONS, "/settings", `both notations are drawn`);
  }
  if (isObj(doc.meta)) {
    vocab(doc.meta, "versionTagPosition", VERSION_TAG_POSITIONS, "/meta", `the tag sits top-left`);
  }
  return { template, issues };
}
