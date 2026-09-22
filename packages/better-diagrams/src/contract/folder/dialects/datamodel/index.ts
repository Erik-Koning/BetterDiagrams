/**
 * dialects/datamodel — the data-model folder format.
 *
 * A tree an exporter writes from a database, an API's object model, or any
 * other system with entities and fields: bands and groups as folders, one
 * folder per entity (with `schema.json` carrying its fields and foreign
 * keys, `entity.yaml` a flat summary, `forensics.json` optional), views
 * aliasing an entity, record types under it, and a root `relationships.json`
 * naming the business edges. See `shapes.ts` for the six manifests.
 *
 * Record types are values of one field, not tables: by default an entity's
 * fold into ONE enumeration node beside it (a row each, a reference line
 * from the discriminator), and their folders — leaves and wrapper group —
 * produce no nodes. `recordTypes: "nodes"` keeps one leaf each.
 *
 * The tree's own shape counts too: a folder that says nothing about itself
 * but holds entities is a group, so a plain directory structure — schemas
 * as folders, tables inside — reads without a manifest at every level.
 *
 * Reads `schema.json` as the truth and `entity.yaml` only as a fallback.
 * Writes nothing the exporter owns — export is sidecar-only, with the one
 * opt-in exception of the two curated keys of an `entity.yaml`.
 */
import type { DiagramEdge, NodeField } from "../../../schema";
import { readJson } from "../../tree";
import { SIDECAR_DIR } from "../../sidecar";
import type { Dialect, FolderEntry, FolderNode, FolderImportOptions, ImportWarning } from "../../types";
import { humanise } from "../generic";
import {
  classify,
  isForensics,
  type BandManifest,
  type GroupManifest,
  type EntitySchema,
  type RecordTypeSchema,
  type RelationshipsManifest,
  type RootManifest,
  type ModelShape,
  type ViewSchema,
} from "./shapes";
import {
  FIELD_WARNING_THRESHOLD,
  fieldData,
  fieldMeta,
  primaryKeyOf,
  selectFields,
  toNodeField,
  type FieldData,
  type FieldMeta,
} from "./fields";
import { MAX_NODE_FIELDS } from "../../../schema";
import {
  EXTERNAL_GROUP_ID,
  externalGroup,
  entityEdges,
  isDiscriminator,
  recordTypeEdges,
  recordTypeEnumId,
  type EdgeContext,
} from "./edges";
import { DATAMODEL_KINDS, diagramTypeOf, entityKind, dataModelRegistry } from "./kinds";
import { parseFlatYaml, patchFlatYaml } from "./yaml";

export const DATAMODEL_DIALECT_ID = "datamodel";

/** The default cross-cutting directory an exporter writes beside the bands. */
export const DEFAULT_CROSS_CUTTING = ["metadata"];

export interface DataModelDialectOptions {
  /** Top-level folders that are metadata, never nodes. */
  crossCutting?: string[];
}

interface Parsed {
  shape: ModelShape;
  raw: unknown;
}

/** One record type as its folder states it — from `schema.json`, or an `entity.yaml` alone. */
interface RecordTypeInfo {
  folder: string;
  name: string | null;
  key: string | null;
  id: string | null;
  active: boolean;
  description: string | null;
  parent: { folder?: string; name?: string } | null;
}

/** An entity's record types, in folder order, with the wrapper group's description when one exists. */
interface RecordTypeGroup {
  description: string | null;
  items: RecordTypeInfo[];
}

