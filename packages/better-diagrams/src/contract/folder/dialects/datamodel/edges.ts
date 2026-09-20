/**
 * edges.ts — an entity's `foreignKeys[]` as diagram edges.
 *
 * `foreignKeys[]` is the source of truth (it is complete, audit FKs and
 * all); `relationships.json` only says which of them are BUSINESS edges, so
 * the default view can leave `owner_id` / `created_by_id` noise out. An
 * edge runs child → parent — FK holder to referenced — and joins canonical
 * entity folders only; a view is an alias, not a table, and gets no FK
 * lines of its own.
 */
import type { DiagramEdge } from "../../../schema";
import { FALLBACK_RELATION, RELATION_KINDS, relationDressing } from "../../../relations";
import type { FolderNode, FolderImportOptions, ImportWarning } from "../../types";
import type { ForeignKey, EntitySchema, RecordTypeSchema } from "./shapes";

/** How many targets `polymorphic: "in-model"` fans out to before capping. */
export const POLY_FANOUT_CAP = 12;

export const EXTERNAL_GROUP_ID = "_external";

export interface EdgeContext {
  /** Canonical entity folder per entity name — views excluded. */
  nameToFolder: Map<string, string>;
  /** `${entity}::${field}` for every edge `relationships.json` lists. */
  business: Set<string>;
  /** Field ids each node carries, so anchors only name rows that exist. */
  fieldsByFolder: Map<string, Set<string>>;
  /** Each entity's primary key field, so a reference knows where it lands. */
  primaryKeyByFolder: Map<string, string>;
  /** Node id per folder, for the point node's parent. */
  parentByFolder: Map<string, string | null>;
  /** Stub nodes requested so far, by entity name. */
  stubs: Map<string, FolderNode>;
  /** Collapse points requested so far. */
  points: FolderNode[];
}

export const stubId = (name: string) => `${EXTERNAL_GROUP_ID}/${name.toLowerCase()}`;

function stubFor(ctx: EdgeContext, name: string): string {
  const known = ctx.stubs.get(name);
  if (known) return known.id;
  const node: FolderNode = {
    id: stubId(name),
    label: name,
    kind: "entity-external",
    icon: "link",
    description: "Outside the model",
    parentId: EXTERNAL_GROUP_ID,
    tags: ["external"],
    data: { model: { shape: "external", name } },
  };
  ctx.stubs.set(name, node);
  return node.id;
}

/**
 * Whether the key must hold a value. `nullable === false` on the field is
 * the truth when the entity states it; the key's own `required` flag is the
 * fallback, since generated files disagree with it often enough that the
 * field spec says not to trust it first.
 */
function fkRequired(schema: EntitySchema, fk: ForeignKey): boolean {
  const field = schema.fields.find((f) => f.name === fk.field);
  if (field?.nullable !== undefined) return field.nullable === false;
  return fk.required === true;
}

function baseEdge(
  sourceFolder: string,
  targetId: string,
  fk: ForeignKey,
  ctx: EdgeContext,
  business: boolean,
  required: boolean,
): DiagramEdge {
  const kind = fk.kind;
  const targetField = fk.targetField ?? ctx.primaryKeyByFolder.get(targetId);
  const hasStart = ctx.fieldsByFolder.get(sourceFolder)?.has(fk.field) ?? false;
  const hasEnd = targetField !== undefined && (ctx.fieldsByFolder.get(targetId)?.has(targetField) ?? false);
  // The kind is the editor's own relation vocabulary, so the line is
  // dressed exactly as the legend and the inspector's picker would dress it
  // — and the legend is what names it. It does NOT ride `tech` as well: that
  // slot is a protocol's, and a `[composition]` under every line would say
  // what the key beside the canvas already says.
  const dressing = relationDressing(RELATION_KINDS[kind] ?? FALLBACK_RELATION);
  // A kind's far end is optional by default — a lookup may be empty. A key
  // the row must hold points at exactly one parent, and the multiplicity
  // says so: `0..1` on a required key would be a claim the schema denies.
  if (required && dressing.endLabel === "0..1") dressing.endLabel = "1";
  return {
    id: `${sourceFolder}::${fk.field}::${targetId}`,
    source: sourceFolder,
    target: targetId,
    label: fk.relationshipName ?? fk.field,
    relation: kind,
    ...dressing,
    ...(hasStart ? { startField: fk.field } : {}),
    ...(hasEnd ? { endField: targetField } : {}),
    data: {
      model: {
        field: fk.field,
        ...(targetField !== undefined ? { targetField } : {}),
        kind,
        relationshipName: fk.relationshipName ?? null,
        referenceTo: [...fk.referenceTo],
        required: fk.required ?? false,
        cascadeDelete: fk.cascadeDelete ?? false,
        deleteConstraint: fk.deleteConstraint ?? null,
        visible: fk.visible ?? true,
        business,
      },
    },
  };
}

