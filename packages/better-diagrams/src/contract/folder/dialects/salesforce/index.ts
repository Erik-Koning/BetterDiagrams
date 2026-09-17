/**
 * dialects/salesforce — the Salesforce data-model folder format.
 *
 * A tree an org exporter writes: bands and groups as folders, one folder
 * per object (with `schema.json` carrying its fields and foreign keys,
 * `object.yaml` a flat summary, `forensics.json` optional), views aliasing
 * an object, record types under it, and a root `relationships.json` naming
 * the business edges. See `shapes.ts` for the six manifests and `spec` for
 * the mapping this implements.
 *
 * Reads `schema.json` as the truth and `object.yaml` only as a fallback.
 * Writes nothing the org exporter owns — export is sidecar-only, with the
 * one opt-in exception of the two curated keys of an `object.yaml`.
 */
import type { DiagramEdge } from "../../../schema";
import { readJson } from "../../tree";
import { SIDECAR_DIR } from "../../sidecar";
import type { Dialect, FolderEntry, FolderNode, FolderImportOptions, ImportWarning } from "../../types";
import { humanise } from "../generic";
import {
  classify,
  isForensics,
  type SfBand,
  type SfGroup,
  type SfObjectSchema,
  type SfRecordType,
  type SfRelationships,
  type SfRootManifest,
  type SfShape,
  type SfView,
} from "./shapes";
import { FIELD_WARNING_THRESHOLD, fieldData, fieldMeta, selectFields, toNodeField, type SfFieldData, type SfFieldMeta } from "./fields";
import { MAX_NODE_FIELDS } from "../../../schema";
import { EXTERNAL_GROUP_ID, externalGroup, objectEdges, type EdgeContext } from "./edges";
import { SALESFORCE_KINDS, diagramTypeOf, objectKind, salesforceRegistry } from "./kinds";
import { parseFlatYaml, patchFlatYaml } from "./yaml";

export const SALESFORCE_DIALECT_ID = "salesforce-datamodel";

/** The default cross-cutting directory an exporter writes beside the bands. */
export const DEFAULT_CROSS_CUTTING = ["metadata"];

export interface SalesforceDialectOptions {
  /** Top-level folders that are metadata, never nodes. */
  crossCutting?: string[];
}

interface Parsed {
  shape: SfShape;
  raw: unknown;
}

