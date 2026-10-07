/**
 * data-model-lint.test.ts — the schema-quality checks: one fixture, a
 * finding (or its absence) per rule, ignore tags, severity and naming.
 */
import { describe, expect, it } from "vitest";
import { validateTemplate, type DiagramTemplate } from "./schema";
import { dataModelLintRules } from "./data-model-lint";
import { BUILTIN_LINT_RULES, lintTemplate } from "./lint";

const table = (id: string, label: string, fields: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  id, label, kind: "table", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 230, h: 120,
  fields: fields.map((f) => ({ id: String(f.id), name: String(f.name ?? f.id), ...f })),
  ...over,
});
const edge = (id: string, source: string, target: string, over: Record<string, unknown> = {}) => ({
  id, source, target, label: "", style: "solid", color: "slate", ...over,
});

const DOC: DiagramTemplate = validateTemplate({
  version: 1,
  nodes: [
    table("customers", "Customers", [{ id: "id", key: "pk", type: "uuid" }], { data: { model: { shape: "entity", name: "customers" } } }),
    table("accounts", "Accounts", [{ id: "id", key: "pk", type: "uuid" }]),
    table("orders", "Orders", [
      { id: "id", key: "pk", type: "uuid" },
      { id: "customer_id", type: "uuid" },
      { id: "account_id", key: "fk", type: "varchar(36)" },
    ], { data: { model: { shape: "entity", name: "orders" } } }),
    table("order_lines", "Order lines", [{ id: "id", key: "pk", type: "uuid" }, { id: "order_id", key: "fk", type: "uuid" }]),
    table("logs", "Logs", [{ id: "message", type: "text" }]),
    table("people", "People", [{ id: "id", key: "pk", type: "uuid" }, { id: "AccountId", type: "uuid" }, { id: "account_id", type: "uuid" }]),
    table("tasks", "Tasks", [{ id: "id", key: "pk", type: "uuid" }], {
      data: { model: { shape: "entity", name: "tasks", fields: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "what_id", type: "uuid", relationship: { referenceTo: ["customers", "orders"] } },
        { name: "ghost_id", type: "uuid", relationship: { referenceTo: ["Ghost"] } },
      ] } },
    }),
    table("big", "Big", [{ id: "id", key: "pk", type: "uuid" }], { data: { model: { shape: "entity", name: "big", fieldsTruncated: true } } }),
  ],
  edges: [
    edge("o-a", "orders", "accounts", { startField: "account_id", endField: "id" }),
    edge("l-o", "order_lines", "orders", { startField: "order_id", endField: "id", relation: "composition", data: { model: { field: "order_id", required: false } } }),
  ],
});

const findings = (doc: DiagramTemplate, rules = BUILTIN_LINT_RULES) => lintTemplate(doc, rules);
const of = (rule: string, doc: DiagramTemplate = DOC) => findings(doc).filter((f) => f.rule === rule);

describe("data-model checks", () => {
  it("a table with no key", () => {
    expect(of("dm-no-primary-key").map((f) => f.nodeIds)).toEqual([["logs"]]);
  });

  it("a column named like a reference that nothing declares — with a fix to draw it", () => {
    const [f, ...rest] = of("dm-undeclared-reference");
    expect(f).toMatchObject({
      message: '"Orders.customer_id" looks like a reference to Customers, but nothing declares it',
      fields: [{ nodeId: "orders", fieldId: "customer_id" }],
      fix: { kind: "draw-reference", from: { nodeId: "orders", fieldId: "customer_id" }, to: "customers" },
    });
    // People.AccountId and People.account_id both look like Accounts references.
    expect(rest.map((x) => x.fields![0]!.fieldId).sort()).toEqual(["AccountId", "account_id"]);
  });

  it("a reference stored as another type than the key it lands on", () => {
    expect(of("dm-key-type-mismatch").map((f) => f.message)).toEqual([
      '"Orders.account_id" is varchar(36) but points at Accounts.id, which is uuid',
    ]);
  });

  it("a reference to nothing in the model, and a polymorphic one", () => {
    expect(of("dm-unresolved-reference").map((f) => f.message)).toEqual(['"Tasks.ghost_id" references "Ghost", which is not in the model']);
    expect(of("dm-polymorphic-reference").map((f) => f.fields)).toEqual([[{ nodeId: "tasks", fieldId: "what_id" }]]);
  });

  it("a composition whose key may be empty", () => {
    expect(of("dm-optional-composition")).toEqual([
      expect.objectContaining({ edgeIds: ["l-o"], fields: [{ nodeId: "order_lines", fieldId: "order_id" }] }),
    ]);
  });

  it("near-duplicate column names, a table cut short, and an inconsistently stored name", () => {
    expect(of("dm-duplicate-name").map((f) => f.message)).toEqual(['"People" has both AccountId and account_id']);
    expect(of("dm-truncated-fields").map((f) => f.nodeIds)).toEqual([["big"]]);
    // account_id: uuid in People, varchar(36) in Orders.
    expect(of("dm-inconsistent-type").map((f) => f.message)).toContain("account_id: 2 types: uuid, varchar (2 tables)");
  });

  it("stays quiet on an architecture document", () => {
    const arch = validateTemplate({
      version: 1,
      nodes: [{ id: "api", label: "API", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 }],
      edges: [],
    });
    expect(findings(arch).filter((f) => f.rule.startsWith("dm-"))).toEqual([]);
  });

  it("honours lint-ignore on a table and on a row", () => {
    const quiet = validateTemplate({
      ...DOC,
      nodes: DOC.nodes.map((n) =>
        n.id === "logs"
          ? { ...n, tags: ["lint-ignore:dm-no-primary-key"] }
          : n.id === "orders"
            ? { ...n, fields: n.fields!.map((f) => (f.id === "customer_id" ? { ...f, tags: ["lint-ignore"] } : f)) }
            : n,
      ),
    });
    expect(of("dm-no-primary-key", quiet)).toEqual([]);
    expect(of("dm-undeclared-reference", quiet).some((f) => f.fields![0]!.fieldId === "customer_id")).toBe(false);
  });

  it("takes severities, switches rules off, and checks naming on request", () => {
    const rules = dataModelLintRules({ severity: { "dm-no-primary-key": "error", "dm-polymorphic-reference": "off" }, naming: "majority" });
    expect(rules["dm-no-primary-key"]!.severity).toBe("error");
    expect(rules["dm-polymorphic-reference"]).toBeUndefined();
    const naming = lintTemplate(DOC, rules).filter((f) => f.rule === "dm-naming");
    expect(naming.map((f) => f.message)).toEqual(['"People": AccountId not snake_case']);
    const pattern = dataModelLintRules({ naming: { table: /^[A-Z][a-z]+$/ } });
    expect(lintTemplate(DOC, pattern).filter((f) => f.rule === "dm-naming").map((f) => f.nodeIds)).toEqual([["order_lines"]]);
  });
});