export interface ModelCtx extends EdgeContext {
  root: RootManifest | null;
  crossCutting: string[];
  schemas: Map<string, Parsed>;
  /** Every node folder that is a record type, whatever mode draws it. */
  recordTypeByPath: Map<string, RecordTypeInfo | null>;
  /** Record types by the entity folder they extend — only the resolvable ones. */
  recordTypes: Map<string, RecordTypeGroup>;
  /** Each entity's discriminator field, when it has one. */
  discriminatorByFolder: Map<string, string>;
  /** Each entity's card title, so the enumeration beside it can name it. */
  labelByFolder: Map<string, string>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const firstLine = (s: unknown): string =>
  typeof s === "string" ? (s.split(/\r?\n/)[0] ?? "").trim() : "";

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Tags an entity node carries; one function so the baseline agrees with import. */
function entityTags(m: {
  kind?: string | null;
  businessLine?: string | null;
  recordCount?: number | null;
  hiddenFields?: number | null;
}): string[] {
  const tags: string[] = [];
  if (m.kind) tags.push(String(m.kind));
  if (m.businessLine) tags.push(String(m.businessLine).toLowerCase());
  if ((m.recordCount ?? 0) > 0) tags.push("populated");
  if ((m.hiddenFields ?? 0) > 0) tags.push("hidden-fields");
  return tags;
}

function parsedSchema(entry: FolderEntry, ctx: ModelCtx): Parsed | undefined {
  const cached = ctx.schemas.get(entry.path);
  if (cached) return cached;
  if (entry.files["schema.json"] === undefined) return undefined;
  const raw = readJson<unknown>(entry, "schema.json");
  const parsed: Parsed = { shape: raw === undefined ? "unknown" : classify(raw), raw };
  // An entity is its fields; a missing or nameless `entity` block is filled
  // from the folder, so a bare `{ fields: [...] }` is a table named after
  // where it sits rather than a crash.
  if (parsed.shape === "entity" && isRecord(raw)) {
    const block = isRecord(raw.entity) ? raw.entity : {};
    if (typeof block.name !== "string" || !block.name) raw.entity = { ...block, name: basename(entry.path) };
  }
  ctx.schemas.set(entry.path, parsed);
  return parsed;
}

/**
 * The node id is the DECLARED `folder`, even when it disagrees with where the
 * file sits — with a warning, never silently. Every cross-reference in the
 * tree (`targetFolders`, `aliasOf.folder`, `parentEntity.folder`) names the
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

function entityNode(
  entry: FolderEntry,
  schema: EntitySchema,
  parentId: string | null,
  ctx: ModelCtx,
  opts: FolderImportOptions,
  warn: (w: ImportWarning) => void,
): FolderNode {
  const id = idFor(entry, schema.folder, warn);
  const e = schema.entity;
  const curated = schema.curated ?? {};
  const kind = entityKind(curated.diagramType, e.kind);
  const hidden = schema.fieldSummary?.hidden ?? schema.fields.filter((f) => f.visible === false).length;
  const model = {
    shape: "entity" as const,
    name: e.name,
    label: e.label ?? null,
    diagramName: curated.diagramName ?? null,
    diagramType: curated.diagramType ?? null,
    kind: e.kind ?? null,
    namespace: e.namespace ?? null,
    recordCount: e.recordCount ?? null,
    fieldsTotal: schema.fieldSummary?.total ?? schema.fields.length,
    fieldsVisible: schema.fieldSummary?.visible ?? schema.fields.filter((f) => f.visible !== false).length,
    hiddenFields: hidden,
    businessLine: curated.businessLine ?? null,
    ...(entry.files["forensics.json"] !== undefined && isForensics(readJson(entry, "forensics.json"))
      ? { forensicsPath: `${entry.path}/forensics.json` }
      : {}),
    validationRuleCount: schema.validationRules?.length ?? 0,
    notes: (schema.notes ?? []).filter((n): n is string => typeof n === "string"),
    // Every field, compactly, whatever the row mode drew — the grid and the
    // search read this; the rows stay the canvas's business.
    fields: schema.fields.slice(0, MAX_NODE_FIELDS).map(fieldData) as FieldData[],
    ...(schema.fields.length > MAX_NODE_FIELDS ? { fieldsTruncated: true } : {}),
    fieldMeta: {} as Record<string, FieldMeta>,
  };
  if (schema.fields.length > MAX_NODE_FIELDS) {
    warn({
      code: "fields-truncated",
      path: entry.path,
      message: `${e.name} has ${schema.fields.length} fields; the document keeps the first ${MAX_NODE_FIELDS}`,
    });
  }
  const partial: FolderNode = {
    id,
    label: curated.diagramName ?? e.label ?? e.name,
    kind,
    icon: DATAMODEL_KINDS[kind].icon,
    description: firstLine(schema.notes?.[0]),
    parentId,
    tags: entityTags(model),
    ...(typeof schema.url === "string" && schema.url ? { url: schema.url } : {}),
    w: 230,
  };
  // Rows the entity pins by name, on top of the import-wide mode. A name
  // the schema doesn't list is a stale curation, and says so.
  const known = new Set(schema.fields.map((f) => f.name));
  const pinned = (curated.diagramFields ?? []).filter((n): n is string => typeof n === "string");
  for (const n of pinned) {
    if (!known.has(n)) {
      warn({ code: "unknown-field", path: entry.path, message: `curated.diagramFields names "${n}", which ${e.name} has no field called; ignored` });
    }
  }
  const chosen = selectFields(schema.fields, opts.fields, partial, pinned);
  if (chosen.length > FIELD_WARNING_THRESHOLD) {
    warn({
      code: "too-many-fields",
      path: entry.path,
      message: `${e.name} shows ${chosen.length} fields; consider fields: "keys"`,
    });
  }
  for (const f of chosen) model.fieldMeta[f.name] = fieldMeta(f);
  ctx.fieldsByFolder.set(id, new Set(chosen.map((f) => f.name)));
  ctx.parentByFolder.set(id, parentId);
  ctx.labelByFolder.set(id, partial.label);
  return {
    ...partial,
    ...(chosen.length ? { fields: chosen.map(toNodeField) } : {}),
    data: { folder: entry.path, model },
  };
}

function viewNode(entry: FolderEntry, v: ViewSchema, parentId: string | null, warn: (w: ImportWarning) => void): FolderNode {
  const id = idFor(entry, v.folder, warn);
  const label = v.curated?.diagramName ?? v.entity?.label ?? v.aliasOf.name ?? id;
  return {
    id,
    label,
    kind: "view",
    icon: DATAMODEL_KINDS.view.icon,
    description: v.view ?? "",
    parentId,
    tags: ["view"],
    data: {
      folder: entry.path,
      model: {
        shape: "view",
        name: v.entity?.name ?? v.aliasOf.name ?? null,
        label: v.entity?.label ?? null,
        diagramName: v.curated?.diagramName ?? null,
        aliasOf: v.aliasOf.folder,
        filter: v.filter ?? null,
        view: v.view ?? null,
      },
    },
  };
}

function recordTypeNode(
  entry: FolderEntry,
  r: RecordTypeSchema,
  parentId: string | null,
  warn: (w: ImportWarning) => void,
): FolderNode {
  const id = idFor(entry, r.folder, warn);
  const rt = r.recordType ?? {};
  return {
    id,
    label: rt.name ?? r.curated?.diagramName ?? rt.key ?? id,
    kind: "record-type",
    icon: DATAMODEL_KINDS["record-type"].icon,
    description: rt.description ?? "",
    parentId,
    tags: ["record-type", ...(rt.active === false ? ["inactive"] : [])],
    data: {
      folder: entry.path,
      model: {
        shape: "record-type",
        name: rt.name ?? null,
        diagramName: r.curated?.diagramName ?? null,
        key: rt.key ?? null,
        id: rt.id ?? null,
        active: rt.active ?? true,
        description: rt.description ?? null,
        parentEntity: r.parentEntity?.folder ?? null,
      },
    },
  };
}

/**
 * What a folder says about being a record type, by either manifest. Read in
 * `prepare`, so the walk knows a wrapper group's children before it reaches
 * them, and so the enumeration can be built without a second parse.
 */
function recordTypeOf(entry: FolderEntry, ctx: ModelCtx): RecordTypeInfo | null {
  const cached = ctx.recordTypeByPath.get(entry.path);
  if (cached !== undefined) return cached;
  let info: RecordTypeInfo | null = null;
  const parsed = parsedSchema(entry, ctx);
  if (parsed?.shape === "record-type") {
    const r = parsed.raw as RecordTypeSchema;
    const rt = r.recordType ?? {};
    info = {
      folder: entry.path,
      name: rt.name ?? r.curated?.diagramName ?? null,
      key: rt.key ?? null,
      id: rt.id ?? null,
      active: rt.active !== false,
      description: rt.description ?? null,
      parent: r.parentEntity ?? null,
    };
  } else if ((!parsed || parsed.shape === "unknown") && entry.files["entity.yaml"] !== undefined) {
    const yaml = parseFlatYaml(entry.files["entity.yaml"] ?? "");
    if (yaml && !yaml.aliasOf && (yaml.key || yaml.diagramType === "record-type")) {
      info = {
        folder: entry.path,
        name: yaml.diagramName ?? yaml.label ?? yaml.name ?? null,
        key: yaml.key ?? null,
        id: yaml.id ?? null,
        active: true,
        description: null,
        parent: null,
      };
    }
  }
  ctx.recordTypeByPath.set(entry.path, info);
  return info;
}

/**
 * The entity a record type extends: the folder it declares when that is an
 * entity in the model, else the entity of that name, else the nearest
 * entity folder above it — where an exporter that writes only `entity.yaml`
 * will have put it.
 */
function recordTypeParent(info: RecordTypeInfo, ctx: ModelCtx): string | null {
  const canonical = new Set(ctx.nameToFolder.values());
  const declared = info.parent?.folder;
  if (declared && canonical.has(declared)) return declared;
  const byName = info.parent?.name ? ctx.nameToFolder.get(info.parent.name) : undefined;
  if (byName) return byName;
  let path = info.folder;
  while (path.includes("/")) {
    path = path.slice(0, path.lastIndexOf("/"));
    if (canonical.has(path)) return path;
  }
  return null;
}

/** A group folder that holds record types and nothing else — scaffolding the enumeration replaces. */
function isRecordTypeWrapper(entry: FolderEntry, ctx: ModelCtx): boolean {
  return entry.children.length > 0 && entry.children.every((c) => ctx.recordTypeByPath.get(c.path));
}

/**
 * The enumeration an entity's record types fold into. Rows are the values —
 * the stable key, or the folder when there is none — and an inactive one
 * says so in the type column, the one place a row has for a word.
 */
function recordTypeEnumNode(entity: string, group: RecordTypeGroup, ctx: ModelCtx): FolderNode {
  const label = ctx.labelByFolder.get(entity) ?? humanise(basename(entity));
  const used = new Set<string>();
  const fields: NodeField[] = group.items.map((r) => {
    let id = r.key ?? basename(r.folder);
    if (used.has(id)) id = r.folder;
    used.add(id);
    return {
      id,
      name: r.name ?? r.key ?? humanise(basename(r.folder)),
      ...(r.active ? {} : { type: "inactive" }),
    };
  });
  return {
    id: recordTypeEnumId(entity),
    label: `${label} record types`,
    kind: "enum",
    icon: "none",
    description: group.description ?? "",
    // Beside the entity, as a collapse point is: inside a non-container it
    // would be drill-in detail, invisible on the canvas its line is drawn on.
    parentId: ctx.parentByFolder.get(entity) ?? null,
    tags: ["record-type"],
    fields,
    data: {
      model: {
        shape: "record-types",
        entity,
        entityLabel: label,
        description: group.description,
        discriminator: ctx.discriminatorByFolder.get(entity) ?? null,
        recordTypes: group.items.map(({ folder, name, key, id, active, description }) => ({
          folder,
          name,
          key,
          id,
          active,
          description,
        })),
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
function bandNode(entry: FolderEntry, b: BandManifest, parentId: string | null, warn: (w: ImportWarning) => void): FolderNode {
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
      model: {
        shape: "band",
        band: b.band,
        description: b.description ?? null,
        entityCount: b.entityCount ?? b.entities.length,
      },
    },
  };
}

function groupNode(entry: FolderEntry, g: GroupManifest, parentId: string | null, warn: (w: ImportWarning) => void): FolderNode {
  const id = idFor(entry, g.folder, warn);
  return {
    id,
    label: humanise(basename(entry.path)),
    kind: "group",
    icon: "none",
    description: g.description ?? "",
    parentId,
    data: {
      folder: entry.path,
      model: {
        shape: "group",
        description: g.description ?? null,
        entityCount: g.childCount ?? g.children?.length ?? 0,
      },
    },
  };
}

/** A folder with no manifest of its own, holding folders: the tree's shape is the model's. */
function plainGroup(entry: FolderEntry, parentId: string | null): FolderNode {
  return {
    id: entry.path,
    label: humanise(basename(entry.path)),
    kind: "group",
    icon: "none",
    description: "",
    parentId,
    data: {
      folder: entry.path,
      model: { shape: "group", description: null, entityCount: entry.children.length },
    },
  };
}

/** `entity.yaml` alone: enough for a labelled box, never for fields or edges. */
function yamlFallback(entry: FolderEntry, parentId: string | null, warn: (w: ImportWarning) => void): FolderNode | null {
  const yaml = parseFlatYaml(entry.files["entity.yaml"] ?? "");
  if (!yaml) return null;
  warn({ code: "yaml-fallback-used", path: entry.path, message: `No readable schema.json in ${entry.path}; entity.yaml used` });
  const name = yaml.name ?? yaml.aliasOf ?? basename(entry.path);
  const label = yaml.diagramName ?? yaml.label ?? name;
  if (yaml.aliasOf) {
    return {
      id: entry.path, label, kind: "view", icon: DATAMODEL_KINDS.view.icon,
      description: yaml.filter ?? "", parentId, tags: ["view"],
      data: { folder: entry.path, model: { shape: "view", name, aliasOf: yaml.aliasOf, filter: yaml.filter ?? null, diagramName: yaml.diagramName ?? null, label: yaml.label ?? null } },
    };
  }
  if (yaml.key || yaml.diagramType === "record-type") {
    return {
      id: entry.path, label, kind: "record-type", icon: DATAMODEL_KINDS["record-type"].icon,
      description: "", parentId, tags: ["record-type"],
      data: { folder: entry.path, model: { shape: "record-type", name: label, key: yaml.key ?? null, id: yaml.id ?? null, diagramName: yaml.diagramName ?? null } },
    };
  }
  const kind = entityKind(yaml.diagramType, yaml.kind);
  const recordCount = Number(yaml.recordCount ?? 0) || 0;
  const model = {
    shape: "entity" as const, name, label: yaml.label ?? null, diagramName: yaml.diagramName ?? null,
    diagramType: yaml.diagramType ?? null, kind: yaml.kind ?? null, namespace: null,
    recordCount, fieldsTotal: Number(yaml.fieldsTotal ?? 0) || 0, fieldsVisible: Number(yaml.fieldsVisible ?? 0) || 0,
    hiddenFields: 0, businessLine: null, validationRuleCount: 0, notes: [] as string[], fields: [] as FieldData[], fieldMeta: {} as Record<string, FieldMeta>,
  };
  return {
    id: entry.path, label, kind, icon: DATAMODEL_KINDS[kind].icon, description: "", parentId, tags: entityTags(model),
    ...(yaml.url ? { url: yaml.url } : {}), w: 230,
    data: { folder: entry.path, model },
  };
}

export function createDataModelDialect(options: DataModelDialectOptions = {}): Dialect<ModelCtx> {
  const configured = options.crossCutting ?? DEFAULT_CROSS_CUTTING;

  const dialect: Dialect<ModelCtx> = {
    id: DATAMODEL_DIALECT_ID,
    registry: dataModelRegistry,

    detect(tree) {
      return classify(readJson(tree.root, "schema.json")) === "root";
    },

    prepare(tree, warn) {
      const rootRaw = readJson<unknown>(tree.root, "schema.json");
      const root = classify(rootRaw) === "root" ? (rootRaw as RootManifest) : null;
      const declared = root?.crossCutting;
      const crossCutting = [
        ...new Set([
          ...configured,
          ...(typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : []),
        ]),
      ];
      const ctx: ModelCtx = {
        root,
        crossCutting,
        schemas: new Map(),
        nameToFolder: new Map(),
        business: new Set(),
        fieldsByFolder: new Map(),
        primaryKeyByFolder: new Map(),
        parentByFolder: new Map(),
        stubs: new Map(),
        points: [],
        recordTypeEntities: new Set(),
        recordTypeByPath: new Map(),
        recordTypes: new Map(),
        discriminatorByFolder: new Map(),
        labelByFolder: new Map(),
      };
      for (const entry of tree.byPath.values()) {
        if (!entry.path || !dialect.isNode(entry, ctx)) continue;
        const parsed = parsedSchema(entry, ctx);
        if (parsed?.shape === "entity") {
          const schema = parsed.raw as EntitySchema;
          const folder = typeof schema.folder === "string" && schema.folder ? schema.folder : entry.path;
          const name = schema.entity.name;
          const pk = primaryKeyOf(schema.fields);
          if (pk) ctx.primaryKeyByFolder.set(folder, pk.name);
          const discriminator = schema.fields.find(isDiscriminator);
          if (discriminator) ctx.discriminatorByFolder.set(folder, discriminator.name);
          if (ctx.nameToFolder.has(name)) {
            // Edges resolve BY name; two folders claiming one means the
            // second's inbound references silently land on the first.
            warn({
              code: "duplicate-name",
              path: entry.path,
              message: `${name} is also ${ctx.nameToFolder.get(name)}; references resolve to that folder`,
            });
          } else {
            ctx.nameToFolder.set(name, folder);
          }
        }
      }
      // Record types after every entity is named, since a parent resolves by name.
      const entries = [...tree.byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      for (const entry of entries) {
        if (!entry.path || !dialect.isNode(entry, ctx)) continue;
        const info = recordTypeOf(entry, ctx);
        if (!info) continue;
        const parent = recordTypeParent(info, ctx);
        if (!parent) continue;
        let group = ctx.recordTypes.get(parent);
        if (!group) {
          group = { description: null, items: [] };
          ctx.recordTypes.set(parent, group);
          ctx.recordTypeEntities.add(parent);
        }
        group.items.push(info);
        // The wrapper folder's description ("How a person is classified")
        // is the enumeration's: it is about the set, not any one value.
        const wrapper = entry.path.includes("/") ? tree.byPath.get(entry.path.slice(0, entry.path.lastIndexOf("/"))) : undefined;
        const manifest = wrapper ? parsedSchema(wrapper, ctx) : undefined;
        if (group.description === null && manifest?.shape === "group") {
          group.description = (manifest.raw as GroupManifest).description ?? null;
        }
      }
      const rel = readJson<RelationshipsManifest>(tree.root, "relationships.json");
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
      // A record type is a row of the enumeration, and its wrapper group is
      // scaffolding — neither is a node unless the leaves were asked for.
      if ((opts.recordTypes ?? "enum") !== "nodes") {
        const info = recordTypeOf(entry, ctx);
        if (info) {
          if (opts.recordTypes !== "none" && !recordTypeParent(info, ctx)) {
            warn({
              code: "edge-target-missing",
              path: entry.path,
              message: `record type ${info.name ?? entry.path} extends ${info.parent?.name ?? info.parent?.folder ?? "?"}, which has no entity folder in the model; left out of the enumeration`,
            });
          }
          return null;
        }
        if (isRecordTypeWrapper(entry, ctx)) return null;
      }
      const parsed = parsedSchema(entry, ctx);
      if (!parsed || parsed.shape === "unknown") {
        if (entry.files["entity.yaml"] !== undefined) return yamlFallback(entry, parentId, warn);
        // No manifest, but folders inside: a plain group. A leaf that says
        // nothing is skipped, and says so when it had files to say it with.
        if (parsed || (!entry.children.length && Object.keys(entry.files).length)) {
          warn({
            code: "unknown-shape",
            path: entry.path,
            message: `${entry.path} has no schema.json shape this dialect knows; ${entry.children.length ? "read as a group" : "skipped"}`,
          });
        }
        return entry.children.length ? plainGroup(entry, parentId) : null;
      }
      switch (parsed.shape) {
        case "band":
          return bandNode(entry, parsed.raw as BandManifest, parentId, warn);
        case "group":
          return groupNode(entry, parsed.raw as GroupManifest, parentId, warn);
        case "entity":
          return entityNode(entry, parsed.raw as EntitySchema, parentId, ctx, opts, warn);
        case "record-type":
          return recordTypeNode(entry, parsed.raw as RecordTypeSchema, parentId, warn);
        case "view":
          return viewNode(entry, parsed.raw as ViewSchema, parentId, warn);
        default:
          return null;
      }
    },

    toEdges(entry, ctx, opts, warn) {
      const parsed = parsedSchema(entry, ctx);
      if (parsed?.shape === "entity") {
        const schema = parsed.raw as EntitySchema;
        const folder = typeof schema.folder === "string" && schema.folder ? schema.folder : entry.path;
        return entityEdges(schema, folder, ctx, opts, warn);
      }
      if (parsed?.shape === "record-type") {
        const r = parsed.raw as RecordTypeSchema;
        const folder = typeof r.folder === "string" && r.folder ? r.folder : entry.path;
        return recordTypeEdges(r, folder, ctx, warn);
      }
      if (parsed?.shape === "view") {
        const v = parsed.raw as ViewSchema;
        const source = typeof v.folder === "string" && v.folder ? v.folder : entry.path;
        const edge: DiagramEdge = {
          id: `${source}::alias::${v.aliasOf.folder}`,
          source,
          target: v.aliasOf.folder,
          label: "alias",
          style: "dashed",
          color: "slate",
          direction: "none",
          data: { model: { kind: "alias", filter: v.filter ?? null } },
        };
        return [edge];
      }
      return [];
    },

    extraNodes(ctx, opts) {
      const out: FolderNode[] = [];
      if ((opts.recordTypes ?? "enum") === "enum") {
        const entities = [...ctx.recordTypes.keys()].sort((a, b) => (a < b ? -1 : 1));
        for (const entity of entities) out.push(recordTypeEnumNode(entity, ctx.recordTypes.get(entity)!, ctx));
      }
      out.push(...ctx.points);
      if (ctx.stubs.size) {
        out.push(externalGroup());
        for (const stub of [...ctx.stubs.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) out.push(stub);
      }
      return out;
    },

    meta(_tree, ctx) {
      const root = ctx.root;
      return {
        title: root?.title ?? "Data model",
        folderFormat: {
          ...(root?.$generatedAt ? { generatedAt: root.$generatedAt } : {}),
          ...(root?.$source ? { source: { ...root.$source } } : {}),
          crossCutting: ctx.crossCutting.length === 1 ? ctx.crossCutting[0] : [...ctx.crossCutting],
        },
      };
    },

    baseline(node) {
      const m = node.data?.model as Record<string, unknown> | undefined;
      if (!m || typeof m.shape !== "string") return null;
      switch (m.shape) {
        case "entity": {
          const notes = Array.isArray(m.notes) ? m.notes : [];
          return {
            label: String(m.diagramName ?? m.label ?? m.name ?? node.id),
            description: firstLine(notes[0]),
            tags: entityTags(m as Parameters<typeof entityTags>[0]),
          };
        }
        case "view":
          return {
            label: String(m.diagramName ?? m.label ?? m.name ?? node.id),
            description: typeof m.view === "string" ? m.view : (typeof m.filter === "string" ? m.filter : ""),
            tags: ["view"],
          };
        case "record-type":
          return {
            label: String(m.name ?? m.diagramName ?? m.key ?? node.id),
            description: typeof m.description === "string" ? m.description : "",
            tags: ["record-type", ...(m.active === false ? ["inactive"] : [])],
          };
        case "record-types":
          return {
            label: `${String(m.entityLabel ?? "")} record types`,
            description: typeof m.description === "string" ? m.description : "",
            tags: ["record-type"],
          };
        case "band":
          return { label: humanise(String(m.band ?? node.id)), description: typeof m.description === "string" ? m.description : "" };
        case "group": {
          const folder = typeof node.data?.folder === "string" ? node.data.folder : node.id;
          return { label: humanise(basename(folder)), description: typeof m.description === "string" ? m.description : "" };
        }
        case "external":
          return { label: String(m.name ?? node.id), description: "Outside the model", tags: ["external"] };
        case "external-group":
          return { label: "Outside the model", description: "Entities referenced by the model but not exported with it", tags: ["external"] };
        case "poly": {
          const targets = Array.isArray(m.referenceTo) ? m.referenceTo.length : 0;
          return { label: `${String(m.field ?? "")} → ${targets} types`, description: "" };
        }
        default:
          return null;
      }
    },

    sidecarFiles(template, tree, opts, warn) {
      const out = new Map<string, string>();
      if (!opts.writeEntityYaml) return out;
      if (!tree) {
        warn({ code: "no-source-tree", message: "writeEntityYaml needs the source tree; no entity.yaml was patched" });
        return out;
      }
      for (const n of template.nodes) {
        const folder = typeof n.data?.folder === "string" ? n.data.folder : null;
        const m = n.data?.model as Record<string, unknown> | undefined;
        if (!folder || !m || n.id === EXTERNAL_GROUP_ID) continue;
        const entry = tree.byPath.get(folder);
        const text = entry?.files["entity.yaml"];
        if (text === undefined) continue;
        const current = parseFlatYaml(text);
        if (!current) {
          warn({ code: "unreadable-file", path: `${folder}/entity.yaml`, message: "entity.yaml is not flat key: value; left untouched" });
          continue;
        }
        const patch: Record<string, string> = {};
        if (current.diagramName !== n.label) patch.diagramName = n.label;
        const type = diagramTypeOf(n.kind);
        if (type && current.diagramType !== undefined && current.diagramType !== type) patch.diagramType = type;
        if (!Object.keys(patch).length) continue;
        const patched = patchFlatYaml(text, patch);
        if (patched !== null) out.set(`${folder}/entity.yaml`, patched);
      }
      return out;
    },
  };
  return dialect;
}

export const dataModelDialect: Dialect<ModelCtx> = createDataModelDialect();

export { DATAMODEL_KINDS, dataModelRegistry } from "./kinds";
export { parseFlatYaml, patchFlatYaml } from "./yaml";
export { classify as classifyDataModelShape } from "./shapes";
export type { ModelShape, EntitySchema, EntityField, ForeignKey, RelationshipKind } from "./shapes";
