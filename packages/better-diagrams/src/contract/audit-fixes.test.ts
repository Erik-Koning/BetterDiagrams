/**
 * Regression tests for the audit fixes.
 *
 * Each case is a bug someone actually hit, phrased as the user action that
 * hit it — a document that lost a node, a Tidy that moved a pinned box, a
 * deletion that took a loop with it. Grouped by the surface the user was
 * touching rather than by the module the fix landed in.
 */
import { describe, expect, it } from "vitest";
import {
  EXAMPLE_SEQUENCE,
  EXAMPLE_ZONED_TEMPLATE,
  autoLayout,
  diffTemplates,
  lintTemplate,
  moveMessage,
  normalizeDate,
  parseLlmTemplateReport,
  removeMessages,
  templateBounds,
  validateSequence,
  validateTemplate,
} from "./index";
import { BUILTIN_LINT_RULES } from "./lint";
import { copyFragment, duplicateWithConnections, pasteFragment } from "./clipboard";
import { wrapText } from "./text";
import type { DiagramTemplate } from "./schema";

const doc = (partial: Record<string, unknown>): DiagramTemplate =>
  validateTemplate({ version: 1, nodes: [], edges: [], ...partial });

describe("a document written by hand or by a model", () => {
  it("keeps a node whose id arrived as a number, and its edges", () => {
    const t = doc({
      nodes: [
        { id: 1, label: "API", kind: "service" },
        { id: "db", label: "DB", kind: "database" },
      ],
      edges: [{ id: "e1", source: 1, target: "db" }],
    });
    expect(t.nodes.map((n) => n.id)).toEqual(["1", "db"]);
    expect(t.edges).toHaveLength(1);
  });

  it("never lets a duplicate id steal the id a later node already claimed", () => {
    const t = doc({
      nodes: [
        { id: "api", label: "A", kind: "service" },
        { id: "api", label: "B", kind: "service" },
        { id: "api_2", label: "C", kind: "service" },
        { id: "x", label: "X", kind: "service" },
      ],
      edges: [{ id: "e", source: "api_2", target: "x" }],
    });
    expect(t.nodes.map((n) => n.id)).toEqual(["api", "api_3", "api_2", "x"]);
    // The edge still points at the node it was written for.
    expect(t.nodes.find((n) => n.id === t.edges[0]!.source)?.label).toBe("C");
  });

  it.each([
    ["javascript:alert(1)", ""],
    // Browsers strip control characters from inside a scheme before acting.
    ["java\nscript:alert(1)", ""],
    ["JavaScript:alert(1)", ""],
    ["data:text/html,<script>x</script>", ""],
    ["vbscript:msgbox", ""],
    ["https://example.com/a", "https://example.com/a"],
    ["mailto:a@b.c", "mailto:a@b.c"],
    ["/docs/adr-7", "/docs/adr-7"],
    ["//cdn.example.com/x", "//cdn.example.com/x"],
    ["file:Order flow", "file:Order flow"],
  ])("only keeps a link it is safe to render: %s", (url, kept) => {
    const t = doc({ nodes: [{ id: "a", label: "A", kind: "service", url }] });
    expect(t.nodes[0]!.url ?? "").toBe(kept);
  });

  it("repairs a single-value providers string instead of inverting its meaning", () => {
    const t = doc({
      zones: [
        { id: "z", label: "Z", providers: ["aws", "azure"], provider: "azure", x: 0, y: 0, w: 500, h: 500 },
      ],
      nodes: [{ id: "a", label: "A", kind: "service", zoneId: "z", providers: "aws", x: 10, y: 10 }],
    });
    expect(t.nodes[0]!.providers).toEqual(["aws"]);
  });

  it("keeps every column of a wide table through a save", () => {
    const fields = Array.from({ length: 45 }, (_, i) => ({ id: `f${i}`, name: `col${i}` }));
    const t = doc({ nodes: [{ id: "t", label: "T", kind: "table", fields }] });
    expect(t.nodes[0]!.fields).toHaveLength(45);
  });

  it("keeps a colour set on an ordinary node, not only on a container", () => {
    const t = doc({ nodes: [{ id: "a", label: "A", kind: "service", color: "#ff0000" }] });
    expect(t.nodes[0]!.color).toBe("#ff0000");
  });

  it("drops a waypoint that lost a coordinate rather than pinning it to the origin", () => {
    const t = doc({
      nodes: [
        { id: "a", label: "A", kind: "service", x: 0, y: 0 },
        { id: "b", label: "B", kind: "service", x: 400, y: 0 },
      ],
      edges: [{ id: "e", source: "a", target: "b", points: [[10, null], [50, 60], ["x", 3]] }],
    });
    expect(t.edges[0]!.points).toEqual([[50, 60]]);
  });

  it.each([
    ["2026-06-15", "2026-06-15"],
    ["2026-06-15T09:30:00Z", "2026-06-15"],
    ["2026-6", "2026-06-01"],
    ["2026-06-15garbage", undefined],
    ["06/15/2026", undefined],
    ["2026-Q3", undefined],
  ])("reads %s as %s", (input, expected) => {
    expect(normalizeDate(input)).toBe(expected);
  });
});

