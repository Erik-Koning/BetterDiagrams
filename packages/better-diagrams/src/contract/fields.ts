/**
 * fields.ts — a field as the reader sees it, whatever the document knows.
 *
 * A record node draws its `fields[]` ROWS. The rest of what a field is — its
 * label, the entities a reference points at, whether the reader may see it,
 * an external-id or unique mark, a formula — and the fields an import chose
 * not to draw at all live in the node's `data` bag (`data.model.fields` for
 * a data-model import; a host may put the same shape under `data.fields`).
 * This module merges the two into one {@link FieldRecord} per field so the
 * grid, the search and the row menu never read a dialect's internals.
 *
 * It is also the ONE place "an edge is anchored at a field" is defined
 * (`edgeFieldIds`): the row anchors `startField`/`endField` first, and a
 * dialect's own record of the field (`data.model.field`, landing on
 * `data.model.targetField`) when validation had to drop the anchor because
 * the row wasn't drawn.
 *
 * Zero dependencies, like every contract module.
 */
import { FIELD_TAG_HIDDEN, FIELD_TAG_RO, type FieldKey, type NodeField } from "./schema";

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

/** One entity a reference points at. `nodeId` absent = outside the document. */
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
  /** Whether the reading principal may see the field; absent when the source didn't say. */
  visible?: boolean;
  externalId?: boolean;
  unique?: boolean;
  /** Computed rather than stored — the row's own flag, or a formula the data carries. */
  derived?: boolean;
  formula?: string;
  /** The row's tags, or what the data implies — `ro` for `updateable: false`, `hidden` for `visible: false`. */
  tags?: string[];
}

/** The structural slice these helpers read — a scoped view document serves too. */
export interface FieldDocument {
  nodes: ReadonlyArray<{
    id: string;
    kind?: string;
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
  /** The type as the source shows it, when that reads better than `type`. */
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
  relationship?: { kind?: string; referenceTo?: string[]; relationshipName?: string | null };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const modelOf = (bag: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  isRecord(bag?.model) ? (bag!.model as Record<string, unknown>) : undefined;

/** The fields a dialect recorded on an edge, for when the row anchors were dropped. */
function dialectEdgeFields(edge: FieldDocEdge): { field?: string; targetField?: string } {
  const m = modelOf(edge.data);
  return {
    ...(typeof m?.field === "string" ? { field: m.field } : {}),
    ...(typeof m?.targetField === "string" ? { targetField: m.targetField } : {}),
  };
}

/**
 * Which field each end of an edge is anchored at. The row anchors win; a
 * dialect's own record of the referencing field stands in when the row was
 * not drawn, and its far end is the key the dialect said it lands on — the
 * target's primary key, for a foreign key.
 */
export function edgeFieldIds(edge: FieldDocEdge): { start?: string; end?: string } {
  const recorded = dialectEdgeFields(edge);
  const start = edge.startField ?? recorded.field;
  const end = edge.endField ?? recorded.targetField;
  return { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) };
}

function coerceDataField(raw: unknown): DataField | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) return null;
  const out: DataField = { name: raw.name };
  if (typeof raw.label === "string") out.label = raw.label;
  if (typeof raw.type === "string") out.type = raw.type;
  if (typeof raw.displayType === "string") out.displayType = raw.displayType;
  if (raw.primaryKey === true) out.primaryKey = true;
  if (typeof raw.nullable === "boolean") out.nullable = raw.nullable;
  if (raw.nameField === true) out.nameField = true;
  if (raw.externalId === true) out.externalId = true;
  if (raw.unique === true) out.unique = true;
  if (typeof raw.formula === "string") out.formula = raw.formula;
  if (typeof raw.visible === "boolean") out.visible = raw.visible;
  if (typeof raw.createable === "boolean") out.createable = raw.createable;
  if (typeof raw.updateable === "boolean") out.updateable = raw.updateable;
  if (Array.isArray(raw.tags)) {
    const tags = raw.tags.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim());
    if (tags.length) out.tags = [...new Set(tags)];
  }
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
 * Every field the node's `data` describes: `data.model.fields` (a data-model
 * import), else a host's `data.fields` of the same shape, else — for a
 * document written before the full list was stored — `data.model.fieldMeta`
 * laid over the rows. Empty for a node whose bag says nothing about fields.
 */
export function dataFields(node: FieldDocNode): DataField[] {
  const m = modelOf(node.data);
  const list = Array.isArray(m?.fields)
    ? m!.fields
    : Array.isArray(node.data?.fields)
      ? (node.data!.fields as unknown[])
      : null;
  if (list) return list.map(coerceDataField).filter((f): f is DataField => f !== null);
  if (isRecord(m?.fieldMeta)) {
    return (node.fields ?? []).map((row) => {
      const meta = m!.fieldMeta as Record<string, unknown>;
      const own = isRecord(meta[row.name]) ? (meta[row.name] as Record<string, unknown>) : {};
      return coerceDataField({ name: row.name, ...own }) ?? { name: row.name };
    });
  }
  return [];
}

