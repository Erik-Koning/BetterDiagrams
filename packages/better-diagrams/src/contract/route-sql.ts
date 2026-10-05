/**
 * route-sql.ts — a route between tables as the SQL that walks it.
 *
 * The path panel finds routes and names the key carrying each hop; the join
 * chain is then mechanical — a FROM, one JOIN per hop, the ON clause from
 * the key. What is NOT mechanical, and where analysts get burned, is
 * multiplicity: a hop from a parent to its children multiplies rows, and two
 * such hops multiply them twice. Every hop is classified, and the SQL comes
 * with warnings a reader can act on (aggregate first, or use EXISTS).
 *
 * Names: a table is its data-model entity name when the import recorded one,
 * else its id when that is an identifier (hand-drawn tables have slug ids
 * like `order_lines` and friendly labels), else its label; a column is its
 * field's name. Identifiers are
 * quoted only when they must be, in the dialect's own quotes.
 *
 * Zero dependencies, like every contract module.
 */
import type { GraphWalk } from "./graph";
import { cachedFieldRecords, edgeFieldIds, referencedKey, type FieldDocument } from "./fields";
import { cardinalityMarker } from "./geometry";

export type SqlDialect = "ansi" | "postgres" | "snowflake" | "bigquery" | "mysql" | "tsql";

export const SQL_DIALECTS: ReadonlyArray<{ id: SqlDialect; label: string }> = [
  { id: "ansi", label: "ANSI SQL" },
  { id: "postgres", label: "PostgreSQL" },
  { id: "snowflake", label: "Snowflake" },
  { id: "bigquery", label: "BigQuery" },
  { id: "mysql", label: "MySQL" },
  { id: "tsql", label: "SQL Server" },
];

type SqlNode = FieldDocument["nodes"][number];

export interface RouteSqlOptions {
  dialect?: SqlDialect;
  /**
   * `auto` (the default): INNER where the key is required and the hop walks
   * from the referencing table to the one it references — no row can be
   * lost — LEFT everywhere else.
   */
  join?: "inner" | "left" | "auto";
  /** `short` → t0, t1…; `table` → the table's initials, deduped. */
  aliases?: "short" | "table";
  /** `star` → `SELECT *`; `keys` → each table's key column. */
  select?: "star" | "keys";
  /** Override how a table is named (a schema prefix, a catalogue). */
  tableName?: (node: SqlNode) => string;
}

export type RouteSqlWarningKind = "fan-out" | "double-fan-out" | "polymorphic" | "no-key";

export interface RouteSqlWarning {
  /** 1-based hop number; 0 for a warning about the whole route. */
  hop: number;
  kind: RouteSqlWarningKind;
  message: string;
}

/** How many rows of the far table each row of the near one meets. */
export type HopMultiplicity = "one" | "many" | "unknown";

export interface RouteSql {
  sql: string;
  warnings: RouteSqlWarning[];
  tables: Array<{ alias: string; nodeId: string; table: string }>;
  hops: Array<{ edgeId: string; join: "INNER" | "LEFT"; multiplicity: HopMultiplicity }>;
}

const RESERVED = new Set([
  "all", "and", "as", "by", "case", "check", "column", "constraint", "create", "cross", "default", "delete", "desc", "distinct",
  "drop", "else", "end", "exists", "false", "from", "full", "grant", "group", "having", "in", "index", "inner", "insert", "into",
  "is", "join", "key", "left", "like", "limit", "not", "null", "on", "or", "order", "outer", "primary", "references", "right",
  "select", "set", "table", "then", "to", "true", "union", "unique", "update", "user", "using", "values", "when", "where", "with",
]);

function quote(name: string, dialect: SqlDialect): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toLowerCase())) return name;
  if (dialect === "mysql" || dialect === "bigquery") return `\`${name.replace(/`/g, "``")}\``;
  if (dialect === "tsql") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

const modelOf = (node: SqlNode | undefined): Record<string, unknown> | undefined => {
  const m = node?.data?.model;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : undefined;
};

/** The table's name as SQL knows it: the entity name, else an identifier-shaped id, else the label. */
export function sqlTableName(node: SqlNode): string {
  const name = modelOf(node)?.name;
  if (typeof name === "string" && name) return name;
  return /^[A-Za-z_][A-Za-z0-9_$.]*$/.test(node.id) ? node.id : (node.label ?? node.id);
}

/** A short alias from a table name: its initials ("order_lines" → "ol"). */
function initials(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = words.map((w) => w[0]!.toLowerCase()).join("");
  return /^[a-z]/.test(out) ? out : `t${out}`;
}

/**
 * The SQL walking `walk` from its first table to its last: one JOIN per
 * hop, each ON clause from the hop's key — the referencing field on one
 * side, the key it lands on on the other (the target's key when the line
 * doesn't name one) — flipped when the hop walks against the key.
 */
