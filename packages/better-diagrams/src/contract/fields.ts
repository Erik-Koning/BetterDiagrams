/**
 * fields.ts — a field as the reader sees it, whatever the document knows.
 *
 * A record node draws its `fields[]` ROWS. The rest of what a field is — its
 * label, the objects a reference points at, whether an integration user may
 * see it, an external-id or unique mark, a formula — and the fields an import
 * chose not to draw at all live in the node's `data` bag (`data.sf.fields`
 * for a Salesforce import; a host may put the same shape under `data.fields`).
 * This module merges the two into one {@link FieldRecord} per field so the
 * grid, the search and the row menu never read a dialect's internals.
 *
 * It is also the ONE place "an edge is anchored at a field" is defined
 * (`edgeFieldIds`): the row anchors `startField`/`endField` first, and a
 * dialect's own record of the field (`data.sf.field`) when validation had
 * to drop the anchor because the row wasn't drawn.
 *
 * Zero dependencies, like every contract module.
 */
import type { FieldKey, NodeField } from "./schema";

export interface FieldRef {
  nodeId: string;
  fieldId: string;
}

/** A pinned thing: a field, or a whole table when `fieldId` is absent. */
export interface Pin {
  nodeId: string;
  fieldId?: string;
}

/** A stable key for a ref or pin — sets, maps, memo keys. */
export const fieldKey = (ref: Pin): string => `${ref.nodeId}\u0000${ref.fieldId ?? ""}`;

export const sameFieldRef = (a: Pin, b: Pin): boolean =>
  a.nodeId === b.nodeId && (a.fieldId ?? "") === (b.fieldId ?? "");

/** A key: a field that anchors at least one edge as its referencing side. */
export interface KeyInfo {
  ref: FieldRef;
  /** The edges this key carries — several for a polymorphic reference. */
  edges: string[];
  /** The tables those edges point at, deduped, in edge order. */
  targets: string[];
}

/** The key an edge is carried by — the badge a lit hop shows. */
export function edgeKeyOf(edge: {
  startField?: string;
  data?: Record<string, unknown>;
}): string | undefined {
  return edgeFieldIds({ id: "", source: "", target: "", ...edge }).start;
}

/** One object a reference points at. `nodeId` absent = outside the document. */
export interface FieldTarget {
  label: string;
  nodeId?: string;
  /** The edge drawing this reference, when the row anchors one. */
  edgeId?: string;
}

export interface FieldRecord {
  /** The row's id, or the data field's name — what a `FieldRef` names. */
  id: string;
  name: string;
  label?: string;
  type?: string;
  key?: FieldKey;
  required?: boolean;
  /** A `fields[]` row on the node, so an edge can anchor to it. */
  row: boolean;
  /** Empty for anything that isn't a reference. */
  fk: FieldTarget[];
  visibleToIntegrationUser?: boolean;
  externalId?: boolean;
  unique?: boolean;
  formula?: string;
}

/** The structural slice these helpers read — a scoped view document serves too. */
export interface FieldDocument {
  nodes: ReadonlyArray<{
    id: string;
    label?: string;
    fields?: readonly NodeField[];
    data?: Record<string, unknown>;
  }>;
  edges: ReadonlyArray<{
    id: string;
    source: string;
    target: string;
    direction?: string;
    startField?: string;
    endField?: string;
    data?: Record<string, unknown>;
  }>;
}

type FieldDocNode = FieldDocument["nodes"][number];
type FieldDocEdge = FieldDocument["edges"][number];

/** A field as a `data` bag describes it — the compact shape an import stores. */
export interface DataField {
  name: string;
  label?: string;
  type?: string;
  toolingType?: string;
  nillable?: boolean;
  nameField?: boolean;
  externalId?: boolean;
  unique?: boolean;
  formula?: string;
  visibleToIntegrationUser?: boolean;
  relationship?: { kind?: string; referenceTo?: string[]; relationshipName?: string | null };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const sfOf = (bag: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  isRecord(bag?.sf) ? (bag!.sf as Record<string, unknown>) : undefined;

/** The field a dialect recorded on an edge, when the row anchor was dropped. */
function dialectEdgeField(edge: FieldDocEdge): string | undefined {
  const sf = sfOf(edge.data);
  return typeof sf?.field === "string" ? sf.field : undefined;
}

/**
 * Which field each end of an edge is anchored at. The row anchors win; a
 * dialect's own record of the referencing field stands in when the row was
 * not drawn (and its far end is the target's `Id`, the only thing a foreign
 * key ever points at).
 */
export function edgeFieldIds(edge: FieldDocEdge): { start?: string; end?: string } {
  const recorded = dialectEdgeField(edge);
  const start = edge.startField ?? recorded;
  const end = edge.endField ?? (recorded !== undefined ? "Id" : undefined);
  return { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) };
}

function coerceDataField(raw: unknown): DataField | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) return null;
  const out: DataField = { name: raw.name };
  if (typeof raw.label === "string") out.label = raw.label;
  if (typeof raw.type === "string") out.type = raw.type;
  if (typeof raw.toolingType === "string") out.toolingType = raw.toolingType;
  if (typeof raw.nillable === "boolean") out.nillable = raw.nillable;
  if (raw.nameField === true) out.nameField = true;
  if (raw.externalId === true) out.externalId = true;
  if (raw.unique === true) out.unique = true;
  if (typeof raw.formula === "string") out.formula = raw.formula;
  if (typeof raw.visibleToIntegrationUser === "boolean") out.visibleToIntegrationUser = raw.visibleToIntegrationUser;
  if (isRecord(raw.relationship)) {
    const r = raw.relationship;
    out.relationship = {
      ...(typeof r.kind === "string" ? { kind: r.kind } : {}),
      ...(Array.isArray(r.referenceTo)
        ? { referenceTo: r.referenceTo.filter((t): t is string => typeof t === "string") }
        : {}),
      ...(typeof r.relationshipName === "string" || r.relationshipName === null
        ? { relationshipName: r.relationshipName }
        : {}),
    };
  }
  return out;
}

