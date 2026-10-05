/**
 * dictionary.ts — the model as a document, and the governance numbers a
 * review asks for.
 *
 * `dataDictionary` is every table with its fields, drawn or not, as a
 * reviewer reads them: name, label, type, key, required, references, tags,
 * description — with the table's description, owner (`team`), status and row
 * count. Markdown and CSV renderings are here too, so the editor's export
 * and the HTML page's download produce the same file.
 *
 * `governanceReport` says how much of the model is documented, who owns
 * what, which columns are sensitive (by tag: `pii`, `pii:<category>`,
 * `sensitive`, `confidential`), and which tables can reach a sensitive
 * column within a few key hops — the question an access review starts with.
 * Tables whose field list the importer cut short are listed as incomplete,
 * because every number here is "at least" for them.
 *
 * Zero dependencies, like every contract module.
 */
import { documentFieldRecords, edgeFieldIds, tableProfile, type FieldDocument, type FieldRecord, type FieldRef } from "./fields";
import { storesFields } from "./coverage";
import { csvText } from "./csv";
import { sensitiveLineage, type LineageLink } from "./lineage";
import { DEFAULT_SENSITIVE_TAG_PATTERN, sensitivityHints, type SensitivityHint } from "./sensitivity";

type DocNode = FieldDocument["nodes"][number] & { description?: string; team?: string; status?: string };

export interface DictionaryTable {
  nodeId: string;
  /** The entity name when the import recorded one, else the label. */
  name: string;
  label: string;
  description?: string;
  owner?: string;
  status?: string;
  recordCount?: number;
  /** The importer kept only the first fields. */
  truncated: boolean;
  /** When the table was profiled, and when its data last changed (from its profile). */
  profiledAt?: string;
  lastModified?: string;
  fields: FieldRecord[];
}

const modelOf = (n: DocNode): Record<string, unknown> => {
  const m = n.data?.model;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
};

export function dataDictionary(doc: FieldDocument, opts: { isTable?: (node: FieldDocument["nodes"][number]) => boolean } = {}): DictionaryTable[] {
  const records = documentFieldRecords(doc);
  return (doc.nodes as readonly DocNode[]).filter(opts.isTable ?? storesFields).map((n) => {
    const m = modelOf(n);
    const profile = tableProfile(n);
    return {
      nodeId: n.id,
      name: typeof m.name === "string" && m.name ? m.name : (n.label ?? n.id),
      label: n.label ?? n.id,
      ...(n.description ? { description: n.description } : {}),
      ...(n.team ? { owner: n.team } : {}),
      ...(n.status ? { status: n.status } : {}),
      ...(typeof m.recordCount === "number" ? { recordCount: m.recordCount } : profile?.rowCount !== undefined ? { recordCount: profile.rowCount } : {}),
      truncated: m.fieldsTruncated === true,
      ...(profile?.profiledAt ? { profiledAt: profile.profiledAt } : {}),
      ...(profile?.lastModified ? { lastModified: profile.lastModified } : {}),
      fields: records.get(n.id) ?? [],
    };
  });
}

const refText = (f: FieldRecord) => f.fk.map((t) => t.label).join(" | ");
/** Whether any field was profiled — the dictionaries add its numbers only then. */
const profiled = (tables: readonly DictionaryTable[]) => tables.some((t) => t.fields.some((f) => f.profile));
const nullsText = (f: FieldRecord) => {
  const r = f.profile?.nullRate;
  return r === undefined ? "" : r === 0 ? "0%" : r < 0.001 ? "<0.1%" : `${Math.round(r * 1000) / 10}%`;
};
const distinctText = (f: FieldRecord) => (f.profile?.distinct !== undefined ? f.profile.distinct.toLocaleString("en-US") : "");

