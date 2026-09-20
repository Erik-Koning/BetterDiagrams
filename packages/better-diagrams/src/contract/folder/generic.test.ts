/**
 * generic.test.ts — the tree builder, the flat-YAML reader, and the generic
 * dialect's full round trip over every shipped architecture example.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildFolderTree, rerootTree, walkTree, normalizePath } from "./tree";
import { importFolder } from "./import";
import { exportFolder } from "./export";
import { MANIFEST_FILE, LAYOUT_FILE } from "./sidecar";
import { genericDialect, slugFolder, humanise } from "./dialects/generic";
import { parseFlatYaml, patchFlatYaml } from "./dialects/datamodel/yaml";
import { EXAMPLE_TEMPLATE, EXAMPLE_ZONED_TEMPLATE, validateTemplate, type DiagramTemplate } from "../schema";

describe("buildFolderTree", () => {
  it("creates folders for every prefix, sorts children, and normalises paths", () => {
    const tree = buildFolderTree(
      new Map([
        ["./b/y/node.json", "{}"],
        ["a\\x\\node.json", "{}"],
        ["/root.json", "{}"],
        ["a/node.json", "{}"],
      ]),
    );
    expect(tree.root.files).toEqual({ "root.json": "{}" });
    expect(tree.root.children.map((c) => c.path)).toEqual(["a", "b"]);
    expect(tree.byPath.get("b")!.files).toEqual({});
    expect(tree.byPath.get("b/y")!.depth).toBe(2);
    expect(tree.byPath.get("a/x")!.parentPath).toBe("a");
    expect([...walkTree(tree.root)].map((e) => e.path)).toEqual(["", "a", "a/x", "b", "b/y"]);
    expect(normalizePath("./a//b/./c")).toBe("a/b/c");
  });

  it("re-roots at a child, rewriting paths", () => {
    const tree = buildFolderTree(new Map([["wrap/a/node.json", "1"], ["wrap/manifest.json", "2"]]));
    const inner = rerootTree(tree, tree.root.children[0]);
    expect(inner.root.files).toEqual({ "manifest.json": "2" });
    expect(inner.byPath.get("a")!.files).toEqual({ "node.json": "1" });
  });

  it("slugs and humanises", () => {
    expect(slugFolder("Payments Core")).toBe("payments-core");
    expect(slugFolder("  ")).toBe("node");
    expect(slugFolder("..hidden")).toBe("hidden");
    expect(humanise("person-account")).toBe("Person account");
  });
});

describe("flat YAML", () => {
  const TEXT = "# summary\nkind: standard\nlabel: \"Case: Comment\"\nrecordCount: 12\n\nname: 'case_comment'\n";

  it("reads scalars, unquoting both styles", () => {
    expect(parseFlatYaml(TEXT)).toEqual({ kind: "standard", label: "Case: Comment", recordCount: "12", name: "case_comment" });
  });

  it("refuses nested documents", () => {
    expect(parseFlatYaml("a:\n  b: 1\n")).toBeNull();
    expect(parseFlatYaml("- item\n")).toBeNull();
    expect(patchFlatYaml("a:\n  b: 1\n", { a: "x" })).toBeNull();
  });

  it("patches in place, byte-identical elsewhere, quoting only what YAML would misread", () => {
    const out = patchFlatYaml(TEXT, { label: "Case Comment", diagramName: "Case: Comment", recordCount: "13" })!;
    expect(out).toBe(
      "# summary\nkind: standard\nlabel: Case Comment\nrecordCount: \"13\"\n\nname: 'case_comment'\ndiagramName: \"Case: Comment\"\n",
    );
    expect(patchFlatYaml("a: 1", { a: "true" })).toBe('a: "true"');
  });
});

describe("generic dialect", () => {
  it("imports a bare directory tree as nested groups and boxes", () => {
    const files = new Map([
      ["platform/api/README.md", "hi"],
      ["platform/db/node.json", JSON.stringify({ label: "Postgres", kind: "database", icon: "database", data: { owner: "data" } })],
      ["platform/edges.json", JSON.stringify([{ id: "e1", source: "platform/api", target: "platform/db", label: "reads" }])],
    ]);
    const { template, dialect, warnings } = importFolder(files);
    expect(dialect).toBe("generic");
    expect(warnings).toEqual([]);
    const ids = template.nodes.map((n) => [n.id, n.kind, n.parentId, n.label]);
    expect(ids).toEqual([
      ["platform", "group", null, "Platform"],
      ["platform/api", "service", "platform", "Api"],
      ["platform/db", "database", "platform", "Postgres"],
    ]);
    expect(template.nodes[2].data).toEqual({ owner: "data" });
    expect(template.edges).toHaveLength(1);
    expect(template.edges[0]).toMatchObject({ source: "platform/api", target: "platform/db", label: "reads" });
  });

  it("detects its own manifest and skips the sidecar folder", () => {
    const files = new Map([
      [MANIFEST_FILE, JSON.stringify({ format: "better-diagrams/folder", version: 1, title: "T" })],
      ["a/node.json", "{}"],
    ]);
    const tree = buildFolderTree(files);
    expect(genericDialect.detect(tree)).toBe(true);
    const { template } = importFolder(files);
    expect(template.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(template.meta?.title).toBe("T");
  });
});

describe("full round trip", () => {
  const dir = fileURLToPath(new URL("../../../../../templates/examples", import.meta.url));
  const shipped: Array<[string, DiagramTemplate]> = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf8"))] as [string, DiagramTemplate])
    .filter(([, doc]) => Array.isArray(doc.nodes));
  const cases: Array<[string, DiagramTemplate]> = [
    ["EXAMPLE_TEMPLATE", EXAMPLE_TEMPLATE],
    ["EXAMPLE_ZONED_TEMPLATE", EXAMPLE_ZONED_TEMPLATE],
    ...shipped,
  ];

  it.each(cases)("%s survives export → import byte-for-byte", (_name, raw) => {
    const doc = validateTemplate(raw);
    const out = exportFolder(doc, { mode: "full" });
    expect(out.mode).toBe("full");
    expect(out.files.has(MANIFEST_FILE)).toBe(true);
    expect(out.files.has(LAYOUT_FILE)).toBe(true);
    const back = importFolder(out.files);
    expect(back.dialect).toBe("generic");
    expect(back.warnings).toEqual([]);
    // The one thing import adds is its own provenance on meta.
    const { folderFormat: _ff, ...meta } = back.template.meta ?? {};
    const stripped = { ...back.template, meta };
    if (!Object.keys(meta).length) delete (stripped as { meta?: unknown }).meta;
    expect(JSON.stringify(validateTemplate(stripped))).toBe(JSON.stringify(doc));
  });

  it("a manifest remembers non-builtin kinds, so a dialect's document reads back intact", () => {
    const doc = validateTemplate(
      {
        version: 1,
        nodes: [{ id: "acc", label: "Account", kind: "entity-standard", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 230, h: 96 }],
        edges: [],
      },
      { knownKinds: ["entity-standard"] },
    );
    expect(doc.nodes[0].kind).toBe("entity-standard");
    const out = exportFolder(doc, { mode: "full", validate: { knownKinds: ["entity-standard"] } });
    expect(JSON.parse(out.files.get(MANIFEST_FILE)!).kinds).toEqual(["entity-standard"]);
    expect(importFolder(out.files).template.nodes[0].kind).toBe("entity-standard");
  });

  it("names folders after ids, nested by parent, never colliding", () => {
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "Pay", label: "A", kind: "group", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 300, h: 200 },
        { id: "pay", label: "B", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 },
        { id: "API", label: "C", kind: "service", icon: "box", description: "", parentId: "Pay", x: 10, y: 10, w: 170, h: 76 },
      ],
      edges: [],
    });
    const out = exportFolder(doc, { mode: "full" });
    expect([...out.files.keys()].filter((p) => p.endsWith("node.json")).sort()).toEqual([
      "pay-2/node.json",
      "pay/api/node.json",
      "pay/node.json",
    ]);
    expect(importFolder(out.files).template.nodes.map((n) => n.id)).toEqual(["Pay", "pay", "API"]);
  });
});