describe("a reply the model did not finish", () => {
  it("reports that the text was cut off rather than loading a partial diagram silently", () => {
    const report = parseLlmTemplateReport(
      '{"version":1,"nodes":[{"id":"a","label":"A","kind":"service"},' +
        '{"id":"b","label":"B","kind":"service"}],"edges":[{"id":"e1","source":"a","tar',
    );
    expect(report.truncated).toBe(true);
    expect(report.template.nodes).toHaveLength(2);
    expect(report.template.edges).toHaveLength(0);
  });

  it("says nothing about a reply that arrived whole", () => {
    const report = parseLlmTemplateReport('{"version":1,"nodes":[],"edges":[]}');
    expect(report.truncated).toBe(false);
    expect(report.repairs).toEqual([]);
  });
});

describe("copying a region", () => {
  it("zones the pasted members into the cloned zone when a node shares the zone's id", () => {
    const t = doc({
      zones: [
        { id: "aws", label: "AWS", providers: ["aws"], provider: "aws", x: 0, y: 0, w: 600, h: 400 },
      ],
      nodes: [
        { id: "aws", label: "grp", kind: "group", zoneId: "aws", x: 20, y: 20, w: 300, h: 200 },
        { id: "svc", label: "svc", kind: "service", parentId: "aws", zoneId: "aws", x: 10, y: 10 },
      ],
    });
    const pasted = pasteFragment(t, copyFragment(t, ["aws"], { zones: ["aws"] }), { offset: 60 });
    const clonedZone = pasted.newZoneIds[0]!;
    for (const id of pasted.newNodeIds) {
      expect(pasted.template.nodes.find((n) => n.id === id)!.zoneId).toBe(clonedZone);
    }
  });

  it("drops the stale route on a duplicated boundary edge", () => {
    const t = doc({
      nodes: [
        { id: "a", label: "A", kind: "service", x: 0, y: 0 },
        { id: "b", label: "B", kind: "service", x: 400, y: 0 },
      ],
      edges: [{ id: "e", source: "a", target: "b", points: [[200, -120]] }],
    });
    const out = duplicateWithConnections(t, ["b"], { makeId: (p) => `${p}_copy` });
    const cloned = out.template.edges.filter((e) => e.id !== "e");
    expect(cloned).toHaveLength(1);
    expect(cloned[0]!.points).toBeUndefined();
  });
});

describe("Tidy", () => {
  it("leaves a pinned node exactly where it was", () => {
    const t = doc({
      nodes: [
        { id: "a", label: "A", kind: "service", x: 900, y: 900, locked: true },
        { id: "b", label: "B", kind: "service", x: 0, y: 0 },
        { id: "c", label: "C", kind: "service", x: 0, y: 0 },
      ],
      edges: [{ id: "e", source: "b", target: "c" }],
    });
    const a = autoLayout(t).nodes.find((n) => n.id === "a")!;
    expect([a.x, a.y]).toEqual([900, 900]);
  });

  it("keeps provider alternates stacked, so switching cloud swaps them in place", () => {
    const laid = autoLayout(EXAMPLE_ZONED_TEMPLATE);
    const at = (id: string) => {
      const n = laid.nodes.find((x) => x.id === id)!;
      return `${n.x},${n.y}`;
    };
    expect(at("sql-aws")).toBe(at("sql-az"));
    expect(at("sql-gcp")).toBe(at("sql-az"));
    // A node whose providers OVERLAP an alternate is not one of them.
    expect(at("cache")).not.toBe(at("sql-az"));
  });
});

