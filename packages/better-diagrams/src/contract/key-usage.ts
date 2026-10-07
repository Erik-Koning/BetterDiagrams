/**
 * key-usage.ts — which tables carry a field, by NAME.
 *
 * `coverage.ts` asks how far a set of keys REACHES over the lines they
 * carry, one table's key at a time. This asks the question a modeller has of
 * a schema as a whole: which tables carry `tenant_id`, `AccountId`,
 * `created_by` — and what share of the model carries them. The unit is the
 * field's name: the same name on forty tables is one entry, whatever each
 * copy points at. Names are matched without regard to case, because a
 * schema that spells `AccountId` in one table and `accountid` in another
 * means one column.
 *
 * Tables are what `storesFields` says they are, as for key coverage: the
 * rows of an enum are values, and a view or a stand-in carries nothing.
 *
 * Zero dependencies, like every contract module.
 */
import { cachedFieldRecords, type FieldDocument, type FieldRef } from "./fields";
import { storesFields } from "./coverage";
import type { FieldKey } from "./schema";
import { DEFAULT_TYPE_ALIASES, normalizeType } from "./type-families";

/** One type a name is stored as, and the tables storing it that way. */
export interface FieldVariant {
  /** The normalised family (`varchar`), or `untyped` when a table doesn't say. */
  family: string;
  /** Under `strictTypes`, the parameters too ("36"); otherwise absent. */
  params?: string;
  /** The spellings seen for it, as the tables wrote them. */
  types: string[];
  /** Whether those tables allow an empty value: all, none, some, or nobody said. */
  nullable: boolean | "mixed" | "unknown";
  tables: Array<{ nodeId: string; fieldId: string }>;
}

/** One field name, across every table that carries it. */
export interface FieldUsage {
  /** The name lowercased — what groups spellings together, and what a chosen key is. */
  id: string;
  /** The spelling most tables use; the first seen on a tie. */
  name: string;
  /** The labels tables give it, deduped — a search matches these too. */
  labels: string[];
  /** Each table carrying it, in document order, with the field's id there and its key mark. */
  tables: Array<{ nodeId: string; fieldId: string; key?: FieldKey }>;
  /** A primary or foreign key, or a reference, on at least one of those tables. */
  isKey: boolean;
  /** The tables it points at, from any of the tables carrying it, deduped. */
  targets: string[];
  /** How it is stored, one entry per type family, most tables first. */
  variants: FieldVariant[];
  /**
   * One type family (untyped tables aside) and one nullability (tables that
   * don't say aside) across every table carrying it.
   */
  consistent: boolean;
}

export interface FieldUsageIndex {
  /** Every field name, most tables first, then by name. */
  fields: FieldUsage[];
  /** By `FieldUsage.id`. */
  byId: Map<string, FieldUsage>;
  /** Every table in the document, in document order — the denominator. */
  tables: string[];
  /**
   * Tables whose field list the importer cut short (`data.model.fieldsTruncated`):
   * a name they carry past the cut is not seen, so every count is "at least".
   */
  truncated: string[];
}

export interface FieldUsageOptions {
  /** Which nodes count as tables. Defaults to {@link storesFields}. */
  isTable?: (node: FieldDocument["nodes"][number]) => boolean;
  /** Spelling → family for type comparison. Defaults to {@link DEFAULT_TYPE_ALIASES}. */
  typeAliases?: Readonly<Record<string, string>>;
  /** Compare type parameters too (`varchar(36)` ≠ `varchar(255)`). Default false. */
  strictTypes?: boolean;
}

