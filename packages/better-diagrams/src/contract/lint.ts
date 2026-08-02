/**
 * lint.ts — architecture governance checks.
 *
 * A lint rule is a pure function over the document: no registry, no DOM, no
 * side effects. `lintTemplate` runs a rule table and returns findings sorted
 * most-severe first. The editor runs it on every committed edit and surfaces
 * the findings in the Checks menu; hosts add their own rules through the
 * registry exactly like exporters:
 *
 *   registry={{ lintRules: {
 *     "no-direct-db": {
 *       label: "Services must not skip the API layer",
 *       severity: "error",
 *       check: (t) => t.edges.filter(bad).map((e) => ({
 *         message: `…`, edgeIds: [e.id],
 *       })),
 *     },
 *     "missing-owner": null,   // remove a built-in
 *   } }}
 *
 * Built-in rules use the built-in kind vocabulary ("external", "database",
 * "queue", "group", "text") directly — the contract half has no registry, and
 * custom kinds are the host's own to lint.
 */
import type { DiagramNode, DiagramTemplate } from "./schema";

export type LintSeverity = "error" | "warning" | "info";

/** One problem a rule found. The rule id and default severity are stamped on by `lintTemplate`. */
export interface LintIssue {
  message: string;
  /** Offending nodes — the editor selects and centres these on click. */
  nodeIds?: string[];
  edgeIds?: string[];
  /** Overrides the rule's default severity for this one finding. */
  severity?: LintSeverity;
}

export interface LintRuleDef {
  /** Shown as the finding's heading in the Checks menu. */
  label: string;
  description?: string;
  severity: LintSeverity;
  check(template: DiagramTemplate): LintIssue[];
}

export interface LintFinding extends LintIssue {
  rule: string;
  severity: LintSeverity;
}

const SEVERITY_RANK: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Kinds that are not architecture elements for linting purposes. */
const isAnnotation = (n: DiagramNode) => n.kind === "text";
const isContainer = (n: DiagramNode) => n.kind === "group";
const isLeaf = (n: DiagramNode) => !isAnnotation(n) && !isContainer(n);
const isSunset = (n: DiagramNode) => n.status === "deprecated" || n.status === "retired";

function nodeMap(template: DiagramTemplate): Map<string, DiagramNode> {
  return new Map(template.nodes.map((n) => [n.id, n]));
}

