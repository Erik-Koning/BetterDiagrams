/**
 * field-records.test.ts — rows merged with what the data bag knows about
 * them: `fieldRecords`, the anchor rule, the index and the search.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  apiNameIndex,
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
  sameFieldRef,
  searchFields,
} from "./fields";
import { readFolderToFileMap } from "./folder/node";
import { importFolder } from "./folder/import";

const contact = {
  id: "contact",
  label: "Contact",
  fields: [
    { id: "Id", name: "Id", key: "pk" as const },
    { id: "AccountId", name: "AccountId", type: "→ Account", key: "fk" as const },
  ],
  data: {
    sf: {
      shape: "object",
      apiName: "Contact",
      fields: [
        { name: "Id", type: "id", nillable: false },
        { name: "AccountId", label: "Account ID", type: "reference", relationship: { kind: "lookup", referenceTo: ["Account"] } },
        { name: "Email", label: "Email", type: "email", nillable: true, visibleToIntegrationUser: false },
        { name: "Region__c", type: "reference", relationship: { kind: "lookup", referenceTo: ["Region__c"] } },
        { name: "Score__c", type: "double", formula: "Amount__c * 2", unique: true, externalId: true, nillable: false },
      ],
    },
  },
};
const account = {
  id: "account",
  label: "Account",
  fields: [{ id: "Id", name: "Id" }],
  data: { sf: { shape: "object", apiName: "Account" } },
};
const stub = { id: "_external/region__c", label: "Region__c", data: { sf: { shape: "external", apiName: "Region__c" } } };
const doc = {
  nodes: [contact, account, stub],
  edges: [
    { id: "contact::AccountId::account", source: "contact", target: "account", startField: "AccountId", endField: "Id" },
    // A dropped anchor: the dialect still knows the field.
    { id: "contact::Region__c::stub", source: "contact", target: "_external/region__c", data: { sf: { field: "Region__c" } } },
    { id: "alias", source: "contact", target: "account", data: { sf: { kind: "alias" } } },
  ],
};

describe("fieldRecords", () => {
  it("lists rows first, then data-only fields, and says which is which", () => {
    const records = fieldRecords(contact, doc);
    expect(records.map((r) => [r.id, r.row])).toEqual([
      ["Id", true],
      ["AccountId", true],
      ["Email", false],
      ["Region__c", false],
      ["Score__c", false],
    ]);
    const byId = Object.fromEntries(records.map((r) => [r.id, r]));
    // The row's own type/key win; the data field fills in the rest.
    expect(byId.AccountId).toMatchObject({ label: "Account ID", type: "→ Account", key: "fk" });
    expect(byId.Email).toEqual({
      id: "Email", name: "Email", label: "Email", type: "email", row: false, fk: [], visibleToIntegrationUser: false,
    });
    expect(byId.Score__c).toMatchObject({ required: true, unique: true, externalId: true, formula: "Amount__c * 2", type: "double" });
    expect(byId.Id).toMatchObject({ key: "pk" });
    expect(byId.Id.required).toBeUndefined();
  });

  it("resolves reference targets from anchored edges and from the api-name index", () => {
    const byId = Object.fromEntries(fieldRecords(contact, doc).map((r) => [r.id, r]));
    expect(byId.AccountId.fk).toEqual([{ label: "Account", nodeId: "account", edgeId: "contact::AccountId::account" }]);
    // The dropped anchor still resolves through data.sf.field; the stub is a node.
    expect(byId.Region__c.fk).toEqual([
      { label: "Region__c", nodeId: "_external/region__c", edgeId: "contact::Region__c::stub" },
    ]);
    // Without a document, targets are labels only.
    expect(fieldRecords(contact).find((r) => r.id === "AccountId")!.fk).toEqual([{ label: "Account" }]);
    expect(apiNameIndex(doc)).toEqual(
      new Map([["Contact", "contact"], ["Account", "account"], ["Region__c", "_external/region__c"]]),
    );
  });

  it("edgeFieldIds: row anchors first, the dialect's field as fallback, nothing for an alias", () => {
    expect(edgeFieldIds(doc.edges[0])).toEqual({ start: "AccountId", end: "Id" });
    expect(edgeFieldIds(doc.edges[1])).toEqual({ start: "Region__c", end: "Id" });
    expect(edgeFieldIds(doc.edges[2])).toEqual({});
    expect(fieldOutEdges(doc, { nodeId: "contact", fieldId: "Region__c" }).map((e) => e.id)).toEqual([
      "contact::Region__c::stub",
    ]);
    expect(fieldInEdges(doc, { nodeId: "account", fieldId: "Id" }).map((e) => e.id)).toEqual([
      "contact::AccountId::account",
    ]);
  });

  it("reads older documents through fieldMeta, and a host's data.fields", () => {
    const legacy = {
      id: "n",
      fields: [{ id: "Key__c", name: "Key__c" }],
      data: { sf: { fieldMeta: { Key__c: { label: "Key", externalId: true } } } },
    };
    expect(dataFields(legacy)).toEqual([{ name: "Key__c", label: "Key", externalId: true }]);
    const host = { id: "h", data: { fields: [{ name: "a", type: "int" }, { nope: true }] } };
    expect(dataFields(host)).toEqual([{ name: "a", type: "int" }]);
    expect(dataFields({ id: "plain" })).toEqual([]);
  });

  it("keyFields lists every referencing field with the edges it carries; edgeKeyOf names a hop's key", () => {
    expect(keyFields(doc)).toEqual([
      { ref: { nodeId: "contact", fieldId: "AccountId" }, edges: ["contact::AccountId::account"], targets: ["account"] },
      { ref: { nodeId: "contact", fieldId: "Region__c" }, edges: ["contact::Region__c::stub"], targets: ["_external/region__c"] },
    ]);
    expect(edgeKeyOf(doc.edges[0])).toBe("AccountId");
    expect(edgeKeyOf(doc.edges[1])).toBe("Region__c");
    expect(edgeKeyOf(doc.edges[2])).toBeUndefined();
    // A polymorphic key carries several edges; they fold into one key.
    const poly = { nodes: doc.nodes, edges: [
      { id: "a", source: "contact", target: "account", startField: "WhatId" },
      { id: "b", source: "contact", target: "_external/region__c", startField: "WhatId" },
    ] };
    expect(keyFields(poly)).toEqual([{ ref: { nodeId: "contact", fieldId: "WhatId" }, edges: ["a", "b"], targets: ["account", "_external/region__c"] }]);
    // A table pin is a valid ref to hasField/fieldKey too.
    expect(hasField(doc, { nodeId: "contact" })).toBe(true);
    expect(hasField(doc, { nodeId: "gone" })).toBe(false);
    expect(fieldKey({ nodeId: "a" })).toBe(`a${String.fromCharCode(0)}`);
    expect(sameFieldRef({ nodeId: "a" }, { nodeId: "a", fieldId: "" })).toBe(true);
  });

  it("hasField, fieldKey and sameFieldRef", () => {
    expect(hasField(doc, { nodeId: "contact", fieldId: "AccountId" })).toBe(true);
    expect(hasField(doc, { nodeId: "contact", fieldId: "Email" })).toBe(true);
    expect(hasField(doc, { nodeId: "contact", fieldId: "Nope" })).toBe(false);
    expect(hasField(doc, { nodeId: "gone", fieldId: "Id" })).toBe(false);
    expect(fieldKey({ nodeId: "a", fieldId: "b" })).toBe(`a${String.fromCharCode(0)}b`);
    expect(sameFieldRef({ nodeId: "a", fieldId: "b" }, { nodeId: "a", fieldId: "b" })).toBe(true);
    expect(sameFieldRef({ nodeId: "a", fieldId: "b" }, { nodeId: "a", fieldId: "c" })).toBe(false);
  });

  it("searchFields matches name, label, type and formula, case-insensitively, with a limit", () => {
    const hit = (h: { nodeId: string; fieldId: string }) => `${h.nodeId}.${h.fieldId}`;
    expect(searchFields(doc, "account id").map(hit)).toEqual(["contact.AccountId"]);
    expect(searchFields(doc, "AMOUNT").map(hit)).toEqual(["contact.Score__c"]);
    expect(searchFields(doc, "email").map(hit)).toEqual(["contact.Email"]);
    expect(searchFields(doc, "id").map(hit)).toEqual(["contact.Id", "contact.AccountId", "account.Id"]);
    expect(searchFields(doc, "id", { limit: 2 })).toHaveLength(2);
    expect(searchFields(doc, "  ")).toEqual([]);
    expect(searchFields(buildFieldIndex(doc), "id")).toEqual(searchFields(doc, "id"));
    expect(searchFields(doc, "email")[0]).toMatchObject({ nodeLabel: "Contact", name: "Email", label: "Email", row: false });
  });

  it("covers every field of an imported object, rows or not", async () => {
    const files = await readFolderToFileMap(
      fileURLToPath(new URL("./folder/fixtures/sf-datamodel-mini", import.meta.url)),
    );
    const { template } = importFolder(files);
    const node = template.nodes.find((n) => n.id === "core/account")!;
    const records = fieldRecords(node, template);
    expect(records.map((r) => r.id)).toEqual([
      "Id", "Name", "OwnerId", "ParentId", "External_Key__c", "Industry", "Description",
    ]);
    expect(records.filter((r) => r.row)).toHaveLength(5);
    const parent = records.find((r) => r.id === "ParentId")!;
    expect(parent.fk).toEqual([{ label: "Account", nodeId: "core/account", edgeId: "core/account::ParentId::core/account" }]);
    // An audit FK hidden in "business" mode has no edge, but its target is still known by name.
    expect(records.find((r) => r.id === "OwnerId")!.fk).toEqual([{ label: "User" }]);
    expect(records.find((r) => r.id === "Description")).toMatchObject({ row: false, visibleToIntegrationUser: false });
  });
});
