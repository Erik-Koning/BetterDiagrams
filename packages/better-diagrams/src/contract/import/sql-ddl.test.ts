/**
 * sql-ddl.test.ts — schema scripts from six databases, read into tables and
 * keys, and built into an editable document.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { importSqlDdl, looksLikeSqlDdl, parseSqlDdl } from "./sql-ddl";
import { buildTableModel } from "./table-model";
import { MAX_NODE_FIELDS } from "../schema";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}.sql`, import.meta.url)), "utf8");
const table = (sql: string, name: string) => parseSqlDdl(sql).tables.find((t) => t.name.toLowerCase() === name.toLowerCase())!;
const col = (sql: string, t: string, c: string) => table(sql, t).columns.find((x) => x.name.toLowerCase() === c.toLowerCase())!;

describe("pg_dump --schema-only", () => {
  const sql = fixture("postgres");

  it("reads tables, types, defaults, generated columns and keys added later", () => {
    const parsed = parseSqlDdl(sql);
    expect(parsed.tables.map((t) => `${t.schema}.${t.name}`)).toEqual(["public.customers", "sales.orders", "sales.order_lines", "public.products"]);
    expect(col(sql, "customers", "created_at")).toEqual({ name: "created_at", type: "timestamp with time zone", nullable: false, default: "now()" });
    expect(col(sql, "orders", "status")).toMatchObject({ type: "public.order_status", default: "'new'::public.order_status", nullable: false });
    expect(col(sql, "orders", "tags").type).toBe("text[]");
    expect(col(sql, "order_lines", "amount").generated).toBe(true);
    expect(table(sql, "order_lines").primaryKey).toEqual(["order_id", "line_no"]);
    expect(table(sql, "order_lines").foreignKeys).toEqual([
      { columns: ["order_id"], table: "sales.orders", refColumns: ["id"], name: "order_lines_order_id_fkey", onDelete: "cascade" },
      { columns: ["product_id"], table: "public.products", refColumns: ["id"], name: "order_lines_product_id_fkey" },
    ]);
  });

  it("takes descriptions from COMMENT ON and uniqueness from a unique index; a semicolon inside a function body splits nothing", () => {
    expect(table(sql, "customers").description).toBe("People who buy");
    expect(col(sql, "customers", "email").description).toBe("Login and receipts");
    expect(table(sql, "customers").uniques).toEqual([["email"]]);
    const parsed = parseSqlDdl(sql);
    expect(parsed.skipped).toMatchObject({ SET: 2, "CREATE FUNCTION": 1, "CREATE SEQUENCE": 1, "CREATE INDEX": 1, GRANT: 1 });
    expect(parsed.warnings).toEqual([{ message: "1 view skipped — a view has no columns of its own in the script" }]);
  });

  it("builds a document: a group per schema, rows with keys, lines dressed as the relationship they are", () => {
    const { template, stats } = importSqlDdl(sql);
    expect(stats).toEqual({ tables: 4, columns: 17, foreignKeys: 4, skipped: 12 });
    expect(template.nodes.filter((n) => n.kind === "group").map((n) => n.label)).toEqual(["public", "sales"]);
    const lines = template.nodes.find((n) => n.id === "sales.order_lines")!;
    expect(lines.parentId).toBe("schema-sales");
    expect(lines.fields!.map((f) => [f.id, f.key ?? "", f.required ?? false])).toEqual([
      ["order_id", "pfk", true],
      ["line_no", "pk", true],
      ["product_id", "fk", false],
      ["quantity", "", true],
      ["amount", "", false],
    ]);
    expect(lines.fields!.find((f) => f.id === "amount")!.derived).toBe(true);
    const byId = Object.fromEntries(template.edges.map((e) => [e.id, e]));
    // Part of the child's own key: it is named by its parent.
    expect(byId["sales.order_lines.order_id->sales.orders"]).toMatchObject({ relation: "composition", startField: "order_id", endField: "id", data: { model: { cascadeDelete: true, required: true } } });
    // A required foreign key lands on exactly one.
    expect(byId["sales.orders.customer_id->public.customers"]).toMatchObject({ relation: "reference", endLabel: "1", data: { model: { deleteConstraint: "restrict" } } });
    expect(byId["sales.order_lines.product_id->public.products"]).toMatchObject({ relation: "reference", endLabel: "0..1" });
    expect(byId["public.products.parent_id->public.products"]).toMatchObject({ relation: "hierarchy" });
    const customers = template.nodes.find((n) => n.id === "public.customers")!;
    expect(customers.description).toBe("People who buy");
    expect(customers.fields!.find((f) => f.id === "email")).toMatchObject({ unique: true, required: true, description: "Login and receipts" });
    expect(customers.data?.model).toEqual({ name: "public.customers", namespace: "public" });
  });

  it("is unplaced and sized to its rows, and the same script gives the same ids", () => {
    const a = importSqlDdl(sql).template;
    expect(a.nodes.every((n) => n.x === 0 && n.y === 0)).toBe(true);
    const lines = a.nodes.find((n) => n.id === "sales.order_lines")!;
    expect(lines.h).toBeGreaterThan(130);
    const b = importSqlDdl(sql).template;
    expect(b.nodes.map((n) => n.id)).toEqual(a.nodes.map((n) => n.id));
    expect(b.edges.map((e) => e.id)).toEqual(a.edges.map((e) => e.id));
  });
});

describe("mysqldump -d", () => {
  const sql = fixture("mysql");

  it("reads backticked names, inline keys and comments, and keeps a column called `key` a column", () => {
    expect(parseSqlDdl(sql).tables.map((t) => t.name)).toEqual(["customers", "orders"]);
    expect(col(sql, "customers", "id").type).toBe("int unsigned");
    expect(col(sql, "customers", "email")).toMatchObject({ type: "varchar(255)", nullable: false, description: "Login" });
    expect(col(sql, "customers", "key")).toMatchObject({ type: "varchar(32)", default: "NULL" });
    expect(col(sql, "orders", "status")).toMatchObject({ type: "enum('new','paid')", default: "'new'" });
    expect(col(sql, "orders", "note").description).toBe("Free text, can't be searched");
    expect(table(sql, "customers")).toMatchObject({ description: "People who buy", primaryKey: ["id"], uniques: [["email"]] });
    expect(table(sql, "orders").foreignKeys).toEqual([{ columns: ["customer_id"], table: "customers", refColumns: ["id"], name: "orders_customer_id_foreign", onDelete: "cascade" }]);
    expect(parseSqlDdl(sql).skipped).toEqual({ "DROP TABLE": 2 });
  });
});

describe("SQL Server scripts", () => {
  const sql = fixture("sqlserver");

  it("splits on GO, reads bracketed names, computed columns, keys added with WITH CHECK, and MS_Description", () => {
    expect(parseSqlDdl(sql).tables.map((t) => `${t.schema}.${t.name}`)).toEqual(["dbo.Customers", "dbo.Orders"]);
    expect(col(sql, "Customers", "Email").type).toBe("nvarchar(255)");
    expect(col(sql, "Customers", "DisplayName")).toEqual({ name: "DisplayName", generated: true });
    expect(col(sql, "Orders", "PlacedAt")).toMatchObject({ type: "datetime2(7)", nullable: true });
    expect(table(sql, "Orders").foreignKeys).toEqual([{ columns: ["CustomerId"], table: "dbo.Customers", refColumns: ["Id"], name: "FK_Orders_Customers" }]);
    expect(table(sql, "Orders").description).toBe("Every order ever placed");
    expect(col(sql, "Orders", "CustomerId").description).toBe("Who placed it");
    const { template } = importSqlDdl(sql);
    expect(template.edges.map((e) => [e.source, e.target, e.startField, e.endField])).toEqual([["dbo.orders", "dbo.customers", "CustomerId", "Id"]]);
  });
});

describe("Snowflake GET_DDL", () => {
  const sql = fixture("snowflake");

  it("drops the database from a three-part name, and reads masking policies past", () => {
    const parsed = parseSqlDdl(sql);
    expect(parsed.tables.map((t) => `${t.schema}.${t.name}`)).toEqual(["CORE.CUSTOMERS", "CORE.ORDERS"]);
    expect(col(sql, "CUSTOMERS", "SSN")).toEqual({ name: "SSN", type: "VARCHAR(11)" });
    expect(col(sql, "CUSTOMERS", "EMAIL").description).toBe("Login");
    expect(table(sql, "CUSTOMERS").description).toBe("People who buy");
    const { template } = importSqlDdl(sql);
    expect(template.edges).toHaveLength(1);
    expect(template.edges[0]).toMatchObject({ source: "core.orders", target: "core.customers", relation: "reference", endLabel: "0..1" });
    // One schema: no group.
    expect(template.nodes.some((n) => n.kind === "group")).toBe(false);
  });
});

describe("BigQuery", () => {
  const sql = fixture("bigquery");

  it("reads project.dataset.table names, STRUCT and ARRAY types, OPTIONS descriptions, and says what a query-built table lacks", () => {
    expect(col(sql, "customers", "address").type).toBe("STRUCT<street STRING,city STRING,zip STRING>");
    expect(col(sql, "customers", "tags").type).toBe("ARRAY<STRING>");
    expect(col(sql, "customers", "id").description).toBe("Surrogate key");
    expect(table(sql, "customers").description).toBe("People who buy");
    expect(table(sql, "orders").foreignKeys).toEqual([{ columns: ["customer_id"], table: "shop-prod.sales.customers", refColumns: ["id"] }]);
    expect(parseSqlDdl(sql).warnings).toEqual([{ line: 19, message: "shop-prod.sales.daily is created from a query; its columns are not in the script" }]);
    expect(importSqlDdl(sql).template.edges.map((e) => [e.source, e.target])).toEqual([["sales.orders", "sales.customers"]]);
  });
});

describe("SQLite", () => {
  const sql = fixture("sqlite");

  it("reads untyped columns, inline REFERENCES, and a column called `period`", () => {
    expect(table(sql, "albums").columns.map((c) => c.name)).toEqual(["id", "artist_id", "title", "period"]);
    expect(col(sql, "albums", "title")).toEqual({ name: "title" });
    expect(table(sql, "albums").foreignKeys).toEqual([{ columns: ["artist_id"], table: "artists", refColumns: ["id"], onDelete: "cascade" }]);
    expect(table(sql, "albums").uniques).toEqual([["title"]]);
    expect(importSqlDdl(sql).template.nodes.map((n) => n.id)).toEqual(["artists", "albums"]);
  });
});

describe("telling DDL from other text", () => {
  it("knows a script that creates or alters a table", () => {
    expect(looksLikeSqlDdl("-- dump\nCREATE TABLE t (id int);")).toBe(true);
    expect(looksLikeSqlDdl("create or replace transient table x (a int)")).toBe(true);
    expect(looksLikeSqlDdl("ALTER TABLE t ADD CONSTRAINT pk PRIMARY KEY (id)")).toBe(true);
    expect(looksLikeSqlDdl('{"nodes": [], "edges": [], "note": "CREATE TABLE"}')).toBe(false);
    expect(looksLikeSqlDdl("A web app talks to a database")).toBe(false);
  });
});

describe("buildTableModel", () => {
  it("warns about a key to a table the source never defines, and draws no line for it", () => {
    const r = buildTableModel([{ name: "orders", columns: [{ name: "id" }, { name: "region_id" }], primaryKey: ["id"], foreignKeys: [{ columns: ["region_id"], table: "regions" }] }]);
    expect(r.template.edges).toEqual([]);
    expect(r.warnings).toEqual([{ message: "orders.region_id references regions, which the source doesn't define" }]);
    expect(r.template.nodes[0]!.fields!.find((f) => f.id === "region_id")!.key).toBe("fk");
  });

  it("marks a one-to-one key, resolves an unqualified reference through the default schema, and keeps a composite key's columns", () => {
    const r = buildTableModel([
      { schema: "public", name: "users", columns: [{ name: "id" }], primaryKey: ["id"] },
      { schema: "app", name: "profiles", columns: [{ name: "user_id", nullable: false, unique: true }], primaryKey: ["user_id"], foreignKeys: [{ columns: ["user_id"], table: "users" }] },
      { schema: "app", name: "pairs", columns: [{ name: "a" }, { name: "b" }, { name: "x" }, { name: "y" }], foreignKeys: [{ columns: ["x", "y"], table: "pairs", refColumns: ["a", "b"] }] },
    ]);
    const [oneToOne, composite] = r.template.edges;
    expect(oneToOne).toMatchObject({ source: "app.profiles", target: "public.users", relation: "composition", startLabel: "0..1" });
    expect(composite).toMatchObject({ relation: "hierarchy", startField: "x", endField: "a", data: { model: { columns: ["x", "y"], targetColumns: ["a", "b"] } } });
  });

  it("keeps the first rows of a very wide table and says so", () => {
    const columns = Array.from({ length: MAX_NODE_FIELDS + 20 }, (_, i) => ({ name: `c${i}` }));
    const r = buildTableModel([{ name: "wide", columns }]);
    const node = r.template.nodes[0]!;
    expect(node.fields).toHaveLength(MAX_NODE_FIELDS);
    expect(node.data?.model).toMatchObject({ fieldsTruncated: true, fieldsTotal: MAX_NODE_FIELDS + 20 });
    expect(r.warnings[0]!.message).toContain(`keeps the first ${MAX_NODE_FIELDS}`);
  });
});

/**
 * Shapes found in real scripts (Sakila in four dialects, Pagila, Microsoft's
 * AdventureWorks) that the fixtures above didn't have.
 */
