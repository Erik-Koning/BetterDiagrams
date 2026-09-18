/**
 * folder.test.ts — the Salesforce data-model dialect against the synthetic
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
import { classifySalesforceShape, SALESFORCE_DIALECT_ID } from "./dialects/salesforce";
import { isForensics } from "./dialects/salesforce/shapes";
import { validateTemplate, type DiagramTemplate } from "../schema";
import { splitTemplate } from "../presentation";
import { autoLayout } from "../layout";
import { keyCoverage, minimalKeyCover } from "../coverage";
import { drillableIds } from "../scope";
import { validatePresentation } from "../presentation";
import type { FileMap, FolderImportOptions } from "./types";

const FIXTURE = fileURLToPath(new URL("./fixtures/sf-datamodel-mini", import.meta.url));

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
    expect(files.has("core/account/person-account/record-types/person/schema.json")).toBe(true);
    expect(files.has("README.md")).toBe(true);
    expect([...files.keys()].every((p) => !p.startsWith("/"))).toBe(true);
  });
});

describe("shape discrimination", () => {
  it("tells the six schema.json shapes apart, in the pinned order", async () => {
    const files = await fixture();
    const shape = (p: string) => classifySalesforceShape(JSON.parse(files.get(p)!));
    expect(shape("schema.json")).toBe("root");
    expect(shape("core/schema.json")).toBe("band");
    expect(shape("ops/support/schema.json")).toBe("group");
    expect(shape("core/account/schema.json")).toBe("object");
    expect(shape("core/account/person-account/record-types/person/schema.json")).toBe("record-type");
    expect(shape("core/account/person-account/schema.json")).toBe("view");
    expect(classifySalesforceShape({ nope: 1 })).toBe("unknown");
    expect(isForensics(JSON.parse(files.get("core/account/forensics.json")!))).toBe(true);
  });

  it("detects the dialect and never makes a node of forensics or metadata", async () => {
    const files = await fixture();
    const hit = detectDialect(buildFolderTree(files));
    expect(hit?.dialect.id).toBe(SALESFORCE_DIALECT_ID);
    const { template } = await imported();
    expect(template.nodes.some((n) => n.id.startsWith("metadata"))).toBe(false);
    expect(template.nodes.some((n) => /forensics/.test(n.id))).toBe(false);
    expect(byId(template, "core/account")!.data!.sf).toMatchObject({ forensicsPath: "core/account/forensics.json" });
    expect((template.meta as { folderFormat: { crossCutting: string } }).folderFormat.crossCutting).toBe("metadata");
  });

  it("re-roots a tree whose paths all start with the dropped directory's name", async () => {
    const wrapped = new Map([...(await fixture())].map(([p, c]) => [`export-2026/${p}`, c]));
    const { template, dialect } = importFolder(wrapped);
    expect(dialect).toBe(SALESFORCE_DIALECT_ID);
    expect(byId(template, "core/account")).toBeTruthy();
  });
});

describe("api name index", () => {
  it("warns when two folders claim one api name, and resolves references to the first", async () => {
    const files = new Map(await fixture());
    files.set(
      "ops/twin/schema.json",
      JSON.stringify({ folder: "ops/twin", object: { apiName: "Contact", label: "Twin" }, fields: [{ name: "Id", type: "id" }] }),
    );
    const { template, warnings } = importFolder(files);
    expect(warnings.find((w) => w.code === "duplicate-api-name" && w.path === "ops/twin")).toBeTruthy();
    expect(template.edges.find((e) => e.id === "ops/support/case::ContactId::core/contact")).toBeTruthy();
  });
});

describe("nesting", () => {
  it("parents every node to its enclosing folder's node, to depth five", async () => {
    const { template } = await imported();
    const parent = (id: string) => byId(template, id)?.parentId;
    expect(parent("core")).toBeNull();
    expect(parent("core/account")).toBe("core");
    expect(parent("core/account/person-account")).toBe("core/account");
    expect(parent("core/account/person-account/record-types")).toBe("core/account/person-account");
    expect(parent("core/account/person-account/record-types/person")).toBe("core/account/person-account/record-types");
    expect(parent("ops/support/case")).toBe("ops/support");
    expect(parent("ops/support/case/case-comment")).toBe("ops/support/case");
    expect(byId(template, "core/account/person-account/record-types/person")!.kind).toBe("sf-record-type");
  });

  it("an object under an object is drill-in detail", async () => {
    const { template } = await imported();
    expect(drillableIds(template)).toContain("ops/support/case");
    expect(drillableIds(template)).toContain("core/account");
  });

  it("maps kinds from the curated diagram type, falling back to the object kind", async () => {
    const { template } = await imported();
    expect(byId(template, "core/account")!.kind).toBe("sf-object-std");
    expect(byId(template, "core/preference")!.kind).toBe("sf-object");
    expect(byId(template, "core/account/person-account")!.kind).toBe("sf-view");
    expect(byId(template, "core")!.kind).toBe("group");
    expect(byId(template, "ops/support")!.kind).toBe("group");
  });

  it("falls back to object.yaml when there is no schema.json, and says so", async () => {
    const { template, warnings } = await imported();
    const widget = byId(template, "ops/legacy-widget")!;
    expect(widget.label).toBe("Legacy Widget");
    expect(widget.kind).toBe("sf-object");
    expect(widget.tags).toEqual(["custom", "populated"]);
    expect(warnings.some((w) => w.code === "yaml-fallback-used" && w.path === "ops/legacy-widget")).toBe(true);
  });
});

describe("fields", () => {
  it('"keys" keeps Id, the name field, references, external ids — and derives required from nillable', async () => {
    const { template } = await imported();
    const account = byId(template, "core/account")!;
    expect(account.fields!.map((f) => f.id)).toEqual(["Id", "Name", "OwnerId", "ParentId", "External_Key__c"]);
    const f = Object.fromEntries(account.fields!.map((x) => [x.id, x]));
    expect(f.Id.key).toBe("pk");
    expect(f.Id.required).toBeUndefined();
    expect(f.OwnerId.key).toBe("fk");
    expect(f.OwnerId.required).toBe(true); // nillable: false
    expect(f.Name.required).toBe(true);
    // `required: true` on the field but nillable — the spec says nillable wins.
    expect(f.External_Key__c.required).toBeUndefined();
    expect(f.ParentId.type).toBe("→ Account");
    expect((account.data!.sf as { fieldMeta: Record<string, unknown> }).fieldMeta.External_Key__c).toEqual({
      label: "External_Key__c",
      visibleToIntegrationUser: true,
      externalId: true,
      unique: true,
    });
  });

  it('"visible" and "all" widen the rows; a polymorphic list is counted, not listed', async () => {
    const all = (await imported({ fields: "all" })).template;
    expect(byId(all, "core/account")!.fields).toHaveLength(7);
    const visible = (await imported({ fields: "visible" })).template;
    expect(byId(visible, "core/account")!.fields!.map((f) => f.id)).not.toContain("Description");
    const task = byId(all, "ops/task")!;
    expect(task.fields!.find((f) => f.id === "WhatId")!.type).toBe("→ 14 types");
    expect(task.fields!.find((f) => f.id === "WhoId")!.type).toBe("→ Contact|Lead");
  });

  it("tags read kind, business line, population and FLS", async () => {
    const { template } = await imported();
    expect(byId(template, "core/account")!.tags).toEqual(["standard", "retail", "populated", "fls-partial"]);
    expect(byId(template, "core/contact")!.tags).toEqual(["standard"]);
    expect(byId(template, "core/account")!.url).toBe("/lightning/o/Account/list");
    expect(byId(template, "core/account")!.description).toBe("Top of the customer hierarchy.");
  });
});

describe("the full field list on an object", () => {
  it("stores every field compactly on data.sf.fields, whatever the row mode", async () => {
    for (const mode of ["keys", "all"] as const) {
      const { template } = await imported({ fields: mode });
      const sf = byId(template, "core/account")!.data!.sf as { fields: Array<Record<string, unknown>>; fieldsTruncated?: boolean };
      expect(sf.fields.map((f) => f.name)).toEqual(["Id", "Name", "OwnerId", "ParentId", "Industry", "External_Key__c", "Description"]);
      expect(sf.fieldsTruncated).toBeUndefined();
      const allowed = new Set(["name", "label", "type", "toolingType", "nillable", "nameField", "externalId", "unique", "formula", "visibleToIntegrationUser", "relationship"]);
      for (const f of sf.fields) for (const key of Object.keys(f)) expect(allowed.has(key)).toBe(true);
      expect(sf.fields[2]).toEqual({ name: "OwnerId", label: "OwnerId", type: "reference", toolingType: "Lookup", nillable: false, visibleToIntegrationUser: true, relationship: { kind: "lookup", referenceTo: ["User"], relationshipName: null } });
      expect(JSON.stringify(sf.fields)).not.toContain("picklistValues");
    }
    expect((byId((await imported()).template, "ops/legacy-widget")!.data!.sf as { fields: unknown[] }).fields).toEqual([]);
  });

  it("keeps the first MAX_NODE_FIELDS and warns past that", async () => {
    const files = new Map(await fixture());
    const big = JSON.parse(files.get("core/contact/schema.json")!);
    big.fields = Array.from({ length: 501 }, (_, i) => ({ name: `F${i}__c`, type: "string", nillable: true, visibleToIntegrationUser: true }));
    files.set("core/contact/schema.json", JSON.stringify(big));
    const { template, warnings } = importFolder(files);
    const sf = byId(template, "core/contact")!.data!.sf as { fields: unknown[]; fieldsTruncated?: boolean };
    expect(sf.fields).toHaveLength(500);
    expect(sf.fieldsTruncated).toBe(true);
    expect(warnings.find((w) => w.code === "fields-truncated" && w.path === "core/contact")).toBeTruthy();
  });
});

describe("edges", () => {
  it("draws master-detail and lookup the way the spec says, anchored to real rows", async () => {
    const { template } = await imported();
    const md = template.edges.find((e) => e.id === "core/preference::Account__c::core/account")!;
    expect(md).toMatchObject({
      source: "core/preference",
      target: "core/account",
      label: "Preferences",
      tech: "masterDetail",
      style: "solid",
      color: "rose",
      startHead: "diamond",
      startLabel: "*",
      endLabel: "1",
      startField: "Account__c",
      endField: "Id",
    });
    expect(md.data!.sf).toMatchObject({ cascadeDelete: true, deleteConstraint: "Cascade", business: true });
    const lookup = template.edges.find((e) => e.id === "core/contact::AccountId::core/account")!;
    expect(lookup).toMatchObject({ style: "dashed", color: "slate", endLabel: "0..1", startField: "AccountId", endField: "Id" });
    expect(lookup.startHead).toBeUndefined();
    const hierarchy = template.edges.find((e) => e.id === "core/account::ParentId::core/account")!;
    expect(hierarchy).toMatchObject({ color: "violet", tech: "hierarchy", label: "ChildAccounts" });
  });

  it('"business" hides audit FKs; "all" shows them (to a stub)', async () => {
    const business = (await imported()).template;
    expect(edgesFrom(business, "ops/support/case").map((e) => e.id)).toEqual([
      "ops/support/case::AccountId::core/account",
      "ops/support/case::ContactId::core/contact",
    ]);
    const all = (await imported({ edges: "all" })).template;
    const audit = all.edges.find((e) => e.id === "ops/support/case::CreatedById::_external/user")!;
    expect(audit).toBeTruthy();
    expect(audit.data!.sf).toMatchObject({ business: false });
    // The stub has no rows, so the far end anchors to its box.
    expect(audit.endField).toBeUndefined();
  });

  it("a target with no folder and no stub is dropped with a warning", async () => {
    const { template, warnings } = await imported({ externalStubs: false });
    expect(template.edges.some((e) => e.id.startsWith("core/contact::Region__c"))).toBe(false);
    expect(warnings.find((w) => w.code === "edge-target-missing" && w.path === "core/contact/Region__c")).toBeTruthy();
    expect(template.nodes.some((n) => n.id.startsWith("_external"))).toBe(false);
  });

  it("stubs an out-of-model target exactly once, under one group", async () => {
    const { template } = await imported({ edges: "all" });
    const stubs = template.nodes.filter((n) => n.id.startsWith("_external/"));
    expect(stubs.map((n) => n.id).sort()).toEqual(["_external/region__c", "_external/user"]);
    expect(stubs.every((n) => n.parentId === "_external" && n.kind === "sf-external")).toBe(true);
    expect(byId(template, "_external")!.kind).toBe("group");
    // Three audit FKs point at User; one stub.
    expect(template.edges.filter((e) => e.target === "_external/user")).toHaveLength(3);
  });
});

describe("polymorphic references", () => {
  it("collapse: one point node and one edge per poly FK, beside the object", async () => {
    const { template } = await imported({ edges: "all" });
    const points = template.nodes.filter((n) => n.kind === "point");
    expect(points.map((n) => n.id).sort()).toEqual(["ops/task/_poly/WhatId", "ops/task/_poly/WhoId"]);
    expect(points.every((n) => n.parentId === "ops")).toBe(true);
    expect(byId(template, "ops/task/_poly/WhatId")!.label).toBe("WhatId → 14 types");
    const edge = template.edges.find((e) => e.id === "ops/task::WhatId::ops/task/_poly/WhatId")!;
    expect(edge).toMatchObject({ style: "dotted", color: "amber", startField: "WhatId" });
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
  it("a view aliases its object with one dashed two-way edge and carries no FK lines", async () => {
    const { template } = await imported();
    const view = byId(template, "core/account/person-account")!;
    expect(view.label).toBe("Person Account");
    expect(view.description).toBe("Account WHERE IsPersonAccount = true");
    expect((view.data!.sf as { aliasOf: string }).aliasOf).toBe("core/account");
    expect(byId(template, "core/account")).toBeTruthy();
    const out = edgesFrom(template, "core/account/person-account");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ target: "core/account", label: "alias", style: "dashed", direction: "none" });
    // FK lines from other objects go to the canonical folder, never the view.
    expect(template.edges.some((e) => e.target === "core/account/person-account" && e.label !== "alias")).toBe(false);
  });

  it("a record type is a labelled leaf with no edges", async () => {
    const { template } = await imported();
    const rt = byId(template, "core/account/person-account/record-types/person")!;
    expect(rt.label).toBe("Person");
    expect(rt.description).toBe("Individual customers");
    expect(rt.data!.sf).toMatchObject({ developerName: "PersonAccount", isPersonType: true, parentObject: "core/account" });
    expect(edgesFrom(template, rt.id)).toEqual([]);
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
        dialect: SALESFORCE_DIALECT_ID,
        version: 1,
        generatedAt: "2026-09-01T00:00:00Z",
        source: { organizationId: "00D000000000000AAA" },
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
      band.objects.push({ folder, band: "core", apiName: `Filler${i}__c`, label: `Filler ${i}`, kind: "custom" });
      files.set(
        `${folder}/schema.json`,
        JSON.stringify({ folder, object: { apiName: `Filler${i}__c`, label: `Filler ${i}`, kind: "custom" }, fields: [{ name: "Id", type: "id", nillable: false }], foreignKeys: [] }),
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
    expect(byId(template, "core/account")!.kind).toBe("sf-object-std");
    expect(byId(template, "core/account/person-account")!.kind).toBe("sf-view");
    expect(warnings.find((w) => w.code === "override-orphan" && w.path === "gone/away")).toBeTruthy();
    // And the note rides back out.
    const out = exportFolder(template, { tree: buildFolderTree(await fixture()) });
    expect(JSON.parse(out.files.get(OVERRIDES_FILE)!).nodes).toEqual({ "core/account": { notes: ["curator note"] } });
  });

  it("writeObjectYaml patches only the two curated keys, only where they differ", async () => {
    const files = await fixture();
    const tree = buildFolderTree(files);
    const first = importFolder(files).template;
    const edited = {
      ...first,
      nodes: first.nodes.map((n) => (n.id === "core/contact" ? { ...n, label: "People" } : n)),
    };
    const out = exportFolder(edited, { tree, writeObjectYaml: true });
    const touched = [...out.files.keys()].filter((p) => p.endsWith("object.yaml"));
    expect(touched).toEqual(["core/contact/object.yaml"]);
    const before = files.get("core/contact/object.yaml")!;
    const after = out.files.get("core/contact/object.yaml")!;
    expect(after).toBe(before.replace("diagramName: Contact", "diagramName: People"));
    expect(exportFolder(first, { tree, writeObjectYaml: true }).files.size).toBe(2);
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
  /** 8 bands × 25 objects × 40 fields, every object with 3 lookups. */
  function benchmark(): FileMap {
    const files = new Map<string, string>();
    const bands = Array.from({ length: 8 }, (_, i) => `band-${i}`);
    const objects: Array<{ folder: string; api: string }> = [];
    for (const band of bands) {
      for (let j = 0; j < 25; j++) objects.push({ folder: `${band}/obj-${j}`, api: `${band.replace("-", "")}_Obj${j}__c` });
    }
    const relEdges: unknown[] = [];
    files.set("schema.json", JSON.stringify({ bands: bands.map((b) => ({ band: b, folder: b })), title: "Bench" }));
    for (const band of bands) {
      files.set(`${band}/schema.json`, JSON.stringify({ band, folder: band, objects: [] }));
    }
    objects.forEach((o, i) => {
      const fields = [
        { name: "Id", type: "id", nillable: false, visibleToIntegrationUser: true },
        { name: "Name", type: "string", nameField: true, nillable: false, visibleToIntegrationUser: true },
      ];
      const fks: unknown[] = [];
      for (let k = 1; k <= 3; k++) {
        const target = objects[(i + k * 7) % objects.length];
        fields.push({
          name: `Ref${k}__c`, type: "reference", nillable: true, visibleToIntegrationUser: true,
          relationship: { kind: "lookup", referenceTo: [target.api] },
        } as never);
        fks.push({ field: `Ref${k}__c`, kind: "lookup", referenceTo: [target.api], relationshipName: null, targetFolders: [target.folder] });
        relEdges.push({ from: o.api, field: `Ref${k}__c`, kind: "lookup", to: target.api });
      }
      for (let f = 0; f < 35; f++) {
        fields.push({
          name: `Field${f}__c`, type: "picklist", nillable: true, visibleToIntegrationUser: true,
          picklistValues: Array.from({ length: 20 }, (_, v) => ({ value: `v${v}`, label: `Value ${v}` })),
        } as never);
      }
      files.set(
        `${o.folder}/schema.json`,
        JSON.stringify({ folder: o.folder, object: { apiName: o.api, label: o.api, kind: "custom" }, fields, foreignKeys: fks }),
      );
    });
    files.set("relationships.json", JSON.stringify({ edges: relEdges }));
    return files;
  }

  it("imports 200 objects under the limits", () => {
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
      band.objects.push({ folder, band: "core", apiName: `F${i}__c`, label: `F${i}`, kind: "custom" });
      files.set(`${folder}/schema.json`, JSON.stringify({ folder, object: { apiName: `F${i}__c`, label: `F${i}`, kind: "custom" }, fields: [{ name: "Id", type: "id", nillable: false }], foreignKeys: [] }));
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
    expect(dialect).toBe(SALESFORCE_DIALECT_ID);
    expect(warnings).toEqual([]);
    expect(stats.nodes).toBe(14); // 9 objects + a view + a group + 3 record types
    // Small enough to open expanded; the README says so.
    expect(template.nodes.filter((n) => n.collapsed)).toEqual([]);
    const kinds = new Set(template.nodes.map((n) => n.kind));
    expect([...kinds].sort()).toEqual(["group", "sf-object", "sf-record-type", "sf-view"]);
    // Master-detail against lookups, and the view's alias.
    const md = template.edges.find((e) => e.tech === "masterDetail")!;
    expect(md.id).toBe("bread::Recipe__c::recipes");
    expect(template.edges.find((e) => e.label === "alias")!.target).toBe("customers");
    // Audit keys are hidden by default and stubbed when asked for.
    expect(template.edges.some((e) => e.id.includes("OwnerId"))).toBe(false);
    const all = importFolder(await readFolderToFileMap(dir), { edges: "all" });
    expect(all.template.nodes.some((n) => n.id === "_external/user")).toBe(true);
    // Nine tables, all reachable, and a provably smallest key set.
    const cover = minimalKeyCover(template);
    expect(cover.fraction).toBe(1);
    expect(cover.optimal).toBe(true);
    expect(keyCoverage(template, cover.keys).total).toBe(9);
  });
});
