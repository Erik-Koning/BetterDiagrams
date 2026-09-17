/**
 * shapes.ts — the six things a Salesforce data-model `schema.json` can be.
 *
 * Same filename, six shapes, told apart by what keys they carry. The order
 * of the checks matters and is pinned by tests: a band has `objects` but no
 * `fields`; an object has `fields`; the rest say what they are in `kind`.
 */

export type SfShape = "root" | "band" | "group" | "object" | "record-type" | "view" | "unknown";

/** One row of a band's or group's flat listing. */
export interface SfSummary {
  folder: string;
  band?: string;
  apiName?: string;
  label?: string;
  kind?: string;
  keyPrefix?: string;
  recordCount?: number;
  diagramName?: string;
  diagramType?: string;
  businessLine?: string | null;
  fieldsTotal?: number;
  fieldsVisibleToIntegrationUser?: number;
  foreignKeyCount?: number;
  describeRoute?: string;
  lightningRoute?: string;
}

export interface SfRootManifest {
  $schemaVersion?: number;
  $generatedAt?: string;
  $source?: { instanceUrl?: string; apiVersion?: string; organizationId?: string };
  title?: string;
  bands?: Array<{ band?: string; folder?: string; description?: string }>;
  /** Folders that are cross-cutting metadata, never nodes. */
  crossCutting?: string | string[];
}

export interface SfBand {
  band: string;
  folder?: string;
  description?: string;
  objectCount?: number;
  distinctSObjects?: string[];
  populatedInSandbox?: string[];
  objects: SfSummary[];
}

export interface SfGroup {
  folder: string;
  kind: "group";
  description?: string;
  childCount?: number;
  children?: SfSummary[];
}

export interface SfRelationship {
  kind: "lookup" | "masterDetail" | "polymorphic" | "hierarchy";
  referenceTo: string[];
  relationshipName?: string | null;
  relationshipLabel?: string;
  cascadeDelete?: boolean;
  deleteConstraint?: "SetNull" | "Restrict" | string;
}

export interface SfField {
  name: string;
  label?: string;
  type: string;
  toolingType?: string;
  nameField?: boolean;
  required?: boolean;
  nillable?: boolean;
  externalId?: boolean;
  unique?: boolean;
  idLookup?: boolean;
  calculated?: boolean;
  formula?: string;
  length?: number;
  precision?: number;
  scale?: number;
  picklistValues?: unknown[];
  visibleToIntegrationUser?: boolean;
  createable?: boolean;
  updateable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  source?: string;
  relationship?: SfRelationship;
}

export interface SfForeignKey {
  field: string;
  label?: string;
  kind: SfRelationship["kind"];
  referenceTo: string[];
  relationshipName: string | null;
  required?: boolean;
  cascadeDelete?: boolean;
  deleteConstraint?: string;
  visibleToIntegrationUser?: boolean;
  /** Canonical object folder first, then any view folders aliasing it. */
  targetFolders?: string[];
}

export interface SfReferencedBy {
  object: string;
  field: string;
  kind: string;
  inModel?: boolean;
  folders?: string[];
  label?: string;
}

export interface SfObjectSchema {
  $schemaVersion?: number;
  $generatedAt?: string;
  $source?: unknown;
  folder: string;
  object: {
    apiName: string;
    label?: string;
    labelPlural?: string;
    keyPrefix?: string;
    kind?: "custom" | "standard" | "fsc" | "external" | string;
    custom?: boolean;
    namespace?: string | null;
    recordCount?: number;
    [key: string]: unknown;
  };
  curated?: {
    diagramName?: string;
    diagramType?: "custom" | "standard" | "fsc" | "record-type" | "external" | string;
    businessLine?: string | null;
    source?: string;
    note?: string;
  };
  recordTypes?: unknown[];
  fieldSummary?: { total?: number; visibleToIntegrationUser?: number; hiddenFromIntegrationUser?: number };
  fields: SfField[];
  foreignKeys?: SfForeignKey[];
  referencedBy?: SfReferencedBy[];
  validationRules?: unknown[];
  routes?: { lightningList?: string; describe?: string; [key: string]: unknown };
  notes?: string[];
}

export interface SfRecordType {
  folder: string;
  kind: "record-type";
  parentObject?: { apiName?: string; label?: string; folder?: string; schema?: string };
  recordType: {
    developerName?: string;
    name?: string;
    recordTypeId?: string;
    isPersonType?: boolean;
    isActive?: boolean;
    availableToIntegrationUser?: boolean;
    description?: string;
    metadataFullName?: string;
  };
  curated?: { diagramName?: string; diagramType?: string };
  routes?: Record<string, unknown>;
  notes?: string[];
}

export interface SfView {
  folder: string;
  kind: "view";
  object?: { apiName?: string; label?: string; keyPrefix?: string };
  aliasOf: { folder: string; apiName?: string; schema?: string };
  view?: string;
  soqlFilter?: string;
  curated?: { diagramName?: string; diagramType?: string };
  routes?: Record<string, unknown>;
  measured?: unknown;
}

export interface SfRelationships {
  edgeCount?: number;
  masterDetailEdges?: number;
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
export function classify(raw: unknown): SfShape {
  if (!isRecord(raw)) return "unknown";
  if (Array.isArray(raw.bands)) return "root";
  if (typeof raw.band === "string" && Array.isArray(raw.objects) && !Array.isArray(raw.fields)) return "band";
  if (raw.kind === "group") return "group";
  if (Array.isArray(raw.fields)) return "object";
  if (raw.kind === "record-type") return "record-type";
  if (raw.kind === "view" && isRecord(raw.aliasOf)) return "view";
  return "unknown";
}

/** `forensics.json` — attached to its object, never a node. */
export function isForensics(raw: unknown): boolean {
  return isRecord(raw) && ("automation" in raw || "dataProfile" in raw);
}
