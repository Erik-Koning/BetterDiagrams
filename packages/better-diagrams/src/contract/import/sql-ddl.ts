/**
 * import/sql-ddl.ts — a schema script in, a data model out.
 *
 * Reads the DDL a database dumps — `pg_dump --schema-only`, `mysqldump -d`,
 * SQL Server's "Script table as", Snowflake's `GET_DDL`, BigQuery and SQLite
 * — tolerantly: it understands the statements that describe tables and
 * keys, and counts the rest rather than failing on them.
 *
 *   CREATE TABLE             columns (type, NOT NULL, DEFAULT, PRIMARY KEY,
 *                            UNIQUE, REFERENCES, generated/computed,
 *                            COMMENT, BigQuery OPTIONS(description)), table
 *                            constraints (PRIMARY KEY, UNIQUE, FOREIGN KEY,
 *                            named or not), the table's COMMENT
 *   ALTER TABLE … ADD        primary, unique and foreign keys added later
 *                            (how pg_dump and SQL Server write them)
 *   CREATE UNIQUE INDEX      a one-column unique index marks the column unique
 *   COMMENT ON TABLE/COLUMN  descriptions (Postgres, Snowflake)
 *   sp_addextendedproperty   MS_Description, SQL Server's descriptions
 *
 * Views and `CREATE TABLE … AS SELECT` are warned about (they have no
 * column list to read); everything else is counted by kind and skipped. A
 * table or key statement that can't be read is a warning with its line.
 *
 * The tables go through `buildTableModel`, so the result is an ordinary
 * editable document, unplaced, ready for auto-layout.
 *
 * Zero dependencies, like every contract module.
 */
import { buildTableModel, type ColumnSpec, type ForeignKeySpec, type SchemaImport, type SchemaImportWarning, type TableModelOptions, type TableSpec } from "./table-model";

interface Token {
  /** word: a bare word or number; ident: a quoted identifier; string: a literal; punct: one character. */
  kind: "word" | "ident" | "string" | "punct";
  text: string;
  line: number;
}

