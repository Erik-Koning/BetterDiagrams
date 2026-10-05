/**
 * import/dbt.ts — a dbt project's tables and keys, from its artifacts.
 *
 * `manifest.json` (what `dbt compile`/`dbt build` writes to `target/`) says
 * what the project builds — models, seeds, snapshots — and reads (sources),
 * with descriptions, tags, owners and the tests and constraints that state
 * its keys. `catalog.json` (`dbt docs generate`) adds what the warehouse
 * says: every column's type and order, and row counts where the adapter
 * reports them. The catalog is optional; without it, types are whatever the
 * project declared (`data_type`).
 *
 * Keys, in order of authority:
 *   constraints    `primary_key` / `foreign_key`, on a column or the model —
 *                  dbt 1.9's `to` + `to_columns`, or the older `expression`
 *   tests          `relationships` → a foreign key (its target found through
 *                  `depends_on`); `unique` with `not_null` on one column → the
 *                  key when none is declared; `not_null` → required; `unique`
 *                  → unique; `dbt_utils.unique_combination_of_columns` → a
 *                  composite key when there is no other
 *
 * Owners come from `meta.owner` or the model's group; a column whose meta
 * says `pii`, `contains_pii` or `sensitive` is tagged `pii`. Ephemeral models
 * build nothing in the warehouse and are left out. dbt's model-level
 * dependencies are not column lineage, so they are not read as lineage.
 *
 * Zero dependencies, like every contract module.
 */
import { buildTableModel, type ColumnSpec, type ForeignKeySpec, type SchemaImport, type TableModelOptions, type TableSpec } from "./table-model";

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const parse = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);

/** Whether a parsed JSON document is a dbt manifest. */
export function isDbtManifest(raw: unknown): boolean {
  return isRecord(raw) && isRecord(raw.metadata) && typeof raw.metadata.dbt_schema_version === "string" && /manifest/i.test(raw.metadata.dbt_schema_version);
}

export interface DbtArtifacts {
  manifest: unknown;
  catalog?: unknown;
}

const TABLE_TYPES = new Set(["model", "seed", "snapshot", "source"]);
const PII_META = ["pii", "contains_pii", "sensitive"];

/** "ref('customers')", "ref('pkg', 'customers')", "source('raw', 'orders')" → the parts. */
function refArgs(text: string): { kind: "ref" | "source"; args: string[] } | null {
  const m = /^\s*(?:\{\{\s*)?(ref|source)\s*\(([^)]*)\)/i.exec(text);
  if (!m) return null;
  const args = [...m[2]!.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]!);
  return { kind: m[1]!.toLowerCase() as "ref" | "source", args };
}

