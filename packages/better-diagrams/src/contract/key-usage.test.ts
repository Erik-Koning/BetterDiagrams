/**
 * key-usage.test.ts — which tables carry a field by name, the search over
 * those names, and the share of the model a chosen set of them covers.
 */
import { describe, expect, it } from "vitest";
import { fieldUsage, inconsistencySummary, searchFieldUsage, usageCoverage, usageHeadline, variantSummary } from "./key-usage";

/**
 *   tenants  id
 *   users    id · tenant_id → tenants · email
 *   orders   id · tenant_id → tenants · user_id → users      (data bag: + created_by, not drawn)
 *   invoices id · TENANT_ID (another spelling) · order_id → orders
 *   logs     id                                               (an island)
 *   status   enum — its rows are values, not fields
 *   users/active — a view: no fields, not a table
 */
const DOC = {
  nodes: [
    { id: "tenants", label: "Tenants", fields: [{ id: "id", name: "id", key: "pk" as const }] },
    {
      id: "users",
      label: "Users",
      fields: [
        { id: "id", name: "id", key: "pk" as const },
        { id: "tenant_id", name: "tenant_id", key: "fk" as const },
        { id: "email", name: "email" },
      ],
    },
    {
      id: "orders",
      label: "Orders",
      fields: [
        { id: "id", name: "id", key: "pk" as const },
        { id: "tenant_id", name: "tenant_id", key: "fk" as const },
        { id: "user_id", name: "user_id", key: "fk" as const },
      ],
      data: { fields: [{ name: "id" }, { name: "tenant_id" }, { name: "user_id" }, { name: "created_by", label: "Created by" }] },
    },
    {
      id: "invoices",
      label: "Invoices",
      fields: [
        { id: "id", name: "id", key: "pk" as const },
        { id: "TENANT_ID", name: "TENANT_ID" },
        { id: "order_id", name: "order_id", key: "fk" as const },
      ],
    },
    { id: "logs", label: "Logs", fields: [{ id: "id", name: "id", key: "pk" as const }] },
    { id: "status", label: "Status", kind: "enum", fields: [{ id: "open", name: "open" }, { id: "id", name: "id" }] },
    { id: "users/active", label: "Active users" },
  ],
  edges: [
    { id: "u-t", source: "users", target: "tenants", startField: "tenant_id", endField: "id" },
    { id: "o-t", source: "orders", target: "tenants", startField: "tenant_id", endField: "id" },
    { id: "o-u", source: "orders", target: "users", startField: "user_id", endField: "id" },
    { id: "i-o", source: "invoices", target: "orders", startField: "order_id", endField: "id" },
    { id: "view", source: "users/active", target: "users" },
  ],
};

describe("fieldUsage", () => {
  const index = fieldUsage(DOC);

  it("counts tables only: never an enum's values, never a view", () => {
    expect(index.tables).toEqual(["tenants", "users", "orders", "invoices", "logs"]);
    expect(index.byId.has("open")).toBe(false);
    expect(index.byId.get("id")!.tables.map((t) => t.nodeId)).toEqual(["tenants", "users", "orders", "invoices", "logs"]);
  });

  it("groups a name across tables whatever its case, in the spelling most use", () => {
    const tenant = index.byId.get("tenant_id")!;
    expect(tenant.name).toBe("tenant_id");
    expect(tenant.tables).toEqual([
      { nodeId: "users", fieldId: "tenant_id", key: "fk" },
      { nodeId: "orders", fieldId: "tenant_id", key: "fk" },
      { nodeId: "invoices", fieldId: "TENANT_ID" },
    ]);
    expect(tenant.isKey).toBe(true);
    expect(tenant.targets).toEqual(["tenants"]);
  });

  it("includes the fields a table's data knows and doesn't draw", () => {
    const created = index.byId.get("created_by")!;
    expect(created.tables).toEqual([{ nodeId: "orders", fieldId: "created_by" }]);
    expect(created.labels).toEqual(["Created by"]);
    expect(created.isKey).toBe(false);
  });

  it("lists the most shared names first", () => {
    expect(index.fields.map((f) => [f.id, f.tables.length]).slice(0, 2)).toEqual([["id", 5], ["tenant_id", 3]]);
  });
});

describe("searchFieldUsage", () => {
  const index = fieldUsage(DOC);

  it("matches a name or a label, ignoring case", () => {
    expect(searchFieldUsage(index, "TENANT").map((f) => f.id)).toEqual(["tenant_id"]);
    expect(searchFieldUsage(index, "created BY").map((f) => f.id)).toEqual(["created_by"]);
    expect(searchFieldUsage(index, "_id").map((f) => f.id)).toEqual(["tenant_id", "order_id", "user_id"]);
  });

  it("ranks a name match above a label match, however many tables share the label's field", () => {
    const labelled = fieldUsage({
      nodes: [
        { id: "a", fields: [{ id: "name", name: "name" }] },
        { id: "b", fields: [{ id: "name", name: "name" }] },
        { id: "c", fields: [{ id: "building_id", name: "building_id" }], data: { fields: [{ name: "building_id" }, { name: "name", label: "Building name" }] } },
      ],
      edges: [],
    });
    expect(searchFieldUsage(labelled, "building").map((f) => f.id)).toEqual(["building_id", "name"]);
    expect(searchFieldUsage(labelled, "name").map((f) => f.id)).toEqual(["name"]);
  });

  it("narrows to keys on request, and lists what tables share when nothing is typed", () => {
    expect(searchFieldUsage(index, "e").map((f) => f.id)).toEqual(["email", "tenant_id", "created_by", "order_id", "user_id"]);
    expect(searchFieldUsage(index, "e", { keysOnly: true }).map((f) => f.id)).toEqual(["tenant_id", "order_id", "user_id"]);
    expect(searchFieldUsage(index, "").map((f) => f.id)).toEqual(["id", "tenant_id"]);
  });
});