export function fieldUsage(doc: FieldDocument, opts: FieldUsageOptions = {}): FieldUsageIndex {
  const isTable = opts.isTable ?? storesFields;
  const tableNodes = doc.nodes.filter(isTable);
  // Read against the whole document, so a reference to a node that is not a
  // table still resolves; only tables are indexed.
  const records = cachedFieldRecords(doc);
  const aliases = opts.typeAliases ?? DEFAULT_TYPE_ALIASES;
  type Building = Omit<FieldUsage, "variants" | "consistent"> & {
    spellings: Map<string, number>;
    kinds: Map<string, { family: string; params?: string; types: Set<string>; nullables: Set<boolean>; tables: FieldVariant["tables"] }>;
  };
  const byId = new Map<string, Building>();
  for (const node of tableNodes) {
    const seen = new Set<string>();
    for (const record of records.get(node.id) ?? []) {
      const id = record.name.toLowerCase();
      // A table carrying two spellings of one name is one table carrying it.
      if (seen.has(id)) continue;
      seen.add(id);
      let usage = byId.get(id);
      if (!usage) {
        usage = { id, name: record.name, labels: [], tables: [], isKey: false, targets: [], spellings: new Map(), kinds: new Map() };
        byId.set(id, usage);
      }
      const type = normalizeType(record.storageType, aliases);
      const kindKey = opts.strictTypes ? `${type.family}(${type.params ?? ""})` : type.family;
      let kind = usage.kinds.get(kindKey);
      if (!kind) {
        kind = { family: type.family, ...(opts.strictTypes && type.params ? { params: type.params } : {}), types: new Set(), nullables: new Set(), tables: [] };
        usage.kinds.set(kindKey, kind);
      }
      if (record.storageType) kind.types.add(record.storageType);
      if (record.nullable !== undefined && !(record.key === "pk" || record.key === "pfk")) kind.nullables.add(record.nullable);
      kind.tables.push({ nodeId: node.id, fieldId: record.id });
      usage.spellings.set(record.name, (usage.spellings.get(record.name) ?? 0) + 1);
      if (record.label && !usage.labels.includes(record.label)) usage.labels.push(record.label);
      usage.tables.push({ nodeId: node.id, fieldId: record.id, ...(record.key ? { key: record.key } : {}) });
      if (record.key || record.fk.length) usage.isKey = true;
      for (const t of record.fk) if (t.nodeId && !usage.targets.includes(t.nodeId)) usage.targets.push(t.nodeId);
    }
  }
  const fields: FieldUsage[] = [...byId.values()].map(({ spellings, kinds, ...usage }) => {
    let best = usage.name;
    let count = 0;
    for (const [spelling, n] of spellings) if (n > count) [best, count] = [spelling, n];
    const variants: FieldVariant[] = [...kinds.values()]
      .map((k) => ({
        family: k.family,
        ...(k.params ? { params: k.params } : {}),
        types: [...k.types],
        nullable: (k.nullables.size === 2 ? "mixed" : k.nullables.size ? [...k.nullables][0]! : "unknown") as FieldVariant["nullable"],
        tables: k.tables,
      }))
      .sort((a, b) => b.tables.length - a.tables.length || a.family.localeCompare(b.family));
    // A primary key is never nullable, so its tables say nothing about the
    // name's nullability; untyped tables say nothing about its type.
    const typed = variants.filter((v) => v.family !== "untyped");
    const stated = new Set(variants.flatMap((v) => (v.nullable === "mixed" ? [true, false] : v.nullable === "unknown" ? [] : [v.nullable])));
    return { ...usage, name: best, variants, consistent: typed.length <= 1 && stated.size <= 1 };
  });
  fields.sort((a, b) => b.tables.length - a.tables.length || a.id.localeCompare(b.id));
  const truncated = tableNodes
    .filter((n) => {
      const m = n.data?.model as Record<string, unknown> | undefined;
      return !!m && typeof m === "object" && m.fieldsTruncated === true;
    })
    .map((n) => n.id);
  return { fields, byId: new Map(fields.map((f) => [f.id, f])), tables: tableNodes.map((n) => n.id), truncated };
}

/**
 * The field names whose name or a label contains the query, ignoring case.
 * The name outranks the label — the name itself, then names starting with
 * the query, then names containing it, then a label alone — so "building"
 * puts `building_id` above a widely shared `name` one table labels
 * "Building name"; within a rank, the index's order (most tables first).
 * An empty query lists every name two or more tables share — the columns a
 * schema has in common.
 */
