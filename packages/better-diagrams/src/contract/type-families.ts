/**
 * type-families.ts — when two column types are "the same type".
 *
 * Schemas spell one type many ways (`int`, `INTEGER`, `int4`; `varchar(36)`,
 * `character varying(36)`). A consistency check that compared raw strings
 * would drown in noise, and one that folded everything would miss real
 * drift. So a type normalises to a FAMILY — lowercased, whitespace
 * collapsed, parameters split off, true synonyms folded — and comparisons
 * are by family unless a caller asks for strict parameters too.
 *
 * The default aliases fold only synonyms (`int4` is `integer`); near
 * relations a reviewer would want to hear about (`int` vs `bigint`,
 * `varchar` vs `text`) stay distinct. A host whose platform means one thing
 * by two names passes its own aliases. `reference` folds into `id` because a
 * platform that types its keys `id` types the fields pointing at them
 * `reference`, and those are one storage type.
 *
 * Zero dependencies, like every contract module.
 */

/** Spelling → family. Keys are normalised (lowercase, single spaces). */
export const DEFAULT_TYPE_ALIASES: Readonly<Record<string, string>> = {
  int: "integer",
  int4: "integer",
  integer: "integer",
  int8: "bigint",
  long: "bigint",
  int2: "smallint",
  bool: "boolean",
  "character varying": "varchar",
  nvarchar: "varchar",
  varchar2: "varchar",
  nvarchar2: "varchar",
  character: "char",
  nchar: "char",
  bpchar: "char",
  numeric: "decimal",
  "double precision": "double",
  float8: "double",
  float4: "real",
  "timestamp without time zone": "timestamp",
  datetime: "timestamp",
  datetime2: "timestamp",
  timestamp_ntz: "timestamp",
  "timestamp with time zone": "timestamptz",
  timestamp_tz: "timestamptz",
  datetimeoffset: "timestamptz",
  uniqueidentifier: "uuid",
  guid: "uuid",
  jsonb: "json",
  reference: "id",
};

export interface TypeFamily {
  /** The folded type name, `[]`-suffixed for arrays. */
  family: string;
  /** What was in the parentheses, spaces removed ("255", "10,2"), if anything. */
  params?: string;
}

/** Normalise one type. An empty or missing type is `untyped`. */
export function normalizeType(raw: string | undefined, aliases: Readonly<Record<string, string>> = DEFAULT_TYPE_ALIASES): TypeFamily {
  const text = (raw ?? "").trim().toLowerCase().replace(/["`]/g, "").replace(/\s+/g, " ");
  if (!text) return { family: "untyped" };
  const m = /^(.*?)\s*(?:\(([^)]*)\))?\s*((?:\[\])*)$/.exec(text);
  const base = (m?.[1] ?? text).trim();
  const params = m?.[2]?.replace(/\s+/g, "");
  const array = m?.[3] ?? "";
  const family = `${aliases[base] ?? base}${array}`;
  return { family, ...(params ? { params } : {}) };
}

/** Whether two types are the same family — and, when `strict`, the same parameters. */
export function sameType(a: string | undefined, b: string | undefined, opts: { strict?: boolean; aliases?: Readonly<Record<string, string>> } = {}): boolean {
  const x = normalizeType(a, opts.aliases);
  const y = normalizeType(b, opts.aliases);
  return x.family === y.family && (!opts.strict || (x.params ?? "") === (y.params ?? ""));
}