/** The canonical entity folder an FK points at, or null when the target is outside the model. */
function canonicalTarget(fk: ForeignKey, ctx: EdgeContext, canonical: ReadonlySet<string>): string | null {
  for (const folder of fk.targetFolders ?? []) if (canonical.has(folder)) return folder;
  const first = fk.referenceTo[0];
  return (first && ctx.nameToFolder.get(first)) ?? null;
}

export function entityEdges(
  schema: EntitySchema,
  folder: string,
  ctx: EdgeContext,
  opts: FolderImportOptions,
  warn: (w: ImportWarning) => void,
): DiagramEdge[] {
  const out: DiagramEdge[] = [];
  const name = schema.entity.name;
  const canonical = new Set(ctx.nameToFolder.values());
  for (const fk of schema.foreignKeys ?? []) {
    const business = ctx.business.has(`${name}::${fk.field}`);
    if ((opts.edges ?? "business") === "business" && !business) continue;
    const required = fkRequired(schema, fk);

    if (fk.kind === "polymorphic") {
      const mode = opts.polymorphic ?? "collapse";
      if (mode === "none") continue;
      if (mode === "collapse") {
        const pointId = `${folder}/_poly/${fk.field}`;
        ctx.points.push({
          id: pointId,
          kind: "point",
          icon: "none",
          label: `${fk.field} → ${fk.referenceTo.length} types`,
          description: "",
          // Beside the entity, not inside it: inside a non-container the
          // point would be drill-in detail, invisible on the canvas the
          // edge is drawn on.
          parentId: ctx.parentByFolder.get(folder) ?? null,
          data: { model: { shape: "poly", field: fk.field, referenceTo: [...fk.referenceTo] } },
        });
        out.push(baseEdge(folder, pointId, fk, ctx, business, required));
        continue;
      }
      // in-model: one edge per target that has a folder, capped.
      const targets = fk.referenceTo
        .map((t) => ctx.nameToFolder.get(t))
        .filter((f): f is string => !!f);
      if (targets.length > POLY_FANOUT_CAP) {
        warn({
          code: "poly-capped",
          path: `${folder}/${fk.field}`,
          message: `${name}.${fk.field} references ${targets.length} in-model entities; drawing the first ${POLY_FANOUT_CAP}`,
        });
      }
      for (const target of targets.slice(0, POLY_FANOUT_CAP)) out.push(baseEdge(folder, target, fk, ctx, business, required));
      continue;
    }

    let target = canonicalTarget(fk, ctx, canonical);
    if (!target) {
      const first = fk.referenceTo[0];
      if (opts.externalStubs !== false && first && fk.referenceTo.length === 1) {
        target = stubFor(ctx, first);
      } else {
        warn({
          code: "edge-target-missing",
          path: `${folder}/${fk.field}`,
          message: `${name}.${fk.field} → ${fk.referenceTo.join("|") || "?"} has no folder in the model; skipped`,
        });
        continue;
      }
    }
    out.push(baseEdge(folder, target, fk, ctx, business, required));
  }
  return out;
}

/**
 * A record type IS-A its parent entity: a named variant that keeps every
 * field and adds its own rules. UML draws that as generalization — a solid
 * line with a hollow triangle at the parent — and so does the diagram, so a
 * subtype reads as a subtype rather than as one more box beside the table.
 * A parent that names no folder in the model gets no line; a missing target
 * would be dropped on validation anyway, and the warning says why.
 */
export function recordTypeEdges(
  r: RecordTypeSchema,
  folder: string,
  ctx: EdgeContext,
  warn: (w: ImportWarning) => void,
): DiagramEdge[] {
  const parent = r.parentEntity;
  if (!parent) return [];
  const canonical = new Set(ctx.nameToFolder.values());
  const target =
    (parent.folder && canonical.has(parent.folder) ? parent.folder : undefined) ??
    (parent.name ? ctx.nameToFolder.get(parent.name) : undefined);
  if (!target || target === folder) {
    warn({
      code: "edge-target-missing",
      path: folder,
      message: `record type ${r.recordType?.name ?? folder} extends ${parent.name ?? parent.folder ?? "?"}, which has no entity folder in the model; no generalization drawn`,
    });
    return [];
  }
  return [
    {
      id: `${folder}::isa::${target}`,
      source: folder,
      target,
      label: "",
      relation: "generalization",
      ...relationDressing(RELATION_KINDS.generalization ?? FALLBACK_RELATION),
      data: { model: { kind: "generalization", parentEntity: target } },
    },
  ];
}

/** The group every stub sits in — emitted once, only when a stub exists. */
export function externalGroup(): FolderNode {
  return {
    id: EXTERNAL_GROUP_ID,
    label: "Outside the model",
    kind: "group",
    icon: "none",
    description: "Entities referenced by the model but not exported with it",
    parentId: null,
    tags: ["external"],
    data: { model: { shape: "external-group" } },
  };
}
