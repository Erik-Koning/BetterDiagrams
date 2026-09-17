/**
 * fields.ts — which of an object's fields become rows, and what a row says.
 *
 * An object can carry hundreds of fields; the default keeps only the ones
 * that explain the object's place in the model — its id, its name, every
 * reference, every external id and unique key. The rest stay in the folder,
 * a click away, not on the canvas.
 */
import type { NodeField } from "../../../schema";
import type { FolderImportOptions, FolderNode } from "../../types";
import type { SfField } from "./shapes";

/** Warn (never truncate) above this many rows on one node. */
export const FIELD_WARNING_THRESHOLD = 100;

export function isKeyField(f: SfField): boolean {
  return (
    f.name === "Id" ||
    f.nameField === true ||
    f.name === "Name" ||
    f.type === "reference" ||
    f.externalId === true ||
    f.unique === true
  );
}

export function selectFields(
  fields: readonly SfField[],
  mode: FolderImportOptions["fields"],
  node: FolderNode,
): SfField[] {
  if (typeof mode === "function") return fields.filter((f) => mode(f, node));
  switch (mode ?? "keys") {
    case "all":
      return [...fields];
    case "visible":
      return fields.filter((f) => f.visibleToIntegrationUser === true);
    default:
      return fields.filter(isKeyField);
  }
}

/** A reference's target list on one short line; a polymorphic list is counted, not listed. */
export function fieldTypeLabel(f: SfField): string {
  if (f.type === "reference") {
    const targets = f.relationship?.referenceTo ?? [];
    if (targets.length > 3) return `→ ${targets.length} types`;
    return targets.length ? `→ ${targets.join("|")}` : "reference";
  }
  return f.toolingType ?? f.type;
}

export function toNodeField(f: SfField): NodeField {
  const key = f.name === "Id" ? "pk" : f.type === "reference" ? "fk" : undefined;
  // `nillable === false` is the truth; `required` disagrees with it in
  // generated files often enough that the spec says not to trust it.
  const required = f.nillable === false && f.name !== "Id";
  return {
    id: f.name,
    name: f.name,
    type: fieldTypeLabel(f),
    ...(key ? { key } : {}),
    ...(required ? { required: true } : {}),
  };
}

/**
 * The compact projection of one field kept on the node for EVERY field, rows
 * or not — what the grid, the search and `fieldRecords` read. Deliberately
 * without picklist values, lengths and the describe flags: those stay in the
 * folder, and a 500-field object must not cost a megabyte in the document.
 */
export interface SfFieldData {
  name: string;
  label?: string;
  type: string;
  toolingType?: string;
  nillable?: boolean;
  nameField?: boolean;
  externalId?: boolean;
  unique?: boolean;
  formula?: string;
  visibleToIntegrationUser?: boolean;
  relationship?: { kind: string; referenceTo: string[]; relationshipName?: string | null };
}

export function fieldData(f: SfField): SfFieldData {
  return {
    name: f.name,
    ...(f.label ? { label: f.label } : {}),
    type: f.type,
    ...(f.toolingType ? { toolingType: f.toolingType } : {}),
    ...(f.nillable !== undefined ? { nillable: f.nillable } : {}),
    ...(f.nameField ? { nameField: true } : {}),
    ...(f.externalId ? { externalId: true } : {}),
    ...(f.unique ? { unique: true } : {}),
    ...(f.formula ? { formula: f.formula } : {}),
    ...(f.visibleToIntegrationUser !== undefined ? { visibleToIntegrationUser: f.visibleToIntegrationUser } : {}),
    ...(f.relationship
      ? {
          relationship: {
            kind: f.relationship.kind,
            referenceTo: [...(f.relationship.referenceTo ?? [])],
            ...(f.relationship.relationshipName !== undefined
              ? { relationshipName: f.relationship.relationshipName }
              : {}),
          },
        }
      : {}),
  };
}

export interface SfFieldMeta {
  label?: string;
  visibleToIntegrationUser?: boolean;
  externalId?: boolean;
  unique?: boolean;
  formula?: string;
}

/** What the inspector may want about a row that the row itself doesn't say. */
export function fieldMeta(f: SfField): SfFieldMeta {
  return {
    ...(f.label ? { label: f.label } : {}),
    ...(f.visibleToIntegrationUser !== undefined ? { visibleToIntegrationUser: f.visibleToIntegrationUser } : {}),
    ...(f.externalId ? { externalId: true } : {}),
    ...(f.unique ? { unique: true } : {}),
    ...(f.formula ? { formula: f.formula } : {}),
  };
}