export function routeSql(doc: FieldDocument, walk: GraphWalk, opts: RouteSqlOptions = {}): RouteSql {
  const dialect = opts.dialect ?? "ansi";
  const q = (name: string) => quote(name, dialect);
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(doc.edges.map((e) => [e.id, e]));
  const records = cachedFieldRecords(doc);
  /** A field id → its column name (rows name their columns; data fields are their names). */
  const column = (nodeId: string, fieldId: string) => records.get(nodeId)?.find((r) => r.id === fieldId)?.name ?? fieldId;
  const record = (nodeId: string, fieldId: string | undefined) =>
    fieldId === undefined ? undefined : records.get(nodeId)?.find((r) => r.id === fieldId);
  const tableOf = (id: string) => {
    const node = nodeById.get(id);
    return node ? (opts.tableName ?? sqlTableName)(node) : id;
  };

  // Aliases, one per position — a route may visit a table only once, but a
  // name's initials can collide.
  const used = new Set<string>();
  const tables = walk.nodes.map((nodeId, i) => {
    const table = tableOf(nodeId);
    let alias = opts.aliases === "table" ? initials(table) : `t${i}`;
    if (used.has(alias)) {
      let n = 2;
      while (used.has(`${alias}${n}`)) n++;
      alias = `${alias}${n}`;
    }
    used.add(alias);
    return { alias, nodeId, table };
  });

  const warnings: RouteSqlWarning[] = [];
  const hops: RouteSql["hops"] = [];
  const joins: string[] = [];
  walk.edges.forEach((edgeId, i) => {
    const hop = i + 1;
    const near = tables[i]!;
    const far = tables[i + 1]!;
    const edge = edgeById.get(edgeId);
    if (!edge) return;
    const forward = edge.source === near.nodeId;
    const ends = edgeFieldIds(edge);
    const model = (edge.data?.model && typeof edge.data.model === "object" ? edge.data.model : {}) as Record<string, unknown>;
    const landing = ends.end ?? referencedKey(doc, { label: "", nodeId: edge.target, edgeId: edge.id })?.fieldId;

    // Multiplicity: walking a key to what it references meets one row (or
    // what the far end's label says); walking back meets many, unless the
    // key is unique or the near end's label says otherwise.
    let multiplicity: HopMultiplicity;
    if (!ends.start) multiplicity = "unknown";
    else if (forward) {
      const m = cardinalityMarker(edge.endLabel);
      multiplicity = m ? (m.endsWith("many") ? "many" : "one") : "one";
    } else {
      const m = cardinalityMarker(edge.startLabel);
      const unique = record(edge.source, ends.start)?.unique === true;
      multiplicity = m ? (m.endsWith("many") ? "many" : "one") : unique ? "one" : "many";
    }

    const required = model.required === true || record(edge.source, ends.start)?.nullable === false;
    const join: "INNER" | "LEFT" =
      opts.join === "inner" ? "INNER" : opts.join === "left" ? "LEFT" : forward && required ? "INNER" : "LEFT";
    hops.push({ edgeId, join, multiplicity });

    let on: string;
    if (!ends.start || !landing) {
      on = "1 = 1";
      warnings.push({ hop, kind: "no-key", message: `Hop ${hop} (${near.table} → ${far.table}) is a line with no key; the join condition is a placeholder.` });
    } else {
      const sourceAlias = forward ? near.alias : far.alias;
      const targetAlias = forward ? far.alias : near.alias;
      const left = `${q(targetAlias)}.${q(column(edge.target, landing))}`;
      const right = `${q(sourceAlias)}.${q(column(edge.source, ends.start))}`;
      // Written from the far table's side, so each ON reads "the new table's column = what we have".
      on = forward ? `${left} = ${right}` : `${right} = ${left}`;
    }
    const referenceTo = Array.isArray(model.referenceTo) ? model.referenceTo : [];
    const polymorphic = edge.relation === "polymorphic" || model.kind === "polymorphic" || referenceTo.length > 1;
    if (polymorphic) {
      warnings.push({
        hop,
        kind: "polymorphic",
        message: `Hop ${hop}: ${near.table} → ${far.table} is a polymorphic reference — also filter on the target's type.`,
      });
    }
    joins.push(
      `  ${join} JOIN ${q(far.table)} AS ${q(far.alias)} ON ${on}${polymorphic ? " /* polymorphic: also match the target type */" : ""}`,
    );
  });

  const manyHops = hops.flatMap((h, i) => (h.multiplicity === "many" ? [i + 1] : []));
  if (manyHops.length === 1) {
    warnings.push({ hop: manyHops[0]!, kind: "fan-out", message: `Hop ${manyHops[0]} goes from one row to many — the result has a row per ${tables[manyHops[0]!]!.table} row.` });
  } else if (manyHops.length > 1) {
    warnings.push({
      hop: 0,
      kind: "double-fan-out",
      message: `Rows multiply at hops ${manyHops.join(" and ")} — counts and sums over this join are inflated; aggregate each side first, or use EXISTS.`,
    });
  }

  const keyColumn = (nodeId: string) => {
    const pk = records.get(nodeId)?.find((r) => r.key === "pk" || r.key === "pfk");
    return pk?.name;
  };
  const select =
    opts.select === "keys"
      ? tables
          .map((t) => {
            const key = keyColumn(t.nodeId);
            return key ? `${q(t.alias)}.${q(key)} AS ${q(`${t.alias}_${key}`)}` : null;
          })
          .filter((s): s is string => !!s)
      : [];
  const head = select.length ? `SELECT\n  ${select.join(",\n  ")}` : "SELECT *";
  const first = tables[0];
  const sql = first ? `${head}\nFROM ${q(first.table)} AS ${q(first.alias)}${joins.length ? `\n${joins.join("\n")}` : ""}` : "";
  return { sql, warnings, tables, hops };
}
