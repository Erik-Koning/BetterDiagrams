/**
 * folder.test.ts — the data-model dialect against the synthetic
 * fixture, and the engine behaviour around it (sidecars, overrides, order).
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFolderToFileMap } from "./node";
import { buildFolderTree } from "./tree";
import { importFolder, detectDialect, AUTO_FOLD_NODES } from "./import";
import { exportFolder, treeFiles } from "./export";
import { LAYOUT_FILE, OVERRIDES_FILE } from "./sidecar";
import { OVERRIDES_FORMAT } from "./types";
import { classifyDataModelShape, DATAMODEL_DIALECT_ID } from "./dialects/datamodel";
import { isForensics } from "./dialects/datamodel/shapes";
import { validateTemplate, type DiagramTemplate } from "../schema";
import { splitTemplate } from "../presentation";
import { autoLayout } from "../layout";
import { keyCoverage, minimalKeyCover } from "../coverage";
import { drillableIds } from "../scope";
import { validatePresentation } from "../presentation";
import type { FileMap, FolderImportOptions } from "./types";

const FIXTURE = fileURLToPath(new URL("./fixtures/datamodel-mini", import.meta.url));

let cached: FileMap | null = null;
async function fixture(): Promise<FileMap> {
  cached ??= await readFolderToFileMap(FIXTURE);
  return cached;
}
async function imported(opts: FolderImportOptions = {}) {
  return importFolder(await fixture(), opts);
}
const byId = (t: DiagramTemplate, id: string) => t.nodes.find((n) => n.id === id);
const edgesFrom = (t: DiagramTemplate, id: string) => t.edges.filter((e) => e.source === id);

describe("the Node adapter", () => {
  it("reads the fixture into a file map, skipping nothing it should keep", async () => {
    const files = await fixture();
    expect(files.has("schema.json")).toBe(true);
    expect(files.has("core/account/individuals/record-types/person/schema.json")).toBe(true);
    expect(files.has("README.md")).toBe(true);
    expect([...files.keys()].every((p) => !p.startsWith("/"))).toBe(true);
  });
});

describe("shape discrimination", () => {
  it("tells the six schema.json shapes apart, in the pinned order", async () => {
    const files = await fixture();
    const shape = (p: string) => classifyDataModelShape(JSON.parse(files.get(p)!));
    expect(shape("schema.json")).toBe("root");
    expect(shape("core/schema.json")).toBe("band");
    expect(shape("ops/support/schema.json")).toBe("group");
    expect(shape("core/account/schema.json")).toBe("entity");
    expect(shape("core/account/individuals/record-types/person/schema.json")).toBe("record-type");
    expect(shape("core/account/individuals/schema.json")).toBe("view");
    expect(classifyDataModelShape({ nope: 1 })).toBe("unknown");
    expect(isForensics(JSON.parse(files.get("core/account/forensics.json")!))).toBe(true);
  });

  it("detects the dialect and never makes a node of forensics or metadata", async () => {
    const files = await fixture();
    const hit = detectDialect(buildFolderTree(files));
    expect(hit?.dialect.id).toBe(DATAMODEL_DIALECT_ID);
    const { template } = await imported();
    expect(template.nodes.some((n) => n.id.startsWith("metadata"))).toBe(false);
    expect(template.nodes.some((n) => /forensics/.test(n.id))).toBe(false);
    expect(byId(template, "core/account")!.data!.model).toMatchObject({ forensicsPath: "core/account/forensics.json" });
    expect((template.meta as { folderFormat: { crossCutting: string } }).folderFormat.crossCutting).toBe("metadata");
  });

  it("re-roots a tree whose paths all start with the dropped directory's name", async () => {
    const wrapped = new Map([...(await fixture())].map(([p, c]) => [`export-2026/${p}`, c]));
    const { template, dialect } = importFolder(wrapped);
    expect(dialect).toBe(DATAMODEL_DIALECT_ID);
    expect(byId(template, "core/account")).toBeTruthy();
  });
});

describe("pinned rows", () => {
  it("curated.diagramFields adds rows by name, and warns about a name the entity has no field for", async () => {
    const files = new Map(await fixture());
    const raw = JSON.parse(files.get("core/account/schema.json")!);
    raw.curated = { ...raw.curated, diagramFields: ["description", "no_such_field"] };
    files.set("core/account/schema.json", JSON.stringify(raw));
    const { template, warnings } = importFolder(files);
    const rows = byId(template, "core/account")!.fields!;
    const description = rows.find((f) => f.id === "description")!;
    expect(description.tags).toEqual(["hidden"]);
    expect(warnings).toContainEqual(expect.objectContaining({ code: "unknown-field", path: "core/account" }));
    // The pin is on top of the mode, never instead of it.
    expect(rows.some((f) => f.key === "pk")).toBe(true);
  });
});

describe("name index", () => {
  it("warns when two folders claim one name, and resolves references to the first", async () => {
    const files = new Map(await fixture());
    files.set(
      "ops/twin/schema.json",
      JSON.stringify({ folder: "ops/twin", entity: { name: "contact", label: "Twin" }, fields: [{ name: "id", type: "id" }] }),
    );
    const { template, warnings } = importFolder(files);
    expect(warnings.find((w) => w.code === "duplicate-name" && w.path === "ops/twin")).toBeTruthy();
    expect(template.edges.find((e) => e.id === "ops/support/case::contact_id::core/contact")).toBeTruthy();
  });
});

describe("nesting", () => {
  it("parents every node to its enclosing folder's node, to depth five", async () => {
    // Leaf record types: the deepest folders the fixture has.
    const { template } = await imported({ recordTypes: "nodes" });
    const parent = (id: string) => byId(template, id)?.parentId;
    expect(parent("core")).toBeNull();
    expect(parent("core/account")).toBe("core");
    expect(parent("core/account/individuals")).toBe("core/account");
    expect(parent("core/account/individuals/record-types")).toBe("core/account/individuals");
    expect(parent("core/account/individuals/record-types/person")).toBe("core/account/individuals/record-types");
    expect(parent("ops/support/case")).toBe("ops/support");
    expect(parent("ops/support/case/case-comment")).toBe("ops/support/case");
    expect(byId(template, "core/account/individuals/record-types/person")!.kind).toBe("record-type");
  });

  it("an entity under an entity is drill-in detail", async () => {
    const { template } = await imported();
    expect(drillableIds(template)).toContain("ops/support/case");
    expect(drillableIds(template)).toContain("core/account");
  });

  it("maps kinds from the curated diagram type, falling back to the entity kind", async () => {
    const { template } = await imported();
    expect(byId(template, "core/account")!.kind).toBe("entity-standard");
    expect(byId(template, "core/preference")!.kind).toBe("entity");
    expect(byId(template, "core/account/individuals")!.kind).toBe("view");
    expect(byId(template, "core")!.kind).toBe("group");
    expect(byId(template, "ops/support")!.kind).toBe("group");
  });

  it("falls back to entity.yaml when there is no schema.json, and says so", async () => {
    const { template, warnings } = await imported();
    const widget = byId(template, "ops/legacy-widget")!;
    expect(widget.label).toBe("Legacy Widget");
    expect(widget.kind).toBe("entity");
    expect(widget.tags).toEqual(["custom", "populated"]);
    expect(warnings.some((w) => w.code === "yaml-fallback-used" && w.path === "ops/legacy-widget")).toBe(true);
  });
});

describe("a plain folder structure", () => {
  it("reads a folder with no manifest as a group when it holds entities, and skips a leaf that says nothing", async () => {
    const files = new Map(await fixture());
    // A schema-less level: `warehouse/` with two entities inside, one of them another level down.
    files.set("warehouse/bins/schema.json", JSON.stringify({ folder: "warehouse/bins", entity: { name: "bin", label: "Bin" }, fields: [{ name: "id", type: "id" }, { name: "site_id", type: "reference", relationship: { kind: "reference", referenceTo: ["site"] } }], foreignKeys: [{ field: "site_id", kind: "reference", referenceTo: ["site"], relationshipName: null }] }));
    files.set("warehouse/sites/main/schema.json", JSON.stringify({ folder: "warehouse/sites/main", entity: { name: "site", label: "Site" }, fields: [{ name: "id", type: "id" }] }));
    files.set("warehouse/notes.txt", "not a node");
    files.set("warehouse/scratch/readme.txt", "nothing to draw");
    const { template, warnings } = importFolder(files, { edges: "all" });
    expect(byId(template, "warehouse")).toMatchObject({ kind: "group", label: "Warehouse", parentId: null });
    expect(byId(template, "warehouse/sites")).toMatchObject({ kind: "group", label: "Sites", parentId: "warehouse" });
    expect(byId(template, "warehouse/bins")).toMatchObject({ kind: "entity", parentId: "warehouse" });
    expect(byId(template, "warehouse/sites/main")).toMatchObject({ kind: "entity", parentId: "warehouse/sites" });
    expect(template.edges.find((e) => e.id === "warehouse/bins::site_id::warehouse/sites/main")).toMatchObject({ startField: "site_id", endField: "id" });
    // The group itself is not a warning; the leaf with only a text file is.
    expect(warnings.filter((w) => w.code === "unknown-shape").map((w) => w.path)).toEqual(["warehouse/scratch"]);
    expect(byId(template, "warehouse/scratch")).toBeUndefined();
  });

  it("a bare { fields } schema is an entity named after its folder", async () => {
    const files = new Map(await fixture());
    files.set("core/audit_log/schema.json", JSON.stringify({ fields: [{ name: "id", type: "id" }, { name: "actor_id", type: "reference", relationship: { kind: "reference", referenceTo: ["contact"] } }], foreignKeys: [{ field: "actor_id", kind: "reference", referenceTo: ["contact"], relationshipName: null }] }));
    const { template, warnings } = importFolder(files, { edges: "all" });
    expect(byId(template, "core/audit_log")).toMatchObject({ kind: "entity", label: "audit_log", parentId: "core" });
    expect((byId(template, "core/audit_log")!.data!.model as { name: string }).name).toBe("audit_log");
    expect(template.edges.find((e) => e.id === "core/audit_log::actor_id::core/contact")).toBeTruthy();
    expect(warnings.filter((w) => w.path === "core/audit_log")).toEqual([]);
  });
});

describe("fields", () => {
  it('"keys" keeps the primary key, the name field, references, external ids — and derives required from nullable', async () => {
    const { template } = await imported();
    const account = byId(template, "core/account")!;
    expect(account.fields!.map((f) => f.id)).toEqual(["id", "name", "owner_id", "parent_id", "external_key"]);
    const f = Object.fromEntries(account.fields!.map((x) => [x.id, x]));
    expect(f.id.key).toBe("pk");
    expect(f.id.required).toBeUndefined();
    expect(f.owner_id.key).toBe("fk");
    expect(f.owner_id.required).toBe(true); // nullable: false
    expect(f.name.required).toBe(true);
    // `required: true` on the field but nullable — the spec says nullable wins.
    expect(f.external_key.required).toBeUndefined();
    expect(f.parent_id.type).toBe("→ account");
    expect((account.data!.model as { fieldMeta: Record<string, unknown> }).fieldMeta.external_key).toEqual({
      label: "External key",
      visible: true,
      externalId: true,
      unique: true,
    });
  });

  it("a reference that is part of the primary key is a pfk row", async () => {
    const files = new Map(await fixture());
    const comment = JSON.parse(files.get("ops/support/case/case-comment/schema.json")!);
    comment.fields = comment.fields.map((f: { name: string }) => (f.name === "parent_id" ? { ...f, primaryKey: true } : f));
    files.set("ops/support/case/case-comment/schema.json", JSON.stringify(comment));
    const { template } = importFolder(files);
    const rows = byId(template, "ops/support/case/case-comment")!.fields!;
    expect(rows.find((f) => f.id === "parent_id")).toMatchObject({ key: "pfk", type: "→ case" });
    expect(rows.find((f) => f.id === "id")!.key).toBe("pk");
    // Still the referencing end of its edge.
    expect(template.edges.find((e) => e.id === "ops/support/case/case-comment::parent_id::ops/support/case")!.startField).toBe("parent_id");
  });

  it("a declared primary key is the key, whatever it is called, and references land on it", async () => {
    const files = new Map(await fixture());
    const contact = JSON.parse(files.get("core/contact/schema.json")!);
    contact.fields = contact.fields.map((f: { name: string }) =>
      f.name === "id" ? { name: "contact_uuid", type: "uuid", nullable: false, primaryKey: true } : f,
    );
    files.set("core/contact/schema.json", JSON.stringify(contact));
    const { template } = importFolder(files);
    const rows = byId(template, "core/contact")!.fields!;
    expect(rows[0]).toMatchObject({ id: "contact_uuid", key: "pk", type: "uuid" });
    expect(rows[0].required).toBeUndefined();
    const edge = template.edges.find((e) => e.id === "ops/support/case::contact_id::core/contact")!;
    expect(edge.endField).toBe("contact_uuid");
    expect((edge.data!.model as { targetField: string }).targetField).toBe("contact_uuid");
  });

  it('"visible" and "all" widen the rows; a polymorphic list is counted, not listed', async () => {
    const all = (await imported({ fields: "all" })).template;
    expect(byId(all, "core/account")!.fields).toHaveLength(7);
    const visible = (await imported({ fields: "visible" })).template;
    expect(byId(visible, "core/account")!.fields!.map((f) => f.id)).not.toContain("description");
    const task = byId(all, "ops/task")!;
    expect(task.fields!.find((f) => f.id === "related_id")!.type).toBe("→ 14 types");
    expect(task.fields!.find((f) => f.id === "person_id")!.type).toBe("→ contact|lead");
  });

  it("tags read kind, business line, population and hidden fields", async () => {
    const { template } = await imported();
    expect(byId(template, "core/account")!.tags).toEqual(["standard", "retail", "populated", "hidden-fields"]);
    expect(byId(template, "core/contact")!.tags).toEqual(["standard"]);
    expect(byId(template, "core/account")!.url).toBe("/entities/account");
    expect(byId(template, "core/account")!.description).toBe("Top of the customer hierarchy.");
  });
});

describe("the full field list on an entity", () => {
  it("stores every field compactly on data.model.fields, whatever the row mode", async () => {
    for (const mode of ["keys", "all"] as const) {
      const { template } = await imported({ fields: mode });
      const m = byId(template, "core/account")!.data!.model as { fields: Array<Record<string, unknown>>; fieldsTruncated?: boolean };
      expect(m.fields.map((f) => f.name)).toEqual(["id", "name", "owner_id", "parent_id", "industry", "external_key", "description"]);
      expect(m.fieldsTruncated).toBeUndefined();
      const allowed = new Set(["name", "label", "type", "displayType", "primaryKey", "nullable", "nameField", "externalId", "unique", "formula", "visible", "relationship"]);
      for (const f of m.fields) for (const key of Object.keys(f)) expect(allowed.has(key)).toBe(true);
      expect(m.fields[0]).toMatchObject({ name: "id", primaryKey: true });
      expect(m.fields[2]).toEqual({ name: "owner_id", label: "Owner ID", type: "reference", displayType: "Reference", nullable: false, visible: true, relationship: { kind: "reference", referenceTo: ["user"], relationshipName: null } });
      expect(JSON.stringify(m.fields)).not.toContain("enumValues");
    }
    expect((byId((await imported()).template, "ops/legacy-widget")!.data!.model as { fields: unknown[] }).fields).toEqual([]);
  });

  it("keeps the first MAX_NODE_FIELDS and warns past that", async () => {
    const files = new Map(await fixture());
    const big = JSON.parse(files.get("core/contact/schema.json")!);
    big.fields = Array.from({ length: 501 }, (_, i) => ({ name: `f${i}`, type: "string", nullable: true, visible: true }));
    files.set("core/contact/schema.json", JSON.stringify(big));
    const { template, warnings } = importFolder(files);
    const m = byId(template, "core/contact")!.data!.model as { fields: unknown[]; fieldsTruncated?: boolean };
    expect(m.fields).toHaveLength(500);
    expect(m.fieldsTruncated).toBe(true);
    expect(warnings.find((w) => w.code === "fields-truncated" && w.path === "core/contact")).toBeTruthy();
  });
});

describe("edges", () => {
  it("draws composition and reference the way the spec says, anchored to real rows", async () => {
    const { template } = await imported();
    const composition = template.edges.find((e) => e.id === "core/preference::account_id::core/account")!;
    expect(composition).toMatchObject({
      source: "core/preference",
      target: "core/account",
      label: "preferences",
      relation: "composition",
      style: "solid",
      color: "rose",
      startHead: "diamond-filled",
      startLabel: "*",
      endLabel: "1",
      startField: "account_id",
      endField: "id",
    });
    expect(composition.data!.model).toMatchObject({ cascadeDelete: true, deleteConstraint: "Cascade", business: true, targetField: "id" });
    const reference = template.edges.find((e) => e.id === "core/contact::account_id::core/account")!;
    expect(reference).toMatchObject({ relation: "reference", style: "dashed", color: "slate", endLabel: "0..1", startField: "account_id", endField: "id" });
    expect(reference.startHead).toBeUndefined();
    const hierarchy = template.edges.find((e) => e.id === "core/account::parent_id::core/account")!;
    expect(hierarchy).toMatchObject({ color: "violet", relation: "hierarchy", label: "child_accounts" });
    // A key the row must hold points at exactly one parent: `1`, not the kind's default `0..1`.
    const all = (await imported({ edges: "all" })).template;
    const required = all.edges.find((e) => e.id.startsWith("core/contact::owner_id::"))!;
    expect(required).toMatchObject({ relation: "reference", startLabel: "*", endLabel: "1" });
    // The kind names the line through the legend, never through `tech` — that slot is a protocol's.
    expect(template.edges.every((e) => e.tech === undefined)).toBe(true);
  });

  it('"business" hides audit FKs; "all" shows them (to a stub)', async () => {
    const business = (await imported()).template;
    expect(edgesFrom(business, "ops/support/case").map((e) => e.id)).toEqual([
      "ops/support/case::account_id::core/account",
      "ops/support/case::contact_id::core/contact",
    ]);
    const all = (await imported({ edges: "all" })).template;
    const audit = all.edges.find((e) => e.id === "ops/support/case::created_by_id::_external/user")!;
    expect(audit).toBeTruthy();
    expect(audit.data!.model).toMatchObject({ business: false });
    // The stub has no rows, so the far end anchors to its box.
    expect(audit.endField).toBeUndefined();
  });

  it("a target with no folder and no stub is dropped with a warning", async () => {
    const { template, warnings } = await imported({ externalStubs: false });
    expect(template.edges.some((e) => e.id.startsWith("core/contact::region_id"))).toBe(false);
    expect(warnings.find((w) => w.code === "edge-target-missing" && w.path === "core/contact/region_id")).toBeTruthy();
    expect(template.nodes.some((n) => n.id.startsWith("_external"))).toBe(false);
  });

  it("stubs an out-of-model target exactly once, under one group", async () => {
    const { template } = await imported({ edges: "all" });
    const stubs = template.nodes.filter((n) => n.id.startsWith("_external/"));
    expect(stubs.map((n) => n.id).sort()).toEqual(["_external/region", "_external/user"]);
    expect(stubs.every((n) => n.parentId === "_external" && n.kind === "entity-external")).toBe(true);
    expect(byId(template, "_external")!.kind).toBe("group");
    // Three audit FKs point at User; one stub.
    expect(template.edges.filter((e) => e.target === "_external/user")).toHaveLength(3);
  });
});

describe("polymorphic references", () => {
  it("collapse: one point node and one edge per poly FK, beside the object", async () => {
    const { template } = await imported({ edges: "all" });
    const points = template.nodes.filter((n) => n.kind === "point");
    expect(points.map((n) => n.id).sort()).toEqual(["ops/task/_poly/person_id", "ops/task/_poly/related_id"]);
    expect(points.every((n) => n.parentId === "ops")).toBe(true);
    expect(byId(template, "ops/task/_poly/related_id")!.label).toBe("related_id → 14 types");
    const edge = template.edges.find((e) => e.id === "ops/task::related_id::ops/task/_poly/related_id")!;
    expect(edge).toMatchObject({ relation: "polymorphic", style: "dotted", color: "amber", startField: "related_id" });
  });

  it("in-model: one edge per target with a folder, capped with a warning", async () => {
    const { template, warnings } = await imported({ edges: "all", polymorphic: "in-model" });
    expect(template.nodes.some((n) => n.kind === "point")).toBe(false);
    expect(edgesFrom(template, "ops/task").map((e) => e.target).sort()).toEqual([
      "core/account",
      "core/contact",
      "ops/support/case",
    ]);
    expect(warnings.some((w) => w.code === "poly-capped")).toBe(false);
  });

  it("none: nothing at all", async () => {
    const { template } = await imported({ edges: "all", polymorphic: "none" });
    expect(edgesFrom(template, "ops/task")).toEqual([]);
    expect(template.nodes.some((n) => n.kind === "point")).toBe(false);
  });
});

describe("views and record types", () => {
  it("a view aliases its entity with one dashed two-way edge and carries no FK lines", async () => {
    const { template } = await imported();
    const view = byId(template, "core/account/individuals")!;
    expect(view.label).toBe("Individuals");
    expect(view.description).toBe("account WHERE type = 'individual'");
    expect((view.data!.model as { aliasOf: string }).aliasOf).toBe("core/account");
    expect(byId(template, "core/account")).toBeTruthy();
    const out = edgesFrom(template, "core/account/individuals");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ target: "core/account", label: "alias", style: "dashed", direction: "none" });
    // FK lines from other entities go to the canonical folder, never the view.
    expect(template.edges.some((e) => e.target === "core/account/individuals" && e.label !== "alias")).toBe(false);
  });

  it("record types fold into one enumeration beside the entity, joined by a reference line", async () => {
    const { template, warnings } = await imported();
    expect(warnings.filter((w) => w.path?.includes("record-types"))).toEqual([]);
    // Neither the leaf nor its wrapper group is a node.
    expect(byId(template, "core/account/individuals/record-types/person")).toBeUndefined();
    expect(byId(template, "core/account/individuals/record-types")).toBeUndefined();
    const rts = byId(template, "core/account/individuals/record-types/person".replace(/\/individuals.*$/, "/_record-types"))!;
    expect(rts.id).toBe("core/account/_record-types");
    expect(rts).toMatchObject({ kind: "enum", label: "Account record types", description: "Record types of Individuals", parentId: "core" });
    // A row per record type, keyed by the stable key.
    expect(rts.fields).toEqual([{ id: "person", name: "Person" }]);
    expect(rts.data!.model).toMatchObject({
      shape: "record-types",
      entity: "core/account",
      discriminator: null,
      recordTypes: [{ folder: "core/account/individuals/record-types/person", key: "person", active: true }],
    });
    // Account has no discriminator column, so the line leaves the box itself.
    const edge = template.edges.find((e) => e.target === rts.id)!;
    expect(edge).toMatchObject({ id: "core/account::record-type::core/account/_record-types", source: "core/account", label: "record type", relation: "reference", style: "dashed", color: "slate" });
    expect(edge.startField).toBeUndefined();
    expect(template.edges.filter((e) => e.target === rts.id)).toHaveLength(1);
  });

  it("recordTypes: \"none\" leaves record types out entirely", async () => {
    const { template, warnings } = await imported({ recordTypes: "none" });
    expect(warnings.filter((w) => w.path?.includes("record-types"))).toEqual([]);
    expect(template.nodes.some((n) => n.id.includes("record-types"))).toBe(false);
    expect(template.edges.some((e) => e.id.includes("record-type"))).toBe(false);
  });

  it("recordTypes: \"nodes\" keeps a record type as a labelled leaf whose one line is a generalization to its parent entity", async () => {
    const { template } = await imported({ recordTypes: "nodes" });
    expect(byId(template, "core/account/_record-types")).toBeUndefined();
    const rt = byId(template, "core/account/individuals/record-types/person")!;
    expect(rt.label).toBe("Person");
    expect(rt.description).toBe("Individual customers");
    expect(rt.data!.model).toMatchObject({ key: "person", active: true, parentEntity: "core/account" });
    // IS-A, drawn UML's way: solid, a hollow triangle at the parent, no cardinality.
    const [isa, ...rest] = edgesFrom(template, rt.id);
    expect(rest).toEqual([]);
    expect(isa).toMatchObject({ target: "core/account", relation: "generalization", style: "solid", color: "emerald", endHead: "triangle" });
    expect(isa!.startLabel).toBeUndefined();
    expect(isa!.endLabel).toBeUndefined();
  });
});

describe("validation and determinism", () => {
  it("emits an already-valid, already-laid-out document", async () => {
    const { template, registry } = await imported();
    const again = validateTemplate(template, { knownKinds: Object.keys(registry.nodeKinds!) });
    expect(again).toEqual(template);
    expect(template.nodes.some((n) => n.x !== 0 || n.y !== 0)).toBe(true);
    expect(template.meta).toMatchObject({
      title: "Example Data Model",
      folderFormat: {
        dialect: DATAMODEL_DIALECT_ID,
        version: 1,
        generatedAt: "2026-09-01T00:00:00Z",
        source: { system: "example", url: "https://example.test" },
        importOptions: { fields: "keys", edges: "business", polymorphic: "collapse", externalStubs: true },
      },
    });
  });

  it("two imports of the same map are byte-identical, whatever the map's order", async () => {
    const files = await fixture();
    const reversed = new Map([...files].reverse());
    expect(JSON.stringify(importFolder(files).template)).toBe(JSON.stringify(importFolder(reversed).template));
  });

  it("produces no paths of its own", async () => {
    expect((await imported()).template.paths).toBeUndefined();
  });
});

describe("a big tree opens folded", () => {
  /** The fixture with `count` extra objects bolted onto one band. */
  const grown = async (count: number) => {
    const files = new Map(await fixture());
    const band = JSON.parse(files.get("core/schema.json")!);
    for (let i = 0; i < count; i++) {
      const folder = `core/filler-${i}`;
      band.entities.push({ folder, band: "core", name: `filler${i}`, label: `Filler ${i}`, kind: "custom" });
      files.set(
        `${folder}/schema.json`,
        JSON.stringify({ folder, entity: { name: `filler${i}`, label: `Filler ${i}`, kind: "custom" }, fields: [{ name: "id", type: "id", nullable: false }], foreignKeys: [] }),
      );
    }
    files.set("core/schema.json", JSON.stringify(band));
    return files;
  };

  const collapsedIds = (t: DiagramTemplate) => t.nodes.filter((n) => n.collapsed).map((n) => n.id).sort();

  it("collapses its top-level bands past the threshold, and leaves a small tree open", async () => {
    const small = importFolder(await fixture());
    expect(small.template.nodes.length).toBeLessThan(AUTO_FOLD_NODES);
    expect(collapsedIds(small.template)).toEqual([]);

    const big = importFolder(await grown(AUTO_FOLD_NODES));
    expect(big.template.nodes.length).toBeGreaterThan(AUTO_FOLD_NODES);
    // The bands, and the stub group that holds out-of-model references.
    expect(collapsedIds(big.template)).toEqual(["_external", "core", "ops"]);
    // Only the top level: a group inside a band stays open once drilled into.
    expect(big.template.nodes.find((n) => n.id === "ops/support")!.collapsed).toBeUndefined();
    // And they are SPACED as chips: the stored size stays the expanded one
    // (expanding must restore the layout), but the canvas is compact.
    const spread = (t: DiagramTemplate) => {
      const tops = t.nodes.filter((n) => !n.parentId).map((n) => n.y);
      return Math.max(...tops) - Math.min(...tops);
    };
    const open = importFolder(await grown(AUTO_FOLD_NODES), { foldGroups: false }).template;
    expect(spread(big.template)).toBeLessThan(spread(open) / 4);
    expect(big.template.nodes.find((n) => n.id === "core")!.h).toBe(open.nodes.find((n) => n.id === "core")!.h);
  });

  it("the caller has the last word either way", async () => {
    expect(collapsedIds(importFolder(await grown(AUTO_FOLD_NODES), { foldGroups: false }).template)).toEqual([]);
    expect(collapsedIds(importFolder(await fixture(), { foldGroups: true }).template)).toEqual(["_external", "core", "ops"]);
  });

  it("a generic tree is never collapsed on its own — it round-trips a document", () => {
    const nodes = Array.from({ length: AUTO_FOLD_NODES + 2 }, (_, i) => ({
      id: i ? `g/n${i}` : "g",
      label: `N${i}`,
      kind: i ? "service" : "group",
      icon: "none",
      description: "",
      parentId: i ? "g" : null,
      x: 0, y: 0, w: 170, h: 76,
    }));
    const doc = validateTemplate({ version: 1, nodes, edges: [] });
    const out = exportFolder(doc, { mode: "full" });
    const back = importFolder(out.files);
    expect(back.template.nodes.length).toBeGreaterThan(AUTO_FOLD_NODES);
    expect(collapsedIds(back.template)).toEqual([]);
  });
});