/** Split SQL into tokens, dropping comments and whitespace. */
function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  // A byte-order mark is not part of the first statement.
  let i = sql.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  const n = sql.length;
  const push = (kind: Token["kind"], text: string, at: number) => out.push({ kind, text, line: at });
  while (i < n) {
    const c = sql[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") {
      i++;
      continue;
    }
    // Comments: -- and # (MySQL, when followed by a space) to the end of the line; /* … */.
    if ((c === "-" && sql[i + 1] === "-") || (c === "#" && (sql[i + 1] === " " || sql[i + 1] === "\t" || sql[i + 1] === "\n"))) {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) {
        if (sql[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    const at = line;
    // Strings: '…' with '' (and MySQL's backslash) escapes.
    if (c === "'") {
      let s = "";
      i++;
      while (i < n) {
        const d = sql[i]!;
        if (d === "\\" && i + 1 < n) {
          s += sql[i + 1];
          i += 2;
          continue;
        }
        if (d === "'") {
          if (sql[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (d === "\n") line++;
        s += d;
        i++;
      }
      push("string", s, at);
      continue;
    }
    // Postgres dollar quoting: $$…$$ or $tag$…$tag$ (function bodies).
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end < 0 ? n : end + m[0].length;
        for (let k = i; k < stop; k++) if (sql[k] === "\n") line++;
        push("string", sql.slice(i + m[0].length, end < 0 ? n : end), at);
        i = stop;
        continue;
      }
    }
    // Quoted identifiers: "x" (doubled "" escapes), `x`, and SQL Server's [x].
    if (c === '"' || c === "`") {
      let s = "";
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            s += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += sql[i];
        i++;
      }
      push("ident", s, at);
      continue;
    }
    if (c === "[") {
      const close = sql.indexOf("]", i + 1);
      const inner = close < 0 ? "" : sql.slice(i + 1, close);
      // An array suffix (int[], int[3]) is punctuation; anything else is a bracketed name.
      if (close > 0 && inner.length && !/^\d*$/.test(inner) && !inner.includes("\n")) {
        push("ident", inner, at);
        i = close + 1;
        continue;
      }
    }
    if (/[A-Za-z0-9_@#$]/.test(c) || c.charCodeAt(0) > 127) {
      let j = i + 1;
      while (j < n && (/[A-Za-z0-9_@#$]/.test(sql[j]!) || sql.charCodeAt(j) > 127)) j++;
      // A decimal number keeps its point.
      if (/^\d+$/.test(sql.slice(i, j)) && sql[j] === "." && /\d/.test(sql[j + 1] ?? "")) {
        j++;
        while (j < n && /\d/.test(sql[j]!)) j++;
      }
      push("word", sql.slice(i, j), at);
      i = j;
      continue;
    }
    push("punct", c, at);
    i++;
  }
  return out;
}

/** Statements: split on `;` and on SQL Server's `GO`, alone on its line. */
/** Words that open a body (a routine, a trigger, a view's query) — a CREATE inside one is not a new statement. */
const BODY_WORDS = new Set(["PROCEDURE", "PROC", "FUNCTION", "TRIGGER", "VIEW", "EVENT", "PACKAGE", "RULE", "BEGIN"]);

/**
 * Statements: split on `;`, on SQL Server's `GO` alone on its line, and —
 * because SQL Server scripts may leave out both — before a CREATE or ALTER
 * that starts a line outside any parentheses, when the statement so far is
 * a table's or an index's rather than a body that may hold its own.
 */
function statements(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  const flush = () => {
    if (cur.length) out.push(cur);
    cur = [];
    depth = 0;
  };
  tokens.forEach((t, k) => {
    if (t.kind === "punct" && t.text === ";") return flush();
    const firstOnLine = k === 0 || tokens[k - 1]!.line < t.line;
    if (t.kind === "word" && /^go$/i.test(t.text) && firstOnLine && (k === tokens.length - 1 || tokens[k + 1]!.line > t.line)) {
      return flush();
    }
    if (
      cur.length &&
      depth === 0 &&
      firstOnLine &&
      isWord(t, "CREATE", "ALTER") &&
      isWord(cur[0], "CREATE", "ALTER") &&
      !cur.slice(0, 6).some((x) => x.kind === "word" && BODY_WORDS.has(x.text.toUpperCase()))
    ) {
      flush();
    }
    if (isPunct(t, "(")) depth++;
    else if (isPunct(t, ")")) depth = Math.max(0, depth - 1);
    cur.push(t);
  });
  flush();
  return out;
}

/**
 * MySQL's DELIMITER blocks (how mysqldump writes triggers and routines):
 * their bodies hold `;` that end nothing, so each block is taken out —
 * counted by kind, its lines kept blank so line numbers still point home.
 */
function withoutDelimiterBlocks(sql: string): { text: string; skipped: Record<string, number> } {
  const skipped: Record<string, number> = {};
  if (!/^\s*DELIMITER\s/im.test(sql)) return { text: sql, skipped };
  const out: string[] = [];
  let delimiter = ";";
  let block: string[] = [];
  const flushBlock = () => {
    for (const part of block.join("\n").split(delimiter)) {
      const words = part.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, " ").trim().split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      const kind = words[0]!.toUpperCase() === "CREATE" ? `CREATE ${(words.find((w, i) => i > 0 && /^(PROCEDURE|FUNCTION|TRIGGER|EVENT)$/i.test(w)) ?? words[1] ?? "").toUpperCase()}` : words[0]!.toUpperCase();
      skipped[kind] = (skipped[kind] ?? 0) + 1;
    }
    block = [];
  };
  for (const line of sql.split("\n")) {
    const m = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(line);
    if (m) {
      if (delimiter !== ";") flushBlock();
      delimiter = m[1]!;
      out.push("");
      continue;
    }
    if (delimiter === ";") out.push(line);
    else {
      block.push(line);
      out.push("");
    }
  }
  if (delimiter !== ";") flushBlock();
  return { text: out.join("\n"), skipped };
}

const isWord = (t: Token | undefined, ...words: string[]) => !!t && t.kind === "word" && words.some((w) => t.text.toUpperCase() === w);
const isPunct = (t: Token | undefined, p: string) => !!t && t.kind === "punct" && t.text === p;

/** A cursor over one statement's tokens. */
class Reader {
  i = 0;
  constructor(readonly t: Token[]) {}
  peek(k = 0) {
    return this.t[this.i + k];
  }
  next() {
    return this.t[this.i++];
  }
  done() {
    return this.i >= this.t.length;
  }
  /** Consume the words, in order, if they come next. */
  take(...words: string[]): boolean {
    for (let k = 0; k < words.length; k++) if (!isWord(this.peek(k), words[k]!)) return false;
    this.i += words.length;
    return true;
  }
  takePunct(p: string): boolean {
    if (!isPunct(this.peek(), p)) return false;
    this.i++;
    return true;
  }
  /** Skip a balanced ( … ) if one comes next; return its tokens. */
  group(): Token[] | null {
    if (!isPunct(this.peek(), "(")) return null;
    const start = ++this.i;
    let depth = 1;
    while (!this.done()) {
      const t = this.next()!;
      if (isPunct(t, "(")) depth++;
      else if (isPunct(t, ")") && --depth === 0) return this.t.slice(start, this.i - 1);
    }
    return this.t.slice(start);
  }
  /** A dotted name: a.b.c, each part a word or a quoted identifier. Quoted parts with dots (BigQuery) split. */
  name(): string[] | null {
    const parts: string[] = [];
    const part = () => {
      const t = this.peek();
      if (!t || (t.kind !== "word" && t.kind !== "ident")) return false;
      this.i++;
      parts.push(...(t.kind === "ident" && t.text.includes(".") && !t.text.includes(" ") ? t.text.split(".") : [t.text]));
      return true;
    };
    if (!part()) return null;
    while (isPunct(this.peek(), ".")) {
      this.i++;
      if (!part()) break;
    }
    return parts;
  }
}

/** Column names in a ( … ) list, without sort orders or lengths. */
function columnList(tokens: Token[] | null): string[] {
  if (!tokens) return [];
  const out: string[] = [];
  let depth = 0;
  let expectName = true;
  for (const t of tokens) {
    if (isPunct(t, "(")) depth++;
    else if (isPunct(t, ")")) depth--;
    else if (depth === 0 && isPunct(t, ",")) expectName = true;
    else if (depth === 0 && expectName && (t.kind === "word" || t.kind === "ident")) {
      out.push(t.text);
      expectName = false;
    }
  }
  return out;
}

/** Top-level comma-separated parts of a ( … ) body; BigQuery's STRUCT<…>/ARRAY<…> commas stay inside. */
function splitDefs(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  let angle = 0;
  tokens.forEach((t, k) => {
    if (isPunct(t, "(")) depth++;
    else if (isPunct(t, ")")) depth--;
    else if (isPunct(t, "<") && isWord(tokens[k - 1], "STRUCT", "ARRAY", "RANGE", "MAP")) angle++;
    else if (isPunct(t, "<") && angle > 0) angle++;
    else if (isPunct(t, ">") && angle > 0) angle--;
    else if (isPunct(t, ",") && depth === 0 && angle === 0) {
      out.push(cur);
      cur = [];
      return;
    }
    cur.push(t);
  });
  if (cur.length) out.push(cur);
  return out;
}

/** The words that end a column's type and start its constraints. */
const COLUMN_STOPS = new Set([
  "NOT", "NULL", "PRIMARY", "UNIQUE", "REFERENCES", "DEFAULT", "CHECK", "CONSTRAINT", "COLLATE", "GENERATED", "AS",
  "IDENTITY", "AUTO_INCREMENT", "AUTOINCREMENT", "COMMENT", "ON", "CHARSET", "ENCODE", "OPTIONS", "MASKING", "ROWGUIDCOL",
  "SPARSE", "FILESTREAM", "KEY", "STORED", "VIRTUAL", "PERSISTED", "TAG", "PROJECTION", "INVISIBLE", "VISIBLE", "SRID",
]);

/**
 * Tokens back to text as the source wrote them: `character varying(255)`,
 * `numeric(10,2)`, `public.order_status`, `ARRAY<STRING>`, `'new'::status`.
 */
function typeText(tokens: Token[]): string {
  let s = "";
  for (const t of tokens) {
    const text = t.kind === "string" ? `'${t.text.replace(/'/g, "''")}'` : t.kind === "ident" && /[^A-Za-z0-9_]/.test(t.text) ? `"${t.text}"` : t.text;
    const tight = t.kind === "punct" && /^[()\[\],<>.:]$/.test(t.text);
    const afterOpen = /[(\[<,.:]$/.test(s);
    s += !s || tight || afterOpen ? text : ` ${text}`;
  }
  return s;
}

/** Text of a string literal, or of BigQuery's OPTIONS(description = "…"). */
function optionsDescription(tokens: Token[] | null): string | undefined {
  if (!tokens) return undefined;
  for (let k = 0; k < tokens.length - 2; k++) {
    if (isWord(tokens[k], "DESCRIPTION") && isPunct(tokens[k + 1], "=") && (tokens[k + 2]!.kind === "string" || tokens[k + 2]!.kind === "ident")) {
      return tokens[k + 2]!.text;
    }
  }
  return undefined;
}

interface Building extends TableSpec {
  columns: ColumnSpec[];
  primaryKey?: string[];
  uniques: string[][];
  foreignKeys: ForeignKeySpec[];
}

/** A foreign key's REFERENCES … clause, from the reader positioned just after REFERENCES. */
function references(r: Reader, columns: string[], name?: string): ForeignKeySpec | null {
  const target = r.name();
  if (!target) return null;
  const refColumns = columnList(r.group());
  let onDelete: string | undefined;
  while (!r.done()) {
    if (r.take("ON", "DELETE")) {
      const words: string[] = [];
      while (isWord(r.peek(), "CASCADE", "RESTRICT", "NO", "ACTION", "SET", "NULL", "DEFAULT")) words.push(r.next()!.text.toLowerCase());
      onDelete = words.join(" ");
    } else if (r.take("ON", "UPDATE")) {
      while (isWord(r.peek(), "CASCADE", "RESTRICT", "NO", "ACTION", "SET", "NULL", "DEFAULT")) r.next();
    } else if (isWord(r.peek(), "MATCH", "DEFERRABLE", "INITIALLY", "NOT", "ENFORCED", "RELY", "NORELY", "VALIDATE", "NOVALIDATE", "ENABLE", "DISABLE", "IMMEDIATE", "DEFERRED", "FULL", "SIMPLE", "PARTIAL", "FOR", "REPLICATION")) {
      r.next();
    } else break;
  }
  return {
    columns,
    table: target.join("."),
    ...(refColumns.length ? { refColumns } : {}),
    ...(name ? { name } : {}),
    ...(onDelete ? { onDelete } : {}),
  };
}

/**
 * A table constraint (PRIMARY KEY, UNIQUE, FOREIGN KEY, with or without a
 * CONSTRAINT name) applied to `table`. False when the tokens are not one.
 */
function tableConstraint(tokens: Token[], table: Building): boolean {
  const r = new Reader(tokens);
  let name: string | undefined;
  if (r.take("CONSTRAINT")) name = r.name()?.join(".");
  if (r.take("PRIMARY", "KEY")) {
    r.take("CLUSTERED") || r.take("NONCLUSTERED");
    const cols = columnList(r.group());
    if (cols.length) table.primaryKey = cols;
    return true;
  }
  if (r.take("UNIQUE")) {
    r.take("KEY") || r.take("INDEX");
    r.take("CLUSTERED") || r.take("NONCLUSTERED");
    if (!isPunct(r.peek(), "(")) r.name(); // an index name
    const cols = columnList(r.group());
    if (cols.length) table.uniques.push(cols);
    return true;
  }
  if (r.take("FOREIGN", "KEY")) {
    if (!isPunct(r.peek(), "(")) r.name(); // MySQL: FOREIGN KEY fk_name (…)
    const cols = columnList(r.group());
    if (!r.take("REFERENCES")) return true;
    const fk = references(r, cols, name);
    if (fk && cols.length) table.foreignKeys.push(fk);
    return true;
  }
  // Recognised and deliberately ignored: checks, plain indexes, exclusions —
  // each told from a column that happens to be called `key` or `period` by
  // what follows it.
  if (name) return true;
  const next = r.peek(1);
  if (isWord(r.peek(), "CHECK")) return isPunct(next, "(");
  if (isWord(r.peek(), "PERIOD")) return isWord(next, "FOR");
  if (isWord(r.peek(), "EXCLUDE")) return isPunct(next, "(") || isWord(next, "USING");
  if (isWord(r.peek(), "LIKE")) return !!next && (next.kind === "word" || next.kind === "ident") && !isPunct(r.peek(2), "(");
  if (isWord(r.peek(), "FULLTEXT", "SPATIAL")) return true;
  if (isWord(r.peek(), "KEY", "INDEX")) {
    // KEY (a) or KEY name (a, b) — not `key varchar(10)`, whose ( … ) holds a length.
    const at = isPunct(next, "(") ? 1 : isPunct(r.peek(2), "(") ? 2 : -1;
    if (at < 0) return false;
    const probe = new Reader(tokens);
    probe.i = at;
    const inner = probe.group() ?? [];
    return !inner.every((t) => (t.kind === "word" && /^\d+$/.test(t.text)) || isPunct(t, ","));
  }
  return false;
}

/** One column definition. Null when the tokens are not a column. */
function columnDef(tokens: Token[], table: Building): ColumnSpec | null {
  const r = new Reader(tokens);
  const first = r.next();
  if (!first || (first.kind !== "word" && first.kind !== "ident")) return null;
  const col: ColumnSpec = { name: first.text };
  // The type: everything up to the first constraint word at depth 0.
  const type: Token[] = [];
  let angle = 0;
  while (!r.done()) {
    const t = r.peek()!;
    if (angle === 0 && t.kind === "word" && COLUMN_STOPS.has(t.text.toUpperCase())) {
      // WITH/WITHOUT TIME ZONE belongs to the type; CHARACTER SET does not.
      break;
    }
    if (angle === 0 && isWord(t, "WITH", "WITHOUT") && !isWord(r.peek(1), "TIME", "LOCAL")) break;
    if (isWord(t, "CHARACTER") && isWord(r.peek(1), "SET")) break;
    if (isPunct(t, "(")) {
      type.push(t);
      r.next();
      const inner = r.t.slice(r.i);
      let depth = 1;
      for (const x of inner) {
        r.next();
        type.push(x);
        if (isPunct(x, "(")) depth++;
        else if (isPunct(x, ")") && --depth === 0) break;
      }
      continue;
    }
    if (isPunct(t, "<")) angle++;
    if (isPunct(t, ">")) angle--;
    type.push(r.next()!);
  }
  if (type.length) col.type = typeText(type);

  let constraintName: string | undefined;
  while (!r.done()) {
    if (r.take("NOT", "NULL")) col.nullable = false;
    else if (r.take("NULL")) col.nullable = true;
    else if (r.take("PRIMARY", "KEY")) {
      table.primaryKey = [col.name];
      r.take("CLUSTERED") || r.take("NONCLUSTERED") || r.take("ASC") || r.take("DESC");
    } else if (r.take("UNIQUE")) {
      r.take("KEY");
      col.unique = true;
    } else if (r.take("REFERENCES")) {
      const fk = references(r, [col.name], constraintName);
      if (fk) table.foreignKeys.push(fk);
    } else if (r.take("CONSTRAINT")) constraintName = r.name()?.join(".");
    else if (r.take("DEFAULT")) {
      // An expression: a literal, a call, a parenthesised expression, a cast.
      const parts: Token[] = [];
      let depth = 0;
      while (!r.done()) {
        const t = r.peek()!;
        if (depth === 0 && t.kind === "word" && COLUMN_STOPS.has(t.text.toUpperCase()) && parts.length) break;
        if (isPunct(t, "(")) depth++;
        if (isPunct(t, ")")) depth--;
        parts.push(r.next()!);
      }
      col.default = typeText(parts);
    } else if (r.take("CHECK")) r.group();
    else if (r.take("COLLATE")) r.name();
    else if (r.take("GENERATED")) {
      // GENERATED ALWAYS AS (expr) [STORED] is computed; … AS IDENTITY is a key generator.
      r.take("ALWAYS") || r.take("BY", "DEFAULT");
      r.take("ON", "NULL");
      if (r.take("AS", "IDENTITY")) r.group();
      else if (r.take("AS")) {
        r.group();
        col.generated = true;
      }
    } else if (r.take("AS")) {
      r.group();
      col.generated = true;
    } else if (r.take("IDENTITY") || r.take("AUTO_INCREMENT") || r.take("AUTOINCREMENT")) {
      r.group();
      while (r.take("START") || r.take("INCREMENT") || r.take("ORDER") || r.take("NOORDER")) {
        r.take("WITH") || r.take("BY");
        if (r.peek()?.kind === "word" && /^\d+$/.test(r.peek()!.text)) r.next();
      }
    } else if (r.take("COMMENT")) {
      r.takePunct("=");
      const t = r.next();
      if (t && t.kind === "string") col.description = t.text;
    } else if (r.take("OPTIONS")) {
      const d = optionsDescription(r.group());
      if (d) col.description = d;
    } else if (r.take("ON", "UPDATE")) {
      r.next();
      r.group();
    } else if (r.take("CHARACTER", "SET") || r.take("CHARSET")) r.next();
    else if (r.take("WITH")) {
      // Snowflake: WITH MASKING POLICY p / WITH TAG (…).
      while (!r.done() && !isWord(r.peek(), "NOT", "NULL", "COMMENT", "DEFAULT", "PRIMARY", "UNIQUE", "REFERENCES")) r.next();
    } else {
      r.next();
      r.group();
    }
  }
  return col;
}

/** The table a statement names, created if the script only alters it — matched without regard to case. */
function lookup(tables: Map<string, Building>, parts: string[]): Building | undefined {
  const name = parts.at(-1)!.toLowerCase();
  const schema = parts.length > 1 ? parts.at(-2)!.toLowerCase() : undefined;
  if (schema !== undefined) return tables.get(`${schema}.${name}`) ?? tables.get(`.${name}`);
  const hits = [...tables.values()].filter((t) => t.name.toLowerCase() === name);
  return hits.length === 1 ? hits[0] : (hits.find((t) => !t.schema || /^(public|dbo|main)$/i.test(t.schema)) ?? hits[0]);
}

export interface ParsedDdl {
  tables: TableSpec[];
  warnings: SchemaImportWarning[];
  /** Statements read past, by kind ("SET", "CREATE SEQUENCE", "GRANT"…). */
  skipped: Record<string, number>;
}

/** Read the tables and keys a DDL script declares. */
export function parseSqlDdl(sql: string): ParsedDdl {
  const tables = new Map<string, Building>();
  const order: Building[] = [];
  const warnings: SchemaImportWarning[] = [];
  const skipped: Record<string, number> = {};
  const skip = (kind: string) => (skipped[kind] = (skipped[kind] ?? 0) + 1);
  let views = 0;
  /** A partition (PARTITION OF, ATTACH PARTITION, or an INHERITS child with no columns of its own) → its parent's name. */
  const partitionOf = new Map<Building, string[]>();
  /** An INHERITS child with columns of its own → its parent's name: it keeps its place, with the parent's columns first. */
  const inheritsFrom = new Map<Building, string[]>();

  const pre = withoutDelimiterBlocks(sql);
  for (const [kind, n] of Object.entries(pre.skipped)) skipped[kind] = (skipped[kind] ?? 0) + n;

  for (const stmt of statements(tokenize(pre.text))) {
    const r = new Reader(stmt);
    const line = stmt[0]!.line;
    const head = stmt.slice(0, 3).map((t) => t.text.toUpperCase());
    try {
      if (r.take("CREATE")) {
        r.take("OR", "REPLACE");
        let temporary = false;
        while (isWord(r.peek(), "GLOBAL", "LOCAL", "TEMP", "TEMPORARY", "TRANSIENT", "VOLATILE", "EXTERNAL", "UNLOGGED", "HYBRID", "ICEBERG", "DYNAMIC", "SNAPSHOT", "MULTISET", "SET")) {
          if (isWord(r.peek(), "TEMP", "TEMPORARY")) temporary = true;
          r.next();
        }
        if (r.take("TABLE")) {
          r.take("IF", "NOT", "EXISTS");
          const parts = r.name();
          if (!parts) {
            warnings.push({ line, message: "A CREATE TABLE without a readable name" });
            continue;
          }
          // A temporary table (or SQL Server's #table) lives for a session, not in the model.
          if (temporary || parts.at(-1)!.startsWith("#")) {
            skip("CREATE TEMPORARY TABLE");
            continue;
          }
          const table: Building = {
            name: parts.at(-1)!,
            ...(parts.length > 1 ? { schema: parts.at(-2)! } : {}),
            columns: [],
            uniques: [],
            foreignKeys: [],
          };
          // Postgres: CREATE TABLE child PARTITION OF parent FOR VALUES …
          if (r.take("PARTITION", "OF")) {
            const parent = r.name();
            if (parent) partitionOf.set(table, parent);
          }
          const body = r.group();
          if (!body && partitionOf.has(table)) {
            // Its columns are its parent's.
          } else if (!body) {
            const how = isWord(r.peek(), "AS") ? "is created from a query" : isWord(r.peek(), "LIKE") || isWord(r.peek(), "CLONE") ? "copies another table" : "has no column list";
            warnings.push({ line, message: `${parts.join(".")} ${how}; its columns are not in the script` });
          } else {
            for (const def of splitDefs(body)) {
              if (!def.length) continue;
              if (tableConstraint(def, table)) continue;
              const col = columnDef(def, table);
              if (col) table.columns.push(col);
            }
          }
          // Table options: COMMENT [=] '…', BigQuery OPTIONS(description = "…").
          while (!r.done()) {
            if (r.take("COMMENT")) {
              r.takePunct("=");
              const t = r.next();
              if (t?.kind === "string") table.description = t.text;
            } else if (r.take("OPTIONS")) {
              const d = optionsDescription(r.group());
              if (d) table.description = d;
            } else if (r.take("INHERITS")) {
              // Postgres inheritance: with no columns of its own, the child is a
              // partition (the pre-10 way of partitioning); with some, a subtype.
              const parent = columnList(r.group());
              if (parent.length) (table.columns.length ? inheritsFrom : partitionOf).set(table, parent[0]!.split("."));
            } else if (!r.group()) r.next();
          }
          const key = `${(table.schema ?? "").toLowerCase()}.${table.name.toLowerCase()}`;
          if (tables.has(key)) {
            warnings.push({ line, message: `${parts.join(".")} is created twice; the later definition wins` });
            order.splice(order.indexOf(tables.get(key)!), 1);
          }
          tables.set(key, table);
          order.push(table);
          continue;
        }
        if (r.take("UNIQUE")) {
          r.take("CLUSTERED") || r.take("NONCLUSTERED");
          if (r.take("INDEX")) {
            r.take("CONCURRENTLY");
            r.take("IF", "NOT", "EXISTS");
            if (!isWord(r.peek(), "ON")) r.name();
            if (r.take("ON")) {
              r.take("ONLY");
              const parts = r.name();
              while (!r.done() && !isPunct(r.peek(), "(")) r.next(); // USING btree
              const cols = columnList(r.group());
              const table = parts ? lookup(tables, parts) : undefined;
              if (table && cols.length) table.uniques.push(cols);
            }
            continue;
          }
        }
        if (isWord(r.peek(), "VIEW") || (isWord(r.peek(), "MATERIALIZED") && isWord(r.peek(1), "VIEW")) || (isWord(r.peek(), "SECURE") && isWord(r.peek(1), "VIEW"))) {
          views++;
          continue;
        }
        const what = r.peek();
        skip(`CREATE ${what && what.kind === "word" ? what.text.toUpperCase() : "…"}`);
        continue;
      }
      if (r.take("ALTER", "TABLE")) {
        r.take("ONLY");
        r.take("IF", "EXISTS");
        r.take("ONLY");
        const parts = r.name();
        const table = parts ? lookup(tables, parts) : undefined;
        if (!parts) {
          skip("ALTER TABLE");
          continue;
        }
        let read = false;
        // One or more actions: ADD [CONSTRAINT n] PRIMARY KEY … , ADD … — SQL
        // Server lets one ADD carry several constraints, comma-separated.
        let adding = false;
        for (const action of splitDefs(stmt.slice(r.i))) {
          const a = new Reader(action);
          a.take("WITH", "CHECK") || a.take("WITH", "NOCHECK");
          if (a.take("ATTACH", "PARTITION")) {
            const child = a.name();
            const childTable = child ? lookup(tables, child) : undefined;
            if (childTable && table) {
              partitionOf.set(childTable, parts);
              read = true;
            }
            adding = false;
            continue;
          }
          if (a.take("ADD")) adding = true;
          else if (!adding || !isWord(a.peek(), "CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK")) {
            adding = false;
            continue;
          }
          const rest = action.slice(a.i);
          if (!isWord(rest[0], "CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN")) {
            // ADD [COLUMN] name type …
            const def = isWord(rest[0], "COLUMN") ? rest.slice(1) : rest;
            const named = def[0] && (def[0].kind === "word" || def[0].kind === "ident") && !isWord(def[0], "IF", "INDEX", "KEY", "CHECK", "PARTITION");
            if (table && named) {
              const d = isWord(def[0], "IF") ? def.slice(3) : def;
              const col = columnDef(d, table);
              if (col && !table.columns.some((c) => c.name.toLowerCase() === col.name.toLowerCase())) {
                table.columns.push(col);
                read = true;
              }
            }
            continue;
          }
          if (!table) {
            warnings.push({ line, message: `ALTER TABLE ${parts.join(".")} adds a key to a table the script doesn't create` });
            read = true;
            break;
          }
          if (tableConstraint(rest, table)) read = true;
        }
        if (!read) skip("ALTER TABLE");
        continue;
      }
      if (r.take("COMMENT", "ON")) {
        const what = r.next()?.text.toUpperCase();
        const parts = r.name();
        if (!parts || !r.take("IS")) {
          skip("COMMENT");
          continue;
        }
        const text = r.next();
        if (!text || text.kind !== "string") continue;
        if (what === "TABLE") {
          const table = lookup(tables, parts);
          if (table) table.description = text.text;
        } else if (what === "COLUMN" && parts.length > 1) {
          const table = lookup(tables, parts.slice(0, -1));
          const col = table?.columns.find((c) => c.name.toLowerCase() === parts.at(-1)!.toLowerCase());
          if (col) col.description = text.text;
        } else skip("COMMENT");
        continue;
      }
      if (stmt.slice(0, 4).some((t) => /^sp_addextendedproperty$/i.test(t.text))) {
        // EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'…', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'Orders'[, @level2type=N'COLUMN', @level2name=N'Id']
        // Arguments by name (@name = N'…') or by position; a value may be a
        // string (N'Person'), a bracketed name ([Person]) or NULL.
        const at = stmt.findIndex((t) => /^sp_addextendedproperty$/i.test(t.text));
        const args = new Map<string, string>();
        const values: Array<string | undefined> = [];
        for (const arg of splitDefs(stmt.slice(at + 1))) {
          let k = 0;
          let name: string | undefined;
          if (arg[0]?.kind === "word" && arg[0].text.startsWith("@") && isPunct(arg[1], "=")) {
            name = arg[0].text.toLowerCase();
            k = 2;
          }
          if (isWord(arg[k], "N") && arg[k + 1]?.kind === "string") k++;
          const v = arg[k];
          const value = v && (v.kind === "string" || v.kind === "ident" || (v.kind === "word" && !isWord(v, "NULL"))) ? v.text : undefined;
          if (name) {
            if (value !== undefined) args.set(name, value);
          } else values.push(value);
        }
        const get = (name: string, pos: number) => args.get(name) ?? values[pos];
        if (get("@name", 0) === "MS_Description") {
          const value = get("@value", 1);
          const schema = get("@level0name", 3);
          const tableName = get("@level1name", 5);
          const column = get("@level2type", 6)?.toUpperCase() === "COLUMN" ? get("@level2name", 7) : undefined;
          const table = tableName ? lookup(tables, schema ? [schema, tableName] : [tableName]) : undefined;
          if (table && value !== undefined) {
            if (column) {
              const col = table.columns.find((c) => c.name.toLowerCase() === column.toLowerCase());
              if (col) col.description = value;
            } else table.description = value;
          }
        }
        continue;
      }
      skip(head[0] === "CREATE" || head[0] === "ALTER" || head[0] === "DROP" ? head.slice(0, 2).join(" ") : (head[0] ?? "…"));
    } catch (err) {
      warnings.push({ line, message: `Could not read this statement: ${(err as Error).message}` });
    }
  }
  // A partition holds some of its parent's rows: folded into the parent, it
  // gives up its own place, and keys declared only on partitions (as pg_dump
  // writes them for a partitioned table) become the parent's.
  const keyOf = (t: Building) => `${(t.schema ?? "").toLowerCase()}.${t.name.toLowerCase()}`;
  const sameCols = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((c, i) => c.toLowerCase() === b[i]!.toLowerCase());
  const folded = new Map<Building, number>();
  for (const [child, parentName] of partitionOf) {
    const parent = lookup(tables, parentName);
    if (!parent || parent === child || !tables.has(keyOf(child))) continue;
    for (const fk of child.foreignKeys) {
      if (parent.foreignKeys.some((f) => sameCols(f.columns, fk.columns) && f.table.toLowerCase() === fk.table.toLowerCase())) continue;
      const { name: _name, ...rest } = fk;
      parent.foreignKeys.push(rest);
    }
    if (!parent.primaryKey && child.primaryKey) parent.primaryKey = child.primaryKey;
    if (!parent.columns.length) parent.columns = child.columns;
    order.splice(order.indexOf(child), 1);
    tables.delete(keyOf(child));
    folded.set(parent, (folded.get(parent) ?? 0) + 1);
  }
  for (const [parent, n] of folded) warnings.push({ message: `${n} partition${n === 1 ? "" : "s"} of ${parent.name} folded into it` });
  // A subtype by inheritance starts with its parent's columns.
  for (const [child, parentName] of inheritsFrom) {
    const parent = lookup(tables, parentName);
    if (!parent || parent === child) continue;
    const own = new Set(child.columns.map((c) => c.name.toLowerCase()));
    child.columns = [...parent.columns.filter((c) => !own.has(c.name.toLowerCase())).map((c) => ({ ...c })), ...child.columns];
  }
  if (views) warnings.push({ message: `${views} view${views === 1 ? "" : "s"} skipped — a view has no columns of its own in the script` });
  return {
    tables: order.map(({ uniques, foreignKeys, ...t }) => ({ ...t, ...(uniques.length ? { uniques } : {}), ...(foreignKeys.length ? { foreignKeys } : {}) })),
    warnings,
    skipped,
  };
}

/** Whether text reads as a DDL script: it creates or alters a table somewhere. */
export function looksLikeSqlDdl(text: string): boolean {
  const head = text.trimStart();
  if (head.startsWith("{") || head.startsWith("[")) return false;
  // A table name followed by its column list, or a key added to a table —
  // not prose that happens to say "create a table for users".
  return (
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:[A-Za-z_]+\s+){0,3}TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[^\s(]+\s*\(/i.test(text) ||
    /\bALTER\s+TABLE\s+(?:ONLY\s+)?[^\s(]+\s+(?:WITH\s+\w+\s+)?ADD\b/i.test(text)
  );
}

/** A DDL script as an editable, unplaced document — see `parseSqlDdl` and `buildTableModel`. */
export function importSqlDdl(sql: string, opts: TableModelOptions = {}): SchemaImport {
  const parsed = parseSqlDdl(sql);
  const built = buildTableModel(parsed.tables, opts);
  const skippedCount = Object.values(parsed.skipped).reduce((a, b) => a + b, 0);
  return {
    template: built.template,
    warnings: [...parsed.warnings, ...built.warnings],
    stats: { ...built.stats, skipped: skippedCount },
  };
}
