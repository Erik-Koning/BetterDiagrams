/**
 * impact.test.ts — what depends on a table or a key: dependents and
 * dependencies, cascades and blockers, a field subject, the "why" chain.
 */
import { describe, expect, it } from "vitest";
import { impactChain, impactHeadline, impactOf } from "./impact";

const table = (id: string, fields: string[] = ["id"], model?: Record<string, unknown>) => ({
  id, label: id[0]!.toUpperCase() + id.slice(1), fields: fields.map((f) => ({ id: f, name: f, ...(f === "id" ? { key: "pk" as const } : {}) })),
  ...(model ? { data: { model } } : {}),
});
const fk = (id: string, source: string, target: string, field: string, model: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  id, source, target, startField: field, endField: "id", data: { model: { field, ...model } }, ...over,
});

/**
 *   accounts ← contacts.account_id ← cases.contact_id (cascade) ← comments.case_id (composition)
 *   accounts ← invoices.account_id (restrict)       accounts → regions (accounts.region_id)
 *   employees.manager_id → employees (a hierarchy)   the stub is outside the model
 */
const DOC = {
  nodes: [
    table("accounts", ["id", "region_id", "code"]),
    table("contacts", ["id", "account_id"]),
    table("cases", ["id", "contact_id"]),
    table("comments", ["id", "case_id"]),
    table("invoices", ["id", "account_id"]),
    table("regions"),
    table("employees", ["id", "manager_id"]),
    table("stub", ["id", "account_id"], { shape: "external" }),
  ],
  edges: [
    fk("c-a", "contacts", "accounts", "account_id", { required: true }),
    fk("k-c", "cases", "contacts", "contact_id", { cascadeDelete: true }),
    fk("m-k", "comments", "cases", "case_id", {}, { relation: "composition" }),
    fk("i-a", "invoices", "accounts", "account_id", { deleteConstraint: "restrict" }),
    fk("a-r", "accounts", "regions", "region_id"),
    fk("e-e", "employees", "employees", "manager_id"),
    fk("s-a", "stub", "accounts", "account_id"),
    { id: "arch", source: "regions", target: "accounts" },
  ],
};

describe("impactOf", () => {
  it("finds every dependent, nearest first, with the hop that reached it", () => {
    const r = impactOf(DOC, { nodeId: "accounts" });
    expect(r.byDepth).toEqual([["contacts", "invoices", "stub"], ["cases"], ["comments"]]);
    expect(r.nodes.find((n) => n.id === "cases")!.via).toEqual({ edgeId: "k-c", from: "contacts", field: "contact_id" });
    expect(r.nodes.find((n) => n.id === "contacts")!.required).toBe(true);
    expect(r.outsideModel).toEqual(["stub"]);
  });

  it("says what a delete cascades to — only along cascading keys — and what blocks it", () => {
    const r = impactOf(DOC, { nodeId: "contacts" });
    expect(r.cascade).toEqual(["cases", "comments"]);
    expect(impactOf(DOC, { nodeId: "accounts" }).cascade).toEqual([]);
    expect(impactOf(DOC, { nodeId: "accounts" }).blockers).toEqual([{ edgeId: "i-a", from: "invoices", field: "account_id" }]);
  });

  it("holds a field subject's first hop to the edges landing on it", () => {
    expect(impactOf(DOC, { nodeId: "accounts", fieldId: "code" }).nodes).toEqual([]);
    expect(impactOf(DOC, { nodeId: "accounts", fieldId: "id" }).byDepth[0]).toEqual(["contacts", "invoices", "stub"]);
  });

  it("walks forward for dependencies, caps depth, and skips lines without keys unless asked", () => {
    expect(impactOf(DOC, { nodeId: "comments" }, { direction: "dependencies" }).byDepth).toEqual([["cases"], ["contacts"], ["accounts"], ["regions"]]);
    expect(impactOf(DOC, { nodeId: "accounts" }, { maxDepth: 1 }).nodes.map((n) => n.id)).toEqual(["contacts", "invoices", "stub"]);
    expect(impactOf(DOC, { nodeId: "accounts" }, { via: "all" }).byDepth[0]).toContain("regions");
  });

  it("ignores a self-reference, and rebuilds the chain to any table", () => {
    expect(impactOf(DOC, { nodeId: "employees" }).nodes).toEqual([]);
    const r = impactOf(DOC, { nodeId: "accounts" });
    expect(impactChain(r, "comments")).toEqual({ nodes: ["accounts", "contacts", "cases", "comments"], edges: ["c-a", "k-c", "m-k"] });
    expect(impactChain(r, "regions")).toBeNull();
  });

  it("says it in one line", () => {
    expect(impactHeadline(impactOf(DOC, { nodeId: "accounts" }), "Accounts")).toBe("5 tables depend on Accounts — 1 blocker");
    expect(impactHeadline(impactOf(DOC, { nodeId: "contacts" }), "Contacts")).toBe("2 tables depend on Contacts — 2 by cascade");
    expect(impactHeadline(impactOf(DOC, { nodeId: "regions" }, { direction: "dependencies" }), "Regions")).toBe("Regions depends on 0 tables");
  });
});