describe("usageCoverage", () => {
  const index = fieldUsage(DOC);

  it("counts the tables carrying any chosen key, and says which fields each carries", () => {
    const result = usageCoverage(index, ["tenant_id", "order_id"]);
    expect(result.covered.map((c) => c.nodeId)).toEqual(["users", "orders", "invoices"]);
    expect(result.covered.find((c) => c.nodeId === "invoices")!.carries).toEqual([
      { nodeId: "invoices", fieldId: "TENANT_ID" },
      { nodeId: "invoices", fieldId: "order_id" },
    ]);
    expect(result.missing).toEqual(["tenants", "logs"]);
    expect(result.total).toBe(5);
    expect(result.fraction).toBeCloseTo(0.6);
    expect(result.perKey).toEqual(new Map([["tenant_id", 3], ["order_id", 1]]));
  });

  it("under 'all', only the tables carrying every chosen key", () => {
    const result = usageCoverage(index, ["tenant_id", "user_id"], { match: "all" });
    expect(result.covered.map((c) => c.nodeId)).toEqual(["orders"]);
    expect(result.fraction).toBeCloseTo(0.2);
  });

  it("can count the tables a key points at, too", () => {
    const result = usageCoverage(index, ["tenant_id"], { includeTargets: true });
    expect(result.covered.map((c) => c.nodeId)).toEqual(["tenants", "users", "orders", "invoices"]);
    expect(result.covered[0]).toEqual({ nodeId: "tenants", carries: [], pointedAtBy: ["tenant_id"] });
    expect(result.perKey.get("tenant_id")).toBe(4);
  });

  it("counts nothing for no keys — under 'all' as well — and skips names it doesn't know", () => {
    for (const match of ["any", "all"] as const) {
      const result = usageCoverage(index, [], { match });
      expect(result.covered).toEqual([]);
      expect(result.fraction).toBe(0);
    }
    expect(usageCoverage(index, ["gone", "email"]).covered.map((c) => c.nodeId)).toEqual(["users"]);
  });
});

describe("fieldUsage — consistency", () => {
  const table = (id: string, fields: Array<Record<string, unknown>>, model: Record<string, unknown> = {}) => ({
    id, label: id, fields: fields.map((f) => ({ id: String(f.name), name: String(f.name) })), data: { model: { fields, ...model } },
  });
  const DRIFT = {
    nodes: [
      table("a", [{ name: "id", type: "uuid", primaryKey: true }, { name: "tenant_id", type: "uuid", nullable: false }]),
      table("b", [{ name: "id", type: "uuid", primaryKey: true }, { name: "tenant_id", type: "UUID", nullable: false }]),
      table("c", [{ name: "id", type: "uuid", primaryKey: true }, { name: "tenant_id", type: "varchar(36)", nullable: true }]),
      table("d", [{ name: "id", type: "uuid", primaryKey: true }, { name: "tenant_id" }], { fieldsTruncated: true }),
    ],
    edges: [],
  };

  it("lists each type a name is stored as, most tables first, and says whether it is consistent", () => {
    const tenant = fieldUsage(DRIFT).byId.get("tenant_id")!;
    expect(tenant.variants.map((v) => [v.family, v.types, v.nullable, v.tables.map((t) => t.nodeId)])).toEqual([
      ["uuid", ["uuid", "UUID"], false, ["a", "b"]],
      ["untyped", [], "unknown", ["d"]],
      ["varchar", ["varchar(36)"], true, ["c"]],
    ]);
    expect(tenant.consistent).toBe(false);
    expect(inconsistencySummary(tenant)).toBe("2 types: uuid, varchar; nullable in some tables, required in others");
    expect(variantSummary(tenant.variants[0]!)).toBe("uuid · 2 tables · required");
    // A primary key never says anything about nullability; untyped tables say nothing about type.
    expect(fieldUsage(DRIFT).byId.get("id")!.consistent).toBe(true);
  });

  it("reports the tables whose field list was cut short", () => {
    expect(fieldUsage(DRIFT).truncated).toEqual(["d"]);
  });

  it("compares parameters only when strict", () => {
    const doc = { nodes: [table("a", [{ name: "code", type: "varchar(10)" }]), table("b", [{ name: "code", type: "varchar(20)" }])], edges: [] };
    expect(fieldUsage(doc).byId.get("code")!.consistent).toBe(true);
    expect(fieldUsage(doc, { strictTypes: true }).byId.get("code")!.consistent).toBe(false);
  });

  it("finds every inconsistent name on request, typed or not", () => {
    const index = fieldUsage(DRIFT);
    expect(searchFieldUsage(index, "", { inconsistentOnly: true }).map((f) => f.id)).toEqual(["tenant_id"]);
    expect(searchFieldUsage(index, "id", { inconsistentOnly: true }).map((f) => f.id)).toEqual(["tenant_id"]);
  });

  it("words a score the same for every panel", () => {
    expect(usageHeadline({ covered: [{ nodeId: "a", carries: [], pointedAtBy: [] }], total: 9 }, "any", 2)).toBe("1 of 9 tables use them");
    expect(usageHeadline({ covered: [], total: 1 }, "all", 2)).toBe("0 of 1 table have all of them");
  });
});