describe("sidecar round trip", () => {
  it("export sidecar → re-import keeps positions and curated edits; a vanished node is an orphan, not a crash", async () => {
    const files = await fixture();
    const first = importFolder(files).template;
    const moved: DiagramTemplate = {
      ...first,
      nodes: first.nodes.map((n) =>
        n.id === "core/contact" ? { ...n, x: 999, y: 777, label: "People", tags: ["curated"] } : n,
      ),
      paths: [{ id: "case-to-account", title: "Case → Account", steps: ["ops/support/case", "core/account"] }],
    };
    const out = exportFolder(moved, { tree: buildFolderTree(files) });
    expect(out.mode).toBe("sidecar");
    expect(out.deletions).toEqual([]);
    expect([...out.files.keys()].sort()).toEqual([LAYOUT_FILE, OVERRIDES_FILE]);
    const overrides = JSON.parse(out.files.get(OVERRIDES_FILE)!);
    expect(overrides).toEqual({
      version: 1,
      format: OVERRIDES_FORMAT,
      nodes: { "core/contact": { label: "People", tags: ["curated"] } },
      paths: [{ id: "case-to-account", title: "Case → Account", steps: ["ops/support/case", "core/account"] }],
    });

    const withSidecar = new Map([...files, ...out.files]);
    const second = importFolder(withSidecar);
    const contact = byId(second.template, "core/contact")!;
    expect([contact.x, contact.y, contact.label, contact.tags]).toEqual([999, 777, "People", ["curated"]]);
    expect(second.template.paths).toEqual(overrides.paths);
    expect(second.warnings.some((w) => w.code === "sidecar-orphan")).toBe(false);

    // The source loses an object: its layout row is reported, everything else survives.
    const shrunk = new Map([...withSidecar].filter(([p]) => !p.startsWith("core/preference/")));
    const third = importFolder(shrunk);
    expect(byId(third.template, "core/preference")).toBeUndefined();
    expect(third.warnings.find((w) => w.code === "sidecar-orphan" && w.path === "core/preference")).toBeTruthy();
    expect(byId(third.template, "core/contact")!.x).toBe(999);
  });

  it("a node added on the canvas is reported, not silently dropped, in sidecar mode", async () => {
    const files = await fixture();
    const first = importFolder(files).template;
    const withNote: DiagramTemplate = {
      ...first,
      nodes: [
        ...first.nodes,
        { id: "note", label: "Curator note", kind: "text", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 200, h: 60 },
      ],
    };
    for (const tree of [buildFolderTree(files), null]) {
      const out = exportFolder(withNote, { tree });
      const w = out.warnings.find((x) => x.code === "no-source-folder");
      expect(w?.path).toBe("note");
      expect(out.warnings.filter((x) => x.code === "no-source-folder")).toHaveLength(1);
      // Everything with a folder — collapse points included — is not "added".
      expect(JSON.parse(out.files.get(OVERRIDES_FILE)!).nodes).toBeUndefined();
    }
    expect(exportFolder(first, { tree: null }).warnings).toEqual([]);
  });

  it("without the source tree, overrides come from the dialect's baseline", async () => {
    const files = await fixture();
    const first = importFolder(files).template;
    const edited = {
      ...first,
      nodes: first.nodes.map((n) => (n.id === "core/account" ? { ...n, label: "Customer" } : n)),
    };
    const out = exportFolder(edited);
    const overrides = JSON.parse(out.files.get(OVERRIDES_FILE)!);
    expect(overrides.nodes).toEqual({ "core/account": { label: "Customer" } });
    expect(out.warnings).toEqual([]);
  });

  it("an override for a missing node warns; notes land in data.notes", async () => {
    const files = new Map(await fixture());
    files.set(
      OVERRIDES_FILE,
      JSON.stringify({
        version: 1,
        format: OVERRIDES_FORMAT,
        nodes: { "core/account": { notes: ["curator note"] }, "gone/away": { label: "x" } },
      }),
    );
    const { template, warnings } = importFolder(files);
    expect(byId(template, "core/account")!.data!.notes).toEqual(["curator note"]);
    // Overrides re-validate; the dialect's kinds must come through that too.
    expect(byId(template, "core/account")!.kind).toBe("entity-standard");
    expect(byId(template, "core/account/individuals")!.kind).toBe("view");
    expect(warnings.find((w) => w.code === "override-orphan" && w.path === "gone/away")).toBeTruthy();
    // And the note rides back out.
    const out = exportFolder(template, { tree: buildFolderTree(await fixture()) });
    expect(JSON.parse(out.files.get(OVERRIDES_FILE)!).nodes).toEqual({ "core/account": { notes: ["curator note"] } });
  });

  it("writeEntityYaml patches only the two curated keys, only where they differ", async () => {
    const files = await fixture();
    const tree = buildFolderTree(files);
    const first = importFolder(files).template;
    const edited = {
      ...first,
      nodes: first.nodes.map((n) => (n.id === "core/contact" ? { ...n, label: "People" } : n)),
    };
    const out = exportFolder(edited, { tree, writeEntityYaml: true });
    const touched = [...out.files.keys()].filter((p) => p.endsWith("entity.yaml"));
    expect(touched).toEqual(["core/contact/entity.yaml"]);
    const before = files.get("core/contact/entity.yaml")!;
    const after = out.files.get("core/contact/entity.yaml")!;
    expect(after).toBe(before.replace("diagramName: Contact", "diagramName: People"));
    expect(exportFolder(first, { tree, writeEntityYaml: true }).files.size).toBe(2);
  });

  it("the layout sidecar is a plain presentation document", async () => {
    const out = exportFolder(importFolder(await fixture()).template);
    const layout = JSON.parse(out.files.get(LAYOUT_FILE)!);
    expect(validatePresentation(layout)).toEqual(layout);
    expect(Object.keys(layout.nodes)).toContain("core/account");
  });

  it("treeFiles gives back exactly the map a tree was built from", async () => {
    const files = await fixture();
    expect(new Map(treeFiles(buildFolderTree(files)))).toEqual(new Map(files));
  });
});