/**
 * Every field the node's `data` describes: `data.sf.fields` (a Salesforce
 * import), else a host's `data.fields` of the same shape, else — for a
 * document written before the full list was stored — `data.sf.fieldMeta`
 * laid over the rows. Empty for a node whose bag says nothing about fields.
 */
export function dataFields(node: FieldDocNode): DataField[] {
  const sf = sfOf(node.data);
  const list = Array.isArray(sf?.fields)
    ? sf!.fields
    : Array.isArray(node.data?.fields)
      ? (node.data!.fields as unknown[])
      : null;
  if (list) return list.map(coerceDataField).filter((f): f is DataField => f !== null);
  if (isRecord(sf?.fieldMeta)) {
    return (node.fields ?? []).map((row) => {
      const meta = sf!.fieldMeta as Record<string, unknown>;
      const m = isRecord(meta[row.name]) ? (meta[row.name] as Record<string, unknown>) : {};
      return coerceDataField({ name: row.name, ...m }) ?? { name: row.name };
    });
  }
  return [];
}

/** `data.sf.apiName` → node id, for the objects and stubs a reference can resolve to. */
export function apiNameIndex(doc: FieldDocument): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of doc.nodes) {
    const sf = sfOf(n.data);
    if (!sf || (sf.shape !== "object" && sf.shape !== "external")) continue;
    if (typeof sf.apiName === "string" && !out.has(sf.apiName)) out.set(sf.apiName, n.id);
  }
  return out;
}

/** A reference's targets on one short line — the same rule the importer's rows use. */
function referenceType(d: DataField): string {
  const targets = d.relationship?.referenceTo ?? [];
  if (targets.length > 3) return `→ ${targets.length} types`;
  return targets.length ? `→ ${targets.join("|")}` : "reference";
}

/**
 * The node's fields as one list: rows first, in row order, then every data
 * field the rows don't already show. Reference targets come from the edges
 * the row anchors (with the edge id) and from the data field's own target
 * list, resolved to nodes through {@link apiNameIndex} when `doc` is given.
 */