export const BUILTIN_LINT_RULES: Record<string, LintRuleDef> = {
  "no-orphans": {
    label: "Unconnected component",
    description: "A component nothing talks to is usually a mistake or leftover.",
    severity: "warning",
    check(t) {
      const connected = new Set(t.edges.flatMap((e) => [e.source, e.target]));
      const parents = new Set(t.nodes.map((n) => n.parentId).filter(Boolean));
      return t.nodes
        .filter((n) => isLeaf(n) && !connected.has(n.id) && !parents.has(n.id))
        .map((n) => ({ message: `"${n.label}" has no connections`, nodeIds: [n.id] }));
    },
  },

  "no-cycles": {
    label: "Synchronous cycle",
    description:
      "A cycle through solid (synchronous) edges is a latency and availability hazard — each hop waits on the next, back to itself.",
    severity: "warning",
    check(t) {
      const byId = new Map(t.nodes.map((n) => [n.id, n]));
      const adjacency = new Map<string, string[]>();
      for (const e of t.edges) {
        if ((e.style ?? "solid") !== "solid") continue;
        if (!adjacency.has(e.source)) adjacency.set(e.source, []);
        adjacency.get(e.source)!.push(e.target);
      }
      const seenCycles = new Set<string>();
      const issues: LintIssue[] = [];
      const state = new Map<string, "visiting" | "done">();
      const stack: string[] = [];

      const visit = (id: string) => {
        state.set(id, "visiting");
        stack.push(id);
        for (const next of adjacency.get(id) ?? []) {
          if (state.get(next) === "visiting") {
            const cycle = stack.slice(stack.indexOf(next));
            const key = [...cycle].sort().join("|");
            if (!seenCycles.has(key)) {
              seenCycles.add(key);
              const names = [...cycle, next].map((cid) => byId.get(cid)?.label ?? cid);
              issues.push({ message: `Cycle: ${names.join(" → ")}`, nodeIds: cycle });
            }
          } else if (!state.has(next)) {
            visit(next);
          }
        }
        stack.pop();
        state.set(id, "done");
      };
      for (const n of t.nodes) if (!state.has(n.id)) visit(n.id);
      return issues;
    },
  },

  "external-data-access": {
    label: "External system reaches a datastore",
    description:
      "Third parties should go through your services, never straight to a database or queue.",
    severity: "error",
    check(t) {
      const byId = nodeMap(t);
      const issues: LintIssue[] = [];
      for (const e of t.edges) {
        const s = byId.get(e.source);
        const target = byId.get(e.target);
        if (!s || !target) continue;
        const pair =
          s.kind === "external" && (target.kind === "database" || target.kind === "queue")
            ? [s, target]
            : target.kind === "external" && (s.kind === "database" || s.kind === "queue")
              ? [target, s]
              : null;
        if (pair) {
          issues.push({
            message: `External "${pair[0].label}" reaches "${pair[1].label}" directly`,
            nodeIds: [pair[0].id, pair[1].id],
            edgeIds: [e.id],
          });
        }
      }
      return issues;
    },
  },

  "missing-owner": {
    label: "Unowned components",
    description:
      "Fires only once ownership is in use: if some nodes carry a team, the rest should too.",
    severity: "warning",
    check(t) {
      if (!t.nodes.some((n) => n.team)) return [];
      const unowned = t.nodes.filter((n) => isLeaf(n) && !n.team);
      if (!unowned.length) return [];
      const names = unowned.map((n) => `"${n.label}"`).join(", ");
      return [
        {
          message: `${unowned.length} component${unowned.length === 1 ? " has" : "s have"} no owning team: ${names}`,
          nodeIds: unowned.map((n) => n.id),
        },
      ];
    },
  },

  "unlabeled-cross-team": {
    label: "Unlabeled cross-team dependency",
    description: "An edge between teams is a contract — say what it carries.",
    severity: "info",
    check(t) {
      const byId = nodeMap(t);
      const issues: LintIssue[] = [];
      for (const e of t.edges) {
        if (e.label) continue;
        const s = byId.get(e.source);
        const target = byId.get(e.target);
        if (s?.team && target?.team && s.team !== target.team) {
          issues.push({
            message: `Unlabeled edge between ${s.team}'s "${s.label}" and ${target.team}'s "${target.label}"`,
            nodeIds: [s.id, target.id],
            edgeIds: [e.id],
          });
        }
      }
      return issues;
    },
  },

  "deprecated-dependency": {
    label: "Dependency on a sunset component",
    description: "Active components should not build on what is being switched off.",
    severity: "warning",
    check(t) {
      const byId = nodeMap(t);
      const issues: LintIssue[] = [];
      for (const e of t.edges) {
        const s = byId.get(e.source);
        const target = byId.get(e.target);
        if (s && target && !isSunset(s) && isSunset(target)) {
          issues.push({
            message: `"${s.label}" depends on ${target.status} "${target.label}"`,
            nodeIds: [s.id, target.id],
            edgeIds: [e.id],
          });
        }
      }
      return issues;
    },
  },
};

/** Run a rule table over a document. Findings come back most-severe first. */
export function lintTemplate(
  template: DiagramTemplate,
  rules: Record<string, LintRuleDef> = BUILTIN_LINT_RULES,
): LintFinding[] {
  const out: LintFinding[] = [];
  for (const [id, rule] of Object.entries(rules)) {
    for (const issue of rule.check(template)) {
      out.push({ ...issue, rule: id, severity: issue.severity ?? rule.severity });
    }
  }
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
