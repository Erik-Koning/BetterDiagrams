/**
 * shapes.ts — the six things a data-model `schema.json` can be.
 *
 * Same filename, six shapes, told apart by what keys they carry. The order
 * of the checks matters and is pinned by tests: a band has `entities` but
 * no `fields`; an entity has `fields`; the rest say what they are in `kind`.
 *
 * The vocabulary is a database's, loosely: an ENTITY is a table, a schema,
 * a collection — anything with fields; a VIEW aliases one with a filter; a
 * RECORD TYPE is a named variant of one; a BAND or GROUP is a folder that
 * holds them. Nothing here belongs to one product.
 */

export type ModelShape = "root" | "band" | "group" | "entity" | "record-type" | "view" | "unknown";

/** One row of a band's or group's flat listing. */
export interface EntitySummary {
  folder: string;
  band?: string;
  name?: string;
  label?: string;
  kind?: string;
  recordCount?: number;
  diagramName?: string;
  diagramType?: string;
  businessLine?: string | null;
  fieldsTotal?: number;
  fieldsVisible?: number;
  foreignKeyCount?: number;
  url?: string;
}

export interface RootManifest {
  $schemaVersion?: number;
  $generatedAt?: string;
  /** Whatever identifies the system this was exported from; copied through to `meta`. */
  $source?: Record<string, unknown>;
  title?: string;
  bands?: Array<{ band?: string; folder?: string; description?: string }>;
  /** Folders that are cross-cutting metadata, never nodes. */
  crossCutting?: string | string[];
}

export interface BandManifest {
  band: string;
  folder?: string;
  description?: string;
  entityCount?: number;
  entities: EntitySummary[];
}

export interface GroupManifest {
  folder: string;
  kind: "group";
  description?: string;
  childCount?: number;
  children?: EntitySummary[];
}

/**
 * How a reference relates two entities. `reference` is a plain foreign
 * key; `composition` owns its target's lifetime (delete the parent, the
 * children go); `hierarchy` points at the entity's own kind; `polymorphic`
 * may point at any of several.
 */
export type RelationshipKind = "reference" | "composition" | "polymorphic" | "hierarchy";

export interface FieldRelationship {
  kind: RelationshipKind;
  referenceTo: string[];
  /** The name the target knows this collection by (`orders`, `child_accounts`). */
  relationshipName?: string | null;
  relationshipLabel?: string;
  cascadeDelete?: boolean;
  deleteConstraint?: "SetNull" | "Restrict" | "Cascade" | string;
}

export interface EntityField {
  name: string;
  label?: string;
  /** A storage type (`string`, `int`, `reference`, `enum`, `id`…). */
  type: string;
  /** The type as the system shows it (`varchar(255)`, `Reference`) — the row's label when present. */
  displayType?: string;
  /** The entity's primary key. Detected from `type: "id"` or a field named `id` when absent. */
  primaryKey?: boolean;
  /** The field that names a record. Detected from a field named `name` when absent. */
  nameField?: boolean;
  required?: boolean;
  nullable?: boolean;
  externalId?: boolean;
  unique?: boolean;
  calculated?: boolean;
  formula?: string;
  length?: number;
  precision?: number;
  scale?: number;
  enumValues?: unknown[];
  /** Whether the reading principal may see the field. Absent means unknown. */
  visible?: boolean;
  createable?: boolean;
  updateable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  relationship?: FieldRelationship;
}

export interface ForeignKey {
  field: string;
  label?: string;
  kind: RelationshipKind;
  referenceTo: string[];
  relationshipName: string | null;
  /** The field the reference lands on; the target's primary key when absent. */
  targetField?: string;
  required?: boolean;
  cascadeDelete?: boolean;
  deleteConstraint?: string;
  visible?: boolean;
  /** Canonical entity folder first, then any view folders aliasing it. */
  targetFolders?: string[];
}

export interface ReferencedBy {
  entity: string;
  field: string;
  kind: string;
  inModel?: boolean;
  folders?: string[];
  label?: string;
}

export interface EntitySchema {
  $schemaVersion?: number;
  $generatedAt?: string;
  $source?: unknown;
  folder: string;
  entity: {
    name: string;
    label?: string;
    labelPlural?: string;
    kind?: "custom" | "standard" | "package" | "external" | string;
    custom?: boolean;
    namespace?: string | null;
    recordCount?: number;
    [key: string]: unknown;
  };
  curated?: {
    diagramName?: string;
    diagramType?: "custom" | "standard" | "package" | "record-type" | "external" | string;
    businessLine?: string | null;
    source?: string;
    note?: string;
  };
  recordTypes?: unknown[];
  fieldSummary?: { total?: number; visible?: number; hidden?: number };
  fields: EntityField[];
  foreignKeys?: ForeignKey[];
  referencedBy?: ReferencedBy[];
  validationRules?: unknown[];
  /** Where the entity lives in its system, for the node's link. */
  url?: string;
  routes?: Record<string, unknown>;
  notes?: string[];
}

export interface RecordTypeSchema {
  folder: string;
  kind: "record-type";
  parentEntity?: { name?: string; label?: string; folder?: string; schema?: string };
  recordType: {
    name?: string;
    /** The stable machine name. */
    key?: string;
    id?: string;
    active?: boolean;
    visible?: boolean;
    description?: string;
  };
  curated?: { diagramName?: string; diagramType?: string };
  routes?: Record<string, unknown>;
  notes?: string[];
}

export interface ViewSchema {
  folder: string;
  kind: "view";
  entity?: { name?: string; label?: string };
  aliasOf: { folder: string; name?: string; schema?: string };
  view?: string;
  /** The predicate that narrows the entity, in whatever language the system speaks. */
  filter?: string;
  curated?: { diagramName?: string; diagramType?: string };
  routes?: Record<string, unknown>;
  measured?: unknown;
}

export interface RelationshipsManifest {
  edgeCount?: number;
  edges: Array<{
    from: string;
    field: string;
    kind: string;
    to: string;
    fromFolders?: string[];
    toFolders?: string[];
  }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** First match wins, in this order. */
export function classify(raw: unknown): ModelShape {
  if (!isRecord(raw)) return "unknown";
  if (Array.isArray(raw.bands)) return "root";
  if (typeof raw.band === "string" && Array.isArray(raw.entities) && !Array.isArray(raw.fields)) return "band";
  if (raw.kind === "group") return "group";
  if (Array.isArray(raw.fields)) return "entity";
  if (raw.kind === "record-type") return "record-type";
  if (raw.kind === "view" && isRecord(raw.aliasOf)) return "view";
  return "unknown";
}

/** `forensics.json` — attached to its entity, never a node. */
export function isForensics(raw: unknown): boolean {
  return isRecord(raw) && ("automation" in raw || "dataProfile" in raw);
}
