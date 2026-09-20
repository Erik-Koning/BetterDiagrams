/**
 * field-records.test.ts — rows merged with what the data bag knows about
 * them: `fieldRecords`, the anchor rule, the index and the search.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  nameIndex,
  buildFieldIndex,
  dataFields,
  edgeFieldIds,
  edgeKeyOf,
  keyFields,
  fieldInEdges,
  fieldKey,
  fieldOutEdges,
  fieldRecords,
  hasField,
  referencedKey,
  sameFieldRef,
  searchFields,
} from "./fields";
import { readFolderToFileMap } from "./folder/node";
import { importFolder } from "./folder/import";

const contact = {
  id: "contact",
  label: "Contact",
  fields: [
    { id: "id", name: "id", key: "pk" as const },
    { id: "account_id", name: "account_id", type: "→ account", key: "fk" as const },
  ],
  data: {
    model: {
      shape: "entity",
      name: "contact",
      fields: [
        { name: "id", type: "id", primaryKey: true, nullable: false },
        { name: "account_id", label: "Account ID", type: "reference", relationship: { kind: "reference", referenceTo: ["account"] } },
        { name: "email", label: "Email", type: "email", nullable: true, visible: false },
        { name: "region_id", type: "reference", relationship: { kind: "reference", referenceTo: ["region"] } },
        { name: "score", type: "double", formula: "amount * 2", unique: true, externalId: true, nullable: false },
      ],
    },
  },
};
const account = {
  id: "account",
  label: "Account",
  fields: [{ id: "id", name: "id" }],
  data: { model: { shape: "entity", name: "account" } },
};
const stub = { id: "_external/region", label: "region", data: { model: { shape: "external", name: "region" } } };
const doc = {
  nodes: [contact, account, stub],
  edges: [
    { id: "contact::account_id::account", source: "contact", target: "account", startField: "account_id", endField: "id" },
    // A dropped anchor: the dialect still knows the field, and where it lands.
    { id: "contact::region_id::stub", source: "contact", target: "_external/region", data: { model: { field: "region_id", targetField: "id" } } },
    { id: "alias", source: "contact", target: "account", data: { model: { kind: "alias" } } },
  ],
};

describe("referencedKey", () => {
  it("is the row the reference's edge lands on", () => {
    const [target] = fieldRecords(contact, doc).find((f) => f.id === "account_id")!.fk;
    expect(referencedKey(doc, target)).toEqual({ nodeId: "account", fieldId: "id" });
  });

  it("falls back to the target's primary key, then its id row, with no edge to say", () => {
    const keyed = { nodes: [{ id: "t", fields: [{ id: "name", name: "name" }, { id: "key", name: "key", key: "pk" as const }] }], edges: [] };
    expect(referencedKey(keyed, { label: "T", nodeId: "t" })).toEqual({ nodeId: "t", fieldId: "key" });
    const named = { nodes: [{ id: "t", fields: [{ id: "name", name: "name" }, { id: "Id", name: "Id" }] }], edges: [] };
    expect(referencedKey(named, { label: "T", nodeId: "t" })).toEqual({ nodeId: "t", fieldId: "Id" });
  });

  it("is nothing for a target that isn't a node, or draws no key row", () => {
    expect(referencedKey(doc, { label: "region" })).toBeNull();
    const bare = { nodes: [{ id: "t", fields: [{ id: "name", name: "name" }] }], edges: [] };
    expect(referencedKey(bare, { label: "T", nodeId: "t" })).toBeNull();
  });
});

describe("fieldRecords", () => {
  it("lists rows first, then data-only fields, and says which is which", () => {
    const records = fieldRecords(contact, doc);
    expect(records.map((r) => [r.id, r.row])).toEqual([
      ["id", true],
      ["account_id", true],
      ["email", false],
      ["region_id", false],
      ["score", false],
    ]);
    const byId = Object.fromEntries(records.map((r) => [r.id, r]));
    // The row's own type/key win; the data field fills in the rest.
    expect(byId.account_id).toMatchObject({ label: "Account ID", type: "→ account", key: "fk" });
    expect(byId.email).toEqual({
      id: "email", name: "email", label: "Email", type: "email", row: false, fk: [], visible: false,
    });
    expect(byId.score).toMatchObject({ required: true, unique: true, externalId: true, formula: "amount * 2", type: "double" });
    expect(byId.id).toMatchObject({ key: "pk" });
    expect(byId.id.required).toBeUndefined();
  });

  it("derives the key and required from a data-only field: primaryKey → pk, a reference → fk, nullable: false → required", () => {
    const node = {
      id: "n",
      data: { model: { fields: [
        { name: "uuid", type: "uuid", primaryKey: true, nullable: false },
        { name: "owner_id", type: "reference", nullable: false, relationship: { referenceTo: ["user"] } },
        { name: "order_id", type: "reference", primaryKey: true, relationship: { referenceTo: ["order"] } },
        { name: "note", type: "string", nullable: true },
      ] } },
    };
    const byId = Object.fromEntries(fieldRecords(node).map((r) => [r.id, r]));
    expect(byId.uuid).toMatchObject({ key: "pk", type: "uuid" });
    expect(byId.uuid.required).toBeUndefined();
    expect(byId.owner_id).toMatchObject({ key: "fk", required: true, type: "→ user" });
    expect(byId.order_id).toMatchObject({ key: "pfk", type: "→ order" });
    expect(byId.note.key).toBeUndefined();
    expect(byId.note.required).toBeUndefined();
  });

  it("resolves reference targets from anchored edges and from the name index", () => {
    const byId = Object.fromEntries(fieldRecords(contact, doc).map((r) => [r.id, r]));
    expect(byId.account_id.fk).toEqual([{ label: "Account", nodeId: "account", edgeId: "contact::account_id::account" }]);
    // The dropped anchor still resolves through data.model.field; the stub is a node.
    expect(byId.region_id.fk).toEqual([
      { label: "region", nodeId: "_external/region", edgeId: "contact::region_id::stub" },
    ]);
    // Without a document, targets are labels only.
    expect(fieldRecords(contact).find((r) => r.id === "account_id")!.fk).toEqual([{ label: "account" }]);
    expect(nameIndex(doc)).toEqual(
      new Map([["contact", "contact"], ["account", "account"], ["region", "_external/region"]]),
    );
  });

  it("edgeFieldIds: row anchors first, the dialect's fields as fallback, nothing for an alias", () => {
    expect(edgeFieldIds(doc.edges[0])).toEqual({ start: "account_id", end: "id" });
    expect(edgeFieldIds(doc.edges[1])).toEqual({ start: "region_id", end: "id" });
    expect(edgeFieldIds(doc.edges[2])).toEqual({});
    // A dialect that recorded the field but not where it lands anchors one end only.
    expect(edgeFieldIds({ id: "x", source: "a", target: "b", data: { model: { field: "f" } } })).toEqual({ start: "f" });
    expect(fieldOutEdges(doc, { nodeId: "contact", fieldId: "region_id" }).map((e) => e.id)).toEqual([
      "contact::region_id::stub",
    ]);
    expect(fieldInEdges(doc, { nodeId: "account", fieldId: "id" }).map((e) => e.id)).toEqual([
      "contact::account_id::account",
    ]);
  });

  it("reads older documents through fieldMeta, and a host's data.fields", () => {
    const legacy = {
      id: "n",
      fields: [{ id: "key", name: "key" }],
      data: { model: { fieldMeta: { key: { label: "Key", externalId: true } } } },
    };
    expect(dataFields(legacy)).toEqual([{ name: "key", label: "Key", externalId: true }]);
    const host = { id: "h", data: { fields: [{ name: "a", type: "int" }, { nope: true }] } };
    expect(dataFields(host)).toEqual([{ name: "a", type: "int" }]);
    expect(dataFields({ id: "plain" })).toEqual([]);
  });

  it("keyFields lists every referencing field with the edges it carries; edgeKeyOf names a hop's key", () => {
    expect(keyFields(doc)).toEqual([
      { ref: { nodeId: "contact", fieldId: "account_id" }, edges: ["contact::account_id::account"], targets: ["account"] },
      { ref: { nodeId: "contact", fieldId: "region_id" }, edges: ["contact::region_id::stub"], targets: ["_external/region"] },
    ]);
    expect(edgeKeyOf(doc.edges[0])).toBe("account_id");
    expect(edgeKeyOf(doc.edges[1])).toBe("region_id");
    expect(edgeKeyOf(doc.edges[2])).toBeUndefined();
    // A polymorphic key carries several edges; they fold into one key.
    const poly = { nodes: doc.nodes, edges: [
      { id: "a", source: "contact", target: "account", startField: "related_id" },
      { id: "b", source: "contact", target: "_external/region", startField: "related_id" },
    ] };
    expect(keyFields(poly)).toEqual([{ ref: { nodeId: "contact", fieldId: "related_id" }, edges: ["a", "b"], targets: ["account", "_external/region"] }]);
    // A table pin is a valid ref to hasField/fieldKey too.
    expect(hasField(doc, { nodeId: "contact" })).toBe(true);
    expect(hasField(doc, { nodeId: "gone" })).toBe(false);
    expect(fieldKey({ nodeId: "a" })).toBe(`a${String.fromCharCode(0)}`);
    expect(sameFieldRef({ nodeId: "a" }, { nodeId: "a", fieldId: "" })).toBe(true);
  });

  it("hasField, fieldKey and sameFieldRef", () => {
    expect(hasField(doc, { nodeId: "contact", fieldId: "account_id" })).toBe(true);
    expect(hasField(doc, { nodeId: "contact", fieldId: "email" })).toBe(true);
    expect(hasField(doc, { nodeId: "contact", fieldId: "nope" })).toBe(false);
    expect(hasField(doc, { nodeId: "gone", fieldId: "id" })).toBe(false);
    expect(fieldKey({ nodeId: "a", fieldId: "b" })).toBe(`a${String.fromCharCode(0)}b`);
    expect(sameFieldRef({ nodeId: "a", fieldId: "b" }, { nodeId: "a", fieldId: "b" })).toBe(true);
    expect(sameFieldRef({ nodeId: "a", fieldId: "b" }, { nodeId: "a", fieldId: "c" })).toBe(false);
  });

  it("searchFields matches name, label, type and formula, case-insensitively, with a limit", () => {
    const hit = (h: { nodeId: string; fieldId: string }) => `${h.nodeId}.${h.fieldId}`;
    expect(searchFields(doc, "account id").map(hit)).toEqual(["contact.account_id"]);
    expect(searchFields(doc, "AMOUNT").map(hit)).toEqual(["contact.score"]);
    expect(searchFields(doc, "email").map(hit)).toEqual(["contact.email"]);
    expect(searchFields(doc, "id").map(hit)).toEqual(["contact.id", "contact.account_id", "contact.region_id", "account.id"]);
    expect(searchFields(doc, "id", { limit: 2 })).toHaveLength(2);
    expect(searchFields(doc, "  ")).toEqual([]);
    expect(searchFields(buildFieldIndex(doc), "id")).toEqual(searchFields(doc, "id"));
    expect(searchFields(doc, "email")[0]).toMatchObject({ nodeLabel: "Contact", name: "email", label: "Email", row: false });
  });

  it("covers every field of an imported entity, rows or not", async () => {
    const files = await readFolderToFileMap(
      fileURLToPath(new URL("./folder/fixtures/datamodel-mini", import.meta.url)),
    );
    const { template } = importFolder(files);
    const node = template.nodes.find((n) => n.id === "core/account")!;
    const records = fieldRecords(node, template);
    expect(records.map((r) => r.id)).toEqual([
      "id", "name", "owner_id", "parent_id", "external_key", "industry", "description",
    ]);
    expect(records.filter((r) => r.row)).toHaveLength(5);
    const parent = records.find((r) => r.id === "parent_id")!;
    expect(parent.fk).toEqual([{ label: "Account", nodeId: "core/account", edgeId: "core/account::parent_id::core/account" }]);
    // An audit FK hidden in "business" mode has no edge, but its target is still known by name.
    expect(records.find((r) => r.id === "owner_id")!.fk).toEqual([{ label: "user" }]);
    expect(records.find((r) => r.id === "description")).toMatchObject({ row: false, visible: false });
  });
});