describe("budget", () => {
  /** 8 bands × 25 entities × 40 fields, every entity with 3 references. */
  function benchmark(): FileMap {
    const files = new Map<string, string>();
    const bands = Array.from({ length: 8 }, (_, i) => `band-${i}`);
    const entities: Array<{ folder: string; name: string }> = [];
    for (const band of bands) {
      for (let j = 0; j < 25; j++) entities.push({ folder: `${band}/obj-${j}`, name: `${band.replace("-", "")}_obj${j}` });
    }
    const relEdges: unknown[] = [];
    files.set("schema.json", JSON.stringify({ bands: bands.map((b) => ({ band: b, folder: b })), title: "Bench" }));
    for (const band of bands) {
      files.set(`${band}/schema.json`, JSON.stringify({ band, folder: band, entities: [] }));
    }
    entities.forEach((o, i) => {
      const fields = [
        { name: "id", type: "id", nullable: false, visible: true },
        { name: "name", type: "string", nameField: true, nullable: false, visible: true },
      ];
      const fks: unknown[] = [];
      for (let k = 1; k <= 3; k++) {
        const target = entities[(i + k * 7) % entities.length];
        fields.push({
          name: `ref${k}_id`, type: "reference", nullable: true, visible: true,
          relationship: { kind: "reference", referenceTo: [target.name] },
        } as never);
        fks.push({ field: `ref${k}_id`, kind: "reference", referenceTo: [target.name], relationshipName: null, targetFolders: [target.folder] });
        relEdges.push({ from: o.name, field: `ref${k}_id`, kind: "reference", to: target.name });
      }
      for (let f = 0; f < 35; f++) {
        fields.push({
          name: `field${f}`, type: "enum", nullable: true, visible: true,
          enumValues: Array.from({ length: 20 }, (_, v) => ({ value: `v${v}`, label: `Value ${v}` })),
        } as never);
      }
      files.set(
        `${o.folder}/schema.json`,
        JSON.stringify({ folder: o.folder, entity: { name: o.name, label: o.name, kind: "custom" }, fields, foreignKeys: fks }),
      );
    });
    files.set("relationships.json", JSON.stringify({ edges: relEdges }));
    return files;
  }

  it("imports 200 entities under the limits", () => {
    const files = benchmark();
    const started = performance.now();
    const { template, stats } = importFolder(files);
    const elapsed = performance.now() - started;
    expect(template.nodes.length).toBe(208);
    expect(stats.edges).toBeLessThanOrEqual(600);
    expect(stats.fields).toBeLessThanOrEqual(2500);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("a collapsed container keeps a box that holds what it hides", () => {
  const node = (id: string, parentId: string | null, over: Record<string, unknown> = {}) => ({
    id, label: id, kind: "service", icon: "none", description: "", parentId, x: 0, y: 0, w: 170, h: 76, ...over,
  });

  it("is spaced as a chip, but stores a frame its children fit inside", () => {
    const doc = validateTemplate({
      version: 1,
      nodes: [
        node("g", null, { kind: "group", w: 300, h: 200, collapsed: true }),
        node("open", null, { kind: "group", w: 300, h: 200 }),
        ...["a", "b", "c", "d", "e", "f"].map((id) => node(id, "g")),
        ...["p", "q"].map((id) => node(id, "open")),
      ],
      edges: [],
    });
    const out = autoLayout(doc, { frames: "all" });
    const g = out.nodes.find((n) => n.id === "g")!;
    const kids = out.nodes.filter((n) => n.parentId === "g");
    // Expanding it must not spill its children outside their own frame.
    expect(Math.max(...kids.map((k) => k.x + k.w))).toBeLessThanOrEqual(g.w);
    expect(Math.max(...kids.map((k) => k.y + k.h))).toBeLessThanOrEqual(g.h);
    // …while its rank-mate is spaced against the CHIP, not that tall frame.
    const open = out.nodes.find((n) => n.id === "open")!;
    expect(Math.abs(open.y - g.y)).toBeLessThan(g.h);
  });
});

describe("a saved layout outranks the auto-fold", () => {
  it("collapses as asked but never re-lays-out over the reader's own arrangement", async () => {
    const files = new Map(await fixture());
    const band = JSON.parse(files.get("core/schema.json")!);
    for (let i = 0; i < AUTO_FOLD_NODES; i++) {
      const folder = `core/filler-${i}`;
      band.entities.push({ folder, band: "core", name: `f${i}`, label: `F${i}`, kind: "custom" });
      files.set(`${folder}/schema.json`, JSON.stringify({ folder, entity: { name: `f${i}`, label: `F${i}`, kind: "custom" }, fields: [{ name: "id", type: "id", nullable: false }], foreignKeys: [] }));
    }
    files.set("core/schema.json", JSON.stringify(band));

    const first = importFolder(files).template;
    const moved = { ...first, nodes: first.nodes.map((n) => (n.id === "core/contact" ? { ...n, x: 4321, y: 8765 } : n)) };
    const { presentation } = splitTemplate(moved);
    const back = importFolder(files, { layoutSidecar: presentation }).template;
    const contact = back.nodes.find((n) => n.id === "core/contact")!;
    expect([contact.x, contact.y]).toEqual([4321, 8765]);
    // Still collapsed — the fold is a view the tree asked for, not a layout.
    expect(back.nodes.filter((n) => n.collapsed).map((n) => n.id).sort()).toEqual(["_external", "core", "ops"]);
  });
});

describe("the shipped datamodel example", () => {
  it("imports clean — it is tracked in git, so it can rot silently", async () => {
    const dir = fileURLToPath(new URL("../../../../../templates/folders/datamodel", import.meta.url));
    const { template, stats, warnings, dialect } = importFolder(await readFolderToFileMap(dir));
    expect(dialect).toBe(DATAMODEL_DIALECT_ID);
    expect(warnings).toEqual([]);
    expect(stats.nodes).toBe(11); // 9 entities + a view + one enumeration of 3 record types
    // Small enough to open expanded; the README says so.
    expect(template.nodes.filter((n) => n.collapsed)).toEqual([]);
    const kinds = new Set(template.nodes.map((n) => n.kind));
    expect([...kinds].sort()).toEqual(["entity", "enum", "view"]);
    // Person's record types: three rows, and a line from its discriminator column.
    const rts = byId(template, "people/_record-types")!;
    expect(rts.fields!.map((f) => f.id)).toEqual(["chef", "customer", "manager"]);
    expect(rts.description).toBe("How a person is classified");
    const line = template.edges.find((e) => e.target === rts.id)!;
    expect(line).toMatchObject({ id: "people::record_type_id::people/_record-types", startField: "record_type_id", relation: "reference" });
    // Person pins two non-key rows: a hidden one and a read-only one, tagged
    // from the source's access flags, in the schema's own field order.
    const person = byId(template, "people")!;
    expect(person.fields!.map((f) => f.id)).toEqual(["id", "name", "record_type_id", "building_id", "notes", "owner_id", "created_at"]);
    expect(person.fields!.find((f) => f.id === "notes")!.tags).toEqual(["hidden"]);
    expect(person.fields!.find((f) => f.id === "created_at")).toMatchObject({ required: true, tags: ["ro"] });
    expect(person.fields!.find((f) => f.id === "id")!.tags).toBeUndefined();
    // The discriminator's own key is the enumeration's line, never a stub.
    const all = importFolder(await readFolderToFileMap(dir), { edges: "all" });
    expect(all.template.nodes.some((n) => n.id === "_external/record_type")).toBe(false);
    // Asked for as leaves, the tree is what it was: a group of three under Person.
    const leaves = importFolder(await readFolderToFileMap(dir), { recordTypes: "nodes" });
    expect(leaves.stats.nodes).toBe(14);
    expect(leaves.template.nodes.filter((n) => n.kind === "record-type").map((n) => n.parentId)).toEqual(["people/record-types", "people/record-types", "people/record-types"]);
    // Composition against references, and the view's alias.
    const composition = template.edges.find((e) => e.relation === "composition")!;
    expect(composition.id).toBe("bread::recipe_id::recipes");
    expect(template.edges.find((e) => e.label === "alias")!.target).toBe("customers");
    // Audit keys are hidden by default and stubbed when asked for.
    expect(template.edges.some((e) => e.id.includes("owner_id"))).toBe(false);
    expect(all.template.nodes.some((n) => n.id === "_external/user")).toBe(true);
    // Nine tables — the enumeration is not one — all reachable, and a provably smallest key set.
    const cover = minimalKeyCover(template);
    expect(cover.fraction).toBe(1);
    expect(cover.optimal).toBe(true);
    expect(keyCoverage(template, cover.keys).total).toBe(9);
  });
});
