/**
 * dbt.test.ts — a dbt project's manifest and catalog, read into tables,
 * columns and keys, from constraints and from tests.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { importDbt, isDbtManifest } from "./dbt";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/dbt/${name}`, import.meta.url)), "utf8");
const manifest = read("manifest.json");
const catalog = read("catalog.json");

describe("importDbt", () => {
  const { template, warnings, stats } = importDbt({ manifest, catalog });
  const node = (id: string) => template.nodes.find((n) => n.id === id)!;
  const row = (id: string, field: string) => node(id).fields!.find((f) => f.id.toLowerCase() === field.toLowerCase())!;

  it("reads models, seeds and sources — not ephemeral models — grouped by schema, titled by the project", () => {
    expect(template.meta?.title).toBe("jaffle_shop");
    expect(template.nodes.filter((n) => n.kind === "table").map((n) => n.id)).toEqual([
      "marts.customers",
      "marts.orders",
      "marts.order_items",
      "marts.products",
      "marts.daily_revenue",
      "seeds.country_codes",
      "jaffle.raw_customers",
    ]);
    expect(template.nodes.filter((n) => n.kind === "group").map((n) => n.label)).toEqual(["marts", "seeds", "jaffle"]);
    expect(stats.tables).toBe(7);
    expect(warnings).toContainEqual({ message: "1 ephemeral model left out — they build nothing in the warehouse" });
  });

  it("takes column order and types from the catalog, descriptions and tags from the project", () => {
    expect(node("marts.customers").fields!.map((f) => [f.name, f.type])).toEqual([
      ["customer_id", "NUMBER"],
      ["FIRST_NAME", "TEXT"],
      ["email", "TEXT"],
      ["number_of_orders", "NUMBER"],
    ]);
    expect(row("marts.customers", "customer_id").description).toBe("The customer");
    // Without a catalog entry the project's declared types serve.
    expect(row("marts.order_items", "product_id").type).toBe("integer");
    expect(node("marts.customers").description).toBe("One row per customer");
    expect(node("marts.customers").tags).toEqual(["core"]);
    expect(node("marts.customers").data?.model).toMatchObject({ recordCount: 935 });
  });

  it("finds owners from meta and from the model's group, and tags columns whose meta says pii", () => {
    expect(node("marts.customers").team).toBe("Growth");
    expect(node("marts.orders").team).toBe("Finance");
    expect(row("marts.customers", "email").tags).toEqual(["pii"]);
    expect(row("jaffle.raw_customers", "id").tags).toEqual(["pii"]);
    // A column already tagged pii:… is not tagged again.
    expect(row("jaffle.raw_customers", "email").tags).toEqual(["pii:email"]);
  });

  it("reads keys from constraints, column- and model-level, in dbt 1.9's `to` form and the older `expression`", () => {
    expect(row("marts.orders", "order_id")).toMatchObject({ key: "pk", required: true });
    expect(node("marts.order_items").fields!.filter((f) => f.key).map((f) => [f.id, f.key])).toEqual([
      ["order_id", "pfk"],
      ["line_no", "pk"],
      ["product_id", "fk"],
    ]);
    const edge = (source: string, target: string) => template.edges.find((e) => e.source === source && e.target === target)!;
    expect(edge("marts.order_items", "marts.orders")).toMatchObject({ relation: "composition", startField: "order_id", endField: "order_id" });
    expect(edge("marts.order_items", "marts.products")).toMatchObject({ relation: "reference", startField: "product_id", endField: "product_id" });
  });

  it("reads keys from tests: unique + not_null is the key, relationships is a foreign key, a unique combination is a composite key", () => {
    expect(row("marts.customers", "customer_id")).toMatchObject({ key: "pk", required: true, unique: true });
    expect(row("marts.orders", "customer_id")).toMatchObject({ key: "fk", required: true });
    expect(template.edges.find((e) => e.source === "marts.orders")).toMatchObject({
      target: "marts.customers",
      relation: "reference",
      startField: "customer_id",
      endField: "customer_id",
      endLabel: "1",
    });
    expect(node("marts.daily_revenue").fields!.filter((f) => f.key === "pk").map((f) => f.id)).toEqual(["day", "currency"]);
    expect(warnings).toContainEqual({ message: "daily_revenue.currency: a relationships test to ref('currencies'), which the project doesn't build" });
  });

  it("works without a catalog, and refuses what is not a manifest", () => {
    const bare = importDbt({ manifest });
    expect(bare.template.nodes.find((n) => n.id === "marts.customers")!.fields!.map((f) => f.name)).toEqual(["customer_id", "email", "number_of_orders"]);
    expect(isDbtManifest(JSON.parse(manifest))).toBe(true);
    expect(isDbtManifest(JSON.parse(catalog))).toBe(false);
    expect(() => importDbt({ manifest: "{}" })).toThrow(/Not a dbt manifest/);
  });
});