/** `data.model.name` → node id, for the entities and stubs a reference can resolve to. */
export function nameIndex(doc: FieldDocument): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of doc.nodes) {
    const m = modelOf(n.data);
    if (!m || (m.shape !== "entity" && m.shape !== "external")) continue;
    if (typeof m.name === "string" && !out.has(m.name)) out.set(m.name, n.id);
  }
  return out;
}

/** A reference's targets on one short line — the same rule the importer's rows use. */
/**
 * A data field's tags: the ones it names, plus the two the access flags
 * imply. The same rule the folder importer applies when it makes a row, so
 * a field that was not drawn reads the same in the grid as one that was.
 */
export function dataFieldTags(d: DataField): string[] {
  const out = [...(d.tags ?? [])];
  if (d.updateable === false && !out.includes(FIELD_TAG_RO)) out.push(FIELD_TAG_RO);
  if (d.visible === false && !out.includes(FIELD_TAG_HIDDEN)) out.push(FIELD_TAG_HIDDEN);
  return out;
}

function referenceType(d: DataField): string {
  const targets = d.relationship?.referenceTo ?? [];
  if (targets.length > 3) return `→ ${targets.length} types`;
  return targets.length ? `→ ${targets.join("|")}` : "reference";
}

/**
 * The node's fields as one list: rows first, in row order, then every data
 * field the rows don't already show. Reference targets come from the edges
 * the row anchors (with the edge id) and from the data field's own target
 * list, resolved to nodes through {@link nameIndex} when `doc` is given.
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
  const index = doc ? nameIndex(doc) : null;

  const targetsOf = (id: string, d: DataField | undefined): FieldTarget[] => {
    const out: FieldTarget[] = [];
    const seen = new Set<string>();
    for (const e of outEdges) {
      if (edgeFieldIds(e).start !== id || seen.has(e.target)) continue;
      seen.add(e.target);
      out.push({ label: labelById.get(e.target) ?? e.target, nodeId: e.target, edgeId: e.id });
    }
    for (const name of d?.relationship?.referenceTo ?? []) {
      const nodeId = index?.get(name);
      const label = nodeId ? (labelById.get(nodeId) ?? name) : name;
      // An edge may already have named this target — by node, or by a label
      // that happens to be the entity name — so the same table is listed once.
      if ((nodeId && seen.has(nodeId)) || out.some((t) => t.label === label || t.label === name)) continue;
      if (nodeId) seen.add(nodeId);
      out.push({ label, ...(nodeId ? { nodeId } : {}) });
    }
    return out;
  };

  const make = (row: NodeField | undefined, d: DataField | undefined): FieldRecord => {
    const id = row?.id ?? d!.name;
    const name = row?.name ?? d!.name;
    const type = row?.type ?? (d?.relationship ? referenceType(d) : (d?.displayType ?? d?.type));
    const key: FieldKey | undefined =
      row?.key ??
      (d ? (d.primaryKey && d.relationship ? "pfk" : d.primaryKey ? "pk" : d.relationship ? "fk" : undefined) : undefined);
    const required = row?.required ?? (d?.nullable === false && !d.primaryKey ? true : undefined);
    const tags = row?.tags ?? (d ? dataFieldTags(d) : []);
    return {
      id,
      name,
      ...(d?.label !== undefined ? { label: d.label } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(key ? { key } : {}),
      ...(required ? { required: true } : {}),
      row: !!row,
      fk: targetsOf(id, d),
      ...(d?.visible !== undefined ? { visible: d.visible } : {}),
      ...(d?.externalId ? { externalId: true } : {}),
      ...(row?.unique || d?.unique ? { unique: true } : {}),
      ...(row?.derived || d?.formula ? { derived: true } : {}),
      ...(d?.formula !== undefined ? { formula: d.formula } : {}),
      ...(tags.length ? { tags } : {}),
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

/**
 * The key a reference points at on its target table — the other half of a
 * foreign key, for a reader following it: the row the reference's edge lands
 * on, or, with no edge to say, the target's primary key (a row simply called
 * `id` failing a `pk` badge — the only thing a foreign key ever points at).
 * Null when the target isn't a node, or draws no such row.
 */
export function referencedKey(doc: FieldDocument, target: FieldTarget): FieldRef | null {
  if (!target.nodeId) return null;
  const edge = target.edgeId ? doc.edges.find((e) => e.id === target.edgeId) : undefined;
  const landed = edge ? edgeFieldIds(edge).end : undefined;
  const node = doc.nodes.find((n) => n.id === target.nodeId);
  const rows = node?.fields ?? [];
  const row =
    (landed !== undefined ? rows.find((f) => f.id === landed) : undefined) ??
    rows.find((f) => f.key === "pk" || f.key === "pfk") ??
    rows.find((f) => /^id$/i.test(f.id) || /^id$/i.test(f.name));
  return row ? { nodeId: target.nodeId, fieldId: row.id } : null;
}