describe("what an export has to draw", () => {
  it("includes a waypoint dragged outside every box in the bounds", () => {
    const t = doc({
      nodes: [
        { id: "a", label: "A", kind: "service", x: 0, y: 100 },
        { id: "b", label: "B", kind: "service", x: 400, y: 100 },
      ],
      edges: [{ id: "e", source: "a", target: "b", points: [[200, -300]] }],
    });
    expect(templateBounds(t).minY).toBe(-300);
  });

  it("measures a collapsed group as its chip, not the frame it is not drawing", () => {
    const t = doc({
      nodes: [
        { id: "g", label: "G", kind: "group", x: 0, y: 0, w: 900, h: 600, collapsed: true },
        { id: "c", label: "C", kind: "service", parentId: "g", x: 20, y: 20 },
      ],
    });
    const bounds = templateBounds(t);
    expect(bounds.maxX).toBeLessThan(300);
    expect(bounds.maxY).toBeLessThan(200);
  });

  it("keeps the line breaks a note was typed with", () => {
    expect(wrapText("Step 1\nStep 2\nStep 3", 13, "sans", 300, 10)).toEqual([
      "Step 1",
      "Step 2",
      "Step 3",
    ]);
  });
});

describe("Checks", () => {
  const linted = (t: DiagramTemplate) => lintTemplate(t, BUILTIN_LINT_RULES).map((f) => f.rule);

  it("does not call a retry self-loop a synchronous cycle", () => {
    const t = doc({
      nodes: [{ id: "job", label: "Job", kind: "service" }],
      edges: [{ id: "r", source: "job", target: "job", style: "solid" }],
    });
    expect(linted(t)).not.toContain("no-cycles");
  });

  it("does not treat a plain association as a call", () => {
    const t = doc({
      nodes: [
        { id: "a", label: "A", kind: "service" },
        { id: "b", label: "B", kind: "service" },
      ],
      edges: [
        { id: "x", source: "a", target: "b", style: "solid" },
        { id: "y", source: "b", target: "a", style: "solid", direction: "none" },
      ],
    });
    expect(linted(t)).not.toContain("no-cycles");
  });

  it("does not ask who owns a decision diamond", () => {
    const t = doc({
      nodes: [
        { id: "s", label: "S", kind: "service", team: "Platform" },
        { id: "d", label: "D", kind: "decision" },
      ],
      edges: [{ id: "e", source: "s", target: "d" }],
    });
    expect(linted(t)).not.toContain("missing-owner");
  });

  it("lets one element opt out by tag", () => {
    const base = {
      nodes: [
        { id: "s", label: "S", kind: "service", team: "Platform" },
        { id: "a", label: "A", kind: "service" },
      ],
      edges: [{ id: "e", source: "s", target: "a" }],
    };
    expect(linted(doc(base))).toContain("missing-owner");
    const excused = doc({
      ...base,
      nodes: [base.nodes[0], { ...base.nodes[1], tags: ["lint-ignore"] }],
    });
    expect(linted(excused)).not.toContain("missing-owner");
  });
});

describe("Compare", () => {
  it("reports a retitled document", () => {
    const before = doc({ meta: { title: "A" }, nodes: [{ id: "n", label: "N", kind: "service" }] });
    const after = doc({ meta: { title: "B" }, nodes: [{ id: "n", label: "N", kind: "service" }] });
    expect(diffTemplates(before, after).meta).toEqual(["title"]);
  });

  it("does not report folding a group as an architecture change", () => {
    const before = doc({ nodes: [{ id: "g", label: "G", kind: "group" }] });
    const after = doc({ nodes: [{ id: "g", label: "G", kind: "group", collapsed: true }] });
    expect(diffTemplates(before, after).summary.changed).toBe(0);
  });
});

describe("editing a sequence", () => {
  const seq = validateSequence(EXAMPLE_SEQUENCE);
  const spans = (t: typeof seq) => (t.fragments ?? []).map((f) => `${f.kind}:${f.from}-${f.to}`);

  it("keeps a loop when its first message is deleted", () => {
    const after = removeMessages(seq, ["m4"]);
    expect(spans(after)).toContain("loop:m5-m5");
  });

  it("keeps an activation bounded when its closing message is deleted", () => {
    const after = removeMessages(seq, ["m8"]);
    const bar = (after.activations ?? []).find((a) => a.participant === "api")!;
    expect(bar.to).toBeDefined();
    expect(bar.to).not.toBe(bar.from);
  });

  it("takes a message OUT of a loop when it is dragged past the loop's end", () => {
    const after = moveMessage(seq, "m4", 8);
    expect(after.messages.map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m5",
      "m6",
      "m7",
      "m8",
      "m9",
      "m4",
    ]);
    // The loop stays over what is still inside it, rather than stretching to
    // swallow every row the moved message passed.
    expect(spans(after)).toContain("loop:m5-m5");
  });
});