/** One Markdown section per table: what it is, then a table of its fields. */
export function dictionaryMarkdown(tables: readonly DictionaryTable[], title = "Data dictionary"): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const out = [`# ${title}`, "", `${tables.length} table${tables.length === 1 ? "" : "s"}.`, ""];
  const withStats = profiled(tables);
  for (const t of tables) {
    out.push(`## ${esc(t.label)}${t.name !== t.label ? ` (\`${esc(t.name)}\`)` : ""}`, "");
    if (t.description) out.push(esc(t.description), "");
    const facts = [
      t.owner ? `Owner: ${esc(t.owner)}` : "",
      t.status ? `Status: ${esc(t.status)}` : "",
      t.recordCount !== undefined ? `Rows: ${t.recordCount.toLocaleString("en-US")}` : "",
      t.lastModified ? `Last changed: ${t.lastModified.slice(0, 10)}` : "",
      t.profiledAt ? `Profiled: ${t.profiledAt.slice(0, 10)}` : "",
      t.truncated ? "Only the first fields are listed." : "",
    ].filter(Boolean);
    if (facts.length) out.push(facts.join(" · "), "");
    if (!t.fields.length) {
      out.push("_No fields._", "");
      continue;
    }
    const stats = withStats;
    out.push(
      `| Field | Label | Type | Key | Required | References | Tags | Description |${stats ? " Nulls | Distinct |" : ""}`,
      `| --- | --- | --- | --- | --- | --- | --- | --- |${stats ? " --- | --- |" : ""}`,
    );
    for (const f of t.fields) {
      out.push(
        `| ${esc(f.name)} | ${esc(f.label ?? "")} | ${esc(f.storageType ?? f.type ?? "")} | ${f.key ? f.key.toUpperCase() : ""} | ${f.required ? "yes" : ""} | ${esc(refText(f))} | ${esc((f.tags ?? []).join(", "))} | ${esc(f.description ?? "")} |` +
          (stats ? ` ${nullsText(f)} | ${distinctText(f)} |` : ""),
      );
    }
    out.push("");
  }
  return out.join("\n");
}

/** One CSV row per field, the table's facts repeated on each. */
export function dictionaryCsv(tables: readonly DictionaryTable[]): string {
  const stats = profiled(tables);
  return csvText(
    ["Table", "Table name", "Owner", "Field", "Label", "Type", "Key", "Required", "References", "Tags", "Description", ...(stats ? ["Nulls", "Distinct"] : [])],
    tables.flatMap((t) =>
      t.fields.map((f) => [
        t.label,
        t.name,
        t.owner ?? "",
        f.name,
        f.label ?? "",
        f.storageType ?? f.type ?? "",
        f.key ? f.key.toUpperCase() : "",
        f.required ? "yes" : "",
        refText(f),
        (f.tags ?? []).join(", "),
        f.description ?? "",
        ...(stats ? [nullsText(f), distinctText(f)] : []),
      ]),
    ),
  );
}

export interface GovernanceReport {
  documentation: {
    tables: number;
    tablesDescribed: number;
    fields: number;
    fieldsDescribed: number;
    fieldsLabelled: number;
  };
  ownership: { tablesOwned: number; byOwner: Array<{ owner: string; tables: string[] }>; unowned: string[] };
  /** Columns carrying a sensitive tag, by tag. */
  sensitivity: Array<{ tag: string; fields: FieldRef[] }>;
  /** Tables within `exposureDepth` key hops of a sensitive column, nearest first, with the column it is nearest to. */
  exposure: Array<{ nodeId: string; hops: number; nearest: FieldRef }>;
  /** Tables whose field list was cut short: every number is "at least" for them. */
  incomplete: string[];
  /** Columns a sensitive column's values flow into (column lineage) that carry no sensitive tag. */
  untaggedFlows: Array<{ ref: FieldRef; source: FieldRef; hops: number }>;
  /** Untagged columns whose names look personal — an email, a phone number — with the tag to give each. */
  suggested: SensitivityHint[];
}

export const DEFAULT_SENSITIVE_TAG = DEFAULT_SENSITIVE_TAG_PATTERN;

export function governanceReport(
  doc: FieldDocument & { lineage?: readonly LineageLink[] },
  opts: { sensitiveTag?: RegExp; exposureDepth?: number; isTable?: (node: FieldDocument["nodes"][number]) => boolean } = {},
): GovernanceReport {
  const tables = dataDictionary(doc, opts.isTable ? { isTable: opts.isTable } : {});
  const sensitiveTag = opts.sensitiveTag ?? DEFAULT_SENSITIVE_TAG;
  const depth = opts.exposureDepth ?? 2;

  let fields = 0;
  let fieldsDescribed = 0;
  let fieldsLabelled = 0;
  const byTag = new Map<string, FieldRef[]>();
  for (const t of tables) {
    for (const f of t.fields) {
      fields++;
      if (f.description) fieldsDescribed++;
      if (f.label) fieldsLabelled++;
      for (const tag of f.tags ?? []) {
        if (!sensitiveTag.test(tag)) continue;
        const list = byTag.get(tag.toLowerCase());
        const ref = { nodeId: t.nodeId, fieldId: f.id };
        if (list) list.push(ref);
        else byTag.set(tag.toLowerCase(), [ref]);
      }
    }
  }
  const owners = new Map<string, string[]>();
  for (const t of tables) if (t.owner) (owners.get(t.owner) ?? owners.set(t.owner, []).get(t.owner)!).push(t.nodeId);

  // Exposure: a breadth-first search from every sensitive column's table at
  // once, over key edges either way, remembering which column each table is
  // nearest to.
  const tableIds = new Set(tables.map((t) => t.nodeId));
  const adj = new Map<string, string[]>();
  for (const e of doc.edges) {
    if (edgeFieldIds(e).start === undefined || e.source === e.target) continue;
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
    (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source);
  }
  const reached = new Map<string, { hops: number; nearest: FieldRef }>();
  const queue: string[] = [];
  for (const refs of byTag.values()) {
    for (const ref of refs) {
      if (reached.has(ref.nodeId)) continue;
      reached.set(ref.nodeId, { hops: 0, nearest: ref });
      queue.push(ref.nodeId);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    const here = reached.get(at)!;
    if (here.hops >= depth) continue;
    for (const to of adj.get(at) ?? []) {
      if (reached.has(to)) continue;
      reached.set(to, { hops: here.hops + 1, nearest: here.nearest });
      queue.push(to);
    }
  }
  const exposure = [...reached.entries()]
    .filter(([id, r]) => r.hops > 0 && tableIds.has(id))
    .map(([nodeId, r]) => ({ nodeId, hops: r.hops, nearest: r.nearest }))
    .sort((a, b) => a.hops - b.hops);

  return {
    documentation: {
      tables: tables.length,
      tablesDescribed: tables.filter((t) => !!t.description).length,
      fields,
      fieldsDescribed,
      fieldsLabelled,
    },
    ownership: {
      tablesOwned: tables.filter((t) => !!t.owner).length,
      byOwner: [...owners.entries()].map(([owner, ids]) => ({ owner, tables: ids })).sort((a, b) => b.tables.length - a.tables.length),
      unowned: tables.filter((t) => !t.owner).map((t) => t.nodeId),
    },
    sensitivity: [...byTag.entries()].map(([tag, list]) => ({ tag, fields: list })).sort((a, b) => b.fields.length - a.fields.length),
    exposure,
    incomplete: tables.filter((t) => t.truncated).map((t) => t.nodeId),
    untaggedFlows: sensitiveLineage(doc, { sensitiveTag }),
    suggested: sensitivityHints(doc, { sensitiveTag, ...(opts.isTable ? { isTable: opts.isTable } : {}) }),
  };
}
