/**
 * dictionary.test.ts — the model as a document, and the governance numbers.
 */
import { describe, expect, it } from "vitest";
import { dataDictionary, dictionaryCsv, dictionaryMarkdown, governanceReport } from "./dictionary";

const DOC = {
  nodes: [
    {
      id: "customers", label: "Customers", description: "People who buy", team: "Sales",
      fields: [
        { id: "id", name: "id", key: "pk" as const, type: "uuid" },
        { id: "email", name: "email", type: "text", tags: ["pii:email"], description: "Where receipts go" },
      ],
      data: { model: { shape: "entity", name: "customer", recordCount: 1200 } },
    },
    {
      id: "orders", label: "Orders", team: "Sales",
      fields: [{ id: "id", name: "id", key: "pk" as const }, { id: "customer_id", name: "customer_id", key: "fk" as const }],
    },
    { id: "items", label: "Items", fields: [{ id: "id", name: "id", key: "pk" as const }, { id: "order_id", name: "order_id", key: "fk" as const }] },
    { id: "audit", label: "Audit | log", fields: [{ id: "id", name: "id" }], data: { model: { shape: "entity", name: "audit", fieldsTruncated: true } } },
    { id: "enum", label: "Status", kind: "enum", fields: [{ id: "open", name: "open" }] },
  ],
  edges: [
    { id: "o-c", source: "orders", target: "customers", startField: "customer_id", endField: "id" },
    { id: "i-o", source: "items", target: "orders", startField: "order_id", endField: "id" },
  ],
};

describe("dataDictionary", () => {
  it("lists every table — never an enum — with its facts and fields", () => {
    const tables = dataDictionary(DOC);
    expect(tables.map((t) => t.nodeId)).toEqual(["customers", "orders", "items", "audit"]);
    expect(tables[0]).toMatchObject({ name: "customer", label: "Customers", description: "People who buy", owner: "Sales", recordCount: 1200, truncated: false });
    expect(tables[3]!.truncated).toBe(true);
  });

  it("renders Markdown and CSV, escaping what would break them", () => {
    const md = dictionaryMarkdown(dataDictionary(DOC));
    expect(md).toContain("## Customers (`customer`)");
    expect(md).toContain("Owner: Sales · Rows: 1,200");
    expect(md).toContain("| email |  | text |  |  |  | pii:email | Where receipts go |");
    expect(md).toContain("## Audit \\| log");
    const csv = dictionaryCsv(dataDictionary(DOC));
    expect(csv.split("\r\n")[0]).toBe("Table,Table name,Owner,Field,Label,Type,Key,Required,References,Tags,Description");
    expect(csv).toContain("Orders,Orders,Sales,customer_id,,,FK,,Customers,,");
  });
});

describe("governanceReport", () => {
  const r = governanceReport(DOC);

  it("counts what is documented and who owns what", () => {
    expect(r.documentation).toEqual({ tables: 4, tablesDescribed: 1, fields: 7, fieldsDescribed: 1, fieldsLabelled: 0 });
    expect(r.ownership).toEqual({ tablesOwned: 2, byOwner: [{ owner: "Sales", tables: ["customers", "orders"] }], unowned: ["items", "audit"] });
  });

  it("finds sensitive columns by tag, and the tables within reach of them", () => {
    expect(r.sensitivity).toEqual([{ tag: "pii:email", fields: [{ nodeId: "customers", fieldId: "email" }] }]);
    expect(r.exposure).toEqual([
      { nodeId: "orders", hops: 1, nearest: { nodeId: "customers", fieldId: "email" } },
      { nodeId: "items", hops: 2, nearest: { nodeId: "customers", fieldId: "email" } },
    ]);
    expect(governanceReport(DOC, { exposureDepth: 1 }).exposure.map((x) => x.nodeId)).toEqual(["orders"]);
    expect(r.incomplete).toEqual(["audit"]);
  });
});
