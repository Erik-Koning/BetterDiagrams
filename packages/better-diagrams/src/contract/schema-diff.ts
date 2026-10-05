/**
 * schema-diff.ts — what changed between two versions of a data model, at
 * the level a migration review reads it: tables and columns, and whether
 * each change breaks the readers and writers of the schema.
 *
 * `diff.ts` matches elements by id and says a table's `fields` changed; this
 * says WHICH columns: added, removed, changed (type, nullability, key,
 * uniqueness, what it references, its words) or renamed — a rename being
 * inferred, never certain, so it carries a confidence. Each change is
 * `breaking` (removing or retyping a column, changing a key or what a
 * reference points at), `caution` (a column becoming required, or nullable;
 * a required column added — defaults are not modelled) or `safe`.
 *
 * Tables match by node id, then by their data-model entity name; columns by
 * id, then by name, ignoring case. Types compare by family (type-families.ts)
 * with length narrowing caught separately.
 *
 * Zero dependencies, like every contract module.
 */
import { documentFieldRecords, keyReferences, type FieldDocument, type FieldRecord, type KeyLink } from "./fields";
import { storesFields } from "./coverage";
import type { FieldKey } from "./schema";
import { DEFAULT_TYPE_ALIASES, normalizeType } from "./type-families";

export type ChangeImpact = "breaking" | "caution" | "safe";

export interface FieldSnapshot {
  name: string;
  storageType?: string;
  nullable?: boolean;
  key?: FieldKey;
  unique?: boolean;
  /** The tables it references, by node id (or name when outside the model). */
  references: string[];
}

export type ColumnAspect = "type" | "nullable" | "key" | "unique" | "references" | "label" | "formula" | "description";

export interface ColumnChange {
  kind: "added" | "removed" | "changed" | "renamed";
  /** The table in `next` (in `base` for a removed table's columns). */
  nodeId: string;
  /** The column in `next` (in `base` for a removed column). */
  fieldId: string;
  from?: FieldSnapshot;
  to?: FieldSnapshot;
  changes?: ColumnAspect[];
  impact: ChangeImpact;
  /** One line a reviewer reads: "type varchar(255) → integer", "now required". */
  reason: string;
  /** For an inferred rename: how sure, 0..1. */
  confidence?: number;
}

export interface SchemaDiff {
  tables: {
    added: string[];
    removed: string[];
    renamed: Array<{ from: string; to: string; confidence: number }>;
  };
  columns: ColumnChange[];
  references: { added: KeyLink[]; removed: KeyLink[] };
  summary: Record<ChangeImpact, number>;
}

export interface SchemaDiffOptions {
  typeAliases?: Readonly<Record<string, string>>;
  /** How alike two column names must be (0..1) before a removed + added pair reads as a rename. Default 0.6. */
  renameThreshold?: number;
}

type DocNode = FieldDocument["nodes"][number];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const entityName = (n: DocNode): string | undefined => {
  const m = n.data?.model;
  const name = m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>).name : undefined;
  return typeof name === "string" && name ? name.toLowerCase() : undefined;
};

/** Levenshtein similarity, 0..1, on squashed names. */
function similarity(a: string, b: string): number {
  const x = squash(a);
  const y = squash(b);
  if (x === y) return 1;
  if (!x.length || !y.length) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length]! / Math.max(x.length, y.length);
}

/**
 * Whether a column may be empty: what the source said, else — for a drawn
 * row, whose only word on it is `required` — the absence of that mark. A
 * primary key never may.
 */
const nullableOf = (r: FieldRecord): boolean | undefined =>
  r.key === "pk" || r.key === "pfk" ? false : r.nullable !== undefined ? r.nullable : r.row ? !r.required : undefined;

const snapshot = (r: FieldRecord): FieldSnapshot => ({
  name: r.name,
  ...(r.storageType !== undefined ? { storageType: r.storageType } : {}),
  ...(nullableOf(r) !== undefined ? { nullable: nullableOf(r) } : {}),
  ...(r.key ? { key: r.key } : {}),
  ...(r.unique ? { unique: true } : {}),
  references: r.fk.map((t) => t.nodeId ?? t.label).sort(),
});

