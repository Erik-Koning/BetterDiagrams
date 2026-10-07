/**
 * import/table-model.ts — tables, columns and keys, as a document.
 *
 * The schema importers (a SQL script, a dbt project) each read their source
 * into the same neutral shape — `TableSpec[]` — and this turns it into an
 * ordinary, editable document: a `table` node per table with every column as
 * a row (key badge, type, required, unique, description, tags), a group per
 * schema when there is more than one, and a line per foreign key anchored at
 * its columns, dressed as the relationship it is:
 *
 *   hierarchy      a table pointing at itself
 *   composition    a key whose columns are part of the table's own primary
 *                  key (an identifying relationship: the child is named by
 *                  its parent)
 *   reference      every other foreign key
 *
 * with the cardinality its nullability and uniqueness say. Nodes are left
 * unplaced (0, 0), sized to their rows, for the caller's auto-layout. A key
 * naming a table the source never created is a warning, not a line.
 *
 * Zero dependencies, like every contract module.
 */
import {
  MAX_NODE_FIELDS,
  fieldsBoxHeight,
  validateTemplate,
  type DiagramEdge,
  type DiagramNode,
  type DiagramTemplate,
  type NodeField,
} from "../schema";
import { RELATION_KINDS, relationDressing } from "../relations";

export interface ColumnSpec {
  name: string;
  type?: string;
  /** `false` for NOT NULL; absent when the source doesn't say. */
  nullable?: boolean;
  unique?: boolean;
  default?: string;
  description?: string;
  tags?: string[];
  /** Computed by the database (a generated or computed column). */
  generated?: boolean;
}

export interface ForeignKeySpec {
  columns: string[];
  /** The referenced table as the source wrote it: `orders`, `sales.orders`, `db.sales.orders`. */
  table: string;
  /** The referenced columns; absent means the target's primary key. */
  refColumns?: string[];
  name?: string;
  /** The delete rule as written: `cascade`, `restrict`, `no action`, `set null`… */
  onDelete?: string;
}

export interface TableSpec {
  schema?: string;
  name: string;
  description?: string;
  owner?: string;
  rowCount?: number;
  tags?: string[];
  columns: ColumnSpec[];
  primaryKey?: string[];
  uniques?: string[][];
  foreignKeys?: ForeignKeySpec[];
}

export interface SchemaImportWarning {
  message: string;
  /** 1-based line in the source, when it has lines. */
  line?: number;
}

export interface SchemaImport {
  template: DiagramTemplate;
  warnings: SchemaImportWarning[];
  stats: { tables: number; columns: number; foreignKeys: number; skipped: number };
}

export interface TableModelOptions {
  title?: string;
  /** Schemas an unqualified reference falls back to, in order. Default `public`, `dbo`, `main`. */
  defaultSchemas?: string[];
}

const lower = (s: string) => s.toLowerCase();

