/**
 * edges.ts — an object's `foreignKeys[]` as diagram edges.
 *
 * `foreignKeys[]` is the source of truth (it is complete, audit FKs and
 * all); `relationships.json` only says which of them are BUSINESS edges, so
 * the default view can leave `OwnerId` / `CreatedById` noise out. An edge
 * runs child → parent — FK holder to referenced — and joins canonical
 * object folders only; a view is an alias, not a table, and gets no FK
 * lines of its own.
 */
import type { DiagramEdge, EdgeColor, EdgeStyle } from "../../../schema";
import type { FolderNode, FolderImportOptions, ImportWarning } from "../../types";
import type { SfForeignKey, SfObjectSchema } from "./shapes";

/** How many targets `polymorphic: "in-model"` fans out to before capping. */
export const POLY_FANOUT_CAP = 12;

export const EXTERNAL_GROUP_ID = "_external";

export interface EdgeContext {
  /** Canonical object folder per apiName — views excluded. */
  apiNameToFolder: Map<string, string>;
  /** `${apiName}::${field}` for every edge `relationships.json` lists. */
  business: Set<string>;
  /** Field ids each node carries, so anchors only name rows that exist. */
  fieldsByFolder: Map<string, Set<string>>;
  /** Node id per folder, for the point node's parent. */
  parentByFolder: Map<string, string | null>;
  /** Stub nodes requested so far, by apiName. */
  stubs: Map<string, FolderNode>;
  /** Collapse points requested so far. */
  points: FolderNode[];
}

const STYLE: Record<string, EdgeStyle> = {
  masterDetail: "solid",
  lookup: "dashed",
  hierarchy: "dashed",
  polymorphic: "dotted",
};
const COLOR: Record<string, EdgeColor> = {
  masterDetail: "rose",
  lookup: "slate",
  hierarchy: "violet",
  polymorphic: "amber",
};

export const stubId = (apiName: string) => `${EXTERNAL_GROUP_ID}/${apiName.toLowerCase()}`;

function stubFor(ctx: EdgeContext, apiName: string): string {
  const known = ctx.stubs.get(apiName);
  if (known) return known.id;
  const node: FolderNode = {
    id: stubId(apiName),
    label: apiName,
    kind: "sf-external",
    icon: "link",
    description: "Outside the model",
    parentId: EXTERNAL_GROUP_ID,
    tags: ["external"],
    data: { sf: { shape: "external", apiName } },
  };
  ctx.stubs.set(apiName, node);
  return node.id;
}

function baseEdge(
  sourceFolder: string,
  targetId: string,
  fk: SfForeignKey,
  ctx: EdgeContext,
  business: boolean,
): DiagramEdge {
  const kind = fk.kind;
  const hasStart = ctx.fieldsByFolder.get(sourceFolder)?.has(fk.field) ?? false;
  const hasEnd = ctx.fieldsByFolder.get(targetId)?.has("Id") ?? false;
  return {
    id: `${sourceFolder}::${fk.field}::${targetId}`,
    source: sourceFolder,
    target: targetId,
    label: fk.relationshipName ?? fk.field,
    tech: kind,
    style: STYLE[kind] ?? "dashed",
    color: COLOR[kind] ?? "slate",
    ...(kind === "masterDetail" ? { startHead: "diamond" } : {}),
    startLabel: "*",
    endLabel: kind === "masterDetail" ? "1" : "0..1",
    ...(hasStart ? { startField: fk.field } : {}),
    ...(hasEnd ? { endField: "Id" } : {}),
    data: {
      sf: {
        field: fk.field,
        kind,
        relationshipName: fk.relationshipName ?? null,
        referenceTo: [...fk.referenceTo],
        required: fk.required ?? false,
        cascadeDelete: fk.cascadeDelete ?? false,
        deleteConstraint: fk.deleteConstraint ?? null,
        visibleToIntegrationUser: fk.visibleToIntegrationUser ?? true,
        business,
      },
    },
  };
}

/** The canonical object folder an FK points at, or null when the target is outside the model. */
function canonicalTarget(fk: SfForeignKey, ctx: EdgeContext, canonical: ReadonlySet<string>): string | null {
  for (const folder of fk.targetFolders ?? []) if (canonical.has(folder)) return folder;
  const first = fk.referenceTo[0];
  return (first && ctx.apiNameToFolder.get(first)) ?? null;
}

export function objectEdges(
  schema: SfObjectSchema,
  folder: string,
  ctx: EdgeContext,
  opts: FolderImportOptions,
  warn: (w: ImportWarning) => void,
): DiagramEdge[] {
  const out: DiagramEdge[] = [];
  const apiName = schema.object.apiName;
  const canonical = new Set(ctx.apiNameToFolder.values());
  for (const fk of schema.foreignKeys ?? []) {
    const business = ctx.business.has(`${apiName}::${fk.field}`);
    if ((opts.edges ?? "business") === "business" && !business) continue;

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
          // Beside the object, not inside it: inside a non-container the
          // point would be drill-in detail, invisible on the canvas the
          // edge is drawn on.
          parentId: ctx.parentByFolder.get(folder) ?? null,
          data: { sf: { shape: "poly", field: fk.field, referenceTo: [...fk.referenceTo] } },
        });
        out.push(baseEdge(folder, pointId, fk, ctx, business));
        continue;
      }
      // in-model: one edge per target that has a folder, capped.
      const targets = fk.referenceTo
        .map((name) => ctx.apiNameToFolder.get(name))
        .filter((f): f is string => !!f);
      if (targets.length > POLY_FANOUT_CAP) {
        warn({
          code: "poly-capped",
          path: `${folder}/${fk.field}`,
          message: `${apiName}.${fk.field} references ${targets.length} in-model objects; drawing the first ${POLY_FANOUT_CAP}`,
        });
      }
      for (const target of targets.slice(0, POLY_FANOUT_CAP)) out.push(baseEdge(folder, target, fk, ctx, business));
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
          message: `${apiName}.${fk.field} → ${fk.referenceTo.join("|") || "?"} has no folder in the model; skipped`,
        });
        continue;
      }
    }
    out.push(baseEdge(folder, target, fk, ctx, business));
  }
  return out;
}

/** The group every stub sits in — emitted once, only when a stub exists. */
export function externalGroup(): FolderNode {
  return {
    id: EXTERNAL_GROUP_ID,
    label: "Outside the model",
    kind: "group",
    icon: "none",
    description: "Objects referenced by the model but not exported with it",
    parentId: null,
    tags: ["external"],
    data: { sf: { shape: "external-group" } },
  };
}
