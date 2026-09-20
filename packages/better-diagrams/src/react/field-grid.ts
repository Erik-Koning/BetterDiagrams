/**
 * field-grid.ts — the field grid's pure half: columns, filtering, sorting,
 * and the two text exports. No DOM, so it is tested without one.
 */
import type { FieldRecord } from "../contract/fields";

export type GridColumn =
  | "key"
  | "name"
  | "label"
  | "type"
  | "required"
  | "fk"
  | "visible"
  | "externalId"
  | "unique"
  | "formula";

export interface GridColumnDef {
  id: GridColumn;
  title: string;
  /** Initial width in px; the reader may drag it. */
  width: number;
  align?: "center";
  /** Monospace: names, types, formulas. */
  mono?: boolean;
}

export const GRID_COLUMNS: readonly GridColumnDef[] = [
  { id: "key", title: "Key", width: 56, align: "center" },
  { id: "name", title: "Name", width: 200, mono: true },
  { id: "label", title: "Label", width: 180 },
  { id: "type", title: "Type", width: 150, mono: true },
  { id: "required", title: "Req.", width: 56, align: "center" },
  { id: "fk", title: "References", width: 200 },
  { id: "visible", title: "Visible", width: 64, align: "center" },
  { id: "externalId", title: "Ext. id", width: 64, align: "center" },
  { id: "unique", title: "Unique", width: 64, align: "center" },
  { id: "formula", title: "Formula", width: 260, mono: true },
];

export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 600;

const CHECK = "✓";

/** What a cell says, as text — the same text the exports write. */
export function cellText(record: FieldRecord, col: GridColumn): string {
  switch (col) {
    case "key":
      return record.key ? record.key.toUpperCase() : "";
    case "name":
      return record.name;
    case "label":
      return record.label ?? "";
    case "type":
      return record.type ?? "";
    case "required":
      return record.required ? CHECK : "";
    case "fk":
      return record.fk.length ? `→ ${record.fk.map((t) => t.label).join(" | ")}` : "";
    case "visible":
      return record.visible === false ? "hidden" : record.visible === true ? CHECK : "";
    case "externalId":
      return record.externalId ? CHECK : "";
    case "unique":
      return record.unique ? CHECK : "";
    case "formula":
      return record.formula ?? "";
  }
}

/** Records whose name, label, type, formula or reference targets contain the query. */
export function filterRecords(records: readonly FieldRecord[], query: string): FieldRecord[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...records];
  return records.filter((r) =>
    [r.name, r.label ?? "", r.type ?? "", r.formula ?? "", ...r.fk.map((t) => t.label)]
      .join("\u0000")
      .toLowerCase()
      .includes(q),
  );
}

/** A column's sort key: booleans as 1/0 (so "true first" is a descending number), text lowercased. */
function sortKey(record: FieldRecord, col: GridColumn): number | string {
  switch (col) {
    case "required":
      return record.required ? 1 : 0;
    case "externalId":
      return record.externalId ? 1 : 0;
    case "unique":
      return record.unique ? 1 : 0;
    case "visible":
      return record.visible === true ? 2 : record.visible === false ? 0 : 1;
    case "key":
      // Ranks, larger first: pk, then pfk, then fk, then none.
      return record.key ? { pk: 3, pfk: 2, fk: 1 }[record.key] : 0;
    case "fk":
      return (record.fk[0]?.label ?? "").toLowerCase();
    default:
      return cellText(record, col).toLowerCase();
  }
}

/**
 * Stable sort by one column. Ascending puts empty text last and booleans
 * true-first — the order a reader asks for ("show me the required ones");
 * descending inverts the comparison while ties keep document order, the way
 * a spreadsheet sorts.
 */
export function sortRecords(
  records: readonly FieldRecord[],
  col: GridColumn,
  dir: "asc" | "desc",
): FieldRecord[] {
  const keyed = records.map((record, index) => ({ record, index, key: sortKey(record, col) }));
  const compare = (a: (typeof keyed)[number], b: (typeof keyed)[number]): number => {
    if (typeof a.key === "number" && typeof b.key === "number") return b.key - a.key; // true / pk first
    const ka = String(a.key);
    const kb = String(b.key);
    if (ka === kb) return 0;
    if (!ka) return 1; // empty text last
    if (!kb) return -1;
    return ka < kb ? -1 : 1;
  };
  keyed.sort((a, b) => {
    const c = compare(a, b);
    if (c !== 0) return dir === "asc" ? c : -c;
    return a.index - b.index;
  });
  return keyed.map((k) => k.record);
}

const escapeCsv = (text: string): string =>
  /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;

/** Header + rows, RFC 4180 quoting, CRLF line ends. */
export function toCsv(records: readonly FieldRecord[], cols: readonly GridColumnDef[] = GRID_COLUMNS): string {
  const lines = [cols.map((c) => escapeCsv(c.title)).join(",")];
  for (const r of records) lines.push(cols.map((c) => escapeCsv(cellText(r, c.id))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** Header + rows, tab-separated — what a spreadsheet pastes as a table. Tabs and newlines inside a cell become spaces. */
export function toTsv(records: readonly FieldRecord[], cols: readonly GridColumnDef[] = GRID_COLUMNS): string {
  const clean = (text: string) => text.replace(/[\t\r\n]+/g, " ");
  const lines = [cols.map((c) => clean(c.title)).join("\t")];
  for (const r of records) lines.push(cols.map((c) => clean(cellText(r, c.id))).join("\t"));
  return `${lines.join("\n")}\n`;
}

/** A filename-safe slug of a node's label. */
export function fileSlug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "node"
  );
}
