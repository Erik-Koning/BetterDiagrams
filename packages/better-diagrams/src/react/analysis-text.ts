/**
 * analysis-text.ts — the words the analysis panels say, in one place, so
 * the editor's React panels and the HTML export's DOM panels say the same
 * thing. Pure strings; no DOM, no React.
 */

import { csvText } from "../contract/csv";
import type { LintFinding } from "../contract/lint";
import type { ImpactResult } from "../contract/impact";
import type { GovernanceReport } from "../contract/dictionary";
import type { StructureSummary } from "../contract/structure";
import { PATH_COLOR_CYCLE } from "../contract/paths";

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** "12 tables within 2 joins". */
export function neighbourhoodHeadline(reached: number, depth: number): string {
  return `${plural(reached, "table")} within ${plural(depth, "join")}`;
}

/** "12 findings — 1 error, 8 warnings, 3 info". */
export function checksSummary(counts: { error: number; warning: number; info: number }): string {
  const total = counts.error + counts.warning + counts.info;
  if (!total) return "No findings";
  const parts = [
    counts.error ? plural(counts.error, "error") : "",
    counts.warning ? plural(counts.warning, "warning") : "",
    counts.info ? `${counts.info} info` : "",
  ].filter(Boolean);
  return `${plural(total, "finding")} — ${parts.join(", ")}`;
}

/** The findings of a severity (or all), whose message or rule matches a query. */
export function filterFindings<F extends { rule: string; severity: string; message: string }>(
  findings: readonly F[],
  severity: string,
  query: string,
  ruleLabel: (rule: string) => string,
): F[] {
  const q = query.trim().toLowerCase();
  return findings.filter(
    (f) =>
      (severity === "all" || f.severity === severity) &&
      (!q || f.message.toLowerCase().includes(q) || ruleLabel(f.rule).toLowerCase().includes(q)),
  );
}

/** Group findings by rule, in the order rules first appear (most severe first, as lintTemplate sorts). */
export function groupFindings<F extends { rule: string }>(findings: readonly F[]): Array<{ rule: string; findings: F[] }> {
  const groups = new Map<string, F[]>();
  for (const f of findings) {
    const list = groups.get(f.rule);
    if (list) list.push(f);
    else groups.set(f.rule, [f]);
  }
  return [...groups.entries()].map(([rule, list]) => ({ rule, findings: list }));
}

/** The findings as CSV: one row each. */
export function findingsCsv(findings: readonly LintFinding[], ruleLabel: (rule: string) => string, nodeLabel: (id: string) => string): string {
  return csvText(
    ["Severity", "Rule", "Message", "Tables", "Columns"],
    findings.map((f) => [
      f.severity,
      ruleLabel(f.rule),
      f.message,
      (f.nodeIds ?? []).map(nodeLabel).join("; "),
      (f.fields ?? []).map((r) => `${nodeLabel(r.nodeId)}.${r.fieldId}`).join("; "),
    ]),
  );
}

/** The impact list as CSV: one row per table reached. */
export function impactCsv(result: ImpactResult, nodeLabel: (id: string) => string): string {
  return csvText(
    ["Table", "Hops", "Via table", "Via key", "Cascade", "Required"],
    result.nodes.map((n) => [
      nodeLabel(n.id),
      String(n.depth),
      nodeLabel(n.via.from),
      n.via.field ?? "",
      n.cascade ? "yes" : "",
      n.required ? "yes" : "",
    ]),
  );
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");

/** The governance report's four headline lines, as both panels print them. */
export function governanceLines(r: GovernanceReport): Array<{ label: string; value: string; detail: string }> {
  const d = r.documentation;
  return [
    { label: "Tables described", value: pct(d.tablesDescribed, d.tables), detail: `${d.tablesDescribed} of ${plural(d.tables, "table")}` },
    { label: "Fields described", value: pct(d.fieldsDescribed, d.fields), detail: `${d.fieldsDescribed} of ${plural(d.fields, "field")}` },
    { label: "Fields labelled", value: pct(d.fieldsLabelled, d.fields), detail: `${d.fieldsLabelled} of ${plural(d.fields, "field")}` },
    { label: "Tables owned", value: pct(r.ownership.tablesOwned, d.tables), detail: `${r.ownership.tablesOwned} of ${plural(d.tables, "table")}` },
  ];
}

/** "3 breaking · 5 caution · 12 safe". */
export function changesSummary(summary: Record<"breaking" | "caution" | "safe", number>): string {
  return `${summary.breaking} breaking · ${summary.caution} caution · ${summary.safe} safe`;
}

/** "40 tables · 4 domains · 2 shared · 3 bridge keys · modularity 0.41". */
export function structureHeadline(s: StructureSummary): string {
  return [
    plural(s.tables, "table"),
    plural(s.domains.length, "domain"),
    s.shared.length ? `${s.shared.length} shared` : "",
    plural(s.bridges.length, "bridge key"),
    s.islands.length ? `${s.islands.length} unjoined` : "",
    s.domains.length ? `modularity ${s.modularity.toFixed(2)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The colour name a domain wears when tables are coloured by domain — the path colour cycle, by domain order. */
export const domainColor = (index: number) => PATH_COLOR_CYCLE[index % PATH_COLOR_CYCLE.length]!;