/** A foreign key's target from a constraint `expression`: "analytics.dbt.customers (id)" or "customers(id)". */
function expressionTarget(expr: string): { table: string; columns: string[] } | null {
  const m = /^\s*([^(\s]+(?:\s*\.\s*[^(\s]+)*)\s*\(([^)]*)\)/.exec(expr);
  if (!m) return null;
  return { table: m[1]!.replace(/["`\s]/g, ""), columns: m[2]!.split(",").map((c) => c.trim().replace(/["`]/g, "")).filter(Boolean) };
}

export function importDbt(artifacts: DbtArtifacts, opts: TableModelOptions = {}): SchemaImport {
  const manifest = parse(artifacts.manifest);
  if (!isDbtManifest(manifest)) throw new Error("Not a dbt manifest (no metadata.dbt_schema_version)");
  const m = manifest as Json;
  const catalog = artifacts.catalog !== undefined ? parse(artifacts.catalog) : undefined;
  const catalogNodes: Json = isRecord(catalog) ? { ...(isRecord(catalog.nodes) ? catalog.nodes : {}), ...(isRecord(catalog.sources) ? catalog.sources : {}) } : {};
  const nodes: Json = { ...(isRecord(m.nodes) ? m.nodes : {}), ...(isRecord(m.sources) ? m.sources : {}) };
  const groups = isRecord(m.groups) ? m.groups : {};
  const warnings: SchemaImport["warnings"] = [];

  // The tables, by unique id.
  const specs = new Map<string, TableSpec & { columns: ColumnSpec[]; foreignKeys: ForeignKeySpec[]; uniques: string[][] }>();
  const qualified = new Map<string, string>(); // unique id → schema.name, what a foreign key names
  const byRef = new Map<string, string>(); // "customers" / "raw.orders" → unique id
  let ephemeral = 0;
  for (const [uid, raw] of Object.entries(nodes)) {
    if (!isRecord(raw)) continue;
    const type = str(raw.resource_type);
    if (!type || !TABLE_TYPES.has(type)) continue;
    const config = isRecord(raw.config) ? raw.config : {};
    if (config.enabled === false) continue;
    if (config.materialized === "ephemeral") {
      ephemeral++;
      continue;
    }
    const name = (type === "source" ? str(raw.identifier) : str(raw.alias)) ?? str(raw.name) ?? uid;
    const schema = str(raw.schema);
    const meta = { ...(isRecord(config.meta) ? config.meta : {}), ...(isRecord(raw.meta) ? raw.meta : {}) };
    const groupName = str(raw.group) ?? str(config.group);
    const group = groupName ? Object.values(groups).find((g) => isRecord(g) && g.name === groupName) : undefined;
    const groupOwner = isRecord(group) && isRecord(group.owner) ? (str(group.owner.name) ?? str(group.owner.email)) : undefined;
    const cat = isRecord(catalogNodes[uid]) ? (catalogNodes[uid] as Json) : undefined;
    const catColumns = isRecord(cat?.columns) ? (cat!.columns as Json) : {};
    const catByName = new Map(Object.values(catColumns).filter(isRecord).map((c) => [String(c.name ?? "").toLowerCase(), c]));
    const rowCount = isRecord(cat?.stats) && isRecord((cat!.stats as Json).row_count) ? ((cat!.stats as Json).row_count as Json).value : undefined;

    // Columns: the catalog's order when there is one, the project's otherwise; descriptions and tags from the project.
    const declared = isRecord(raw.columns) ? Object.values(raw.columns).filter(isRecord) : [];
    const declaredByName = new Map(declared.map((c) => [String(c.name ?? "").toLowerCase(), c]));
    const names = cat
      ? [...catByName.values()].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0)).map((c) => String(c.name))
      : declared.map((c) => String(c.name));
    for (const c of declared) if (!names.some((n) => n.toLowerCase() === String(c.name).toLowerCase())) names.push(String(c.name));
    const columns: ColumnSpec[] = names.map((n) => {
      const d = declaredByName.get(n.toLowerCase());
      const c = catByName.get(n.toLowerCase());
      // The project's spelling of a name, when it has one; the warehouse's otherwise.
      const colName = str(d?.name) ?? n;
      const colMeta = isRecord(d?.meta) ? d!.meta : {};
      const tags = [...(Array.isArray(d?.tags) ? d!.tags.filter((t): t is string => typeof t === "string") : [])];
      if (PII_META.some((k) => colMeta[k] === true || colMeta[k] === "true") && !tags.some((t) => /^pii/i.test(t))) tags.push("pii");
      const type = str(c?.type) ?? str(d?.data_type);
      const description = str(d?.description) ?? str(c?.comment);
      return { name: colName, ...(type ? { type } : {}), ...(description ? { description } : {}), ...(tags.length ? { tags } : {}) };
    });
    const tableTags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [];
    const description = str(raw.description) ?? (isRecord(cat?.metadata) ? str((cat!.metadata as Json).comment) : undefined);
    specs.set(uid, {
      name,
      ...(schema ? { schema } : {}),
      ...(description ? { description } : {}),
      ...((str(meta.owner) ?? groupOwner) ? { owner: (str(meta.owner) ?? groupOwner)! } : {}),
      ...(typeof rowCount === "number" ? { rowCount } : {}),
      ...(tableTags.length ? { tags: tableTags } : {}),
      columns,
      foreignKeys: [],
      uniques: [],
    });
    qualified.set(uid, schema ? `${schema}.${name}` : name);
    if (type === "source") byRef.set(`${String(raw.source_name ?? "")}.${String(raw.name ?? name)}`.toLowerCase(), uid);
    else byRef.set(String(raw.name ?? name).toLowerCase(), uid);
  }

  const columnOf = (spec: TableSpec, name: string) => spec.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const refTarget = (to: string): string | undefined => {
    const r = refArgs(to);
    if (!r) return undefined;
    const uid = r.kind === "source" ? byRef.get(r.args.slice(-2).join(".").toLowerCase()) : byRef.get(r.args.at(-1)!.toLowerCase());
    return uid ? qualified.get(uid) : undefined;
  };

  // Constraints: declared keys.
  const declaredPk = new Set<string>();
  for (const [uid, spec] of specs) {
    const raw = nodes[uid] as Json;
    const fromConstraint = (c: Json, cols: string[]) => {
      const type = str(c.type);
      if (type === "primary_key" && cols.length) {
        spec.primaryKey = cols;
        declaredPk.add(uid);
      } else if (type === "not_null") for (const col of cols) Object.assign(columnOf(spec, col) ?? {}, { nullable: false });
      else if (type === "unique" && cols.length) spec.uniques.push(cols);
      else if (type === "foreign_key" && cols.length) {
        const viaTo = str(c.to) ? refTarget(String(c.to)) : undefined;
        const toColumns = Array.isArray(c.to_columns) ? c.to_columns.filter((x): x is string => typeof x === "string") : undefined;
        const viaExpr = str(c.expression) ? expressionTarget(String(c.expression)) : null;
        const table = viaTo ?? viaExpr?.table;
        if (!table) {
          warnings.push({ message: `${spec.name}.${cols.join(", ")}: a foreign key constraint whose target can't be read` });
          return;
        }
        const refColumns = toColumns ?? viaExpr?.columns;
        spec.foreignKeys.push({ columns: cols, table, ...(refColumns?.length ? { refColumns } : {}), ...(str(c.name) ? { name: String(c.name) } : {}) });
      }
    };
    for (const c of Array.isArray(raw.constraints) ? raw.constraints.filter(isRecord) : []) {
      fromConstraint(c, Array.isArray(c.columns) ? c.columns.filter((x): x is string => typeof x === "string") : []);
    }
    const declared = isRecord(raw.columns) ? Object.values(raw.columns).filter(isRecord) : [];
    for (const col of declared) {
      for (const c of Array.isArray(col.constraints) ? col.constraints.filter(isRecord) : []) fromConstraint(c, [String(col.name)]);
    }
  }

  // Tests: keys the project checks rather than declares.
  const uniqueCols = new Map<string, Set<string>>();
  const notNullCols = new Map<string, Set<string>>();
  const combinations = new Map<string, string[]>();
  const note = (map: Map<string, Set<string>>, uid: string, col: string) => (map.get(uid) ?? map.set(uid, new Set()).get(uid)!).add(col.toLowerCase());
  for (const raw of Object.values(nodes)) {
    if (!isRecord(raw) || raw.resource_type !== "test" || !isRecord(raw.test_metadata)) continue;
    if (isRecord(raw.config) && raw.config.enabled === false) continue;
    const name = str(raw.test_metadata.name);
    const kwargs = isRecord(raw.test_metadata.kwargs) ? raw.test_metadata.kwargs : {};
    const attached = str(raw.attached_node) ?? (isRecord(raw.depends_on) && Array.isArray(raw.depends_on.nodes) ? String(raw.depends_on.nodes.at(-1)) : undefined);
    const spec = attached ? specs.get(attached) : undefined;
    if (!spec || !attached) continue;
    const column = str(raw.column_name) ?? str(kwargs.column_name);
    if (name === "unique" && column) note(uniqueCols, attached, column);
    else if (name === "not_null" && column) note(notNullCols, attached, column);
    else if (name === "unique_combination_of_columns" && Array.isArray(kwargs.combination_of_columns)) {
      combinations.set(attached, kwargs.combination_of_columns.filter((x): x is string => typeof x === "string"));
    } else if (name === "relationships" && column) {
      const deps = isRecord(raw.depends_on) && Array.isArray(raw.depends_on.nodes) ? raw.depends_on.nodes.filter((x): x is string => typeof x === "string") : [];
      // The target is what `to` names (a model testing itself names itself); depends_on
      // is the fallback for a `to` this can't read.
      const named = str(kwargs.to) ? refArgs(String(kwargs.to)) : null;
      const other = deps.find((d) => d !== attached && specs.has(d));
      const table = named ? refTarget(String(kwargs.to)) : other ? qualified.get(other) : undefined;
      if (!table) {
        warnings.push({ message: `${spec.name}.${column}: a relationships test to ${String(kwargs.to ?? "?")}, which the project doesn't build` });
        continue;
      }
      const field = str(kwargs.field);
      if (spec.foreignKeys.some((f) => f.columns.length === 1 && f.columns[0]!.toLowerCase() === column.toLowerCase())) continue;
      spec.foreignKeys.push({ columns: [column], table, ...(field ? { refColumns: [field] } : {}) });
    }
  }
  for (const [uid, spec] of specs) {
    const unique = uniqueCols.get(uid) ?? new Set<string>();
    const notNull = notNullCols.get(uid) ?? new Set<string>();
    for (const c of spec.columns) {
      if (notNull.has(c.name.toLowerCase())) c.nullable = false;
      if (unique.has(c.name.toLowerCase())) c.unique = true;
    }
    if (declaredPk.has(uid)) continue;
    // The key: a unique, never-null column — `id` or `<table>_id` first — else a unique combination.
    const candidates = spec.columns.filter((c) => unique.has(c.name.toLowerCase()) && notNull.has(c.name.toLowerCase()));
    const singular = spec.name.toLowerCase().replace(/s$/, "");
    const pick = candidates.find((c) => /^id$/i.test(c.name)) ?? candidates.find((c) => c.name.toLowerCase() === `${singular}_id`) ?? candidates[0];
    if (pick) spec.primaryKey = [pick.name];
    else if (combinations.get(uid)?.length) spec.primaryKey = combinations.get(uid)!;
  }
  if (ephemeral) warnings.push({ message: `${ephemeral} ephemeral model${ephemeral === 1 ? "" : "s"} left out — they build nothing in the warehouse` });

  const metadata = m.metadata as Json;
  const built = buildTableModel(
    [...specs.values()].map(({ uniques, foreignKeys, ...t }) => ({ ...t, ...(uniques.length ? { uniques } : {}), ...(foreignKeys.length ? { foreignKeys } : {}) })),
    { title: opts.title ?? str(metadata.project_name) ?? "dbt project", ...(opts.defaultSchemas ? { defaultSchemas: opts.defaultSchemas } : {}) },
  );
  return { ...built, warnings: [...warnings, ...built.warnings] };
}
