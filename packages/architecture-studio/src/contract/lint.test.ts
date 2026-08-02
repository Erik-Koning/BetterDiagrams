/**
 * Tests for the architecture lint engine — one suite per built-in rule, plus
 * the rule-table override behaviour the registry relies on.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_LINT_RULES, lintTemplate } from "./lint";
import type { DiagramTemplate } from "./schema";

const node = (over: Record<string, unknown> = {}) =>
  ({
    id: "n",
    label: "N",
    kind: "service",
    icon: "box",
    description: "",
    parentId: null,
    x: 0,
    y: 0,
    w: 170,
    h: 76,
    ...over,
  }) as DiagramTemplate["nodes"][number];

const edge = (over: Record<string, unknown> = {}) =>
  ({
    id: "e",
    source: "a",
    target: "b",
    label: "",
    style: "solid",
    color: "slate",
    ...over,
  }) as DiagramTemplate["edges"][number];

const doc = (nodes: unknown[], edges: unknown[] = []): DiagramTemplate =>
  ({ version: 1, nodes, edges }) as DiagramTemplate;

const byRule = (findings: ReturnType<typeof lintTemplate>, rule: string) =>
  findings.filter((f) => f.rule === rule);

describe("no-orphans", () => {
  it("flags a leaf nothing talks to, but not annotations or containers", () => {
    const t = doc(
      [
        node({ id: "a" }),
        node({ id: "b" }),
        node({ id: "lonely", label: "Lonely" }),
        node({ id: "note", kind: "text" }),
        node({ id: "box", kind: "group" }),
      ],
      [edge()],
    );
    const found = byRule(lintTemplate(t), "no-orphans");
    expect(found).toHaveLength(1);
    expect(found[0].nodeIds).toEqual(["lonely"]);
    expect(found[0].severity).toBe("warning");
  });

  it("does not flag a parent whose children carry the edges", () => {
    const t = doc(
      [node({ id: "p", kind: "service" }), node({ id: "c", parentId: "p" }), node({ id: "b" })],
      [edge({ source: "c", target: "b" })],
    );
    expect(byRule(lintTemplate(t), "no-orphans")).toHaveLength(0);
  });
});

describe("no-cycles", () => {
  it("names the cycle through solid edges", () => {
    const t = doc(
      [node({ id: "a", label: "A" }), node({ id: "b", label: "B" }), node({ id: "c", label: "C" })],
      [
        edge({ id: "e1", source: "a", target: "b" }),
        edge({ id: "e2", source: "b", target: "c" }),
        edge({ id: "e3", source: "c", target: "a" }),
      ],
    );
    const found = byRule(lintTemplate(t), "no-cycles");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("A → B → C → A");
  });

  it("ignores cycles broken by an async (dashed) hop", () => {
    const t = doc(
      [node({ id: "a" }), node({ id: "b" })],
      [
        edge({ id: "e1", source: "a", target: "b" }),
        edge({ id: "e2", source: "b", target: "a", style: "dashed" }),
      ],
    );
    expect(byRule(lintTemplate(t), "no-cycles")).toHaveLength(0);
  });
});

describe("external-data-access", () => {
  it("errors when an external system reaches a datastore directly", () => {
    const t = doc(
      [node({ id: "a", kind: "external", label: "Stripe" }), node({ id: "b", kind: "database", label: "Ledger" })],
      [edge()],
    );
    const found = byRule(lintTemplate(t), "external-data-access");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].message).toContain("Stripe");
    expect(found[0].edgeIds).toEqual(["e"]);
  });

  it("stays quiet for external → service", () => {
    const t = doc([node({ id: "a", kind: "external" }), node({ id: "b" })], [edge()]);
    expect(byRule(lintTemplate(t), "external-data-access")).toHaveLength(0);
  });
});

describe("missing-owner", () => {
  it("stays quiet while ownership is unused, fires once it is partial", () => {
    const nobody = doc([node({ id: "a" }), node({ id: "b" })], [edge()]);
    expect(byRule(lintTemplate(nobody), "missing-owner")).toHaveLength(0);

    const partial = doc([node({ id: "a", team: "Core" }), node({ id: "b", label: "B" })], [edge()]);
    const found = byRule(lintTemplate(partial), "missing-owner");
    expect(found).toHaveLength(1);
    expect(found[0].nodeIds).toEqual(["b"]);
    expect(found[0].message).toContain('"B"');
  });
});

describe("unlabeled-cross-team", () => {
  it("asks for a label between teams, but not within one", () => {
    const t = doc(
      [
        node({ id: "a", team: "Core" }),
        node({ id: "b", team: "Data" }),
        node({ id: "c", team: "Core" }),
      ],
      [
        edge({ id: "x", source: "a", target: "b" }),
        edge({ id: "y", source: "a", target: "c" }),
        edge({ id: "z", source: "a", target: "b", label: "orders" }),
      ],
    );
    const found = byRule(lintTemplate(t), "unlabeled-cross-team");
    expect(found).toHaveLength(1);
    expect(found[0].edgeIds).toEqual(["x"]);
    expect(found[0].severity).toBe("info");
  });
});

describe("deprecated-dependency", () => {
  it("flags an active component building on a sunset one", () => {
    const t = doc(
      [node({ id: "a", label: "API" }), node({ id: "b", label: "Old Cache", status: "deprecated" })],
      [edge()],
    );
    const found = byRule(lintTemplate(t), "deprecated-dependency");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("deprecated");
  });

  it("lets sunset components depend on each other", () => {
    const t = doc(
      [node({ id: "a", status: "retired" }), node({ id: "b", status: "deprecated" })],
      [edge()],
    );
    expect(byRule(lintTemplate(t), "deprecated-dependency")).toHaveLength(0);
  });
});

describe("lintTemplate", () => {
  it("sorts errors before warnings before info", () => {
    const t = doc(
      [
        node({ id: "a", kind: "external", team: "Ext" }),
        node({ id: "b", kind: "database", team: "Data" }),
        node({ id: "lonely" }),
      ],
      [edge()],
    );
    const rank = { error: 0, warning: 1, info: 2 };
    const severities = lintTemplate(t).map((f) => f.severity);
    expect(severities.length).toBeGreaterThanOrEqual(3);
    expect(severities[0]).toBe("error");
    for (let i = 1; i < severities.length; i++) {
      expect(rank[severities[i]]).toBeGreaterThanOrEqual(rank[severities[i - 1]]);
    }
  });

  it("runs a custom rule table and honours per-issue severity overrides", () => {
    const t = doc([node({ id: "a" })]);
    const findings = lintTemplate(t, {
      "must-have-ten": {
        label: "Ten nodes minimum",
        severity: "info",
        check: (d) =>
          d.nodes.length < 10
            ? [{ message: `Only ${d.nodes.length} node(s)`, severity: "error" as const }]
            : [],
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("must-have-ten");
    expect(findings[0].severity).toBe("error");
  });

  it("a rule removed from the table does not run", () => {
    const t = doc([node({ id: "lonely" })]);
    const rules = { ...BUILTIN_LINT_RULES };
    delete rules["no-orphans"];
    expect(byRule(lintTemplate(t, rules), "no-orphans")).toHaveLength(0);
  });
});