/** Turn table specs into a validated, editable, unplaced document. */
export function buildTableModel(tables: readonly TableSpec[], opts: TableModelOptions = {}): SchemaImport {
  const warnings: SchemaImportWarning[] = [];
  const schemas = [...new Set(tables.map((t) => t.schema).filter((s): s is string => !!s))];
  const multiSchema = schemas.length > 1;

  // Ids: schema.table, lowercased, numbered on a clash.
  const taken = new Set<string>();
  const idOf = new Map<TableSpec, string>();
  for (const t of tables) {
    const base = lower(t.schema ? `${t.schema}.${t.name}` : t.name);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    idOf.set(t, id);
  }
  const bySchemaName = new Map<string, TableSpec>();
  const byName = new Map<string, TableSpec[]>();
  for (const t of tables) {
    bySchemaName.set(lower(`${t.schema ?? ""}.${t.name}`), t);
    (byName.get(lower(t.name)) ?? byName.set(lower(t.name), []).get(lower(t.name))!).push(t);
  }
  const fallbacks = (opts.defaultSchemas ?? ["public", "dbo", "main"]).map(lower);
  /** The table a reference names: as qualified, else in the referencing table's schema, the default schemas, or the one table of that name. */
  const resolve = (ref: string, from: TableSpec): TableSpec | undefined => {
    const parts = ref.split(".").map((p) => p.trim()).filter(Boolean);
    const name = parts.at(-1) ?? ref;
    const schema = parts.length > 1 ? parts.at(-2) : undefined;
    if (schema) return bySchemaName.get(lower(`${schema}.${name}`)) ?? (byName.get(lower(name))?.length === 1 ? byName.get(lower(name))![0] : undefined);
    return (
      bySchemaName.get(lower(`${from.schema ?? ""}.${name}`)) ??
      fallbacks.map((s) => bySchemaName.get(`${s}.${lower(name)}`)).find(Boolean) ??
      bySchemaName.get(`.${lower(name)}`) ??
      (byName.get(lower(name))?.length === 1 ? byName.get(lower(name))![0] : undefined)
    );
  };
  const sameColumns = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((c) => b.some((x) => lower(x) === lower(c)));
  const columnOf = (t: TableSpec, name: string) => t.columns.find((c) => lower(c.name) === lower(name));

  const groupId = (schema: string) => `schema-${lower(schema).replace(/[^a-z0-9]+/g, "-")}`;
  const nodes: DiagramNode[] = multiSchema
    ? schemas.map((s) => ({ id: groupId(s), label: s, kind: "group", icon: "none", description: "", parentId: null, x: 0, y: 0 }) as DiagramNode)
    : [];
  const edges: DiagramEdge[] = [];
  let columns = 0;
  let foreignKeys = 0;

  for (const t of tables) {
    const pk = (t.primaryKey ?? []).map(lower);
    const fkCols = new Set((t.foreignKeys ?? []).flatMap((f) => f.columns.map(lower)));
    const singleUniques = new Set((t.uniques ?? []).filter((u) => u.length === 1).map((u) => lower(u[0]!)));
    if (t.columns.length > MAX_NODE_FIELDS) {
      warnings.push({ message: `${t.name} has ${t.columns.length} columns; the document keeps the first ${MAX_NODE_FIELDS}` });
    }
    const seen = new Set<string>();
    const rows: NodeField[] = [];
    for (const c of t.columns.slice(0, MAX_NODE_FIELDS)) {
      if (seen.has(lower(c.name))) continue;
      seen.add(lower(c.name));
      const inPk = pk.includes(lower(c.name));
      const isFk = fkCols.has(lower(c.name));
      rows.push({
        id: c.name,
        name: c.name,
        ...(c.type ? { type: c.type } : {}),
        ...(inPk && isFk ? { key: "pfk" as const } : inPk ? { key: "pk" as const } : isFk ? { key: "fk" as const } : {}),
        ...(inPk || c.nullable === false ? { required: true } : {}),
        ...(c.unique || singleUniques.has(lower(c.name)) ? { unique: true } : {}),
        ...(c.generated ? { derived: true } : {}),
        ...(c.description ? { description: c.description } : {}),
        ...(c.tags?.length ? { tags: [...c.tags] } : {}),
      });
    }
    columns += rows.length;
    const description = t.description ?? "";
    const qualified = t.schema && multiSchema ? `${t.schema}.${t.name}` : t.name;
    nodes.push({
      id: idOf.get(t)!,
      label: t.name,
      kind: "table",
      icon: "none",
      description,
      parentId: t.schema && multiSchema ? groupId(t.schema) : null,
      x: 0,
      y: 0,
      w: 240,
      h: fieldsBoxHeight(rows.length, !!description),
      fields: rows,
      ...(t.owner ? { team: t.owner } : {}),
      ...(t.tags?.length ? { tags: [...t.tags] } : {}),
      data: {
        model: {
          name: qualified,
          ...(t.schema ? { namespace: t.schema } : {}),
          ...(t.rowCount !== undefined ? { recordCount: t.rowCount } : {}),
          ...(t.columns.length > MAX_NODE_FIELDS ? { fieldsTotal: t.columns.length, fieldsTruncated: true } : {}),
        },
      },
    } as DiagramNode);

    for (const fk of t.foreignKeys ?? []) {
      const target = resolve(fk.table, t);
      if (!target) {
        warnings.push({ message: `${t.name}.${fk.columns.join(", ")} references ${fk.table}, which the source doesn't define` });
        continue;
      }
      const refColumns = fk.refColumns?.length ? fk.refColumns : (target.primaryKey ?? []);
      const self = target === t;
      const identifying = !self && pk.length > 0 && fk.columns.every((c) => pk.includes(lower(c)));
      const kind = self ? "hierarchy" : identifying ? "composition" : "reference";
      const required = fk.columns.every((c) => columnOf(t, c)?.nullable === false || pk.includes(lower(c)));
      const oneToOne = sameColumns(fk.columns, t.primaryKey ?? []) || (fk.columns.length === 1 && singleUniques.has(lower(fk.columns[0]!))) || (fk.columns.length === 1 && !!columnOf(t, fk.columns[0]!)?.unique);
      const dressing = relationDressing(RELATION_KINDS[kind]!);
      const startField = rows.find((r) => lower(r.name) === lower(fk.columns[0]!))?.id;
      const endField = refColumns.length ? target.columns.find((c) => lower(c.name) === lower(refColumns[0]!))?.name : undefined;
      const onDelete = fk.onDelete?.trim().toLowerCase();
      let id = `${idOf.get(t)}.${lower(fk.columns.join("+"))}->${idOf.get(target)}`;
      for (let n = 2; edges.some((e) => e.id === id); n++) id = `${id}-${n}`;
      edges.push({
        id,
        source: idOf.get(t)!,
        target: idOf.get(target)!,
        label: "",
        ...dressing,
        ...(kind === "reference" && required ? { endLabel: "1" } : {}),
        ...(oneToOne && dressing.startLabel ? { startLabel: "0..1" } : {}),
        relation: kind,
        ...(startField !== undefined ? { startField } : {}),
        ...(endField !== undefined ? { endField } : {}),
        data: {
          model: {
            field: fk.columns[0],
            ...(refColumns[0] ? { targetField: refColumns[0] } : {}),
            ...(fk.columns.length > 1 ? { columns: [...fk.columns], targetColumns: [...refColumns] } : {}),
            kind,
            required,
            ...(fk.name ? { constraintName: fk.name } : {}),
            ...(onDelete === "cascade" ? { cascadeDelete: true } : {}),
            ...(onDelete ? { deleteConstraint: onDelete } : {}),
          },
        },
      } as DiagramEdge);
      foreignKeys++;
    }
  }

  const template = validateTemplate({
    version: 1,
    meta: { title: opts.title ?? "Data model" },
    nodes,
    edges,
  });
  return { template, warnings, stats: { tables: tables.length, columns, foreignKeys, skipped: 0 } };
}