export interface SfCtx extends EdgeContext {
  root: SfRootManifest | null;
  crossCutting: string[];
  schemas: Map<string, Parsed>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const firstLine = (s: unknown): string =>
  typeof s === "string" ? (s.split(/\r?\n/)[0] ?? "").trim() : "";

/** Tags an object node carries; one function so the baseline agrees with import. */
function objectTags(sf: {
  kind?: string | null;
  businessLine?: string | null;
  recordCount?: number | null;
  flsPartial?: boolean;
}): string[] {
  const tags: string[] = [];
  if (sf.kind) tags.push(String(sf.kind));
  if (sf.businessLine) tags.push(String(sf.businessLine).toLowerCase());
  if ((sf.recordCount ?? 0) > 0) tags.push("populated");
  if (sf.flsPartial) tags.push("fls-partial");
  return tags;
}

function parsedSchema(entry: FolderEntry, ctx: SfCtx): Parsed | undefined {
  const cached = ctx.schemas.get(entry.path);
  if (cached) return cached;
  if (entry.files["schema.json"] === undefined) return undefined;
  const raw = readJson<unknown>(entry, "schema.json");
  const parsed: Parsed = { shape: raw === undefined ? "unknown" : classify(raw), raw };
  ctx.schemas.set(entry.path, parsed);
  return parsed;
}

/**
 * The node id is the DECLARED `folder`, even when it disagrees with where the
 * file sits — with a warning, never silently. Every cross-reference in the
 * tree (`targetFolders`, `aliasOf.folder`, `parentObject.folder`) names the
 * declared value, so an id taken from the filesystem instead would dangle
 * exactly on the trees where the two differ. A mismatch means the export
 * was moved without being regenerated; the warning says so.
 */
function idFor(entry: FolderEntry, declared: unknown, warn: (w: ImportWarning) => void): string {
  if (typeof declared === "string" && declared.trim() && declared.trim() !== entry.path) {
    warn({
      code: "folder-mismatch",
      path: entry.path,
      message: `schema.json says folder "${declared.trim()}" but sits at "${entry.path}"; using the declared folder as the id`,
    });
    return declared.trim();
  }
  return entry.path;
}

function objectNode(
  entry: FolderEntry,
  schema: SfObjectSchema,
  parentId: string | null,
  ctx: SfCtx,
  opts: FolderImportOptions,
  warn: (w: ImportWarning) => void,
): FolderNode {
  const id = idFor(entry, schema.folder, warn);
  const o = schema.object;
  const curated = schema.curated ?? {};
  const kind = objectKind(curated.diagramType, o.kind, o.apiName);
  const hidden =
    schema.fieldSummary?.hiddenFromIntegrationUser ??
    schema.fields.filter((f) => f.visibleToIntegrationUser === false).length;
  const sf = {
    shape: "object" as const,
    apiName: o.apiName,
    label: o.label ?? null,
    diagramName: curated.diagramName ?? null,
    diagramType: curated.diagramType ?? null,
    keyPrefix: o.keyPrefix ?? null,
    kind: o.kind ?? null,
    namespace: o.namespace ?? null,
    recordCount: o.recordCount ?? null,
    fieldsTotal: schema.fieldSummary?.total ?? schema.fields.length,
    fieldsVisible:
      schema.fieldSummary?.visibleToIntegrationUser ??
      schema.fields.filter((f) => f.visibleToIntegrationUser !== false).length,
    flsPartial: hidden > 0,
    businessLine: curated.businessLine ?? null,
    ...(entry.files["forensics.json"] !== undefined && isForensics(readJson(entry, "forensics.json"))
      ? { forensicsPath: `${entry.path}/forensics.json` }
      : {}),
    validationRuleCount: schema.validationRules?.length ?? 0,
    notes: (schema.notes ?? []).filter((n): n is string => typeof n === "string"),
    // Every field, compactly, whatever the row mode drew — the grid and the
    // search read this; the rows stay the canvas's business.
    fields: schema.fields.slice(0, MAX_NODE_FIELDS).map(fieldData) as SfFieldData[],
    ...(schema.fields.length > MAX_NODE_FIELDS ? { fieldsTruncated: true } : {}),
    fieldMeta: {} as Record<string, SfFieldMeta>,
  };
  if (schema.fields.length > MAX_NODE_FIELDS) {
    warn({
      code: "fields-truncated",
      path: entry.path,
      message: `${o.apiName} has ${schema.fields.length} fields; the document keeps the first ${MAX_NODE_FIELDS}`,
    });
  }
  const partial: FolderNode = {
    id,
    label: curated.diagramName ?? o.label ?? o.apiName,
    kind,
    icon: SALESFORCE_KINDS[kind].icon,
    description: firstLine(schema.notes?.[0]),
    parentId,
    tags: objectTags(sf),
    ...(typeof schema.routes?.lightningList === "string" ? { url: schema.routes.lightningList } : {}),
    w: 230,
  };
  const chosen = selectFields(schema.fields, opts.fields, partial);
  if (chosen.length > FIELD_WARNING_THRESHOLD) {
    warn({
      code: "too-many-fields",
      path: entry.path,
      message: `${o.apiName} shows ${chosen.length} fields; consider fields: "keys"`,
    });
  }
  for (const f of chosen) sf.fieldMeta[f.name] = fieldMeta(f);
  ctx.fieldsByFolder.set(id, new Set(chosen.map((f) => f.name)));
  ctx.parentByFolder.set(id, parentId);
  return {
    ...partial,
    ...(chosen.length ? { fields: chosen.map(toNodeField) } : {}),
    data: { folder: entry.path, sf },
  };
}

function viewNode(entry: FolderEntry, v: SfView, parentId: string | null, warn: (w: ImportWarning) => void): FolderNode {
  const id = idFor(entry, v.folder, warn);
  const label = v.curated?.diagramName ?? v.object?.label ?? v.aliasOf.apiName ?? id;
  return {
    id,
    label,
    kind: "sf-view",
    icon: SALESFORCE_KINDS["sf-view"].icon,
    description: v.view ?? "",
    parentId,
    tags: ["view"],
    data: {
      folder: entry.path,
      sf: {
        shape: "view",
        apiName: v.object?.apiName ?? v.aliasOf.apiName ?? null,
        label: v.object?.label ?? null,
        diagramName: v.curated?.diagramName ?? null,
        aliasOf: v.aliasOf.folder,
        soqlFilter: v.soqlFilter ?? null,
        view: v.view ?? null,
      },
    },
  };
}

function recordTypeNode(
  entry: FolderEntry,
  r: SfRecordType,
  parentId: string | null,
  warn: (w: ImportWarning) => void,
): FolderNode {
  const id = idFor(entry, r.folder, warn);
  const rt = r.recordType ?? {};
  return {
    id,
    label: rt.name ?? r.curated?.diagramName ?? rt.developerName ?? id,
    kind: "sf-record-type",
    icon: SALESFORCE_KINDS["sf-record-type"].icon,
    description: rt.description ?? "",
    parentId,
    tags: ["record-type", ...(rt.isActive === false ? ["inactive"] : [])],
    data: {
      folder: entry.path,
      sf: {
        shape: "record-type",
        name: rt.name ?? null,
        diagramName: r.curated?.diagramName ?? null,
        developerName: rt.developerName ?? null,
        recordTypeId: rt.recordTypeId ?? null,
        isPersonType: rt.isPersonType ?? false,
        isActive: rt.isActive ?? true,
        description: rt.description ?? null,
        parentObject: r.parentObject?.folder ?? null,
      },
    },
  };
}

/**
 * Bands and groups are titled by their FOLDER NAME, humanised — deliberately
 * not by `description`, which the spec's fallback order would reach: a
 * description is a sentence ("Support desk operations") and a card title is
 * a name. The sentence keeps its place as the node's `description`.
 */
function bandNode(entry: FolderEntry, b: SfBand, parentId: string | null, warn: (w: ImportWarning) => void): FolderNode {
  const id = idFor(entry, b.folder, warn);
  return {
    id,
    label: humanise(b.band),
    kind: "group",
    icon: "none",
    description: b.description ?? "",
    parentId,
    data: {
      folder: entry.path,
      sf: {
        shape: "band",
        band: b.band,
        description: b.description ?? null,
        objectCount: b.objectCount ?? b.objects.length,
        ...(b.distinctSObjects ? { distinctSObjects: [...b.distinctSObjects] } : {}),
        ...(b.populatedInSandbox ? { populatedInSandbox: [...b.populatedInSandbox] } : {}),
      },
    },
  };
}

function groupNode(entry: FolderEntry, g: SfGroup, parentId: string | null, warn: (w: ImportWarning) => void): FolderNode {
  const id = idFor(entry, g.folder, warn);
  const base = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  return {
    id,
    label: humanise(base),
    kind: "group",
    icon: "none",
    description: g.description ?? "",
    parentId,
    data: {
      folder: entry.path,
      sf: {
        shape: "group",
        description: g.description ?? null,
        objectCount: g.childCount ?? g.children?.length ?? 0,
      },
    },
  };
}

/** `object.yaml` alone: enough for a labelled box, never for fields or edges. */
function yamlFallback(entry: FolderEntry, parentId: string | null, warn: (w: ImportWarning) => void): FolderNode | null {
  const yaml = parseFlatYaml(entry.files["object.yaml"] ?? "");
  if (!yaml) return null;
  warn({ code: "yaml-fallback-used", path: entry.path, message: `No readable schema.json in ${entry.path}; object.yaml used` });
  const apiName = yaml.apiName ?? yaml.aliasOf ?? entry.path.slice(entry.path.lastIndexOf("/") + 1);
  const label = yaml.diagramName ?? yaml.displayName ?? apiName;
  if (yaml.aliasOf) {
    return {
      id: entry.path, label, kind: "sf-view", icon: SALESFORCE_KINDS["sf-view"].icon,
      description: yaml.soqlFilter ?? "", parentId, tags: ["view"],
      data: { folder: entry.path, sf: { shape: "view", apiName, aliasOf: yaml.aliasOf, soqlFilter: yaml.soqlFilter ?? null, diagramName: yaml.diagramName ?? null, label: yaml.displayName ?? null } },
    };
  }
  if (yaml.developerName || yaml.recordTypeId || yaml.diagramType === "record-type") {
    return {
      id: entry.path, label, kind: "sf-record-type", icon: SALESFORCE_KINDS["sf-record-type"].icon,
      description: "", parentId, tags: ["record-type"],
      data: { folder: entry.path, sf: { shape: "record-type", name: label, developerName: yaml.developerName ?? null, recordTypeId: yaml.recordTypeId ?? null, diagramName: yaml.diagramName ?? null } },
    };
  }
  const kind = objectKind(yaml.diagramType, yaml.type, apiName);
  const recordCount = Number(yaml.recordCount ?? 0) || 0;
  const sf = {
    shape: "object" as const, apiName, label: yaml.displayName ?? null, diagramName: yaml.diagramName ?? null,
    diagramType: yaml.diagramType ?? null, keyPrefix: yaml.keyPrefix ?? null, kind: yaml.type ?? null, namespace: null,
    recordCount, fieldsTotal: Number(yaml.fieldsTotal ?? 0) || 0, fieldsVisible: Number(yaml.fieldsVisibleToIntegrationUser ?? 0) || 0,
    flsPartial: false, businessLine: null, validationRuleCount: 0, notes: [] as string[], fields: [] as SfFieldData[], fieldMeta: {} as Record<string, SfFieldMeta>,
  };
  return {
    id: entry.path, label, kind, icon: SALESFORCE_KINDS[kind].icon, description: "", parentId, tags: objectTags(sf),
    ...(yaml.lightningRoute ? { url: yaml.lightningRoute } : {}), w: 230,
    data: { folder: entry.path, sf },
  };
}

export function createSalesforceDialect(options: SalesforceDialectOptions = {}): Dialect<SfCtx> {
  const configured = options.crossCutting ?? DEFAULT_CROSS_CUTTING;

  const dialect: Dialect<SfCtx> = {
    id: SALESFORCE_DIALECT_ID,
    registry: salesforceRegistry,

    detect(tree) {
      return classify(readJson(tree.root, "schema.json")) === "root";
    },

    prepare(tree, warn) {
      const rootRaw = readJson<unknown>(tree.root, "schema.json");
      const root = classify(rootRaw) === "root" ? (rootRaw as SfRootManifest) : null;
      const declared = root?.crossCutting;
      const crossCutting = [
        ...new Set([
          ...configured,
          ...(typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : []),
        ]),
      ];
      const ctx: SfCtx = {
        root,
        crossCutting,
        schemas: new Map(),
        apiNameToFolder: new Map(),
        business: new Set(),
        fieldsByFolder: new Map(),
        parentByFolder: new Map(),
        stubs: new Map(),
        points: [],
      };
      for (const entry of tree.byPath.values()) {
        if (!entry.path || !dialect.isNode(entry, ctx)) continue;
        const parsed = parsedSchema(entry, ctx);
        if (parsed?.shape === "object") {
          const schema = parsed.raw as SfObjectSchema;
          const folder = typeof schema.folder === "string" && schema.folder ? schema.folder : entry.path;
          const apiName = schema.object.apiName;
          if (ctx.apiNameToFolder.has(apiName)) {
            // Edges resolve BY api name; two folders claiming one means the
            // second's inbound references silently land on the first.
            warn({
              code: "duplicate-api-name",
              path: entry.path,
              message: `${apiName} is also ${ctx.apiNameToFolder.get(apiName)}; references resolve to that folder`,
            });
          } else {
            ctx.apiNameToFolder.set(apiName, folder);
          }
        }
      }
      const rel = readJson<SfRelationships>(tree.root, "relationships.json");
      for (const e of rel?.edges ?? []) {
        if (isRecord(e) && typeof e.from === "string" && typeof e.field === "string") {
          ctx.business.add(`${e.from}::${e.field}`);
        }
      }
      if (!rel && tree.root.files["relationships.json"] !== undefined) {
        warn({ code: "unreadable-file", path: "relationships.json", message: "relationships.json is not valid JSON; every FK reads as non-business" });
      }
      return ctx;
    },

    isNode(entry, ctx) {
      const top = entry.path.split("/")[0];
      return top !== SIDECAR_DIR && !ctx.crossCutting.includes(top);
    },

    toNode(entry, parentId, ctx, opts, warn) {
      const parsed = parsedSchema(entry, ctx);
      if (!parsed || parsed.shape === "unknown") {
        if (entry.files["object.yaml"] !== undefined) return yamlFallback(entry, parentId, warn);
        if (parsed || Object.keys(entry.files).length) {
          warn({ code: "unknown-shape", path: entry.path, message: `${entry.path} has no schema.json shape this dialect knows; skipped` });
        }
        return null;
      }
      switch (parsed.shape) {
        case "band":
          return bandNode(entry, parsed.raw as SfBand, parentId, warn);
        case "group":
          return groupNode(entry, parsed.raw as SfGroup, parentId, warn);
        case "object":
          return objectNode(entry, parsed.raw as SfObjectSchema, parentId, ctx, opts, warn);
        case "record-type":
          return recordTypeNode(entry, parsed.raw as SfRecordType, parentId, warn);
        case "view":
          return viewNode(entry, parsed.raw as SfView, parentId, warn);
        default:
          return null;
      }
    },

    toEdges(entry, ctx, opts, warn) {
      const parsed = parsedSchema(entry, ctx);
      if (parsed?.shape === "object") {
        const schema = parsed.raw as SfObjectSchema;
        const folder = typeof schema.folder === "string" && schema.folder ? schema.folder : entry.path;
        return objectEdges(schema, folder, ctx, opts, warn);
      }
      if (parsed?.shape === "view") {
        const v = parsed.raw as SfView;
        const source = typeof v.folder === "string" && v.folder ? v.folder : entry.path;
        const edge: DiagramEdge = {
          id: `${source}::alias::${v.aliasOf.folder}`,
          source,
          target: v.aliasOf.folder,
          label: "alias",
          style: "dashed",
          color: "slate",
          direction: "none",
          data: { sf: { kind: "alias", soqlFilter: v.soqlFilter ?? null } },
        };
        return [edge];
      }
      return [];
    },

    extraNodes(ctx) {
      const out: FolderNode[] = [...ctx.points];
      if (ctx.stubs.size) {
        out.push(externalGroup());
        for (const stub of [...ctx.stubs.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) out.push(stub);
      }
      return out;
    },

    meta(_tree, ctx) {
      const root = ctx.root;
      return {
        title: root?.title ?? "Salesforce data model",
        folderFormat: {
          ...(root?.$generatedAt ? { generatedAt: root.$generatedAt } : {}),
          ...(root?.$source ? { source: { ...root.$source } } : {}),
          crossCutting: ctx.crossCutting.length === 1 ? ctx.crossCutting[0] : [...ctx.crossCutting],
        },
      };
    },

    baseline(node) {
      const sf = node.data?.sf as Record<string, unknown> | undefined;
      if (!sf || typeof sf.shape !== "string") return null;
      switch (sf.shape) {
        case "object": {
          const notes = Array.isArray(sf.notes) ? sf.notes : [];
          return {
            label: String(sf.diagramName ?? sf.label ?? sf.apiName ?? node.id),
            description: firstLine(notes[0]),
            tags: objectTags(sf as Parameters<typeof objectTags>[0]),
          };
        }
        case "view":
          return {
            label: String(sf.diagramName ?? sf.label ?? sf.apiName ?? node.id),
            description: typeof sf.view === "string" ? sf.view : (typeof sf.soqlFilter === "string" ? sf.soqlFilter : ""),
            tags: ["view"],
          };
        case "record-type":
          return {
            label: String(sf.name ?? sf.diagramName ?? sf.developerName ?? node.id),
            description: typeof sf.description === "string" ? sf.description : "",
            tags: ["record-type", ...(sf.isActive === false ? ["inactive"] : [])],
          };
        case "band":
          return { label: humanise(String(sf.band ?? node.id)), description: typeof sf.description === "string" ? sf.description : "" };
        case "group": {
          const folder = typeof node.data?.folder === "string" ? node.data.folder : node.id;
          return { label: humanise(folder.slice(folder.lastIndexOf("/") + 1)), description: typeof sf.description === "string" ? sf.description : "" };
        }
        case "external":
          return { label: String(sf.apiName ?? node.id), description: "Outside the model", tags: ["external"] };
        case "external-group":
          return { label: "Outside the model", description: "Objects referenced by the model but not exported with it", tags: ["external"] };
        case "poly": {
          const targets = Array.isArray(sf.referenceTo) ? sf.referenceTo.length : 0;
          return { label: `${String(sf.field ?? "")} → ${targets} types`, description: "" };
        }
        default:
          return null;
      }
    },

    sidecarFiles(template, tree, opts, warn) {
      const out = new Map<string, string>();
      if (!opts.writeObjectYaml) return out;
      if (!tree) {
        warn({ code: "no-source-tree", message: "writeObjectYaml needs the source tree; no object.yaml was patched" });
        return out;
      }
      for (const n of template.nodes) {
        const folder = typeof n.data?.folder === "string" ? n.data.folder : null;
        const sf = n.data?.sf as Record<string, unknown> | undefined;
        if (!folder || !sf || n.id === EXTERNAL_GROUP_ID) continue;
        const entry = tree.byPath.get(folder);
        const text = entry?.files["object.yaml"];
        if (text === undefined) continue;
        const current = parseFlatYaml(text);
        if (!current) {
          warn({ code: "unreadable-file", path: `${folder}/object.yaml`, message: "object.yaml is not flat key: value; left untouched" });
          continue;
        }
        const patch: Record<string, string> = {};
        if (current.diagramName !== n.label) patch.diagramName = n.label;
        const type = diagramTypeOf(n.kind);
        if (type && current.diagramType !== undefined && current.diagramType !== type) patch.diagramType = type;
        if (!Object.keys(patch).length) continue;
        const patched = patchFlatYaml(text, patch);
        if (patched !== null) out.set(`${folder}/object.yaml`, patched);
      }
      return out;
    },
  };
  return dialect;
}

export const salesforceDialect: Dialect<SfCtx> = createSalesforceDialect();

export { SALESFORCE_KINDS, salesforceRegistry } from "./kinds";
export { parseFlatYaml, patchFlatYaml } from "./yaml";
export { classify as classifySalesforceShape } from "./shapes";
export type { SfShape, SfObjectSchema, SfField, SfForeignKey } from "./shapes";