describe("what real scripts do", () => {
  it("reads two CREATE TABLEs with no GO or semicolon between them", () => {
    const sql = "CREATE TABLE film_text (\n  film_id INT NOT NULL,\n  PRIMARY KEY NONCLUSTERED (film_id),\n)\n\nCREATE TABLE inventory (\n  inventory_id INT NOT NULL IDENTITY,\n  film_id INT NOT NULL\n)\nGO\n";
    expect(parseSqlDdl(sql).tables.map((t) => t.name)).toEqual(["film_text", "inventory"]);
  });

  it("reads every constraint one ADD carries, comma-separated", () => {
    const sql = `CREATE TABLE [Sales].[Header] ([Id] int, [BillTo] int, [ShipTo] int)
GO
CREATE TABLE [Person].[Address] ([AddressID] int)
GO
ALTER TABLE [Sales].[Header] ADD
    CONSTRAINT [FK_Bill] FOREIGN KEY ([BillTo]) REFERENCES [Person].[Address]([AddressID]),
    CONSTRAINT [FK_Ship] FOREIGN KEY ([ShipTo]) REFERENCES [Person].[Address]([AddressID]);
GO`;
    expect(table(sql, "Header").foreignKeys!.map((f) => f.columns[0])).toEqual(["BillTo", "ShipTo"]);
  });

  it("reads MS_Description given by position, with bracketed names, past a byte-order mark", () => {
    const sql = `﻿CREATE TABLE [Person].[Address] ([AddressID] int, [City] nvarchar(30))
GO
EXECUTE [sys].[sp_addextendedproperty] N'MS_Description', N'Street address information', N'SCHEMA', [Person], N'TABLE', [Address], NULL, NULL;
EXECUTE [sys].[sp_addextendedproperty] N'MS_Description', N'Name of the city.', N'SCHEMA', [Person], N'TABLE', [Address], N'COLUMN', [City];
GO`;
    expect(table(sql, "Address").description).toBe("Street address information");
    expect(col(sql, "Address", "City").description).toBe("Name of the city.");
  });

  it("leaves out MySQL's DELIMITER blocks — and the temporary table a procedure makes — counting them", () => {
    const sql = `CREATE TABLE customer (customer_id INT PRIMARY KEY);
DELIMITER ;;
CREATE PROCEDURE rewards_report(IN min_purchases INT)
BEGIN
    CREATE TEMPORARY TABLE tmpCustomer (customer_id INT UNSIGNED NOT NULL PRIMARY KEY);
    INSERT INTO tmpCustomer (customer_id) SELECT 1;
END ;;
DELIMITER ;
CREATE TABLE payment (payment_id INT PRIMARY KEY);`;
    const parsed = parseSqlDdl(sql);
    expect(parsed.tables.map((t) => t.name)).toEqual(["customer", "payment"]);
    expect(parsed.skipped).toEqual({ "CREATE PROCEDURE": 1 });
    expect(parseSqlDdl("CREATE TEMPORARY TABLE t (a int); CREATE TABLE #scratch (a int);").skipped).toEqual({ "CREATE TEMPORARY TABLE": 2 });
  });

  it("folds partitions into their table, carrying up keys declared only on the partitions", () => {
    const pagila = `CREATE TABLE public.customer (customer_id integer NOT NULL);
CREATE TABLE public.payment (payment_id integer NOT NULL, customer_id integer NOT NULL, payment_date timestamp NOT NULL) PARTITION BY RANGE (payment_date);
CREATE TABLE public.payment_p2022_01 (payment_id integer NOT NULL, customer_id integer NOT NULL, payment_date timestamp NOT NULL);
CREATE TABLE public.payment_p2022_02 PARTITION OF public.payment FOR VALUES FROM ('2022-02-01') TO ('2022-03-01');
ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_01 FOR VALUES FROM ('2022-01-01') TO ('2022-02-01');
ALTER TABLE ONLY public.payment_p2022_01 ADD CONSTRAINT payment_p2022_01_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(customer_id);`;
    const parsed = parseSqlDdl(pagila);
    expect(parsed.tables.map((t) => t.name)).toEqual(["customer", "payment"]);
    expect(table(pagila, "payment").foreignKeys).toEqual([{ columns: ["customer_id"], table: "public.customer", refColumns: ["customer_id"] }]);
    expect(parsed.warnings).toContainEqual({ message: "2 partitions of payment folded into it" });
  });

  it("treats an INHERITS child with no columns as a partition, and one with columns as a subtype that starts with its parent's", () => {
    const sql = `CREATE TABLE payment (payment_id int PRIMARY KEY, amount numeric);
CREATE TABLE payment_p2007_01 (CONSTRAINT p_check CHECK (amount > 0)) INHERITS (payment);
CREATE TABLE refund (reason text) INHERITS (payment);`;
    expect(parseSqlDdl(sql).tables.map((t) => t.name)).toEqual(["payment", "refund"]);
    expect(table(sql, "refund").columns.map((c) => c.name)).toEqual(["payment_id", "amount", "reason"]);
  });
});