export function fieldRecords(node: FieldDocNode, doc?: FieldDocument): FieldRecord[] {
  const rows = node.fields ?? [];
  const data = dataFields(node);
  const byName = new Map<string, DataField>();
  for (const d of data) if (!byName.has(d.name)) byName.set(d.name, d);
  const rowNames = new Set<string>();
  for (const r of rows) {
    rowNames.add(r.id);
    rowNames.add(r.name);
  }

  const labelById = new Map<string, string>();
  if (doc) for (const n of doc.nodes) labelById.set(n.id, n.label ?? n.id);
  const outEdges = doc ? doc.edges.filter((e) => e.source === node.id) : [];
  const index = doc ? apiNameIndex(doc) : null;

  const targetsOf = (id: string, d: DataField | undefined): FieldTarget[] => {
    const out: FieldTarget[] = [];
    const seen = new Set<string>();
    for (const e of outEdges) {
      if (edgeFieldIds(e).start !== id || seen.has(e.target)) continue;
      seen.add(e.target);
      out.push({ label: labelById.get(e.target) ?? e.target, nodeId: e.target, edgeId: e.id });
    }
    for (const api of d?.relationship?.referenceTo ?? []) {
      const nodeId = index?.get(api);
      const label = nodeId ? (labelById.get(nodeId) ?? api) : api;
      // An edge may already have named this target — by node, or by a label
      // that happens to be the api name — so the same table is listed once.
      if ((nodeId && seen.has(nodeId)) || out.some((t) => t.label === label || t.label === api)) continue;
      if (nodeId) seen.add(nodeId);
      out.push({ label, ...(nodeId ? { nodeId } : {}) });
    }
    return out;
  };

  const make = (row: NodeField | undefined, d: DataField | undefined): FieldRecord => {
    const id = row?.id ?? d!.name;
    const name = row?.name ?? d!.name;
    const type = row?.type ?? (d?.relationship ? referenceType(d) : (d?.toolingType ?? d?.type));
    const key: FieldKey | undefined =
      row?.key ?? (d ? (name === "Id" ? "pk" : d.relationship ? "fk" : undefined) : undefined);
    const required = row?.required ?? (d?.nillable === false && name !== "Id" ? true : undefined);
    return {
      id,
      name,
      ...(d?.label !== undefined ? { label: d.label } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(key ? { key } : {}),
      ...(required ? { required: true } : {}),
      row: !!row,
      fk: targetsOf(id, d),
      ...(d?.visibleToIntegrationUser !== undefined
        ? { visibleToIntegrationUser: d.visibleToIntegrationUser }
        : {}),
      ...(d?.externalId ? { externalId: true } : {}),
      ...(d?.unique ? { unique: true } : {}),
      ...(d?.formula !== undefined ? { formula: d.formula } : {}),
    };
  };

  const out: FieldRecord[] = rows.map((row) => make(row, byName.get(row.id) ?? byName.get(row.name)));
  for (const d of data) if (!rowNames.has(d.name)) out.push(make(undefined, d));
  return out;
}

/** Edges leaving the node through this field. */
export function fieldOutEdges<E extends FieldDocEdge>(doc: { edges: ReadonlyArray<E> }, ref: FieldRef): E[] {
  return doc.edges.filter((e) => e.source === ref.nodeId && edgeFieldIds(e).start === ref.fieldId);
}

/** Edges arriving at the node on this field. */
export function fieldInEdges<E extends FieldDocEdge>(doc: { edges: ReadonlyArray<E> }, ref: FieldRef): E[] {
  return doc.edges.filter((e) => e.target === ref.nodeId && edgeFieldIds(e).end === ref.fieldId);
}

/** Whether the document has this field — as a row or in the node's data — or, for a table pin, the table. */
export function hasField(doc: FieldDocument, ref: Pin): boolean {
  const node = doc.nodes.find((n) => n.id === ref.nodeId);
  if (!node) return false;
  if (ref.fieldId === undefined) return true;
  if (node.fields?.some((f) => f.id === ref.fieldId)) return true;
  return dataFields(node).some((d) => d.name === ref.fieldId);
}

/** Every key in the document, in edge order, each with the edges it carries. */
export function keyFields(doc: FieldDocument): KeyInfo[] {
  const byKey = new Map<string, KeyInfo>();
  for (const e of doc.edges) {
    const start = edgeFieldIds(e).start;
    if (!start) continue;
    const ref = { nodeId: e.source, fieldId: start };
    const key = fieldKey(ref);
    const info = byKey.get(key);
    if (info) {
      info.edges.push(e.id);
      if (!info.targets.includes(e.target)) info.targets.push(e.target);
    } else {
      byKey.set(key, { ref, edges: [e.id], targets: [e.target] });
    }
  }
  return [...byKey.values()];
}

export interface FieldIndexEntry {
  nodeId: string;
  nodeLabel: string;
  fieldId: string;
  name: string;
  label?: string;
  row: boolean;
  /** Lowercased `name label type formula`, what a query is matched against. */
  haystack: string;
}

/** Every field in the document, flat — built once, scanned per keystroke. */
export interface FieldIndex {
  entries: FieldIndexEntry[];
}

export function buildFieldIndex(doc: FieldDocument): FieldIndex {
  const entries: FieldIndexEntry[] = [];
  for (const n of doc.nodes) {
    for (const f of fieldRecords(n)) {
      entries.push({
        nodeId: n.id,
        nodeLabel: n.label ?? n.id,
        fieldId: f.id,
        name: f.name,
        ...(f.label !== undefined ? { label: f.label } : {}),
        row: f.row,
        haystack: [f.name, f.label ?? "", f.type ?? "", f.formula ?? ""].join("\u0000").toLowerCase(),
      });
    }
  }
  return { entries };
}

export interface FieldHit {
  nodeId: string;
  nodeLabel: string;
  fieldId: string;
  name: string;
  label?: string;
  /** Drawn on the node, so the canvas can highlight it; else only the grid can. */
  row: boolean;
}

/**
 * Fields whose name, label, type or formula contains the query, in document
 * order, at most `limit` (default 200). Accepts a prebuilt index so a search
 * box pays one `includes` per field per keystroke, or a document for the
 * one-off call.
 */
export function searchFields(
  source: FieldDocument | FieldIndex,
  query: string,
  opts: { limit?: number } = {},
): FieldHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = opts.limit ?? 200;
  const index = "entries" in source ? source : buildFieldIndex(source);
  const out: FieldHit[] = [];
  for (const e of index.entries) {
    if (!e.haystack.includes(q)) continue;
    out.push({
      nodeId: e.nodeId,
      nodeLabel: e.nodeLabel,
      fieldId: e.fieldId,
      name: e.name,
      ...(e.label !== undefined ? { label: e.label } : {}),
      row: e.row,
    });
    if (out.length >= limit) break;
  }
  return out;
}