/** The length a type allows, when it states one ("varchar(255)" → 255). */
const lengthOf = (params: string | undefined) => {
  const n = Number(params?.split(",")[0]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function schemaDiff(base: FieldDocument, next: FieldDocument, opts: SchemaDiffOptions = {}): SchemaDiff {
  const aliases = opts.typeAliases ?? DEFAULT_TYPE_ALIASES;
  const threshold = opts.renameThreshold ?? 0.6;
  const baseTables = base.nodes.filter(storesFields);
  const nextTables = next.nodes.filter(storesFields);
  const baseRecords = documentFieldRecords(base);
  const nextRecords = documentFieldRecords(next);

  // ── Tables ──
  const pairs: Array<[DocNode, DocNode]> = [];
  const matchedBase = new Set<string>();
  const matchedNext = new Set<string>();
  const nextById = new Map(nextTables.map((n) => [n.id, n]));
  const nextByName = new Map(nextTables.flatMap((n) => (entityName(n) ? [[entityName(n)!, n] as const] : [])));
  for (const b of baseTables) {
    const n = nextById.get(b.id) ?? (entityName(b) ? nextByName.get(entityName(b)!) : undefined);
    if (!n || matchedNext.has(n.id)) continue;
    pairs.push([b, n]);
    matchedBase.add(b.id);
    matchedNext.add(n.id);
  }
  // A removed and an added table sharing most of their columns: a rename.
  const renamedTables: SchemaDiff["tables"]["renamed"] = [];
  const columnSet = (records: FieldRecord[] | undefined) => new Set((records ?? []).map((r) => squash(r.name)));
  for (const b of baseTables) {
    if (matchedBase.has(b.id)) continue;
    const mine = columnSet(baseRecords.get(b.id));
    let best: { n: DocNode; score: number } | null = null;
    for (const n of nextTables) {
      if (matchedNext.has(n.id)) continue;
      const theirs = columnSet(nextRecords.get(n.id));
      const union = new Set([...mine, ...theirs]).size;
      const shared = [...mine].filter((c) => theirs.has(c)).length;
      // Two tables with little but an id in common are not one table renamed.
      const score = union && shared >= 3 ? shared / union : 0;
      if (score >= 0.8 && (!best || score > best.score)) best = { n, score };
    }
    if (best) {
      pairs.push([b, best.n]);
      matchedBase.add(b.id);
      matchedNext.add(best.n.id);
      renamedTables.push({ from: b.id, to: best.n.id, confidence: Math.round(best.score * 100) / 100 });
    }
  }
  const removedTables = baseTables.filter((n) => !matchedBase.has(n.id)).map((n) => n.id);
  const addedTables = nextTables.filter((n) => !matchedNext.has(n.id)).map((n) => n.id);

  // ── Columns ──
  const columns: ColumnChange[] = [];
  for (const id of removedTables) {
    for (const r of baseRecords.get(id) ?? []) {
      columns.push({ kind: "removed", nodeId: id, fieldId: r.id, from: snapshot(r), impact: "breaking", reason: "table removed" });
    }
  }
  for (const [b, n] of pairs) {
    const before = baseRecords.get(b.id) ?? [];
    const after = nextRecords.get(n.id) ?? [];
    const afterById = new Map(after.map((r) => [r.id, r]));
    const afterByName = new Map(after.map((r) => [r.name.toLowerCase(), r]));
    const used = new Set<string>();
    const unmatched: FieldRecord[] = [];
    for (const r of before) {
      const m = afterById.get(r.id) ?? afterByName.get(r.name.toLowerCase());
      if (!m || used.has(m.id)) {
        unmatched.push(r);
        continue;
      }
      used.add(m.id);
      const change = compare(r, m);
      if (change) columns.push({ nodeId: n.id, fieldId: m.id, from: snapshot(r), to: snapshot(m), ...change });
    }
    const added = after.filter((r) => !used.has(r.id));
    // Renames: a removed column and an added one alike in type, key and
    // nullability, with names close enough — best pairs first.
    const candidates: Array<{ r: FieldRecord; m: FieldRecord; score: number }> = [];
    for (const r of unmatched) {
      for (const m of added) {
        if (normalizeType(r.storageType, aliases).family !== normalizeType(m.storageType, aliases).family) continue;
        if ((r.key ?? "") !== (m.key ?? "") || nullableOf(r) !== nullableOf(m)) continue;
        const score = similarity(r.name, m.name);
        if (score >= threshold) candidates.push({ r, m, score });
      }
    }
    candidates.sort((x, y) => y.score - x.score);
    const renamedFrom = new Set<string>();
    const renamedTo = new Set<string>();
    for (const c of candidates) {
      if (renamedFrom.has(c.r.id) || renamedTo.has(c.m.id)) continue;
      renamedFrom.add(c.r.id);
      renamedTo.add(c.m.id);
      columns.push({
        kind: "renamed",
        nodeId: n.id,
        fieldId: c.m.id,
        from: snapshot(c.r),
        to: snapshot(c.m),
        impact: "caution",
        reason: `possibly renamed from ${c.r.name}`,
        confidence: Math.round(c.score * 100) / 100,
      });
    }
    for (const r of unmatched) {
      if (renamedFrom.has(r.id)) continue;
      columns.push({ kind: "removed", nodeId: n.id, fieldId: r.id, from: snapshot(r), impact: "breaking", reason: "removed" });
    }
    for (const m of added) {
      if (renamedTo.has(m.id)) continue;
      const required = nullableOf(m) === false && m.key !== "pk" && m.key !== "pfk";
      columns.push({
        kind: "added",
        nodeId: n.id,
        fieldId: m.id,
        to: snapshot(m),
        impact: required ? "caution" : "safe",
        reason: required ? "added, required — existing rows need a value" : "added",
      });
    }
  }
  for (const id of addedTables) {
    for (const r of nextRecords.get(id) ?? []) {
      columns.push({ kind: "added", nodeId: id, fieldId: r.id, to: snapshot(r), impact: "safe", reason: "table added" });
    }
  }

  function compare(r: FieldRecord, m: FieldRecord): Pick<ColumnChange, "kind" | "changes" | "impact" | "reason"> | null {
    const changes: ColumnAspect[] = [];
    const reasons: Array<{ impact: ChangeImpact; text: string }> = [];
    const a = normalizeType(r.storageType, aliases);
    const b = normalizeType(m.storageType, aliases);
    if (a.family !== b.family) {
      changes.push("type");
      reasons.push({ impact: "breaking", text: `type ${r.storageType ?? "untyped"} → ${m.storageType ?? "untyped"}` });
    } else if ((a.params ?? "") !== (b.params ?? "")) {
      changes.push("type");
      const [x, y] = [lengthOf(a.params), lengthOf(b.params)];
      reasons.push(x !== undefined && y !== undefined && y < x
        ? { impact: "breaking", text: `shorter: ${r.storageType} → ${m.storageType}` }
        : { impact: "safe", text: `type ${r.storageType} → ${m.storageType}` });
    }
    const [wasNullable, isNullable] = [nullableOf(r), nullableOf(m)];
    if (wasNullable !== isNullable && wasNullable !== undefined && isNullable !== undefined) {
      changes.push("nullable");
      reasons.push(isNullable ? { impact: "caution", text: "now nullable" } : { impact: "caution", text: "now required" });
    }
    if ((r.key ?? "") !== (m.key ?? "")) {
      changes.push("key");
      const pk = (k?: string) => k === "pk" || k === "pfk";
      reasons.push({ impact: pk(r.key) || pk(m.key) ? "breaking" : "caution", text: `key ${r.key ?? "none"} → ${m.key ?? "none"}` });
    }
    if (!!r.unique !== !!m.unique) {
      changes.push("unique");
      reasons.push(m.unique ? { impact: "caution", text: "now unique" } : { impact: "safe", text: "no longer unique" });
    }
    const refs = (x: FieldRecord) => x.fk.map((t) => t.nodeId ?? t.label).sort().join("|");
    if (refs(r) !== refs(m)) {
      changes.push("references");
      reasons.push({ impact: "breaking", text: `references ${refs(r) || "nothing"} → ${refs(m) || "nothing"}` });
    }
    if ((r.label ?? "") !== (m.label ?? "")) {
      changes.push("label");
      reasons.push({ impact: "safe", text: "label changed" });
    }
    if ((r.formula ?? "") !== (m.formula ?? "")) {
      changes.push("formula");
      reasons.push({ impact: "caution", text: "formula changed" });
    }
    if ((r.description ?? "") !== (m.description ?? "")) {
      changes.push("description");
      reasons.push({ impact: "safe", text: "description changed" });
    }
    if (!changes.length) return null;
    const rank: Record<ChangeImpact, number> = { breaking: 0, caution: 1, safe: 2 };
    const impact = reasons.reduce<ChangeImpact>((worst, x) => (rank[x.impact] < rank[worst] ? x.impact : worst), "safe");
    return { kind: "changed", changes, impact, reason: reasons.map((x) => x.text).join("; ") };
  }

  // ── References ──
  const linkKey = (l: KeyLink) => `${l.from.nodeId}.${l.from.fieldId.toLowerCase()}→${l.to.nodeId}`;
  const links = (doc: FieldDocument) => {
    const out = new Map<string, KeyLink>();
    for (const n of doc.nodes.filter(storesFields)) for (const l of keyReferences(doc, { nodeId: n.id }).carries) out.set(linkKey(l), l);
    return out;
  };
  const before = links(base);
  const after = links(next);
  const references = {
    added: [...after.entries()].filter(([k]) => !before.has(k)).map(([, l]) => l),
    removed: [...before.entries()].filter(([k]) => !after.has(k)).map(([, l]) => l),
  };

  const summary: Record<ChangeImpact, number> = { breaking: 0, caution: 0, safe: 0 };
  for (const c of columns) summary[c.impact]++;
  return { tables: { added: addedTables, removed: removedTables, renamed: renamedTables }, columns, references, summary };
}

/** A migration report in Markdown: the summary, then each table's changes, breaking first. */
export function schemaDiffMarkdown(diff: SchemaDiff, label: (nodeId: string) => string, title = "Schema changes"): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const out = [`# ${title}`, "", `**${diff.summary.breaking} breaking · ${diff.summary.caution} caution · ${diff.summary.safe} safe**`, ""];
  if (diff.tables.added.length) out.push(`Tables added: ${diff.tables.added.map(label).join(", ")}`, "");
  if (diff.tables.removed.length) out.push(`Tables removed: ${diff.tables.removed.map(label).join(", ")}`, "");
  for (const r of diff.tables.renamed) out.push(`Table possibly renamed: ${label(r.from)} → ${label(r.to)} (${Math.round(r.confidence * 100)}%)`, "");
  const byTable = new Map<string, ColumnChange[]>();
  for (const c of diff.columns) (byTable.get(c.nodeId) ?? byTable.set(c.nodeId, []).get(c.nodeId)!).push(c);
  const rank: Record<ChangeImpact, number> = { breaking: 0, caution: 1, safe: 2 };
  for (const [nodeId, changes] of byTable) {
    out.push(`## ${esc(label(nodeId))}`, "", "| Impact | Column | Change |", "| --- | --- | --- |");
    for (const c of [...changes].sort((a, b) => rank[a.impact] - rank[b.impact])) {
      out.push(`| ${c.impact} | ${esc(c.to?.name ?? c.from?.name ?? c.fieldId)} | ${esc(c.kind === "changed" ? c.reason : `${c.kind}${c.reason && c.reason !== c.kind ? ` — ${c.reason}` : ""}`)} |`);
    }
    out.push("");
  }
  if (diff.references.added.length || diff.references.removed.length) {
    out.push("## References", "");
    for (const l of diff.references.added) out.push(`- added: ${esc(label(l.from.nodeId))}.${esc(l.from.fieldId)} → ${esc(label(l.to.nodeId))}`);
    for (const l of diff.references.removed) out.push(`- removed: ${esc(label(l.from.nodeId))}.${esc(l.from.fieldId)} → ${esc(label(l.to.nodeId))}`);
    out.push("");
  }
  return out.join("\n");
}