export function searchFieldUsage(
  index: FieldUsageIndex,
  query: string,
  opts: { keysOnly?: boolean; inconsistentOnly?: boolean } = {},
): FieldUsage[] {
  const q = query.trim().toLowerCase();
  const candidates = index.fields.filter((f) => (!opts.keysOnly || f.isKey) && (!opts.inconsistentOnly || !f.consistent));
  // With nothing typed, the shared names — or, asked for them, every inconsistent one.
  if (!q) return opts.inconsistentOnly ? candidates : candidates.filter((f) => f.tables.length > 1);
  const rank = (f: FieldUsage) =>
    f.id === q ? 0 : f.id.startsWith(q) ? 1 : f.id.includes(q) ? 2 : f.labels.some((l) => l.toLowerCase().includes(q)) ? 3 : -1;
  return candidates
    .map((f, order) => ({ f, order, rank: rank(f) }))
    .filter((r) => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((r) => r.f);
}

export interface UsageOptions {
  /** A table counts when it uses ANY chosen key (the default) or ALL of them. */
  match?: "any" | "all";
  /** A key also counts for the tables it points at, not only the ones carrying it. Default false. */
  includeTargets?: boolean;
}

export interface UsageCoverage {
  /** The tables counted, in document order: the chosen fields each carries, and the chosen keys pointing at it. */
  covered: Array<{ nodeId: string; carries: FieldRef[]; pointedAtBy: string[] }>;
  /** The tables not counted, in document order. */
  missing: string[];
  total: number;
  /** `covered.length / total`, 0..1. */
  fraction: number;
  /** Per chosen key (by id), how many tables use it — carry it, or are pointed at by it when targets count. */
  perKey: Map<string, number>;
}

/**
 * Score a chosen set of field names: which tables use them and what share of
 * the model that is. Names the index doesn't know are skipped, so a set kept
 * across an edit that removed one still scores the rest; none chosen counts
 * nothing (even under "all", where an empty set would otherwise hold for
 * every table).
 */
export function usageCoverage(index: FieldUsageIndex, chosen: readonly string[], opts: UsageOptions = {}): UsageCoverage {
  const keys = [...new Set(chosen)].map((id) => index.byId.get(id)).filter((f): f is FieldUsage => !!f);
  const total = index.tables.length;
  const perKey = new Map<string, number>();
  const carries = new Map<string, FieldRef[]>();
  const pointed = new Map<string, string[]>();
  const uses = new Map<string, Set<string>>();
  const note = (nodeId: string, key: string) => {
    let set = uses.get(nodeId);
    if (!set) uses.set(nodeId, (set = new Set()));
    set.add(key);
  };
  const tableSet = new Set(index.tables);
  for (const key of keys) {
    const users = new Set<string>();
    for (const t of key.tables) {
      users.add(t.nodeId);
      note(t.nodeId, key.id);
      const list = carries.get(t.nodeId);
      const ref = { nodeId: t.nodeId, fieldId: t.fieldId };
      if (list) list.push(ref);
      else carries.set(t.nodeId, [ref]);
    }
    if (opts.includeTargets) {
      for (const target of key.targets) {
        if (!tableSet.has(target)) continue;
        users.add(target);
        note(target, key.id);
        const list = pointed.get(target);
        if (list) list.push(key.id);
        else pointed.set(target, [key.id]);
      }
    }
    perKey.set(key.id, users.size);
  }
  const counts = (nodeId: string) => {
    const set = uses.get(nodeId);
    if (!set || !keys.length) return false;
    return opts.match === "all" ? keys.every((k) => set.has(k.id)) : true;
  };
  const covered: UsageCoverage["covered"] = [];
  const missing: string[] = [];
  for (const nodeId of index.tables) {
    if (counts(nodeId)) covered.push({ nodeId, carries: carries.get(nodeId) ?? [], pointedAtBy: pointed.get(nodeId) ?? [] });
    else missing.push(nodeId);
  }
  return { covered, missing, total, fraction: total ? covered.length / total : 0, perKey };
}

// ── Words both panels use — the editor's and the HTML page's say the same ──

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "4 of 9 tables use them", "1 of 9 tables have all of them". */
export function usageHeadline(coverage: Pick<UsageCoverage, "covered" | "total">, match: "any" | "all", picked: number): string {
  return `${coverage.covered.length} of ${plural(coverage.total, "table")} ${match === "all" && picked > 1 ? "have all of them" : "use them"}`;
}

/** "uuid · 40 tables · required", "untyped · 1 table". */
export function variantSummary(v: FieldVariant): string {
  const type = v.family === "untyped" ? "untyped" : v.types[0] && v.types.length === 1 ? v.types[0] : v.family + (v.params ? `(${v.params})` : "");
  const nullable = v.nullable === true ? " · nullable" : v.nullable === false ? " · required" : v.nullable === "mixed" ? " · sometimes nullable" : "";
  return `${type} · ${plural(v.tables.length, "table")}${nullable}`;
}

/** Why a name is flagged inconsistent, in one line ("2 types: uuid, varchar"; "nullable in 3 of 42"). */
export function inconsistencySummary(f: FieldUsage): string {
  const typed = f.variants.filter((v) => v.family !== "untyped");
  const parts: string[] = [];
  if (typed.length > 1) parts.push(`${typed.length} types: ${typed.map((v) => v.family).join(", ")}`);
  const nullableTables = f.variants.reduce((n, v) => n + (v.nullable === true ? v.tables.length : 0), 0);
  const requiredTables = f.variants.reduce((n, v) => n + (v.nullable === false ? v.tables.length : 0), 0);
  if ((nullableTables && requiredTables) || f.variants.some((v) => v.nullable === "mixed")) {
    parts.push(`nullable in some tables, required in others`);
  }
  return parts.join("; ");
}
