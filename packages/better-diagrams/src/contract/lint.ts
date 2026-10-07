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
import { edgeFieldIds, type FieldRef } from "./fields";
import { dataModelLintRules } from "./data-model-lint";
import { taskLintRules } from "./task-lint";
import { TASK_KIND } from "./tasks";

export type LintSeverity = "error" | "warning" | "info";

/**
 * A fix for a finding, applied as one undoable edit: draw the reference a
 * column's name implies, to that table's key; or give a column a tag.
 */
export type LintFix =
  | { kind: "draw-reference"; label: string; from: FieldRef; to: string }
  | { kind: "tag-field"; label: string; field: FieldRef; tag: string };

/** One problem a rule found. The rule id and default severity are stamped on by `lintTemplate`. */
export interface LintIssue {
  message: string;
  /** Offending nodes — the editor selects and centres these on click. */
  nodeIds?: string[];
  edgeIds?: string[];
  /** Offending columns — the editor marks these rows when it goes to the finding. */
  fields?: FieldRef[];
  /** A fix the editor can apply as one undoable edit; the HTML export shows findings only. */
  fix?: LintFix;
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
/** The bare dot at the end of a dangling arrow — notation, not a component. */
const isPoint = (n: DiagramNode) => n.kind === "point";
/**
 * Flow-chart notation: a decision diamond, a start/end stadium, an I/O
 * parallelogram. They are steps in a procedure, not systems anyone owns or
 * deploys, so ownership and dependency rules have nothing to say about them.
 */
const FLOWCHART_KINDS = new Set(["decision", "terminator", "io"]);
const isFlowchart = (n: DiagramNode) => FLOWCHART_KINDS.has(n.kind as string);

/**
 * A work item (tasks.ts) is not a system either: it is held by assignees,
 * not owned by a team, and an unlinked one is an ordinary backlog entry.
 */
const isTask = (n: DiagramNode) => n.kind === TASK_KIND;

const isLeaf = (n: DiagramNode) => !isAnnotation(n) && !isContainer(n) && !isPoint(n);
/** A real architecture element: something a team could own and operate. */
const isComponent = (n: DiagramNode) => isLeaf(n) && !isFlowchart(n) && !isTask(n);
const isSunset = (n: DiagramNode) => n.status === "deprecated" || n.status === "retired";

// The ignore tag lives in its own module so rule sets built outside this file
// (the data-model rules) share it without importing this one.
export { LINT_IGNORE_TAG, lintIgnored } from "./lint-ignore";
import { lintIgnored } from "./lint-ignore";

function nodeMap(template: DiagramTemplate): Map<string, DiagramNode> {
  return new Map(template.nodes.map((n) => [n.id, n]));
}

/**
 * The built-in rules: the architecture rules below, and the data-model rules
 * (data-model-lint.ts) with their defaults. Those consider tables only, so an
 * architecture document never hears from them.
 */
const ARCHITECTURE_RULES: Record<string, LintRuleDef> = {
  "no-orphans": {
    label: "Unconnected component",
    description: "A component nothing talks to is usually a mistake or leftover.",
    severity: "warning",
    check(t) {
      const connected = new Set(t.edges.flatMap((e) => [e.source, e.target]));
      const parents = new Set(t.nodes.map((n) => n.parentId).filter(Boolean));
      return t.nodes
        .filter(
          (n) =>
            isLeaf(n) &&
            !isTask(n) &&
            !connected.has(n.id) &&
            !parents.has(n.id) &&
            !lintIgnored(n, "no-orphans"),
        )
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
        // A self-loop is a retry, not a distributed cycle — the schema prompt
        // asks for exactly this shape on a flow chart, so reporting it would
        // flag the editor's own advice.
        if (e.source === e.target) continue;
        // Only a one-way call is a hop that waits on the next one. "none" is a
        // plain association (no call at all) and "both" is a mutual link the
        // author drew deliberately as ONE edge, not a cycle we discovered.
        if ((e.direction ?? "forward") !== "forward") continue;
        // A key between two tables is not a call: a loop of foreign keys is an
        // ordinary data model, however the line happens to be drawn (one drawn
        // in the editor is solid until someone says otherwise).
        if (e.relation || edgeFieldIds(e).start !== undefined) continue;
        // A line between tasks is "finish this first", not a call — a loop of
        // them is a deadlocked plan, which the cards already show as Blocked.
        if (byId.get(e.source)?.kind === TASK_KIND || byId.get(e.target)?.kind === TASK_KIND) continue;
        if (byId.get(e.source) && lintIgnored(byId.get(e.source)!, "no-cycles")) continue;
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
        if (pair && !pair.some((n) => lintIgnored(n, "external-data-access"))) {
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
      const unowned = t.nodes.filter(
        (n) => isComponent(n) && !n.team && !lintIgnored(n, "missing-owner"),
      );
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
        if (
          s?.team &&
          target?.team &&
          s.team !== target.team &&
          !lintIgnored(s, "unlabeled-cross-team") &&
          !lintIgnored(target, "unlabeled-cross-team")
        ) {
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
        if (
          s &&
          target &&
          !isSunset(s) &&
          isSunset(target) &&
          !lintIgnored(s, "deprecated-dependency")
        ) {
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

export const BUILTIN_LINT_RULES: Record<string, LintRuleDef> = { ...ARCHITECTURE_RULES, ...dataModelLintRules(), ...taskLintRules() };

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
