/**
 * analyses.test.ts — saved analyses: validation and pruning, the document
 * round trip, ids, drift, and Compare not seeing them.
 */
import { describe, expect, it } from "vitest";
import { analysisDrift, analysisId, validateAnalyses, type SavedAnalysis } from "./analyses";
import { fromReactFlow, toReactFlow, validateTemplate, type DiagramTemplate } from "./schema";
import { diffTemplates } from "./diff";

const node = (id: string) => ({ id, label: id, kind: "table", icon: "none", description: "", parentId: null, x: 0, y: 0 });

const USAGE: SavedAnalysis = { id: "tenant", title: "Tenant key", kind: "usage", names: ["tenant_id"], match: "any", includeTargets: false };

describe("validateAnalyses", () => {
  it("keeps each kind, repairing what it can", () => {
    const out = validateAnalyses([
      { id: "a", title: "  Routes  ", kind: "paths", pins: [{ nodeId: "x", fieldId: "id" }, { nodeId: "y" }], mode: "sideways" },
      { id: "b", kind: "usage", names: ["Tenant_ID", "tenant_id", "", 3], match: "all", includeTargets: true },
      { id: "c", title: "Cover", kind: "coverage", keys: [{ nodeId: "x", fieldId: "id" }, { nodeId: "y" }], scope: { kind: "from", nodeId: "y" } },
      { id: "d", title: "Impact", kind: "impact", subject: { nodeId: "x" }, direction: "dependencies", maxDepth: 2.7, via: "nope" },
      { id: "e", title: "Near", kind: "neighbourhood", from: ["x", "x", "y"], depth: 9, direction: "in", keysOnly: true },
    ]);
    expect(out).toEqual([
      { id: "a", title: "Routes", kind: "paths", pins: [{ nodeId: "x", fieldId: "id" }, { nodeId: "y" }], undirected: true, mode: "between" },
      { id: "b", title: "b", kind: "usage", names: ["tenant_id"], match: "all", includeTargets: true },
      // A coverage key is a field; a table pin is not one.
      { id: "c", title: "Cover", kind: "coverage", keys: [{ nodeId: "x", fieldId: "id" }], scope: { kind: "from", nodeId: "y" } },
      { id: "d", title: "Impact", kind: "impact", subject: { nodeId: "x" }, direction: "dependencies", maxDepth: 2, via: "keys" },
      { id: "e", title: "Near", kind: "neighbourhood", from: ["x", "y"], depth: 6, direction: "in", keysOnly: true },
    ]);
  });

  it("drops what is not an analysis: an unknown kind, no id, a repeated id, a question about nothing", () => {
    expect(
      validateAnalyses([
        { id: "x", kind: "lineage" },
        { kind: "usage", names: ["a"] },
        { id: "dup", kind: "usage", names: ["a"] },
        { id: "dup", kind: "usage", names: ["b"] },
        { id: "empty", kind: "usage", names: [] },
        "nonsense",
      ]).map((a) => a.id),
    ).toEqual(["dup"]);
    expect(validateAnalyses({})).toEqual([]);
  });

  it("prunes references to nodes the document no longer has", () => {
    const nodeIds = new Set(["x"]);
    const out = validateAnalyses(
      [
        { id: "p", kind: "paths", pins: [{ nodeId: "x" }, { nodeId: "gone" }] },
        { id: "i", kind: "impact", subject: { nodeId: "gone" } },
        { id: "c", kind: "coverage", keys: [{ nodeId: "x", fieldId: "id" }], scope: { kind: "from", nodeId: "gone" } },
        { id: "n", kind: "neighbourhood", from: ["gone"] },
      ],
      { nodeIds },
    );
    expect(out.map((a) => a.id)).toEqual(["p", "c"]);
    expect(out[0]).toMatchObject({ pins: [{ nodeId: "x" }] });
    expect(out[1]).toMatchObject({ scope: { kind: "all" } });
  });

  it("keeps a note, a date and a snapshot", () => {
    const [a] = validateAnalyses([{ ...USAGE, note: " quarterly ", created: "2026-09-30T10:00:00Z", snapshot: { headline: "3 of 5 tables use them", value: 0.6 } }]);
    expect(a).toMatchObject({ note: "quarterly", created: "2026-09-30", snapshot: { headline: "3 of 5 tables use them", value: 0.6 } });
  });
});

describe("in the document", () => {
  const doc = (analyses: unknown): DiagramTemplate =>
    validateTemplate({ version: 1, nodes: [node("x"), node("y")], edges: [], analyses } as never);

  it("is omitted when empty and kept when not", () => {
    expect("analyses" in doc([])).toBe(false);
    expect(doc([USAGE]).analyses).toEqual([USAGE]);
  });

  it("goes with a deleted node, and rides through a canvas round trip", () => {
    const d = doc([USAGE, { id: "i", title: "Impact", kind: "impact", subject: { nodeId: "y" }, direction: "dependents", via: "keys" }]);
    const rf = toReactFlow(d);
    const back = fromReactFlow(rf.nodes.filter((n) => n.id !== "y"), rf.edges, { base: d, allNodesPresent: true });
    expect(back.analyses).toEqual([USAGE]);
  });

  it("is not a change to Compare", () => {
    const d = doc([]);
    const diff = diffTemplates(d, doc([USAGE]));
    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 0 });
  });
});

describe("helpers", () => {
  it("makes an id from the title, numbered when taken", () => {
    expect(analysisId("Tenant key audit", [])).toBe("tenant-key-audit");
    expect(analysisId("Tenant key audit", [{ id: "tenant-key-audit" }, { id: "tenant-key-audit-2" }])).toBe("tenant-key-audit-3");
    expect(analysisId("!!!", [])).toBe("analysis");
  });

  it("says how far a re-run drifted", () => {
    expect(analysisDrift("usage", { headline: "", value: 0.44 }, { value: 0.51 })).toBe("was 44%, now 51%");
    expect(analysisDrift("impact", { headline: "", value: 12 }, { value: 15 })).toBe("was 12, now 15");
    expect(analysisDrift("usage", { headline: "", value: 0.441 }, { value: 0.439 })).toBeNull();
    expect(analysisDrift("usage", undefined, { value: 0.5 })).toBeNull();
  });
});