/** One foreign key pointing at a key: the referencing table, its row (when drawn or recorded), and the line. */
export interface Referencer {
  nodeId: string;
  fieldId?: string;
  edgeId: string;
}

/**
 * Everything that points AT a key — the other direction from `referencedKey`.
 * A line lands on the row its `endField` (or the dialect's record) names, or,
 * saying nothing, on the table's key: the same rule a followed reference
 * uses to find its far end, so the two directions agree. For a table pin
 * (no `fieldId`) every line into the table counts. A table pointing at
 * itself — a hierarchy — is a reference like any other.
 */
export function referencesTo(doc: FieldDocument, ref: Pin): Referencer[] {
  if (!doc.nodes.some((n) => n.id === ref.nodeId)) return [];
  const implicit = referencedKey(doc, { label: "", nodeId: ref.nodeId })?.fieldId;
  const out: Referencer[] = [];
  for (const e of doc.edges) {
    if (e.target !== ref.nodeId) continue;
    const ends = edgeFieldIds(e);
    if (ref.fieldId !== undefined && (ends.end ?? implicit) !== ref.fieldId) continue;
    out.push({ nodeId: e.source, ...(ends.start !== undefined ? { fieldId: ends.start } : {}), edgeId: e.id });
  }
  return out;
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


/**
 * One foreign key as a pair of ends: the referencing field and the key it
 * lands on. `edgeId` is absent when the document draws no line for it — a
 * reference the data describes that the import chose not to draw — and
 * `to.fieldId` when the target draws no key row to land on.
 */
export interface KeyLink {
  from: FieldRef;
  to: Pin;
  edgeId?: string;
}

/** Every key touching a table or a field, in both directions. */
export interface KeyReferences {
  /** Keys the table (or the one field) carries, pointing out at other tables. */
  carries: KeyLink[];
  /** Keys elsewhere pointing at the table (or at the one field). */
  referencedBy: KeyLink[];
}

const sameLink = (a: KeyLink, b: KeyLink): boolean =>
  sameFieldRef(a.from, b.from) && sameFieldRef(a.to, b.to);

/**
 * The keys a table or field takes part in: what it carries (its own
 * reference fields, each resolved to the key it lands on) and what points
 * at it (`referencesTo`, each with the key the line lands on). A field pin
 * narrows both to that one field. Same rules as the row menu's "Follow
 * reference" and "Show references", so the panel and the menu agree.
 */
export function keyReferences(doc: FieldDocument, pin: Pin): KeyReferences {
  const node = doc.nodes.find((n) => n.id === pin.nodeId);
  if (!node) return { carries: [], referencedBy: [] };
  const carries: KeyLink[] = [];
  for (const record of fieldRecords(node, doc)) {
    if (pin.fieldId !== undefined && record.id !== pin.fieldId) continue;
    for (const target of record.fk) {
      if (!target.nodeId) continue;
      const key = referencedKey(doc, target);
      const link: KeyLink = {
        from: { nodeId: node.id, fieldId: record.id },
        to: key ?? { nodeId: target.nodeId },
        ...(target.edgeId !== undefined ? { edgeId: target.edgeId } : {}),
      };
      if (!carries.some((l) => sameLink(l, link))) carries.push(link);
    }
  }
  const implicit = referencedKey(doc, { label: "", nodeId: pin.nodeId })?.fieldId;
  const referencedBy: KeyLink[] = [];
  for (const r of referencesTo(doc, pin)) {
    if (r.fieldId === undefined) continue; // a line with no field is not a key
    const edge = doc.edges.find((e) => e.id === r.edgeId);
    const landed = (edge ? edgeFieldIds(edge).end : undefined) ?? implicit;
    const link: KeyLink = {
      from: { nodeId: r.nodeId, fieldId: r.fieldId },
      to: landed !== undefined ? { nodeId: pin.nodeId, fieldId: landed } : { nodeId: pin.nodeId },
      edgeId: r.edgeId,
    };
    if (!referencedBy.some((l) => sameLink(l, link))) referencedBy.push(link);
  }
  return { carries, referencedBy };
}

/**
 * The keys joining two pins directly, either way round: what `a` carries
 * that lands on `b`, then what `b` carries that lands on `a`. A field pin
 * holds its end to that field. References the document draws no line for
 * are included (`edgeId` absent) — a key is a key whether or not it is drawn.
 */
export function keysBetween(doc: FieldDocument, a: Pin, b: Pin): KeyLink[] {
  const landsOn = (link: KeyLink, end: Pin) =>
    link.to.nodeId === end.nodeId && (end.fieldId === undefined || link.to.fieldId === end.fieldId);
  return [
    ...keyReferences(doc, a).carries.filter((l) => landsOn(l, b)),
    ...keyReferences(doc, b).carries.filter((l) => landsOn(l, a)),
  ];
}
