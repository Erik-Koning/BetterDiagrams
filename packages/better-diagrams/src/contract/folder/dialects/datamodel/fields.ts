/**
 * fields.ts — which of an entity's fields become rows, and what a row says.
 *
 * An entity can carry hundreds of fields; the default keeps only the ones
 * that explain the entity's place in the model — its primary key, its name,
 * every reference, every external id and unique key. The rest stay in the
 * folder, a click away, not on the canvas.
 */
import { FIELD_TAG_HIDDEN, FIELD_TAG_RO, type NodeField } from "../../../schema";
import type { FolderImportOptions, FolderNode } from "../../types";
import type { EntityField } from "./shapes";

/** Warn (never truncate) above this many rows on one node. */
export const FIELD_WARNING_THRESHOLD = 100;

/**
 * The primary key: declared, or the conventional shapes — a field of type
 * `id`, or one simply called `id` in any case.
 */
export function isPrimaryKey(f: EntityField): boolean {
  return f.primaryKey === true || f.type === "id" || /^id$/i.test(f.name);
}

/** The field that names a record: declared, or one called `name`. */
export function isNameField(f: EntityField): boolean {
  return f.nameField === true || /^name$/i.test(f.name);
}

/** The first primary key among the fields, or null when none is declared or recognisable. */
export function primaryKeyOf(fields: readonly EntityField[]): EntityField | null {
  return fields.find((f) => f.primaryKey === true) ?? fields.find(isPrimaryKey) ?? null;
}

export function isKeyField(f: EntityField): boolean {
  return (
    isPrimaryKey(f) ||
    isNameField(f) ||
    f.type === "reference" ||
    f.externalId === true ||
    f.unique === true
  );
}

/**
 * The rows: what the mode picks, plus any the entity pins by name in
 * `curated.diagramFields` — in the entity's own field order either way, so
 * a pinned column sits where the schema lists it, not at the bottom.
 */
export function selectFields(
  fields: readonly EntityField[],
  mode: FolderImportOptions["fields"],
  node: FolderNode,
  pinned: readonly string[] = [],
): EntityField[] {
  const pin = new Set(pinned);
  const keep = (f: EntityField): boolean => {
    if (pin.has(f.name)) return true;
    if (typeof mode === "function") return mode(f, node);
    switch (mode ?? "keys") {
      case "all":
        return true;
      case "visible":
        return f.visible === true;
      default:
        return isKeyField(f);
    }
  };
  return fields.filter(keep);
}

/**
 * A row's tags: what the field names, plus the two the access flags imply —
 * `ro` when it cannot be updated, `hidden` when the reading principal cannot
 * see it. Only `updateable` is read for `ro`: a field that can be set once
 * on create is still written, and a row has no glyph for "once".
 */
export function fieldTags(f: EntityField): string[] {
  const out = (f.tags ?? []).filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
  if (f.updateable === false && !out.includes(FIELD_TAG_RO)) out.push(FIELD_TAG_RO);
  if (f.visible === false && !out.includes(FIELD_TAG_HIDDEN)) out.push(FIELD_TAG_HIDDEN);
  return [...new Set(out)];
}

/** A reference's target list on one short line; a polymorphic list is counted, not listed. */
export function fieldTypeLabel(f: EntityField): string {
  if (f.type === "reference") {
    const targets = f.relationship?.referenceTo ?? [];
    if (targets.length > 3) return `→ ${targets.length} types`;
    return targets.length ? `→ ${targets.join("|")}` : "reference";
  }
  return f.displayType ?? f.type;
}

export function toNodeField(f: EntityField): NodeField {
  const pk = isPrimaryKey(f);
  const ref = f.type === "reference";
  // Part of the key AND a reference — a join table's columns — is `pfk`.
  const key = pk && ref ? "pfk" : pk ? "pk" : ref ? "fk" : undefined;
  // `nullable === false` is the truth; `required` disagrees with it in
  // generated files often enough that the spec says not to trust it.
  const required = f.nullable === false && !pk;
  // A formula field is computed, never stored: UML's derived attribute.
  const derived = f.calculated === true || (typeof f.formula === "string" && f.formula.length > 0);
  const tags = fieldTags(f);
  return {
    id: f.name,
    name: f.name,
    type: fieldTypeLabel(f),
    ...(key ? { key } : {}),
    ...(required ? { required: true } : {}),
    ...(f.unique === true && !pk ? { unique: true } : {}),
    ...(derived ? { derived: true } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

/**
 * The compact projection of one field kept on the node for EVERY field, rows
 * or not — what the grid, the search and `fieldRecords` read. Deliberately
 * without enum values, lengths and the query flags: those stay in the
 * folder, and a 500-field entity must not cost a megabyte in the document.
 * The two access flags a row can show (`updateable`, `visible`) and the
 * field's own tags do come along, so an undrawn field reads the same in the
 * grid as a drawn one.
 */
export interface FieldData {
  name: string;
  label?: string;
  type: string;
  displayType?: string;
  primaryKey?: boolean;
  nullable?: boolean;
  nameField?: boolean;
  externalId?: boolean;
  unique?: boolean;
  formula?: string;
  visible?: boolean;
  createable?: boolean;
  updateable?: boolean;
  tags?: string[];
  relationship?: { kind: string; referenceTo: string[]; relationshipName?: string | null };
}

export function fieldData(f: EntityField): FieldData {
  const tags = [...new Set((f.tags ?? []).filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()))];
  return {
    name: f.name,
    ...(f.label ? { label: f.label } : {}),
    type: f.type,
    ...(f.displayType ? { displayType: f.displayType } : {}),
    ...(isPrimaryKey(f) ? { primaryKey: true } : {}),
    ...(f.nullable !== undefined ? { nullable: f.nullable } : {}),
    ...(f.nameField ? { nameField: true } : {}),
    ...(f.externalId ? { externalId: true } : {}),
    ...(f.unique ? { unique: true } : {}),
    ...(f.formula ? { formula: f.formula } : {}),
    ...(f.visible !== undefined ? { visible: f.visible } : {}),
    ...(f.createable !== undefined ? { createable: f.createable } : {}),
    ...(f.updateable !== undefined ? { updateable: f.updateable } : {}),
    ...(tags.length ? { tags } : {}),
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

export interface FieldMeta {
  label?: string;
  visible?: boolean;
  externalId?: boolean;
  unique?: boolean;
  formula?: string;
}

/** What the inspector may want about a row that the row itself doesn't say. */
export function fieldMeta(f: EntityField): FieldMeta {
  return {
    ...(f.label ? { label: f.label } : {}),
    ...(f.visible !== undefined ? { visible: f.visible } : {}),
    ...(f.externalId ? { externalId: true } : {}),
    ...(f.unique ? { unique: true } : {}),
    ...(f.formula ? { formula: f.formula } : {}),
  };
}
