/**
 * field-tags.test.ts — a row's tags: what validation keeps, what the data
 * bag implies for a row that was never drawn, and what the folder importer
 * reads them from.
 */
import { describe, expect, it } from "vitest";
import { FIELD_TAG_HIDDEN, FIELD_TAG_RO, MAX_FIELD_TAGS, fieldTagBadge, validateTemplate } from "./schema";
import { dataFieldTags, fieldRecords } from "./fields";
import { fieldTags, toNodeField } from "./folder/dialects/datamodel/fields";

const table = (fields: unknown[], data?: Record<string, unknown>) =>
  validateTemplate({
    version: 1,
    nodes: [{ id: "t", label: "T", kind: "table", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 230, h: 96, fields, ...(data ? { data } : {}) }],
    edges: [],
  }).nodes[0]!;

describe("row tags through validation", () => {
  it("keeps trimmed, de-duplicated tags and drops the key when none survive", () => {
    const n = table([
      { id: "a", name: "a", tags: [" ro ", "pii", "ro", "", 7] },
      { id: "b", name: "b", tags: [] },
      { id: "c", name: "c", tags: "ro" },
    ]);
    expect(n.fields![0]!.tags).toEqual(["ro", "pii"]);
    expect("tags" in n.fields![1]!).toBe(false);
    expect("tags" in n.fields![2]!).toBe(false);
  });

  it("caps a runaway list", () => {
    const n = table([{ id: "a", name: "a", tags: Array.from({ length: 20 }, (_, i) => `t${i}`) }]);
    expect(n.fields![0]!.tags).toHaveLength(MAX_FIELD_TAGS);
  });

  it("badges every tag in uppercase except hidden, which dims the row instead", () => {
    expect(fieldTagBadge(FIELD_TAG_RO)).toBe("RO");
    expect(fieldTagBadge("pii")).toBe("PII");
    expect(fieldTagBadge(FIELD_TAG_HIDDEN)).toBeNull();
  });
});

describe("row tags from the data bag", () => {
  it("implies ro and hidden from the access flags, after the field's own tags", () => {
    expect(dataFieldTags({ name: "a", updateable: false, visible: false, tags: ["pii"] })).toEqual(["pii", "ro", "hidden"]);
    expect(dataFieldTags({ name: "a", createable: false })).toEqual([]);
    expect(dataFieldTags({ name: "a", updateable: false, tags: ["ro"] })).toEqual(["ro"]);
  });

  it("a drawn row keeps its own tags; an undrawn field reads them from the bag", () => {
    const n = table([{ id: "a", name: "a", tags: ["pii"] }], {
      model: { fields: [{ name: "a", updateable: false }, { name: "b", visible: false }] },
    });
    const records = fieldRecords(n);
    expect(records.find((r) => r.id === "a")!.tags).toEqual(["pii"]);
    expect(records.find((r) => r.id === "b")!.tags).toEqual(["hidden"]);
  });
});

describe("row tags from a data-model folder", () => {
  it("reads ro from updateable, hidden from visible, and the field's own tags verbatim", () => {
    expect(fieldTags({ name: "a", type: "string", updateable: false, visible: false, tags: ["pii", " pii"] })).toEqual(["pii", "ro", "hidden"]);
    expect(fieldTags({ name: "a", type: "string", createable: false })).toEqual([]);
    expect(toNodeField({ name: "a", type: "string", updateable: false }).tags).toEqual(["ro"]);
    expect("tags" in toNodeField({ name: "a", type: "string" })).toBe(false);
  });
});
