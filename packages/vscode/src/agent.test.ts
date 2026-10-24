import { describe, expect, it } from "vitest";
import { EMPTY_TEMPLATE, buildSequencePrompt, templatePromptContext } from "@mosphere/better-diagrams";
import { registry } from "@app/documents.js";
import { INSTRUCTIONS_MARK, checkDiagram, instructionsMarkdown, schemaAnswer, schemaPrompt, withPointer } from "./agent";

const json = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
const shop = {
  version: 1,
  nodes: [
    { id: "web", label: "Storefront", kind: "service", x: 0, y: 0 },
    { id: "api", label: "Orders API", kind: "service", x: 320, y: 0 },
  ],
  edges: [{ id: "e1", source: "web", target: "api" }],
};

describe("schemaPrompt", () => {
  it("is the web app's copied prompt, with its registry's kinds", () => {
    const copied = templatePromptContext(EMPTY_TEMPLATE, registry).systemPrompt;
    expect(schemaPrompt()).toBe(copied);
    // The data-model kinds and the app's own demo kinds come with the shared registry.
    expect(schemaPrompt()).toContain("entity");
    expect(schemaPrompt()).toContain("vault");
  });

  it("is tailored to an existing diagram: its kind, and the clouds it uses", () => {
    const onAws = { ...shop, nodes: [...shop.nodes, { id: "fn", label: "Fn", kind: "aws-lambda", x: 0, y: 200 }] };
    expect(schemaPrompt({ existing: onAws })).toBe(templatePromptContext(EMPTY_TEMPLATE, registry).promptForClouds(["aws"]));
    expect(schemaPrompt({ existing: { version: 1, participants: [], messages: [] } })).toBe(buildSequencePrompt());
  });

  it("takes a kind, clouds and the content form", () => {
    const context = templatePromptContext(EMPTY_TEMPLATE, registry);
    expect(schemaPrompt({ kind: "tasks" })).toBe(context.promptForClouds([], { focus: "tasks" }));
    expect(schemaPrompt({ clouds: ["gcp", "nope"] })).toBe(context.promptForClouds(["gcp"]));
    expect(schemaPrompt({ geometry: false })).toBe(context.promptForClouds([], { geometry: false }));
    expect(schemaPrompt({ kind: "sequence" })).toBe(buildSequencePrompt());
  });

  it("tells an agent to write the JSON to the file", () => {
    expect(schemaAnswer()).toMatch(/^This is the prompt Better Diagrams gives its own AI\. Where it says to respond with JSON, write that JSON to the diagram's \.json file/);
  });
});

describe("checkDiagram", () => {
  it("says a clean diagram opens as written", () => {
    expect(checkDiagram("docs/shop.json", json(shop))).toBe(
      [
        "docs/shop.json: an architecture diagram, 2 nodes, 1 edge.",
        "",
        "The editor reads it exactly as written: nothing is repaired or dropped.",
        "",
        "Checks: none.",
      ].join("\n"),
    );
  });

  it("lists what the editor would repair or drop, and the checks", () => {
    const odd = {
      ...shop,
      nodes: [...shop.nodes.map((n, i) => (i === 0 ? { ...n, colour: "red" } : n)), { id: "lonely", label: "Lonely", kind: "service", x: 0, y: 300 }],
      edges: [...shop.edges, { id: "e2", source: "api", target: "nowhere" }],
    };
    const report = checkDiagram("odd.json", json(odd));
    expect(report).toContain("The editor would repair or drop 2 things as it opens it.");
    expect(report).toContain("colour");
    expect(report).toContain("nowhere");
    expect(report).toMatch(/- warning \S+: .*Lonely.* \(lonely\)/);
  });

  it("reads a sequence", () => {
    const seq = { version: 1, participants: [{ id: "a", label: "A" }, { id: "b", label: "B" }], messages: [{ id: "m1", from: "a", to: "b", label: "hi" }] };
    expect(checkDiagram("flow.json", json(seq))).toMatch(/^flow\.json: a sequence diagram, 2 participants and 1 message\.\n\nThe editor reads it exactly as written/);
  });

  it("explains what isn't one", () => {
    expect(checkDiagram("x.json", '{ "nodes": [')).toMatch(/^x\.json isn't valid JSON: .+ The editor won't open it until it parses\.$/);
    expect(checkDiagram("package.json", json({ name: "pkg" }))).toContain('one has a "nodes" array');
    expect(checkDiagram("rf.json", json({ nodes: [{ id: "a", position: { x: 0, y: 0 } }], edges: [] }))).toContain("React Flow export");
    expect(checkDiagram("new.json", "")).toContain("is empty");
  });
});

describe("instructionsMarkdown", () => {
  it("carries the architecture prompt, the task brief and the sequence prompt", () => {
    const text = instructionsMarkdown(["aws"]);
    expect(text.startsWith(INSTRUCTIONS_MARK)).toBe(true);
    expect(text).toContain(schemaPrompt({ clouds: ["aws"] }));
    expect(text).toContain(buildSequencePrompt());
    // The brief, and only the brief: the architecture prompt isn't repeated.
    expect(text).toMatch(/## Task flows\n\nA task flow is an architecture document whose nodes are tasks\. On top of the above:\n\nTASK FLOW: this diagram is a work plan[^\n]*\n\n## Sequence diagrams/);
    expect(text.split("You convert software requirements").length).toBe(2);
    expect(text).toContain("#betterDiagramsValidate");
  });
});

describe("withPointer", () => {
  it("adds a pointer at the end, and replaces its own on a second run", () => {
    const original = "# Agents\n\nRun the tests.\n";
    const once = withPointer(original, "docs/better-diagrams.md");
    expect(once.startsWith("# Agents\n\nRun the tests.\n\n<!-- better-diagrams -->")).toBe(true);
    expect(once).toContain("[docs/better-diagrams.md](docs/better-diagrams.md)");
    const twice = withPointer(once, "../docs/better-diagrams.md");
    expect(twice.match(/<!-- better-diagrams -->/g)).toHaveLength(1);
    expect(twice).toContain("../docs/better-diagrams.md");
    expect(twice.startsWith(original.trimEnd())).toBe(true);
    expect(withPointer(once, "docs/better-diagrams.md")).toBe(once);
  });

  it("starts an empty file with just the pointer", () => {
    expect(withPointer("", "docs/better-diagrams.md")).toMatch(/^<!-- better-diagrams -->\n[\s\S]*<!-- \/better-diagrams -->\n$/);
  });
});
