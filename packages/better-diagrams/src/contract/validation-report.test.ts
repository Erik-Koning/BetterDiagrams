import { describe, expect, it } from "vitest";
import { validateTemplateReport } from "./validation-report";
import { EXAMPLE_TEMPLATE, EXAMPLE_ZONED_TEMPLATE, validateTemplate } from "./schema";

const codes = (raw: unknown, opts?: Parameters<typeof validateTemplateReport>[1]) =>
  validateTemplateReport(raw, opts).issues.map((i) => `${i.code} ${i.path}`);

describe("validateTemplateReport", () => {
  it("returns exactly what validateTemplate does, and no issues for a clean document", () => {
    for (const doc of [EXAMPLE_TEMPLATE, EXAMPLE_ZONED_TEMPLATE]) {
      const report = validateTemplateReport(doc);
      expect(report.template).toEqual(validateTemplate(doc));
      expect(report.issues).toEqual([]);
      // A validated document reports nothing either: repairs are idempotent.
      expect(validateTemplateReport(report.template).issues).toEqual([]);
    }
  });

  it("doesn't count defaults filled in or stripped as issues", () => {
    expect(codes({ nodes: [{ id: "a", status: "active", textAlign: "left", done: false }], edges: [] })).toEqual([]);
  });

  it("lists what the silent repairs did, pointing into the input", () => {
    const report = validateTemplateReport({
      nodes: [
        { id: "api", label: "API", kind: "my-kind", colour: "#f00" },
        { id: "api", label: "Duplicate" },
        { label: "No id" },
        { id: "w", kind: "service", parentId: "nowhere", zoneId: "gcp", date: "someday", collapsed: true },
        { id: "a", kind: "group", parentId: "b" },
        { id: "b", kind: "group", parentId: "a", outline: "wavy" },
      ],
      edges: [
        { id: "e1", source: "api", target: "paymnts" },
        { id: "e2", source: "api", target: "w", style: "zigzag", endField: "missing" },
        { id: "e2", source: "w", target: "api" },
      ],
      settings: { arrange: "spiral", theme: "dark" },
    });
    const byPath = Object.fromEntries(report.issues.map((i) => [`${i.code} ${i.path}`, i.message]));
    expect(Object.keys(byPath)).toEqual([
      "unknown-key /nodes/0/colour",
      "unknown-value /nodes/0/kind",
      "duplicate-id /nodes/1/id",
      "dropped /nodes/2",
      "invalid-date /nodes/3/date",
      "not-applicable /nodes/3/collapsed",
      "missing-reference /nodes/3/parentId",
      "missing-reference /nodes/3/zoneId",
      "parent-cycle /nodes/4/parentId",
      "unknown-value /nodes/5/outline",
      "missing-reference /edges/0",
      "unknown-value /edges/1/style",
      "missing-reference /edges/1/endField",
      "duplicate-id /edges/2/id",
      "unknown-key /settings/theme",
      "unknown-value /settings/arrange",
    ]);
    expect(byPath["unknown-value /nodes/0/kind"]).toContain("became a \"service\"");
    expect(byPath["duplicate-id /nodes/1/id"]).toBe('Node id "api" was already used, so this one became "api_2".');
    expect(byPath["missing-reference /edges/0"]).toBe('The edge\'s target "paymnts" names no node, so the edge was left out.');
  });

  it("knows a registry's kinds when they are passed, as validation does", () => {
    const doc = { nodes: [{ id: "v", kind: "vault" }], edges: [] };
    expect(codes(doc)).toEqual(["unknown-value /nodes/0/kind"]);
    expect(codes(doc, { knownKinds: ["vault"] })).toEqual([]);
  });

  it("reports dropped fields, numbers that aren't, and paths that lost steps", () => {
    expect(
      codes({
        nodes: [
          { id: "t", kind: "table", w: -5, x: "left", fields: [{ name: "id", key: "primary" }, { type: "int" }, { name: "id" }] },
          { id: "u", kind: "table" },
        ],
        edges: [],
        paths: [
          { id: "p", title: "P", steps: ["t", "ghost", "u"] },
          { id: "q", title: "Q", steps: ["ghost"] },
        ],
      }),
    ).toEqual([
      "unknown-value /nodes/0/x",
      "unknown-value /nodes/0/w",
      "unknown-value /nodes/0/fields/0/key",
      "dropped /nodes/0/fields/1",
      "missing-reference /paths/0/steps",
      "dropped /paths",
    ]);
  });

  it("reports zones, saved analyses, lineage links and meta", () => {
    const report = validateTemplateReport({
      zones: [
        { id: "z", label: "Cloud", shape: "blob", outline: "wiggly", tint: 3, date: "soon" },
        { id: "z", label: "Again" },
        { label: "No id" },
      ],
      nodes: [{ id: "api" }, { id: "db" }],
      edges: [],
      analyses: [
        { id: "a1", title: "Kept", kind: "neighbourhood", from: ["api"], depth: 1, direction: "out", keysOnly: false },
        { id: "a2", title: "Gone", kind: "neighbourhood", from: ["ghost"], depth: 1, direction: "out", keysOnly: false },
        "nonsense",
      ],
      lineage: [
        { id: "l1", from: { nodeId: "api", fieldId: "x" }, to: { nodeId: "db", fieldId: "y" } },
        { id: "l2", from: { nodeId: "api", fieldId: "x" }, to: { nodeId: "nowhere", fieldId: "y" } },
      ],
      meta: { title: "T", versionTagPosition: "middle" },
    });
    const byPath = Object.fromEntries(report.issues.map((i) => [`${i.code} ${i.path}`, i.message]));
    expect(Object.keys(byPath)).toEqual([
      "unknown-key /zones/0/tint",
      "unknown-value /zones/0/shape",
      "unknown-value /zones/0/outline",
      "invalid-date /zones/0/date",
      "duplicate-id /zones/1/id",
      "dropped /zones/2",
      "dropped /analyses",
      "dropped /lineage",
      "unknown-value /meta/versionTagPosition",
    ]);
    expect(report.template.zones?.map((z) => z.id)).toEqual(["z", "z_2"]);
    expect(byPath["unknown-value /zones/0/outline"]).toMatch(/^"wiggly" isn't an outline value/);
    expect(byPath["dropped /analyses"]).toMatch(/^2 saved analyses couldn't be read/);
    expect(byPath["dropped /lineage"]).toMatch(/^1 lineage link couldn't be read .*, so it was left out\.$/);
  });

  it("escapes JSON Pointer segments", () => {
    expect(codes({ nodes: [{ id: "a", "x/y~z": 1 }], edges: [] })).toEqual(["unknown-key /nodes/0/x~1y~0z"]);
  });

  it("throws where validation throws", () => {
    expect(() => validateTemplateReport({ edges: [] })).toThrow("missing a `nodes` array");
  });
});
